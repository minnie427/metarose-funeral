-- META ROSE Phone Hub — read-only verification after running
-- supabase_migration_20260814_exclusive_station_locks.sql

-- 1. Exactly four seeded station locks should exist.
select station_id, state, session_id, client_ref, acquired_at, expires_at
from public.station_locks
order by station_id;

-- 2. Direct browser activation must be absent. SELECT and UPDATE ownership
-- policies remain so the phone can confirm and safely close its exact row.
select policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'station_presence'
order by policyname;

-- 3. Confirm the three lock RPC definitions and TD view definition.
select pg_get_functiondef(
  'public.claim_station(text,uuid,uuid,text,integer)'::regprocedure
) as claim_station_definition;
select pg_get_functiondef(
  'public.renew_station(text,uuid,uuid,integer)'::regprocedure
) as renew_station_definition;
select pg_get_functiondef(
  'public.release_station(text,uuid,uuid)'::regprocedure
) as release_station_definition;
select pg_get_viewdef('public.v_active_at_station'::regclass, true)
  as active_station_view_definition;

-- 4. Browser can execute only the RPCs; only TD's service_role can read the
-- live view directly.
select
  has_function_privilege('anon', 'public.claim_station(text,uuid,uuid,text,integer)', 'execute') as anon_claim,
  has_function_privilege('authenticated', 'public.claim_station(text,uuid,uuid,text,integer)', 'execute') as audience_claim,
  has_function_privilege('anon', 'public.renew_station(text,uuid,uuid,integer)', 'execute') as anon_renew,
  has_function_privilege('authenticated', 'public.renew_station(text,uuid,uuid,integer)', 'execute') as audience_renew,
  has_function_privilege('anon', 'public.release_station(text,uuid,uuid)', 'execute') as anon_release,
  has_function_privilege('authenticated', 'public.release_station(text,uuid,uuid)', 'execute') as audience_release,
  has_table_privilege('anon', 'public.v_active_at_station', 'select') as anon_active_view,
  has_table_privilege('authenticated', 'public.v_active_at_station', 'select') as audience_active_view,
  has_table_privilege('service_role', 'public.v_active_at_station', 'select') as td_active_view;

-- Expected booleans in order:
-- false, true, false, true, false, true, false, false, true

-- 5. Operational truth. Before a phone claims a work, both result sets may be
-- empty/idle. After a successful pattern match, the same UUID must appear in
-- station_locks and v_active_at_station for that station.
select *
from public.v_active_at_station
order by station_id;

select l.station_id, l.state, l.session_id, l.client_ref,
       l.acquired_at, l.expires_at,
       p.entered_at, p.left_at, p.via,
       s.status as session_status
from public.station_locks l
left join public.station_presence p on p.client_ref = l.client_ref
left join public.sessions s on s.id = l.session_id
order by l.station_id;
