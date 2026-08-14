-- META ROSE Phone Hub - read-only verification
-- Run after supabase_migration_20260814_unlimited_session_lifecycle.sql.

-- 1. All four stations must still exist. Active rows may be present during a test.
select station_id, state, session_id, client_ref, acquired_at, expires_at
from public.station_locks
order by station_id;

-- 2. No journey-age cutoff may remain in the control functions or TD view.
with definitions as (
  select
    pg_get_functiondef(
      'public.claim_station(text,uuid,uuid,text,integer)'::regprocedure
    ) as claim_def,
    pg_get_functiondef(
      'public.renew_station(text,uuid,uuid,integer)'::regprocedure
    ) as renew_def,
    pg_get_functiondef(
      'public.close_stale_sessions(integer)'::regprocedure
    ) as cleanup_def,
    pg_get_viewdef('public.v_active_at_station'::regclass, true) as active_view_def
)
select
  position('180 minutes' in claim_def) = 0 as claim_has_no_180m_cutoff,
  position('180 minutes' in renew_def) = 0 as renew_has_no_180m_cutoff,
  position('round_timeout' in cleanup_def) = 0 as cleanup_never_ends_by_age,
  position('180 minutes' in active_view_def) = 0 as view_has_no_180m_cutoff,
  position('90 minutes' in active_view_def) = 0 as view_has_no_presence_age_cutoff
from definitions;

-- Expected: all five values are true.

-- 3. Inspect recent sessions. An active session older than three hours is now
-- valid for pattern entry and must not be changed by this verification.
select id, status, entered_at, now() - entered_at as journey_age,
       exited_at, end_reason
from public.sessions
order by entered_at desc
limit 12;

-- 4. Operational truth: each TD-visible UUID must equal its lock UUID.
select l.station_id,
       l.state as lock_state,
       l.session_id as lock_session_id,
       l.expires_at,
       v.session_id as td_view_session_id,
       v.color,
       v.display_name
from public.station_locks l
left join public.v_active_at_station v using (station_id)
order by l.station_id;
