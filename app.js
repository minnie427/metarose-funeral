import { CONFIG } from './config.js';
import {
  initDB,
  startSession as startDbSession,
  updateSession as updateDbSession,
  logEvent as logDbEvent,
  logAnalyticsEvent,
  enterStation as enterDbStation,
  leaveStation as leaveDbStation,
  saveArtifact as saveDbArtifact,
  saveSurvey as saveDbSurvey,
  saveSessionSnapshot as saveDbSessionSnapshot,
  endSession as endDbSession,
  flushQueue as flushDbQueue,
  flushAnalyticsEvents,
  resetSession as resetDbSession,
  fetchMyArtifacts,
  fetchMyCaptureArtifacts,
  createCaptureSignedUrl,
  setRuntimeActive as setDbRuntimeActive,
  activeSessionMatches as activeDbSessionMatches,
  confirmSessionControlFields,
  getState as getDbState,
  getLastStationEntryStatus,
} from './db.js?v=lease-visibility-v1-20260814';
import {
  beginRead,
  endRead,
  startIdleTracking,
  trackInput,
} from './measure.js';

const $app = document.getElementById('app');
const $dock = document.getElementById('dock');
const $bar = document.getElementById('statusbar');

const STORAGE_KEY = 'meta_rose_phone_hub_v1';
const EVENTS_KEY = 'meta_rose_phone_hub_events_v1';
const ARTIST_INSTAGRAM_URL = 'https://www.instagram.com/minniepark.studio/';
const ACTIVE_TAB_KEY = 'meta_rose_phone_hub_active_tab_v1';
// 새 Safari 탭이 opener의 sessionStorage를 복제하는 구현도 있으므로
// 탭 ID는 page load마다 새로 만든다. 같은 탭 새로고침·NFC 재진입은
// station URL이 다시 주도권을 가져가므로 세션 연속성에는 영향이 없다.
const TAB_INSTANCE_ID = crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
// 투명 배경 PNG. 색은 CSS mask로 장미의 alpha 영역에만 입힌다.
const ROSE_SPECIMEN_IMAGE = './assets/images/rose_specimen.png';
const ROSE_SPECIMEN_ANIMATION_IMAGE = './assets/images/rose_specimen_animation.png';
const ROSE_SPECIMEN_ANIMATION_COMPACT_IMAGE = './assets/images/rose_specimen_animation_compact.png';

let currentView = { name: 'arrival', data: {} };
let activeReadKey = null;
let uiTrackingStarted = false;
let tabRuntimeActive = true;
let tabChannel = null;

function readActiveTabLease() {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_TAB_KEY) || 'null');
  } catch {
    return null;
  }
}

function activeTabOverlay() {
  let overlay = document.getElementById('inactive-tab-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('section');
  overlay.id = 'inactive-tab-overlay';
  overlay.className = 'inactive-tab-overlay';
  overlay.setAttribute('role', 'alert');
  overlay.setAttribute('aria-live', 'assertive');
  overlay.innerHTML = `
    <div class="inactive-tab-card">
      <span>PHONE HUB / ACTIVE SCREEN</span>
      <h1>가장 최근에 연 화면을 이용해주세요</h1>
      <p>이 화면은 중복 연결과 기록을 막기 위해 멈췄습니다. 가장 최근에 연 Phone Hub 화면으로 이동해주세요.</p>
      <button type="button" class="inactive-tab-takeover">이 화면을 다시 사용합니다</button>
    </div>`;
  overlay.querySelector('.inactive-tab-takeover')?.addEventListener('click', () => {
    claimActiveTab();
  });
  document.body.append(overlay);
  return overlay;
}

function setTabRuntimeActive(active) {
  const next = Boolean(active);
  tabRuntimeActive = next;
  setDbRuntimeActive(next);
  document.body.classList.toggle('inactive-phone-hub-tab', !next);
  if (next) {
    document.getElementById('inactive-tab-overlay')?.remove();
  } else {
    stopCapturePolling();
    stopActiveRead();
    activeTabOverlay();
  }
}

function announceActiveTab() {
  const lease = {
    id: TAB_INSTANCE_ID,
    heartbeat: Date.now(),
    station: stationFromQuery(),
    via: stationViaFromQuery(),
  };
  localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify(lease));
  tabChannel?.postMessage(lease);
}

function claimActiveTab() {
  setTabRuntimeActive(true);
  announceActiveTab();
}

function observeActiveTabLease(lease) {
  if (!lease?.id || lease.id === TAB_INSTANCE_ID) return;
  setTabRuntimeActive(false);
}

function enforceActiveTabOwnership() {
  const lease = readActiveTabLease();
  if (lease?.id && lease.id !== TAB_INSTANCE_ID) {
    setTabRuntimeActive(false);
  }
}

function ownsActiveTab(sessionId = null) {
  const lease = readActiveTabLease();
  const currentSession = getSession();
  return Boolean(
    tabRuntimeActive
    && lease?.id === TAB_INSTANCE_ID
    && (!sessionId || currentSession?.id === sessionId)
  );
}

function initializeActiveTabGuard({ forceClaim = false } = {}) {
  if ('BroadcastChannel' in window) {
    tabChannel = new BroadcastChannel('meta_rose_phone_hub_tabs_v1');
    tabChannel.addEventListener('message', (event) => observeActiveTabLease(event.data));
  }
  window.addEventListener('storage', (event) => {
    if (event.key !== ACTIVE_TAB_KEY || !event.newValue) return;
    try { observeActiveTabLease(JSON.parse(event.newValue)); } catch { /* ignore */ }
  });
  // Safari가 background tab을 freeze/BFCache에 넣으면 storage/Broadcast
  // 알림을 놓칠 수 있다. 다시 보이는 순간 localStorage 소유권을 재검증한다.
  window.addEventListener('pageshow', enforceActiveTabOwnership);
  window.addEventListener('focus', enforceActiveTabOwnership);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') enforceActiveTabOwnership();
  });

  const taggedEntry = Boolean(stationFromQuery());
  const lease = readActiveTabLease();
  // NFC/QR로 새로 열린 탭은 언제나 즉시 주도권을 갖는다. 일반 HOME 탭은
  // 아직 소유자가 없거나 같은 탭을 새로고침한 경우에만 주도권을 갖는다.
  // 이전 탭 자동 복구는 하지 않는다. iOS가 백그라운드 타이머를 중단해도
  // 두 탭이 동시에 활성화되지 않게 하는 것이 전시 데이터에는 더 안전하다.
  if (forceClaim || taggedEntry || !lease?.id || lease.id === TAB_INSTANCE_ID) claimActiveTab();
  else setTabRuntimeActive(false);
}

window.addEventListener('fringe:station-lease-lost', (event) => {
  const stationId = event.detail?.station || null;
  const session = getSession();
  if (!stationId || session?.connected_station !== stationId) return;
  updateSession({ connected_station: null });
  window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
  if (currentView.name === 'module' && currentView.data.stationId === stationId) {
    void screenModule(stationId, {
      enter: false,
      via: 'lease_lost',
      entryStatus: { code: 'lease_lost', stationId },
    });
  }
});

// Phone Hub은 TD의 raw interaction을 읽거나 실시간으로 구독하지 않는다.
// 각 TD가 결과 확정 시 기록한 trace_summary만, MY SPECIMEN / FINAL을
// 열 때 한 번 읽어 장미의 형태에 반영한다.
let remoteTraceCache = {
  sessionId: null,
  fingerprint: '',
  summaries: [],
  request: null,
};

let capturePollTimer = null;
const captureUrlCache = new Map();

// 전시 작동에 필요한 데이터만 즉시 보낸다. 나머지는 analytics buffer에
// 모았다가 작품 종료·백그라운드·재접속·Exit에서 batch로 백업한다.
const LIVE_EVENT_TYPES = new Set([
  'station_enter',
  'station_leave',
]);

// 모든 UI 제어의 "한 번 누름"은 남기되, 좌표·입력값·터치 이동 원본은 받지 않는다.
// 개별 의미 이벤트(예: station_enter)는 이 일반 이벤트와 별도로 유지된다.
function startUiActionTracking() {
  if (uiTrackingStarted) return;
  uiTrackingStarted = true;
  document.addEventListener('click', (event) => {
    if (!tabRuntimeActive) return;
    const control = event.target.closest('button, summary, a');
    if (!control || control.closest('#debug')) return;
    const label = String(control.getAttribute('aria-label') || control.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 120);
    logEvent('ui_control_click', {
      view: currentView.name,
      control: control.tagName.toLowerCase(),
      class_name: String(control.className || '').slice(0, 120),
      label,
    });
  }, { capture: true });
}

function stopActiveRead() {
  if (!activeReadKey) return;
  endRead(activeReadKey);
  activeReadKey = null;
}

function startPageRead(key) {
  stopActiveRead();
  activeReadKey = key;
  beginRead(key, $app);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') {
      node.className = value;
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }

  return node;
}

function render(nodes, actions = []) {
  stopCapturePolling();
  stopActiveRead();
  closeRoseMenu();
  $app.replaceChildren(...[].concat(nodes).filter(Boolean), siteFooter());
  $dock.replaceChildren();

  const visibleActions = [].concat(actions).filter(Boolean);
  if (visibleActions.length) {
    $dock.append(el('div', { class: 'dock-actions' }, ...visibleActions));
  }

  document.body.classList.toggle('has-dock', visibleActions.length > 0);
  window.scrollTo(0, 0);
}

function stopCapturePolling() {
  if (!capturePollTimer) return;
  clearTimeout(capturePollTimer);
  capturePollTimer = null;
}

function siteFooter() {
  return el('footer', { class: 'site-footer' },
    el('span', {}, 'META ROSE SPECIMEN / SEOUL 2026'),
    el('span', {}, '© 2026 MINNIE PARK. ALL RIGHTS RESERVED.'),
  );
}

function rememberView(name, data = {}) {
  currentView = { name, data };
}

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.random() * 16 | 0;
    return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
  });
}

function ensureSession() {
  const existing = getSession();
  if (existing) return existing;

  const sessionId = makeId();
  const session = {
    id: sessionId,
    display_record_no: sessionId.slice(0, 8).toUpperCase(),
    lang: 'ko',
    color: '#F25C94',
    color_locked: false,
    nickname: '',
    emotional_name: '',
    emotional_name_a: '',
    emotional_name_b: '',
    connected_station: null,
    pending_station: null,
    consent: false,
    intro_seen: false,
    completed_stations: [],
    survey: {},
    created_at: new Date().toISOString(),
  };

  saveSession(session);
  logEvent('session_created', { language_initial: navigator.language || 'unknown' }, '00', session);
  return session;
}

function updateSession(patch) {
  const session = { ...ensureSession(), ...patch };
  saveSession(session);
  syncSessionToDb(patch);
  return session;
}

// 화면의 용어와 DB의 컬럼은 일부 다르다. 화면 상태 전체를 보내지 않고,
// 전시에 필요한 canonical 값만 비동기 큐에 넣는다.
function syncSessionToDb(patch) {
  const dbPatch = {};
  if ('color' in patch) dbPatch.color = patch.color;
  if ('lang' in patch) dbPatch.lang = patch.lang;
  if ('consent' in patch) {
    dbPatch.consent = patch.consent;
    dbPatch.consent_at = patch.consent ? new Date().toISOString() : null;
  }
  if ('emotional_name' in patch) dbPatch.final_name = patch.emotional_name;
  if ('emotional_name_a' in patch) dbPatch.final_name_a = patch.emotional_name_a;
  if ('emotional_name_b' in patch) dbPatch.final_name_b = patch.emotional_name_b;
  if (Object.keys(dbPatch).length) void updateDbSession(dbPatch);
}

async function createRemoteSession(consent) {
  const local = ensureSession();
  const remote = await startDbSession({ consent, sessionId: local.id });
  const current = getSession();
  if (!remote
      || remote.id !== local.id
      || current?.id !== local.id
      || !ownsActiveTab(local.id)) return null;
  saveSession({
    ...current,
    id: remote.id,
    display_record_no: remote.id.slice(0, 8).toUpperCase(),
    created_at: remote.entered_at || current.created_at,
  });
  return remote;
}

const TRACE_FIELD_BY_STATION = {
  '01': 'resonance_trace',
  '02': 'mutation_trace',
  '03': 'temporal_trace',
  '04': 'archive_trace',
};

function normaliseTraceLevel(value) {
  const numeric = Number(value);
  return [0, 1, 2].includes(numeric) ? numeric : null;
}

function traceSummaryFromArtifact(artifact) {
  if (artifact?.type !== 'trace_summary' || !artifact.station_id) return null;
  const stationId = String(artifact.station_id).padStart(2, '0');
  const meta = artifact.meta && typeof artifact.meta === 'object' ? artifact.meta : {};
  const stationField = TRACE_FIELD_BY_STATION[stationId];
  // SUB3의 최종 계산 규칙은 아직 P1이다. 그때 archive_trace 또는 generic
  // trace를 넣으면 Phone Hub 코드를 다시 바꾸지 않아도 된다.
  const level = normaliseTraceLevel(meta[stationField] ?? meta.trace);
  if (level === null) return null;
  return {
    id: artifact.id || null,
    stationId,
    level,
    occurredAt: artifact.occurred_at || '',
  };
}

function traceSummariesForCurrentSession() {
  return remoteTraceCache.summaries;
}

function traceSummaryForStation(stationId) {
  const target = String(stationId).padStart(2, '0');
  return traceSummariesForCurrentSession().find((summary) => summary.stationId === target) || null;
}

function traceProfileForCurrentSession() {
  const summaries = traceSummariesForCurrentSession();
  if (!summaries.length) return null;
  const average = summaries.reduce((total, summary) => total + summary.level, 0) / summaries.length;
  return {
    count: summaries.length,
    intensity: Math.max(0, Math.min(2, Math.round(average))),
  };
}

function traceFingerprint(summaries) {
  return summaries
    .map((summary) => `${summary.id || summary.stationId}:${summary.stationId}:${summary.level}:${summary.occurredAt}`)
    .join('|');
}

async function refreshRemoteTraceSummaries() {
  const session = ensureSession();
  if (!session?.id) return [];

  if (remoteTraceCache.sessionId !== session.id) {
    remoteTraceCache = {
      sessionId: session.id,
      fingerprint: '',
      summaries: [],
      request: null,
    };
  }

  if (remoteTraceCache.request) return remoteTraceCache.request;

  const sessionIdAtRequest = session.id;
  remoteTraceCache.request = fetchMyArtifacts()
    .then((artifacts) => {
      if (ensureSession()?.id !== sessionIdAtRequest) return [];

      // 같은 station의 여러 checkpoint 중 가장 최근 확정값 하나만 사용한다.
      const latestByStation = new Map();
      artifacts
        .map(traceSummaryFromArtifact)
        .filter(Boolean)
        .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))
        .forEach((summary) => latestByStation.set(summary.stationId, summary));
      const summaries = [...latestByStation.values()].sort((a, b) => a.stationId.localeCompare(b.stationId));
      const fingerprint = traceFingerprint(summaries);
      const changed = fingerprint !== remoteTraceCache.fingerprint;

      remoteTraceCache = {
        sessionId: sessionIdAtRequest,
        fingerprint,
        summaries,
        request: null,
      };

      // 화면을 처음 열 때와 TD가 새 결과를 쓴 뒤 다시 열 때만 다시 그린다.
      // 지속 polling은 하지 않는다.
      if (changed && currentView.name === 'specimen') {
        renderCurrentView();
      } else if (changed && currentView.name === 'final') {
        // FINAL은 종료 기록을 한 번만 남겨야 한다. 데이터 반영을 위한
        // 재렌더에서는 그 저장 동작을 반복하지 않는다.
        screenFinalSpecimen({ refresh: true });
      }
      return summaries;
    })
    .catch(() => {
      remoteTraceCache = { ...remoteTraceCache, request: null };
      return [];
    });

  return remoteTraceCache.request;
}

function logEvent(eventType, payload = {}, stationId = null, suppliedSession = null) {
  if (!tabRuntimeActive) return null;
  const session = suppliedSession || ensureSession();
  let existing = [];

  try {
    existing = JSON.parse(localStorage.getItem(EVENTS_KEY) || '[]');
  } catch {
    existing = [];
  }

  existing.push({
    id: makeId(),
    session_id: session.id,
    station_id: stationId || session.connected_station || '00',
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    payload,
  });

  localStorage.setItem(EVENTS_KEY, JSON.stringify(existing));
  const writeEvent = LIVE_EVENT_TYPES.has(eventType) ? logDbEvent : logAnalyticsEvent;
  writeEvent(eventType, {
    station: stationId || session.connected_station || '00',
    payload,
  });
}

function tr(ko, en) {
  return (getSession()?.lang || 'ko') === 'en' ? en : ko;
}

function isRegistered(session = getSession()) {
  return Boolean(session?.intro_seen && session?.color && session?.color_locked);
}

function getCompletedStations(session = getSession()) {
  return Array.isArray(session?.completed_stations) ? session.completed_stations : [];
}

function markStationComplete(stationId) {
  const completed = new Set(getCompletedStations(ensureSession()));
  completed.add(String(stationId));
  updateSession({ completed_stations: [...completed] });
}

function applySessionColor(hex) {
  document.documentElement.style.setProperty('--session', hex || '#F25C94');
}

function displayName(session = getSession()) {
  return session?.emotional_name || tr('아직 이름 없음', 'NOT YET NAMED');
}

function stationFromQuery() {
  return new URLSearchParams(location.search).get('station');
}

function stationViaFromQuery() {
  const via = new URLSearchParams(location.search).get('via');
  return ['nfc', 'qr'].includes(via) ? via : 'qr';
}

function clearStationQuery() {
  const url = new URL(location.href);
  url.searchParams.delete('station');
  url.searchParams.delete('via');
  history.replaceState({}, '', url);
}

function stationLabel(stationId) {
  return {
    '01': 'NAMING',
    '02': 'INTERVENTION',
    '03': 'WITNESS',
    '04': 'RECORD',
  }[stationId] || 'MODULE';
}

function workTitle(stationId) {
  return {
    '01': tr('명명', 'NAMING'),
    '02': tr('개입', 'INTERVENTION'),
    '03': tr('목격', 'WITNESS'),
    '04': tr('기록', 'RECORD'),
  }[stationId] || tr('작품', 'WORK');
}

function workAboutSection(stationId) {
  return `about-work-${stationId}`;
}

function isTestMode() {
  return new URLSearchParams(location.search).get('test') === '1';
}

function assetFrame(fileName, options = {}) {
  const path = options.path || `./assets/images/${fileName}`;
  const label = options.label || fileName;
  const placeholder = el('div', { class: 'asset-placeholder' },
    el('span', { class: 'asset-type' }, options.type || 'IMAGE ASSET'),
    el('strong', {}, fileName),
    el('small', {}, path.replace('./', '')),
    options.note ? el('p', {}, options.note) : null,
  );

  const image = el('img', {
    class: 'asset-image',
    src: path,
    alt: label,
    onload: () => {
      image.hidden = false;
      placeholder.hidden = true;
    },
    onerror: () => {
      image.hidden = true;
      placeholder.hidden = false;
    },
  });

  image.hidden = true;
  return el('div', { class: `asset-frame ${options.className || ''}`.trim() }, image, placeholder);
}

function roseSpecimenImage(label, className = '', source = ROSE_SPECIMEN_IMAGE) {
  const image = el('img', {
    class: className,
    src: source,
    alt: label,
  });
  // PNG가 아직 폴더에 없더라도 작품 화면은 멈추지 않는다. 파일을 넣으면
  // 다음 새로고침부터 자동으로 실제 specimen 이미지가 사용된다.
  image.addEventListener('error', () => {
    if (image.dataset.fallback === 'true') return;
    if (image.src.includes('/rose_specimen_animation')) {
      image.src = ROSE_SPECIMEN_IMAGE;
      return;
    }
    image.dataset.fallback = 'true';
    image.src = './rose-bloom.svg';
  });
  return image;
}

function roseMark(className = '') {
  return el('span', { class: `rose-mark ${className}`.trim(), 'aria-hidden': 'true' },
    roseSpecimenImage('', 'rose-mark-image'),
    el('i', { class: 'rose-tint rose-mark-tint' }),
  );
}

