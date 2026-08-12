// ============================================================
// 폰 허브 — 데이터 레이어
//
// 원칙 (22 §5-2 — 여기서 어기면 데이터가 통째로 오염된다):
//   · 타임스탬프는 "행동한 순간". 전송 시각으로 찍지 않는다
//   · 모든 이벤트에 session·station·scope·seq
//   · 끊기면 브라우저에 쌓고 복구 시 전송 (C4)
//   · Supabase가 없어도 앱은 죽지 않는다 (graceful degradation)
// ============================================================

import { CONFIG } from './config.js';

const LS = {
  session:  'fringe26.session',
  queue:    'fringe26.queue',
  analytics:'fringe26.analytics',
  seq:      'fringe26.seq',
  state:    'fringe26.state',
};

let sb = null;               // Supabase client
let ready = false;
let online = navigator.onLine;

// 관객은 계정을 만들지 않는다. Supabase Anonymous Auth가 기기 안에만
// 익명 UUID를 보관하고, RLS가 이 UUID의 세션만 읽고 쓰도록 제한한다.
// 이는 관객 식별 정보가 아니라 접근권한용 난수다.
async function ensureAudienceAuth() {
  if (!sb) return null;
  const { data: existing } = await sb.auth.getUser();
  if (existing?.user) return existing.user;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return data.user || null;
}

// 오프라인 입장도 잃지 않는다. 입장 당시 인터넷이 없어서 auth_uid가 없던
// session은 연결이 돌아온 뒤 같은 session id에 익명 권한만 붙여 전송한다.
// 이미 queue에 들어간 sessions insert 행도 함께 갱신해야 순서가 뒤집히지 않는다.
async function attachAudienceAuthToActiveSession() {
  const current = loadSession();
  if (!current || current.status !== 'active' || current.auth_uid || !ready || !online) return current;
  const user = await ensureAudienceAuth();
  if (!user) return current;

  const next = { ...current, auth_uid: user.id };
  saveSession(next);

  const q = readQueue();
  let queuedInsert = false;
  for (const job of q) {
    if (job.table === 'sessions' && job.op === 'insert' && job.row?.id === next.id) {
      job.row.auth_uid = user.id;
      queuedInsert = true;
    }
  }
  if (queuedInsert) writeQueue(q);
  else enqueue({ table: 'sessions', op: 'update', id: next.id, row: { auth_uid: user.id } });
  return next;
}

// ------------------------------------------------------------
// 초기화 — Supabase SDK를 CDN에서 동적 import.
// 실패해도 앱은 로컬 모드로 계속 간다.
// ------------------------------------------------------------
export async function initDB() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    console.warn('[db] Supabase 미설정 — 로컬 전용 모드');
    startFlushLoop();
    return { ready: false, reason: 'not-configured' };
  }
  try {
    const { createClient } = await import(
      'https://esm.sh/@supabase/supabase-js@2'
    );
    sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    ready = true;
    await attachAudienceAuthToActiveSession();
  } catch (e) {
    console.error('[db] Supabase 로드 실패 — 로컬 모드로 계속', e);
    ready = false;
  }
  startFlushLoop();
  return { ready };
}

export const isReady   = () => ready;
export const isOnline  = () => online;

window.addEventListener('online', async () => {
  online = true;
  try {
    await attachAudienceAuthToActiveSession();
  } catch (e) {
    console.warn('[db] 재연결 익명 인증 실패 — 다음 재시도까지 로컬 보관', e);
  }
  flushAnalyticsEvents('reconnect');
  flushQueue(true);
});
window.addEventListener('offline', () => { online = false; });

// ------------------------------------------------------------
// 세션 상태 — localStorage에 유지. 브라우저를 닫았다 열어도 복구된다.
// ------------------------------------------------------------
export function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS.session) || 'null'); }
  catch { return null; }
}

function saveSession(s) {
  localStorage.setItem(LS.session, JSON.stringify(s));
}

export function getState() {
  try { return JSON.parse(localStorage.getItem(LS.state) || '{}'); }
  catch { return {}; }
}

