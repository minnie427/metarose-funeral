-- ============================================================
-- 폰 허브 — Supabase 스키마
-- 근거: 22_데이터측정_설계.md §5-5 / 21_폰허브_핸드오버.md §4
-- 전시: 오늘 나는 죽인다, 나를 · 서울 프린지 2026 (8/15·16·18)
--
-- 사용법: Supabase 대시보드 → SQL Editor → 전체 붙여넣기 → Run
-- ============================================================

-- ------------------------------------------------------------
-- 0. 원칙 (구현자가 반드시 지킬 것 — 22 §5-2)
--    · 타임스탬프는 "행동한 순간"(occurred_at). 전송 시각(created_at)과 분리
--    · 모든 이벤트에 session_id·team_id·station_id·scope 포함
--    · payload는 JSONB — 작품이 바뀌어도 스키마 불변 = 이식성
--    · seq(순번)로 유실 감지
--    · schema_version으로 전시 간 해석 가능성 유지
-- ------------------------------------------------------------

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- 1. teams — 회차 단위로 함께 이동하는 2~4인
-- ------------------------------------------------------------
create table if not exists teams (
  id           uuid primary key default gen_random_uuid(),
  round_no     int,                     -- 회차 번호
  member_count int,
  formed_at    timestamptz not null default now(),
  note         text
);

-- ------------------------------------------------------------
-- 2. sessions — 관객 1인 = 1세션. 계정 없음, 신원 정보 없음
--    session status는 전체 여정의 lifecycle이다. 종료된 관객이 다시
--    체험하려면 새 UUID를 발급해 TD 귀속이 섞이지 않게 한다.
-- ------------------------------------------------------------
create table if not exists sessions (
  id             uuid primary key default gen_random_uuid(),
  auth_uid       uuid,          -- Supabase Anonymous Auth UUID. 신원정보가 아닌 접근권한용 난수
  team_id        uuid references teams(id) on delete set null,
  status         text not null default 'active',   -- active | ended
  entered_at     timestamptz not null default now(),
  exited_at      timestamptz,
  end_reason     text,          -- survey_done | ending_reached | round_timeout | manual
  round_no       int,
  ticket_type    text,          -- paid | free | invited
  consent        boolean not null default false,
  consent_at     timestamptz,
  ab_group       text,          -- A/B 개입 그룹 (22 §4-B — 설계 전이라 비워둠)
  color          text,          -- #RRGGBB — 개인 시그니처. 부2 식별자로 작동
  color_name     text,
  pseudonym      text,          -- 가명(假名)
  final_name     text,          -- 최종 명명 (가명을 덮어씀)
  final_name_a   text,          -- 1박자: 미워했던 면
  final_name_b   text,          -- 2박자: 그 '나'의 다른 면
  lang           text default 'ko',
  device         jsonb,         -- 익명 기기 정보 (UA·화면크기)
  schema_version text not null default 'fringe2026.1',
  created_at     timestamptz not null default now()
);

create index if not exists idx_sessions_status on sessions(status);
create index if not exists idx_sessions_round  on sessions(round_no);

-- ------------------------------------------------------------
-- 3. station_presence — 태깅(QR·NFC)으로 만들어지는 "결합"
--    귀속(attribution)의 핵심: TD는 누구인지 모른다.
--    서버가 "그 시각 그 스테이션의 활성 세션"을 찾아 붙인다. (21 §1)
-- ------------------------------------------------------------
create table if not exists station_presence (
  id          bigserial primary key,
  client_ref  uuid,                 -- 폰의 오프라인 재전송 식별자
  session_id  uuid not null references sessions(id) on delete cascade,
  station_id  text not null,        -- '00'..'05'
  entered_at  timestamptz not null default now(),
  left_at     timestamptz,
  via         text,                 -- nfc | qr | manual
  created_at  timestamptz not null default now()
);

create index if not exists idx_presence_station_time
  on station_presence(station_id, entered_at desc);

create unique index if not exists uq_presence_client_ref
  on station_presence(client_ref) where client_ref is not null;