function globalHeader() {
  const session = ensureSession();
  return el('header', { class: 'global-header' },
    el('button', {
      class: 'wordmark',
      type: 'button',
      'aria-label': tr('홈으로 이동', 'Go to home'),
      onclick: () => {
        closeRoseMenu();
        if (isRegistered(session)) screenHome();
        else screenArrival();
      },
    },
      el('span', {}, 'META ROSE'),
      el('span', {}, '2026'),
    ),
    el('div', { class: 'global-actions' },
      isTestMode() ? el('button', {
        class: 'dev-reset-button',
        type: 'button',
        'aria-label': tr('개발용: 처음부터 다시 보기', 'Developer: reset to arrival'),
        onclick: resetCurrentBrowserSession,
      }, 'RESET') : null,
      el('button', {
        class: 'language-button',
        type: 'button',
        'aria-label': tr('언어 변경', 'Change language'),
        onclick: () => {
          const next = session.lang === 'ko' ? 'en' : 'ko';
          updateSession({ lang: next });
          logEvent('language_selected', { language: next }, '00');
          renderCurrentView();
        },
      }, session.lang === 'ko' ? 'KO / EN' : 'EN / KO'),
      el('button', {
        class: 'rose-menu-button',
        type: 'button',
        'aria-label': tr('장미 메뉴 열기', 'Open rose menu'),
        'aria-haspopup': 'dialog',
        onclick: () => openRoseMenu(),
      }, roseMark('menu-rose')),
    ),
  );
}

function personalHeader(connectedStation = null) {
  const session = ensureSession();
  const connected = Boolean(connectedStation && session.connected_station === connectedStation);

  return el('button', {
    class: 'personal-header',
    type: 'button',
    onclick: () => screenMySpecimen({
      returnTo: connectedStation
        ? { name: 'module', data: { stationId: connectedStation, options: { via: 'back' } } }
        : { name: 'home', data: {} },
    }),
    'aria-label': tr('내 표본 보기', 'View my specimen'),
  },
    el('span', { class: 'personal-rose' },
      roseSpecimenImage(''),
      el('i', { class: 'rose-tint' }),
    ),
    el('span', { class: 'personal-copy' },
      el('small', {}, `ROSE NO. ${session.display_record_no}`),
      el('strong', {}, displayName(session)),
    ),
    connectedStation ? el('span', { class: `connection-state ${connected ? 'is-connected' : ''}` },
      connected ? '● CONNECTED' : '○ NOT CONNECTED',
    ) : el('span', { class: 'header-arrow', 'aria-hidden': 'true' }, '↗'),
  );
}

function closeRoseMenu() {
  document.querySelector('.rose-menu-overlay')?.remove();
  document.body.classList.remove('menu-open');
}

function menuAction(label, action, index = null) {
  return el('button', {
    class: 'rose-menu-item',
    type: 'button',
    onclick: () => {
      logEvent('menu_item_selected', { item: label, navigation_via: 'menu' }, null);
      closeRoseMenu();
      action();
    },
  },
    index ? el('span', { class: 'menu-index' }, index) : el('span', { class: 'menu-index' }, '·'),
    el('span', { class: 'menu-label' }, label),
    el('span', { class: 'menu-arrow', 'aria-hidden': 'true' }, '↗'),
  );
}

function guardedNavigation(action) {
  const session = ensureSession();
  if (!session.intro_seen) {
    screenArrival();
  } else if (!isRegistered(session)) {
    screenPersonalSetup();
  } else {
    action();
  }
}

function seedTestSession(completedStations = ['01']) {
  const session = ensureSession();
  const demo = {
    intro_seen: true,
    consent: true,
    color: session.color || '#F25C94',
    color_locked: true,
    nickname: '',
    emotional_name_a: session.emotional_name_a || '겁이 많은 나',
    emotional_name_b: session.emotional_name_b || '그래도 계속 가는 나',
    emotional_name: session.emotional_name || '겁이 많지만 계속 가는 나',
    completed_stations: completedStations,
  };
  updateSession(demo);
  applySessionColor(demo.color);
}

// 개발 중 현재 브라우저의 Phone Hub 상태만 초기화한다.
// Supabase에 이미 전송된 익명 전시 기록을 삭제하거나 변경하지 않는다.
function resetCurrentBrowserSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(EVENTS_KEY);
  resetDbSession();
  remoteTraceCache = {
    sessionId: null,
    fingerprint: '',
    summaries: [],
    request: null,
  };
  screenArrival();
}

function testPreview(label, action) {
  return el('button', {
    class: 'test-preview-button',
    type: 'button',
    onclick: () => {
      closeRoseMenu();
      action();
    },
  }, label);
}

function testPreviewPanel({ home = false } = {}) {
  return el('section', { class: `test-preview-panel ${home ? 'home-test-preview' : ''}`.trim() },
    el('span', { class: 'micro-label' }, 'TEST MODE / PREVIEW'),
    home ? el('h2', {}, tr('개발용 화면', 'DEVELOPMENT PREVIEW')) : null,
    home ? el('p', {}, tr(
      '장미 패턴 선택, 기존 태깅, 출구와 마지막 총정리 화면을 바로 확인합니다.',
      'Open rose-pattern entry, legacy tagged, exit, and final specimen states directly.',
    )) : null,
    el('div', { class: 'test-preview-grid' },
      testPreview(tr('처음부터 다시 보기', 'RESET TO ARRIVAL'), resetCurrentBrowserSession),
      testPreview('PATTERN 01', () => { seedTestSession(); screenModule('01', { enter: false, via: 'test_pattern' }); }),
      testPreview('PATTERN 02', () => { seedTestSession(); screenModule('02', { enter: false, via: 'test_pattern' }); }),
      testPreview('PATTERN 03', () => { seedTestSession(); screenModule('03', { enter: false, via: 'test_pattern' }); }),
      testPreview('PATTERN 04', () => { seedTestSession(); screenModule('04', { enter: false, via: 'test_pattern' }); }),
      testPreview('ANIMATION ALL', () => screenPatternAnimationPreview('all')),
      testPreview('TAGGED 01', () => { seedTestSession(); screenModule('01', { enter: true, via: 'test' }); }),
      testPreview('TAGGED 02', () => { seedTestSession(); screenModule('02', { enter: true, via: 'test' }); }),
      testPreview('TAGGED 03', () => { seedTestSession(); screenModule('03', { enter: true, via: 'test' }); }),
      testPreview('TAGGED 04', () => { seedTestSession(); screenModule('04', { enter: true, via: 'test' }); }),
      testPreview('ABOUT', () => { seedTestSession(); screenAboutProject(); }),
      testPreview('EXIT', () => { seedTestSession(['01']); screenExitJourney(); }),
      testPreview('FINAL', () => { seedTestSession(['01', '02', '03', '04']); screenFinalSpecimen(); }),
    ),
  );
}

function openRoseMenu() {
  if (document.querySelector('.rose-menu-overlay')) return;
  const session = ensureSession();
  logEvent('menu_open', { from: currentView.name }, null);

  const overlay = el('div', {
    class: 'rose-menu-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'ROSE MENU',
    onclick: (event) => {
      if (event.target === overlay) closeRoseMenu();
    },
  },
    el('div', { class: 'rose-menu-panel' },
      el('div', { class: 'rose-menu-head' },
        el('div', {},
          el('span', { class: 'micro-label' }, `ROSE NO. ${session.display_record_no}`),
          el('h2', {}, 'ROSE MENU'),
        ),
        el('button', { class: 'menu-close', type: 'button', onclick: closeRoseMenu, 'aria-label': tr('메뉴 닫기', 'Close menu') }, '×'),
      ),
      el('nav', { class: 'rose-menu-nav', 'aria-label': 'ROSE MENU' },
        menuAction('HOME', () => guardedNavigation(screenHome)),
        menuAction(tr('명명', 'NAMING'), () => guardedNavigation(() => screenModule('01', { via: 'menu' })), '01'),
        menuAction(tr('개입', 'INTERVENTION'), () => guardedNavigation(() => screenModule('02', { via: 'menu' })), '02'),
        menuAction(tr('목격', 'WITNESS'), () => guardedNavigation(() => screenModule('03', { via: 'menu' })), '03'),
        menuAction(tr('기록', 'RECORD'), () => guardedNavigation(() => screenModule('04', { via: 'menu' })), '04'),
        menuAction(tr('현재 표본', 'MY SPECIMEN'), () => guardedNavigation(screenMySpecimen)),
        menuAction(tr('오늘의 이름', 'NAME GIVEN TODAY'), () => guardedNavigation(() => screenFinalReflection({ exitFlow: false }))),
        menuAction(tr('전체 프로젝트', 'ABOUT THE PROJECT'), () => guardedNavigation(() => screenAboutProject())),
      ),
      isTestMode() ? testPreviewPanel() : null,
      el('div', { class: 'rose-menu-foot' },
        el('button', {
          class: 'menu-language',
          type: 'button',
          onclick: () => {
            const next = session.lang === 'ko' ? 'en' : 'ko';
            updateSession({ lang: next });
            logEvent('language_selected', { language: next, navigation_via: 'menu' }, '00');
            closeRoseMenu();
            renderCurrentView();
          },
        }, session.lang === 'ko' ? 'LANGUAGE  KO → EN' : 'LANGUAGE  EN → KO'),
        el('a', {
          class: 'menu-instagram',
          href: ARTIST_INSTAGRAM_URL,
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': 'Instagram @minniepark.studio',
          onclick: () => logEvent('artist_instagram_open', { handle: '@minniepark.studio' }, null),
        }, '@MINNIEPARK.STUDIO', el('span', { 'aria-hidden': 'true' }, '↗')),
        el('span', {}, 'META ROSE 2026 / THE FUNERAL'),
        el('span', { class: 'menu-copyright' }, '© 2026 MINNIE PARK. ALL RIGHTS RESERVED.'),
      ),
    ),
  );

  document.body.append(overlay);
  document.body.classList.add('menu-open');
  overlay.querySelector('.menu-close')?.focus();
}

function roseVisual(kind = 'specimen', label = 'MY ROSE', traceProfile = null) {
  const traceClasses = traceProfile
    ? ` has-td-trace trace-count-${traceProfile.count} trace-intensity-${traceProfile.intensity}`
    : '';
  return el('div', { class: `rose-visual rose-visual-${kind}${traceClasses}` },
    el('div', { class: 'scan-corner corner-a' }),
    el('div', { class: 'scan-corner corner-b' }),
    el('div', { class: 'rose-asset' },
      roseSpecimenImage(label),
      el('i', { class: 'rose-tint' }),
      el('i', { class: 'scanline' }),
    ),
    el('span', { class: 'visual-note note-a' }, 'BIO-SCAN / 01'),
    el('span', { class: 'visual-note note-b' }, 'LIVE SPECIMEN'),
  );
}

function disclosure(label, body, eventPrefix) {
  let openedAt = null;
  return el('details', {
    class: 'disclosure',
    ontoggle: (event) => {
      const open = event.target.open;
      const dwellMs = !open && openedAt !== null ? Math.round(performance.now() - openedAt) : null;
      if (open) openedAt = performance.now();
      logEvent(`${eventPrefix}_${open ? 'open' : 'close'}`, { dwell_ms: dwellMs }, null);
      if (!open) openedAt = null;
    },
  },
    el('summary', {}, label, el('span', { 'aria-hidden': 'true' }, '+')),
    el('div', { class: 'disclosure-body' }, body),
  );
}

function primaryButton(label, action) {
  return el('button', { class: 'primary-action', type: 'button', onclick: action }, label, el('span', { 'aria-hidden': 'true' }, '→'));
}

function textButton(label, action, className = '') {
  return el('button', { class: `text-button ${className}`.trim(), type: 'button', onclick: action }, label, el('span', { 'aria-hidden': 'true' }, '↗'));
}

function screenArrival() {
  const session = ensureSession();
  rememberView('arrival');
  clearStationQuery();
  applySessionColor('#D9D4CF');

  render([
    globalHeader(),
    el('section', { class: 'arrival-cover' },
      el('div', { class: 'cover-meta' },
        el('span', {}, 'MINNIE PARK'),
        el('span', {}, '2026'),
      ),
      el('h1', { class: 'arrival-title' },
        el('span', {}, tr('오늘 나는', 'TODAY I KILL')),
        el('span', {}, tr('죽인다, 나를', 'MY SELF')),
      ),
      assetFrame('arrival_hero.png', {
        className: 'arrival-asset',
        label: 'META ROSE SPECIMEN arrival hero',
        type: 'ARRIVAL HERO / P0',
        note: tr('입구 표지용 고정 비주얼 사진', 'Fixed visual photograph for the entry cover'),
      }),
      el('div', { class: 'record-line' },
        el('span', {}, tr('당신의 장미 번호', 'YOUR ROSE NUMBER')),
        el('strong', {}, `ROSE NO. ${session.display_record_no}`),
      ),
      el('section', { class: 'arrival-thesis' },
        el('p', {}, tr(
          '바니타스의 꽃과 해골은 삶이 사라진다는 사실을 말해왔습니다.',
          'The flowers and skulls of vanitas have long spoken of life passing away.',
        )),
        el('p', {}, tr(
          '여기서는 질문이 조금 달라집니다. 우리는 왜 살아 있는 동안에도 자기 안의 어떤 부분을 계속 죽일까요.',
          'Here, the question shifts: why do we keep killing parts of ourselves while we are still alive?',
        )),
        el('p', {}, tr(
          '이 장례식은 그 ‘나’를 다시 불러, 무엇을 살리고 어느 쪽에 물을 줄지 고르는 자리입니다.',
          'This funeral calls that self back, and returns the choice of what to keep alive and what to water.',
        )),
      ),
      el('p', { class: 'intro-copy phone-role-copy' }, tr(
        '이 휴대폰은 당신이 고른 장미와 지은 이름, 각 작품에서 남긴 장면을 한곳에 모읍니다. 전시장 곳곳의 장미에 휴대폰을 대면, 당신이 지나온 과정이 당신의 장미에 차례로 남습니다.',
        'This phone gathers your rose, the name you make, and the moments you leave in each work.',
      )),
      disclosure(
        tr('당신의 장미에 남는 것', 'WHAT STAYS WITH YOUR ROSE'),
        el('div', { class: 'copy-stack' },
          el('p', {}, tr(
            '계정을 만들거나 본명을 묻지 않습니다. 당신이 고른 색, 직접 지은 이름, 작품을 지나며 남기기로 한 장면만 장미 번호와 연결됩니다.',
            'No account or legal name is required. Only what you choose to leave is connected to your rose number.',
          )),
          el('p', {}, tr(
            '얼굴을 식별하기 위한 정보와 휴대폰의 위치 정보는 저장하지 않습니다. 수집한 기록은 작품 연구와 전시 경험 개선을 위해서만 사용하며 다른 관객에게 공개하지 않습니다.',
            'Original face images and phone location are not stored.',
          )),
        ),
        'record_info',
      ),
      disclosure(
        tr('당신의 속도로 보셔도 됩니다', 'MOVE AT YOUR OWN PACE'),
        el('div', { class: 'copy-stack' },
          el('p', {}, tr(
            '이 작품에는 자기혐오, 죽음과 애도의 이미지가 등장합니다. 그러나 무엇을 가까이 보고, 무엇을 만지고, 언제 멈출지는 당신이 정합니다.',
            'This work contains images of self-hatred, death, and mourning. You decide what to approach, touch, or leave.',
          )),
          el('p', {}, tr(
            '불편하면 지나가도 되고, 잠시 쉬었다 돌아와도 됩니다. 당신의 속도와 선택도 이 작품의 일부입니다.',
            'You may pass, pause, or return. Your pace and choices are part of the work.',
          )),
        ),
        'pace_info',
      ),
      el('footer', { class: 'screen-footer-meta' },
        el('span', {}, `SESSION CREATED / ${new Date(session.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`),
      ),
    ),
  ], [
    primaryButton(tr('내 장미를 만들고 입장합니다', 'CREATE MY ROSE AND ENTER'), async () => {
      logEvent('arrival_enter_clicked', {}, '00');
      const remote = await createRemoteSession(true);
      if (!remote) {
        alert(tr(
          '세션 연결을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 눌러주세요.',
          'The session could not be confirmed. Check the network and try again.',
        ));
        return;
      }
      updateSession({ intro_seen: true, consent: true, local_only: false });
      screenPersonalSetup();
    }),
    textButton(tr('기록 없이 작품 안내만 보겠습니다', 'VIEW THE GUIDE WITHOUT A RECORD'), () => {
      logEvent('arrival_local_only_clicked', {}, '00');
      updateSession({ intro_seen: true, consent: false, local_only: true });
      screenPersonalSetup();
    }, 'local-only-entry quiet-entry'),
  ]);
  // 입장 전 읽기는 세션 발급 후 queue에서 해당 세션으로 귀속된다.
  startPageRead('arrival');
}

