-- META ROSE Phone Hub
-- Unlimited visitor journey + five-minute station lease hardening.
--
-- Run after supabase_migration_20260814_exclusive_station_locks.sql.
-- This migration deletes nothing and does not interrupt a valid current lock.
-- A session remains usable until Exit/staff reset explicitly ends it; only the
-- station lease expires after five minutes without a confirmed phone action.

begin;

create or replace function public.claim_station(
  p_station_id text,
  p_session_id uuid,
  p_client_ref uuid,
  p_via text default 'pattern',
  p_lease_seconds int default 300
)
returns table (
  claim_status text,
  claimed_station_id text,
  claimed_client_ref uuid,
  claimed_entered_at timestamptz,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_lease_seconds int := least(greatest(coalesce(p_lease_seconds, 300), 120), 900);
  v_lock public.station_locks%rowtype;
  v_entered_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_station_id is null
     or p_station_id not in ('01', '02', '03', '04')
     or p_client_ref is null then
    return query select 'invalid_request', p_station_id, null::uuid,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Four stations have very low claim volume. One transaction lock makes all
  -- cross-station moves deterministic and avoids opposite-direction deadlocks.
  perform pg_advisory_xact_lock(20260814, 4271);

  perform 1
    from public.sessions s
   where s.id = p_session_id
     and s.auth_uid = auth.uid()
     and s.status = 'active'
     and s.entered_at <= v_now + interval '5 minutes'
   for update;
  if not found then
    return query select 'invalid_session', p_station_id, null::uuid,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into public.station_locks(station_id)
  values (p_station_id)
  on conflict (station_id) do nothing;

  -- Expired or invalid leases stop attribution first, then become available.
  update public.station_presence p
     set left_at = greatest(p.entered_at, v_now)
    from public.station_locks l
    left join public.sessions s on s.id = l.session_id
   where l.client_ref = p.client_ref
     and l.state = 'active'
     and p.left_at is null
     and (
       l.expires_at <= v_now
       or s.id is null
       or s.status <> 'active'
       or s.entered_at > v_now + interval '5 minutes'
     );

  update public.station_locks l
     set session_id = null,
         client_ref = null,
         state = 'idle',
         acquired_at = null,
         expires_at = null,
         updated_at = v_now
   where l.state = 'active'
     and (
       l.expires_at <= v_now
       or not exists (
         select 1
           from public.sessions s
          where s.id = l.session_id
            and s.status = 'active'
            and s.entered_at <= v_now + interval '5 minutes'
       )
     );

  select *
    into v_lock
    from public.station_locks l
   where l.station_id = p_station_id
   for update;

  if v_lock.state = 'active' and v_lock.expires_at > v_now then
    if v_lock.session_id <> p_session_id then
      return query select 'busy', p_station_id, null::uuid,
        null::timestamptz, v_lock.expires_at;
      return;
    end if;

    select p.entered_at
      into v_entered_at
      from public.station_presence p
     where p.client_ref = v_lock.client_ref
       and p.session_id = p_session_id
       and p.station_id = p_station_id
       and p.left_at is null;

    if found then
      -- Repair any impossible duplicate ownership without disturbing this
      -- already-confirmed target station.
      update public.station_presence p
         set left_at = greatest(p.entered_at, v_now)
        from public.station_locks l
       where l.session_id = p_session_id
         and l.station_id <> p_station_id
         and l.state = 'active'
         and l.client_ref = p.client_ref
         and p.left_at is null;
      update public.station_locks
         set session_id = null,
             client_ref = null,
             state = 'idle',
             acquired_at = null,
             expires_at = null,
             updated_at = v_now
       where session_id = p_session_id
         and station_id <> p_station_id
         and state = 'active';

      update public.station_locks
         set expires_at = v_now + make_interval(secs => v_lease_seconds),
             updated_at = v_now
       where station_id = p_station_id;
      return query select 'connected', p_station_id, v_lock.client_ref,
        v_entered_at, v_now + make_interval(secs => v_lease_seconds);
      return;
    end if;

    update public.station_locks
       set session_id = null,
           client_ref = null,
           state = 'idle',
           acquired_at = null,
           expires_at = null,
           updated_at = v_now
     where station_id = p_station_id;
  end if;

  -- The target is now available. Only at this point release the same phone's
  -- previous station. A BUSY target therefore never disconnects the work the
  -- visitor is already using.
  update public.station_presence p
     set left_at = greatest(p.entered_at, v_now)
    from public.station_locks l
   where l.session_id = p_session_id
     and l.station_id <> p_station_id
     and l.state = 'active'
     and l.client_ref = p.client_ref
     and p.left_at is null;

  update public.station_locks
     set session_id = null,
         client_ref = null,
         state = 'idle',
         acquired_at = null,
         expires_at = null,
         updated_at = v_now
   where session_id = p_session_id
     and station_id <> p_station_id
     and state = 'active';

  begin
    insert into public.station_presence(
      client_ref, session_id, station_id, entered_at, via
    ) values (
      p_client_ref,
      p_session_id,
      p_station_id,
      v_now,
      left(coalesce(nullif(p_via, ''), 'pattern'), 32)
    )
    returning station_presence.entered_at into v_entered_at;
  exception when unique_violation then
    select p.entered_at
      into v_entered_at
      from public.station_presence p
     where p.client_ref = p_client_ref
       and p.session_id = p_session_id
       and p.station_id = p_station_id
       and p.left_at is null;
    if not found then
      return query select 'conflict', p_station_id, null::uuid,
        null::timestamptz, null::timestamptz;
      return;
    end if;
  end;

  update public.station_locks
     set session_id = p_session_id,
         client_ref = p_client_ref,
         state = 'active',
         acquired_at = v_now,
         expires_at = v_now + make_interval(secs => v_lease_seconds),
         updated_at = v_now
   where station_id = p_station_id;

  return query select 'connected', p_station_id, p_client_ref,
    v_entered_at, v_now + make_interval(secs => v_lease_seconds);
end;
$$;

create or replace function public.renew_station(
  p_station_id text,
  p_session_id uuid,
  p_client_ref uuid,
  p_lease_seconds int default 300
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_lease_seconds int := least(greatest(coalesce(p_lease_seconds, 300), 120), 900);
  v_rows int := 0;
begin
  if auth.uid() is null then return false; end if;
  perform pg_advisory_xact_lock(20260814, 4271);

  if not exists (
    select 1 from public.sessions s
     where s.id = p_session_id
       and s.auth_uid = auth.uid()
       and s.status = 'active'
       and s.entered_at <= v_now + interval '5 minutes'
  ) then
    return false;
  end if;

  update public.station_locks l
     set expires_at = v_now + make_interval(secs => v_lease_seconds),
         updated_at = v_now
   where l.station_id = p_station_id
     and l.session_id = p_session_id
     and l.client_ref = p_client_ref
     and l.state = 'active'
     and l.expires_at > v_now
     and exists (
       select 1 from public.station_presence p
        where p.client_ref = l.client_ref
          and p.session_id = l.session_id
          and p.station_id = l.station_id
          and p.left_at is null
     );
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.release_station(
  p_station_id text,
  p_session_id uuid,
  p_client_ref uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_owned boolean := false;
  v_closed boolean := false;
begin
  if auth.uid() is null then return false; end if;
  if not exists (
    select 1 from public.sessions s
     where s.id = p_session_id
       and s.auth_uid = auth.uid()
  ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(20260814, 4271);

  select exists (
    select 1 from public.station_presence p
     where p.client_ref = p_client_ref
       and p.session_id = p_session_id
       and p.station_id = p_station_id
  ) into v_owned;
  if not v_owned then return false; end if;

  update public.station_presence p
     set left_at = greatest(p.entered_at, v_now)
   where p.client_ref = p_client_ref
     and p.session_id = p_session_id
     and p.station_id = p_station_id
     and p.left_at is null;

  select not exists (
    select 1 from public.station_presence p
     where p.client_ref = p_client_ref
       and p.session_id = p_session_id
       and p.station_id = p_station_id
       and p.left_at is null
  ) into v_closed;

  update public.station_locks l
     set session_id = null,
         client_ref = null,
         state = 'idle',
         acquired_at = null,
         expires_at = null,
         updated_at = v_now
   where l.station_id = p_station_id
     and l.session_id = p_session_id
     and l.client_ref = p_client_ref;

  return v_closed;
end;
$$;

-- TD keeps the same columns and URL. Only a valid, unexpired exclusive lease
-- is visible, so an older visitor can never be resurrected.
create or replace view public.v_active_at_station as
select l.station_id,
       s.id as session_id,
       s.color,
       s.color_name,
       coalesce(s.final_name, s.pseudonym) as display_name,
       s.final_name is not null as is_final,
       p.entered_at
  from public.station_locks l
  join public.station_presence p
    on p.client_ref = l.client_ref
   and p.session_id = l.session_id
   and p.station_id = l.station_id
   and p.left_at is null
  join public.sessions s on s.id = l.session_id
 where l.state = 'active'
   and l.expires_at > now()
   and s.status = 'active'
   and p.entered_at <= now() + interval '5 minutes'
   and s.entered_at <= now() + interval '5 minutes';

-- Monitoring follows the same unlimited-journey contract. Active now is not
-- cut off by session age; total today still uses the Seoul calendar day.
create or replace view public.v_live_count as
select
  (select count(*) from public.sessions where status = 'active') as active_now,
  (select count(*)
     from public.sessions
    where entered_at >= (
            date_trunc('day', now() at time zone 'Asia/Seoul')
            at time zone 'Asia/Seoul'
          )
      and entered_at < (
            (date_trunc('day', now() at time zone 'Asia/Seoul') + interval '1 day')
            at time zone 'Asia/Seoul'
          )) as total_today;

-- Backward-compatible maintenance entry point. The minutes argument remains
-- for existing staff tooling, but elapsed journey time never ends a session.
-- It now repairs only already-ended sessions and expired station leases.
create or replace function public.close_stale_sessions(minutes int default 90)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n int := 0;
  changed int := 0;
  closed_at timestamptz := clock_timestamp();
begin
  if minutes is null or minutes < 1 then
    raise exception 'minutes must be a positive integer';
  end if;

  update public.station_presence p
     set left_at = greatest(p.entered_at, coalesce(s.exited_at, closed_at))
    from public.sessions s
   where s.id = p.session_id
     and p.left_at is null
     and s.status <> 'active';
  get diagnostics n = row_count;

  update public.station_presence p
     set left_at = greatest(p.entered_at, closed_at)
    from public.station_locks l
   where l.client_ref = p.client_ref
     and l.state = 'active'
     and l.expires_at <= closed_at
     and p.left_at is null;
  get diagnostics changed = row_count;
  n := n + changed;

  update public.station_locks l
     set session_id = null,
         client_ref = null,
         state = 'idle',
         acquired_at = null,
         expires_at = null,
         updated_at = closed_at
   where l.state = 'active'
     and (
       l.expires_at <= closed_at
     or not exists (
         select 1 from public.sessions s
          where s.id = l.session_id and s.status = 'active'
       )
     );
  get diagnostics changed = row_count;
  n := n + changed;

  return n;
end;
$$;

revoke all on function public.claim_station(text, uuid, uuid, text, int)
  from public, anon;
revoke all on function public.renew_station(text, uuid, uuid, int)
  from public, anon;
revoke all on function public.release_station(text, uuid, uuid)
  from public, anon;
grant execute on function public.claim_station(text, uuid, uuid, text, int)
  to authenticated;
grant execute on function public.renew_station(text, uuid, uuid, int)
  to authenticated;
grant execute on function public.release_station(text, uuid, uuid)
  to authenticated;

revoke all on public.v_active_at_station from public, anon, authenticated;
grant select on public.v_active_at_station to service_role;
revoke all on public.v_live_count from public, anon, authenticated;
grant select on public.v_live_count to service_role;
revoke all on function public.close_stale_sessions(int)
  from public, anon, authenticated;
grant execute on function public.close_stale_sessions(int) to service_role;

commit;