export function setState(patch) {
  const s = { ...getState(), ...patch };
  localStorage.setItem(LS.state, JSON.stringify(s));
  return s;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function nextSeq() {
  const n = (parseInt(localStorage.getItem(LS.seq) || '0', 10) || 0) + 1;
  localStorage.setItem(LS.seq, String(n));
  return n;
}

// ------------------------------------------------------------
// A1. 세션 발급
//   ★ 세션 id를 클라이언트에서 만든다. 그래야 오프라인에서도 발급되고,
//     나중에 연결되면 그 id 그대로 서버에 올라간다.
// ------------------------------------------------------------
export async function startSession({ consent = false, roundNo = null } = {}) {
  const existing = loadSession();
  if (existing && existing.status === 'active') {
    try { await attachAudienceAuthToActiveSession(); }
    catch (e) { console.warn('[db] 기존 세션 익명 인증 보류', e); }
    return loadSession() || existing;
  }

  let audienceUser = null;
  if (ready && online) {
    try {
      audienceUser = await ensureAudienceAuth();
    } catch (e) {
      // 인증 문제가 있어도 작품 흐름은 중단하지 않는다. local queue에 남기고
      // 연결 복구 뒤 다시 전송한다.
      console.warn('[db] 익명 인증 실패 — 로컬 기록 모드로 계속', e);
    }
  }

  const s = {
    id: uuid(),
    status: 'active',
    entered_at: new Date().toISOString(),
    consent,
    consent_at: consent ? new Date().toISOString() : null,
    round_no: roundNo,
    lang: (navigator.language || 'ko').startsWith('ko') ? 'ko' : 'en',
    // 세부 UA·화면해상도처럼 기기 지문이 될 수 있는 값은 수집하지 않는다.
    device: { form_factor: matchMedia('(max-width: 700px)').matches ? 'phone' : 'large_screen' },
    auth_uid: audienceUser?.id || null,
    schema_version: 'fringe2026.1',
  };
  saveSession(s);

  // ★ 동의 화면에서 이미 쌓인 이벤트(읽기 행동·스크롤 깊이)를 이 세션에 붙인다.
  //   세션 발급 전에 일어난 행동도 이 관객의 것이다 — 22 §1-1의
  //   "맥락을 얼마나 받아들였나"가 바로 이 구간에서 나온다.
  //   ⚠️ seq는 리셋하지 않는다. 리셋하면 (session_id, seq)가 겹친다.
  backfillSession(s.id);
  backfillAnalyticsSession(s.id);

  enqueue({ table: 'sessions', op: 'insert', row: s });
  logEvent('session_start', { scope: 'individual' });
  return s;
}

function backfillSession(sessionId) {
  const q = readQueue();
  let n = 0;
  for (const job of q) {
    if (job.table === 'events' && job.row && job.row.session_id == null) {
      job.row.session_id = sessionId;
      n += 1;
    }
  }
  if (n) { writeQueue(q); console.info(`[db] 세션 발급 전 이벤트 ${n}건 귀속`); }
}

function backfillAnalyticsSession(sessionId) {
  const q = readAnalyticsQueue();
  let n = 0;
  for (const row of q) {
    if (row.session_id == null) {
      row.session_id = sessionId;
      n += 1;
    }
  }
  if (n) writeAnalyticsQueue(q);
}

// 세션 필드 갱신 (색·가명·명명 등)
export async function updateSession(patch) {
  const s = loadSession();
  if (!s) return null;
  const next = { ...s, ...patch };
  saveSession(next);
  enqueue({ table: 'sessions', op: 'update', id: s.id, row: patch });
  return next;
}

// ------------------------------------------------------------
// C3. 세션 종료 마킹
//   🔴 8/6 변경 — 스크린샷과 분리한다.
//      부1은 엔딩 도달 시점이 종료 이벤트다. 설문 완료도 종료 신호.
//      미이행자는 서버의 close_stale_sessions()가 회차 종료로 마감.
// ------------------------------------------------------------
export async function endSession(reason = 'survey_done') {
  const s = loadSession();
  if (!s || s.status === 'ended') return s;
  const patch = {
    status: 'ended',
    exited_at: new Date().toISOString(),
    end_reason: reason,
  };
  logEvent('session_end', { payload: { reason } });
  return updateSession(patch);
}

// ------------------------------------------------------------
// C1. 이벤트 로깅 — 모든 행동이 여기로 온다
// ------------------------------------------------------------
export function logEvent(type, {
  station = null,
  scope = 'individual',
  payload = {},
  occurredAt = null,
} = {}) {
  const s = loadSession();
  const row = {
    session_id: s ? s.id : null,
    team_id: s ? (s.team_id || null) : null,
    station_id: station ?? getState().station ?? null,
    event_type: type,
    scope,
    occurred_at: occurredAt || new Date().toISOString(),  // ★ 행동한 순간
    seq: nextSeq(),
    source: 'phone',
    payload,
    schema_version: 'fringe2026.1',
  };
  enqueue({ table: 'events', op: 'insert', row });
  if (CONFIG.DEBUG) console.log('[event]', type, row);
  window.dispatchEvent(new CustomEvent('fringe:event', { detail: row }));
  return row;
}

// 분석 전용 행동은 서버로 즉시 보내지 않는다. 동일한 event 형식을 유지해
// 나중에 events 테이블에서 한 줄씩 분석할 수 있게 하고, checkpoint에서만
// 일반 전송 queue로 옮긴다.
export function logAnalyticsEvent(type, {
  station = null,
  scope = 'individual',
  payload = {},
  occurredAt = null,
} = {}) {
  const s = loadSession();
  const row = {
    session_id: s ? s.id : null,
    team_id: s ? (s.team_id || null) : null,
    station_id: station ?? getState().station ?? null,
    event_type: type,
    scope,
    occurred_at: occurredAt || new Date().toISOString(),
    seq: nextSeq(),
    source: 'phone',
    payload,
    schema_version: 'fringe2026.1',
  };
  const q = readAnalyticsQueue();
  q.push(row);
  writeAnalyticsQueue(q);
  window.dispatchEvent(new CustomEvent('fringe:analytics', { detail: row }));
  return row;
}

// 작품 완료, 화면 전환, 백그라운드, 재접속, Exit에서 호출한다.
// analytics buffer에서 main queue로 옮긴 뒤의 서버 전송·재시도는 기존
// offline queue가 보장한다. 따라서 네트워크 실패로 기록을 버리지 않는다.
export function flushAnalyticsEvents(reason = 'checkpoint') {
  const q = readAnalyticsQueue();
  const s = loadSession();
  if (!q.length || !s) return 0;

  for (const row of q) {
    if (row.session_id == null) row.session_id = s.id;
    if (row.team_id == null) row.team_id = s.team_id || null;
    enqueue({ table: 'events', op: 'insert', row });
  }
  writeAnalyticsQueue([]);
  logEvent('analytics_checkpoint', {
    payload: { reason, event_count: q.length },
  });
  return q.length;
}

// ------------------------------------------------------------
// 태깅 — QR/NFC로 스테이션에 들어왔다 = "결합"
// ------------------------------------------------------------
export async function enterStation(stationId, via = 'qr') {
  const s = loadSession();
  if (!s) return null;
  const now = new Date().toISOString();

  // 이전 스테이션을 닫는다
  const st = getState();
  if (st.presenceId && st.station && st.station !== stationId) {
    enqueue({
      table: 'station_presence', op: 'update',
      id: st.presenceId, row: { left_at: now },
    });
  }

  const presenceId = uuid();
  enqueue({
    table: 'station_presence', op: 'insert',
    row: {
      id_client: presenceId,   // 클라 생성 id — 서버는 bigserial이라
                               // payload로만 쓰고 실제 매칭은 시각으로 한다
      session_id: s.id,
      station_id: stationId,
      entered_at: now,
      via,
    },
  });
  setState({ station: stationId, presenceId, stationEnteredAt: now });
  logEvent('station_enter', {
    station: stationId,
    payload: { via },
    occurredAt: now,
  });
  return stationId;
}

// 스테이션을 떠날 때 열린 presence를 닫는다.
// UI의 event 기록은 app.js가 별도로 남기므로 여기서는 결합 상태만 갱신한다.
export function leaveStation(stationId = getState().station) {
  const s = loadSession();
  if (!s || !stationId) return null;
  const now = new Date().toISOString();
  enqueue({
    table: 'station_presence', op: 'update',
    id: getState().presenceId,
    row: { left_at: now },
  });
  setState({ station: null, presenceId: null, stationEnteredAt: null });
  return stationId;
}

// ------------------------------------------------------------
// 아티팩트 — 관객이 남긴 것
// ------------------------------------------------------------
export function saveArtifact(type, value, meta = {}) {
  const s = loadSession();
  const row = {
    session_id: s ? s.id : null,
    station_id: getState().station ?? null,
    type,
    value: typeof value === 'string' ? value : null,
    image_path: meta.image_path || null,
    image_url: meta.image_url || null,
    meta,
    occurred_at: new Date().toISOString(),
  };
  enqueue({ table: 'artifacts', op: 'insert', row });
  logEvent('artifact_saved', { payload: { type } });
  return row;
}

// ------------------------------------------------------------
// 설문
// ------------------------------------------------------------
export function saveSurvey(answers) {
  const s = loadSession();
  const now = new Date().toISOString();
  for (const [qid, a] of Object.entries(answers)) {
    enqueue({
      table: 'survey', op: 'insert',
      row: {
        session_id: s ? s.id : null,
        question_id: qid,
        answer: a.value != null ? String(a.value) : null,
        answer_num: typeof a.value === 'number' ? a.value : null,
        meta: a.meta || {},          // 작성 소요·수정 횟수 (C7)
        occurred_at: a.occurredAt || now,
      },
    });
  }
  logEvent('survey_submit', { payload: { count: Object.keys(answers).length } });
}

// Exit 시점의 가벼운 세션 스냅샷.
// 개별 행동은 events에 이미 남고, 이 행은 나중에 한 관객의 상태를 빠르게
// 재구성하기 위한 최종 인덱스다. 원본 scroll/click 스트림을 중복 저장하지 않는다.
export function saveSessionSnapshot(snapshot) {
  const s = loadSession();
  if (!s) return null;
  const row = {
    session_id: s.id,
    station_id: '05',
    type: 'session_snapshot',
    value: null,
    meta: snapshot,
    occurred_at: new Date().toISOString(),
  };
  enqueue({ table: 'artifacts', op: 'insert', row });
  logEvent('session_snapshot_saved', {
    station: '05',
    payload: {
      snapshot_version: snapshot.snapshot_version || '1',
      completed_station_count: Array.isArray(snapshot.completed_stations)
        ? snapshot.completed_stations.length : 0,
    },
  });
  return row;
}

// ------------------------------------------------------------
// 읽기 — 결과 화면·혼잡도용
// ------------------------------------------------------------
export async function fetchLiveCount() {
  if (!ready || !online) return null;
  try {
    const { count, error } = await sb
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');
    if (error) throw error;
    return count;
  } catch (e) {
    console.warn('[db] live count 실패', e);
    return null;
  }
}

export async function fetchMyArtifacts() {
  const s = loadSession();
  if (!s) return [];
  // 오프라인이거나 미설정이면 큐에 있는 것으로라도 보여준다
  const local = readQueue()
    .filter(j => j.table === 'artifacts' && j.row.session_id === s.id)
    .map(j => j.row);
  if (!ready || !online) return local;
  try {
    const { data, error } = await sb
      .from('artifacts').select('*')
      .eq('session_id', s.id)
      .order('occurred_at', { ascending: true });
    if (error) throw error;
    return data && data.length ? data : local;
  } catch {
    return local;
  }
}

// TD가 비공개 Storage에 올린 캡처는 영구 공개 URL을 만들지 않는다.
// 현재 익명 관객 권한으로 짧게 유효한 URL만 발급해 자기 세션의 이미지에
// 접근한다. Storage RLS가 session_id 폴더를 다시 검증한다.
export async function createCaptureSignedUrl(storagePath, expiresIn = 1800) {
  if (!storagePath || !ready || !online || !sb) return null;
  try {
    const { data, error } = await sb.storage
      .from('session-captures')
      .createSignedUrl(storagePath, expiresIn);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (e) {
    console.warn('[db] capture signed URL 실패', e);
    return null;
  }
}

export async function fetchMyCaptureArtifacts(stationId = null) {
  const artifacts = await fetchMyArtifacts();
  return artifacts
    .filter((artifact) => artifact?.type === 'capture')
    .filter((artifact) => !stationId || String(artifact.station_id).padStart(2, '0') === String(stationId).padStart(2, '0'))
    .sort((a, b) => new Date(b.occurred_at || b.created_at || 0) - new Date(a.occurred_at || a.created_at || 0));
}

// TD가 올린 인터랙션 요약(장미 극성 비율 등)을 결과 화면에서 읽는다
export async function fetchMyEvents(types = null) {
  const s = loadSession();
  if (!s || !ready || !online) return [];
  try {
    let q = sb.from('events').select('*').eq('session_id', s.id);
    if (types) q = q.in('event_type', types);
    const { data, error } = await q.order('occurred_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch { return []; }
}

// ============================================================
// C4. 오프라인 큐
//   ⚠️ 타임스탬프는 이미 row 안에 "행동한 순간"으로 박혀 있다.
//      여기서 다시 찍지 않는다.
// ============================================================

function readQueue() {
  try { return JSON.parse(localStorage.getItem(LS.queue) || '[]'); }
  catch { return []; }
}

function readAnalyticsQueue() {
  try { return JSON.parse(localStorage.getItem(LS.analytics) || '[]'); }
  catch { return []; }
}

function writeAnalyticsQueue(q) {
  try {
    localStorage.setItem(LS.analytics, JSON.stringify(q));
  } catch (e) {
    // 분석용 데이터만 최후 수단으로 최근 500건을 유지한다.
    console.warn('[db] analytics buffer 용량 초과, 최근 기록만 유지', e);
    localStorage.setItem(LS.analytics, JSON.stringify(q.slice(-500)));
  }
}

function writeQueue(q) {
  try {
    localStorage.setItem(LS.queue, JSON.stringify(q));
  } catch (e) {
    // 용량 초과 — 가장 오래된 것부터 버리되 sessions/survey는 남긴다
    console.warn('[db] 큐 용량 초과, 오래된 이벤트 정리', e);
    const keep = q.filter(j => j.table !== 'events').concat(
      q.filter(j => j.table === 'events').slice(-200)
    );
    localStorage.setItem(LS.queue, JSON.stringify(keep));
  }
}

function enqueue(job) {
  const q = readQueue();
  q.push({ ...job, _id: uuid(), _tries: 0, _nextAt: 0 });
  writeQueue(q);
  updateBadge();
  if (online && ready) setTimeout(() => flushQueue(), 50);
}

let flushing = false;
let flushTimer = null;
let analyticsBackupTimer = null;

function startFlushLoop() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => flushQueue(), CONFIG.MEASURE.queueFlushMs);
  if (analyticsBackupTimer) clearInterval(analyticsBackupTimer);
  analyticsBackupTimer = setInterval(() => {
    flushAnalyticsEvents('periodic_backup');
    flushQueue();
  }, CONFIG.MEASURE.analyticsBackupMs);
  // 페이지를 떠날 때 마지막 시도
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAnalyticsEvents('page_hidden');
      flushQueue(true);
    }
  });
}