function openRegistrationConfirmation(color, selectionMeta = {}) {
  const overlay = el('div', { class: 'confirmation-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('장미 선택 확인', 'Confirm rose') },
    el('div', { class: 'confirmation-card' },
      el('span', { class: 'micro-label' }, 'CONFIRM / SPECIMEN'),
      roseVisual('confirmation', 'SELECTED MY ROSE'),
      el('h2', {}, tr('이 장미를 선택하시겠습니까?', 'CHOOSE THIS ROSE?')),
      el('p', {}, tr(
        '선택한 색은 작품 안에서 당신을 나타내고, 마지막 방에서 자신을 찾는 단서가 됩니다. 이번 관람 중에는 변경할 수 없습니다.',
        'This color represents you throughout today\'s work and record. It cannot be changed during this exhibition.',
      )),
      primaryButton(tr('이 장미로 결정합니다', 'CONFIRM THIS ROSE'), () => {
        applySessionColor(color);
        updateSession({ nickname: '', color, color_locked: true });
        logEvent('specimen_registered', { color, ...selectionMeta }, '00');
        overlay.remove();
        const pendingSession = getSession();
        const pendingStation = pendingSession?.pending_station;
        const pendingStationVia = pendingSession?.pending_station_via || 'qr';
        if (pendingStation === '05') {
          updateSession({ pending_station: null, pending_station_via: null });
          screenExitJourney();
        } else if (pendingStation) {
          updateSession({ pending_station: null, pending_station_via: null });
          screenModule(pendingStation, { enter: true, via: pendingStationVia });
        } else {
          screenHome();
        }
      }),
      textButton(tr('다시 선택하기', 'SELECT AGAIN'), () => overlay.remove()),
    ),
  );

  document.body.append(overlay);
}

function screenPersonalSetup() {
  const session = ensureSession();
  rememberView('setup');
  applySessionColor(session.color || '#F25C94');

  let selectedColor = session.color_locked ? session.color : (session.color || '#F25C94');
  const openedAt = performance.now();
  let colorChangeCount = 0;
  const error = el('p', { class: 'field-error', 'aria-live': 'polite' });
  const colorPicker = el('input', {
    class: 'continuous-color-field',
    type: 'color',
    value: selectedColor,
    'aria-label': tr('나의 장미 색 선택', 'Choose my rose color'),
    oninput: (event) => {
      colorChangeCount += 1;
      selectedColor = event.currentTarget.value.toUpperCase();
      applySessionColor(selectedColor);
      error.textContent = '';
    },
  });

  render([
    globalHeader(),
    el('section', { class: 'screen registration-screen' },
      el('div', { class: 'screen-kicker' },
        el('span', {}, '01 / REGISTRATION'),
        el('span', {}, `ROSE NO. ${session.display_record_no}`),
      ),
      el('h1', { class: 'screen-title' }, tr('나의 장미 색을 고릅니다', 'CHOOSE MY ROSE COLOR')),
      roseVisual('registration', 'MY ROSE PREVIEW'),
      el('div', { class: 'input-group color-group' },
        el('label', {}, 'MY ROSE COLOR'),
        colorPicker,
        el('span', { class: 'input-note' }, tr('색의 이름은 정해두지 않았습니다. 팔레트에서 지금 당신의 장미로 남기고 싶은 색을 직접 골라주세요.', 'Choose the color you want to keep as your rose directly from the palette.')),
        error,
      ),
      el('section', { class: 'emotional-naming-intro' },
        el('span', { class: 'section-code' }, 'NAME GIVEN TODAY'),
        el('h2', {}, tr('이름은 아직 짓지 않습니다', 'THE NAME COMES LATER')),
        el('p', {}, tr(
          '01의 장미 정원에서 손으로 먼저 만난 뒤, 당신의 말로 하나의 이름을 짓습니다. 그 이름은 02와 03에서 다시 나타납니다.',
          'After meeting the roses by hand in 01, you will make one name in your own words.',
        )),
        disclosure(
          tr('이름을 짓는 일에 대하여', 'ABOUT NAMING'),
          el('div', { class: 'copy-stack emotional-naming-guide' },
            el('p', {}, tr(
              '이름을 짓는 일은 이미 정해진 감정 단어를 고르는 과정이 아닙니다. 작품을 지나며 발견한 서로 다른 두 모습을 한 문장 안에 함께 남기고, 오늘의 나를 부를 임시적인 이름을 직접 만드는 과정입니다.',
              'Emotional naming is not a matter of choosing from a fixed list. It brings two different sides you encounter into one sentence and lets you make a temporary name for yourself today.',
            )),
            el('p', {}, tr(
              '먼저 내가 없애고 싶거나 미워했던 한 면을 적습니다. 예를 들면 “쉽게 겁먹는 나”, “자꾸 멈추는 나”처럼 지금 실제로 느껴지는 말이면 충분합니다. 그다음, 바로 그 모습 안에 동시에 존재했던 다른 한 면을 찾습니다. 두려워하면서도 자리를 지켰거나, 멈췄지만 다시 움직였던 나일 수 있습니다.',
              'First, write one side of yourself that you wanted to erase or rejected. Then look for another side that existed inside it at the same time: perhaps the self that was afraid but stayed, or stopped and moved again.',
            )),
            el('p', {}, tr(
              '두 번째 문장은 첫 번째를 지우거나 긍정적으로 고쳐 쓰기 위한 것이 아닙니다. 서로 모순되어 보이는 두 모습이 동시에 나였다는 사실을 그대로 두는 것이 중요합니다.',
              'The second sentence does not erase, correct, or make the first one positive. What matters is allowing two seemingly contradictory sides to remain true at once.',
            )),
            el('div', { class: 'emotional-naming-example' },
              el('span', {}, tr('예시', 'EXAMPLE')),
              el('p', {}, tr('“겁이 많은 나” + “그래도 계속 가는 나”', '“The self who is afraid” + “The self who keeps going”')),
              el('strong', {}, tr('→ 겁이 많지만 계속 가는 나', '→ THE SELF WHO IS AFRAID BUT KEEPS GOING')),
            ),
            el('p', {}, tr(
              '정답이나 좋은 표현은 없습니다. 완전한 문장이 아니어도 되고, 타인에게 설명하기 어려운 말이어도 됩니다. 이 이름은 진단이나 성격 규정이 아니라, 오늘 이 전시를 통과한 나를 잠시 붙잡아 두는 표식입니다.',
              'There is no correct or polished answer. It does not need to be a complete sentence or easy to explain. This is not a diagnosis or a fixed identity, but a marker for the self moving through the exhibition today.',
            )),
            el('p', {}, tr(
              '01을 마친 뒤 이름을 짓는 것을 권합니다. 오늘 지은 이름은 02와 03의 화면에 나타나고, 마지막에는 당신의 장미 번호와 함께 유품에 남습니다. 발인 전 다시 읽고 다듬을 수 있습니다.',
              'We recommend naming after 01. Your completed name reappears in 02 and 03 and remains with your rose number in the final record. You can read and refine it again at the end.',
            )),
          ),
          'emotional_naming_intro',
        ),
      ),
    ),
  ], [
    primaryButton(tr('이 색으로 나의 장미를 만듭니다', 'CREATE MY ROSE'), () => {
      if (!selectedColor) {
        error.textContent = tr('나의 장미 색을 골라주세요.', 'Choose my rose color.');
        return;
      }
      error.textContent = '';
      openRegistrationConfirmation(selectedColor, {
        selection_duration_ms: Math.round(performance.now() - openedAt),
        color_change_count: colorChangeCount,
      });
    }),
  ]);
}

function moduleStatus(session, stationId) {
  if (session.connected_station === stationId) return tr('연결 중', 'CONNECTED');
  if (getCompletedStations(session).includes(stationId)) return tr('다녀옴', 'VISITED');
  return tr('아직', 'NOT YET');
}

function floorplanHotspot(stationId, className, physicalLabel) {
  const label = stationLabel(stationId);
  const session = ensureSession();
  const visited = getCompletedStations(session).includes(stationId) || Boolean(traceSummaryForStation(stationId));
  const connected = session.connected_station === stationId;
  return el('button', {
    class: `map-hotspot ${className}${visited ? ' is-visited' : ''}${connected ? ' is-connected' : ''}`,
    type: 'button',
    'aria-label': `${stationId} ${label} ${physicalLabel}`,
    onclick: () => {
      logEvent('floorplan_module_click', { station_id: stationId, via: 'floorplan' }, stationId);
      screenModule(stationId, { via: 'floorplan' });
    },
  },
    el('span', { class: 'hotspot-number' }, String(Number(stationId))),
    el('span', { class: 'hotspot-label' }, workTitle(stationId)),
    visited ? el('span', { class: 'hotspot-complete', 'aria-hidden': 'true' }, '✓') : null,
  );
}

function floorplanRouteOrder(session) {
  const routeStep = (stationId) => {
    const visited = getCompletedStations(session).includes(stationId) || Boolean(traceSummaryForStation(stationId));
    return el('button', {
      class: `route-order-step${visited ? ' is-visited' : ''}`,
      type: 'button',
      onclick: () => screenModule(stationId, { via: 'route_order' }),
      'aria-label': `${stationId} ${workTitle(stationId)} ${moduleStatus(session, stationId)}`,
    },
      el('strong', {}, String(Number(stationId))),
      el('span', {}, workTitle(stationId)),
    );
  };

  return el('nav', { class: 'floorplan-route-order', 'aria-label': tr('권장 관람 순서', 'Suggested route') },
    routeStep('01'),
    el('span', { class: 'route-order-arrow', 'aria-hidden': 'true' }, '→'),
    el('div', { class: 'route-order-pair' }, routeStep('02'), routeStep('03')),
    el('span', { class: 'route-order-arrow', 'aria-hidden': 'true' }, '→'),
    routeStep('04'),
    el('span', { class: 'route-order-arrow', 'aria-hidden': 'true' }, '→'),
    el('button', { class: 'route-order-step route-order-exit', type: 'button', onclick: screenExitJourney },
      el('strong', {}, '⇅'),
      el('span', {}, tr('출입구', 'IN / OUT')),
    ),
  );
}

function floorplanViewer(session) {
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let planAngle = 0;
  let dragStartAngle = 0;
  let planTilt = 42;
  let dragStartTilt = 42;
  let activePointerId = null;

  const planViewCounter = () => `${String(Math.round(planAngle)).padStart(3, '0')}° · ${String(Math.round(planTilt)).padStart(2, '0')}°`;
  const actualPlan = el('img', {
    class: 'actual-floorplan-image',
    src: './assets/floorplan/gallery-room-1-plan.webp',
    alt: '',
    'aria-hidden': 'true',
    onerror: (event) => { event.currentTarget.hidden = true; },
  });

  function finishDrag(event) {
    if (activePointerId !== event.pointerId) return;
    const didDrag = dragging;
    if (dragging && stage.hasPointerCapture?.(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
    dragging = false;
    activePointerId = null;
    stage.classList.remove('is-dragging');
    if (didDrag) {
      logEvent('floorplan_rotate', {
        turntable_ready: false,
        frame: null,
        angle: Math.round(planAngle),
        tilt: Math.round(planTilt),
      }, '00');
    }
  }

  const planRotor = el('div', { class: 'floorplan-rotor' },
    actualPlan,
    el('div', { class: 'miniature-walls', 'aria-hidden': 'true' },
      el('span', { class: 'mini-wall is-horizontal wall-top-a' }),
      el('span', { class: 'mini-wall is-horizontal wall-top-b' }),
      el('span', { class: 'mini-wall is-vertical wall-left' }),
      el('span', { class: 'mini-wall is-vertical wall-right-a' }),
      el('span', { class: 'mini-wall is-vertical wall-right-b' }),
      el('span', { class: 'mini-wall is-horizontal wall-notch-top' }),
      el('span', { class: 'mini-wall is-vertical wall-notch-side' }),
      el('span', { class: 'mini-wall is-horizontal wall-bottom' }),
      el('span', { class: 'mini-wall is-vertical wall-partition' }),
    ),
    el('div', { class: 'floorplan-info-table', 'aria-hidden': 'true' }, 'INFO TABLE'),
    floorplanHotspot('01', 'hotspot-01', 'MAIN 1'),
    floorplanHotspot('02', 'hotspot-02', 'SUB 1'),
    floorplanHotspot('03', 'hotspot-03', 'SUB 2'),
    floorplanHotspot('04', 'hotspot-04', 'SUB 3 VIDEO'),
    el('div', { class: 'floorplan-passage', 'aria-hidden': 'true' },
      el('span', {}, '←'),
      ' ROOM 2 / PASSAGE',
    ),
    el('button', {
      class: 'map-exit',
      type: 'button',
      onclick: (event) => { event.stopPropagation(); screenExitJourney(); },
      'aria-label': tr('출구 화면 열기', 'Open exit screen'),
    }, 'IN / OUT', el('span', {}, '↕')),
  );

  const stage = el('div', {
    class: 'floorplan-stage',
    onpointerdown: (event) => {
      if (event.button !== 0 || event.target.closest('button, a, input, summary')) return;
      activePointerId = event.pointerId;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragStartAngle = planAngle;
      dragStartTilt = planTilt;
    },
    onpointermove: (event) => {
      if (activePointerId !== event.pointerId) return;
      const deltaX = event.clientX - dragStartX;
      const deltaY = event.clientY - dragStartY;
      if (!dragging) {
        if (Math.hypot(deltaX, deltaY) < 7) return;
        dragging = true;
        stage.classList.add('is-dragging');
        stage.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
      planAngle = (dragStartAngle + (deltaX * 0.9) + 3600) % 360;
      planTilt = Math.max(18, Math.min(68, dragStartTilt - (deltaY * 0.28)));
      stage.style.setProperty('--plan-angle', `${planAngle}deg`);
      stage.style.setProperty('--plan-tilt', `${planTilt}deg`);
      stage.querySelector('.frame-counter').textContent = planViewCounter();
    },
    onpointerup: finishDrag,
    onpointercancel: finishDrag,
    onlostpointercapture: () => {
      dragging = false;
      activePointerId = null;
      stage.classList.remove('is-dragging');
    },
  },
    planRotor,
    el('div', { class: 'turntable-ui' },
      el('span', { class: 'view-mode' }, 'DRAG ↔ ROTATE · ↕ TILT'),
      el('span', { class: 'frame-counter' }, '000° · 42°'),
    ),
  );

  return stage;
}

function screenHome() {
  const session = ensureSession();
  if (!isRegistered(session)) {
    screenPersonalSetup();
    return;
  }

  rememberView('home');
  clearStationQuery();
  applySessionColor(session.color);
  logEvent('home_enter', {}, '00');

  const modules = ['01', '02', '03', '04'];

  render([
    globalHeader(),
    el('section', { class: 'screen home-screen' },
      personalHeader(),
      el('section', { class: 'project-intro home-project-lead' },
        el('span', { class: 'micro-label' }, 'TODAY I KILL MY SELF / 2026'),
        el('h1', {}, tr('오늘 나는 죽인다, 나를', 'TODAY I KILL MY SELF')),
        el('p', {}, tr(
          '바니타스의 꽃과 해골은 삶이 사라진다는 사실을 말해왔습니다. 이 작품은 질문을 바꿉니다. 우리는 왜 살아 있는 동안에도 자기 안의 어떤 부분을 계속 죽일까요.',
          'The flowers and skulls of vanitas speak of life passing. This work asks what we keep killing while we are still alive.',
        )),
        textButton(tr('전체 프로젝트 읽기', 'READ THE FULL PROJECT'), () => screenAboutProject('about-intro'), 'home-about-primary'),
      ),
      el('div', { class: 'section-heading-row' },
        el('div', {},
          el('span', { class: 'micro-label' }, 'EXHIBITION MAP / B1'),
          el('h1', { class: 'screen-title compact-title' }, 'FLOORPLAN'),
        ),
        el('span', { class: 'map-coordinate' }, '37.5665°N'),
      ),
      floorplanRouteOrder(session),
      floorplanViewer(session),
      el('p', { class: 'route-note route-note-primary' }, tr(
        '01의 장미 정원에서 이름을 지은 뒤, 02와 03은 원하는 순서로 지나가셔도 됩니다. 04는 언제든 보실 수 있습니다.',
        'Make your name in 01, then visit 02 and 03 in either order. 04 is open at any time.',
      )),
      el('div', { class: 'module-index-list' },
        ...modules.map((stationId) => el('button', { class: 'module-index-row module-index-key', type: 'button', onclick: () => screenModule(stationId, { via: 'floorplan_list' }) },
          el('span', { class: 'module-number' }, stationId),
          el('strong', {}, workTitle(stationId)),
          el('span', { class: 'visit-status' }, moduleStatus(session, stationId)),
          el('span', { class: 'module-code' }, stationLabel(stationId)),
        )),
      ),
      isTestMode() ? testPreviewPanel({ home: true }) : null,
      el('div', { class: 'home-name-action' },
        el('span', {}, session.emotional_name ? tr('오늘 지은 이름', 'NAME GIVEN TODAY') : tr('아직 이름 없음', 'NOT YET NAMED')),
        textButton(session.emotional_name ? tr('오늘의 이름 보기', 'VIEW NAME') : tr('오늘의 이름 짓기', 'NAME YOURSELF'), () => screenFinalReflection({ exitFlow: false })),
      ),
    ),
  ]);
}

function scrollToAboutSection(sectionId, smooth = true) {
  const target = document.getElementById(sectionId);
  if (!target) return;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  logEvent('about_anchor_selected', { section_id: sectionId }, '00');
}

function aboutSection({ id, index, title, lead, body = [], deeper = [] }) {
  return el('section', { class: 'about-section', id },
    el('span', { class: 'about-section-index' }, index),
    el('h2', {}, title),
    el('p', { class: 'about-section-lead' }, lead),
    ...body.map((paragraph) => el('p', {}, paragraph)),
    deeper.length ? disclosure(
      tr('작품의 안쪽 읽기', 'READ DEEPER'),
      el('div', { class: 'copy-stack about-deeper-copy' },
        ...deeper.map((paragraph) => el('p', {}, paragraph)),
      ),
      `about_${id}`,
    ) : null,
    el('button', { class: 'about-to-top', type: 'button', onclick: () => scrollToAboutSection('about-top') }, tr('목차로 돌아가기', 'BACK TO CONTENTS')),
  );
}

function screenAboutProject(initialSection = null) {
  const session = ensureSession();
  if (!isRegistered(session)) {
    screenPersonalSetup();
    return;
  }

  rememberView('about', { initialSection });
  clearStationQuery();
  applySessionColor(session.color);
  logEvent('about_page_enter', { initial_section: initialSection || 'top' }, '00');

  const anchors = [
    ['about-intro', '작품이 시작된 질문'],
    ['about-vanitas', '바니타스에서 가져온 것'],
    ['about-rose', '장미가 가진 여러 얼굴'],
    ['about-ambivalence', '양가성과 동시성'],
    ['about-choice', '선택을 관객에게 돌려주는 일'],
    ['about-ritual', '장례식의 순서'],
    ['about-work-01', '01 명명 / NAMING'],
    ['about-work-02', '02 개입 / INTERVENTION'],
    ['about-work-03', '03 목격 / WITNESS'],
    ['about-work-04', '04 기록 / RECORD'],
    ['about-phone', '당신의 장미와 Phone Hub'],
    ['about-position', '관객을 대하는 작가의 위치'],
  ];

  render([
    globalHeader(),
    el('article', { class: 'screen about-screen', id: 'about-top' },
      textButton('HOME', screenHome, 'about-back'),
      el('header', { class: 'about-hero' },
        el('span', { class: 'micro-label' }, 'META ROSE 2026 / THE FUNERAL'),
        el('h1', {}, tr('프로젝트에 대하여', 'ABOUT THE PROJECT')),
        el('p', {}, '〈오늘 나는 죽인다, 나를〉'),
        el('p', { class: 'about-hero-lead' }, tr(
          '내가 죽인 나를 위해 치르는 장례식. 꽃과 해골, 사람의 손과 기계, 살리는 행동과 죽이는 행동이 한 시간 안에 함께 놓입니다.',
          'A funeral for the self I have killed.',
        )),
      ),
      el('details', { class: 'about-toc', open: true },
        el('summary', {}, tr('읽을 곳을 고릅니다', 'CONTENTS'), el('span', { 'aria-hidden': 'true' }, '+')),
        el('nav', { class: 'about-anchor-nav', 'aria-label': tr('프로젝트 상세 목차', 'Project contents') },
          ...anchors.map(([id, label], index) => el('button', {
            type: 'button',
            onclick: () => scrollToAboutSection(id),
          },
            el('span', {}, String(index + 1).padStart(2, '0')),
            el('strong', {}, label),
          )),
        ),
      ),
      aboutSection({
        id: 'about-intro',
        index: '01',
        title: '작품이 시작된 질문',
        lead: '타인에게는 너그러우면서 왜 자기 자신에게는 그렇게 잔인해질까요.',
        body: [
          '우리는 사랑하는 사람의 결함을 그 사람의 일부로 받아들이면서도, 자기 안에서 같은 결함을 발견하면 없애야 할 것으로 취급하곤 합니다. 게으른 나, 우울한 나, 실패한 나, 질투하는 나, 겁이 많은 나. 살아 있는 한 사람 안에 머물 수 있는 여러 얼굴을 스스로 쫓아내고 죽입니다.',
          '〈오늘 나는 죽인다, 나를〉은 그렇게 죽여 온 ‘나’를 위한 장례식입니다. 그러나 이 장례는 완전히 보내버리기 위한 의식이 아닙니다. 죽였다고 믿은 것이 어떤 모습으로 다시 돌아오는지 보고, 그 존재를 다시 부를 이름을 만드는 자리입니다.',
        ],
        deeper: [
          '이 작품은 자기혐오를 하나의 개인적 결함으로만 보지 않습니다. 완벽함을 요구하는 시선, 쓸모와 생산성을 기준으로 자신을 평가하는 습관, 좋아 보이는 모습만 남기려는 이미지 문화가 한 사람의 내부에서 어떻게 작동하는지를 함께 봅니다.',
          '장례식이라는 형식은 끝을 선언하기 위해서가 아니라, 평소에는 보이지 않던 관계를 잠시 드러내기 위해 사용됩니다. 누가 죽였고, 무엇이 죽었으며, 남은 사람은 누구인지. 여기서는 세 질문의 답이 모두 ‘나’일 수 있습니다.',
          '이 작품에서 죽인 사람과 죽은 사람, 그리고 장례 뒤에 남은 사람은 모두 나일 수 있습니다. 그래서 이 장례는 누군가를 완전히 보내기 위한 의식이 아닙니다. 내가 없앴다고 믿은 것이 어떤 모습으로 돌아오는지 보고, 그 존재와 맺고 있던 관계를 다시 바라보는 자리입니다.',
          '작품은 자기혐오가 사라졌다고 선언하지 않습니다. 대신 미워했던 면을 제거해야만 앞으로 갈 수 있다는 생각을 멈추고, 그 면 안에 함께 있었던 다른 얼굴까지 같은 시간에 놓아봅니다.',
        ],
      }),
      aboutSection({
        id: 'about-vanitas',
        index: '02',
        title: '바니타스에서 가져온 것',
        lead: '꽃, 해골, 썩는 과일과 꺼지는 빛은 삶이 유한하다는 사실을 한 화면에 놓아왔습니다.',
        body: [
          '바니타스 정물화에서 활짝 핀 꽃과 해골은 서로 반대되는 장식이 아닙니다. 가장 아름다운 순간 안에 이미 시듦이 있고, 죽음의 이미지 안에도 한때 살아 있던 시간의 흔적이 있습니다. 삶과 죽음은 앞뒤로 나뉘지 않고 같은 장면 안에 동시에 존재합니다.',
          '이 작품은 그 구조를 오늘의 자기 인식으로 옮깁니다. “우리는 언젠가 죽는다”는 오래된 문장 옆에 “나는 살아 있는 동안 무엇을 계속 죽이고 있는가”라는 질문을 둡니다.',
        ],
        deeper: [
          '그래서 여기의 장미와 해골은 단순한 장례 장식이나 고딕 이미지가 아닙니다. 장미는 만져야 소리를 얻고, 해골은 관객에게 손을 내밉니다. 정물화 속에서 멈춰 있던 상징이 관객의 행동을 기다리는 물체로 바뀝니다.',
          '바니타스가 죽음을 기억하게 했다면, 이 작업은 자신이 무엇을 죽이고 있는지 보게 합니다. 기억은 관찰로 끝나지 않고, 무엇을 살리고 무엇에 물을 줄지 다시 고르는 행동으로 이어집니다.',
          '바니타스의 꽃은 피어 있는 순간에도 시들고 있고, 해골은 한때 살아 움직였던 몸의 시간을 품습니다. 이 작품은 서로 반대되는 상태가 한 화면 안에 동시에 존재하는 구조를 가져오되, 죽음을 멀리 있는 운명으로만 다루지 않습니다.',
          '살아 있으면서도 자기 안의 일부를 반복해서 제거하고, 말하지 못하게 하고, 존재하지 않았던 것처럼 만드는 일에 주목합니다. 장미와 해골은 그 질문을 바라보는 상징에서 관객의 선택을 받아 움직이는 몸으로 바뀝니다.',
        ],
      }),
      aboutSection({
        id: 'about-rose',
        index: '03',
        title: '장미가 가진 여러 얼굴',
        lead: '장미는 사랑의 꽃이면서 장례의 꽃이고, 피어난 얼굴과 가시를 한 몸에 가지고 있습니다.',
        body: [
          '장미 한 송이를 좋은 감정이나 나쁜 감정 하나에 고정하지 않습니다. 같은 성질이 어떤 순간에는 자신을 지키고, 다른 순간에는 자신과 타인을 찌를 수 있기 때문입니다. 관객이 고른 색에도 미리 감정의 이름을 붙이지 않습니다.',
          '01의 장미는 생화입니다. 손에 닿고 물을 먹으며 실제로 변하는 자리이기 때문입니다. 02와 03의 장미는 조화와 표본의 물성을 가집니다. 이미 일어난 일을 다시 연기하고, 지나간 것을 바라보는 자리이기 때문입니다.',
        ],
        deeper: [
          '생화와 조화를 진짜와 가짜의 위계로 나누지 않습니다. 생화는 변화하고 소멸하는 몸이고, 조화는 변하지 않도록 붙잡힌 기억입니다. 하나는 살아 있어서 사라지고, 다른 하나는 죽어 있어서 오래 남습니다.',
          '마지막에 만들어지는 디지털 장미도 완성된 자아의 초상이 아닙니다. 관객이 고른 색, 지나온 순서, 남긴 이름과 장면이 잠시 한 형태로 모인 것입니다. 정답이나 진단이 아니라 그날의 배치에 가깝습니다.',
          '같은 성질이 어떤 순간에는 자신을 지키고, 다른 순간에는 자신과 타인을 찌를 수 있습니다. 그래서 관객이 고른 색에도 미리 감정의 이름을 붙이지 않습니다. 색은 진단이 아니라 전시장 안에서 자신을 다시 찾기 위한 표식입니다.',
          '01의 장미는 손길과 전시의 시간을 몸에 남깁니다. 02와 03의 장미는 이미 일어난 일을 다시 연기하고 지나간 것을 표본처럼 바라보는 자리에 놓입니다. 서로 다른 물성은 각 작품이 시간과 맺는 관계를 드러냅니다.',
        ],
      }),
      aboutSection({
        id: 'about-ambivalence',
        index: '04',
        title: '양가성과 동시성',
        lead: '미워한 면과 그것의 다른 얼굴을 동시에 바라볼 수 있을까요.',
        body: [
          '이 전시에서 살리는 행동과 죽이는 행동은 선과 악으로 나뉘지 않습니다. 물과 햇빛도 지나치면 한 존재를 압도할 수 있고, 독과 괴물에 반응하는 방식에서도 관객 자신의 태도가 드러납니다. 중요한 것은 어느 버튼이 옳은가가 아니라, 자신이 무엇을 반복해서 선택하는가입니다.',
          '오늘의 이름도 같은 구조를 가집니다. 관객은 먼저 없애고 싶었던 자기의 한 면을 쓰고, 그 안에 함께 있었던 다른 한 면을 씁니다. 두 번째 문장은 첫 번째를 미화하거나 취소하지 않습니다. 서로 모순되는 두 얼굴이 한 이름 안에 함께 남습니다.',
        ],
        deeper: [
          '작품의 끝은 부정적인 면을 제거하고 긍정적인 면이 승리하는 장면이 아닙니다. 죽음 뒤에는 리스폰이 있고, 이전의 흔적은 완전히 사라지지 않습니다. 살아남음과 상처, 돌봄과 파괴가 한 화면 안에서 공존하는 상태가 마지막에 가깝습니다.',
          '그래서 Phone Hub는 관객에게 점수나 성격 분석을 보여주지 않습니다. 내부의 변화는 장미의 모양에만 반영됩니다. 숫자는 모순을 다시 한 줄의 평가로 줄여버리기 때문입니다.',
          '돌봄은 언제나 순수하게 선하지 않고 파괴 역시 하나의 의미로만 닫히지 않습니다. 무엇을 살린다는 명목으로 지나치게 통제할 수도 있고, 없애려던 행동이 오히려 다른 흔적을 드러낼 수도 있습니다.',
          '오늘의 이름도 같은 구조를 가집니다. 두 번째 문장은 첫 번째를 미화하거나 취소하지 않습니다. 둘은 한 사람 안에서 동시에 존재하며, 이름은 한쪽이 다른 쪽을 이긴 결과가 아니라 두 얼굴을 함께 부르는 방식이 됩니다.',
        ],
      }),
      aboutSection({
        id: 'about-choice',
        index: '05',
        title: '선택을 관객에게 돌려주는 일',
        lead: '이 작품은 관객의 감정을 대신 말하지 않으려 합니다.',
        body: [
          '감정 단어를 먼저 보여주지 않고, 몸이 장미와 기계에 닿은 다음에 이름을 묻습니다. 설명을 읽고 정답을 수행하는 순서가 아니라, 만지고 머물고 망설인 뒤에 자신의 언어가 오도록 하기 위해서입니다.',
          '무엇을 만질지, 얼마나 오래 볼지, 도움말을 열지, 한 장면을 남길지, 언제 그만둘지는 관객이 정합니다. 불편한 내용을 끝까지 견디는 것이 좋은 관람이라는 규칙도 없습니다. 지나가고, 쉬고, 다시 돌아오는 선택까지 작품의 일부입니다.',
        ],
        deeper: [
          '선택권을 준다는 것은 모든 것을 가볍게 만든다는 뜻이 아닙니다. 오히려 선택의 결과가 다음 장면에 남도록 합니다. 01에서 만든 이름이 02와 03으로 이동하고, 오래 바라본 시간이 자신의 위치를 바꾸며, 마지막에 남긴 한 줄이 장미 번호에 연결됩니다.',
          '작가는 관객을 분석 대상이나 작품을 완성하는 재료로만 다루지 않으려 합니다. 관객은 작품 안에서 보이는 사람이면서 동시에 보는 사람이고, 시스템을 움직이는 입력이면서도 언제든 그 관계를 멈출 수 있는 사람입니다.',
          '감정 단어를 먼저 보여주지 않는 이유는 관객의 언어가 시스템이 제시한 예시를 따라가지 않게 하기 위해서입니다. 설명을 읽고 정답을 수행하는 대신, 몸이 장미와 기계에 닿은 뒤에 말이 오도록 합니다.',
          '자유는 아무 결과도 없는 상태가 아니라 내 선택이 남긴 모양을 다시 볼 수 있는 상태에 가깝습니다. 불편한 내용을 끝까지 견디는 것이 좋은 관람이라는 규칙도 없습니다. 지나가고, 쉬고, 다시 돌아오는 선택 역시 작품의 일부입니다.',
        ],
      }),
      aboutSection({
        id: 'about-ritual',
        index: '06',
        title: '장례식의 순서',
        lead: '명명하고, 개입하고, 목격하고, 마지막에 오늘 지은 이름을 내려놓습니다.',
        body: [
          '첫 번째 작품에서 관객은 다른 사람의 손을 빌려 장미를 만지고 이름을 짓습니다. 두 번째에서는 그 이름을 가진 존재를 직접 살리고 죽이며 자신이 자신을 대하는 방식을 다시 연기합니다. 세 번째에서는 자기 화면을 벗어나 다른 사람들의 장례 속에서 자신의 자리를 찾습니다.',
          '마지막의 “놓아주기”는 이름을 삭제하는 일이 아닙니다. 그 이름을 더 이상 혼자 들고 있지 않겠다고 정하는 일입니다. 장례식이 끝나도 죽인 것은 사라지지 않습니다. 다만 다시 부를 수 있는 이름과, 어느 쪽에 물을 줄지 고를 가능성이 남습니다.',
        ],
        deeper: [
          '이 순서는 치료의 단계나 회복의 정답을 제시하지 않습니다. 작품을 본 뒤 더 나아졌다고 말하도록 요구하지도 않습니다. 의식의 역할은 한 사람 안의 모순을 없애는 것이 아니라, 평소에는 겹쳐 보이지 않던 것들을 같은 시간 안에 놓는 것입니다.',
          '01은 다른 사람의 손을 빌려 자기 안으로 가장 가까이 들어가는 자리입니다. 02는 그 이름을 가진 존재를 직접 살리고 죽이며 자신이 자신을 대하는 방식을 행동으로 반복합니다.',
          '03에서는 자기 내부에서 한 걸음 물러나 세계의 장례들 사이에서 자신의 색과 형체를 목격합니다. 04는 완성된 작품 뒤에서 사라지는 제작의 손과 실패를 이 시신의 기록으로 남깁니다.',
          '마지막 발인은 이름을 삭제하는 일이 아닙니다. 그 이름을 더 이상 혼자 들고 있지 않기로 하는 일입니다. 의식은 모순을 없애지 않고, 서로 겹쳐 보이지 않던 것들을 같은 시간 안에 놓습니다.',
        ],
      }),
      aboutSection({
        id: 'about-work-01',
        index: '07',
        title: '01 명명 / NAMING',
        lead: '혼자서는 소리가 나지 않는 생화 장미 정원입니다.',
        body: [
          '한 사람의 몸은 물에서 시작하고, 다른 사람의 손을 거쳐 장미까지 이어집니다. 서로 다른 몸이 잠시 하나의 회로가 될 때 생화와 기계가 함께 소리를 냅니다. 장미를 오래 쥐거나 여러 송이를 함께 만지면 정원의 반응도 달라집니다.',
          '이 작품에서 관계는 감상해야 할 주제가 아니라 작동 조건입니다. 누군가의 손을 잡지 않으면 자기 장미도 들을 수 없습니다. “나는 혼자 존재할 수 있는가”라는 질문이 설명문이 아니라 끊어지고 이어지는 회로로 나타납니다.',
        ],
        deeper: [
          '관객은 장미의 소리를 들은 뒤 오늘의 이름을 짓습니다. 먼저 미워했던 자기의 한 면을 적고, 그 안의 다른 얼굴을 적은 다음, 둘이 함께 남을 수 있는 하나의 문장을 만듭니다. 명명은 감정을 분류하는 검사가 아니라 서로 밀어내던 두 얼굴을 같은 이름 아래 잠시 두는 행동입니다.',
          '장미마다 어떤 의미가 있는지는 미리 적어두지 않습니다. 의미를 먼저 읽고 맞는 꽃을 고르는 대신, 손의 감각과 소리의 반응이 먼저 오게 합니다.',
          '장면을 남기는 마지막 행동은 메인1이 내민 손과의 악수입니다. 사람과 사람이 손을 이어 회로를 만들었던 몸이, 이번에는 작품의 몸과 직접 손을 맞잡으며 그 순간을 기록합니다.',
          '정원의 회로는 물에서 시작해 사람의 피부와 손을 지나 생화에 닿습니다. 자연과 기계, 나와 타인의 경계가 하나의 신호 안에서 잠시 흐려지고, 반응의 원인을 한 사람에게만 돌릴 수 없게 됩니다.',
          '생화는 전시가 진행되는 동안 실제로 상하고 시듭니다. 관객의 접촉은 흔적 없이 사라지는 입력이 아니라 꽃의 몸에 남는 시간이며, 명명은 그 접촉 뒤에 오는 응답입니다.',
        ],
      }),
      aboutSection({
        id: 'about-work-02',
        index: '08',
        title: '02 개입 / INTERVENTION',
        lead: '01에서 지은 이름을 가진 존재가 화면 안에서 다시 살아납니다.',
        body: [
          '관객은 화면 속 존재를 살리거나 해치는 행동을 반복합니다. 완전히 죽어도 존재는 다시 일어나지만, 이전의 흔적은 지워지지 않습니다. 반복할수록 화면에는 자신이 그 존재를 어떻게 대해왔는지가 쌓입니다.',
          '관객의 몸과 화면 속 장미 인간은 살아 있는 나와 다시 연기되는 나라는 서로 다른 상태로 마주합니다. 관객이 누르는 선택은 화면에만 머물지 않고 다음 리스폰과 흔적에 이어집니다.',
        ],
        deeper: [
          '스크린샷을 남기려면 카메라를 바라보고 두 눈을 2초 동안 감습니다. 화면을 확인하며 포즈를 취하는 대신 잠시 시각을 닫고, 방금 자신이 그 존재를 어떻게 대했는지 몸 안에서 느낀 뒤 장면을 남깁니다.',
          '이 작품에는 승리 화면이 없습니다. 긍정적인 선택만 반복하는 것도 하나의 답이 되지 않습니다. 돌봄과 파괴가 함께 지나간 뒤 그 존재와 어떤 상태로 머무는지가 중요합니다.',
          '물과 햇빛, 독과 괴물은 선과 악의 버튼이 아닙니다. 중요한 것은 어느 선택이 옳은가가 아니라 어떤 행동을 반복하고 언제 바꾸며 서로 다른 행동을 어떻게 섞는가입니다.',
          '관객은 화면 속 존재를 보면서 동시에 카메라 안의 자신을 봅니다. 손가락의 형상 안에 자기 모습이 나타나고, 행동하는 나와 그 행동을 지켜보는 내가 같은 장면에 놓입니다.',
          '죽음은 끝이 되지 않습니다. 존재는 다시 일어나지만 이전 상태로 완전히 복구되지는 않습니다. 돌봄과 손상, 죽음과 재생이 서로를 취소하지 않고 같은 몸에 남습니다.',
        ],
      }),
      aboutSection({
        id: 'about-work-03',
        index: '09',
        title: '03 목격 / WITNESS',
        lead: '다른 사람들의 장례가 흐르는 시간 속에서 자신의 자리를 찾습니다.',
        body: [
          '이전 작품들이 자기 안으로 가까이 들어갔다면, 이 작품은 시선을 바깥으로 돌립니다. 화면을 지나가는 장면은 모두 다른 사람의 장례입니다. 관객은 그 시간을 빨리 소비하지 않고, 일부 장면 앞에서 속도를 늦추며 머뭅니다.',
          '자신의 형체는 정면에서 바로 알아볼 수 없는 왜상으로 나타납니다. 한 자리에서 비스듬히 바라볼 때만 형태가 서기 때문에, 무엇을 보는지는 어디에 서 있는가와 분리되지 않습니다.',
        ],
        deeper: [
          '되감기가 없는 이유는 놓친 것을 벌주기 위해서가 아닙니다. 모든 장면을 확보하고 확인하는 방식 대신, 지나가는 동안 실제로 본 것이 남게 하기 위해서입니다. 찾기는 목적이 아니라 천천히 보게 만드는 도구입니다.',
          '여러 언어의 인공적인 목소리와 한국어 자막은 타인의 기억에 완전히 들어갈 수 없다는 거리를 만듭니다. 충분히 오래 머문 순간에만 자신의 목소리와 가까운 단서가 나타납니다. 애도는 죽은 사람만을 위한 것이 아니라, 남아서 바라보는 사람의 위치를 다시 만드는 일이기도 합니다.',
          '관객은 손의 높이로 시간의 속도를 바꾸고 일부 장면 앞에서 충분히 느려진 채 머뭅니다. 놓친 장면은 다시 소유할 수 없는 지나간 시간으로 남습니다.',
          '왜상은 정면에서 풍경의 일부였던 죽음의 표식이 특정한 각도에서 드러나는 바니타스의 시각 구조를 가져옵니다. 여기서도 관객은 몸의 위치를 바꾸어야 자신의 형체를 볼 수 있습니다.',
          '자기 색을 찾는 일은 특별한 존재가 되는 일이 아니라, 서로 같지 않은 수많은 죽음과 타인의 시간 사이에 자신도 놓여 있음을 알아보는 일입니다.',
        ],
      }),
      aboutSection({
        id: 'about-work-04',
        index: '10',
        title: '04 기록 / RECORD',
        lead: '완성된 작품 뒤에서 사라지는 손과 제작의 시간을 남긴 영상입니다.',
        body: [
          '장미, 해골, 전선, 센서와 컨트롤러가 하나의 몸이 되는 동안의 손을 기록했습니다. 관객이 만나는 완성된 표면만이 아니라, 자르고 잇고 실패하고 다시 연결한 시간을 작품의 일부로 둡니다.',
          '영상에는 반드시 처음부터 봐야 하는 서사가 없습니다. 어느 순간에 들어오고 나가도 됩니다. 다른 작품을 기다리는 동안 보아도 되고, 모든 작품을 지난 뒤 돌아와도 됩니다.',
        ],
        deeper: [
          '제작 기록은 작품을 설명하는 홍보 영상이 아닙니다. 이 시신이 어떤 노동과 반복을 지나 만들어졌는지 보여주는 또 하나의 부검 기록에 가깝습니다. 기계가 매끈한 마술처럼 보이지 않도록 연결부와 손의 흔적을 숨기지 않습니다.',
          '인터랙티브 미디어 작품은 완성되면 기술이 보이지 않는 매끄러운 표면으로 나타나기 쉽습니다. 그러나 그 뒤에는 자르고 잇는 손, 실패한 테스트, 다시 시작된 연결, 사라진 버전과 고장 난 장치의 시간이 있습니다.',
          '이 작품은 그 과정을 숨겨 마술처럼 보이게 하지 않습니다. 기계 역시 몸을 가지고 있고, 그 몸은 수많은 손의 노동과 오류를 통해 만들어집니다.',
          '영상에 정해진 처음과 마지막이 없는 이유도 여기에 있습니다. 제작은 선명한 시작과 완성으로 정리되지 않습니다. 어느 장면에서 들어와도 손은 이미 무언가를 만들고 있고, 어느 순간 떠나도 작업은 다른 곳에서 계속됩니다.',
          '04는 네 번째 성격 점수나 변화 축을 만들지 않습니다. 앞선 세 작품이 생겨난 물질적 시간과 그 시간을 감싸는 기록의 자리입니다.',
        ],
      }),
      aboutSection({
        id: 'about-phone',
        index: '11',
        title: '당신의 장미와 Phone Hub',
        lead: '휴대폰은 작품의 실시간 화면을 복제하지 않고, 흩어진 선택을 한 장미 아래 이어주는 얇은 실입니다.',
        body: [
          '입장에서 고른 색, 01에서 지은 이름, 각 작품에서 직접 남긴 장면이 하나의 장미 번호에 연결됩니다. 작품 앞의 조화 장미에 휴대폰을 대는 행동은 디지털 기록을 시작하는 동시에 전시장 전체에 흩어진 정원을 이어줍니다.',
          'Phone Hub는 관객을 분석한 점수나 성격 유형을 보여주지 않습니다. 중간의 현재 표본도 완성된 해석이 아니라 지금까지의 흔적입니다. 변화는 숫자가 아니라 장미의 모양과 남겨진 장면으로만 보입니다.',
        ],
        deeper: [
          '작품의 원본 상호작용은 각 TouchDesigner 시스템 안에서 처리하고, 휴대폰에는 필요한 결과만 전달합니다. 네트워크가 잠시 끊겨도 작품이 멈추지 않게 하고, 관객이 기술 상태를 감시하느라 작품에서 눈을 떼지 않게 하기 위한 구조입니다.',
          '당신의 장미 번호는 실명 대신 오늘의 선택들을 다시 찾기 위한 표식입니다. 번호의 목적은 사람을 식별하는 것이 아니라, 떨어져 있는 장면들이 누구의 장미에 돌아가야 하는지 알려주는 것입니다.',
          'Phone Hub는 작품의 실시간 화면을 복제하지 않습니다. 각 작품이 실제로 필요로 하는 최소한의 정보만 제때 연결하고, 나머지 행동 기록은 작품의 흐름을 방해하지 않도록 묶어서 저장합니다.',
          '현재의 장미는 완성된 초상이 아닙니다. 색, 이름, 방문한 순서와 작품에서 남겨진 흔적이 그 순간 잠시 겹쳐 보이는 표본이며, 관객이 다음 행동을 하면 다시 달라질 수 있습니다.',
          '세션이 끝나면 휴대폰에서는 해당 관람의 연결을 종료합니다. 수집된 기록은 다른 관객에게 공개되지 않으며, 개인을 식별하지 않는 내부 연구와 작품 개선의 자료로만 다룹니다.',
        ],
      }),
      aboutSection({
        id: 'about-position',
        index: '12',
        title: '관객을 대하는 작가의 위치',
        lead: '이 작품은 관객의 고통을 대신 해석하거나, 고백을 더 많이 끌어내는 것을 목표로 하지 않습니다.',
        body: [
          '작가는 관객에게 어떤 감정을 느껴야 하는지 말하지 않습니다. 불편함을 끝까지 견디라고 요구하지도 않습니다. 작품이 제안하는 것은 정답이 아니라 선택할 수 있는 조건입니다. 가까이 갈지, 손을 잡을지, 살릴지, 죽일지, 머물지, 이름을 남길지 관객이 정합니다.',
          '동시에 모든 선택이 가볍게 사라지지는 않습니다. 한 작품에서 한 행동이 다음 작품의 색과 이름, 화면과 위치에 이어집니다. 자유는 아무 결과도 없는 상태가 아니라, 자신의 선택이 남긴 모양을 다시 볼 수 있는 상태에 가깝습니다.',
        ],
        deeper: [
          '이 장례식은 치료를 약속하지 않습니다. 자기혐오가 사라졌다고 선언하지도 않습니다. 다만 미워했던 면과 그 안의 다른 얼굴을 동시에 바라볼 수 있는 짧은 시간을 만들고자 합니다.',
          '모순은 없어지지 않아도, 어느 쪽에 물을 줄지는 고를 수 있습니다. 이 문장은 작품이 관객에게 주는 결론이 아니라, 전시장을 나간 뒤에도 다시 선택할 수 있도록 남겨두는 질문입니다.',
          '인터랙션은 무엇을 느껴야 하는지 명령하기 위한 장치가 아니라 자기 선택을 자기 눈앞에 돌려놓기 위한 구조입니다. 오늘의 이름은 작품이 부여하는 진단이 아니며, 관객이 원하지 않으면 기록 없이 입장할 수도 있습니다.',
          '선택권은 작품의 책임을 관객에게 떠넘기기 위한 말이 아닙니다. 죽음, 애도, 자기혐오를 다루는 만큼 화면은 강요보다 예고를, 평가보다 복구 가능한 선택을 먼저 제공합니다.',
          '기술이 실패하더라도 작품을 계속 볼 수 있는 경로를 남기고, 남겨진 데이터보다 관객의 경험을 우선합니다. 관객은 정답을 찾는 사람이 아니라 서로 모순되는 자기 모습을 같은 시간 안에 둘 수 있는지 시험하는 사람입니다.',
        ],
      }),
      el('footer', { class: 'about-page-end' },
        el('span', { class: 'micro-label' }, 'ARTIST / MINNIE PARK'),
        el('p', {}, tr('Minnie Park은 인간, 자연, 기계 사이에서 감정이 어떻게 물질과 행동으로 번역되는지 탐구하는 인터랙티브 미디어 아티스트입니다.', 'Minnie Park is an interactive media artist.')),
        el('p', {}, tr('생화, 해골, 전선, 센서, 실시간 이미지와 관객의 몸을 연결해 한 사람이 혼자서는 완성할 수 없는 장면을 만듭니다.', 'Her work connects organic matter, machines, real-time images, and the audience body.')),
        el('a', { class: 'text-button', href: ARTIST_INSTAGRAM_URL, target: '_blank', rel: 'noopener noreferrer' }, tr('작가에게 메시지 보내기', 'MESSAGE THE ARTIST'), el('span', { 'aria-hidden': 'true' }, '↗')),
        textButton('HOME', screenHome),
        textButton(tr('장미 메뉴를 엽니다', 'OPEN ROSE MENU'), openRoseMenu),
      ),
    ),
  ]);

  startPageRead('about_project');

  if (initialSection) {
    requestAnimationFrame(() => scrollToAboutSection(initialSection, false));
  }
}

const MODULES = {
  '01': {
    en: 'NAMING', ko: '명명', phaseKo: '명명', visual: 'naming',
    essentialKo: '다른 사람과 손을 이어 장미를 만집니다. 혼자 고른 장미가 아니라, 잠시 함께 만든 회로 안에서 들린 장미를 기억해주세요. 마지막에는 작품이 내민 손과 악수해 이 장면을 남깁니다.',
    essentialEn: 'Place one hand in the water and hold the person beside you. Touch the roses with your free hand to make today\'s resonance.',
    helpKo: '물에서 시작해 사람의 손을 지나 장미까지 하나의 회로를 만듭니다.',
    helpEn: 'Make a chain of hands from the water to the roses. Touch a rose while connected to activate sound and light.',
    helpDetailKo: ['한 사람이 물에 한 손을 담급니다.', '남은 손으로 옆 사람의 손을 잡습니다. 여러 명이면 같은 방식으로 손을 이어갑니다.', '사슬 끝에 선 사람이 남은 손으로 장미를 만집니다. 짧게 스치거나 오래 쥐고, 여러 송이를 함께 잡아도 됩니다.', '작품이 손을 내밀면 악수합니다. 손을 맞잡은 순간의 장면이 당신의 장미에 남습니다.', '장미를 지난 뒤 오늘의 이름을 짓습니다.'],
    helpDetailEn: ['One person begins with one hand in the water.', 'Hold hands in a chain until the final person reaches the roses.', 'The last person touches the roses with their free hand. A brief touch or a long hold both work.', 'If the chain breaks, the sound stops. Reconnect your hands to continue.', 'When the work offers a hand, shake it to leave the scene. The circuit cannot close alone.'],
    troubleshootKo: ['소리가 나지 않으면 물에서 장미까지 손이 이어져 있는지 확인해주세요. 손과 손이 끊어지면 회로와 소리도 멈춥니다.', '손을 다시 잡은 뒤 장미를 만져주세요. 손이 젖었다면 장비를 만지기 전에 닦아주세요.', '악수 뒤 장면이 보이지 않아도 작품은 계속 진행할 수 있습니다. 잠시 뒤 다시 확인하거나 스태프에게 말씀해주세요.'],
    aboutKo: '생화와 기계가 한 정원 안에 연결되어 있습니다. 장미는 손이 닿는 동안 소리를 얻지만, 그 소리는 혼자서는 나지 않습니다. 누군가 물에 손을 담그고 서로의 손을 이을 때 여러 몸이 잠시 하나의 회로가 됩니다. 여기서 손이 머문 장미들은 뒤이어 지을 오늘의 이름에 먼저 닿은 재료가 됩니다.',
    aboutEn: 'As different bodies become one circuit, the combination of roses becomes material for one emotional name.',
    aboutDetailKo: ['이 정원에서 관계는 감상해야 할 주제가 아니라 작동 조건입니다. 누군가의 손을 잡지 않으면 자기 앞의 장미도 들을 수 없습니다. “나는 혼자 존재할 수 있는가”라는 질문이 설명문이 아니라 끊어지고 이어지는 회로로 나타납니다.', '회로는 물에서 시작해 사람의 피부와 손을 지나 생화에 닿습니다. 자연과 기계, 나와 타인의 경계는 하나의 신호 안에서 잠시 흐려집니다. 누가 시작했고 누가 반응을 만들었는지 한 사람에게만 돌릴 수 없습니다.', '장미마다 정해진 감정 단어는 없습니다. 의미를 먼저 읽고 자신에게 맞는 꽃을 고르는 대신, 손의 감각과 소리의 반응이 말보다 먼저 오게 합니다.', '생화는 전시가 진행되는 동안 실제로 상하고 시듭니다. 관객의 접촉은 흔적 없이 사라지는 입력이 아니라 꽃의 몸에 남는 시간입니다.', '여러 송이를 함께 잡거나 오래 머무는 행동은 좋은 선택과 나쁜 선택으로 환산되지 않습니다. 그 조합은 점수로 돌아오지 않고, 이후 자기 언어로 이름을 지을 때 다시 떠올릴 감각으로 남습니다.', '마지막에 작품이 내민 손과 악수하면 한 장면이 남습니다. 처음에는 다른 사람의 손을 빌려 회로를 만들었다면, 끝에서는 작품의 몸과 직접 손을 맞잡습니다.'],
  },
  '02': {
    en: 'INTERVENTION', ko: '개입', phaseKo: '개입', visual: 'reenactment',
    essentialKo: '컨트롤러로 화면 속 존재에게 개입합니다. 돌보고, 해치고, 다시 일어나는 모습을 지켜보세요. 한 방향만 반복할 필요는 없습니다. 마지막에는 카메라를 바라보고 두 눈을 감아 장면을 남깁니다.',
    essentialEn: 'Open your hand toward the screen. Follow the hand and mask, then close both eyes for two seconds to be recorded.',
    helpKo: '버튼마다 화면 속 존재에게 다른 변화가 일어납니다. 화면의 반응을 보며 행동을 고릅니다.',
    helpEn: 'Use the controller buttons to intervene in the figure. When the hand and mask appear, face the camera and close both eyes to leave a scene.',
    helpDetailKo: ['컨트롤러의 버튼을 눌러봅니다. 버튼마다 화면 속 존재에게 다른 변화가 일어납니다.', '화면의 반응을 보며 서로 다른 행동을 시도합니다. 무엇이 살리고 무엇이 해치는지는 직접 발견합니다.', '손 전체와 얼굴이 카메라 화면에 들어오도록 한 걸음 물러섭니다.', '화면에 손과 마스크가 나타나면 카메라를 바라봅니다.', '두 눈을 약 2초 동안 감습니다. 눈을 감은 순간의 장면이 당신의 장미에 남습니다.'],
    helpDetailEn: ['Each controller button makes a different change. Discover what it protects or harms by watching the response.', 'You do not need to repeat only one kind of action. Notice what remains when different actions are mixed.', 'Step back until your full hand and face are visible to the camera.', 'When the hand and mask appear, face the camera and close both eyes for about two seconds. That moment is recorded.'],
    troubleshootKo: ['버튼을 눌러도 반응이 없으면 컨트롤러의 전원이 켜져 있는지 확인해주세요.', '손과 마스크가 보이지 않으면 손 전체와 얼굴이 화면 안에 들어오도록 한 걸음 물러섭니다.', '스크린샷이 남지 않으면 카메라를 정면으로 바라보고 두 눈을 완전히 감은 채 약 2초간 기다립니다.', '계속 작동하지 않으면 스태프에게 말씀해주세요.'],
    aboutKo: '01에서 지은 이름을 가진 존재가 화면 안에서 다시 살아납니다. 당신은 그 존재를 돌보거나 해칠 수 있습니다. 완전히 죽어도 다시 일어나지만 이전의 흔적은 지워지지 않습니다. 여기에는 승리도 패배도 없습니다. 남는 것은 그 존재를 대했던 방식입니다.',
    aboutEn: 'This scene does not restore a lost emotion exactly. It leaves another form by performing it again with the body.',
    aboutDetailKo: ['이 작품에서 관객은 관찰자가 아니라 개입하는 사람입니다. 화면 속 존재는 01에서 관객이 지은 이름을 받아 나타나고, 관객의 손은 그 존재를 살리거나 죽이는 사건을 만듭니다.', '물과 햇빛, 독과 괴물은 선과 악의 버튼이 아닙니다. 중요한 것은 어느 선택이 정답인가가 아니라 어떤 행동을 반복하고, 언제 바꾸며, 서로 다른 행동을 어떻게 섞는가입니다.', '죽음은 끝이 되지 않습니다. 존재는 다시 일어나지만 이전 상태로 완전히 복구되지는 않습니다. 돌봄과 손상, 죽음과 재생이 서로를 취소하지 않고 같은 몸에 남습니다.', '관객은 화면 속 존재를 보면서 동시에 카메라 안의 자신을 보게 됩니다. 손가락의 형상 안에 자신의 모습이 나타나고, 행동하는 나와 그 행동을 지켜보는 내가 같은 장면에 놓입니다.', '두 눈을 감는 행위는 정답을 찾았다는 신호가 아닙니다. 화면을 확인하며 포즈를 고르는 대신 잠시 시각을 닫고, 방금 자신이 그 존재를 어떻게 대해왔는지 몸 안에서 지나가게 합니다.', '그 순간 생성된 스크린샷은 결과 인증 사진이 아닙니다. 내가 이름 붙인 존재에게 무엇을 했고, 그 행위를 바라보는 나는 어떤 모습이었는지를 함께 남긴 장면입니다.'],
  },
  '03': {
    en: 'WITNESS', ko: '목격', phaseKo: '목격', visual: 'mourning',
    essentialKo: '흰 장미 위에 손을 올려 흐르는 시간을 늦춥니다. 가장 느린 시간에 머문 뒤 화면을 비스듬히 바라보며 자신의 장미 색을 찾습니다. 찾은 자리에서 흰 장미를 눌러 그 순간을 남깁니다.',
    essentialEn: 'Place your hand above the flower. Move time with its height and slowly find your color inside the passing images.',
    helpKo: '손의 높이로 시간을 늦추고, 몸의 위치를 바꾸어 정면에서는 보이지 않는 자신의 형체를 찾습니다.',
    helpEn: 'Slow time by holding your hand over the white rose, then look from an angle to find your color.',
    helpDetailKo: ['흰 장미 위에 손을 올립니다. 손이 가까워질수록 화면의 시간이 느려집니다.', '가장 느린 시간에 약 3초 동안 머뭅니다. 짧은 소리가 나면 손을 떼어도 느려진 시간이 유지됩니다.', '화면 앞에서 몸을 옆으로 옮기며 비스듬히 바라봅니다. 정면에서는 보이지 않던 형체와 자신의 장미 색을 찾습니다.', '찾았다고 생각되는 자리에서 흰 장미를 누릅니다.', '지나간 영상은 되감기지 않습니다. 놓친 장면도 이곳을 지나온 시간의 일부로 남습니다.'],
    helpDetailEn: ['Bring your hand close to the white rose to slow the image.', 'Stay at the slowest speed for about three seconds to hear a short sound. The slowed speed remains briefly after you remove your hand.', 'A form invisible from the front appears when you look at the screen from an angle. Find your rose color slowly.', 'Press the white rose where you find it. The video does not rewind; a missed scene remains part of the passing time.'],
    troubleshootKo: ['시간이 느려지지 않으면 손을 장미 위에서 완전히 뺐다가 다시 가져와주세요.', '가장 느린 속도에서 약 3초 머물면 짧은 소리가 납니다. 소리가 난 뒤에는 손을 떼고 화면을 비스듬히 볼 수 있습니다.', '형체가 보이지 않으면 화면 정면에만 서 있지 말고 좌우로 천천히 움직이며 바라보는 각도를 바꿔주세요.', '흰 장미를 눌러도 반응하지 않으면 조금 더 머물며 다음 장면을 바라봐주세요.'],
    aboutKo: '다른 사람들의 장례가 흐르는 시간 속에서 자신의 자리를 찾습니다. 손을 가까이 가져갈수록 시간은 느려지고, 오래 바라본 장면과 처음 고른 장미의 색이 당신이 나타날 자리를 정합니다. 찾기는 목적이 아니라 지나가는 것을 천천히 보게 만드는 방법입니다.',
    aboutEn: 'Here, mourning is not a still scene but finding your trace again among other people\'s time.',
    aboutDetailKo: ['01과 02가 자기 안으로 가까이 들어가는 작품이었다면, 03은 한 걸음 물러나 세계 속에서 자신을 바라보는 자리입니다. 화면을 지나가는 장면은 서로 다른 문화와 장소에 존재하는 장례의 이미지입니다.', '관객은 영상을 자유롭게 되감거나 목록처럼 훑을 수 없습니다. 손의 높이로 시간의 속도를 바꾸고, 일부 장면 앞에서 충분히 느려진 채 머뭅니다. 놓친 장면은 다시 소유할 수 없는 지나간 시간으로 남습니다.', '자신의 형체는 정면에서 알아보기 어려운 왜상으로 나타납니다. 한 자리에서 비스듬히 바라볼 때만 형태가 서기 때문에, 무엇을 보는지는 어디에 서 있는가와 분리되지 않습니다.', '왜상은 바니타스의 계보 안에서 죽음을 숨겨두었던 시각 장치를 가져옵니다. 정면에서는 풍경의 일부였던 형상이 몸을 옮겨 특정한 각도에 섰을 때 드러나듯, 여기서도 관객은 자기 위치를 바꾸어야 자신을 볼 수 있습니다.', '여러 언어의 목소리와 한국어 자막은 타인의 기억에 완전히 들어갈 수 없다는 거리를 남깁니다. 관객은 세계의 죽음을 모두 자기 이야기로 소유하지 않은 채 바라봅니다.', '애도는 죽은 사람만을 위한 일이 아닙니다. 남아서 바라보는 사람이 자신의 위치를 다시 만드는 일이기도 합니다. 자기 색을 찾는 일은 특별한 존재가 되는 일이 아니라 수많은 타인 사이에 자신도 놓여 있음을 알아보는 일입니다.'],
  },
  '04': {
    en: 'RECORD', ko: '기록', phaseKo: '기록', visual: 'archive',
    essentialKo: '헤드폰을 쓰고 원하는 만큼 머뭅니다. 영상에는 반드시 처음부터 보아야 하는 서사가 없습니다. 어느 장면에서 들어와도 되고, 한 장면만 본 뒤 나가도 됩니다.',
    essentialEn: 'Look slowly through the scenes and specimen records left behind.',
    helpKo: '정해진 시작과 끝 없이 제작의 장면 사이에 머뭅니다.',
    helpEn: 'Put on the headphones and watch from any point for as long as you wish. Touch your phone to the rose to connect this stay.',
    helpDetailKo: ['준비된 티슈로 헤드폰을 닦습니다.', '헤드폰을 쓰고 편한 자리에서 영상을 봅니다.', '원하는 장면만 보거나 오래 머물러도 됩니다.', '관람을 마친 뒤 헤드폰을 다시 닦아 제자리에 둡니다.', '휴대폰을 연결하지 않아도 영상을 볼 수 있습니다. 장미에 휴대폰을 대면 머문 시간이 당신의 장미 번호에 남습니다.'],
    helpDetailEn: ['Put on the headphones and sit or stand where you can watch comfortably. Please use the supplied tissue before and after use.', 'The film has no fixed beginning or ending. You may enter at any scene and leave at any time.', 'To connect this visit to your rose number, hold your phone to the rose on the sign or scan the QR. The film can also be watched without connecting your phone.'],
    troubleshootKo: ['소리가 들리지 않으면 헤드폰이 끝까지 연결되어 있는지 확인해주세요. 음량은 준비된 조절 장치에서 천천히 올려주세요.', '영상에는 정해진 시작 화면이 없습니다. 중간 장면처럼 보여도 정상입니다.', '계속 소리가 들리지 않으면 스태프에게 말씀해주세요.'],
    aboutKo: '완성된 작품 뒤에서 사라지는 손과 제작의 시간을 남긴 영상입니다. 장미, 해골, 전선과 센서가 하나의 몸이 되는 동안의 절단과 연결, 실패와 반복을 기록했습니다. 완성된 표면뿐 아니라 그 표면을 만들고 사라진 시간도 이 장례의 일부입니다.',
    aboutEn: 'ARCHIVE is not a fourth distortion axis. It is the documentary frame around the other traces.',
    aboutDetailKo: ['제작 기록은 다른 작품을 설명하는 부록이나 홍보 영상이 아닙니다. 이 시신이 어떤 노동과 반복을 지나 만들어졌는지를 보여주는 또 하나의 부검 기록에 가깝습니다.', '인터랙티브 미디어 작품은 완성되면 기술이 보이지 않는 매끄러운 표면으로 나타나기 쉽습니다. 그러나 그 뒤에는 자르고 잇는 손, 실패한 테스트, 다시 시작된 연결, 사라진 버전과 고장 난 장치의 시간이 있습니다.', '이 작품은 그 과정을 숨겨 마술처럼 보이게 하지 않습니다. 기계 역시 몸을 가지고 있고, 그 몸은 수많은 손의 노동과 오류를 통해 만들어집니다.', '장미와 해골, 센서와 케이블은 각각 독립된 재료였다가 전시가 시작되는 순간 하나의 작동하는 시신이 됩니다. 관객이 만나는 것은 완제품이 아니라 계속 유지되고 다시 연결되어야 하는 임시적인 몸입니다.', '영상에 정해진 처음과 마지막이 없는 이유도 여기에 있습니다. 제작은 선명한 시작과 완성으로 정리되지 않습니다. 어느 장면에서 들어와도 손은 이미 무언가를 만들고 있고, 어느 순간 떠나도 작업은 다른 곳에서 계속됩니다.', '04는 네 번째 성격 점수나 변화 축을 만들지 않습니다. 앞선 세 작품이 생겨난 물질적 시간과 그 시간을 감싸는 기록의 자리입니다.'],
  },
};

const ROSE_PATTERN_IDS = ['01', '02', '03', '04'];

function rosePatternSvg(stationId) {
  const roseCore = `
    <g class="pattern-rose-core">
      <ellipse cx="60" cy="42" rx="10" ry="22" />
      <ellipse cx="60" cy="42" rx="10" ry="22" transform="rotate(60 60 60)" />
      <ellipse cx="60" cy="42" rx="10" ry="22" transform="rotate(120 60 60)" />
      <ellipse cx="60" cy="78" rx="10" ry="22" />
      <ellipse cx="60" cy="78" rx="10" ry="22" transform="rotate(60 60 60)" />
      <ellipse cx="60" cy="78" rx="10" ry="22" transform="rotate(120 60 60)" />
      <circle cx="60" cy="60" r="7" />
      <circle cx="60" cy="60" r="2.5" class="pattern-solid" />
    </g>`;
  const structures = {
    '01': `
      <g class="pattern-structure pattern-structure-naming">
        <path d="M37 19 C19 29 13 46 16 65 C18 80 27 92 40 100" />
        <path d="M83 19 C101 29 107 46 104 65 C102 80 93 92 80 100" />
        <path d="M52 13 L52 27 M68 13 L68 27 M52 93 L52 107 M68 93 L68 107" />
      </g>`,
    '02': `
      <g class="pattern-structure pattern-structure-intervention">
        <path d="M18 99 L102 21" />
        <path d="M30 88 L25 76 M43 76 L34 72 M76 45 L86 48 M89 33 L95 44" />
        <circle cx="60" cy="60" r="31" stroke-dasharray="3 7" />
      </g>`,
    '03': `
      <g class="pattern-structure pattern-structure-witness">
        <ellipse cx="60" cy="60" rx="50" ry="30" transform="rotate(-18 60 60)" />
        <ellipse cx="60" cy="60" rx="42" ry="48" stroke-dasharray="2 9" />
        <circle cx="105" cy="43" r="4" class="pattern-solid pattern-orbit-point" />
      </g>`,
    '04': `
      <g class="pattern-structure pattern-structure-record">
        <path d="M15 39 V15 H39 M81 15 H105 V39 M105 81 V105 H81 M39 105 H15 V81" />
        <path d="M25 31 H46 M74 31 H95 M25 89 H46 M74 89 H95" stroke-dasharray="2 5" />
        <path d="M14 60 H106" class="pattern-scan-axis" />
      </g>`,
  };
  return `<svg viewBox="0 0 120 120" role="img" aria-hidden="true" focusable="false">
    ${roseCore}${structures[stationId] || structures['01']}
  </svg>`;
}

function stablePatternOrder(sessionId, stationId) {
  const seed = `${sessionId || 'local'}:${stationId}`
    .split('')
    .reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const offset = seed % ROSE_PATTERN_IDS.length;
  const rotated = [
    ...ROSE_PATTERN_IDS.slice(offset),
    ...ROSE_PATTERN_IDS.slice(0, offset),
  ];
  return seed % 2 ? rotated.reverse() : rotated;
}

const PATTERN_ANIMATION_MOTION = {
  '01': { code: 'JOIN / NAME', finalKo: '당신의 장미를 명명에 잇습니다', finalEn: 'JOINING YOUR ROSE TO NAMING' },
  '02': { code: 'ACT / ALTER', finalKo: '당신의 장미를 개입에 들여보냅니다', finalEn: 'ENTERING YOUR ROSE INTO INTERVENTION' },
  '03': { code: 'SHIFT / WITNESS', finalKo: '당신의 장미를 목격의 시간에 놓습니다', finalEn: 'PLACING YOUR ROSE IN WITNESS' },
  '04': { code: 'SCAN / RECORD', finalKo: '당신의 장미를 기록에 남깁니다', finalEn: 'INSCRIBING YOUR ROSE INTO RECORD' },
};

function patternAnimationStage(stationId, { compact = false } = {}) {
  const module = MODULES[stationId];
  const motion = PATTERN_ANIMATION_MOTION[stationId];
  return el('div', {
    class: `pattern-animation-stage${compact ? ' is-compact' : ''}`,
    'data-station': stationId,
    'aria-label': tr(`${module.ko} 입장 애니메이션 미리보기`, `${module.en} entry animation preview`),
  },
    el('span', { class: 'pattern-animation-index' }, `${stationId} / ${module.en}`),
    el('span', { class: 'pattern-animation-coordinate coordinate-top' }, motion.code),
    el('div', { class: 'pattern-animation-field', 'aria-hidden': 'true' },
      el('span', { class: 'pattern-animation-guide guide-a' }),
      el('span', { class: 'pattern-animation-guide guide-b' }),
      el('div', { class: 'pattern-animation-symbol', html: rosePatternSvg(stationId) }),
      el('div', { class: 'pattern-animation-specimen' },
        roseSpecimenImage('', 'pattern-animation-specimen-image', compact
          ? ROSE_SPECIMEN_ANIMATION_COMPACT_IMAGE
          : ROSE_SPECIMEN_ANIMATION_IMAGE),
        el('i', { class: 'pattern-animation-tint' }),
        el('i', { class: 'pattern-animation-scan' }),
      ),
      el('span', { class: 'pattern-animation-dot dot-a' }),
      el('span', { class: 'pattern-animation-dot dot-b' }),
      el('span', { class: 'pattern-animation-dot dot-c' }),
    ),
    el('div', { class: 'pattern-animation-copy', 'aria-live': 'polite' },
      el('span', { class: 'pattern-animation-copy-step step-a' }, tr(
        `${module.ko}의 장미가 확인되었습니다`,
        `THE ROSE OF ${module.en} IS CONFIRMED`,
      )),
      el('span', { class: 'pattern-animation-copy-step step-b' }, tr(
        motion.finalKo,
        motion.finalEn,
      )),
    ),
  );
}

const patternAnimationRuns = new WeakMap();

async function decodePatternAnimationImage(stage) {
  const image = stage.querySelector('.pattern-animation-specimen-image');
  try {
    if (image && !image.complete) {
      await new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }
    if (image?.decode) await image.decode();
  } catch {
    // The existing image fallback will be used. Animation still remains usable.
  }
}

async function replayPatternAnimations(inputStages) {
  const stages = inputStages.filter((stage) => stage?.isConnected);
  if (!stages.length) return;
  const runIds = new Map();

  stages.forEach((stage) => {
    const runId = (patternAnimationRuns.get(stage) || 0) + 1;
    patternAnimationRuns.set(stage, runId);
    runIds.set(stage, runId);
    stage.classList.remove('is-playing');
    stage.classList.add('is-preparing');
  });

  await Promise.all(stages.map(decodePatternAnimationImage));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  stages.forEach((stage) => {
    if (patternAnimationRuns.get(stage) !== runIds.get(stage) || !stage.isConnected) return;
    stage.classList.remove('is-preparing');
    stage.classList.add('is-playing');
  });
}

function replayPatternAnimation(stage) {
  return replayPatternAnimations([stage]);
}

function patternAnimationComparisonCard(stationId, stage) {
  const module = MODULES[stationId];
  return el('article', { class: 'pattern-animation-comparison-card' },
    stage,
    el('button', {
      class: 'pattern-animation-card-replay',
      type: 'button',
      onclick: () => replayPatternAnimation(stage),
    }, `${stationId} / ${tr(module.ko, module.en)} / ${tr('다시 보기', 'REPLAY')}`),
  );
}

function screenPatternAnimationPreview(stationId = 'all') {
  const comparisonMode = stationId === 'all';
  const safeStationId = comparisonMode || MODULES[stationId] ? stationId : '01';
  if (comparisonMode) {
    rememberView('pattern-animation', { stationId: 'all' });
    const stages = ROSE_PATTERN_IDS.map((id) => patternAnimationStage(id, { compact: true }));
    render([
      el('header', { class: 'global-header pattern-preview-header' },
        el('div', { class: 'wordmark', 'aria-label': 'META ROSE 2026' },
          el('span', {}, 'META ROSE'),
          el('span', {}, '2026'),
        ),
        el('span', { class: 'micro-label' }, 'ANIMATION STUDY / V2'),
      ),
      el('section', { class: 'screen pattern-animation-preview pattern-animation-comparison' },
        el('span', { class: 'micro-label' }, 'FOUR ENTRY TRANSITIONS / PREVIEW'),
        el('h1', {}, tr('네 개의 입장 동작', 'FOUR ROSE TRANSITIONS')),
        el('p', { class: 'pattern-animation-preview-note' }, tr(
          '각 장미는 작품의 행위를 따라 서로 다른 방식으로 열립니다. 이 화면은 애니메이션만 보여주며 작품이나 TD에는 연결되지 않습니다.',
          'EACH ROSE OPENS THROUGH THE ACTION OF ITS WORK. THIS PREVIEW DOES NOT CONNECT TO THE INSTALLATION.',
        )),
        el('div', { class: 'pattern-animation-comparison-grid' },
          ...ROSE_PATTERN_IDS.map((id, index) => patternAnimationComparisonCard(id, stages[index])),
        ),
        el('button', {
          class: 'primary-button pattern-animation-replay',
          type: 'button',
          onclick: () => replayPatternAnimations(stages),
        }, tr('네 개 다시 보기', 'REPLAY ALL FOUR')),
      ),
    ]);
    requestAnimationFrame(() => replayPatternAnimations(stages));
    return;
  }

  const module = MODULES[safeStationId];
  rememberView('pattern-animation', { stationId: safeStationId });
  const stage = patternAnimationStage(safeStationId);

  render([
    el('header', { class: 'global-header pattern-preview-header' },
      el('div', { class: 'wordmark', 'aria-label': 'META ROSE 2026' },
        el('span', {}, 'META ROSE'),
        el('span', {}, '2026'),
      ),
      el('span', { class: 'micro-label' }, 'ANIMATION STUDY / V2'),
    ),
    el('section', { class: 'screen pattern-animation-preview' },
      el('span', { class: 'micro-label' }, 'ENTRY TRANSITION / PREVIEW'),
      el('h1', {}, tr('장미 연결 동작', 'ROSE CONNECTION STUDY')),
      el('p', { class: 'pattern-animation-preview-note' }, tr(
        '이 화면은 애니메이션만 보여줍니다. 작품이나 TD에는 연결되지 않습니다.',
        'THIS PREVIEW SHOWS ONLY THE ANIMATION. IT DOES NOT CONNECT TO THE INSTALLATION.',
      )),
      stage,
      el('button', {
        class: 'primary-button pattern-animation-replay',
        type: 'button',
        onclick: () => replayPatternAnimation(stage),
      }, tr('다시 보기', 'REPLAY')),
      el('button', {
        class: 'text-button pattern-animation-return',
        type: 'button',
        onclick: () => {
          const target = new URL(location.href);
          target.searchParams.set('test', '1');
          target.searchParams.set('preview', `pattern-${safeStationId}`);
          location.href = target.toString();
        },
      }, tr(`${module.ko} 화면으로`, `BACK TO ${module.en}`)),
    ),
  ]);
  requestAnimationFrame(() => replayPatternAnimation(stage));
}

function patternEntryFeedback(stationId, entryStatus = null) {
  const module = MODULES[stationId];
  if (!entryStatus || entryStatus.stationId !== stationId) return '';
  if (entryStatus.code === 'busy') {
    return tr(
      `지금 다른 장미가 ${module.ko}과 연결되어 있습니다. 잠시 후 다시 시도해주세요.`,
      `ANOTHER ROSE IS CONNECTED TO ${module.en}. PLEASE TRY AGAIN SHORTLY.`,
    );
  }
  if (entryStatus.code === 'setup_required') {
    return tr(
      '패턴 연결 준비가 아직 완료되지 않았습니다. 안내판의 NFC 또는 QR을 이용해주세요.',
      'PATTERN ENTRY IS NOT READY YET. PLEASE USE THE NFC OR QR ON THE SIGN.',
    );
  }
  if (entryStatus.code === 'lease_lost') {
    return tr(
      '연결 시간이 끝났습니다. 작품 앞에서 장미를 다시 선택해주세요.',
      'THE CONNECTION HAS ENDED. SELECT THE ROSE AGAIN AT THE WORK.',
    );
  }
  if (['connection_error', 'readback_failed', 'session_unavailable',
    'previous_close_failed', 'claim_rejected', 'invalid_session',
    'conflict'].includes(entryStatus.code)) {
    return tr(
      '연결을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 선택해주세요.',
      'THE CONNECTION COULD NOT BE CONFIRMED. CHECK THE NETWORK AND TRY AGAIN.',
    );
  }
  return '';
}

async function playPatternSuccessTransition(panel, button, stationId) {
  // Phase 1 deliberately stays light: the contract and DOM hook are fixed,
  // while the full Rose Specimen colour-overlay animation can be added here
  // later without touching station claiming, TD, or the pattern choices.
  panel.dataset.state = 'matched';
  panel.dataset.matchedStation = stationId;
  button.classList.add('is-matched');
  await new Promise((resolve) => setTimeout(resolve, 260));
  panel.dataset.state = 'connecting';
}

function patternEntryPanel(stationId, entryStatus = null) {
  const module = MODULES[stationId];
  const session = ensureSession();
  const feedback = el('p', {
    class: `pattern-entry-feedback${entryStatus?.code === 'busy' ? ' is-busy' : ''}`,
    'aria-live': 'polite',
  }, patternEntryFeedback(stationId, entryStatus));
  const panel = el('section', {
    class: 'pattern-entry',
    'data-station': stationId,
  },
    el('span', { class: 'micro-label' }, 'ROSE PATTERN / ENTRY'),
    el('h2', {}, tr(
      `${module.ko}의 장미를 선택해주세요`,
      `SELECT THE ROSE OF ${module.en}`,
    )),
    el('p', { class: 'pattern-entry-instruction' }, tr(
      '작품 앞에서 마주한 장미와 같은 패턴을 선택해주세요.',
      'SELECT THE PATTERN THAT MATCHES THE ROSE BEFORE YOU.',
    )),
    el('div', { class: 'pattern-choice-grid' },
      ...stablePatternOrder(session.id, stationId).map((patternId, index) => {
        const button = el('button', {
          class: 'rose-pattern-button',
          type: 'button',
          'data-pattern': patternId,
          'aria-label': tr(`장미 패턴 ${index + 1}`, `Rose pattern ${index + 1}`),
          onclick: async () => {
            if (panel.dataset.state === 'connecting') return;
            logEvent('station_pattern_selected', {
              expected_pattern: stationId,
              selected_pattern: patternId,
              matched: patternId === stationId,
            }, stationId);
            if (patternId !== stationId) {
              button.classList.remove('is-mismatch');
              void button.offsetWidth;
              button.classList.add('is-mismatch');
              feedback.classList.remove('is-busy');
              feedback.textContent = tr(
                `${module.ko}의 장미를 다시 확인해주세요.`,
                `CHECK THE ROSE OF ${module.en} AGAIN.`,
              );
              setTimeout(() => button.classList.remove('is-mismatch'), 520);
              return;
            }

            panel.dataset.state = 'connecting';
            button.classList.add('is-selected');
            panel.querySelectorAll('.rose-pattern-button').forEach((candidate) => {
              candidate.disabled = true;
              if (candidate !== button) candidate.classList.add('is-dimmed');
            });
            feedback.classList.remove('is-busy');
            feedback.textContent = tr(
              `당신의 장미를 ${module.ko}에 연결하고 있습니다.`,
              `CONNECTING YOUR ROSE TO ${module.en}.`,
            );
            await playPatternSuccessTransition(panel, button, stationId);
            await screenModule(stationId, { enter: true, via: 'pattern' });
          },
        }, el('span', {
          class: 'rose-pattern-graphic',
          html: rosePatternSvg(patternId),
        }));
        return button;
      }),
    ),
    feedback,
    el('p', { class: 'pattern-entry-fallback' }, tr(
      '연결이 어려우면 안내판의 NFC 또는 QR을 이용해주세요.',
      'IF CONNECTION IS DIFFICULT, USE THE NFC OR QR ON THE SIGN.',
    )),
  );
  return panel;
}

function moduleHero(stationId, module) {
  const fileName = {
    '01': 'module_01_naming_hero.jpeg',
    '02': 'module_02_reenactment_hero.png',
    '03': 'module_03_mourning_hero.png',
    '04': 'module_04_archive_hero.png',
  }[stationId];

  return el('div', { class: `module-hero module-${module.visual}` },
    el('span', { class: 'module-coordinate coordinate-a' }, `${stationId} / INPUT`),
    el('span', { class: 'module-coordinate coordinate-b' }, 'SCAN ACTIVE'),
    assetFrame(fileName, {
      className: 'module-asset',
      label: `${module.en} module hero`,
      type: `MODULE ${stationId} HERO / P0`,
      note: `${module.en} / ${module.ko}`,
    }),
  );
}

function captureResultPanel(stationId) {
  if (!['01', '02', '03'].includes(stationId)) return null;
  const isSub1 = stationId === '02';
  const autoPollsCapture = ['01', '02'].includes(stationId);
  return el('section', {
    class: 'module-capture-panel',
    id: `module-capture-${stationId}`,
    'data-station': stationId,
    'aria-live': 'polite',
  },
    el('span', { class: 'micro-label' }, 'MY CAPTURE'),
    el('h2', {}, tr('내가 남긴 장면', 'MY CAPTURED MOMENT')),
    el('div', { class: 'capture-result-stage' },
      el('div', { class: 'capture-empty' },
        el('span', { class: 'capture-empty-mark', 'aria-hidden': 'true' }, '＋'),
        el('p', {}, tr(
          isSub1
            ? '이 작품에서 눈을 감아 남긴 장면이 이곳에 나타납니다.'
            : '이 작품에서 남긴 장면이 이곳에 나타납니다.',
          'The moment you leave in this work will appear here.',
        )),
        autoPollsCapture ? el('small', {}, tr('연결 중에는 새 장면을 자동으로 확인합니다.', 'New captures are checked automatically while connected.')) : null,
      ),
    ),
  );
}

function captureStoragePath(artifact) {
  if (artifact?.image_path) return artifact.image_path;
  if (artifact?.meta?.storage_path) return artifact.meta.storage_path;
  return null;
}

async function captureDisplayUrl(artifact) {
  const path = captureStoragePath(artifact);
  if (!path) return artifact?.image_url || null;
  const cached = captureUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const url = await createCaptureSignedUrl(path, 1800);
  if (url) captureUrlCache.set(path, { url, expiresAt: Date.now() + 25 * 60 * 1000 });
  return url;
}

async function refreshCaptureResultPanel(stationId) {
  const panel = document.getElementById(`module-capture-${stationId}`);
  if (!panel || !panel.isConnected) return false;
  const artifacts = await fetchMyCaptureArtifacts(stationId);
  if (!panel.isConnected || !artifacts.length) return false;

  const resolved = (await Promise.all(artifacts.map(async (artifact) => ({
    artifact,
    url: await captureDisplayUrl(artifact),
  })))).filter((item) => item.url);
  if (!panel.isConnected || !resolved.length) return false;

  const fingerprint = resolved.map(({ artifact }) => artifact.id || captureStoragePath(artifact) || artifact.value).join('|');
  if (panel.dataset.fingerprint === fingerprint) return true;
  panel.dataset.fingerprint = fingerprint;

  let index = 0;
  const stage = el('div', { class: 'capture-result-stage has-capture' });
  const image = el('img', { class: 'capture-result-image', alt: tr('내가 작품에서 남긴 장면', 'My captured moment from the work') });
  const count = el('span', { class: 'capture-result-count' });
  const openLink = el('a', {
    class: 'capture-result-open',
    target: '_blank',
    rel: 'noopener',
  }, tr('이미지 열기', 'OPEN IMAGE'), el('span', { 'aria-hidden': 'true' }, '↗'));

  const show = (nextIndex) => {
    index = (nextIndex + resolved.length) % resolved.length;
    image.src = resolved[index].url;
    openLink.href = resolved[index].url;
    count.textContent = `${index + 1} / ${resolved.length}`;
  };

  stage.append(
    image,
    el('div', { class: 'capture-result-meta' },
      count,
      resolved.length > 1 ? el('div', { class: 'capture-result-nav' },
        el('button', { type: 'button', 'aria-label': tr('이전 장면', 'Previous capture'), onclick: () => show(index - 1) }, '←'),
        el('button', { type: 'button', 'aria-label': tr('다음 장면', 'Next capture'), onclick: () => show(index + 1) }, '→'),
      ) : null,
    ),
    openLink,
  );
  panel.querySelector('.capture-result-stage')?.replaceWith(stage);
  show(0);
  logEvent('capture_result_available', { count: resolved.length }, stationId);
  return true;
}

function startModuleCapturePolling(stationId, connected) {
  if (!['01', '02', '03'].includes(stationId)) return;
  stopCapturePolling();
  const poll = async () => {
    if (currentView.name !== 'module' || currentView.data.stationId !== stationId) return;
    await refreshCaptureResultPanel(stationId);
    // 캡처 adapter가 연결된 MAIN1·SUB1은 같은 계약으로 반복 확인한다.
    if (['01', '02'].includes(stationId)
        && connected
        && currentView.name === 'module'
        && currentView.data.stationId === stationId) {
      capturePollTimer = setTimeout(poll, 4000);
    }
  };
  capturePollTimer = setTimeout(poll, 0);
}

async function leaveStation(stationId) {
  const session = ensureSession();
  if (session.connected_station === stationId) {
    const closed = await leaveDbStation(stationId);
    if (!ownsActiveTab(session.id)) return false;
    if (!closed) {
      alert(tr(
        '작품 연결 종료를 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 눌러주세요.',
        'The station could not be disconnected. Check the network and try again.',
      ));
      return false;
    }
    updateSession({ connected_station: null });
    window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
    logEvent('station_leave', { reason: 'manual' }, stationId);
    flushAnalyticsEvents('station_leave');
  }
  markStationComplete(stationId);
  screenHome();
  return true;
}

async function screenModule(stationId, options = {}) {
  const session = ensureSession();
  const module = MODULES[stationId];
  let entryStatus = options.entryStatus || null;
  if (!module) {
    screenHome();
    return;
  }

  if (!isRegistered(session)) {
    updateSession({
      pending_station: options.enter ? stationId : null,
      pending_station_via: options.enter ? (options.via || 'qr') : null,
    });
    session.intro_seen ? screenPersonalSetup() : screenArrival();
    return;
  }

  const via = options.via || 'floorplan';
  const localOnly = Boolean(session.local_only);
  const needsName = !localOnly
    && ['02', '03'].includes(stationId)
    && !session.emotional_name;
  if (options.enter && localOnly) {
    // A local-only visitor may read every page, but must explicitly opt in
    // before a Supabase presence can activate TD or return a capture.
    logEvent('station_local_only_view', { via }, stationId);
  } else if (options.enter && needsName) {
    updateSession({ pending_station: stationId, pending_station_via: via });
    logEvent('station_name_required', { via }, stationId);
  } else if (options.enter) {
    const uiSessionId = ensureSession().id;
    const previousConnectedStation = ensureSession().connected_station || null;
    const controlFields = {
      color: ensureSession().color,
      lang: ensureSession().lang,
      final_name: ensureSession().emotional_name || null,
      final_name_a: ensureSession().emotional_name_a || null,
      final_name_b: ensureSession().emotional_name_b || null,
    };
    const controlsConfirmed = activeDbSessionMatches(uiSessionId)
      ? await confirmSessionControlFields(uiSessionId, controlFields)
      : null;
    const boundStation = controlsConfirmed && ownsActiveTab(uiSessionId)
      ? await enterDbStation(stationId, via, uiSessionId)
      : null;
    entryStatus = getLastStationEntryStatus();
    if (boundStation === stationId && ownsActiveTab(uiSessionId)) {
      if (previousConnectedStation && previousConnectedStation !== stationId) {
        markStationComplete(previousConnectedStation);
        logEvent('station_leave', {
          reason: 'station_switch',
          next_station: stationId,
        }, previousConnectedStation);
        flushAnalyticsEvents('station_switch');
      }
      updateSession({ connected_station: stationId });
      window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: stationId } }));
    } else if (ownsActiveTab(uiSessionId)) {
      // Reconcile from the last server-confirmed DB state. If closing the old
      // station failed it remains here; if it closed before a new bind failed,
      // this is null. The phone must never display a false CONNECTED state.
      const confirmedDbStation = getDbState()?.station || null;
      const latestUi = ensureSession();
      if (latestUi.connected_station !== confirmedDbStation) {
        updateSession({ connected_station: confirmedDbStation });
        window.dispatchEvent(new CustomEvent('fringe:station', {
          detail: { station: confirmedDbStation },
        }));
      }
      console.warn('[phone-hub] station bind failed', { stationId, via });
    }
  }

  const freshSession = ensureSession();
  const connected = freshSession.connected_station === stationId;
  rememberView('module', { stationId, options: { ...options, enter: false } });
  applySessionColor(freshSession.color);
  logEvent('module_page_view', { via, connected }, stationId);

  render([
    globalHeader(),
    el('section', { class: 'screen module-screen' },
      personalHeader(stationId),
      el('div', { class: 'module-title-block' },
        el('span', { class: 'micro-label' }, `MODULE ${stationId} / ${module.en}`),
        el('h1', { class: 'module-title-display' }, tr(module.ko, module.en)),
        el('p', { class: 'module-korean-title' }, tr(module.phaseKo, module.en)),
      ),
      moduleHero(stationId, module),
      freshSession.local_only ? el('section', { class: 'tag-instruction local-only-station-notice' },
        el('span', { class: 'tag-symbol', 'aria-hidden': 'true' }, '⌑'),
        el('div', {},
          el('h2', {}, tr('지금은 작품 안내만 보고 있습니다', 'YOU ARE VIEWING THE GUIDE ONLY')),
          el('p', {}, tr(
            '전시 화면과 장미를 연결하려면 익명 장미 번호가 필요합니다. 연결하기 전에는 이 기기 밖으로 기록을 보내지 않습니다.',
            'An anonymous rose number is required to connect to the installation and receive captures. Nothing leaves this device until you choose to connect.',
          )),
          textButton(tr('익명 장미 번호를 만들고 연결합니다', 'CREATE AN ANONYMOUS ROSE NUMBER AND CONNECT'), async () => {
            const remote = await createRemoteSession(true);
            if (!remote) {
              alert(tr(
                '세션 연결을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 눌러주세요.',
                'The session could not be confirmed. Check the network and try again.',
              ));
              return;
            }
            updateSession({ consent: true, local_only: false });
            await screenModule(stationId, { enter: true, via });
          }, 'local-only-connect'),
        ),
      ) : needsName ? el('section', { class: 'naming-prerequisite' },
        el('span', { class: 'instruction-level' }, 'NAME GIVEN TODAY / REQUIRED'),
        el('h2', {}, tr('이 작품에는 오늘 지은 이름이 필요합니다', 'THIS WORK NEEDS YOUR NAME')),
        el('p', {}, tr(
          '01의 장미를 지난 뒤 이름을 짓는 것을 권합니다. 그 이름이 이 작품의 화면 안에 나타납니다.',
          'We recommend making your name after the rose garden in 01. That name appears inside this work.',
        )),
        el('div', { class: 'naming-prerequisite-actions' },
          textButton(tr('01 명명으로 갑니다', 'GO TO 01'), () => screenModule('01', { via: 'name_required' })),
          textButton(tr('지금 오늘의 이름을 짓습니다', 'MAKE MY NAME NOW'), () => screenFinalReflection({ exitFlow: false, returnToStation: stationId })),
        ),
      ) : connected ? el('div', { class: 'connected-banner' },
        el('span', {}, '● CONNECTED'),
        el('span', {}, `STATION / ${stationId}`),
      ) : patternEntryPanel(stationId, entryStatus),
      el('section', { class: 'module-info-block' },
        el('span', { class: 'micro-label' }, 'ABOUT THIS WORK'),
        el('h2', {}, tr('이 작품에 대하여', 'ABOUT THIS WORK')),
        el('p', {}, tr(module.aboutKo, module.aboutEn)),
        disclosure(
          tr('작품의 안쪽 읽기', 'READ DEEPER'),
          el('div', { class: 'copy-stack' }, ...tr(module.aboutDetailKo, module.aboutDetailEn).map((paragraph) => el('p', {}, paragraph))),
          `about_${stationId}`,
        ),
      ),
      el('section', { class: 'module-info-block' },
        el('span', { class: 'micro-label' }, 'YOUR TURN'),
        el('h2', {}, tr('당신의 차례', 'YOUR TURN')),
        el('p', {}, tr(module.essentialKo, module.essentialEn)),
      ),
      el('section', { class: 'module-info-block' },
        el('span', { class: 'micro-label' }, 'SEQUENCE'),
        el('h2', {}, tr('참여 순서', 'SEQUENCE')),
        el('p', {}, tr(module.helpKo, module.helpEn)),
        el('ol', { class: 'detailed-step-list' }, ...tr(module.helpDetailKo, module.helpDetailEn).map((step) => el('li', {}, step))),
      ),
      el('section', { class: 'module-info-block troubleshooting-block' },
        disclosure(
          tr('잘 되지 않을 때', 'TROUBLESHOOTING'),
          el('div', { class: 'copy-stack' }, ...tr(module.troubleshootKo || [], module.helpDetailEn).map((paragraph) => el('p', {}, paragraph))),
          `troubleshoot_${stationId}`,
        ),
      ),
      captureResultPanel(stationId),
      textButton(tr('전체 프로젝트에서 이 작품 읽기', 'READ THIS WORK IN THE FULL PROJECT'), () => screenAboutProject(workAboutSection(stationId)), 'module-full-story'),
      !connected ? textButton('HOME', screenHome, 'return-home') : null,
    ),
  ], connected && !needsName ? [
    primaryButton(stationId === '01' ? tr('오늘의 이름을 짓습니다', 'NAME THIS FEELING') : tr('이 작품을 마칩니다', 'FINISH THIS WORK'), async () => {
      if (stationId === '01') {
        const activeSession = ensureSession();
        const closed = await leaveDbStation('01');
        if (!ownsActiveTab(activeSession.id)) return;
        if (!closed) {
          alert(tr(
            '작품 연결 종료를 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 눌러주세요.',
            'The station could not be disconnected. Check the network and try again.',
          ));
          return;
        }
        updateSession({ connected_station: null });
        markStationComplete('01');
        window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
        logEvent('station_leave', { reason: 'manual' }, '01');
        flushAnalyticsEvents('station_leave');
        screenFinalReflection({ exitFlow: false });
      } else {
        await leaveStation(stationId);
      }
    }),
  ] : []);
  startModuleCapturePolling(stationId, connected && !needsName);
}

