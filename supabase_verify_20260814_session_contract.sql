-- META ROSE Phone Hub — read-only verification after the 2026-08-14 migration

-- 1. The active view must rank first, then filter latest.left_at/status/age.
select pg_get_viewdef('public.v_active_at_station'::regclass, true)
  as active_view_definition;

-- 2. Old ended sessions must have no open presence. Expected: 0.
select count(*) as open_presence_for_non_active_session
from public.station_presence p
join public.sessions s on s.id = p.session_id
where p.left_at is null
  and s.status <> 'active';

-- 3. No stale active sessions should remain after the one-time cleanup.
-- Expected stale_active_sessions: 0.
-- remaining_active_sessions may be above 0 when a current phone is active.
select
  count(*) filter (
    where status = 'active'
      and (
        entered_at < now() - interval '180 minutes'
        or entered_at > now() + interval '5 minutes'
      )
  ) as stale_active_sessions,
  count(*) filter (where status = 'active') as remaining_active_sessions
from public.sessions;

-- 4. Operational truth. Before a new tag, station 01 may correctly be absent.
-- After the physical 01 NFC tag, exactly the new phone UUID must appear.
select *
from public.v_active_at_station
order by station_id;

-- 5. Recent lifecycle join for comparison with the phone and TD UUID.
select p.id, p.station_id, p.client_ref, p.session_id,
       p.entered_at, p.left_at, p.via,
       s.status, s.entered_at as session_entered_at,
       s.exited_at, s.end_reason, s.color, s.final_name
from public.station_presence p
join public.sessions s on s.id = p.session_id
order by p.entered_at desc, p.id desc
limit 20;

-- 6. Access must be false, false, true for each protected operation.
select
  has_table_privilege('anon', 'public.v_active_at_station', 'select') as anon_active,
  has_table_privilege('authenticated', 'public.v_active_at_station', 'select') as auth_active,
  has_table_privilege('service_role', 'public.v_active_at_station', 'select') as service_active,
  has_function_privilege('anon', 'public.close_stale_sessions(integer)', 'execute') as anon_cleanup,
  has_function_privilege('authenticated', 'public.close_stale_sessions(integer)', 'execute') as auth_cleanup,
  has_function_privilege('service_role', 'public.close_stale_sessions(integer)', 'execute') as service_cleanup;
