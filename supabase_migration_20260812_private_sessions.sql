-- META ROSE Phone Hub — privacy + TD checkpoint migration
-- 이미 supabase_schema.sql을 실행한 현재 프로젝트에 한 번만 실행한다.
-- 실행 전: Phone Hub 코드의 Anonymous Auth 버전을 배포하고,
-- Supabase Dashboard > Authentication > Providers에서 Anonymous Sign-Ins를 켠다.

alter table sessions add column if not exists auth_uid uuid;
alter table events add column if not exists event_uid uuid;
create unique index if not exists uq_events_event_uid
  on events(event_uid) where event_uid is not null;

-- 이전 공개 정책은 반드시 제거한다. 이 정책들이 남아 있으면 관객 브라우저가
-- 다른 관객의 익명 감정명·이벤트를 조회할 수 있다.
drop policy if exists anon_insert_teams on teams;
drop policy if exists anon_insert_sessions on sessions;
drop policy if exists anon_insert_station_presence on station_presence;
drop policy if exists anon_insert_events on events;
drop policy if exists anon_insert_artifacts on artifacts;
drop policy if exists anon_insert_survey on survey;
drop policy if exists anon_insert_anon_presence on anon_presence;
drop policy if exists anon_select_sessions on sessions;
drop policy if exists anon_select_presence on station_presence;
drop policy if exists anon_select_artifacts on artifacts;
drop policy if exists anon_select_events on events;
drop policy if exists anon_update_sessions on sessions;
drop policy if exists anon_update_presence on station_presence;

drop policy if exists audience_insert_sessions on sessions;
drop policy if exists audience_select_sessions on sessions;
drop policy if exists audience_update_sessions on sessions;
drop policy if exists audience_insert_presence on station_presence;
drop policy if exists audience_select_presence on station_presence;
drop policy if exists audience_update_presence on station_presence;
drop policy if exists audience_insert_events on events;
drop policy if exists audience_select_events on events;
drop policy if exists audience_insert_artifacts on artifacts;
drop policy if exists audience_select_artifacts on artifacts;
drop policy if exists audience_insert_survey on survey;
drop policy if exists audience_select_survey on survey;

create policy audience_insert_sessions on sessions for insert to authenticated
  with check (auth_uid = auth.uid());
create policy audience_select_sessions on sessions for select to authenticated
  using (auth_uid = auth.uid());
create policy audience_update_sessions on sessions for update to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

create policy audience_insert_presence on station_presence for insert to authenticated
  with check (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));
create policy audience_select_presence on station_presence for select to authenticated
  using (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));
create policy audience_update_presence on station_presence for update to authenticated
  using (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()))
  with check (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));

create policy audience_insert_events on events for insert to authenticated
  with check (source = 'phone' and exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));
create policy audience_select_events on events for select to authenticated
  using (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));

create policy audience_insert_artifacts on artifacts for insert to authenticated
  with check (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));
create policy audience_select_artifacts on artifacts for select to authenticated
  using (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));

create policy audience_insert_survey on survey for insert to authenticated
  with check (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));
create policy audience_select_survey on survey for select to authenticated
  using (exists (select 1 from sessions s where s.id = session_id and s.auth_uid = auth.uid()));

-- 이 뷰와 자동 종료 함수는 TD/운영자만 쓰며, 관객에게 공개하면 안 된다.
revoke all on v_active_at_station, v_live_count, v_returning, v_naming_shift,
  v_attribution_gap from anon, authenticated;
revoke all on function close_stale_sessions(int) from public, anon, authenticated;
grant select on v_active_at_station, v_live_count, v_returning, v_naming_shift,
  v_attribution_gap to service_role;
grant execute on function close_stale_sessions(int) to service_role;