function screenMySpecimen({ returnTo = null } = {}) {
  const session = ensureSession();
  if (!isRegistered(session)) {
    screenPersonalSetup();
    return;
  }

  rememberView('specimen', { returnTo });
  clearStationQuery();
  applySessionColor(session.color);

  const modules = ['01', '02', '03', '04'];
  const traceProfile = traceProfileForCurrentSession();

  render([
    globalHeader(),
    el('section', { class: 'screen specimen-screen' },
      returnTo?.name === 'module' ? textButton(
        tr(`${returnTo.data.stationId} ${workTitle(returnTo.data.stationId)}로 돌아갑니다`, `BACK TO ${returnTo.data.stationId} ${stationLabel(returnTo.data.stationId)}`),
        () => screenModule(returnTo.data.stationId, returnTo.data.options),
        'specimen-back-button',
      ) : null,
      el('div', { class: 'screen-kicker' },
        el('span', {}, tr('현재 표본', 'MY SPECIMEN')),
        el('span', {}, `ROSE NO. ${session.display_record_no}`),
      ),
      roseVisual('specimen', 'CURRENT MY ROSE', traceProfile),
      el('div', { class: 'specimen-name' },
        el('span', {}, session.emotional_name ? tr('오늘 지은 이름', 'NAME GIVEN TODAY') : tr('아직 이름 없음', 'NOT YET NAMED')),
        el('h1', {}, displayName(session)),
      ),
      el('section', { class: 'trace-section' },
        el('div', { class: 'section-heading-row' },
          el('h2', {}, tr('지나온 흔적', 'CURRENT TRACE')),
        ),
        ...modules.map((stationId) => {
          const summary = traceSummaryForStation(stationId);
          const completed = getCompletedStations(session).includes(stationId) || Boolean(summary);
          return el('div', { class: 'trace-row' },
            el('span', {}, stationId),
            el('strong', {}, workTitle(stationId)),
            el('span', { class: completed ? 'is-visited' : '' }, summary ? tr('기록됨', 'TRACE RECORDED') : moduleStatus(session, stationId)),
          );
        }),
      ),
      el('div', { class: 'quiet-actions' },
        textButton(session.emotional_name ? tr('오늘의 이름 보기', 'VIEW NAME') : tr('오늘의 이름 짓기', 'NAME GIVEN TODAY'), () => screenFinalReflection({ exitFlow: false })),
        textButton('HOME', screenHome),
      ),
    ),
  ]);
  void refreshRemoteTraceSummaries();
}

