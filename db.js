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
  generation:'fringe26.generation',
  controlQuarantine:'fringe26.control_quarantine',
};

// 한 번의 NFC/QR 태그가 Safari 탭을 중복으로 열 때만 같은 결합으로 본다.
// 그 이후의 명시적 재태그는 새 presence를 만들어 전시 현장 상태를 갱신한다.
const STATION_TAG_DEDUPE_MS = 15 * 1000;
const STATION_LEASE_SECONDS = 5 * 60;
const STATION_LEASE_RENEW_MS = 60 * 1000;

let sb = null;               // Supabase client
let ready = false;
let online = navigator.onLine;
let initPromise = null;
let stationLeaseTimer = null;
let lastStationEntryStatus = { code: 'idle', stationId: null };
// iOS NFC/QR은 새 Safari 탭을 열 수 있다. Phone Hub의 최신 탭 하나만
// DB 기록·전송을 수행하게 app.js의 cross-tab guard가 이 값을 제어한다.
let runtimeActive = true;

export function setRuntimeActive(active) {
  runtimeActive = Boolean(active);
  if (runtimeActive && online && ready) {
    setTimeout(() => flushQueue(true), 0);
    startStationLeaseHeartbeat();
  } else {
    stopStationLeaseHeartbeat();
  }
}

export const isRuntimeActive = () => runtimeActive;

export function getLastStationEntryStatus() {
  return { ...lastStationEntryStatus };
}

function setStationEntryStatus(code, stationId = null, detail = {}) {
  lastStationEntryStatus = { code, stationId, ...detail };
  return lastStationEntryStatus;
}

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

// 앱 초기화 중 만들어진 canonical local session에 Anonymous Auth를 붙인다.
// 세션 시작과 station presence는 온라인 확인 전용이며, 오프라인 큐는
// 이벤트·설문·아티팩트 같은 기록 데이터만 담당한다.
async function attachAudienceAuthToCurrentSession() {
  const current = loadSession();
  if (!current || !ready || !online || !runtimeActive) return current;
  if (current.auth_uid) return current;
  const expectedSessionId = current.id;
  const user = await ensureAudienceAuth();
  if (!user) return current;

  // Anonymous Auth may finish after a reset, a new audience session, or a
  // newer NFC Safari tab has taken ownership. Never let that late completion
  // resurrect the session object captured before the await.
  const latest = loadSession();
  if (!runtimeActive || !latest || latest.id !== expectedSessionId) {
    return latest;
  }

  const next = { ...latest, auth_uid: user.id };
  saveSession(next);

  const q = readQueue();
  for (const job of q) {
    if (job.table === 'sessions' && job.op === 'insert' && job.row?.id === next.id) {
      job.row.auth_uid = user.id;
    }
  }
  writeQueue(q);
  return next;
}

// ------------------------------------------------------------
// 초기화 — Supabase SDK를 CDN에서 동적 import.
// 실패해도 앱은 로컬 모드로 계속 간다.
// ------------------------------------------------------------
async function initializeDB() {
  quarantineLegacyActivationJobs();
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
    await attachAudienceAuthToCurrentSession();
    startStationLeaseHeartbeat();
  } catch (e) {
    console.error('[db] Supabase 로드 실패 — 로컬 모드로 계속', e);
    ready = false;
  }
  startFlushLoop();
  return { ready };
}

// Boot and a fast Arrival tap may ask for initialization at the same time.
// One shared promise prevents duplicate clients, auth races, and flush loops.
export function initDB() {
  if (!initPromise) {
    initPromise = initializeDB().then((result) => {
      if (!result.ready) initPromise = null;
      return result;
    });
  }
  return initPromise;
}

export const isReady   = () => ready;
export const isOnline  = () => online;

window.addEventListener('online', async () => {
  online = true;
  try {
    if (!ready) await initDB();
    await attachAudienceAuthToCurrentSession();
  } catch (e) {
    console.warn('[db] 재연결 익명 인증 실패 — 다음 재시도까지 로컬 보관', e);
  }
  flushAnalyticsEvents('reconnect');
  flushQueue(true);
  startStationLeaseHeartbeat();
});
window.addEventListener('offline', () => { online = false; });

