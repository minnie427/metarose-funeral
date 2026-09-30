-- META ROSE Melbourne 2026
-- Give every Phone Hub-owned station presence a stable non-empty display name.
-- A visitor's chosen final_name still takes precedence. This changes no UUID,
-- station lock, capture, artifact, RLS or physical-run behaviour.

begin;

create or replace view public.v_active_at_station as
select l.station_id,
       s.id as session_id,
       s.color,
       s.color_name,
       coalesce(
         nullif(btrim(s.final_name), ''),
         nullif(btrim(s.pseudonym), ''),
         'PHONE ROSE · ' || upper(substr(replace(s.id::text, '-', ''), 1, 8))
       ) as display_name,
       nullif(btrim(s.final_name), '') is not null as is_final,
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

comment on view public.v_active_at_station is
  'Active Melbourne Phone Hub owner. display_name is chosen final_name, stored Phone Rose pseudonym, or deterministic PHONE ROSE plus UUID prefix.';

commit;

-- Expected verification result: display_name is never NULL or blank.
select station_id,
       session_id,
       color,
       display_name,
       is_final,
       entered_at
  from public.v_active_at_station
 order by station_id;