async function screenExitJourney() {
  const session = ensureSession();
  rememberView('exit');
  clearStationQuery();

  if (session.connected_station) {
    const closed = await leaveDbStation(session.connected_station);
    if (!ownsActiveTab(session.id)) return;
    if (!closed) {
      alert(tr(
        '현재 작품과의 연결을 먼저 종료해야 합니다. 네트워크를 확인한 뒤 출구 태그를 다시 읽어주세요.',
        'Disconnect the current station first. Check the network and scan the exit tag again.',
      ));
      return;
    }
    window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
    logEvent('station_leave', { reason: 'exit' }, session.connected_station);
    updateSession({ connected_station: null });
  }

  const missing = ['01', '02', '03', '04'].filter((stationId) => !getCompletedStations(session).includes(stationId));
  logEvent('exit_entered', { missing_modules: missing }, '05');
  flushAnalyticsEvents('exit_entered');

  render([
    globalHeader(),
    el('section', { class: 'screen exit-screen' },
      el('span', { class: 'micro-label' }, '05 / DEPARTURE'),
      el('h1', { class: 'screen-title' }, tr(missing.length ? '아직 지나지 않은 곳이 있습니다.' : '네 곳을 모두 지나왔습니다.', missing.length ? 'SOME PLACES REMAIN.' : 'YOU HAVE PASSED ALL FOUR WORKS.')),
      missing.length ? el('div', { class: 'missing-list' },
        ...missing.map((stationId) => el('button', { type: 'button', onclick: () => screenModule(stationId, { via: 'exit' }) },
          el('span', {}, stationId),
          el('strong', {}, workTitle(stationId)),
          el('span', {}, '↗'),
        )),
      ) : null,
      el('p', { class: 'intro-copy' }, tr(
        missing.length ? '모든 곳을 지나지 않아도 지금까지 남긴 것으로 유품을 만들 수 있습니다. 돌아가도 되고, 이대로 마쳐도 됩니다.' : '이제 오늘 지은 이름과 남긴 장면을 확인하고, 이 장례식의 마지막 기록을 남깁니다.',
        missing.length ? 'You may complete your rose with what you have left so far.' : 'Review the name and moments you left, then make the final record of this funeral.',
      )),
      missing.length ? textButton(tr('돌아가서 봅니다', 'RETURN TO EXHIBITION'), screenHome) : null,
    ),
  ], [
    primaryButton(tr(missing.length ? '이대로 발인을 시작합니다' : '발인을 시작합니다', 'BEGIN DEPARTURE'), () => {
      logEvent(missing.length ? 'exit_continue_incomplete' : 'exit_continue_complete', { missing_modules: missing }, '05');
      screenFinalReflection({ exitFlow: true });
    }),
  ]);
}