// wake=true — 재연결 순간 backoff를 무시하고 즉시 재전송
// (11 로그 8/5 S11-H `upload_reconnect_wake` 와 같은 처리)
export async function flushQueue(wake = false) {
  if (flushing || !ready || !online) return;
  let q = readQueue();
  if (!q.length) return;
  flushing = true;

  const now = Date.now();
  const stillPending = [];

  for (const job of q) {
    if (!wake && job._nextAt > now) { stillPending.push(job); continue; }
    try {
      await sendJob(job);
    } catch (e) {
      job._tries += 1;
      const backoff = Math.min(
        1000 * Math.pow(2, job._tries),
        CONFIG.MEASURE.queueMaxBackoffMs
      );
      job._nextAt = wake ? 0 : Date.now() + backoff;
      job._lastError = String(e).slice(0, 200);
      // 20번 넘게 실패하면 포기하지 않고 남겨둔다 — 전시 끝나고
      // 브라우저에 남아 있는 것 자체가 마지막 보험이다
      stillPending.push(job);
    }
  }
  writeQueue(stillPending);
  updateBadge();
  flushing = false;
}

async function sendJob(job) {
  const { table, op, row, id } = job;

  if (op === 'insert') {
    const clean = { ...row };
    delete clean.id_client;
    if (table === 'station_presence') clean.client_ref = row.id_client;
    const { error } = await sb.from(table).insert(clean);
    // 중복(같은 session+seq)은 성공으로 친다 — 재전송 시 정상 상황
    if (error && !/duplicate|unique/i.test(error.message || '')) throw error;
    return;
  }

  if (op === 'update') {
    if (table === 'sessions') {
      const { error } = await sb.from('sessions').update(row).eq('id', id);
      if (error) throw error;
      return;
    }
    if (table === 'station_presence') {
      // 클라 id로는 못 찾으므로 세션+스테이션의 열린 행을 닫는다
      const s = loadSession();
      const { error } = await sb.from('station_presence')
        .update(row).eq('session_id', s?.id).is('left_at', null);
      if (error) throw error;
      return;
    }
  }
  throw new Error('unknown job ' + table + '/' + op);
}

export function queueSize() { return readQueue().length; }
export function analyticsQueueSize() { return readAnalyticsQueue().length; }

function updateBadge() {
  window.dispatchEvent(new CustomEvent('fringe:queue', {
    detail: { size: readQueue().length, online, ready },
  }));
}

// ------------------------------------------------------------
// 스태프용 — 세션 초기화 (다음 관객)
// ------------------------------------------------------------
export function resetSession() {
  const hadRemoteSession = loadSession();
  flushAnalyticsEvents('staff_reset');
  localStorage.removeItem(LS.session);
  localStorage.removeItem(LS.state);
  localStorage.removeItem(LS.seq);
  // ‘이 기기에만 저장’으로 들어온 관객의 분석 buffer는 다음 관객 session에
  // 절대 귀속시키지 않는다. 원격 session이 없다는 것은 서버 수집 비동의다.
  if (!hadRemoteSession) localStorage.removeItem(LS.analytics);
  // 🔴 큐는 지우지 않는다. 아직 안 올라간 이전 관객 데이터가 들어 있다.
}
