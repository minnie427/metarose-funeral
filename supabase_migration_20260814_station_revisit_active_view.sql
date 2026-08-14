-- META ROSE Phone Hub — active-session attribution hardening
-- Apply once in Supabase SQL Editor before the MAIN1 end-to-end retest.

begin;

-- A browser may insert only a presence that TD could actually accept.
drop policy if exists audience_insert_presence on public.station_presence;
create policy audience_insert_presence
on public.station_presence for insert to authenticated
with check (
  station_presence.left_at is null
  and station_presence.entered_at >= now() - interval '90 minutes'
  and station_presence.entered_at <= now() + interval '5 minutes'
  and
  exists (
    select 1
    from public.sessions s
    where s.id = station_presence.session_id
      and s.auth_uid = auth.uid()
      and s.status = 'active'
      and s.entered_at >= now() - interval '180 minutes'
      and s.entered_at <= now() + interval '5 minutes'
  )
);

-- End stale sessions and close their still-open presence rows. No history is
-- deleted; left_at/status make the lifecycle explicit for later analysis.
create or replace function public.close_stale_sessions(minutes int default 90)
returns int
language plpgsql
as $$
declare
  n int := 0;
  closed_at timestamptz := now();
begin
  if minutes is null or minutes < 1 then
    raise exception 'minutes must be a positive integer';
  end if;

  update public.sessions
     set status = 'ended',
         exited_at = coalesce(exited_at, closed_at),
         end_reason = coalesce(end_reason, 'round_timeout')
   where status = 'active'
     and (
       entered_at < closed_at - (minutes || ' minutes')::interval
       or entered_at > closed_at + interval '5 minutes'
     );
  get diagnostics n = row_count;

  update public.station_presence p
     set left_at = greatest(p.entered_at, coalesce(s.exited_at, closed_at))
    from public.sessions s
   where s.id = p.session_id
     and p.left_at is null
     and s.status <> 'active';

  return n;
end
$$;

-- Rank the newest presence for each station before filtering. This makes a
-- closed newest visit resolve to idle instead of resurrecting an older open row.
-- Only a currently active and recent exhibition session is eligible.
create or replace view public.v_active_at_station as
select latest.station_id,
       latest.session_id,
       latest.color,
       latest.color_name,
       latest.display_name,
       latest.is_final,
       latest.entered_at
from (
  select distinct on (p.station_id)
         p.station_id,
         s.id as session_id,
         s.color,
         s.color_name,
         coalesce(s.final_name, s.pseudonym) as display_name,
         s.final_name is not null as is_final,
         p.entered_at,
         p.left_at,
         s.status as session_status,
         s.entered_at as session_entered_at
  from public.station_presence p
  join public.sessions s on s.id = p.session_id
  order by p.station_id, p.entered_at desc, p.id desc
) latest
where latest.left_at is null
  and latest.session_status = 'active'
  and latest.entered_at >= now() - interval '90 minutes'
  and latest.entered_at <= now() + interval '5 minutes'
  and latest.session_entered_at >= now() - interval '180 minutes'
  and latest.session_entered_at <= now() + interval '5 minutes';

-- Seoul calendar-day counts must be converted back to timestamptz while the
-- Supabase SQL session itself runs in UTC.
create or replace view public.v_live_count as
select count(*) filter (
         where status = 'active'
           and entered_at >= now() - interval '180 minutes'
           and entered_at <= now() + interval '5 minutes'
       ) as active_now,
       count(*) as total_today
from public.sessions
where entered_at >= (
        date_trunc('day', now() at time zone 'Asia/Seoul')
        at time zone 'Asia/Seoul'
      )
  and entered_at < (
        (date_trunc('day', now() at time zone 'Asia/Seoul') + interval '1 day')
        at time zone 'Asia/Seoul'
      );

-- One conservative cleanup for old development/test sessions. This only
-- marks/ends records; it never deletes them.
select public.close_stale_sessions(180);

-- TD service role only. Audience browsers must not enumerate station presence.
revoke all on public.v_active_at_station, public.v_live_count
  from public, anon, authenticated;
grant select on public.v_active_at_station, public.v_live_count
  to service_role;
revoke all on function public.close_stale_sessions(int)
  from public, anon, authenticated;
grant execute on function public.close_stale_sessions(int)
  to service_role;

commit;