function saveNaming(a, b, finalName, inputMeta = {}) {
  updateSession({
    emotional_name_a: a,
    emotional_name_b: b,
    emotional_name: finalName,
  });
  markStationComplete('01');
  saveDbArtifact('naming', finalName, {
    emotional_name_a: a,
    emotional_name_b: b,
    input_summary: inputMeta,
  });
  logEvent('emotional_name_saved', {
    emotional_name_a: a,
    emotional_name_b: b,
    emotional_name: finalName,
    input_summary: inputMeta,
  }, '01');
  flushAnalyticsEvents('naming_saved');
}

// 치료·진단이 아니라 전시의 감정적 깊이·구조·매체 경험을 각각 한 번씩 묻는다.
// 감정 깊이는 01 하나로만 직접 측정해 중복 척도를 피한다.
// 1은 전혀 그렇지 않다, 10은 매우 그렇다. 자유소감은 선택 입력이다.
const SURVEY_QUESTIONS = [
  {
    id: 'emotional_depth',
    ko: '이 전시는 내게 깊고 분명한 감정적 경험으로 남았습니다.',
    en: 'This exhibition remained with me as a deep and distinct emotional experience.',
  },
  {
    id: 'self_relevance',
    ko: '이 전시에서 마주한 장미 또는 장면은 지금의 나와 연결되어 있었습니다.',
    en: 'A rose or scene in this exhibition felt connected to who I am now.',
  },
  {
    id: 'ambivalence',
    ko: '내 안의 서로 다른 면을 한쪽만 지우지 않고 함께 바라볼 수 있었습니다.',
    en: 'I could look at different sides of myself without erasing either one.',
  },
  {
    id: 'emotional_reframing',
    ko: '관람 전과 비교해, 내 감정을 조금 다른 방식으로 바라보게 되었습니다.',
    en: 'I came to view my emotions in a somewhat different way.',
  },
  {
    id: 'agency',
    ko: '무엇을 가까이 보고, 만지고, 멈출지 내가 선택하고 있다고 느꼈습니다.',
    en: 'I felt that I could choose what to approach, touch, or leave.',
  },
  {
    id: 'interaction_meaning',
    ko: '손과 몸으로 한 상호작용이 단순한 조작 이상으로 느껴졌습니다.',
    en: 'The interactions I made with my hands and body felt like more than simple controls.',
  },
  {
    id: 'journey_continuity',
    ko: '각 작품이 흩어진 경험이 아니라 하나의 흐름으로 이어졌습니다.',
    en: 'The works felt like one connected flow rather than separate experiences.',
  },
  {
    id: 'lingering',
    ko: '전시를 떠난 뒤에도 오늘의 장미 또는 이름을 다시 생각할 것 같습니다.',
    en: 'I think I will return to today\'s rose or name after leaving.',
  },
  {
    id: 'phone_hub_clarity',
    ko: 'Phone Hub는 다음에 무엇을 할지 이해하는 데 도움이 되었습니다.',
    en: 'The Phone Hub helped me understand what to do next.',
  },
  {
    id: 'phone_hub_immersion',
    ko: 'Phone Hub는 작품 감상에서 나를 떼어놓기보다, 전시 안에 머물게 했습니다.',
    en: 'The Phone Hub helped me remain inside the exhibition rather than pulling me away from it.',
  },
];