-- ------------------------------------------------------------
-- 4. events — 모든 행동. A·B의 모든 기능이 여기 남는다 (21 §C1)
-- ------------------------------------------------------------
create table if not exists events (
  id             bigserial primary key,
  event_uid      uuid,          -- TD checkpoint 재전송 dedupe key
  session_id     uuid references sessions(id) on delete cascade,
  team_id        uuid references teams(id) on delete set null,
  station_id     text,
  event_type     text not null,
  scope          text not null default 'individual',  -- individual | team | anonymous
  occurred_at    timestamptz not null,    -- ★ 행동한 순간
  created_at     timestamptz not null default now(),  -- 전송 시각
  seq            bigint,                  -- 세션 내 순번 (유실 감지)
  source         text not null default 'phone',       -- phone | td_main1 | td_sub1 | td_sub2
  payload        jsonb not null default '{}'::jsonb,
  schema_version text not null default 'fringe2026.1'
);

create index if not exists idx_events_session on events(session_id, seq);
create index if not exists idx_events_type    on events(event_type);
create index if not exists idx_events_time    on events(occurred_at desc);
create index if not exists idx_events_station on events(station_id, occurred_at desc);

-- 같은 이벤트가 오프라인 큐 재전송으로 중복 들어오는 것 방지
create unique index if not exists uq_events_session_seq
  on events(session_id, seq) where session_id is not null and seq is not null;
create unique index if not exists uq_events_event_uid
  on events(event_uid) where event_uid is not null;