// ------------------------------------------------------------
// 세션 상태 — localStorage에 유지. 브라우저를 닫았다 열어도 복구된다.
// ------------------------------------------------------------
export function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS.session) || 'null'); }
  catch { return null; }
}

export function activeSessionMatches(expectedSessionId) {
  const current = loadSession();
  return Boolean(
    expectedSessionId
    && current?.id === expectedSessionId
    && current.status === 'active'
  );
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

function sessionGeneration() {
  return parseInt(localStorage.getItem(LS.generation) || '0', 10) || 0;
}

function advanceSessionGeneration() {
  const next = sessionGeneration() + 1;
  localStorage.setItem(LS.generation, String(next));
  return next;
}

// ------------------------------------------------------------
// A1. 세션 발급
//   ★ 세션 id를 클라이언트에서 만든다. 그래야 오프라인에서도 발급되고,
//     나중에 연결되면 그 id 그대로 서버에 올라간다.
// ------------------------------------------------------------
export async function startSession({ consent = false, roundNo = null, sessionId = null } = {}) {
  // Arrival is a control-plane boundary. Wait for Supabase/Auth instead of
  // creating a remote-consent session that may only exist in a delayed queue.
  const invocationGeneration = sessionGeneration();
  await initDB();
  if (!runtimeActive || sessionGeneration() !== invocationGeneration) return loadSession();
  const existing = loadSession();
  const requestedId = sessionId || existing?.id || uuid();
  if (existing && existing.status === 'active' && existing.id === requestedId) {
    const existingGeneration = sessionGeneration();
    try { await attachAudienceAuthToCurrentSession(); }
    catch (e) { console.warn('[db] 기존 세션 익명 인증 보류', e); }
    const current = loadSession() || existing;
    const serverConfirmed = await confirmServerSession(current);
    if (serverConfirmed && controlPlaneStillCurrent(current.id, existingGeneration)) {
      return loadSession();
    }
    if (!runtimeActive || sessionGeneration() !== existingGeneration) return loadSession();
    // A prior offline/dev attempt may have created only local state. Recreate
    // the same canonical UUID below after ensuring Anonymous Auth.
  }

  if (!ready || !online || !sb || !runtimeActive) return null;

  const generationAtStart = invocationGeneration;
  const existingIdAtStart = existing?.id || null;

  let audienceUser = null;
  if (ready && online) {
    try {
      audienceUser = await ensureAudienceAuth();
    } catch (e) {
      console.warn('[db] 익명 인증 실패 — 원격 세션 시작 보류', e);
    }
  }


  // A reset or another tab may replace the visitor while auth is pending.
  // Abort the stale request instead of overwriting the newer UUID.
  const latest = loadSession();
  const sessionWasReplaced = latest
    && latest.id !== requestedId
    && latest.id !== existingIdAtStart;
  if (!runtimeActive
      || sessionGeneration() !== generationAtStart
      || sessionWasReplaced) {
    return latest;
  }

  const s = {
    ...(existing?.id === requestedId ? existing : {}),
    id: requestedId,
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
  // Auth may resolve after a newer NFC tab claimed runtime ownership.
  if (!runtimeActive || sessionGeneration() !== generationAtStart) return loadSession();
  saveSession(s);

  // The canonical session row is inserted and read back before Arrival may
  // continue. Delayed analytics still use the separate offline queue.
  const { error: insertError } = await sb.from('sessions').insert(s);
  if (insertError && !/duplicate|unique/i.test(insertError.message || '')) {
    return null;
  }
  if (!await confirmServerSession(s)) {
    return null;
  }
  if (!controlPlaneStillCurrent(s.id, generationAtStart)) {
    return null;
  }

  // ★ 동의 화면에서 이미 쌓인 이벤트(읽기 행동·스크롤 깊이)를 이 세션에 붙인다.
  //   세션 발급 전에 일어난 행동도 이 관객의 것이다 — 22 §1-1의
  //   "맥락을 얼마나 받아들였나"가 바로 이 구간에서 나온다.
  //   ⚠️ seq는 리셋하지 않는다. 리셋하면 (session_id, seq)가 겹친다.
  backfillSession(s.id);
  backfillAnalyticsSession(s.id);

  logEvent('session_start', { scope: 'individual' });
  return s;
}

async function confirmServerSession(session) {
  if (!session?.id || !session.auth_uid || !ready || !online || !sb || !runtimeActive) {
    return false;
  }
  const { data, error } = await sb.from('sessions')
    .select('id,status,auth_uid')
    .eq('id', session.id)
    .eq('auth_uid', session.auth_uid)
    .eq('status', 'active')
    .maybeSingle();
  return !error && data?.id === session.id;
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

// Color/name/language are TD control inputs. Before a station can open, write
// and read back these canonical fields synchronously so TD never starts with a
// correct UUID but stale/null visitor metadata.
export async function confirmSessionControlFields(expectedSessionId, fields = {}) {
  const control = await controlPlaneSession(expectedSessionId);
  if (!control) return null;
  const allowed = ['color', 'lang', 'final_name', 'final_name_a', 'final_name_b'];
  const patch = Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => allowed.includes(key) && value !== undefined));
  if (Object.keys(patch).length) {
    const { error } = await sb.from('sessions')
      .update(patch)
      .eq('id', control.session.id)
      .eq('auth_uid', control.session.auth_uid)
      .eq('status', 'active');
    if (error || !controlPlaneStillCurrent(control.session.id, control.generation)) return null;
  }
  const columns = ['id', ...Object.keys(patch)].join(',');
  const { data, error } = await sb.from('sessions')
    .select(columns)
    .eq('id', control.session.id)
    .eq('auth_uid', control.session.auth_uid)
    .eq('status', 'active')
    .maybeSingle();
  if (error || !data || !controlPlaneStillCurrent(control.session.id, control.generation)) {
    return null;
  }
  const exact = Object.entries(patch).every(([key, value]) => data[key] === value);
  if (!exact) return null;
  const current = loadSession();
  saveSession({ ...current, ...patch });
  return data;
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
  if (!runtimeActive) return null;
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
  if (!runtimeActive) return null;
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
// 작품 입장 — 패턴/NFC/QR 모두 같은 독점 잠금을 사용한다.
// Migration 적용 전에는 기존 NFC/QR만 legacy direct insert로 유지한다.
// 패턴 입장은 잠금 RPC가 없으면 반드시 실패한다.
// ------------------------------------------------------------
export async function enterStation(stationId, via = 'qr', expectedSessionId = null) {
  if (stationEntryInFlight) {
    setStationEntryStatus('in_flight', stationId);
    return null;
  }
  stationEntryInFlight = true;
  setStationEntryStatus('connecting', stationId, { via });
  try {
    const control = await controlPlaneSession(expectedSessionId);
    if (!control) {
      setStationEntryStatus('session_unavailable', stationId, { via });
      return null;
    }
    const { session: s, generation } = control;
    if (expectedSessionId && s.id !== expectedSessionId) {
      console.error('[db] station bind rejected: session mismatch', {
        expected: expectedSessionId,
        actual: s.id,
        station: stationId,
      });
      setStationEntryStatus('session_mismatch', stationId, { via });
      return null;
    }

    const now = new Date().toISOString();
    const st = getState();
    const presenceEnteredAtMs = Date.parse(st.stationEnteredAt || '');
    const presenceAgeMs = Date.now() - presenceEnteredAtMs;
    const recentLegacySameStationTag = st.stationControl !== 'exclusive'
      && st.presenceId
      && st.station === stationId
      && Number.isFinite(presenceEnteredAtMs)
      && presenceAgeMs >= 0
      && presenceAgeMs < STATION_TAG_DEDUPE_MS;

    // A cached pre-lock build may leave one legacy presence. Close it before
    // moving into the exclusive contract. Repeated legacy NFC reads retain the
    // existing exact-row guard until the migration is available.
    if (recentLegacySameStationTag) {
      const confirmed = await serverHasOpenPresence(st.presenceId, s.id, stationId);
      if (!controlPlaneStillCurrent(s.id, generation)) return null;
      if (confirmed) {
        logEvent('station_tag_repeat', {
          station: stationId,
          payload: { via, control: 'legacy' },
          occurredAt: now,
        });
        setStationEntryStatus('connected', stationId, { via, control: 'legacy' });
        return stationId;
      }
      if (getState().presenceId === st.presenceId) clearStationState();
      queuePresenceClose(st.presenceId, new Date().toISOString());
      setStationEntryStatus('readback_failed', stationId, { via });
      return null;
    }

    if (st.presenceId && st.station && st.stationControl !== 'exclusive') {
      const closed = await directClosePresence(st.presenceId, now);
      if (!closed || !controlPlaneStillCurrent(s.id, generation)) {
        setStationEntryStatus('previous_close_failed', stationId, { via });
        return null;
      }
      if (getState().presenceId === st.presenceId) clearStationState();
    }

    const presenceId = uuid();
    const exclusive = await claimExclusiveStation({
      stationId,
      via,
      session: s,
      generation,
      requestedClientRef: presenceId,
    });
    if (exclusive.handled) return exclusive.ok ? stationId : null;

    // Rollout safety: before the dedicated migration is run, existing NFC/QR
    // links keep working. Pattern entry never bypasses the exclusive lock.
    if (via === 'pattern') {
      setStationEntryStatus('setup_required', stationId, { via });
      return null;
    }
    return await enterLegacyStation({
      stationId,
      via,
      session: s,
      generation,
      presenceId,
      now,
    });
  } finally {
    stationEntryInFlight = false;
  }
}
let stationEntryInFlight = false;

function stationRpcMissing(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  return code === 'PGRST202'
    || code === '42883'
    || /claim_station.*(schema cache|does not exist|not found)/i.test(message);
}

async function claimExclusiveStation({
  stationId, via, session, generation, requestedClientRef,
}) {
  let data = null;
  let error = null;
  try {
    ({ data, error } = await sb.rpc('claim_station', {
      p_station_id: stationId,
      p_session_id: session.id,
      p_client_ref: requestedClientRef,
      p_via: via,
      p_lease_seconds: STATION_LEASE_SECONDS,
    }));
  } catch (caught) {
    error = caught;
  }

  if (error) {
    if (stationRpcMissing(error)) return { handled: false, ok: false };
    const ambiguous = !error?.code || /fetch|network|timeout/i.test(String(error?.message || error));
    if (ambiguous) {
      const failedAt = new Date().toISOString();
      const released = await directReleaseExclusiveStation(
        stationId, session.id, requestedClientRef,
      );
      if (!released) {
        queuePresenceClose(requestedClientRef, failedAt, {
          releaseLock: true,
          stationId,
          sessionId: session.id,
        });
      }
    }
    console.warn('[db] exclusive station claim failed', error);
    setStationEntryStatus('connection_error', stationId, { via });
    return { handled: true, ok: false };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (row?.claim_status === 'busy') {
    setStationEntryStatus('busy', stationId, {
      via,
      leaseExpiresAt: row.lease_expires_at || null,
    });
    return { handled: true, ok: false };
  }
  if (row?.claim_status !== 'connected'
      || row.claimed_station_id !== stationId
      || !row.claimed_client_ref) {
    setStationEntryStatus(row?.claim_status || 'claim_rejected', stationId, { via });
    return { handled: true, ok: false };
  }

  const claimedClientRef = row.claimed_client_ref;
  const exactReadback = await serverHasOpenPresence(
    claimedClientRef, session.id, stationId,
  );
  if (!exactReadback || !controlPlaneStillCurrent(session.id, generation)) {
    const cancelledAt = new Date().toISOString();
    const released = await directReleaseExclusiveStation(
      stationId, session.id, claimedClientRef,
    );
    if (!released) {
      queuePresenceClose(claimedClientRef, cancelledAt, {
        releaseLock: true,
        stationId,
        sessionId: session.id,
      });
    }
    setStationEntryStatus('readback_failed', stationId, { via });
    return { handled: true, ok: false };
  }

  setState({
    station: stationId,
    presenceId: claimedClientRef,
    stationEnteredAt: row.claimed_entered_at || new Date().toISOString(),
    stationControl: 'exclusive',
    stationLeaseExpiresAt: row.lease_expires_at || null,
  });
  startStationLeaseHeartbeat();
  logEvent('station_enter', {
    station: stationId,
    payload: { via, control: 'exclusive' },
    occurredAt: row.claimed_entered_at || new Date().toISOString(),
  });
  setStationEntryStatus('connected', stationId, {
    via,
    control: 'exclusive',
  });
  return { handled: true, ok: true };
}

async function enterLegacyStation({
  stationId, via, session, generation, presenceId, now,
}) {
  if (!controlPlaneStillCurrent(session.id, generation)) return null;
  const presenceRow = {
    client_ref: presenceId,
    session_id: session.id,
    station_id: stationId,
    entered_at: now,
    via,
  };
  let inserted = null;
  try {
    const { data, error } = await sb.from('station_presence')
      .insert(presenceRow)
      .select('client_ref,session_id,station_id,entered_at,left_at')
      .single();
    if (error) throw error;
    inserted = data;
  } catch (error) {
    const failedAt = new Date().toISOString();
    if (!await directClosePresence(presenceId, failedAt)) {
      queuePresenceClose(presenceId, failedAt);
    }
    console.warn('[db] legacy station bind failed', error);
    setStationEntryStatus('connection_error', stationId, { via, control: 'legacy' });
    return null;
  }

  const exactInsert = inserted?.client_ref === presenceId
    && inserted?.session_id === session.id
    && inserted?.station_id === stationId
    && inserted?.left_at == null;
  const exactReadback = exactInsert
    && await serverHasOpenPresence(presenceId, session.id, stationId);
  if (!exactReadback || !controlPlaneStillCurrent(session.id, generation)) {
    const cancelledAt = new Date().toISOString();
    if (!await directClosePresence(presenceId, cancelledAt)) {
      queuePresenceClose(presenceId, cancelledAt);
    }
    setStationEntryStatus('readback_failed', stationId, { via, control: 'legacy' });
    return null;
  }

  setState({
    station: stationId,
    presenceId,
    stationEnteredAt: now,
    stationControl: 'legacy',
    stationLeaseExpiresAt: null,
  });
  logEvent('station_enter', {
    station: stationId,
    payload: { via, control: 'legacy' },
    occurredAt: now,
  });
  setStationEntryStatus('connected', stationId, { via, control: 'legacy' });
  return stationId;
}

async function controlPlaneSession(expectedSessionId = null) {
  const generation = sessionGeneration();
  await initDB();
  if (!ready || !online || !sb || !runtimeActive
      || sessionGeneration() !== generation) return null;
  await attachAudienceAuthToCurrentSession();
  const session = loadSession();
  if (!session
      || session.status !== 'active'
      || !session.auth_uid
      || (expectedSessionId && session.id !== expectedSessionId)
      || !await confirmServerSession(session)) {
    return null;
  }
  if (!controlPlaneStillCurrent(session.id, generation)) return null;
  return { session: loadSession(), generation };
}

function controlPlaneStillCurrent(sessionId, generation) {
  const current = loadSession();
  return Boolean(
    runtimeActive
    && current?.id === sessionId
    && current.status === 'active'
    && sessionGeneration() === generation
  );
}

async function serverHasOpenPresence(clientRef, sessionId, stationId) {
  if (!clientRef || !sessionId || !stationId || !sb || !online) return false;
  const { data, error } = await sb.from('station_presence')
    .select('client_ref,session_id,station_id,left_at')
    .eq('client_ref', clientRef)
    .eq('session_id', sessionId)
    .eq('station_id', stationId)
    .is('left_at', null)
    .maybeSingle();
  return !error && data?.client_ref === clientRef;
}

function clearStationState() {
  setState({
    station: null,
    presenceId: null,
    stationEnteredAt: null,
    stationControl: null,
    stationLeaseExpiresAt: null,
  });
  stopStationLeaseHeartbeat();
}

async function directReleaseExclusiveStation(stationId, sessionId, clientRef) {
  if (!stationId || !sessionId || !clientRef || !sb || !online) return false;
  try {
    const { data, error } = await sb.rpc('release_station', {
      p_station_id: stationId,
      p_session_id: sessionId,
      p_client_ref: clientRef,
    });
    if (error) throw error;
    return data === true;
  } catch (error) {
    console.warn('[db] exclusive station release failed', error);
    return false;
  }
}

async function renewActiveStationLease() {
  const state = getState();
  const session = loadSession();
  if (!runtimeActive || !ready || !online || !sb
      || state.stationControl !== 'exclusive'
      || !state.station || !state.presenceId
      || !session?.id || session.status !== 'active') {
    return false;
  }
  try {
    const { data, error } = await sb.rpc('renew_station', {
      p_station_id: state.station,
      p_session_id: session.id,
      p_client_ref: state.presenceId,
      p_lease_seconds: STATION_LEASE_SECONDS,
    });
    if (error) throw error;
    if (data === true) {
      if (getState().presenceId === state.presenceId) {
        setState({
          stationLeaseExpiresAt: new Date(
            Date.now() + STATION_LEASE_SECONDS * 1000,
          ).toISOString(),
        });
      }
      return true;
    }

    if (getState().presenceId === state.presenceId) {
      clearStationState();
      window.dispatchEvent(new CustomEvent('fringe:station-lease-lost', {
        detail: { station: state.station, clientRef: state.presenceId },
      }));
    }
    return false;
  } catch (error) {
    // A transient network failure must not make the phone claim it has left.
    // The server lease remains the source of truth and will expire fail-safe.
    console.warn('[db] station lease renew deferred', error);
    return false;
  }
}

function startStationLeaseHeartbeat() {
  stopStationLeaseHeartbeat();
  const state = getState();
  if (!runtimeActive || !ready || !online
      || state.stationControl !== 'exclusive'
      || !state.station || !state.presenceId) return;
  stationLeaseTimer = setInterval(
    () => { void renewActiveStationLease(); },
    STATION_LEASE_RENEW_MS,
  );
}

function stopStationLeaseHeartbeat() {
  if (!stationLeaseTimer) return;
  clearInterval(stationLeaseTimer);
  stationLeaseTimer = null;
}

async function directClosePresence(clientRef, leftAt = new Date().toISOString()) {
  if (!clientRef || !sb || !online) return false;
  try {
    const { error: updateError } = await sb.from('station_presence')
      .update({ left_at: leftAt })
      .eq('client_ref', clientRef)
      .is('left_at', null);
    if (updateError) throw updateError;
    const { data, error: readError } = await sb.from('station_presence')
      .select('client_ref,left_at')
      .eq('client_ref', clientRef)
      .maybeSingle();
    return !readError && Boolean(data?.left_at);
  } catch (error) {
    console.warn('[db] presence close failed', error);
    return false;
  }
}

function queuePresenceClose(
  clientRef,
  leftAt = new Date().toISOString(),
  { releaseLock = false, stationId = null, sessionId = null } = {},
) {
  if (!clientRef) return null;
  // A superseded Safari tab may be inactive exactly when its direct insert
  // response returns. Deactivation is safe to persist even from that tab;
  // activations remain forbidden.
  const q = readQueue();
  q.push({
    table: 'station_presence',
    op: 'update',
    id: clientRef,
    row: { left_at: leftAt },
    release_lock: Boolean(releaseLock),
    station_id: stationId,
    session_id: sessionId,
    _id: uuid(),
    _tries: 0,
    _nextAt: 0,
  });
  writeQueue(q);
  updateBadge();
  if (runtimeActive && online && ready) setTimeout(() => flushQueue(), 50);
  return clientRef;
}

// 스테이션을 떠날 때 열린 presence를 닫는다.
// UI의 event 기록은 app.js가 별도로 남기므로 여기서는 결합 상태만 갱신한다.
export async function leaveStation(stationId = getState().station) {
  const state = getState();
  const s = loadSession();
  if (!s || !stationId || !state.presenceId || state.station !== stationId) return false;
  const control = await controlPlaneSession(s.id);
  if (!control) return false;
  const now = new Date().toISOString();
  const closed = state.stationControl === 'exclusive'
    ? await directReleaseExclusiveStation(stationId, s.id, state.presenceId)
    : await directClosePresence(state.presenceId, now);
  if (!closed) return false;
  if (controlPlaneStillCurrent(s.id, control.generation)
      && getState().presenceId === state.presenceId) {
    clearStationState();
  }
  return true;
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

// Builds before this contract could queue a session/presence activation while
// offline. Preserve those jobs locally for diagnosis, but never replay them
// later and unexpectedly start a TD installation.
function quarantineLegacyActivationJobs() {
  const queue = readQueue();
  const unsafe = queue.filter(job => job?.op === 'insert'
    && job.table === 'station_presence');
  if (!unsafe.length) return 0;

  let archive = [];
  try {
    archive = JSON.parse(localStorage.getItem(LS.controlQuarantine) || '[]');
  } catch { archive = []; }
  archive.push(...unsafe.map(job => ({
    quarantined_at: new Date().toISOString(),
    reason: 'legacy_delayed_activation_blocked',
    job,
  })));
  localStorage.setItem(LS.controlQuarantine, JSON.stringify(archive.slice(-100)));
  writeQueue(queue.filter(job => !unsafe.includes(job)));
  return unsafe.length;
}

function enqueue(job) {
  if (!runtimeActive) return null;
  if (job.table === 'station_presence' && job.op === 'insert') {
    throw new Error('station_presence insert is online control-plane only');
  }
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
  if (!runtimeActive || flushing || !ready || !online) return;
  const q = readQueue();
  if (!q.length) return;
  flushing = true;
  const snapshotIds = new Set(q.map(job => job._id));

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
  // Do not overwrite jobs enqueued while an awaited network request was in
  // flight. Merge those new jobs with the retry set from this snapshot.
  const newlyEnqueued = readQueue().filter(job => !snapshotIds.has(job._id));
  writeQueue([...stillPending, ...newlyEnqueued]);
  updateBadge();
  flushing = false;
}

async function sendJob(job) {
  const { table, op, row, id } = job;

  if (op === 'insert') {
    if (table === 'station_presence') {
      throw new Error('queued station activation is forbidden');
    }
    const clean = { ...row };
    delete clean.id_client;
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
      // enqueue 당시의 고유 client_ref로 그 presence 한 행만 닫는다.
      // 전송 시점의 현재 session을 사용하면 다음 관객의 행을 닫을 수 있다.
      if (!id) {
        console.warn('[db] station_presence close skipped: missing client_ref');
        return;
      }
      const { error: updateError } = await sb.from('station_presence')
        .update(row).eq('client_ref', id).is('left_at', null);
      if (updateError) throw updateError;
      // A lost INSERT response can race its compensating close. Treat a
      // zero-row update as pending rather than success, so the close remains
      // in the queue until the exact row is visible and confirmed closed.
      const { data, error: readError } = await sb.from('station_presence')
        .select('client_ref,left_at')
        .eq('client_ref', id)
        .maybeSingle();
      if (readError) throw readError;
      if (data?.client_ref !== id || !data?.left_at) {
        throw new Error('presence close is not yet server-confirmed');
      }
      if (job.release_lock && job.station_id && job.session_id) {
        const { data: released, error: releaseError } = await sb.rpc('release_station', {
          p_station_id: job.station_id,
          p_session_id: job.session_id,
          p_client_ref: id,
        });
        if (releaseError || released !== true) {
          throw releaseError || new Error('station lock release is not server-confirmed');
        }
      }
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
export function resetSession(reason = 'staff_reset') {
  const hadRemoteSession = loadSession();
  const previousState = getState();
  const now = new Date().toISOString();
  flushAnalyticsEvents(reason);
  if (hadRemoteSession?.status === 'active') {
    if (previousState.presenceId) {
      // Reset is an explicit takeover. A delayed activation is never queued;
      // closing an already confirmed row is safe to retry in the background.
      queuePresenceClose(previousState.presenceId, now, {
        releaseLock: previousState.stationControl === 'exclusive',
        stationId: previousState.station || null,
        sessionId: hadRemoteSession.id,
      });
    }
    enqueue({
      table: 'sessions',
      op: 'update',
      id: hadRemoteSession.id,
      row: {
        status: 'ended',
        exited_at: now,
        end_reason: reason,
      },
    });
  }
  advanceSessionGeneration();
  stopStationLeaseHeartbeat();
  localStorage.removeItem(LS.session);
  localStorage.removeItem(LS.state);
  localStorage.removeItem(LS.seq);
  // ‘이 기기에만 저장’으로 들어온 관객의 분석 buffer는 다음 관객 session에
  // 절대 귀속시키지 않는다. 원격 session이 없다는 것은 서버 수집 비동의다.
  if (!hadRemoteSession) localStorage.removeItem(LS.analytics);
  // 🔴 큐는 지우지 않는다. 아직 안 올라간 이전 관객 데이터가 들어 있다.
}