function screenFinalReflection({ exitFlow = false, returnToStation = null } = {}) {
  const session = ensureSession();
  rememberView('reflection', { exitFlow, returnToStation });
  clearStationQuery();

  const aInput = el('input', { type: 'text', value: session.emotional_name_a || '', placeholder: tr('내가 미워했던 나의 한 면', 'A side of myself I rejected'), maxlength: 60 });
  const bInput = el('input', { type: 'text', value: session.emotional_name_b || '', placeholder: tr('그 안에 있던 다른 한 면', 'Another side that was there'), maxlength: 60 });
  const finalInput = el('input', { type: 'text', value: session.emotional_name || '', placeholder: tr('오늘의 나에게 붙이는 이름', 'A name for today\'s self'), maxlength: 60 });
  const error = el('p', { class: 'field-error', 'aria-live': 'polite' });
  const reflectionOpenedAt = performance.now();
  const inputTracking = {
    rejected_side: trackInput(aInput, 'emotional_name_a'),
    other_side: trackInput(bInput, 'emotional_name_b'),
    final_name: trackInput(finalInput, 'emotional_name'),
  };

  const surveyTextInput = el('textarea', {
    rows: 4,
    maxlength: 600,
    value: session.survey?.reflection || '',
    placeholder: tr('지금 남기고 싶은 문장', 'A sentence you want to leave'),
  });
  const surveyTextTracking = trackInput(surveyTextInput, 'survey_reflection');
  const sliderAnswers = {};

  const surveySlider = (question, index) => {
    const stored = Number(session.survey?.[question.id]);
    const hasStoredAnswer = Number.isInteger(stored) && stored >= 1 && stored <= 10;
    if (hasStoredAnswer) sliderAnswers[question.id] = stored;

    const value = el('output', { class: 'survey-slider-value', 'aria-live': 'polite' }, hasStoredAnswer ? String(stored) : '—');
    const input = el('input', {
      id: `survey_${question.id}`,
      class: 'survey-slider-input',
      type: 'range',
      min: 1,
      max: 10,
      step: 1,
      value: hasStoredAnswer ? stored : 5,
      'aria-label': tr(question.ko, question.en),
      'aria-valuetext': hasStoredAnswer ? String(stored) : tr('아직 선택하지 않음', 'Not selected yet'),
    });
    input.addEventListener('input', () => {
      const selected = Number(input.value);
      sliderAnswers[question.id] = selected;
      value.textContent = String(selected);
      input.setAttribute('aria-valuetext', String(selected));
      input.dataset.answered = 'true';
    });

    return el('fieldset', { class: 'survey-question survey-slider-question' },
      el('legend', {}, `${String(index + 1).padStart(2, '0')}. ${tr(question.ko, question.en)}`),
      el('div', { class: 'survey-slider-header' },
        el('span', {}, tr('전혀 그렇지 않다', 'NOT AT ALL')),
        value,
        el('span', {}, tr('매우 그렇다', 'VERY MUCH')),
      ),
      input,
      el('div', { class: 'survey-slider-ticks', 'aria-hidden': 'true' },
        ...Array.from({ length: 10 }, (_, tick) => el('span', {}, String(tick + 1))),
      ),
    );
  };

  const survey = el('div', { class: 'survey-block' },
    el('span', { class: 'micro-label' }, 'FINAL RECORD / 10 QUESTIONS'),
    el('p', { class: 'survey-scale-note' }, tr('아래 문항은 이 전시가 실제로 어떻게 닿았는지 확인하기 위한 기록입니다. 정답은 없습니다. 약 1분 동안 각 막대를 1에서 10 사이로 움직여주세요.', 'About 1 minute · drag each scale from 1 to 10.')),
    ...SURVEY_QUESTIONS.map(surveySlider),
    el('div', { class: 'survey-text-question' },
      el('label', { for: 'survey-reflection' }, tr(
        '오늘 이 장례식에서, 잠시 남겨두고 싶은 마음이나 장면이 있다면 적어주세요. (선택)',
        'If there is a feeling or scene from this funeral you want to leave for a while, write it here. (Optional)',
      )),
      surveyTextInput,
    ),
  );

  render([
    globalHeader(),
    el('section', { class: 'screen reflection-screen' },
      el('span', { class: 'micro-label' }, exitFlow ? 'FINAL RECORD' : 'NAME GIVEN TODAY'),
      el('h1', { class: 'screen-title' }, tr(exitFlow ? '놓아주기 전에' : '오늘의 이름을 짓습니다', exitFlow ? 'BEFORE LETTING GO' : 'NAME GIVEN TODAY')),
      el('p', { class: 'intro-copy' }, tr(
        exitFlow ? '오늘 지은 이름을 이곳에 두고 갈 시간입니다. 두고 간다는 것은 지우는 일이 아닙니다. 더 이상 혼자 들고 있지 않기로 하는 일입니다.' : '방금 손이 머문 장미를 떠올려주세요. 없애고 싶었던 한 면과 그 안에 함께 있었던 다른 한 면을 적고, 두 얼굴이 함께 남을 수 있는 하나의 이름을 짓습니다.',
        'Place two sides together and make one name that can hold them both.',
      )),
      el('div', { class: 'numbered-input' },
        el('span', {}, '01'),
        el('label', {}, tr('내가 미워했던 나의 한 면', 'A SIDE OF MYSELF I REJECTED')),
        aInput,
      ),
      el('div', { class: 'numbered-input' },
        el('span', {}, '02'),
        el('label', {}, tr('그 안에 있던 다른 한 면', 'ANOTHER SIDE THAT WAS THERE')),
        bInput,
      ),
      el('div', { class: 'numbered-input final-name-input' },
        el('span', {}, '03'),
        el('label', {}, tr('두 얼굴을 함께 부를 오늘의 이름', 'FINALLY, GIVE TODAY\'S SELF ONE NAME.')),
        finalInput,
      ),
      exitFlow ? survey : null,
      error,
      !exitFlow ? textButton('HOME', screenHome) : null,
    ),
  ], [
    primaryButton(exitFlow ? tr('이 이름을 두고 갑니다', 'LEAVE THIS NAME') : tr('오늘의 이름을 남깁니다', 'SAVE THIS NAME'), () => {
      const a = aInput.value.trim();
      const b = bInput.value.trim();
      const finalName = finalInput.value.trim();
      if (!a || !b || !finalName) {
        error.textContent = tr('세 문장을 모두 당신의 말로 적어주세요.', 'Complete all three lines.');
        (!a ? aInput : !b ? bInput : finalInput).focus();
        return;
      }

      const inputMeta = {
        rejected_side: inputTracking.rejected_side.commit(a),
        other_side: inputTracking.other_side.commit(b),
        final_name: inputTracking.final_name.commit(finalName),
      };
      saveNaming(a, b, finalName, inputMeta);

      if (exitFlow) {
        const scaleAnswers = {};
        const missingQuestion = SURVEY_QUESTIONS.find((question) => {
          const value = sliderAnswers[question.id] || '';
          scaleAnswers[question.id] = value;
          return !value;
        });
        if (missingQuestion) {
          error.textContent = tr('각 문항의 막대를 한 번씩 움직여주세요.', 'Move each scale once to answer all questions.');
          document.getElementById(`survey_${missingQuestion.id}`)?.focus();
          return;
        }
        const reflection = surveyTextInput.value.trim();
        const reflectionMeta = surveyTextTracking.commit(reflection);
        const surveyMeta = {
          reflection_duration_ms: Math.round(performance.now() - reflectionOpenedAt),
        };
        const surveyRows = Object.fromEntries(SURVEY_QUESTIONS.map((question) => [
          question.id,
          { value: Number(scaleAnswers[question.id]), meta: surveyMeta },
        ]));
        surveyRows.reflection = { value: reflection || null, meta: reflectionMeta };
        updateSession({ survey: { ...ensureSession().survey, ...scaleAnswers, reflection }, finalization_started: true });
        saveDbSurvey(surveyRows);
        logEvent('survey_completed', {
          answers: scaleAnswers,
          reflection_length: reflection.length,
          ...surveyMeta,
        }, '05');
        screenFinalSpecimen();
      } else if (returnToStation) {
        const pendingStationVia = ensureSession().pending_station_via || 'emotional_naming';
        updateSession({ pending_station: null, pending_station_via: null });
        screenModule(returnToStation, { enter: true, via: pendingStationVia });
      } else {
        screenHome();
      }
    }),
  ]);
}