-- ------------------------------------------------------------
-- 5. artifacts — 관객이 남긴 것
--    type: pseudonym | naming | combo | capture | ending | offering
-- ------------------------------------------------------------
create table if not exists artifacts (
  id          bigserial primary key,
  session_id  uuid references sessions(id) on delete cascade,
  station_id  text,
  type        text not null,
  value       text,        -- 텍스트 아티팩트
  image_path  text,        -- ⚠️ 이미지 원본은 TD 로컬 보관, 여기엔 경로만
                           --    (21 §5 — 무료 1GB 초과 회피)
  image_url   text,        -- Storage를 쓰기로 결정했을 때만 채움
  meta        jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_artifacts_session on artifacts(session_id, type);

-- ------------------------------------------------------------
-- 6. survey — 마무리 행동 (A11). 결과 화면의 전제
-- ------------------------------------------------------------
create table if not exists survey (
  id          bigserial primary key,
  session_id  uuid references sessions(id) on delete cascade,
  question_id text not null,
  answer      text,
  answer_num  numeric,     -- 척도 문항용
  meta        jsonb not null default '{}'::jsonb,  -- 작성시간·수정횟수 (C7)
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_survey_session on survey(session_id);

-- ------------------------------------------------------------
-- 7. anon_presence — 익명 자동감지 (C8) 【미확정】
--    ★ 개인 데이터와 절대 결합하지 않는다 (21 §0-A)
--    session_id 컬럼이 없는 것이 설계다. 도입 안 하면 비어 있음.
-- ------------------------------------------------------------
create table if not exists anon_presence (
  id          bigserial primary key,
  station_id  text not null,
  sensor      text,
  occupied    boolean,
  head_count  int,
  occurred_at timestamptz not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 8. RLS — 관객은 자기 익명 세션만 읽고 쓸 수 있다.
--    Phone Hub는 Anonymous Auth 후 authenticated 역할이 된다.
--    TD는 이 정책을 우회하는 service_role key를 TD 로컬 컴퓨터에만 둔다.
-- ------------------------------------------------------------
alter table teams            enable row level security;
alter table sessions         enable row level security;
alter table station_presence enable row level security;
alter table events           enable row level security;
alter table artifacts        enable row level security;
alter table survey           enable row level security;
alter table anon_presence    enable row level security;

create policy audience_insert_sessions on sessions for insert to authenticated
  with check (auth_uid = auth.uid());
create policy audience_select_sessions on sessions for select to authenticated
  using (auth_uid = auth.uid());
create policy audience_update_sessions on sessions for update to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

create policy audience_insert_presence on station_presence for insert to authenticated
  with check (
    station_presence.left_at is null
    and station_presence.entered_at >= now() - interval '90 minutes'
    and station_presence.entered_at <= now() + interval '5 minutes'
    and exists (
    select 1 from sessions s
    where s.id = station_presence.session_id
      and s.auth_uid = auth.uid()
      and s.status = 'active'
      and s.entered_at >= now() - interval '180 minutes'
      and s.entered_at <= now() + interval '5 minutes'
  ));
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

-- ------------------------------------------------------------
-- 9. 뷰 — 전시 중 실시간 모니터링 + 전시 후 분석 (22 §4-2)
-- ------------------------------------------------------------

-- 9-1. TD가 폴링하는 "지금 이 스테이션의 활성 세션"
--      스테이션별 최신 presence를 먼저 고른 뒤 유효성을 검사한다.
--      그래야 최신 관객이 나간 뒤 과거의 열린 행이 되살아나지 않는다.
--      종료된 관객은 새 UUID를 발급한 뒤에만 다시 체험한다.
create or replace view v_active_at_station as
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
  from station_presence p
  join sessions s on s.id = p.session_id
  order by p.station_id, p.entered_at desc, p.id desc
) latest
where latest.left_at is null
  and latest.session_status = 'active'
  and latest.entered_at >= now() - interval '90 minutes'
  and latest.entered_at <= now() + interval '5 minutes'
  and latest.session_entered_at >= now() - interval '180 minutes'
  and latest.session_entered_at <= now() + interval '5 minutes';

-- 9-2. 운영 모니터링 — 지금 몇 명이 안에 있나 (혼잡도 B3의 소스)
create or replace view v_live_count as
select count(*) filter (
         where status = 'active'
           and entered_at >= now() - interval '180 minutes'
           and entered_at <= now() + interval '5 minutes'
       ) as active_now,
       count(*)                                  as total_today
from sessions
where entered_at >= (
        date_trunc('day', now() at time zone 'Asia/Seoul')
        at time zone 'Asia/Seoul'
      )
  and entered_at < (
        (date_trunc('day', now() at time zone 'Asia/Seoul') + interval '1 day')
        at time zone 'Asia/Seoul'
      );

-- 9-3. 되돌아옴 — 같은 세션이 같은 스테이션에 2회 이상 (22 §4-2)
create or replace view v_returning as
select session_id, station_id, count(*) as visits
from station_presence
group by session_id, station_id
having count(*) > 1;

-- 9-4. 가명 → 최종 명명의 변화 (핵심 관계적 지표)
create or replace view v_naming_shift as
select id as session_id, pseudonym, final_name, final_name_a, final_name_b,
       char_length(coalesce(final_name,'')) - char_length(coalesce(pseudonym,'')) as len_delta
from sessions
where pseudonym is not null or final_name is not null;

-- 9-5. 결합 누락률 — TD 인터랙션은 있는데 태깅이 없는 비율 (그 자체가 UX 지표)
create or replace view v_attribution_gap as
select station_id,
       count(*) filter (where session_id is null) as unattributed,
       count(*)                                   as total,
       round(100.0 * count(*) filter (where session_id is null) / nullif(count(*),0), 1) as gap_pct
from events
where source <> 'phone'
group by station_id;

-- 9-6. 회차 종료 자동 마감 폴백 (C3 — 설문 미이행자)
--      전시 중 회차가 끝날 때마다 실행: select close_stale_sessions(90);
create or replace function close_stale_sessions(minutes int default 90)
returns int language plpgsql as $$
declare n int;
begin
  if minutes is null or minutes < 1 then
    raise exception 'minutes must be a positive integer';
  end if;

  update sessions
     set status = 'ended',
         exited_at = coalesce(exited_at, now()),
         end_reason = coalesce(end_reason, 'round_timeout')
   where status = 'active'
     and (
       entered_at < now() - (minutes || ' minutes')::interval
       or entered_at > now() + interval '5 minutes'
     );
  get diagnostics n = row_count;

  update station_presence p
     set left_at = greatest(p.entered_at, coalesce(s.exited_at, now()))
    from sessions s
   where s.id = p.session_id
     and p.left_at is null
     and s.status <> 'active';

  return n;
end $$;

-- 내부 운영용 뷰/함수는 관객 브라우저에서 열지 않는다.
revoke all on v_active_at_station, v_live_count, v_returning, v_naming_shift,
  v_attribution_gap from anon, authenticated;
revoke all on function close_stale_sessions(int) from public, anon, authenticated;
grant select on v_active_at_station, v_live_count, v_returning, v_naming_shift,
  v_attribution_gap to service_role;
grant execute on function close_stale_sessions(int) to service_role;

-- ------------------------------------------------------------
-- 10. 회수 (22 §4-3)
--     대시보드 → Table Editor → 각 테이블 Export CSV
--     또는 SQL Editor에서 위 뷰를 그대로 조회
--     🔴 전시 종료 후 즉시 백업. 3일치를 한 번에 잃으면 검증이 무너진다.
-- ------------------------------------------------------------
