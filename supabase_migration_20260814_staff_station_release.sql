-- META ROSE Phone Hub — staff-only emergency station release
-- Run once after supabase_migration_20260814_exclusive_station_locks.sql.
-- This installs an operations function only. It deletes no rows and does not
-- end the audience session, so the same rose can enter again later.

begin;

create or replace function public.force_release_station(p_station_id text)
returns table (
  released_station_id text,
  released_session_id uuid,
  released_client_ref uuid,
  released_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_session_id uuid;
  v_client_ref uuid;
begin
  if p_station_id is null
     or p_station_id not in ('01', '02', '03', '04') then
    raise exception 'invalid station id: %', p_station_id;
  end if;

  perform pg_advisory_xact_lock(20260814, 4271);

  select l.session_id, l.client_ref
    into v_session_id, v_client_ref
    from public.station_locks l
   where l.station_id = p_station_id
   for update;

  if not found then
    raise exception 'station lock row is missing: %', p_station_id;
  end if;

  if v_client_ref is not null then
    update public.station_presence p
       set left_at = greatest(p.entered_at, v_now)
     where p.client_ref = v_client_ref
       and p.station_id = p_station_id
       and p.left_at is null;
  end if;

  update public.station_locks
     set session_id = null,
         client_ref = null,
         state = 'idle',
         acquired_at = null,
         expires_at = null,
         updated_at = v_now
   where station_id = p_station_id;

  return query select p_station_id, v_session_id, v_client_ref, v_now;
end;
$$;

revoke all on function public.force_release_station(text)
  from public, anon, authenticated;
grant execute on function public.force_release_station(text)
  to service_role;

commit;

-- OPERATION — run only after visually confirming the work is empty:
-- select * from public.force_release_station('01');