function specimenReference(stationId, session) {
  const hasTrace = Boolean(traceSummaryForStation(stationId));
  const visited = getCompletedStations(session).includes(stationId) || hasTrace;
  const referenceFile = {
    '01': 'result_01_naming_capture.webp',
    '02': 'result_02_reenactment_capture.webp',
    '03': 'result_03_mourning_capture.webp',
    '04': 'result_04_archive_reference.webp',
  }[stationId];
  return el('article', { class: `specimen-reference ${visited ? 'is-visited' : ''}`, 'data-station': stationId },
    el('div', { class: 'reference-line', 'aria-hidden': 'true' }),
    el('div', { class: 'reference-image' },
      assetFrame(referenceFile, {
        className: 'result-reference-asset',
        type: visited ? `RESULT / ${stationId}` : 'NO TRACE / FALLBACK',
        note: `CAPTURE / ${stationId}`,
      }),
    ),
    el('div', { class: 'reference-copy' },
      el('span', {}, `${stationId} / ${stationLabel(stationId)}`),
      el('strong', {}, visited ? tr('남겨진 기록', 'TRACE RECORDED') : tr('방문하지 않음', 'NOT VISITED')),
      el('small', {}, visited ? `CAPTURE / ${stationId}` : 'ARCHIVE / EMPTY'),
    ),
  );
}

async function refreshSpecimenCaptureReferences() {
  const artifacts = await fetchMyCaptureArtifacts();
  const latestByStation = new Map();
  for (const artifact of artifacts) {
    const stationId = String(artifact.station_id || '').padStart(2, '0');
    if (['01', '02', '03'].includes(stationId) && !latestByStation.has(stationId)) {
      latestByStation.set(stationId, artifact);
    }
  }
  for (const [stationId, artifact] of latestByStation) {
    const card = document.querySelector(`.specimen-reference[data-station="${stationId}"]`);
    if (!card) continue;
    const url = await captureDisplayUrl(artifact);
    if (!url || !card.isConnected) continue;
    const imageWrap = card.querySelector('.reference-image');
    if (!imageWrap) continue;
    imageWrap.replaceChildren(el('img', {
      class: 'result-reference-asset asset-image',
      src: url,
      alt: tr(`${stationId}에서 내가 남긴 장면`, `My captured moment from ${stationId}`),
    }));
    card.classList.add('is-visited', 'has-remote-capture');
    const status = card.querySelector('.reference-copy strong');
    if (status) status.textContent = tr('남겨진 장면', 'CAPTURE RECORDED');
  }
}

function saveResultImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1440;
  const context = canvas.getContext('2d');
  const session = ensureSession();
  const title = session.emotional_name || '아직 이름 없음';

  context.fillStyle = '#070707';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = 'rgba(255,255,255,.22)';
  context.strokeRect(58, 58, 964, 1324);
  context.fillStyle = '#e9e6df';
  context.font = '500 34px Menlo, monospace';
  context.fillText('META ROSE SPECIMEN', 84, 120);
  context.fillStyle = session.color || '#F25C94';
  context.beginPath();
  context.arc(540, 480, 210, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#070707';
  context.beginPath();
  context.arc(540, 480, 108, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#f3f0e9';
  context.font = '500 58px Helvetica Neue, sans-serif';
  const safeTitle = title.length > 24 ? `${title.slice(0, 24)}…` : title;
  context.fillText(safeTitle, 84, 890);
  context.font = '400 28px Menlo, monospace';
  context.fillStyle = '#b6b2aa';
  context.fillText(`ROSE NO. ${session.display_record_no}`, 84, 962);
  context.fillText('NAME GIVEN TODAY / META ROSE', 84, 1012);
  context.fillText('MINNIE PARK / META ROSE 2026', 84, 1320);

  const link = document.createElement('a');
  link.download = `meta-rose-${session.display_record_no}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  logEvent('image_save', {}, '05');
}

async function shareResult() {
  const session = ensureSession();
  const text = `FINAL MEMENTO / META ROSE 2026\n${session.emotional_name || '아직 이름 없음'}\nROSE NO. ${session.display_record_no}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'META ROSE SPECIMEN', text, url: location.href });
      logEvent('share_complete', {}, '05');
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${location.href}`);
    alert(tr('결과 링크가 복사되었습니다.', 'Result link copied.'));
  } catch {
    logEvent('share_cancel', {}, '05');
  }
}

function screenFinalSpecimen({ refresh = false } = {}) {
  const session = ensureSession();
  rememberView('final');
  clearStationQuery();
  applySessionColor(session.color);
  const traceProfile = traceProfileForCurrentSession();
  if (!refresh) {
    updateSession({ finalization_completed: true });
    const analyticsEventCount = flushAnalyticsEvents('exit_final');
    saveDbSessionSnapshot({
      snapshot_version: '1',
      finalized_at: new Date().toISOString(),
      rose_no: session.display_record_no,
      lang: session.lang,
      color: session.color,
      emotional_name: session.emotional_name || null,
      completed_stations: getCompletedStations(session),
      survey: session.survey || {},
      analytics_event_count: analyticsEventCount,
      finalization_completed: true,
    });
    endDbSession('survey_done');
    logEvent('result_entered', {}, '05');
    void flushDbQueue(true);
  }

  render([
    globalHeader(),
    el('section', { class: 'screen final-specimen-screen' },
      el('div', { class: 'final-header' },
        el('span', {}, 'FINAL MEMENTO / 유품'),
        el('strong', {}, `ROSE NO. ${session.display_record_no}`),
      ),
      el('div', { class: 'vertical-specimen' },
        roseVisual('final', 'FINAL META ROSE SPECIMEN', traceProfile),
        el('div', { class: 'specimen-stem stem-top', 'aria-hidden': 'true' }),
        el('div', { class: 'final-emotional-name' },
          el('span', {}, tr('오늘 지은 이름', 'NAME GIVEN TODAY')),
          el('h1', {}, session.emotional_name || tr('아직 이름 없음', 'NOT YET NAMED')),
        ),
        el('div', { class: 'specimen-stem', 'aria-hidden': 'true' }),
        specimenReference('01', session),
        specimenReference('02', session),
        specimenReference('03', session),
        specimenReference('04', session),
        el('div', { class: 'specimen-stem stem-bottom', 'aria-hidden': 'true' }),
      ),
      el('section', { class: 'final-epilogue' },
        el('p', {}, tr('장례식은 끝났습니다.', 'THE FUNERAL HAS ENDED.')),
        el('p', {}, tr('죽인 것은 사라지지 않았습니다. 다시 부를 이름이 생겼을 뿐입니다.', 'WHAT WAS KILLED DID NOT DISAPPEAR. IT NOW HAS A NAME THAT CAN BE CALLED AGAIN.')),
        el('p', {}, tr('모순은 없어지지 않아도, 어느 쪽에 물을 줄지는 다시 고를 수 있습니다.', 'THE CONTRADICTION MAY REMAIN, BUT YOU MAY CHOOSE AGAIN WHAT TO WATER.')),
      ),
      el('footer', { class: 'specimen-label' },
        el('div', {}, el('span', {}, tr('오늘 지은 이름', 'NAME GIVEN TODAY')), el('strong', {}, session.emotional_name || tr('아직 이름 없음', 'NOT YET NAMED'))),
        el('div', {}, el('span', {}, 'ROSE NO.'), el('strong', {}, session.display_record_no)),
        el('div', {}, el('span', {}, 'DATE'), el('strong', {}, new Date().toLocaleDateString('ko-KR'))),
        el('p', {}, 'META ROSE 2026 / MINNIE PARK'),
      ),
    ),
  ], [
    primaryButton(tr('이미지로 저장', 'SAVE IMAGE'), saveResultImage),
    el('button', { class: 'secondary-action', type: 'button', onclick: shareResult }, tr('공유', 'SHARE'), el('span', { 'aria-hidden': 'true' }, '↗')),
  ]);
  void refreshRemoteTraceSummaries();
  void refreshSpecimenCaptureReferences();
}

function renderCurrentView() {
  const { name, data } = currentView;
  if (name === 'arrival') screenArrival();
  else if (name === 'setup') screenPersonalSetup();
  else if (name === 'home') screenHome();
  else if (name === 'about') screenAboutProject(data.initialSection);
  else if (name === 'module') screenModule(data.stationId, data.options);
  else if (name === 'specimen') screenMySpecimen(data);
  else if (name === 'exit') screenExitJourney();
  else if (name === 'reflection') screenFinalReflection(data);
  else if (name === 'final') screenFinalSpecimen();
  else if (name === 'pattern-animation') screenPatternAnimationPreview(data.stationId);
  else screenHome();
}

function boot() {
  const bootParams = new URLSearchParams(location.search);
  const patternPreview = bootParams.get('preview');
  const patternAnimationPreviewMatch = bootParams.get('test') === '1'
    ? /^pattern-animation-(all|0[1-4])$/.exec(patternPreview || '')
    : null;

  // Animation study is deliberately isolated from Supabase, station locks,
  // tab ownership, analytics, and TD. It can be reviewed on a phone without
  // changing an active exhibition connection.
  if (patternAnimationPreviewMatch) {
    const previewSession = ensureSession();
    applySessionColor(previewSession.color || '#F25C94');
    $bar.replaceChildren();
    screenPatternAnimationPreview(patternAnimationPreviewMatch[1]);
    return;
  }

  // Reset shared session state before any asynchronous Supabase/Auth work can
  // capture and later restore the previous audience session.
  const resetRequested = bootParams.get('reset') === '1';
  initializeActiveTabGuard({ forceClaim: resetRequested });
  if (resetRequested) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(EVENTS_KEY);
    resetDbSession();
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('reset');
    history.replaceState({}, '', cleanUrl);
  }
  // SDK 로드·네트워크 실패는 이 흐름을 막지 않는다. db.js가 local queue로 폴백한다.
  void initDB();
  startIdleTracking();
  startUiActionTracking();
  const session = ensureSession();
  applySessionColor(session.color);
  $bar.replaceChildren();

  const patternPreviewMatch = isTestMode()
    ? /^pattern-(0[1-4])$/.exec(patternPreview || '')
    : null;
  if (patternPreviewMatch) {
    seedTestSession();
    screenModule(patternPreviewMatch[1], { enter: false, via: 'test_pattern' });
    return;
  }

  const station = stationFromQuery();
  const stationVia = stationViaFromQuery();
  if (station === '05') {
    if (!session.intro_seen || !isRegistered(session)) {
      updateSession({ pending_station: station, pending_station_via: stationVia });
      session.intro_seen ? screenPersonalSetup() : screenArrival();
    } else {
      screenExitJourney();
    }
    return;
  }

  if (station && MODULES[station]) {
    if (!session.intro_seen || !isRegistered(session)) {
      updateSession({ pending_station: station, pending_station_via: stationVia });
      session.intro_seen ? screenPersonalSetup() : screenArrival();
    } else {
      screenModule(station, { enter: true, via: stationVia });
    }
    return;
  }

  if (!session.intro_seen) {
    screenArrival();
  } else if (!isRegistered(session)) {
    screenPersonalSetup();
  } else if (session.finalization_started && !session.finalization_completed) {
    screenFinalReflection({ exitFlow: true });
  } else {
    screenHome();
  }
}

window.addEventListener('DOMContentLoaded', boot);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeRoseMenu();
});
