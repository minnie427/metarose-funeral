import { CONFIG } from './config.js?v=melbourne-onsite-v15-20261003';
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
  flushQueue as flushDbQueue,
  flushAnalyticsEvents,
  resetSession as resetDbSession,
  fetchMyArtifacts,
  fetchMyCaptureArtifacts,
  createCaptureSignedUrl,
  setRuntimeActive as setDbRuntimeActive,
  activeSessionMatches as activeDbSessionMatches,
  verifyRemoteSessionStatus,
  confirmSessionControlFields,
  getState as getDbState,
  getLastStationEntryStatus,
  revalidateStationConnection,
  getArtifactFetchStatus,
  notePhoneActivity,
} from './db.js?v=melbourne-onsite-v15-20261003';
import { MELBOURNE, ABOUT_SECTIONS } from './melbourne-content.js?v=melbourne-onsite-v15-20261003';
import {
  beginRead,
  endRead,
  startIdleTracking,
  trackInput,
} from './measure.js?v=melbourne-onsite-v15-20261003';

const $app = document.getElementById('app');
const $dock = document.getElementById('dock');
const $bar = document.getElementById('statusbar');

// Development previews must never share visitor state or contact Supabase.
// Resolve this before any browser-storage, tab-guard or DB lifecycle code.
const TEST_MODE = new URLSearchParams(location.search).get('test') === '1';
if (TEST_MODE) setDbRuntimeActive(false);
const STORAGE_KEY = TEST_MODE
  ? 'meta_rose_phone_hub_melbourne_test_v1'
  : 'meta_rose_phone_hub_melbourne_v1';
const EVENTS_KEY = TEST_MODE
  ? 'meta_rose_phone_hub_melbourne_test_events_v1'
  : 'meta_rose_phone_hub_melbourne_events_v1';
const ARTIST_INSTAGRAM_URL = 'https://www.instagram.com/minniepark.studio/';
const ACTIVE_TAB_KEY = TEST_MODE
  ? 'meta_rose_phone_hub_melbourne_test_active_tab_v1'
  : 'meta_rose_phone_hub_melbourne_active_tab_v1';
const REDUCE_MOTION_KEY = 'meta_rose_phone_hub_melbourne_reduce_motion_v1';
const LARGE_TEXT_KEY = 'meta_rose_phone_hub_melbourne_large_text_v1';
// window.name belongs to the browsing context and survives a reload without
// being shared as Phone Hub visitor data. It prevents a normal refresh from
// being mistaken for a second competing tab.
const TAB_WINDOW_PREFIX = TEST_MODE
  ? 'meta-rose-melbourne-test-tab:'
  : 'meta-rose-melbourne-tab:';
const TAB_INSTANCE_ID = String(window.name || '').startsWith(TAB_WINDOW_PREFIX)
  ? window.name.slice(TAB_WINDOW_PREFIX.length)
  : (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
window.name = `${TAB_WINDOW_PREFIX}${TAB_INSTANCE_ID}`;
const ACTIVE_TAB_LEASE_MS = 20000;
const PHONE_CONNECT_TIMEOUT_MS = 10000;
const ASSET_CACHE_KEY = 'melbourne-onsite-v15-20261003';
const versionedAssetUrl = (path) => {
  const value = String(path || '');
  if (!value || /^(?:data:|blob:|https?:)/i.test(value)) return value;
  return `${value}${value.includes('?') ? '&' : '?'}v=${ASSET_CACHE_KEY}`;
};
// 투명 배경 PNG. 색은 CSS mask로 장미의 alpha 영역에만 입힌다.
const ROSE_SPECIMEN_IMAGE = versionedAssetUrl('./assets/images/rose_specimen.png');
const ROSE_SPECIMEN_ANIMATION_IMAGE = versionedAssetUrl('./assets/images/rose_specimen_animation.png');
const ROSE_SPECIMEN_ANIMATION_COMPACT_IMAGE = versionedAssetUrl('./assets/images/rose_specimen_animation_compact.png');

let currentView = { name: 'arrival', data: {} };
let viewGeneration = 0;
let activeReadKey = null;
let uiTrackingStarted = false;
let tabRuntimeActive = true;
let tabChannel = null;
let phoneHubEntryInFlight = false;
let stationConnectionUiInFlight = false;
let stationConnectionUiAttempt = 0;
let stationStatusRevalidationGeneration = 0;
let roseMenuOpener = null;
let languageChooserOpener = null;
let inactiveTabPreviousFocus = null;
let activeTabHeartbeatTimer = null;
let dockResizeObserver = null;

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
  // Expose only one modal surface to assistive technology. The duplicate-tab
  // safety dialog supersedes transient navigation dialogs.
  closeRoseMenu({ restoreFocus: false });
  closeLanguageChooser({ restoreFocus: false });
  inactiveTabPreviousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  overlay = document.createElement('section');
  overlay.id = 'inactive-tab-overlay';
  overlay.className = 'inactive-tab-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'inactive-tab-title');
  overlay.setAttribute('aria-describedby', 'inactive-tab-description');
  overlay.innerHTML = `
    <div class="inactive-tab-card">
      <span>PHONE HUB / ACTIVE SCREEN</span>
      <h1 id="inactive-tab-title">${tr('다른 Phone Hub 화면이 열려 있습니다', 'ANOTHER PHONE HUB SCREEN IS OPEN')}</h1>
      <p id="inactive-tab-description">${tr('중복 연결을 막기 위해 이 화면을 잠시 멈췄습니다. 이 화면을 계속 사용하거나 새 장미로 다시 시작할 수 있습니다.', 'This screen is paused to prevent duplicate connections. You can continue here or begin again with a new Rose number.')}</p>
      <button type="button" class="inactive-tab-takeover">${tr('이 화면을 사용합니다', 'USE THIS SCREEN')}</button>
      <button type="button" class="inactive-tab-reset">${tr('새 장미로 다시 시작', 'START A NEW ROSE')}</button>
    </div>`;
  overlay.querySelector('.inactive-tab-takeover')?.addEventListener('click', () => {
    claimActiveTab();
    resumeCurrentViewAfterTabTakeover();
  });
  overlay.querySelector('.inactive-tab-reset')?.addEventListener('click', () => {
    // Become the active owner before resetDbSession runs. Otherwise the DB
    // runtime is paused and the previous server session cannot be closed.
    claimActiveTab();
    resetCurrentBrowserSession();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // A duplicate tab must be resolved explicitly; Escape must not expose a
      // second live interface behind the safety dialog.
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled && node.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.body.append(overlay);
  $app.inert = true;
  $dock.inert = true;
  $bar.inert = true;
  queueMicrotask(() => overlay.querySelector('.inactive-tab-takeover')?.focus());
  return overlay;
}

function setTabRuntimeActive(active) {
  const next = Boolean(active);
  tabRuntimeActive = next;
  setDbRuntimeActive(TEST_MODE ? false : next);
  document.body.classList.toggle('inactive-phone-hub-tab', !next);
  if (next) {
    document.getElementById('inactive-tab-overlay')?.remove();
    const navigationDialogOpen = Boolean(
      document.querySelector('.rose-menu-overlay')
      || document.querySelector('.language-dialog-overlay')
    );
    $app.inert = navigationDialogOpen;
    $dock.inert = navigationDialogOpen;
    $bar.inert = false;
    if (inactiveTabPreviousFocus?.isConnected) inactiveTabPreviousFocus.focus();
    inactiveTabPreviousFocus = null;
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
  if (activeTabHeartbeatTimer) clearInterval(activeTabHeartbeatTimer);
  activeTabHeartbeatTimer = setInterval(() => {
    if (tabRuntimeActive) announceActiveTab();
  }, 5000);
}

function resumeCurrentViewAfterTabTakeover() {
  // Pausing an inactive duplicate intentionally stops polling and reading.
  // Resume only those services: re-rendering FINAL would repeat snapshot and
  // result-view events, while re-rendering a work is unnecessary.
  if (currentView.name === 'module' && currentView.data.stationId) {
    startModuleCapturePolling(currentView.data.stationId);
  } else if (currentView.name === 'final') {
    startResultCapturePolling();
  } else if (currentView.name === 'arrival') {
    startPageRead('arrival');
  } else if (currentView.name === 'about') {
    startPageRead('about_project');
  }
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
    tabChannel = new BroadcastChannel(TEST_MODE
      ? 'meta_rose_phone_hub_melbourne_test_tabs_v1'
      : 'meta_rose_phone_hub_melbourne_tabs_v1');
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

  const lease = readActiveTabLease();
  const leaseFresh = Boolean(lease?.heartbeat && (Date.now() - lease.heartbeat) < ACTIVE_TAB_LEASE_MS);
  // Reloading the same tab keeps ownership. A second fresh tab does not take
  // over merely because it loaded an NFC/QR URL; takeover remains explicit.
  if (forceClaim || !leaseFresh || !lease?.id || lease.id === TAB_INSTANCE_ID) claimActiveTab();
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

async function revalidateVisibleModuleConnection(trigger = 'screen_entry') {
  if (TEST_MODE
      || stationConnectionUiInFlight
      || document.visibilityState === 'hidden'
      || !tabRuntimeActive
      || currentView.name !== 'module') return;

  const stationId = String(currentView.data.stationId || '').padStart(2, '0');
  if (!['01', '02', '03'].includes(stationId)) return;
  const sessionAtStart = ensureSession();
  if (!isRegistered(sessionAtStart) || sessionAtStart.local_only) return;

  const requestGeneration = ++stationStatusRevalidationGeneration;
  const viewGenerationAtStart = viewGeneration;
  const priorOptions = currentView.data.options || {};
  const priorStatusCode = priorOptions.entryStatus?.code || null;
  const wasConnected = sessionAtStart.connected_station === stationId;
  const result = await revalidateStationConnection(stationId, sessionAtStart.id);

  if (requestGeneration !== stationStatusRevalidationGeneration
      || viewGeneration !== viewGenerationAtStart
      || currentView.name !== 'module'
      || currentView.data.stationId !== stationId
      || !ownsActiveTab(sessionAtStart.id)) return;

  const latest = ensureSession();
  if (result.code === 'connected') {
    if (latest.connected_station !== stationId) {
      updateSession({ connected_station: stationId });
      window.dispatchEvent(new CustomEvent('fringe:station', {
        detail: { station: stationId },
      }));
    }
    if (!wasConnected || priorStatusCode === 'busy' || priorStatusCode === 'status_unavailable') {
      void screenModule(stationId, {
        enter: false,
        via: `revalidate_${trigger}`,
        entryStatus: result,
        skipConnectionRevalidation: true,
      });
    }
    return;
  }

  if (result.code === 'available') {
    if (latest.connected_station === stationId) {
      updateSession({ connected_station: null });
      window.dispatchEvent(new CustomEvent('fringe:station', {
        detail: { station: null },
      }));
    }
    if (wasConnected || priorStatusCode === 'busy' || priorStatusCode === 'connected') {
      void screenModule(stationId, {
        enter: false,
        via: `revalidate_${trigger}`,
        entryStatus: result,
        skipConnectionRevalidation: true,
      });
    }
    return;
  }

  // A network/auth failure is not BUSY. Replace only a stale BUSY message;
  // an existing CONNECTED display remains intact until the server can answer.
  if (priorStatusCode === 'busy') {
    void screenModule(stationId, {
      enter: false,
      via: `revalidate_${trigger}`,
      entryStatus: {
        code: result.code === 'offline' ? 'offline' : 'status_unavailable',
        stationId,
      },
      skipConnectionRevalidation: true,
    });
  }
}

function scheduleVisibleStationRevalidation(trigger) {
  if (document.visibilityState === 'hidden') return;
  setTimeout(() => { void revalidateVisibleModuleConnection(trigger); }, 0);
}

window.addEventListener('pageshow', () => scheduleVisibleStationRevalidation('pageshow'));
window.addEventListener('focus', () => scheduleVisibleStationRevalidation('focus'));
window.addEventListener('online', () => scheduleVisibleStationRevalidation('online'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    scheduleVisibleStationRevalidation('visibility');
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
let capturePollFocusHandler = null;
let capturePollVisibilityHandler = null;
let capturePollPageShowHandler = null;
let capturePollOnlineHandler = null;
let capturePollGeneration = 0;
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
  const markPhoneActivity = () => {
    if (tabRuntimeActive && !TEST_MODE) notePhoneActivity();
  };
  if (!TEST_MODE) notePhoneActivity();
  document.addEventListener('pointerdown', markPhoneActivity, { capture: true, passive: true });
  document.addEventListener('keydown', markPhoneActivity, { capture: true });
  document.addEventListener('input', markPhoneActivity, { capture: true });
  window.addEventListener('scroll', markPhoneActivity, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') markPhoneActivity();
  });
  document.addEventListener('click', (event) => {
    if (!tabRuntimeActive) return;
    if (!TEST_MODE) notePhoneActivity();
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
  if (TEST_MODE) return;
  const session = getSession();
  if (!session?.consent || session.local_only) return;
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
  dockResizeObserver?.disconnect();
  const updateDockHeight = () => {
    document.documentElement.style.setProperty('--dock-height', `${visibleActions.length ? Math.ceil($dock.getBoundingClientRect().height) : 0}px`);
  };
  updateDockHeight();
  if (visibleActions.length && 'ResizeObserver' in window) {
    dockResizeObserver = new ResizeObserver(updateDockHeight);
    dockResizeObserver.observe($dock);
  }
  updateDocumentContext();
  window.scrollTo(0, 0);
  requestAnimationFrame(() => {
    if ($app.inert || document.querySelector('[aria-modal="true"]')) return;
    const target = $app.querySelector('h1') || $app;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });
}

function stopCapturePolling() {
  capturePollGeneration += 1;
  if (capturePollTimer) {
    clearTimeout(capturePollTimer);
    capturePollTimer = null;
  }
  if (capturePollFocusHandler) {
    window.removeEventListener('focus', capturePollFocusHandler);
    capturePollFocusHandler = null;
  }
  if (capturePollVisibilityHandler) {
    document.removeEventListener('visibilitychange', capturePollVisibilityHandler);
    capturePollVisibilityHandler = null;
  }
  if (capturePollPageShowHandler) {
    window.removeEventListener('pageshow', capturePollPageShowHandler);
    capturePollPageShowHandler = null;
  }
  if (capturePollOnlineHandler) {
    window.removeEventListener('online', capturePollOnlineHandler);
    capturePollOnlineHandler = null;
  }
}

function siteFooter() {
  return el('footer', { class: 'site-footer' },
    el('span', { lang: 'en' }, `${MELBOURNE.titleUpper} / MELBOURNE 2026`),
    el('span', { class: 'access-fringe-credit', lang: 'en' }, MELBOURNE.accessCredit),
    el('span', { lang: 'en' }, '© 2026 MINNIE PARK. ALL RIGHTS RESERVED.'),
  );
}

function rememberView(name, data = {}) {
  viewGeneration += 1;
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
    lang: CONFIG.EXHIBITION?.defaultLanguage || 'en',
    color: '#F25C94',
    color_locked: false,
    nickname: '',
    emotional_name: '',
    emotional_name_a: '',
    emotional_name_b: '',
    name_source: 'none',
    connected_station: null,
    pending_station: null,
    consent: false,
    consent_version: null,
    edition: MELBOURNE.edition,
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
  if (TEST_MODE) return;
  const dbPatch = {};
  if ('color' in patch) dbPatch.color = patch.color;
  if ('lang' in patch) dbPatch.lang = patch.lang;
  if ('nickname' in patch) dbPatch.pseudonym = patch.nickname;
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
  if (TEST_MODE) return null;
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

async function createRemoteSessionWithDeadline() {
  if (TEST_MODE) {
    const local = ensureSession();
    return {
      remote: { id: local.id, entered_at: local.created_at, test_mode: true },
      code: 'test_simulated',
    };
  }
  if (!navigator.onLine) return { remote: null, code: 'offline' };
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), PHONE_CONNECT_TIMEOUT_MS);
  });
  const connection = createRemoteSession(true)
    .then((remote) => ({ remote, timedOut: false }))
    .catch(() => ({ remote: null, timedOut: false }));
  const result = await Promise.race([connection, timeout]);
  if (timer) clearTimeout(timer);
  if (result?.timedOut) {
    // Advancing the DB generation makes any late Auth/PostgREST completion
    // stale, so a request begun on a failed connection cannot start a work
    // after the network later returns.
    resetDbSession('phone_connect_timeout');
    return { remote: null, code: 'timeout' };
  }
  return { remote: result?.remote || null, code: result?.remote ? 'ok' : 'failed' };
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
  if (TEST_MODE) return [];
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
  // Before explicit Phone Hub consent, and in the no-remote-data pathway,
  // do not create local analytics that could later be backfilled or uploaded.
  if (!session?.consent || session.local_only) return null;
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
  if (TEST_MODE) return existing.at(-1);
  const writeEvent = LIVE_EVENT_TYPES.has(eventType) ? logDbEvent : logAnalyticsEvent;
  writeEvent(eventType, {
    station: stationId || session.connected_station || '00',
    payload,
  });
}

function tr(ko, en) {
  return (getSession()?.lang || CONFIG.EXHIBITION?.defaultLanguage || 'en') === 'ko' ? ko : en;
}

function updateDocumentContext() {
  const lang = getSession()?.lang === 'ko' ? 'ko' : 'en';
  document.documentElement.lang = lang === 'ko' ? 'ko' : 'en-AU';
  document.title = `${MELBOURNE.title} · Minnie Park`;
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', MELBOURNE.title);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', tr(
    'Minnie Park 박지민의 오디오비주얼 인터랙티브 전시 · 멜버른 2026',
    'An audiovisual interactive exhibition by Minnie Park · Melbourne 2026',
  ));
  document.body.classList.toggle('reduce-motion', reduceMotionEnabled());
  document.body.classList.toggle('large-text', largeTextEnabled());
  const skipLink = document.querySelector('.skip-link');
  if (skipLink) skipLink.textContent = tr('본문으로 바로가기', 'Skip to main content');
}

function systemReduceMotionEnabled() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function reduceMotionEnabled() {
  return localStorage.getItem(REDUCE_MOTION_KEY) === '1'
    || systemReduceMotionEnabled();
}

function reduceMotionControlLabel(long = false) {
  if (systemReduceMotionEnabled()) {
    return tr(
      long ? 'Phone Hub 움직임 줄이기: 기기 설정으로 켜짐' : '움직임 줄이기: 기기 설정으로 켜짐',
      long ? 'REDUCE PHONE HUB MOTION: ON (DEVICE SETTING)' : 'REDUCE MOTION: ON (DEVICE SETTING)',
    );
  }
  return reduceMotionEnabled()
    ? tr(long ? 'Phone Hub 움직임 줄이기: 켜짐' : '움직임 줄이기: 켜짐', long ? 'REDUCE PHONE HUB MOTION: ON' : 'REDUCE MOTION: ON')
    : tr(long ? 'Phone Hub 움직임 줄이기: 꺼짐' : '움직임 줄이기: 꺼짐', long ? 'REDUCE PHONE HUB MOTION: OFF' : 'REDUCE MOTION: OFF');
}

function reduceMotionControlAttributes() {
  const systemSetting = systemReduceMotionEnabled();
  return {
    'aria-pressed': reduceMotionEnabled() ? 'true' : 'false',
    'aria-disabled': systemSetting ? 'true' : null,
  };
}

function toggleReduceMotion() {
  if (systemReduceMotionEnabled()) return;
  const next = localStorage.getItem(REDUCE_MOTION_KEY) === '1' ? '0' : '1';
  localStorage.setItem(REDUCE_MOTION_KEY, next);
  updateDocumentContext();
  renderCurrentView();
}

function largeTextEnabled() {
  return localStorage.getItem(LARGE_TEXT_KEY) === '1';
}

function largeTextControlLabel(long = false) {
  return largeTextEnabled()
    ? tr(long ? 'Phone Hub 큰 글자: 켜짐' : '큰 글자: 켜짐', long ? 'LARGER PHONE HUB TEXT: ON' : 'LARGER TEXT: ON')
    : tr(long ? 'Phone Hub 큰 글자: 꺼짐' : '큰 글자: 꺼짐', long ? 'LARGER PHONE HUB TEXT: OFF' : 'LARGER TEXT: OFF');
}

function largeTextControlAttributes() {
  return { 'aria-pressed': largeTextEnabled() ? 'true' : 'false' };
}

function toggleLargeText() {
  localStorage.setItem(LARGE_TEXT_KEY, largeTextEnabled() ? '0' : '1');
  updateDocumentContext();
  renderCurrentView();
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

function sessionContrastInk(hex) {
  let value = String(hex || '').trim().replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(value)) {
    value = value.split('').map((character) => character + character).join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(value)) return '#09090a';
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (
      channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    ));
  const luminance = (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? '#09090a' : '#ffffff';
}

function applySessionColor(hex) {
  const color = hex || '#F25C94';
  document.documentElement.style.setProperty('--session', color);
  document.documentElement.style.setProperty('--session-ink', sessionContrastInk(color));
}

function visitorRoseName(session = getSession()) {
  if (session?.name_source !== 'visitor') return '';
  return String(session.emotional_name || '').trim();
}

function phoneRoseLabel(session = getSession()) {
  const recordNo = String(
    session?.display_record_no
    || session?.id?.slice?.(0, 8)
    || '',
  ).trim().toUpperCase();
  return recordNo ? `PHONE ROSE · ${recordNo}` : 'PHONE ROSE';
}

function displayName(session = getSession()) {
  const visitorName = visitorRoseName(session);
  if (visitorName) return visitorName;
  // A Phone Hub visitor without a chosen name is still a specific phone-owned
  // Rose. Keep that visibly distinct from a TD-only anonymous run.
  if (session?.consent && !session?.local_only) return phoneRoseLabel(session);
  return session?.lang === 'ko' ? '무기명' : 'ANONYMOUS';
}

function randomRoseColor(excludeHex = '') {
  const palette = Array.isArray(CONFIG.PALETTE) && CONFIG.PALETTE.length
    ? CONFIG.PALETTE
    : [{ hex: '#F25C94' }];
  const normalizedExclude = String(excludeHex || '').toUpperCase();
  const available = palette.length > 1
    ? palette.filter((item) => String(item.hex || '').toUpperCase() !== normalizedExclude)
    : palette;
  return available[Math.floor(Math.random() * available.length)].hex;
}

function roseColourLabel(hex) {
  const normalized = String(hex || '').toUpperCase();
  const match = (CONFIG.PALETTE || []).find((item) => String(item.hex).toUpperCase() === normalized);
  if (!match) return tr('사용자 지정 장미색', 'Custom rose colour');
  const namesKo = {
    rose: '장미빛', peach: '복숭아빛', amber: '호박빛', mint: '민트빛',
    aqua: '아쿠아빛', blue: '파란빛', violet: '보라빛', magenta: '마젠타빛',
  };
  return tr(namesKo[match.name] || match.name, `${match.name.charAt(0).toUpperCase()}${match.name.slice(1)} rose`);
}

function routeAfterRoseSetup() {
  const session = ensureSession();
  const pendingStation = session.pending_station;
  const pendingStationVia = session.pending_station_via || 'qr';
  updateSession({ pending_station: null, pending_station_via: null });
  if (pendingStation === '05') {
    void screenExitJourney();
  } else if (pendingStation && MODULES[pendingStation]) {
    // QR/NFC and HOME only open the work page. A separate, explicit CONNECT
    // action is required before a station claim is attempted.
    void screenModule(pendingStation, { enter: false, via: pendingStationVia });
  } else {
    screenHome();
  }
}

async function beginPhoneHub({ chooseColor = false, button = null } = {}) {
  if (phoneHubEntryInFlight) return;
  const sessionIdAtStart = rotateLocalOnlySessionForRemoteOptIn().id;
  phoneHubEntryInFlight = true;
  const entryButtons = [...document.querySelectorAll('.dock button')];
  entryButtons.forEach((entryButton) => { entryButton.disabled = true; });
  if (button) button.setAttribute('aria-busy', 'true');
  const restoreEntryControls = () => {
    entryButtons.forEach((entryButton) => { entryButton.disabled = false; });
    if (button) button.removeAttribute('aria-busy');
  };
  const connection = await createRemoteSessionWithDeadline();
  const remote = connection.remote;
  if (getSession()?.id !== sessionIdAtStart || !ownsActiveTab(sessionIdAtStart)) {
    phoneHubEntryInFlight = false;
    restoreEntryControls();
    return;
  }
  if (!remote) {
    phoneHubEntryInFlight = false;
    restoreEntryControls();
    const offline = connection.code === 'offline';
    alert(offline ? tr(
      '현재 네트워크에 연결되어 있지 않습니다. 연결 후 다시 누르거나 스태프에게 현재 설치된 현장 시작 방법을 확인해주세요.',
      'This phone is offline. Reconnect and try again, or ask staff for the start method currently installed at the work.',
    ) : tr(
      '10초 안에 Phone Hub 연결을 확인하지 못했습니다. 요청은 취소되었습니다. 다시 시도하거나 스태프에게 현재 설치된 현장 시작 방법을 확인해주세요.',
      'The Phone Hub connection was not confirmed within 10 seconds, so the request was cancelled. Try again or ask staff for the start method currently installed at the work.',
    ));
    return;
  }

  const current = ensureSession();
  const basePatch = {
    intro_seen: true,
    consent: true,
    consent_version: 'melbourne-phone-hub-v1',
    consent_at: new Date().toISOString(),
    consent_method: 'explicit_phone_hub_entry_action',
    local_only: false,
    emotional_name: current.name_source === 'visitor' ? current.emotional_name : '',
    emotional_name_a: current.name_source === 'visitor' ? current.emotional_name_a : '',
    emotional_name_b: current.name_source === 'visitor' ? current.emotional_name_b : '',
    name_source: current.name_source === 'visitor' ? 'visitor' : 'none',
    // TD receives this stable fallback through sessions.pseudonym whenever the
    // visitor chooses not to name their Rose. A later chosen final_name still
    // takes precedence in v_active_at_station.
    nickname: phoneRoseLabel(current),
  };
  updateSession(basePatch);
  logEvent('arrival_enter_clicked', {
    choose_color: chooseColor,
    consent_version: basePatch.consent_version,
    consent_method: basePatch.consent_method,
  }, '00');

  if (chooseColor) {
    // Present every new visitor with a usable colour immediately. They may
    // refine it in the picker, or simply continue with this random selection.
    const color = randomRoseColor(current.color);
    applySessionColor(color);
    updateSession({ color, color_locked: false });
    phoneHubEntryInFlight = false;
    screenPersonalSetup();
    return;
  }

  const color = randomRoseColor();
  applySessionColor(color);
  updateSession({ color, color_locked: true });
  logEvent('specimen_registered', {
    color,
    name_source: basePatch.name_source,
    registration_mode: 'quick_random',
  }, '00');
  phoneHubEntryInFlight = false;
  routeAfterRoseSetup();
}

function rotateLocalOnlySessionForRemoteOptIn() {
  const current = ensureSession();
  if (!current.local_only) return current;

  // A prior remote row may already be queued as ended. Never reuse that UUID
  // when a no-phone visitor later opts into the Phone Hub, or the old queued
  // end can race the new insert and terminate the new visit.
  if (!TEST_MODE) resetDbSession('local_only_remote_opt_in');
  const id = makeId();
  const fresh = {
    id,
    display_record_no: id.slice(0, 8).toUpperCase(),
    lang: current.lang || CONFIG.EXHIBITION?.defaultLanguage || 'en',
    color: '#F25C94',
    color_locked: false,
    nickname: '',
    emotional_name: '',
    emotional_name_a: '',
    emotional_name_b: '',
    name_source: 'none',
    connected_station: null,
    pending_station: current.pending_station || null,
    pending_station_via: current.pending_station_via || null,
    consent: false,
    consent_version: null,
    consent_at: null,
    local_only: true,
    edition: MELBOURNE.edition,
    intro_seen: false,
    completed_stations: [],
    survey: {},
    created_at: new Date().toISOString(),
  };
  localStorage.removeItem(EVENTS_KEY);
  saveSession(fresh);
  remoteTraceCache = {
    sessionId: null,
    fingerprint: '',
    summaries: [],
    request: null,
  };
  return fresh;
}

function beginNoRemoteDataPath() {
  const session = ensureSession();
  // This is an explicit no-remote-recording choice. Close any older remote
  // session that may still be present on a shared device before showing the
  // on-site route, so a previous visitor cannot remain connected behind it.
  if (!TEST_MODE) resetDbSession('no_remote_data_selected');
  saveSession({
    ...session,
    intro_seen: false,
    consent: false,
    consent_version: null,
    local_only: true,
    connected_station: null,
  });
  screenNoPhoneParticipation();
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

function openModuleFromNavigation(stationId, via) {
  // RECORD is a shared, non-exclusive viewing work. An explicit navigation
  // choice records the visit without rendering a phone-connection control.
  // Rerenders and page reloads still use enter:false and cannot create visits.
  return screenModule(stationId, { via, enter: stationId === '04' });
}

function isTestMode() {
  return TEST_MODE;
}

function assetFrame(fileName, options = {}) {
  const path = options.path || `./assets/images/${fileName}`;
  const requestPath = versionedAssetUrl(path);
  const label = options.label || fileName;
  const placeholder = el('div', { class: 'asset-placeholder' },
    el('span', { class: 'asset-type' }, options.type || 'IMAGE ASSET'),
    el('strong', {}, tr('이미지를 불러오지 못했습니다', 'IMAGE UNAVAILABLE')),
    el('p', {}, tr('페이지를 새로고침하거나 작가에게 알려주세요.', 'Reload the page or let the artist know.')),
  );

  const image = el('img', {
    class: 'asset-image',
    alt: label,
    loading: options.loading || 'lazy',
    decoding: 'async',
    fetchpriority: options.fetchPriority || 'auto',
    hidden: true,
    onload: () => {
      image.hidden = false;
      placeholder.hidden = true;
    },
    onerror: () => {
      image.hidden = true;
      placeholder.hidden = false;
    },
  });
  // Attach load/error handlers before assigning src. Cached and local images
  // can otherwise finish before the listener exists and remain hidden.
  image.src = requestPath;
  if (image.complete && image.naturalWidth > 0) {
    image.hidden = false;
    placeholder.hidden = true;
  }
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
    image.src = versionedAssetUrl('./rose-bloom.svg');
  });
  return image;
}

function roseMark(className = '') {
  return el('span', { class: `rose-mark ${className}`.trim(), 'aria-hidden': 'true' },
    roseSpecimenImage('', 'rose-mark-image'),
    el('i', { class: 'rose-tint rose-mark-tint' }),
  );
}

async function releaseCurrentStation(reason = 'navigation') {
  const session = ensureSession();
  const stationId = session.connected_station;
  if (!stationId) return true;

  if (TEST_MODE) {
    updateSession({ connected_station: null });
    markStationComplete(stationId);
    window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
    logEvent('station_leave', { reason, test_mode: true }, stationId);
    return true;
  }

  const closed = await leaveDbStation(stationId);
  if (!ownsActiveTab(session.id)) return false;
  if (!closed) {
    alert(tr(
      'Phone Hub 연결 종료를 확인하지 못했습니다. 네트워크가 돌아오면 다시 연결하거나, 현재 이용 가능한 현장 참여 방식은 스태프에게 확인해주세요.',
      'The Phone Hub could not confirm disconnection. Reconnect when the network returns, or ask staff which on-site participation method is currently available.',
    ));
    updateSession({ connected_station: null });
    markStationComplete(stationId);
    window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
    return true;
  }

  updateSession({ connected_station: null });
  markStationComplete(stationId);
  window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
  logEvent('station_leave', { reason }, stationId);
  if (!TEST_MODE) flushAnalyticsEvents(`station_leave_${reason}`);
  return true;
}

function navigateWithinPhoneHub(action) {
  closeRoseMenu();
  action();
  return true;
}

function openArtistInstagram(event) {
  event?.preventDefault();
  logEvent('artist_instagram_open', { handle: '@minniepark.studio' }, null);
  navigateWithinPhoneHub(() => {
    window.location.assign(ARTIST_INSTAGRAM_URL);
  });
}

async function goHome() {
  closeRoseMenu();
  const session = ensureSession();
  if (!isRegistered(session)) {
    screenArrival();
    return false;
  }
  // HOME ends only the phone's exclusive station presence. The installation
  // must keep/finish its physical playback from its own verified TD signals.
  // This prevents a phone heartbeat from blocking the next visitor.
  await releaseCurrentStation('home');
  screenHome();
  return true;
}

function globalHeader() {
  ensureSession();
  return el('header', { class: 'global-header' },
    el('button', {
      class: 'wordmark',
      type: 'button',
      'aria-label': tr('홈으로 이동', 'Go to home'),
      onclick: () => { void goHome(); },
    },
      roseMark('wordmark-rose'),
      el('span', { class: 'wordmark-copy' },
        el('span', {}, 'META ROSE 26'),
        el('span', { class: 'wordmark-fringe' }, 'MELB FRINGE'),
      ),
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
        'aria-label': tr('언어 선택', 'Choose language'),
        'aria-haspopup': 'dialog',
        onclick: (event) => openLanguageChooser(event.currentTarget),
      }, el('span', { class: 'language-globe', 'aria-hidden': 'true' })),
      el('button', {
        class: 'rose-menu-button',
        type: 'button',
        'aria-label': tr('메뉴 열기', 'Open menu'),
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        onclick: (event) => openRoseMenu(event.currentTarget),
      },
        el('span', { class: 'menu-trigger-symbol', 'aria-hidden': 'true' }, '☰'),
        el('span', { class: 'menu-trigger-label' }, tr('메뉴', 'MENU')),
      ),
    ),
  );
}

function setInterfaceLanguage(language, navigationVia = 'language_dialog') {
  const next = language === 'ko' ? 'ko' : 'en';
  updateSession({ lang: next });
  logEvent('language_selected', { language: next, navigation_via: navigationVia }, '00');
  updateDocumentContext();
}

function closeLanguageChooser({ restoreFocus = true } = {}) {
  const overlay = document.querySelector('.language-dialog-overlay');
  if (!overlay) return;
  overlay.remove();
  const blockingDialogOpen = Boolean(
    document.querySelector('.rose-menu-overlay')
    || document.getElementById('inactive-tab-overlay')
  );
  $app.inert = blockingDialogOpen;
  $dock.inert = blockingDialogOpen;
  if (restoreFocus && !blockingDialogOpen) languageChooserOpener?.focus({ preventScroll: true });
  languageChooserOpener = null;
}

function openLanguageChooser(opener = null) {
  if (document.querySelector('.language-dialog-overlay')) return;
  languageChooserOpener = opener instanceof HTMLElement ? opener : document.activeElement;
  const currentLanguage = ensureSession().lang === 'ko' ? 'ko' : 'en';
  const choose = (language) => {
    setInterfaceLanguage(language);
    closeLanguageChooser({ restoreFocus: false });
    renderCurrentView();
  };
  const overlay = el('div', {
    class: 'language-dialog-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'language-dialog-title',
    onclick: (event) => {
      if (event.target === overlay) closeLanguageChooser();
    },
  },
    el('section', { class: 'language-dialog-card' },
      el('span', { class: 'micro-label' }, 'LANGUAGE'),
      el('h2', { id: 'language-dialog-title' }, 'Choose language · 언어 선택'),
      el('button', {
        class: 'language-choice',
        type: 'button',
        'aria-pressed': currentLanguage === 'en' ? 'true' : 'false',
        onclick: () => choose('en'),
      }, 'English'),
      el('button', {
        class: 'language-choice',
        type: 'button',
        'aria-pressed': currentLanguage === 'ko' ? 'true' : 'false',
        onclick: () => choose('ko'),
      }, '한국어'),
      el('button', { class: 'language-dialog-close', type: 'button', onclick: closeLanguageChooser }, tr('닫기', 'CLOSE')),
    ),
  );
  document.body.append(overlay);
  $app.inert = true;
  $dock.inert = true;
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLanguageChooser();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button')].filter((node) => !node.disabled);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  overlay.querySelector('.language-choice[aria-pressed="true"]')?.focus();
}

function personalHeader(connectedStation = null) {
  const session = ensureSession();
  const connected = Boolean(connectedStation && session.connected_station === connectedStation);

  return el('button', {
    class: 'personal-header',
    type: 'button',
    onclick: () => {
      navigateWithinPhoneHub(() => screenMySpecimen({
        returnTo: connectedStation
          ? { name: 'module', data: { stationId: connectedStation, options: { via: 'back' } } }
          : { name: 'home', data: {} },
      }));
    },
    'aria-label': tr('나의 장미 보기', 'View my rose'),
  },
    el('span', { class: 'personal-rose' },
      roseSpecimenImage(''),
      el('i', { class: 'rose-tint' }),
    ),
    el('span', { class: 'personal-copy' },
      el('small', {}, `${tr('장미 번호', 'ROSE NO.')} ${session.display_record_no}`),
      el('strong', {}, displayName(session)),
    ),
    connectedStation ? el('span', { class: `connection-state ${connected ? 'is-connected' : ''}` },
      connected ? tr('● 연결됨', '● CONNECTED') : tr('○ 연결 안 됨', '○ NOT CONNECTED'),
    ) : el('span', { class: 'header-arrow', 'aria-hidden': 'true' }, '↗'),
  );
}

function closeRoseMenu({ restoreFocus = true } = {}) {
  const overlay = document.querySelector('.rose-menu-overlay');
  if (!overlay) return;
  overlay.remove();
  document.body.classList.remove('menu-open');
  const blockingDialogOpen = Boolean(
    document.querySelector('.language-dialog-overlay')
    || document.getElementById('inactive-tab-overlay')
  );
  $app.inert = blockingDialogOpen;
  $dock.inert = blockingDialogOpen;
  roseMenuOpener?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && !blockingDialogOpen) roseMenuOpener?.focus({ preventScroll: true });
  roseMenuOpener = null;
}

function menuAction(label, action, index = null) {
  return el('button', {
    class: 'rose-menu-item',
    type: 'button',
    onclick: () => {
      logEvent('menu_item_selected', { item: label, navigation_via: 'menu' }, null);
      navigateWithinPhoneHub(action);
    },
  },
    index ? el('span', { class: 'menu-index' }, index) : el('span', { class: 'menu-index' }, '·'),
    el('span', { class: 'menu-label' }, label),
    el('span', { class: 'menu-arrow', 'aria-hidden': 'true' }, '↗'),
  );
}

function menuGroupLabel(ko, en) {
  return el('p', { class: 'menu-group-label' }, tr(ko, en));
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
  const hasVisitorName = session.name_source === 'visitor';
  const demo = {
    intro_seen: true,
    consent: true,
    color: session.color || '#F25C94',
    color_locked: true,
    nickname: '',
    emotional_name_a: hasVisitorName ? (session.emotional_name_a || '') : '',
    emotional_name_b: hasVisitorName ? (session.emotional_name_b || '') : '',
    emotional_name: hasVisitorName ? (session.emotional_name || '') : '',
    name_source: hasVisitorName ? 'visitor' : 'none',
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
  if (!TEST_MODE) resetDbSession();
  remoteTraceCache = {
    sessionId: null,
    fingerprint: '',
    summaries: [],
    request: null,
  };
  screenArrival();
}

function confirmStartNewRose() {
  const confirmed = window.confirm(tr(
    '현재 장미 번호의 Phone Hub 연결을 끝내고 새 장미를 시작할까요? 이미 저장된 이미지와 데이터는 삭제되지 않습니다.',
    'End this Phone Hub connection and start a new Rose number? Captures and data already saved will not be deleted.',
  ));
  if (!confirmed) return;
  localStorage.removeItem(ACTIVE_TAB_KEY);
  resetCurrentBrowserSession();
  claimActiveTab();
}

// 00 is an entrance route, not a required lifecycle boundary. Opening results
// never ends the current Melbourne visit.
async function handleEntranceRoute() {
  const session = ensureSession();
  if (!session.intro_seen || !isRegistered(session)) {
    session.intro_seen ? screenPersonalSetup() : screenArrival();
    return;
  }

  if (!TEST_MODE && !session.local_only && session.consent) {
    render([
      globalHeader(),
      el('section', { class: 'screen entrance-session-check', role: 'status', 'aria-live': 'polite' },
        el('span', { class: 'micro-label' }, tr('장미 확인', 'ROSE CHECK')),
        el('h1', { class: 'screen-title' }, tr('장미 번호를 확인하고 있습니다', 'CHECKING YOUR ROSE NUMBER')),
        el('p', { class: 'intro-copy' }, tr(
          '네트워크 확인이 늦어지면 스태프에게 현재 설치된 현장 참여 방식을 확인할 수 있습니다.',
          'If the network check is slow, ask staff which on-site participation method is currently installed.',
        )),
      ),
    ]);
    const serverVerification = verifyRemoteSessionStatus(session.id);
    const remoteStatus = await Promise.race([
      serverVerification,
      new Promise((resolve) => setTimeout(() => resolve('unavailable'), 4000)),
    ]);
    if (getSession()?.id !== session.id || !ownsActiveTab(session.id)) return;
    if (remoteStatus === 'ended') {
      resetCurrentBrowserSession();
      return;
    }
    if (remoteStatus === 'unavailable') {
      // The UI continues after four seconds, but a slow read may still prove
      // that this Rose ended server-side. Reconcile only while the same tab
      // and same local UUID still own the interface.
      void serverVerification.then((lateStatus) => {
        if (lateStatus !== 'ended'
            || getSession()?.id !== session.id
            || !ownsActiveTab(session.id)) return;
        resetCurrentBrowserSession();
      });
    }
  }

  if (session.connected_station && TEST_MODE) {
    await releaseCurrentStation('entrance_return');
  } else if (session.connected_station) {
    const previousStation = session.connected_station;
    const closed = await leaveDbStation(previousStation);
    if (!ownsActiveTab(session.id)) return;
    if (closed) {
      updateSession({ connected_station: null });
      window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
      logEvent('station_leave', { reason: 'entrance_return' }, previousStation);
      if (!TEST_MODE) flushAnalyticsEvents('entrance_return');
    } else {
      alert(tr(
        '현재 Phone Hub 연결 종료를 확인하지 못했습니다. 네트워크를 확인하거나, 현재 설치된 현장 시작 방식은 스태프에게 확인해주세요.',
        'The Phone Hub connection could not be closed. Check the network, or ask staff which on-site start method is currently installed.',
      ));
    }
  }

  updateSession({ pending_station: null, pending_station_via: null });
  screenHome();
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
      '작품 연결, 기존 태깅, 출구와 마지막 총정리 화면을 바로 확인합니다.',
      'Open work connection, legacy tagged, exit, and final result states directly.',
    )) : null,
    el('div', { class: 'test-preview-grid' },
      testPreview(tr('처음부터 다시 보기', 'RESET TO ARRIVAL'), resetCurrentBrowserSession),
      testPreview('WORK 01', () => { seedTestSession(); screenModule('01', { enter: false, via: 'test_work' }); }),
      testPreview('WORK 02', () => { seedTestSession(); screenModule('02', { enter: false, via: 'test_work' }); }),
      testPreview('WORK 03', () => { seedTestSession(); screenModule('03', { enter: false, via: 'test_work' }); }),
      testPreview('WORK 04', () => { seedTestSession(); screenModule('04', { enter: false, via: 'test_work' }); }),
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

function openRoseMenu(opener = null) {
  if (document.querySelector('.rose-menu-overlay')) return;
  const openerElement = opener?.currentTarget || opener;
  roseMenuOpener = openerElement instanceof HTMLElement ? openerElement : document.activeElement;
  roseMenuOpener?.setAttribute?.('aria-expanded', 'true');
  const session = ensureSession();
  logEvent('menu_open', { from: currentView.name }, null);

  const overlay = el('div', {
    class: 'rose-menu-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': tr('메뉴', 'MENU'),
    onclick: (event) => {
      if (event.target === overlay) closeRoseMenu();
    },
  },
    el('div', { class: 'rose-menu-panel' },
      el('div', { class: 'rose-menu-head' },
        el('div', {},
          el('span', { class: 'micro-label' }, `${tr('장미 번호', 'ROSE NO.')} ${session.display_record_no}`),
          el('h2', {}, tr('메뉴', 'MENU')),
        ),
        el('button', { class: 'menu-close', type: 'button', onclick: closeRoseMenu, 'aria-label': tr('메뉴 닫기', 'Close menu') }, '×'),
      ),
      el('nav', { class: 'rose-menu-nav', 'aria-label': tr('주요 메뉴', 'Main menu') },
        menuAction('HOME', () => guardedNavigation(() => { void goHome(); })),
        menuGroupLabel('작품', 'WORKS'),
        menuAction(tr('명명', 'NAMING'), () => guardedNavigation(() => screenModule('01', { via: 'menu' })), '01'),
        menuAction(tr('개입', 'INTERVENTION'), () => guardedNavigation(() => screenModule('02', { via: 'menu' })), '02'),
        menuAction(tr('목격', 'WITNESS'), () => guardedNavigation(() => screenModule('03', { via: 'menu' })), '03'),
        menuAction(tr('기록', 'RECORD'), () => guardedNavigation(() => openModuleFromNavigation('04', 'menu')), '04'),
        menuGroupLabel('나의 Phone Hub', 'MY PHONE HUB'),
        menuAction(tr('나의 장미', 'MY ROSE'), () => guardedNavigation(screenFinalSpecimen)),
        menuAction(tr('설문', 'SURVEY'), () => guardedNavigation(screenSurvey)),
        menuGroupLabel('정보', 'INFORMATION'),
        menuAction(tr('전체 프로젝트', 'ABOUT THE PROJECT'), () => guardedNavigation(() => screenAboutProject())),
        menuAction(tr('접근성·감각 안내', 'ACCESS & SENSORY GUIDE'), screenAccessGuide),
      ),
      isTestMode() ? testPreviewPanel() : null,
      el('div', { class: 'rose-menu-foot' },
        el('button', {
          class: 'menu-language large-text-menu',
          type: 'button',
          onclick: () => { closeRoseMenu(); toggleLargeText(); },
          ...largeTextControlAttributes(),
        }, largeTextControlLabel()),
        el('button', {
          class: 'menu-language reduce-motion-menu',
          type: 'button',
          onclick: () => { closeRoseMenu(); toggleReduceMotion(); },
          ...reduceMotionControlAttributes(),
        }, reduceMotionControlLabel()),
        el('button', {
          class: 'menu-language start-new-rose-menu',
          type: 'button',
          onclick: () => { closeRoseMenu(); confirmStartNewRose(); },
        }, tr('새 장미 시작', 'START A NEW ROSE')),
        el('a', {
          class: 'menu-instagram',
          href: ARTIST_INSTAGRAM_URL,
          'aria-label': 'Instagram @minniepark.studio',
          onclick: openArtistInstagram,
        }, '@MINNIEPARK.STUDIO', el('span', { 'aria-hidden': 'true' }, '↗')),
        el('span', { lang: 'en' }, `${MELBOURNE.titleUpper} / ${MELBOURNE.cityYear}`),
        el('span', { class: 'access-fringe-credit', lang: 'en' }, MELBOURNE.accessCredit),
        el('span', { class: 'menu-copyright', lang: 'en' }, '© 2026 MINNIE PARK. ALL RIGHTS RESERVED.'),
      ),
    ),
  );

  document.body.append(overlay);
  document.body.classList.add('menu-open');
  $app.inert = true;
  $dock.inert = true;
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeRoseMenu();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled && node.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
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

function primaryButton(label, action, className = '') {
  return el('button', { class: `primary-action ${className}`.trim(), type: 'button', onclick: action }, label, el('span', { 'aria-hidden': 'true' }, '→'));
}

function stackedActionLabel(primary, secondary) {
  return el('span', { class: 'stacked-action-label' },
    el('strong', {}, primary),
    el('small', {}, secondary),
  );
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
        el('span', {}, MELBOURNE.cityYear),
      ),
      el('p', { class: 'arrival-festival' }, MELBOURNE.festival),
      el('h1', { class: 'arrival-project-title' }, MELBOURNE.titleUpper),
      el('p', { class: 'arrival-byline' }, MELBOURNE.artistCredit),
      assetFrame('arrival_hero.png', {
        className: 'arrival-asset',
        label: tr('메타 로즈 전시의 장미 비주얼', 'A rose visual from The Meta Rose exhibition'),
        type: 'ARRIVAL HERO / P0',
        note: tr('입구 표지용 고정 비주얼 사진', 'Fixed visual photograph for the entry cover'),
        loading: 'eager',
        fetchPriority: 'high',
      }),
      el('section', { class: 'arrival-summary' },
        el('span', { class: 'micro-label' }, tr('오디오비주얼 인터랙티브 전시', 'AUDIOVISUAL INTERACTIVE EXHIBITION')),
        el('p', {}, tr(
          '생화 장미, 움직이는 이미지, 빛과 소리가 접촉과 움직임, 거리에 반응합니다. 명명·개입·목격·기록의 네 작품은 돌봄과 손상, 삶과 죽음을 같은 장면 안에 놓습니다. 얼마나 가까이 다가가고 얼마나 오래 머물지는 관객이 선택합니다.',
          'Living roses, moving images, light and sound respond to touch, movement and proximity. Across four works, Naming, Intervention, Witness and Record, the exhibition places care and damage, life and death, within the same frame. You choose how closely and how long to take part.',
        )),
      ),
      textButton(tr('프로젝트 자세히 보기', 'ABOUT THE PROJECT'), () => screenAboutProject('about-intro'), 'arrival-about-link'),
      el('section', { class: 'arrival-access-summary' },
        disclosure(
          tr('참여 전 안내', 'BEFORE YOU TAKE PART'),
          el('div', { class: 'copy-stack arrival-notice-details' },
            el('p', {}, tr(
              'Phone Hub는 선택 사항입니다. 휴대폰 없이도 참여할 수 있고, 도움이 필요하면 현장의 작가에게 말해주세요.',
              'The Phone Hub is optional. You can take part without it, and ask the artist on site for help.',
            )),
            el('p', {}, tr(
              '실제 장미의 향과 꽃가루에 민감하다면 편한 거리를 유지해주세요.',
              'Real roses are used. Keep a comfortable distance if you are sensitive to fragrance or pollen.',
            )),
            el('p', {}, tr(
              '관객의 인터랙션에 따라 가벼운 번쩍임, 밝기와 소리의 변화가 있을 수 있습니다.',
              'Interaction may cause mild flashes and changes in brightness or sound.',
            )),
            disclosure(
              tr('Phone Hub 기록 안내', 'PHONE HUB & DATA'),
          el('div', { class: 'copy-stack phone-data-details' },
            el('p', {}, tr(
              'Phone Hub를 사용하면 무작위 장미 번호, 색, 선택적 장미 이름과 설문·자유 글, 작품 연결, 관객이 요청한 캡처가 저장됩니다.',
              'If you use the Phone Hub, it stores a random Rose number, colour, optional rose name, optional survey and free-text responses, work connections, and captures you request.',
            )),
            el('p', {}, tr(
              '사용한 화면·버튼, 읽기·스크롤 진행과 시간, 화면을 떠난 시간, 입력 시간과 수정·삭제 횟수의 요약 기록도 남습니다. 누른 키 하나하나의 원시 입력은 기록하지 않고, 본명과 위치는 묻지 않습니다. Phone Hub를 사용하지 않으려면 현장 스태프에게 이용 가능한 시작 방법을 물어보세요.',
              'It also keeps a summary of the pages and controls used, reading and scroll progress and time, time away from the page, and input timing and edit or delete counts. Raw keystrokes are not recorded, and it does not ask for your legal name or location. If you prefer not to use the Phone Hub, ask staff for the available on-site start method.',
            )),
            el('p', {}, tr(
              '02와 03의 카메라는 작품 반응을 위해 실시간으로 손과 몸을 처리합니다. 카메라 처리 자체와 캡처 저장은 다릅니다. 별도 캡처 동작을 요청한 경우에만 이미지 저장을 시도하며, 업로드가 완료되면 장미 번호로 다시 보여줍니다.',
              'Cameras in Works 02 and 03 process hands and bodies live for the artwork. Live processing is different from saving a capture. Image storage is attempted only after a separate capture request; after a successful upload, the Rose number is used to return it.',
            )),
            el('p', {}, tr(
              'Phone Hub 기록은 작가가 관리하는 Supabase 프로젝트에 저장됩니다. 요청한 캡처는 비공개 저장소에 보관되고, 시간이 제한된 링크로 본인의 Phone Hub에만 표시됩니다. 작가와 승인된 운영자 외에는 전체 기록을 열람하는 인터페이스를 제공하지 않습니다.',
              'Phone Hub records are stored in a Supabase project controlled by the artist. Requested captures are kept in private storage and shown in your Phone Hub through time-limited links. No interface for browsing the complete record is provided to anyone other than the artist and approved operators.',
            )),
            el('p', {}, tr(
              '작품 컴퓨터에는 운영용 기술 로그와 요청한 캡처의 로컬 사본이 남을 수 있습니다. 자동 삭제일은 설정되어 있지 않으며, 전시 평가와 작품 개발을 위해 작가가 수동으로 삭제할 때까지 보관됩니다. 삭제를 원하면 현장의 작가에게 요청하거나 About의 작가 연락 링크를 사용하고, 장미 번호와 대략적인 방문 시간을 알려주세요.',
              'Artwork computers may retain operational technical logs and local copies of requested captures. No automatic deletion date is configured; records are retained for exhibition evaluation and artwork development until the artist deletes them manually. To request deletion, ask the artist on site or use the artist contact link in About, and provide your Rose number and approximate visit time.',
            )),
          ),
          'arrival_data_notice',
            ),
          ),
          'arrival_before_participation',
        ),
      ),
    ),
  ], [
    primaryButton(stackedActionLabel(
      tr('Phone Hub 사용', 'USE PHONE HUB'),
      tr('색을 고릅니다', 'CHOOSE A COLOUR'),
    ), (event) => {
      void beginPhoneHub({ chooseColor: true, button: event.currentTarget });
    }, 'arrival-phone-primary'),
    textButton(tr('Phone Hub와 원격 기록 없이 참여', 'TAKE PART WITHOUT PHONE HUB OR REMOTE DATA'), beginNoRemoteDataPath, 'no-data-entry'),
  ]);
  // 입장 전 읽기는 세션 발급 후 queue에서 해당 세션으로 귀속된다.
  startPageRead('arrival');
}

function screenNoPhoneParticipation() {
  rememberView('no-phone');
  clearStationQuery();
  render([
    globalHeader(),
    el('section', { class: 'screen no-phone-screen' },
      el('span', { class: 'micro-label' }, tr('휴대폰 없음 / 원격 기록 없음', 'NO PHONE / NO REMOTE RECORDING')),
      el('h1', { class: 'screen-title' }, tr('휴대폰 없이 참여합니다', 'TAKE PART WITHOUT THE PHONE HUB')),
      el('p', { class: 'intro-copy' }, tr(
        '이 화면은 현장 참여 방법만 보여줍니다. 원격 관객 세션을 만들거나 행동 로그·캡처를 업로드하지 않습니다. 이 기기에는 현재 안내 화면을 유지하기 위한 최소 상태만 남습니다.',
        'This route shows the on-site participation options only. It does not create a remote audience session or upload interaction logs or captures. Minimal state remains on this device only to keep this guide open.',
      )),
      el('p', { class: 'intro-copy' }, tr(
        '휴대폰을 사용하지 않아도 작품 안의 실시간 카메라 처리와 장치 안전을 위한 로컬 기술 로그는 작동할 수 있습니다. 이것은 Phone Hub의 개인 캡처 저장과 다릅니다.',
        'Without the Phone Hub, live camera processing inside a work and local technical logs used for safe operation may still run. This is different from saving a personal capture to a Rose number.',
      )),
      el('div', { class: 'accessible-participation-list' },
        ...['01', '02', '03', '04'].map((stationId) => el('article', { class: 'access-route-card' },
          el('span', {}, stationId),
          el('h2', {}, workTitle(stationId)),
          el('p', {}, tr(
            MODULES[stationId]?.anonymousStartKo || (stationId === '04' ? '편한 위치에서 원하는 만큼 영상을 봅니다.' : '스태프에게 현장 시작 방법을 요청하세요.'),
            MODULES[stationId]?.anonymousStartEn || (stationId === '04' ? 'Watch the film from any comfortable position for as long as you wish.' : 'Ask a staff member for the on-site start option.'),
          )),
        )),
      ),
      el('p', { class: 'access-support-note' }, tr(
        '만지기, 현장 입력 사용하기, 바라보고 듣기 모두 유효한 참여입니다. 도움이 필요하면 운영 시간 동안 현장에 있는 작가에게 편한 방식을 알려주세요.',
        'Touching, using an on-site input, and watching or listening are all valid ways to take part. The artist is on site during opening hours; tell her what works best for you.',
      )),
      textButton(tr('접근성·감각 정보', 'ACCESS & SENSORY INFORMATION'), screenAccessGuide),
      textButton(tr('Phone Hub를 사용하고 싶습니다', 'I WANT TO USE THE PHONE HUB'), screenArrival),
    ),
  ]);
}

function screenAccessGuide() {
  rememberView('access');
  clearStationQuery();
  const accessItem = (titleKo, titleEn, bodyKo, bodyEn) => el('section', { class: 'access-guide-item' },
    el('h2', {}, tr(titleKo, titleEn)),
    el('p', {}, tr(bodyKo, bodyEn)),
  );
  render([
    globalHeader(),
    el('article', { class: 'screen access-guide-screen' },
      el('span', { class: 'micro-label' }, tr('접근성·감각 안내 / 멜버른', 'ACCESS & SENSORY GUIDE / MELBOURNE')),
      el('h1', { class: 'screen-title' }, tr('접근성·감각 정보', 'ACCESS & SENSORY INFORMATION')),
      el('p', { class: 'access-venue-address' }, `${MELBOURNE.venue} · ${MELBOURNE.address}`),
      el('p', { class: 'intro-copy' }, tr(
        '원하는 방식과 속도로 참여하세요. 모든 작품을 완료할 필요가 없으며, 언제든 쉬거나 나갔다 다시 들어올 수 있습니다.',
        'Take part in the way and at the pace that works for you. You do not need to complete every work, and you may pause, leave or return at any time.',
      )),
      accessItem('빛과 움직임', 'LIGHT AND MOVEMENT', '공간은 어둡고 움직이는 추상 영상과 글리치, 밝기 변화가 있습니다. Reduce motion은 Phone Hub 애니메이션을 줄이며 실제 프로젝션의 움직임은 멈추지 않습니다.', 'The room is dark and includes moving abstract imagery, glitch and changes in brightness. Reduce Motion limits Phone Hub animation; it does not stop movement in the projected artworks.'),
      accessItem('소리', 'SOUND', '작품은 변화하는 공간 음향을 사용합니다. 03의 소리는 헤드폰이 아니라 스피커로 재생되고, 04 영상은 무음입니다.', 'The works use changing room sound. Work 03 plays through speakers rather than headphones. Work 04 is silent.'),
      accessItem('꽃 알레르기·접촉', 'FLOWER ALLERGY, SENSITIVITY AND TOUCH', '실제 장미를 사용하므로 향, 꽃가루, 가시와 물이 있을 수 있습니다. 꽃, 꽃가루 또는 향에 알레르기나 민감성이 있다면 장미에서 편한 거리를 유지하고 작가에게 알려주세요. 장미나 다른 사람을 만지는 것은 선택이며, 관람만 하는 방식도 가능합니다.', 'The exhibition uses real roses, so there may be fragrance, pollen, thorns and water. If you have an allergy or sensitivity to flowers, pollen or fragrance, keep a comfortable distance from the roses and tell the artist. Touching a rose or another person is optional; observation is also available.'),
      accessItem('카메라', 'CAMERA PROCESSING', '02와 03은 실시간 손·몸 처리를 사용합니다. 캡처는 별도의 관객 요청 동작이 있을 때만 저장됩니다. 카메라 처리가 불편하다면 편한 거리에서 관람하는 방법을 스태프와 상의할 수 있으며, 캡처를 요청할 필요는 없습니다.', 'Works 02 and 03 use live hand or body processing. A capture is stored only after a separate visitor request. If camera processing is a concern, ask staff about observing from a comfortable position; you do not need to request a capture.'),
      accessItem('이동·좌석', 'MOBILITY AND SEATING', 'Mission to Seafarers의 정확한 단차 없는 입구, 화장실, 문 폭, 좌석과 작품 사이 동선은 현장 확인 후 갱신됩니다. 현재 확인되지 않은 공간 정보는 약속하지 않습니다.', 'The exact step-free entrance, toilet, door width, seating and route between works at Mission to Seafarers will be updated after the on-site check. Unverified spatial access is not promised here.'),
      accessItem('휴대폰 없이 참여', 'NO-PHONE PARTICIPATION', 'QR, NFC, Phone Hub, 이름, 캡처와 설문은 필수가 아닙니다. 작품 01, 02, 03에서 현재 이용 가능한 현장 시작 방법은 작가에게 확인할 수 있고, 04는 누구나 바로 관람할 수 있습니다.', 'QR, NFC, the Phone Hub, naming, captures and survey are optional. Ask the artist which on-site start method is currently available for Works 01, 02 and 03. Anyone may watch Work 04 directly.'),
      accessItem('현장 도움', 'ON-SITE ASSISTANCE', '작가는 전시 운영 시간 동안 현장에 있습니다. Phone Hub, 작품 시작 방법, 감각적·신체적 접근 방법에 도움이 필요하면 작가에게 요청할 수 있습니다.', 'The artist is on site during opening hours. You can ask her for help with the Phone Hub, starting a work, or finding a sensory or physical approach that works for you.'),
      accessItem('조용히 쉴 공간', 'QUIET SPACE', '조용히 쉬어갈 공간은 현장 확인 중입니다. 확인 전에는 안뜰이나 다른 장소를 조용한 공간으로 확정하지 않습니다. 당일 가장 조용한 장소가 필요하면 작가에게 물어보세요.', 'A quiet rest space is still being confirmed. The courtyard or any other area will not be identified as a quiet space until it has been checked. Ask the artist for the calmest available place on the day.'),
      el('button', {
        class: 'secondary-action large-text-toggle',
        type: 'button',
        onclick: toggleLargeText,
        ...largeTextControlAttributes(),
      }, largeTextControlLabel(true)),
      el('button', {
        class: 'secondary-action reduce-motion-toggle',
        type: 'button',
        onclick: toggleReduceMotion,
        ...reduceMotionControlAttributes(),
      }, reduceMotionControlLabel(true)),
      systemReduceMotionEnabled() ? el('p', { class: 'input-note', role: 'status' }, tr(
        '기기의 움직임 줄이기 설정을 따르고 있습니다. 변경하려면 기기 설정을 이용하세요.',
        'The Phone Hub is following your device’s Reduce Motion setting. Change it in your device settings.',
      )) : null,
      el('p', { class: 'access-fringe-statement' }, MELBOURNE.accessCredit),
      textButton('HOME', () => {
        const session = ensureSession();
        if (isRegistered(session)) screenHome();
        else screenArrival();
      }),
    ),
  ]);
}

function screenPersonalSetup() {
  const session = ensureSession();
  rememberView('setup');
  applySessionColor(session.color || '#F25C94');

  let selectedColor = session.color_locked ? session.color : (session.color || '#F25C94');
  const openedAt = performance.now();
  let colorChangeCount = 0;
  const error = el('p', { class: 'field-error', 'aria-live': 'polite' });
  const selectedColourText = el('output', {
    class: 'selected-colour-text',
    for: 'rose-colour-picker',
    'aria-live': 'polite',
  }, tr(`선택한 색: ${roseColourLabel(selectedColor)} ${selectedColor.toUpperCase()}`, `Selected colour: ${roseColourLabel(selectedColor)} ${selectedColor.toUpperCase()}`));
  const colorPicker = el('input', {
    id: 'rose-colour-picker',
    class: 'continuous-color-field',
    type: 'color',
    value: selectedColor,
    'aria-label': tr('나의 장미 색 선택', 'Choose my rose colour'),
    oninput: (event) => {
      colorChangeCount += 1;
      selectedColor = event.currentTarget.value.toUpperCase();
      applySessionColor(selectedColor);
      selectedColourText.textContent = tr(`선택한 색: ${roseColourLabel(selectedColor)} ${selectedColor}`, `Selected colour: ${roseColourLabel(selectedColor)} ${selectedColor}`);
      error.textContent = '';
    },
  });

  render([
    globalHeader(),
    el('section', { class: 'screen registration-screen' },
      el('div', { class: 'screen-kicker' },
        el('span', {}, tr('나의 장미 / 색', 'MY ROSE / COLOUR')),
        el('span', {}, `${tr('장미 번호', 'ROSE NO.')} ${session.display_record_no}`),
      ),
      el('h1', { class: 'screen-title' }, tr('장미 색을 정합니다', 'CHOOSE THE COLOUR OF YOUR ROSE')),
      roseVisual('registration', tr('나의 장미 미리보기', 'MY ROSE PREVIEW')),
      el('div', { class: 'input-group color-group' },
        el('label', { for: 'rose-colour-picker' }, tr('나의 장미 색', 'MY ROSE COLOUR')),
        colorPicker,
        selectedColourText,
        error,
      ),
      el('div', { class: 'rose-setup-guidance' },
        el('p', {},
          el('span', {}, tr('오늘의 여정을 표시할 색을 고르세요.', 'Choose a colour for your journey.')),
          el('span', {}, tr('입장한 뒤에는 바꿀 수 없습니다.', 'You cannot change it after entering.')),
        ),
        el('p', {}, tr(
          '원한다면 여정 중에 장미의 이름을 지을 수 있습니다.',
          'Name your rose during your journey if you wish.',
        )),
      ),
    ),
  ], [
    primaryButton(tr('계속', 'CONTINUE'), () => {
      if (!selectedColor) {
        error.textContent = tr('나의 장미 색을 골라주세요.', 'Choose my rose colour.');
        return;
      }
      error.textContent = '';
      const current = ensureSession();
      updateSession({
        nickname: '',
        color: selectedColor,
        color_locked: true,
        emotional_name: current.name_source === 'visitor' ? current.emotional_name : '',
        name_source: current.name_source === 'visitor' ? 'visitor' : 'none',
      });
      logEvent('specimen_registered', {
        color: selectedColor,
        selection_duration_ms: Math.round(performance.now() - openedAt),
        color_change_count: colorChangeCount,
        registration_mode: colorChangeCount ? 'manual_color' : 'random_preset',
      }, '00');
      routeAfterRoseSetup();
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
      openModuleFromNavigation(stationId, 'floorplan');
    },
  },
    el('span', { class: 'hotspot-number' }, String(Number(stationId))),
    el('span', { class: 'hotspot-label' }, workTitle(stationId)),
    visited ? el('span', { class: 'hotspot-complete', 'aria-hidden': 'true' }, '✓') : null,
  );
}

function floorplanRouteOrder(session, onSelectTarget) {
  const routeButtons = [];
  const routeStep = (stationId) => {
    const visited = getCompletedStations(session).includes(stationId) || Boolean(traceSummaryForStation(stationId));
    const button = el('button', {
      class: `route-order-step${visited ? ' is-visited' : ''}`,
      type: 'button',
      'aria-pressed': 'false',
      onclick: () => {
        routeButtons.forEach((item) => {
          item.classList.remove('is-selected');
          item.setAttribute('aria-pressed', 'false');
        });
        button.classList.add('is-selected');
        button.setAttribute('aria-pressed', 'true');
        onSelectTarget?.(stationId);
      },
      'aria-label': tr(
        `${stationId} ${workTitle(stationId)} 위치 표시 · ${moduleStatus(session, stationId)}`,
        `Show ${stationId} ${workTitle(stationId)} on the floor plan · ${moduleStatus(session, stationId)}`,
      ),
    },
      el('strong', {}, stationId),
      visited ? el('span', { class: 'route-step-check', 'aria-hidden': 'true' }, '✓') : null,
    );
    routeButtons.push(button);
    return button;
  };

  return el('nav', { class: 'floorplan-route-order', 'aria-label': tr('권장 관람 순서', 'Suggested route') },
    el('span', {
      class: 'route-order-step route-order-entry is-visited',
      'aria-label': tr('00 입구 · 다녀옴', '00 Entry · visited'),
    },
      el('strong', {}, '00'),
      el('span', { class: 'route-step-label' }, tr('입구', 'ENTRY')),
      el('span', { class: 'route-step-check', 'aria-hidden': 'true' }, '✓'),
    ),
    el('span', { class: 'route-order-arrow', 'aria-hidden': 'true' }, '→'),
    routeStep('01'),
    el('span', { class: 'route-order-arrow', 'aria-hidden': 'true' }, '→'),
    routeStep('02'),
    el('span', { class: 'route-order-arrow', 'aria-hidden': 'true' }, '→'),
    routeStep('03'),
    el('span', { class: 'route-order-arrow', 'aria-hidden': 'true' }, '→'),
    routeStep('04'),
    el('span', { class: 'route-order-arrow', 'aria-hidden': 'true' }, '→'),
    el('button', {
      class: 'route-order-step route-order-exit',
      type: 'button',
      onclick: screenExitJourney,
      'aria-label': tr('05 출구와 설문', '05 Exit and survey'),
    },
      el('strong', {}, '05'),
      el('span', { class: 'route-step-label' }, tr('출구', 'EXIT')),
    ),
  );
}

function melbourneProvisionalFloorplan(session) {
  const layout = CONFIG.VENUE_LAYOUT || {};
  let planAngle = 0;
  let planTilt = 42;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startAngle = 0;
  let startTilt = 42;
  let dragging = false;
  const mapTargets = new Map();

  const positionsAreConfirmed = Boolean(layout.positionsConfirmed);
  const displayedPositions = positionsAreConfirmed
    ? (layout.works || {})
    : (layout.provisionalWorks || {});
  const positionEntries = Object.entries(displayedPositions)
    .filter(([, position]) => Number.isFinite(position?.x) && Number.isFinite(position?.y));
  const accessPreview = layout.provisionalAccessPreview || {};
  const previewRoutePoints = Array.isArray(accessPreview.routePoints)
    ? accessPreview.routePoints.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    : [];
  const toiletRoutePoints = Array.isArray(accessPreview.toiletRoutePoints)
    ? accessPreview.toiletRoutePoints.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    : [];
  const courtyardRoutePoints = Array.isArray(accessPreview.courtyardRoutePoints)
    ? accessPreview.courtyardRoutePoints.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    : [];

  const marker = ([stationId, position]) => {
    const visited = getCompletedStations(session).includes(stationId) || Boolean(traceSummaryForStation(stationId));
    const connected = session.connected_station === stationId;
    const button = el('button', {
      class: `melbourne-confirmed-marker${positionsAreConfirmed ? ' is-confirmed' : ' is-provisional'}${visited ? ' is-visited' : ''}${connected ? ' is-connected' : ''}`,
      type: 'button',
      'data-floorplan-station': stationId,
      'data-wall': position.wall || '',
      style: { left: `${position.x}%`, top: `${position.y}%` },
      onclick: (event) => {
        event.stopPropagation();
        logEvent('floorplan_module_click', {
          station_id: stationId,
          via: positionsAreConfirmed ? 'melbourne_confirmed_floorplan' : 'melbourne_provisional_floorplan',
          provisional: !positionsAreConfirmed,
        }, stationId);
        openModuleFromNavigation(stationId, positionsAreConfirmed ? 'melbourne_confirmed_floorplan' : 'melbourne_provisional_floorplan');
      },
      'aria-label': `${stationId} ${workTitle(stationId)}, ${moduleStatus(session, stationId)}`,
    },
      el('span', { class: 'melbourne-map-number' }, stationId),
      el('span', { class: 'melbourne-map-name' }, workTitle(stationId)),
      visited ? el('span', { class: 'melbourne-map-check', 'aria-hidden': 'true' }, '✓') : null,
    );
    mapTargets.set(stationId, button);
    return button;
  };

  const markerDepth = ([stationId, position]) => {
    const visited = getCompletedStations(session).includes(stationId) || Boolean(traceSummaryForStation(stationId));
    const connected = session.connected_station === stationId;
    return [
      el('span', {
        class: `melbourne-marker-footprint${visited ? ' is-visited' : ''}${connected ? ' is-connected' : ''}`,
        style: { left: `${position.x}%`, top: `${position.y}%` },
        'aria-hidden': 'true',
      }),
      el('span', {
        class: `melbourne-marker-stem${visited ? ' is-visited' : ''}${connected ? ' is-connected' : ''}`,
        style: { left: `${position.x}%`, top: `${position.y}%` },
        'aria-hidden': 'true',
      }),
    ];
  };

  const accessPoint = (point, className) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    const label = session.lang === 'ko' ? point.labelKo : point.labelEn;
    return el('span', {
      class: `access-preview-point ${className}`,
      style: { left: `${point.x}%`, top: `${point.y}%` },
    }, label || '');
  };

  const routeGraphics = (points, layer, arrow = '') => {
    const segments = points.slice(0, -1).map((point, index) => {
      const next = points[index + 1];
      const dx = next.x - point.x;
      const scaledDy = (next.y - point.y) * (2 / 3);
      const length = Math.hypot(dx, scaledDy);
      const angle = Math.atan2(scaledDy, dx) * (180 / Math.PI);
      return el('span', {
        class: `access-preview-route-segment access-layer-${layer}`,
        style: {
          left: `${point.x}%`,
          top: `${point.y}%`,
          width: `${length}%`,
          transform: `rotate(${angle}deg)`,
        },
        'aria-hidden': 'true',
      });
    });
    const nodes = points.map((point) => el('span', {
      class: `access-preview-route-node access-layer-${layer}`,
      style: { left: `${point.x}%`, top: `${point.y}%` },
      'aria-hidden': 'true',
    }));
    const last = points.at(-1);
    const routeArrow = arrow && last ? el('span', {
      class: `access-preview-route-arrow access-layer-${layer}`,
      style: { left: `${last.x}%`, top: `${last.y}%` },
      'aria-hidden': 'true',
    }, arrow) : null;
    return [...segments, ...nodes, routeArrow].filter(Boolean);
  };

  const workRouteGraphics = routeGraphics(previewRoutePoints, 'route');
  const toiletRouteGraphics = routeGraphics(toiletRoutePoints, 'toilet');
  const courtyardRouteGraphics = routeGraphics(courtyardRoutePoints, 'courtyard');

  const permanentFixture = (point, className, visual, accessibleLabel, visibleLabel = accessibleLabel) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    return el('span', {
      class: `floorplan-permanent-fixture ${className}`,
      style: { left: `${point.x}%`, top: `${point.y}%` },
      role: 'img',
      'aria-label': accessibleLabel,
    }, visual, visibleLabel ? el('span', { class: 'floorplan-fixture-label' }, visibleLabel) : null);
  };

  const permanentFixtures = el('div', { class: 'floorplan-permanent-fixtures' },
    permanentFixture(
      accessPreview.roseInstallation,
      'floorplan-rose-installation',
      el('span', { class: 'floorplan-standing-rose', 'aria-hidden': 'true' },
        roseSpecimenImage('', 'floorplan-standing-rose-image'),
        el('i', { class: 'floorplan-standing-rose-tint' }),
      ),
      tr('01 앞 장미 설치물', 'ROSE INSTALLATION AT 01'),
      '',
    ),
    permanentFixture(
      accessPreview.entryExit,
      'floorplan-entry-fixture access-entry-exit',
      el('span', { class: 'floorplan-entry-symbol', 'aria-hidden': 'true' }, '⇅'),
      tr('입구 / 출구 · 피드백', 'ENTRY / EXIT · FEEDBACK'),
    ),
  );

  const accessOverlay = el('div', {
    class: 'floorplan-access-overlay',
    id: 'floorplan-access-overlay',
    'aria-hidden': 'true',
  },
    ...workRouteGraphics,
    ...toiletRouteGraphics,
    ...courtyardRouteGraphics,
    accessPoint(accessPreview.toilet, 'access-toilet access-layer-toilet'),
    accessPoint(accessPreview.courtyard, 'access-courtyard access-layer-courtyard'),
    el('span', { class: 'access-preview-label access-layer-route' }, tr('이동 경로', 'ROUTE')),
  );

  const rotor = el('div', { class: 'melbourne-rectangular-rotor' },
    el('div', { class: 'melbourne-room-floor', 'aria-hidden': 'true' }),
    el('div', { class: 'melbourne-rectangular-walls', 'aria-hidden': 'true' },
      el('span', { class: 'melbourne-room-wall wall-north' }),
      el('span', { class: 'melbourne-room-wall wall-east' }),
      el('span', { class: 'melbourne-room-wall wall-south' }),
      el('span', { class: 'melbourne-room-wall wall-west' }),
    ),
    permanentFixtures,
    accessOverlay,
    ...positionEntries.flatMap(markerDepth),
    ...positionEntries.map(marker),
  );

  const counter = el('span', { class: 'frame-counter' }, '000° · 42°');
  const updatePlanView = ({ log = false } = {}) => {
    rotor.style.setProperty('--plan-angle', `${planAngle}deg`);
    rotor.style.setProperty('--plan-tilt', `${planTilt}deg`);
    counter.textContent = `${String(Math.round(planAngle)).padStart(3, '0')}° · ${String(Math.round(planTilt)).padStart(2, '0')}°`;
    if (log) logEvent('floorplan_rotate', {
      venue: 'mission_to_seafarers',
      provisional: !layout.positionsConfirmed,
      angle: Math.round(planAngle),
      tilt: Math.round(planTilt),
    }, '00');
  };
  const adjustView = (angleDelta = 0, tiltDelta = 0) => {
    planAngle = (planAngle + angleDelta + 3600) % 360;
    planTilt = Math.max(18, Math.min(68, planTilt + tiltDelta));
    updatePlanView({ log: true });
  };
  const resetView = () => {
    planAngle = 0;
    planTilt = 42;
    updatePlanView({ log: true });
  };

  const dragHint = el('div', { class: 'floorplan-drag-hint', 'aria-hidden': 'true' },
    el('span', { class: 'floorplan-hand-icon' }, '☝'),
    el('span', {}, tr('드래그하여 보기 회전', 'TOUCH & DRAG TO ROTATE')),
  );
  let stage;
  const endIdleView = () => {
    stage?.classList.add('has-interacted');
    dragHint.hidden = true;
  };

  stage = el('div', {
    class: 'floorplan-stage melbourne-floorplan-stage is-idle',
    tabindex: '0',
    'aria-label': tr(
      'Mission to Seafarers 평면도. 드래그하거나 키보드 화살표로 회전할 수 있습니다. 현장 접근 정보에서 표시할 항목을 고를 수 있습니다.',
      'Floor plan for Mission to Seafarers. Drag or use the keyboard arrow keys to rotate it. Open Venue Access Details to choose what is shown.',
    ),
    onkeydown: (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); endIdleView(); adjustView(-15, 0); }
      if (event.key === 'ArrowRight') { event.preventDefault(); endIdleView(); adjustView(15, 0); }
      if (event.key === 'ArrowUp') { event.preventDefault(); endIdleView(); adjustView(0, -5); }
      if (event.key === 'ArrowDown') { event.preventDefault(); endIdleView(); adjustView(0, 5); }
      if (event.key === 'Home') { event.preventDefault(); endIdleView(); resetView(); }
    },
    onpointerdown: (event) => {
      if (event.button !== 0 || event.target.closest('button, a')) return;
      endIdleView();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startAngle = planAngle;
      startTilt = planTilt;
    },
    onpointermove: (event) => {
      if (pointerId !== event.pointerId) return;
      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      if (!dragging) {
        if (Math.hypot(deltaX, deltaY) < 8 || Math.abs(deltaX) < Math.abs(deltaY)) return;
        dragging = true;
        stage.classList.add('is-dragging');
        stage.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
      planAngle = (startAngle + (deltaX * .9) + 3600) % 360;
      planTilt = Math.max(18, Math.min(68, startTilt - (deltaY * .22)));
      updatePlanView();
    },
    onpointerup: (event) => {
      if (pointerId !== event.pointerId) return;
      if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      if (dragging) updatePlanView({ log: true });
      pointerId = null;
      dragging = false;
      stage.classList.remove('is-dragging');
    },
    onpointercancel: () => {
      pointerId = null;
      dragging = false;
      stage.classList.remove('is-dragging');
    },
  },
    rotor,
    dragHint,
    el('button', {
      class: 'floorplan-reset-icon floorplan-reset-corner',
      type: 'button',
      onclick: (event) => { event.stopPropagation(); endIdleView(); resetView(); },
      'aria-label': tr('평면도 기본 각도로', 'Reset floor plan angle'),
    }, '↻'),
    el('div', { class: 'turntable-ui' },
      el('span', { class: 'view-mode' }, tr('드래그하여 보기 회전', 'DRAG TO ROTATE VIEW')),
      counter,
    ),
  );

  const accessLayerClasses = [
    'show-access-entry-exit',
    'show-access-route',
    'show-access-toilet',
    'show-access-courtyard',
  ];
  const accessLayerButtons = [];
  const accessLayerStatus = el('p', { class: 'access-layer-status', role: 'status', 'aria-live': 'polite' });
  let activeAccessLayer = null;
  let highlightedMapTarget = null;
  const clearRouteHighlight = () => {
    highlightedMapTarget?.classList.remove('is-route-highlighted');
    highlightedMapTarget = null;
  };
  const clearAccessLayer = () => {
    stage.classList.remove(...accessLayerClasses);
    activeAccessLayer = null;
    accessLayerButtons.forEach((button) => button.setAttribute('aria-pressed', 'false'));
    accessLayerStatus.textContent = '';
  };
  const highlightFloorplanTarget = (stationId) => {
    clearAccessLayer();
    clearRouteHighlight();
    const target = mapTargets.get(stationId);
    if (!target) return;
    highlightedMapTarget = target;
    target.classList.add('is-route-highlighted');
    endIdleView();
    logEvent('floorplan_route_target_highlighted', { station_id: stationId }, '00');
  };
  const selectAccessLayer = (layer, label) => {
    const shouldClear = activeAccessLayer === layer;
    clearRouteHighlight();
    clearAccessLayer();
    if (shouldClear) return;
    activeAccessLayer = layer;
    stage.classList.add(`show-access-${layer}`);
    accessLayerButtons.forEach((button) => {
      button.setAttribute('aria-pressed', button.dataset.accessLayer === layer ? 'true' : 'false');
    });
    accessLayerStatus.textContent = tr(`${label}만 지도에 표시합니다.`, `Showing ${label} only on the floor plan.`);
    logEvent('floorplan_access_layer_selected', { layer }, null);
  };
  const accessLayerButton = (layer, ko, en) => {
    const label = tr(ko, en);
    const button = el('button', {
      class: 'access-layer-button',
      type: 'button',
      'data-access-layer': layer,
      'aria-pressed': 'false',
      'aria-controls': 'floorplan-access-overlay',
      onclick: () => selectAccessLayer(layer, label),
    }, label);
    accessLayerButtons.push(button);
    return button;
  };
  let accessOpenedAt = null;
  const accessDetails = el('details', {
    class: 'disclosure floorplan-access-disclosure',
    ontoggle: (event) => {
      const open = event.currentTarget.open;
      const dwellMs = !open && accessOpenedAt !== null
        ? Math.round(performance.now() - accessOpenedAt)
        : null;
      if (open) accessOpenedAt = performance.now();
      logEvent(`floorplan_access_details_${open ? 'open' : 'close'}`, { dwell_ms: dwellMs }, null);
      if (!open) {
        clearAccessLayer();
        accessOpenedAt = null;
      }
    },
  },
    el('summary', {}, tr('현장 접근 정보', 'VENUE ACCESS DETAILS'), el('span', { 'aria-hidden': 'true' }, '+')),
    el('div', { class: 'disclosure-body' },
      el('div', { class: 'access-layer-controls', role: 'group', 'aria-label': tr('지도에서 볼 접근 정보', 'Access information to show on the floor plan') },
        accessLayerButton('entry-exit', '입구 / 출구', 'ENTRY / EXIT'),
        accessLayerButton('route', '이동 경로', 'ROUTE'),
        accessLayerButton('toilet', '화장실 · 나가서 오른쪽', 'TOILET · EXIT RIGHT'),
        accessLayerButton('courtyard', '코트야드 · 나가서 왼쪽', 'COURTYARD · EXIT LEFT'),
      ),
      accessLayerStatus,
    ),
  );

  const planPanel = el('div', {
    class: 'floorplan-tab-panel',
    id: 'floorplan-panel',
    role: 'tabpanel',
    'aria-labelledby': 'floorplan-tab',
  },
    stage,
    accessDetails,
  );

  const listPanel = el('div', {
    class: 'floorplan-tab-panel work-list-tab-panel',
    id: 'work-list-panel',
    role: 'tabpanel',
    'aria-labelledby': 'work-list-tab',
    hidden: true,
  },
    el('div', { class: 'module-index-list home-primary-modules' },
      ...['01', '02', '03', '04'].map((stationId) => el('button', {
        class: 'module-index-row module-index-key work-list-row',
        type: 'button',
        onclick: () => openModuleFromNavigation(stationId, 'home_list_tab'),
        'aria-label': `${stationId} ${workTitle(stationId)}, ${moduleStatus(session, stationId)}`,
      },
        el('span', { class: 'module-number' }, stationId),
        el('strong', { class: 'work-list-title' }, workTitle(stationId)),
        getCompletedStations(session).includes(stationId) || Boolean(traceSummaryForStation(stationId))
          ? el('span', { class: 'visit-status' }, tr('다녀옴', 'VISITED'))
          : null,
      )),
    ),
  );

  let selectedTab = 'plan';
  let planTab;
  let listTab;
  const selectTab = (next) => {
    selectedTab = next === 'list' ? 'list' : 'plan';
    const planSelected = selectedTab === 'plan';
    planPanel.hidden = !planSelected;
    listPanel.hidden = planSelected;
    planTab.setAttribute('aria-selected', planSelected ? 'true' : 'false');
    planTab.tabIndex = planSelected ? 0 : -1;
    listTab.setAttribute('aria-selected', planSelected ? 'false' : 'true');
    listTab.tabIndex = planSelected ? -1 : 0;
    logEvent('home_work_view_selected', { view: selectedTab }, '00');
  };
  const onTabKeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const next = selectedTab === 'plan' ? 'list' : 'plan';
    selectTab(next);
    (next === 'plan' ? planTab : listTab).focus();
  };
  planTab = el('button', {
    id: 'floorplan-tab',
    type: 'button',
    role: 'tab',
    'aria-controls': 'floorplan-panel',
    'aria-selected': 'true',
    onclick: () => selectTab('plan'),
    onkeydown: onTabKeydown,
  }, tr('평면도', 'FLOOR PLAN'));
  listTab = el('button', {
    id: 'work-list-tab',
    type: 'button',
    role: 'tab',
    'aria-controls': 'work-list-panel',
    'aria-selected': 'false',
    tabindex: '-1',
    onclick: () => selectTab('list'),
    onkeydown: onTabKeydown,
  }, tr('작품 목록', 'WORK LIST'));

  return el('section', {
    class: 'melbourne-floorplan-section',
    'aria-labelledby': 'melbourne-floorplan-heading',
  },
    el('h2', { class: 'screen-title compact-title', id: 'melbourne-floorplan-heading' }, tr('평면도', 'FLOOR PLAN')),
    el('p', { class: 'melbourne-floorplan-address' }, `${MELBOURNE.venue} · ${MELBOURNE.address}`),
    floorplanRouteOrder(session, highlightFloorplanTarget),
    el('div', { class: 'floorplan-tabs', role: 'tablist', 'aria-label': tr('작품 위치 보기', 'Choose how to view the works') }, planTab, listTab),
    planPanel,
    listPanel,
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
    src: versionedAssetUrl('./assets/floorplan/gallery-room-1-plan.webp'),
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

  render([
    globalHeader(),
    el('section', { class: 'screen home-screen' },
      personalHeader(),
      el('section', { class: 'project-intro home-project-lead home-project-compact' },
        el('span', { class: 'micro-label' }, `${MELBOURNE.city.toUpperCase()} / ${MELBOURNE.year}`),
        el('h1', { class: 'screen-title compact-title' }, MELBOURNE.title),
        el('p', {}, tr(
          '바니타스는 아름다움과 죽음을 한 이미지 안에 함께 둡니다. 생화 장미, 움직이는 이미지, 빛과 소리로 이어진 네 작품은 내가 밀어내는 것과, 그 남은 것과 다시 맺을 관계를 묻습니다.',
          'Vanitas holds beauty and mortality within the same image. Through living roses, moving images, light and sound, four works ask what we push away within ourselves, and what relationship we might choose with what remains.',
        )),
      ),
      melbourneProvisionalFloorplan(session),
      textButton(tr('프로젝트 자세히 보기', 'READ MORE ABOUT THE PROJECT'), () => screenAboutProject('about-intro'), 'home-about-primary'),
      el('section', { class: 'home-direct-actions', 'aria-label': tr('나의 Phone Hub', 'My Phone Hub') },
        el('h2', {}, tr('나의 장미', 'MY ROSE')),
        primaryButton(tr('나의 장미 보기', 'VIEW MY ROSE'), () => screenFinalSpecimen()),
        textButton(tr('경험 남기기', 'SHARE FEEDBACK'), screenSurvey, 'home-survey-link'),
      ),
      isTestMode() ? testPreviewPanel({ home: true }) : null,
    ),
  ]);
}

function scrollToAboutSection(sectionId, smooth = true) {
  const target = document.getElementById(sectionId);
  if (!target) return;
  target.scrollIntoView({ behavior: smooth && !reduceMotionEnabled() ? 'smooth' : 'auto', block: 'start' });
  logEvent('about_anchor_selected', { section_id: sectionId }, '00');
}

const ABOUT_MEDIA_BY_SECTION = {
  'about-intro': 'arrival_hero.png',
  'about-work-01': 'module_01_naming_hero.jpeg',
  'about-work-02': 'module_02_reenactment_hero.png',
  'about-work-03': 'module_03_mourning_hero.png',
  'about-work-04': 'module_04_archive_hero.png',
};

function aboutSection({ id, index, title, lead, body = [], deeper = [] }) {
  const mediaFile = ABOUT_MEDIA_BY_SECTION[id];
  return el('section', { class: 'about-section', id },
    el('span', { class: 'about-section-index' }, index),
    el('h2', {}, title),
    el('p', { class: 'about-section-lead' }, lead),
    mediaFile ? el('figure', { class: 'about-section-media' },
      assetFrame(mediaFile, {
        className: 'about-documentation-asset',
        label: `${title}, ${tr('전시 기록', 'exhibition documentation')}`,
        type: 'EXHIBITION DOCUMENTATION / 2026',
      }),
      el('figcaption', {}, tr('이전 전시 기록 · 서울, 2026', 'Previous presentation · Seoul, 2026')),
    ) : null,
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

// Preserved Seoul curatorial copy. Melbourne uses the bilingual content-driven
// implementation below, so the original operating text remains recoverable.
function screenAboutProjectSeoulArchive(initialSection = null) {
  const session = ensureSession();
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
      textButton('HOME', () => { void goHome(); }, 'about-back'),
      el('header', { class: 'about-hero' },
        el('span', { class: 'micro-label' }, 'META ROSE 2026 / THE FUNERAL'),
        el('h1', {}, tr('프로젝트에 대하여', 'ABOUT THE PROJECT')),
        el('p', {}, '〈오늘 나는 죽인다, 나를〉'),
        el('p', { class: 'about-hero-lead' }, tr(
          '내가 죽인 나를 위해 치르는 장례식. 꽃과 스켈레톤, 사람의 손과 기계, 살리는 행동과 죽이는 행동이 한 시간 안에 함께 놓입니다.',
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
          '이 작품은 스스로 밀어내거나 없애려 한 나의 면을 하나의 개인적 결함으로만 보지 않습니다. 완벽함을 요구하는 시선, 쓸모와 생산성을 기준으로 자신을 평가하는 습관, 좋아 보이는 모습만 남기려는 이미지 문화가 한 사람의 내부에서 어떻게 작동하는지를 함께 봅니다.',
          '장례식이라는 형식은 끝을 선언하기 위해서가 아니라, 평소에는 보이지 않던 관계를 잠시 드러내기 위해 사용됩니다. 누가 죽였고, 무엇이 죽었으며, 남은 사람은 누구인지. 여기서는 세 질문의 답이 모두 ‘나’일 수 있습니다.',
          '이 작품에서 죽인 사람과 죽은 사람, 그리고 장례 뒤에 남은 사람은 모두 나일 수 있습니다. 그래서 이 장례는 누군가를 완전히 보내기 위한 의식이 아닙니다. 내가 없앴다고 믿은 것이 어떤 모습으로 돌아오는지 보고, 그 존재와 맺고 있던 관계를 다시 바라보는 자리입니다.',
          '작품은 불편했던 나의 면이 사라졌다고 선언하지 않습니다. 대신 그 면을 제거해야만 앞으로 갈 수 있다는 생각을 멈추고, 그 안에 함께 있었던 다른 얼굴까지 같은 시간에 놓아봅니다.',
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
          '그래서 여기의 장미와 스켈레톤은 단순한 장례 장식이나 고딕 이미지가 아닙니다. 장미는 만져야 소리를 얻고, 스켈레톤은 관객에게 손을 내밉니다. 정물화 속에서 멈춰 있던 상징이 관객의 행동을 기다리는 물체로 바뀝니다.',
          '바니타스가 죽음을 기억하게 했다면, 이 작업은 자신이 무엇을 죽이고 있는지 보게 합니다. 기억은 관찰로 끝나지 않고, 무엇을 살리고 무엇에 물을 줄지 다시 고르는 행동으로 이어집니다.',
          '바니타스의 꽃은 피어 있는 순간에도 시들고 있고, 해골은 한때 살아 움직였던 몸의 시간을 품습니다. 이 작품은 서로 반대되는 상태가 한 화면 안에 동시에 존재하는 구조를 가져오되, 죽음을 멀리 있는 운명으로만 다루지 않습니다.',
          '살아 있으면서도 자기 안의 일부를 반복해서 제거하고, 말하지 못하게 하고, 존재하지 않았던 것처럼 만드는 일에 주목합니다. 장미와 스켈레톤은 그 질문을 바라보는 상징에서 관객의 선택을 받아 움직이는 몸으로 바뀝니다.',
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
          '장미 이름도 같은 구조를 가집니다. 관객은 먼저 자신이 죽여 온 한 면을 쓰고, 그와 동시에 존재했던 반대편의 면을 씁니다. 두 번째 문장은 첫 번째를 미화하거나 취소하지 않습니다. 서로 모순되는 두 얼굴이 한 이름 안에 함께 남습니다.',
        ],
        deeper: [
          '작품의 끝은 부정적인 면을 제거하고 긍정적인 면이 승리하는 장면이 아닙니다. 죽음 뒤에는 리스폰이 있고, 이전의 흔적은 완전히 사라지지 않습니다. 살아남음과 상처, 돌봄과 파괴가 한 화면 안에서 공존하는 상태가 마지막에 가깝습니다.',
          '그래서 Phone Hub는 관객에게 점수나 성격 분석을 보여주지 않습니다. 내부의 변화는 장미의 모양에만 반영됩니다. 숫자는 모순을 다시 한 줄의 평가로 줄여버리기 때문입니다.',
          '돌봄은 언제나 순수하게 선하지 않고 파괴 역시 하나의 의미로만 닫히지 않습니다. 무엇을 살린다는 명목으로 지나치게 통제할 수도 있고, 없애려던 행동이 오히려 다른 흔적을 드러낼 수도 있습니다.',
          '장미 이름도 같은 구조를 가집니다. 두 번째 문장은 첫 번째를 미화하거나 취소하지 않습니다. 둘은 한 사람 안에서 동시에 존재하며, 이름은 한쪽이 다른 쪽을 이긴 결과가 아니라 두 얼굴을 함께 부르는 방식이 됩니다.',
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
        lead: '명명하고, 개입하고, 목격하고, 기록한 뒤 장미의 이름과 함께 돌아갑니다.',
        body: [
          '첫 번째 작품에서 관객은 스켈레톤의 왼손을 잡고 다른 손으로 생화 장미를 만져 하나의 회로를 완성합니다. 두 번째에서는 장미이자 스켈레톤인 자기 형상에 직접 개입하고, 세 번째에서는 세계의 장례 서사 속에서 왜곡된 자기 장미의 자리를 목격합니다.',
          '네 번째 기록은 완성된 작품 뒤의 손과 물질의 시간을 보여줍니다. 마지막 출구에서 다시 읽는 장미의 이름은 삭제하거나 버릴 결론이 아니라, 전시 밖에서도 돌아볼 수 있는 오늘의 표식입니다.',
        ],
        deeper: [
          '이 순서는 치료의 단계나 회복의 정답을 제시하지 않습니다. 작품을 본 뒤 더 나아졌다고 말하도록 요구하지도 않습니다. 의식의 역할은 한 사람 안의 모순을 없애는 것이 아니라, 평소에는 겹쳐 보이지 않던 것들을 같은 시간 안에 놓는 것입니다.',
          '01은 살아 있는 손, 생화 장미와 스켈레톤이 하나의 회로가 되어 자기 안으로 가장 가까이 들어가는 자리입니다. 02는 그 이름을 가진 존재를 직접 돌보고 해치며 자신이 자신을 대하는 방식을 행동으로 반복합니다.',
          '03에서는 자기 내부에서 한 걸음 물러나 세계의 장례들 사이에서 자신의 색과 형체를 목격합니다. 04는 완성된 작품 뒤에서 사라지는 제작의 손과 실패를 이 시신의 기록으로 남깁니다.',
          '마지막 출구는 이름을 삭제하는 자리가 아닙니다. 의식은 모순을 없애지 않고, 서로 겹쳐 보이지 않던 것들을 같은 시간 안에 둔 채 다시 선택할 가능성을 남깁니다.',
        ],
      }),
      aboutSection({
        id: 'about-work-01',
        index: '07',
        title: '01 명명 / NAMING',
        lead: '살아 있는 손과 생화 장미, 스켈레톤이 하나의 회로가 되는 작품입니다.',
        body: [
          '스켈레톤의 왼손을 잡고 다른 손으로 생화 장미를 만지면 회로가 완성됩니다. 열다섯 송이는 각각 다른 소리와 빛, 픽셀의 반응을 가지고 있으며 오래 머물수록 반응은 더 깊어집니다.',
          '장미를 만지는 순서와 조합에 따라 빛과 소리가 겹쳐집니다. 열다섯 송이를 한 번씩 모두 거치는 순서만 계산해도 15! = 1,307,674,368,000가지입니다. 숫자를 모두 소유하는 것이 아니라, 오늘의 나와 가장 깊게 공명하는 하나의 균형을 충분히 탐색합니다.',
        ],
        deeper: [
          '스켈레톤은 죽은 타인이 아니라 오늘 장례를 치르는 또 하나의 나를 가리킵니다. 살아 있는 손이 스켈레톤과 생화에 동시에 닿아야만 빛과 소리가 발생한다는 조건은 삶과 죽음이 분리된 두 상태가 아니라 한 회로 안의 동시적인 조건임을 드러냅니다.',
          '비주얼은 일부러 감정의 이름을 직접 설명하지 않습니다. 겹겹의 추상 이미지가 경계를 흐리고, 아주 어두운 글리치가 한순간 반짝이는 핑크빛으로 바뀝니다. 관객은 정해진 답을 읽는 대신 자기 몸이 반응하는 픽셀과 소리의 조합을 찾습니다.',
          '원하는 균형을 찾았다면 스켈레톤의 양손을 잡습니다. 두 손이 맞닿는 순간 화면이 기록되고 짧은 기계음이 촬영을 알립니다. 기록은 정답의 인증이 아니라 그 순간의 공명을 붙잡는 행위입니다.',
          '그 뒤 장미 이름을 짓습니다. 서로 밀어내던 두 얼굴을 같은 이름 안에 잠시 두는 명명은, 방금 몸으로 찾은 빛과 소리의 균형을 자신의 언어로 옮기는 과정입니다.',
          '생화는 전시가 진행되는 동안 실제로 상하고 시듭니다. 관객의 접촉은 사라지는 입력이 아니라 꽃의 몸과 작품의 기록에 남는 시간입니다.',
        ],
      }),
      aboutSection({
        id: 'about-work-02',
        index: '08',
        title: '02 개입 / INTERVENTION',
        lead: '01에서 지은 이름을 가진 존재가 화면 안에서 다시 살아납니다.',
        body: [
          '관객은 화면 속 존재의 균형과 생기를 바라보며 돌보고, 찌르고, 다시 개입합니다. 모든 것이 똑같이 공평하게 존재할 수 없듯 공평이나 불공평 어느 한쪽만으로도 이 몸은 유지되지 않습니다. 목표는 완벽한 평형이 아니라 계속 움직이는 불균형의 균형을 마주하는 것입니다.',
          '화면 속 존재는 장미이자 스켈레톤이고, 죽음이자 삶이며, 내가 죽이는 나이면서 동시에 나를 죽이는 나입니다. 서로를 취소하지 않는 두 힘이 같은 몸에 남습니다.',
        ],
        deeper: [
          '엄지와 검지로 사각형을 만들면 그 안에 카메라 화면이 나타나는 마스크가 생깁니다. 독을 먹이고 돌보던 대상의 얼굴 위에 나의 모습이 겹쳐지면서, 행동하는 나와 그 행동을 바라보는 내가 같은 장면에 놓입니다.',
          '다섯 손가락으로 마스크를 그리면 처음 정한 장미 색과 장미 이름이 스켈레톤 위에 나타납니다. 삶이 나이고 내가 죽음이며, 장미와 스켈레톤이 서로 다른 상징이 아니라 같은 존재의 두 얼굴임을 보여줍니다.',
          '물과 햇빛, 독과 괴물은 선과 악의 버튼이 아닙니다. 중요한 것은 어떤 행동을 반복하고 언제 바꾸며 서로 다른 힘을 어떻게 섞어 오늘의 균형을 만드는가입니다.',
          '죽음은 끝이 되지 않습니다. 존재는 다시 일어나지만 이전 상태로 완전히 복구되지는 않습니다. 돌봄과 손상, 죽음과 재생이 서로를 취소하지 않고 같은 몸에 남습니다.',
          '기록하고 싶은 순간에는 로즈 휴먼 인터페이스의 버튼 아무거나 두 개를 5초 동안 누릅니다. 방금 그 존재에게 한 일과 그것을 바라보던 나의 얼굴이 같은 장면으로 남습니다.',
        ],
      }),
      aboutSection({
        id: 'about-work-03',
        index: '09',
        title: '03 목격 / WITNESS',
        lead: '세계의 장례 서사 안에서 왜곡된 나의 장미를 세 번 목격합니다.',
        body: [
          '손을 장미 가까이 대고 수직으로 움직이면 영상의 시간을 천천히 또는 빠르게 제어할 수 있습니다. 가장 천천히 하는 목격을 세 번 반복하는 동안, 처음에는 흐릿했던 장미 스켈레톤의 형체를 찾아갑니다.',
          '바니타스 회화의 해골처럼 나의 장미도 처음에는 왜곡된 모습으로 나타납니다. 관객은 왜곡의 반대 얼굴을 찾기 위해 시간의 흐름을 없애는 대신 충분히 늦추고, 자기 자신을 살펴볼 시간을 스스로에게 수여합니다.',
        ],
        deeper: [
          '이전 작품들이 자기 안으로 가까이 들어갔다면, 03은 한 걸음 물러나 세계 속에서 자신을 바라보는 자리입니다. 화면을 지나가는 장면과 여러 언어는 서로 다른 문화와 장소에 존재하는 죽음의 서사를 이룹니다.',
          '세 번의 목격은 정답을 세 번 확인하는 과정이 아닙니다. 같은 장미도 시간과 거리, 내가 선 위치에 따라 다르게 보인다는 사실을 몸으로 확인하는 과정입니다.',
          '왜상은 정면에서 풍경의 일부였던 죽음의 표식이 특정한 각도에서 드러나는 바니타스의 시각 구조를 가져옵니다. 여기서도 관객은 손과 몸의 위치를 바꾸어야 자기 장미의 형체를 볼 수 있습니다.',
          '시간은 여전히 흐릅니다. 관객은 시간을 멈춰 소유하는 대신 그 흐름에 찬찬히 개입해 자기 자신을 살펴볼 시간을 스스로에게 줍니다.',
          '세 번의 목격 뒤, 나의 장미 스켈레톤을 찾았다고 생각이 드는 순간 장미 버튼을 누릅니다. 이 선택은 정답의 확인이 아니라 오늘 내가 서 있던 위치에서 서사를 마무리하는 행위입니다.',
        ],
      }),
      aboutSection({
        id: 'about-work-04',
        index: '10',
        title: '04 기록 / RECORD',
        lead: '완성된 작품 뒤에서 사라지는 손과 제작의 시간을 남긴 영상입니다.',
        body: [
          '장미, 스켈레톤, 전선, 센서와 컨트롤러가 하나의 몸이 되는 동안의 손을 기록했습니다. 관객이 만나는 완성된 표면만이 아니라, 자르고 잇고 실패하고 다시 연결한 시간을 작품의 일부로 둡니다.',
          '영상에는 반드시 처음부터 봐야 하는 서사가 없습니다. 어느 순간에 들어오고 나가도 됩니다. 다른 작품을 기다리는 동안 보아도 되고, 모든 작품을 지난 뒤 돌아와도 됩니다.',
        ],
        deeper: [
          '제작 기록은 작품을 설명하는 홍보 영상이 아닙니다. 이 시신이 어떤 노동과 반복을 지나 만들어졌는지 보여주는 또 하나의 부검 기록에 가깝습니다. 기계가 매끈한 마술처럼 보이지 않도록 연결부와 손의 흔적을 숨기지 않습니다.',
          '인터랙티브 미디어 작품은 완성되면 기술이 보이지 않는 매끄러운 표면으로 나타나기 쉽습니다. 그러나 그 뒤에는 자르고 잇는 손, 실패한 테스트, 다시 시작된 연결, 사라진 버전과 고장 난 장치의 시간이 있습니다.',
          '이 작품은 그 과정을 숨겨 마술처럼 보이게 하지 않습니다. 기계 역시 몸을 가지고 있고, 그 몸은 수많은 손의 노동과 오류를 통해 만들어집니다.',
          '영상에 정해진 처음과 마지막이 없는 이유도 여기에 있습니다. 제작은 선명한 시작과 완성으로 정리되지 않습니다. 어느 장면에서 들어와도 손은 이미 무언가를 만들고 있고, 어느 순간 떠나도 작업은 다른 곳에서 계속됩니다.',
          '04는 앞선 작품의 결과를 해석하거나 관객을 한 가지 결론으로 분류하지 않습니다. 완성된 장면 뒤에 감춰진 손, 실패, 반복과 물질의 시간을 독립된 기록으로 남깁니다.',
        ],
      }),
      aboutSection({
        id: 'about-phone',
        index: '11',
        title: '당신의 장미와 Phone Hub',
        lead: '휴대폰은 작품의 실시간 화면을 복제하지 않고, 흩어진 선택을 한 장미 아래 이어주는 얇은 실입니다.',
        body: [
          '입장에서 고른 색, 01에서 지은 장미 이름, 각 작품에서 직접 남긴 장면이 하나의 장미 번호에 연결됩니다. 입구의 NFC로 장미 번호를 시작하고 작품 앞의 패턴을 고르는 행동은, 디지털 기록을 시작하는 동시에 네 작품에 흩어진 장면을 이어줍니다.',
          'Phone Hub는 관객을 분석한 점수나 성격 유형을 보여주지 않습니다. 나의 장미도 완성된 해석이 아니라 지금까지의 흔적입니다. 변화는 숫자가 아니라 장미의 모양과 남겨진 장면으로만 보입니다.',
        ],
        deeper: [
          '작품의 원본 상호작용은 각 TouchDesigner 시스템 안에서 처리하고, 휴대폰에는 필요한 결과만 전달합니다. 네트워크가 잠시 끊겨도 작품이 멈추지 않게 하고, 관객이 기술 상태를 감시하느라 작품에서 눈을 떼지 않게 하기 위한 구조입니다.',
          '당신의 장미 번호는 실명 대신 오늘의 선택들을 다시 찾기 위한 표식입니다. 번호의 목적은 사람을 식별하는 것이 아니라, 떨어져 있는 장면들이 누구의 장미에 돌아가야 하는지 알려주는 것입니다.',
          'Phone Hub는 작품의 실시간 화면을 복제하지 않습니다. 각 작품이 실제로 필요로 하는 최소한의 정보만 제때 연결하고, 나머지 행동 기록은 작품의 흐름을 방해하지 않도록 묶어서 저장합니다.',
          '현재의 장미는 완성된 초상이 아닙니다. 색, 이름, 방문한 순서와 작품에서 남겨진 흔적이 그 순간 잠시 겹쳐 보이는 표본이며, 관객이 다음 행동을 하면 다시 달라질 수 있습니다.',
          '계정을 만들거나 본명을 묻지 않습니다. 얼굴을 식별하기 위한 정보와 휴대폰의 위치 정보는 저장하지 않습니다. 수집한 기록은 작품 연구와 전시 경험 개선을 위해서만 사용하며 다른 관객에게 공개하지 않습니다.',
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
          '이 장례식은 치료를 약속하지 않습니다. 스스로 밀어냈던 면이 사라졌다고 선언하지도 않습니다. 다만 그 면과 그 안의 다른 얼굴을 동시에 바라볼 수 있는 짧은 시간을 만들고자 합니다.',
          '모순은 없어지지 않아도, 어느 쪽에 물을 줄지는 고를 수 있습니다. 이 문장은 작품이 관객에게 주는 결론이 아니라, 전시장을 나간 뒤에도 다시 선택할 수 있도록 남겨두는 질문입니다.',
          '인터랙션은 무엇을 느껴야 하는지 명령하기 위한 장치가 아니라 자기 선택을 자기 눈앞에 돌려놓기 위한 구조입니다. 장미 이름은 작품이 부여하는 진단이 아니며, 관객이 원하지 않으면 기록 없이 입장할 수도 있습니다.',
          '선택권은 작품의 책임을 관객에게 떠넘기기 위한 말이 아닙니다. 죽음과 애도, 스스로 밀어낸 나의 면을 다루는 만큼 화면은 강요보다 예고를, 평가보다 복구 가능한 선택을 먼저 제공합니다.',
          '불편하면 지나가도 되고, 잠시 쉬었다 돌아와도 됩니다. 무엇을 가까이 보고, 무엇을 만지고, 언제 멈출지는 관객이 정합니다. 관객의 속도와 선택도 이 작품의 일부입니다.',
          '기술이 실패하더라도 작품을 계속 볼 수 있는 경로를 남기고, 남겨진 데이터보다 관객의 경험을 우선합니다. 관객은 정답을 찾는 사람이 아니라 서로 모순되는 자기 모습을 같은 시간 안에 둘 수 있는지 시험하는 사람입니다.',
        ],
      }),
      el('footer', { class: 'about-page-end' },
        el('span', { class: 'micro-label' }, 'ARTIST / MINNIE PARK'),
        el('p', {}, tr('Minnie Park은 인간, 자연, 기계 사이에서 감정이 어떻게 물질과 행동으로 번역되는지 탐구하는 인터랙티브 미디어 아티스트입니다.', 'Minnie Park is an interactive media artist.')),
        el('p', {}, tr('생화, 스켈레톤, 전선, 센서, 실시간 이미지와 관객의 몸을 연결해 한 사람이 혼자서는 완성할 수 없는 장면을 만듭니다.', 'Her work connects organic matter, machines, real-time images, and the audience body.')),
        el('a', { class: 'text-button', href: ARTIST_INSTAGRAM_URL, onclick: openArtistInstagram }, tr('작가에게 메시지 보내기', 'MESSAGE THE ARTIST'), el('span', { 'aria-hidden': 'true' }, '↗')),
        textButton('HOME', () => { void goHome(); }),
        textButton(tr('장미 메뉴를 엽니다', 'OPEN ROSE MENU'), openRoseMenu),
      ),
    ),
  ]);

  startPageRead('about_project');

  if (initialSection) {
    requestAnimationFrame(() => scrollToAboutSection(initialSection, false));
  }
}

function screenAboutProject(initialSection = null) {
  const session = ensureSession();
  rememberView('about', { initialSection });
  clearStationQuery();
  applySessionColor(session.color);
  logEvent('about_page_enter', { initial_section: initialSection || 'top' }, '00');

  const localised = (ko, en) => session.lang === 'ko' ? (ko || en || '') : (en || ko || '');

  render([
    globalHeader(),
    el('article', { class: 'screen about-screen', id: 'about-top' },
      textButton('HOME', () => { void goHome(); }, 'about-back'),
      el('header', { class: 'about-hero' },
        el('span', { class: 'micro-label' }, `${MELBOURNE.city.toUpperCase()} / ${MELBOURNE.year}`),
        el('h1', {}, tr('프로젝트에 대하여', 'ABOUT THE PROJECT')),
        el('p', {}, MELBOURNE.title),
        el('p', { class: 'about-hero-lead' }, tr(
          '삶과 죽음, 돌봄과 파괴처럼 서로 반대되어 보이는 상태가 한 몸 안에 동시에 존재함을 생화 장미, 빛, 소리, 움직이는 이미지로 살펴봅니다.',
          'Living roses, light, sound and moving images hold apparently opposing states, including life and death and care and destruction, within the same body and moment.',
        )),
      ),
      el('details', { class: 'about-toc', open: true },
        el('summary', {}, tr('읽을 곳을 고릅니다', 'CONTENTS'), el('span', { 'aria-hidden': 'true' }, '+')),
        el('nav', { class: 'about-anchor-nav', 'aria-label': tr('프로젝트 상세 목차', 'Project contents') },
          ...ABOUT_SECTIONS.map((section, index) => el('button', {
            type: 'button',
            onclick: () => scrollToAboutSection(section.id),
          },
            el('span', {}, String(index + 1).padStart(2, '0')),
            el('strong', {}, localised(section.titleKo, section.titleEn)),
          )),
        ),
      ),
      ...ABOUT_SECTIONS.map((section, index) => aboutSection({
        id: section.id,
        index: String(index + 1).padStart(2, '0'),
        title: localised(section.titleKo, section.titleEn),
        lead: localised(section.leadKo, section.leadEn),
        body: localised(section.bodyKo, section.bodyEn) || [],
        deeper: localised(section.deeperKo, section.deeperEn) || [],
      })),
      el('section', { class: 'access-credit-card' },
        el('h2', {}, tr('접근성 지원', 'ACCESSIBILITY SUPPORT')),
        el('p', {}, MELBOURNE.accessCredit),
        textButton(tr('접근성·감각 안내', 'ACCESS & SENSORY GUIDE'), screenAccessGuide),
      ),
      el('footer', { class: 'about-page-end' },
        el('span', { class: 'micro-label' }, tr('작가 / MINNIE PARK 박지민', 'ARTIST / MINNIE PARK 박지민')),
        el('p', {}, tr(
          'Minnie Park은 인간, 자연, 기계 사이에서 감정이 어떻게 물질과 행동으로 번역되는지 탐구하는 인터랙티브 미디어 아티스트입니다.',
          'Minnie Park is an interactive media artist exploring how emotion is translated into matter and action between people, nature and machines.',
        )),
        el('a', { class: 'text-button', href: ARTIST_INSTAGRAM_URL, onclick: openArtistInstagram }, tr('작가에게 메시지 보내기', 'MESSAGE THE ARTIST'), el('span', { 'aria-hidden': 'true' }, '↗')),
        textButton('HOME', () => { void goHome(); }),
      ),
    ),
  ]);

  startPageRead('about_project');
  if (initialSection) requestAnimationFrame(() => scrollToAboutSection(initialSection, false));
}

const MODULES = {
  '01': {
    en: 'NAMING', ko: '명명', phaseKo: '명명', visual: 'naming',
    introKo: '검은 리본을 잡고 생화 장미를 만지면 접촉이 빛과 소리로 바뀝니다. 오늘 내 몸이 공명하는 균형을 찾고, 장면을 남기려면 흰 리본과 검은 리본을 동시에 잡습니다.',
    introEn: 'Hold the black ribbon and touch a living rose to turn contact into light and sound. Find the balance that resonates with your body today, then hold the white and black ribbons at the same time to request a capture.',
    quickStepsKo: ['한 손으로 검은 리본을 잡습니다.', '검은 리본을 잡은 채 다른 손으로 장미를 만지며 빛과 소리를 탐색합니다.', '장면을 남기려면 흰 리본과 검은 리본을 동시에 잡습니다.'],
    quickStepsEn: ['Hold the black ribbon with one hand.', 'Keep holding the black ribbon and touch a rose with your other hand to explore its light and sound.', 'To request a capture, hold the white and black ribbons at the same time.'],
    quickNoteKo: '짧은 기계음이 들리면 캡처가 요청된 것입니다.',
    quickNoteEn: 'A short mechanical sound confirms the capture request.',
    essentialKo: '한 손으로 검은 리본을 잡고 다른 손으로 생화 장미를 만집니다. 서로 다른 장미의 소리와 빛을 충분히 탐색한 뒤, 오늘의 나와 가장 공명하는 순간을 남기려면 흰 리본과 검은 리본을 동시에 잡습니다.',
    essentialEn: 'Hold the black ribbon with one hand and touch the living roses with the other. Explore their different sounds and lights, then hold the white and black ribbons at the same time to request a capture of the moment that resonates with you.',
    helpKo: '검은 리본을 잡고 장미를 만져 서로 다른 빛과 소리를 탐색합니다. 장면을 남기려면 흰 리본과 검은 리본을 동시에 잡습니다.',
    helpEn: 'Hold the black ribbon and touch the roses to explore different light and sound. Hold the white and black ribbons at the same time to request a capture.',
    helpDetailKo: ['한 손으로 검은 리본을 잡습니다.', '검은 리본을 잡은 채 다른 손으로 한 송이 또는 여러 송이의 생화 장미를 만집니다. 장미마다 서로 다른 소리와 빛이 나타납니다.', '같은 장미에 오래 머물거나 여러 장미를 조합해보세요. 머무는 시간이 길수록 소리와 빛의 층은 더 깊어집니다.', '아주 어두운 글리치부터 순간적으로 반짝이는 핑크빛까지 살피며, 오늘의 나와 가장 공명하는 픽셀과 소리의 균형을 찾습니다.', '그 순간의 캡처를 요청하려면 흰 리본과 검은 리본을 동시에 잡습니다. 짧은 기계음이 요청을 확인합니다.', '01을 마친 뒤, 방금 찾은 균형을 떠올리며 장미 이름을 지을 수 있습니다.'],
    helpDetailEn: ['Hold the black ribbon with one hand.', 'Keep holding the black ribbon and touch one or several living roses with the other. Each rose produces a different sound and light.', 'Stay longer or combine different roses. The layers deepen with time.', 'Find the balance of pixels and sound that resonates with you today.', 'To request a capture of that moment, hold the white and black ribbons at the same time. A short mechanical sound confirms the request.', 'After 01, you may give your rose its name.'],
    troubleshootKo: ['반응이 없다면 검은 리본을 충분히 잡은 상태에서 장미를 다시 만져주세요.', '한 송이씩 천천히 만져 각 장미의 반응을 확인한 뒤 여러 송이를 조합해보세요.', '캡처가 요청되지 않으면 두 리본에서 손을 뗀 뒤, 흰 리본과 검은 리본을 동시에 다시 잡고 짧은 기계음이 들릴 때까지 유지해주세요.', '계속 작동하지 않거나 캡처가 보이지 않으면 스태프에게 말씀해주세요.'],
    troubleshootEn: ['If nothing responds, keep a firm hold on the black ribbon and touch the rose again.', 'Try one rose at a time before combining several roses.', 'If a capture is not requested, release both ribbons, then hold the white and black ribbons again at the same time until you hear the short mechanical sound.', 'If it still does not respond or your capture does not appear, ask a staff member.'],
    aboutKo: '검은 리본, 생화 장미와 관객의 몸이 하나의 임시적인 회로가 됩니다. 장미를 만지는 행동은 빛과 소리를 만들면서 동시에 꽃의 시간을 앞당깁니다. 흰 리본과 검은 리본을 함께 잡는 동작은 관객이 선택한 순간의 캡처를 요청합니다.',
    aboutEn: 'The black ribbon, living roses and the audience body form a temporary circuit. Touch creates light and sound while also advancing the flowers\' time. Holding the white and black ribbons together requests a capture of the visitor\'s chosen moment.',
    aboutDetailKo: ['검은 리본과 매달린 생화 장미는 관객의 몸을 통해 하나의 임시적인 회로가 됩니다.', '열다섯 송이는 각각 다른 소리와 빛을 가집니다. 열다섯 장미를 순서 있게 모두 선택할 때 가능한 배열은 15!, 즉 1,307,674,368,000가지입니다. 관객은 그 거대한 가능성을 전부 계산하지 않고, 몸이 동하는 한순간의 조합을 감각으로 찾습니다.', '비주얼은 일부러 감정의 이름을 직접 보여주지 않습니다. 겹겹의 픽셀과 글리치는 경계를 흐리고, 어둠 속에서 잠깐 번지는 핑크빛은 하나의 감정이 고정된 얼굴로만 남지 않게 합니다.', '장미를 만지는 행동은 돌봄이면서 동시에 꽃의 시간을 앞당기는 접촉입니다. 장미는 관객의 접촉을 통해 소리를 얻고 시듭니다.', '오래 머무를수록 빛과 소리는 심화되지만 더 높은 점수로 환산되지는 않습니다. 이 작품의 목적은 가장 좋은 조합을 맞히는 것이 아니라 오늘 자신의 몸이 실제로 공명하는 균형을 알아차리는 것입니다.', '흰 리본과 검은 리본을 동시에 잡는 마지막 동작은 기록의 셔터입니다. 방금 선택한 균형을 한 장면으로 남기도록 캡처를 요청합니다.'],
    aboutDetailEn: ['The black ribbon and hanging living roses form a temporary circuit through the audience body.', 'Each of the fifteen roses has a different sound and light. Rather than calculating every possible sequence, the visitor senses one combination that resonates in the moment.', 'Layered pixels and glitches avoid assigning a fixed emotional name to the image.', 'Touching a rose is an act of care that also advances the flower\'s time. The rose gains sound through contact and continues to wither.', 'Longer contact deepens the light and sound but does not create a higher score. The aim is to notice the balance that resonates with your body today.', 'Holding the white and black ribbons at the same time acts as the shutter, requesting a capture of the balance you chose.'],
  },
  '02': {
    en: 'INTERVENTION', ko: '개입', phaseKo: '개입', visual: 'reenactment',
    introKo: '화면 속 존재는 장미이자 스켈레톤, 삶이자 죽음입니다. 돌봄과 손상이 함께 만드는 불균형 안에서, 행동하는 나와 그 행동을 바라보는 나를 마주합니다.',
    introEn: 'The figure is both rose and skeleton, life and death. Within the imbalance made by care and damage, the work places the self who acts beside the self who watches.',
    quickStepsKo: ['엄지와 검지로 사각형을 만들어 카메라 화면이 나타나는 마스크를 만들고, 다섯 손가락으로 또 다른 마스크를 만듭니다.', '화면 속 존재의 균형과 생기를 바꾸며 충분히 탐색합니다.', '기록하고 싶은 순간, 로즈 휴먼 인터페이스의 버튼 아무거나 두 개를 5초 동안 누릅니다.'],
    quickStepsEn: ['Form a rectangle with your thumb and index finger for one camera mask, then use five fingers for another.', 'Explore by changing the figure\'s balance and vitality.', 'To capture the moment, hold any two buttons on the Rose Human Interface for five seconds.'],
    anonymousStartKo: '휴대폰 없이 참여하려면 로즈 휴먼 컨트롤러의 버튼 아무거나 하나를 누릅니다.',
    anonymousStartEn: 'To take part without the phone, press any one button on the Rose Human Controller.',
    quickNoteKo: '',
    quickNoteEn: '',
    essentialKo: '컨트롤러로 화면 속 스켈레톤의 균형과 생기에 개입합니다. 엄지와 검지로 사각형을 만들거나 다섯 손가락을 펼쳐 서로 다른 마스크를 만들면, 행동하는 나와 그 행동을 바라보는 나의 얼굴이 스켈레톤 위에 겹쳐집니다. 장면을 남기려면 로즈 휴먼 인터페이스의 버튼 두 개를 5초 동안 누릅니다.',
    essentialEn: 'Intervene in the skeleton\'s balance and vitality. Form a rectangle with your thumb and index finger or open five fingers to create two masks. Hold any two Rose Human Interface buttons for five seconds to capture the scene.',
    helpKo: '서로 다른 행동으로 균형과 생기의 변화를 만들고, 손가락 마스크 안에서 자신의 얼굴을 마주합니다.',
    helpEn: 'Use the controller to alter balance and vitality. Form two distinct hand masks, then hold two controller buttons to record the scene.',
    helpDetailKo: ['컨트롤러의 서로 다른 행동을 시도합니다. 각 행동은 화면 속 스켈레톤의 균형과 생기를 다르게 바꿉니다.', '한 방향만 반복할 필요는 없습니다. 돌봄과 손상, 죽음과 다시 일어남이 한 몸에 함께 남는 과정을 지켜봅니다.', '카메라 앞에서 엄지와 검지로 사각형을 만들면 그 안에 카메라 화면이 나타나는 마스크가 생깁니다.', '다섯 손가락을 펼치면 내가 고른 장미 색과 장미 이름이 나타나는 또 다른 마스크가 생깁니다.', '행동하는 나와 그 행동을 바라보는 나를 충분히 마주합니다.', '장면을 기록하려면 로즈 휴먼 인터페이스의 버튼 아무거나 두 개를 5초 동안 누릅니다.'],
    helpDetailEn: ['Try different controller actions to change the skeleton\'s balance and vitality.', 'Care and damage, death and return may remain in the same body.', 'Form a rectangle with your thumb and index finger to reveal the camera mask.', 'Open five fingers to create the second mask with your rose colour and name.', 'Hold any two Rose Human Interface buttons for five seconds to capture the scene.'],
    troubleshootKo: ['손과 마스크가 보이지 않으면 손 전체와 얼굴이 화면 안에 들어오도록 한 걸음 물러섭니다.', '스크린샷이 남지 않으면 인터페이스의 서로 다른 버튼 두 개를 동시에 누른 채 5초 동안 유지해주세요.', '계속 작동하지 않으면 스태프에게 말씀해주세요.'],
    aboutKo: '모든 것이 공평하게 존재할 수 없듯 불공평만 존재할 수도 없습니다. 화면 속 나는 장미이자 스켈레톤이며, 삶이자 죽음입니다. 관객은 이 존재를 돌보고 해치며 균형을 바로잡으려 하지만, 완전한 평형에 도달하는 것이 아니라 계속 흔들리는 불균형의 균형을 마주하게 됩니다.',
    aboutEn: 'The self on screen is rose and skeleton, life and death. Intervention does not produce perfect balance; it reveals the shifting balance inside imbalance.',
    aboutDetailKo: ['이 작품에서 관객은 관찰자가 아니라 적극적으로 개입하는 사람입니다. 화면 속 존재는 관객의 장미 색과 이름을 받아 나타나고, 관객의 선택은 그 존재를 살리거나 죽이는 실제 사건이 됩니다.', '돌봄과 손상은 서로 깨끗하게 분리되지 않습니다. 살리기 위한 개입이 다른 균형을 무너뜨릴 수 있고, 파괴적인 행동 뒤에도 생명은 다시 일어납니다. 공평과 불공평 역시 서로를 배제하지 않은 채 함께 나타납니다.', '나를 죽이는 나와 내가 죽이는 나는 다른 인물이 아닙니다. 장미와 스켈레톤, 삶과 죽음도 같은 화면 안에서 하나의 몸을 공유합니다. 작품은 이 모순을 해결하기보다 그대로 마주 보게 합니다.', '엄지와 검지로 만든 사각형 안에는 카메라 화면이 나타납니다. 관객은 자신이 해치고 돌보는 스켈레톤 위에서, 바로 그 행동을 선택하고 지켜보는 자신의 얼굴을 만나게 됩니다.', '다섯 손가락 마스크에는 관객이 고른 색과 장미 이름이 더해집니다. 그 순간 화면 속 존재는 타자가 아니라 장미 이름을 가진 나의 장미이자 나의 스켈레톤으로 구체화됩니다.', '로즈 휴먼 인터페이스의 버튼 두 개를 5초 동안 눌러 남기는 장면은 성공이나 실패의 증명이 아닙니다. 무엇을 했는지와 그 행동을 바라본 나는 누구였는지를 같은 기록 안에 두는 일입니다.'],
  },
  '03': {
    en: 'WITNESS', ko: '목격', phaseKo: '목격', visual: 'mourning',
    introKo: '왜상 속에 숨은 해골처럼 나의 장미는 흐르는 세계 안에서 왜곡되어 나타납니다. 세 번의 느린 목격으로 시간에 개입하며, 같은 장미의 다른 얼굴을 찾습니다.',
    introEn: 'Like a skull hidden in anamorphic vanitas, your rose appears distorted within a moving world. Three slow acts of witness let you intervene in time and find its other face.',
    quickStepsKo: ['손을 장미 가까이 대고 수직으로 움직여 영상의 시간을 천천히 또는 빠르게 제어합니다.', '영상 속 나의 장미 스켈레톤을 찾으며, 가장 천천히 하는 목격을 세 번 반복합니다.', '찾았다고 생각이 들 때 장미 버튼을 누릅니다.'],
    quickStepsEn: ['Move your hand vertically near the rose to control the video time, slowly or quickly.', 'Search for your rose-skeleton in the video and repeat your slowest witnessing three times.', 'Press the rose button when you believe you have found it.'],
    anonymousStartKo: '휴대폰 없이 참여하려면 장미 버튼을 한 번 누릅니다.',
    anonymousStartEn: 'To take part without the phone, press the rose button once.',
    quickNoteKo: '',
    quickNoteEn: '',
    essentialKo: '손을 장미 가까이 대고 수직으로 움직여 영상의 시간을 제어합니다. 영상 속 나의 장미 스켈레톤을 천천히 또는 빠르게 목격하며 찾고, 가장 천천히 하는 목격을 세 번 반복합니다. 찾았다고 생각이 들 때 장미 버튼을 눌러 서사를 마무리합니다.',
    essentialEn: 'Move your hand vertically near the rose to control the video time. Search for your rose-skeleton at different speeds, repeat your slowest witnessing three times, then press the rose button when you believe you have found it.',
    helpKo: '손의 수직 움직임으로 영상의 시간을 조절하며, 세 번의 느린 목격 속에서 나의 장미 스켈레톤을 찾습니다.',
    helpEn: 'Control the video time with vertical hand movement and find your rose-skeleton through three slow acts of witness.',
    helpDetailKo: ['화면과 장미 앞에 섭니다. 소리는 공간의 스피커로 재생됩니다.', '손을 장미 가까이 대고 위아래로 천천히 움직여 영상의 시간을 제어합니다.', '빠르게 움직여 지나가는 장면과 아주 천천히 머무는 장면을 모두 살피며 나의 장미 스켈레톤을 찾습니다.', '그중 가장 천천히 하는 목격을 세 번 반복합니다.', '나의 장미 스켈레톤을 찾았다고 생각이 드는 순간 장미 버튼을 누릅니다.', '지나간 장면과 놓친 시간까지 포함해 자신의 서사를 마무리합니다.'],
    helpDetailEn: ['Stand before the screen and rose. Sound plays through the room speakers.', 'Move your hand vertically near the rose to control video time.', 'Search for your rose-skeleton through fast passages and very slow moments.', 'Repeat your slowest witnessing three times.', 'Press the rose button when you believe you have found your rose-skeleton.'],
    troubleshootKo: ['영상의 시간이 바뀌지 않으면 손을 장미 가까이에 둔 채 위아래로 더 분명하게 움직여주세요.', '목격이 이어지지 않으면 손을 장미에서 완전히 뺐다가 천천히 다시 가까이 대주세요.', '장미 스켈레톤을 찾았을 때 장미 버튼을 한 번 분명하게 눌러주세요.', '스피커 소리가 들리지 않거나 화면이 반응하지 않으면 스태프에게 말씀해주세요.'],
    aboutKo: '03은 세계 속에서 나의 죽음과 나의 장미를 목격하는 자리입니다. 바니타스의 왜상 속 해골처럼 장미는 처음부터 온전한 모습으로 주어지지 않습니다. 관객은 세 번 시간에 개입하고, 여전히 흘러가는 장면을 찬찬히 바라볼 시간을 스스로에게 수여함으로써 왜곡의 반대편 얼굴을 찾습니다.',
    aboutEn: 'The rose first appears as a distortion, like the skull hidden in a vanitas image. Three acts of witness give you time to find its other face inside a world that continues to move.',
    aboutDetailKo: ['01이 내 안의 공명을 찾고 02가 나의 행위를 조금 떨어져 바라보는 작품이라면, 03은 더 넓은 세계의 언어와 시간 속에 나의 죽음과 장미를 대입하는 자리입니다.', '세 번의 목격은 정답을 고르는 단계가 아닙니다. 어떤 장면에 얼마나 가까이 다가가고 언제 손을 거두었는지가, 흐르는 서사 안에서 관객의 자리를 만듭니다.', '관객의 장미는 처음에는 흐릿하고 왜곡된 모습으로 나타납니다. 바니타스 회화의 왜상이 특정한 위치와 충분한 바라봄을 요구했듯, 이 장미도 한눈에 소비되지 않고 시간을 필요로 합니다.', '시간은 완전히 멈추지 않습니다. 관객은 모든 장면을 붙잡을 수 없지만, 손을 가까이 가져가 속도에 개입하고 자신을 찬찬히 바라볼 시간을 스스로에게 수여할 수 있습니다.', '장미가 선명해지는 것은 죽음이 사라졌다는 뜻이 아닙니다. 왜곡되어 있던 한 얼굴과 그 반대편 얼굴을 같은 서사 안에서 함께 볼 수 있게 되었다는 뜻에 가깝습니다.', '세 번째 목격 뒤에는 기록하거나 다시 시간에 개입할 수 있습니다. 이미 정해진 결말을 확인하는 대신, 자신의 서사를 어디에서 마칠지 관객이 선택합니다.'],
  },
  '04': {
    en: 'RECORD', ko: '기록', phaseKo: '기록', visual: 'archive',
    introKo: '완성된 작품 뒤에서 사라지는 손, 실패와 반복을 남긴 무음의 영상입니다. 제작의 시간도 이 장례의 일부로 돌아옵니다.',
    introEn: 'A silent film of the hands, failures and repetitions that disappear behind the finished work. The time of making returns as part of this funeral.',
    quickStepsKo: ['화면 앞의 편한 자리에서 봅니다.', '영상은 소리 없이 반복됩니다.', '정해진 시작과 끝이 없습니다. 언제든 이동해도 됩니다.'],
    quickStepsEn: ['Watch from any comfortable place.', 'The film loops without sound.', 'There is no required beginning or ending. Leave at any time.'],
    quickNoteKo: '',
    quickNoteEn: '',
    essentialKo: '소리 없이 이어지는 제작의 시간을 원하는 만큼 바라봅니다. 영상에는 반드시 처음부터 보아야 하는 서사가 없습니다. 어느 장면에서 들어와도 되고, 한 장면만 본 뒤 나가도 됩니다.',
    essentialEn: 'Watch the silent record of making for as long as you wish. There is no required beginning or ending.',
    helpKo: '정해진 시작과 끝 없이 제작의 장면 사이에 머뭅니다.',
    helpEn: 'Watch the silent film from any point for as long as you wish. Phone connection is optional.',
    helpDetailKo: ['편한 자리에서 소리 없는 영상을 바라봅니다.', '영상에는 정해진 처음과 마지막이 없습니다. 중간 장면에서 시작해도 정상입니다.', '원하는 장면만 본 뒤 나가거나, 손의 노동과 반복을 오래 바라보아도 됩니다.', '휴대폰을 연결하지 않아도 영상을 볼 수 있습니다.'],
    helpDetailEn: ['Watch the silent film from a comfortable place.', 'The film has no fixed beginning or ending. Enter at any scene and leave at any time.', 'You may watch without connecting your phone.'],
    troubleshootKo: ['이 영상은 의도적으로 소리가 없습니다. 헤드폰도 사용하지 않습니다.', '영상에는 정해진 시작 화면이 없습니다. 중간 장면처럼 보여도 정상입니다.', '영상이 멈추거나 화면이 꺼진 경우 스태프에게 말씀해주세요.'],
    aboutKo: '완성된 작품 뒤에서 사라지는 손과 제작의 시간을 남긴 영상입니다. 장미, 스켈레톤, 전선과 센서가 하나의 몸이 되는 동안의 절단과 연결, 실패와 반복을 기록했습니다. 완성된 표면뿐 아니라 그 표면을 만들고 사라진 시간도 이 장례의 일부입니다.',
    aboutEn: 'RECORD preserves the labor, failed attempts, and repeated connections that disappear behind the completed works.',
    aboutDetailKo: ['제작 기록은 다른 작품을 설명하는 부록이나 홍보 영상이 아닙니다. 이 시신이 어떤 노동과 반복을 지나 만들어졌는지를 보여주는 또 하나의 부검 기록에 가깝습니다.', '인터랙티브 미디어 작품은 완성되면 기술이 보이지 않는 매끄러운 표면으로 나타나기 쉽습니다. 그러나 그 뒤에는 자르고 잇는 손, 실패한 테스트, 다시 시작된 연결, 사라진 버전과 고장 난 장치의 시간이 있습니다.', '이 작품은 그 과정을 숨겨 마술처럼 보이게 하지 않습니다. 기계 역시 몸을 가지고 있고, 그 몸은 수많은 손의 노동과 오류를 통해 만들어집니다.', '장미와 스켈레톤, 센서와 케이블은 각각 독립된 재료였다가 전시가 시작되는 순간 하나의 작동하는 시신이 됩니다. 관객이 만나는 것은 완제품이 아니라 계속 유지되고 다시 연결되어야 하는 임시적인 몸입니다.', '영상에 정해진 처음과 마지막이 없는 이유도 여기에 있습니다. 제작은 선명한 시작과 완성으로 정리되지 않습니다. 어느 장면에서 들어와도 손은 이미 무언가를 만들고 있고, 어느 순간 떠나도 작업은 다른 곳에서 계속됩니다.', '04는 앞선 작품들이 생겨난 물질적 시간과 그 시간을 감싸는 독립된 기록의 자리입니다. 완성된 결과에서 지워지기 쉬운 노동과 실패, 반복의 몸을 다시 화면 앞으로 돌려놓습니다.'],
  },
};

// Melbourne physical configuration. Keep these visitor instructions together
// so the still-changing title and verified on-site inputs can be changed once.
Object.assign(MODULES['01'], {
  introKo: '살아 있는 장미를 만지는 일은 돌봄이면서 동시에 꽃의 시간을 앞당깁니다. 몸을 회로로 삼아, 오늘 나와 공명하는 빛과 소리의 잠시적인 균형을 찾습니다.',
  introEn: 'Touching a living rose is an act of care that also advances its time. Using the body as a circuit, the work asks you to find one temporary balance of light and sound that resonates today.',
  quickStepsKo: ['한 손으로 검은 리본을 잡습니다.', '검은 리본을 잡은 채 다른 손으로 장미를 만지며 빛과 소리를 탐색합니다.', '장면을 남기려면 흰 리본과 검은 리본을 동시에 잡습니다.'],
  quickStepsEn: ['Hold the black ribbon with one hand.', 'Keep holding the black ribbon and touch a rose with your other hand to explore its light and sound.', 'To request a capture, hold the white and black ribbons at the same time.'],
  quickNoteKo: '짧은 기계음이 들리면 캡처가 요청된 것입니다.',
  quickNoteEn: 'A short mechanical sound confirms the capture request.',
  essentialKo: '한 손으로 검은 리본을 잡고 다른 손으로 생화 장미를 만집니다. 서로 다른 장미의 소리와 빛을 충분히 탐색한 뒤, 오늘의 나와 가장 공명하는 순간을 남기려면 흰 리본과 검은 리본을 동시에 잡습니다.',
  essentialEn: 'Hold the black ribbon with one hand and touch the living roses with the other. Explore their different sounds and lights, then hold the white and black ribbons at the same time to request a capture of the moment that resonates with you.',
  helpKo: '검은 리본을 잡고 장미를 만져 서로 다른 빛과 소리를 탐색합니다. 장면을 남기려면 흰 리본과 검은 리본을 동시에 잡습니다.',
  helpEn: 'Hold the black ribbon and touch the roses to explore different light and sound. Hold the white and black ribbons at the same time to request a capture.',
  helpDetailKo: ['한 손으로 검은 리본을 잡습니다.', '검은 리본을 잡은 채 다른 손으로 한 송이 또는 여러 송이의 생화 장미를 만집니다. 장미마다 서로 다른 소리와 빛이 나타납니다.', '같은 장미에 오래 머물거나 여러 장미를 조합해보세요. 머무는 시간이 길수록 소리와 빛의 층은 더 깊어집니다.', '아주 어두운 글리치부터 순간적으로 반짝이는 핑크빛까지 살피며, 오늘의 나와 가장 공명하는 픽셀과 소리의 균형을 찾습니다.', '그 순간의 캡처를 요청하려면 흰 리본과 검은 리본을 동시에 잡습니다. 짧은 기계음이 요청을 확인합니다.', '01을 마친 뒤, 방금 찾은 균형을 떠올리며 장미 이름을 지을 수 있습니다.'],
  helpDetailEn: ['Hold the black ribbon with one hand.', 'Keep holding the black ribbon and touch one or several living roses with the other. Each rose produces a different sound and light.', 'Stay longer or combine different roses. The layers deepen with time.', 'Find the balance of pixels and sound that resonates with you today.', 'To request a capture of that moment, hold the white and black ribbons at the same time. A short mechanical sound confirms the request.', 'After 01, you may give your rose its name.'],
  anonymousStartKo: '휴대폰 없이도 검은 리본을 잡고 장미를 만지면 바로 참여할 수 있습니다.',
  anonymousStartEn: 'To take part without a phone, hold the black ribbon and touch a rose.',
  troubleshootKo: ['반응이 없다면 검은 리본을 충분히 잡은 상태에서 장미를 다시 만져주세요.', '한 송이씩 천천히 만져 각 장미의 반응을 확인한 뒤 여러 송이를 조합해보세요.', '캡처가 요청되지 않으면 두 리본에서 손을 뗀 뒤, 흰 리본과 검은 리본을 동시에 다시 잡고 짧은 기계음이 들릴 때까지 유지해주세요.', '계속 작동하지 않거나 캡처가 보이지 않으면 스태프에게 말씀해주세요.'],
  troubleshootEn: ['If nothing responds, keep a firm hold on the black ribbon and touch the rose again.', 'Try one rose at a time before combining several roses.', 'If a capture is not requested, release both ribbons, then hold the white and black ribbons again at the same time until you hear the short mechanical sound.', 'If it still does not respond or your capture does not appear, ask a staff member.'],
  aboutKo: '검은 리본, 생화 장미와 관객의 몸이 하나의 임시적인 회로가 됩니다. 장미를 만지는 행동은 빛과 소리를 만들면서 동시에 꽃의 시간을 앞당깁니다. 흰 리본과 검은 리본을 함께 잡는 동작은 관객이 선택한 순간의 캡처를 요청합니다.',
  aboutEn: 'The black ribbon, living roses and the audience body form a temporary circuit. Touch creates light and sound while also advancing the flowers\' time. Holding the white and black ribbons together requests a capture of the visitor\'s chosen moment.',
  aboutDetailKo: ['검은 리본과 매달린 생화 장미는 관객의 몸을 통해 하나의 임시적인 회로가 됩니다.', '가능한 모든 조합을 소유하는 대신, 오늘 몸이 반응하는 한순간의 균형을 찾습니다.', '흰 리본과 검은 리본을 동시에 잡으면 방금 선택한 균형의 캡처를 요청합니다.'],
  aboutDetailEn: ['The black ribbon and hanging living roses form a temporary circuit through the audience body.', 'Rather than possessing every possible combination, the visitor finds one temporary balance to which the body responds.', 'Holding the white and black ribbons at the same time requests a capture of the balance just chosen.'],
});

Object.assign(MODULES['02'], {
  quickNoteKo: '',
  quickNoteEn: '',
  troubleshootEn: ['If the hand masks do not appear, step back until your whole hand and face are in frame.', 'For a capture, hold any two Rose Human Interface buttons together for five seconds.', 'If it still does not respond, ask a staff member.'],
});

Object.assign(MODULES['03'], {
  quickNoteKo: '소리는 헤드폰이 아니라 공간의 스피커로 재생됩니다. 손을 멈추고 바라보아도 작품은 종료되지 않습니다.',
  quickNoteEn: 'Sound plays through room speakers, not headphones. Keeping your hand still does not end the work.',
  troubleshootEn: ['If the video time does not change, keep your hand near the rose and make a clearer vertical movement.', 'If witnessing does not continue, move your hand fully away from the rose, then bring it back slowly.', 'When you find the rose-skeleton, press the rose button once clearly.', 'If the speakers or screen do not respond, ask a staff member.'],
});

Object.assign(MODULES['04'], {
  introKo: '완성된 작품 뒤에서 사라지는 손, 실패와 반복을 남긴 무음의 영상입니다. 제작의 시간도 이 장례의 일부로 돌아옵니다.',
  introEn: 'A silent film of the hands, failures and repetitions that disappear behind the finished work. The time of making returns as part of this funeral.',
  quickStepsKo: ['편한 위치에서 바라봅니다.', '영상은 소리 없이 반복됩니다.', '정해진 시작과 끝이 없으며 캡처를 만들지 않습니다.'],
  quickStepsEn: ['Watch from any comfortable position.', 'The film loops without sound.', 'There is no required beginning or ending, and this work does not create captures.'],
  essentialKo: '휴대폰 연결이나 독점 점유 없이, 여러 사람이 편한 위치에서 원하는 만큼 바라봅니다.',
  essentialEn: 'Watch for as long as you wish, from any comfortable position. Phone connection and exclusive use are not required.',
  helpEn: 'Watch the silent loop from any point for as long as you wish. No phone connection or capture is required.',
  troubleshootEn: ['This film is intentionally silent and does not use headphones.', 'There is no required opening frame. Beginning in the middle of a scene is expected.', 'If the film stops or the screen turns off, ask a staff member.'],
});

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

function patternAnimationMotionLayer(stationId) {
  const motionClass = {
    '01': 'motion-naming',
    '02': 'motion-intervention',
    '03': 'motion-witness',
    '04': 'motion-record',
  }[stationId] || 'motion-naming';
  return el('div', {
    class: `pattern-motion-layer ${motionClass}`,
    'aria-hidden': 'true',
  },
    ...['a', 'b', 'c', 'd'].map((piece) => el('i', {
      class: `pattern-motion-fragment fragment-${piece}`,
      html: rosePatternSvg(stationId),
    })),
    el('i', { class: 'pattern-motion-merge-ring' }),
    el('i', { class: 'pattern-motion-merge-core' }),
  );
}

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
      patternAnimationMotionLayer(stationId),
      el('div', { class: 'pattern-animation-symbol', html: rosePatternSvg(stationId) }),
      el('div', { class: 'pattern-animation-specimen' },
        roseSpecimenImage('', 'pattern-animation-specimen-image', compact
          ? ROSE_SPECIMEN_ANIMATION_COMPACT_IMAGE
          : ROSE_SPECIMEN_ANIMATION_IMAGE),
        el('i', { class: 'pattern-animation-tint' }),
        el('i', { class: 'pattern-animation-scan' }),
      ),
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
const PATTERN_ANIMATION_LIVE_DURATION_MS = 1100;

async function decodePatternAnimationImage(stage) {
  const image = stage.querySelector('.pattern-animation-specimen-image');
  try {
    if (image && !image.complete) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timeoutId);
          image.removeEventListener('load', finish);
          image.removeEventListener('error', finish);
          resolve();
        };
        const timeoutId = setTimeout(finish, 1200);
        image.addEventListener('load', finish, { once: true });
        image.addEventListener('error', finish, { once: true });
      });
    }
    // decode() itself can remain pending on a stalled request even after the
    // load-wait timeout. Decode only a completed image and cap that wait too,
    // so PREPARING can always fall through to the visual fallback.
    if (image?.decode && image.complete && image.naturalWidth > 0) {
      await Promise.race([
        image.decode().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
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
        el('div', { class: 'wordmark', 'aria-label': 'META ROSE 26 · MELB FRINGE' },
          el('span', { class: 'wordmark-copy' },
            el('span', {}, 'META ROSE 26'),
            el('span', { class: 'wordmark-fringe' }, 'MELB FRINGE'),
          ),
        ),
        el('span', { class: 'micro-label' }, 'ANIMATION STUDY / V5'),
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
      el('div', { class: 'wordmark', 'aria-label': 'META ROSE 26 · MELB FRINGE' },
        el('span', { class: 'wordmark-copy' },
          el('span', {}, 'META ROSE 26'),
          el('span', { class: 'wordmark-fringe' }, 'MELB FRINGE'),
        ),
      ),
      el('span', { class: 'micro-label' }, 'ANIMATION STUDY / V5'),
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

function stationConnectionFeedback(stationId, entryStatus = null) {
  const module = MODULES[stationId];
  if (!entryStatus || entryStatus.stationId !== stationId) return '';
  if (entryStatus.code === 'busy') {
    return tr(
      `다른 장미가 ${module.ko}을 체험 중입니다. 작품이 비어 있다면 잠시 후 다시 선택하세요.`,
      `ANOTHER ROSE IS EXPERIENCING ${module.en}. IF THE WORK IS EMPTY, TRY AGAIN SHORTLY.`,
    );
  }
  if (entryStatus.code === 'setup_required') {
    return tr(
      '연결되지 않았습니다. 다시 시도하거나 스태프에게 현재 설치된 시작 방법을 확인해주세요.',
      'NOT CONNECTED. TRY AGAIN OR ASK STAFF WHICH START METHOD IS CURRENTLY INSTALLED.',
    );
  }
  if (entryStatus.code === 'lease_lost') {
    return tr(
      '연결 시간이 끝났습니다. 작품 앞에서 다시 연결해주세요.',
      'THE CONNECTION HAS ENDED. CONNECT AGAIN AT THE WORK.',
    );
  }
  if (entryStatus.code === 'available') {
    return tr(
      '이전 상태가 더 이상 확인되지 않습니다. 다시 연결해 현재 상태를 확인하세요.',
      'THE PREVIOUS STATUS IS NO LONGER ACTIVE. CONNECT AGAIN TO CHECK THE WORK.',
    );
  }
  if (['offline', 'status_unavailable', 'connection_error',
    'connection_timeout'].includes(entryStatus.code)) {
    return tr(
      '연결 상태를 확인할 수 없습니다. 네트워크를 확인하고 다시 시도해주세요.',
      'THE CONNECTION COULD NOT BE CHECKED. CHECK THE NETWORK AND TRY AGAIN.',
    );
  }
  if (['readback_failed', 'session_unavailable', 'previous_close_failed',
    'claim_rejected', 'invalid_session', 'conflict'].includes(entryStatus.code)) {
    return tr(
      '연결되지 않았습니다. 다시 연결하거나 스태프에게 현재 설치된 시작 방법을 확인해주세요.',
      'NOT CONNECTED. TRY AGAIN OR ASK STAFF WHICH START METHOD IS CURRENTLY INSTALLED.',
    );
  }
  return '';
}

async function requestStationConnection(
  stationId,
  { panel, button, feedback, via = 'work_number' },
) {
  if (stationConnectionUiInFlight) return false;
  stationConnectionUiInFlight = true;
  const attempt = ++stationConnectionUiAttempt;
  // A manual retry supersedes any read-only foreground check that may still
  // be in flight. Only this claim's response may decide CONNECTED or BUSY.
  stationStatusRevalidationGeneration += 1;
  panel.dataset.state = 'connecting';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  feedback.classList.remove('is-busy');
  feedback.textContent = tr('연결 중', 'CONNECTING');

  try {
    await screenModule(stationId, { enter: true, via });
    return true;
  } finally {
    if (attempt === stationConnectionUiAttempt) {
      stationConnectionUiInFlight = false;
      if (button.isConnected) {
        panel.dataset.state = '';
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  }
}

async function playPatternSuccessTransition(panel, button, stationId) {
  panel.dataset.state = 'matched';
  panel.dataset.matchedStation = stationId;
  button.classList.add('is-matched');
  const stage = patternAnimationStage(stationId);
  stage.classList.add('is-live-entry');
  stage.style.setProperty('--pattern-animation-duration', `${PATTERN_ANIMATION_LIVE_DURATION_MS}ms`);
  let skipAnimation = null;
  const skipPromise = new Promise((resolve) => { skipAnimation = resolve; });
  const skipButton = el('button', {
    class: 'pattern-entry-skip',
    type: 'button',
    onclick: () => skipAnimation?.('skip'),
  }, tr('애니메이션 건너뛰기', 'SKIP ANIMATION'));
  const overlay = el('div', {
    class: 'pattern-entry-transition-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': tr('장미를 작품에 연결하고 있습니다', 'CONNECTING YOUR ROSE TO THE WORK'),
  }, stage, skipButton);
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const previousInert = {
    app: $app.inert,
    dock: $dock.inert,
    bar: $bar.inert,
  };
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      skipAnimation?.('skip');
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled && node.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.body.appendChild(overlay);
  $app.inert = true;
  $dock.inert = true;
  $bar.inert = true;
  skipButton.focus();

  try {
    if (reduceMotionEnabled()) {
      overlay.classList.add('is-reduced-motion');
      await new Promise((resolve) => setTimeout(resolve, 120));
      return;
    }
    const prepared = await Promise.race([
      replayPatternAnimation(stage).then(() => 'ready'),
      skipPromise,
    ]);
    if (prepared === 'skip') return;
    const completed = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve('complete'), PATTERN_ANIMATION_LIVE_DURATION_MS)),
      skipPromise,
    ]);
    if (completed === 'skip') return;
    overlay.classList.add('is-leaving');
    await new Promise((resolve) => setTimeout(resolve, 180));
  } finally {
    overlay.remove();
    const blockingDialogOpen = Boolean(
      document.getElementById('inactive-tab-overlay')
      || document.querySelector('.rose-menu-overlay')
    );
    $app.inert = blockingDialogOpen || previousInert.app;
    $dock.inert = blockingDialogOpen || previousInert.dock;
    $bar.inert = Boolean(document.getElementById('inactive-tab-overlay')) || previousInert.bar;
    if (!blockingDialogOpen) {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      else ($app.querySelector('h1, button, a[href]'))?.focus?.({ preventScroll: true });
    }
    panel.dataset.state = 'connecting';
  }
}

function stationConnectionPanel(stationId, entryStatus = null) {
  const module = MODULES[stationId];
  const reconnect = ['busy', 'connected'].includes(entryStatus?.code);
  const feedbackId = `station-connection-feedback-${stationId}`;
  const feedback = el('p', {
    id: feedbackId,
    class: `station-connection-feedback${entryStatus?.code === 'busy' ? ' is-busy' : ''}`,
    role: entryStatus?.code ? 'alert' : 'status',
    'aria-live': entryStatus?.code ? 'assertive' : 'polite',
  }, stationConnectionFeedback(stationId, entryStatus));
  const panel = el('section', {
    class: 'station-connection-panel',
    'data-station': stationId,
    'aria-label': tr(`${stationId} ${module.ko} 연결`, `Connect to ${stationId} ${module.en}`),
  });
  if (entryStatus?.code === 'connected') {
    panel.append(el('div', { class: 'connected-banner' },
      el('span', {}, tr('● 연결됨', '● CONNECTED')),
      el('span', {}, tr('작품을 시작하세요', 'START THE WORK')),
    ));
  }
  const button = el('button', {
    class: 'primary-action direct-station-entry',
    type: 'button',
    'aria-describedby': feedbackId,
  },
    reconnect
      ? tr('다시 연결', 'CONNECT AGAIN')
      : tr(`${stationId} ${module.ko} 연결`, `CONNECT TO ${stationId} ${module.en}`),
    el('span', { 'aria-hidden': 'true' }, '→'),
  );
  button.addEventListener('click', () => {
    void requestStationConnection(stationId, {
      panel,
      button,
      feedback,
      via: reconnect ? 'connect_again' : 'work_number',
    });
  });
  panel.append(button, feedback);
  return panel;
}

function moduleHero(stationId, module) {
  const fileName = {
    '01': 'module_01_naming_hero.jpeg',
    '02': 'module_02_reenactment_hero.png',
    '03': 'module_03_mourning_hero.png',
    '04': 'module_04_archive_hero.png',
  }[stationId];

  const heroLabel = {
    '01': tr('분홍 장미 이미지가 대칭으로 반복된 명명 작품 비주얼', 'A mirrored pink-rose image used for Naming'),
    '02': tr('선과 점으로 스캔된 분홍 장미 개입 작품 비주얼', 'A pink rose rendered through scanning lines and points for Intervention'),
    '03': tr('네 가지 빛과 색의 상태로 나뉜 장미와 한국어 문장이 있는 목격 작품 비주얼', 'A rose divided into four states of light and colour, with Korean text, for Witness'),
    '04': tr('추적된 장미 화면과 TouchDesigner 노드가 보이는 제작 과정 이미지', 'A production view showing tracked roses and a TouchDesigner node network for Record'),
  }[stationId];

  return el('div', { class: `module-hero module-${module.visual}` },
    el('span', { class: 'module-coordinate coordinate-a' }, stationId === '04'
      ? tr('04 / 공동 관람', '04 / SHARED VIEW')
      : tr(`${stationId} / 입력`, `${stationId} / INPUT`)),
    el('span', { class: 'module-coordinate coordinate-b' }, stationId === '04'
      ? tr('무음 반복 영상', 'SILENT LOOP')
      : tr('스캔 중', 'SCAN ACTIVE')),
    assetFrame(fileName, {
      className: 'module-asset',
      label: heroLabel,
      type: `MODULE ${stationId} HERO / P0`,
      note: `${module.en} / ${module.ko}`,
      loading: 'eager',
      fetchPriority: 'high',
    }),
    stationId === '03' ? el('p', { class: 'module-image-translation' }, tr(
      '이미지 속 문구: “이 복잡한 마음은 늘 두 가지 일을 동시에 한다.”',
      'Text in image: “This complex mind is always doing two things at once.”',
    )) : null,
  );
}

function captureResultPanel(stationId) {
  if (!['01', '02', '03'].includes(stationId)) return null;
  const isSub1 = stationId === '02';
  const isSub2 = stationId === '03';
  const autoPollsCapture = ['01', '02', '03'].includes(stationId);
  return el('section', {
    class: 'module-capture-panel',
    id: `module-capture-${stationId}`,
    'data-station': stationId,
    'data-fetch-state': 'loading',
    'aria-busy': 'true',
  },
    el('span', { class: 'micro-label' }, tr(`작품 ${stationId}`, `WORK ${stationId}`)),
    el('h2', {}, tr('내가 남긴 장면', 'MY CAPTURED MOMENT')),
    el('div', {
      class: 'capture-fetch-status',
      id: `capture-status-${stationId}`,
    },
      el('span', { class: 'capture-fetch-status-copy' }, tr(
        '새 캡처를 확인하고 있습니다…',
        'CHECKING FOR A NEW CAPTURE…',
      )),
      el('span', {
        class: 'capture-poll-announcement',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      }),
    ),
    el('div', { class: 'capture-result-stage' },
      el('div', { class: 'capture-empty' },
        el('span', { class: 'capture-empty-mark', 'aria-hidden': 'true' }, '＋'),
        el('p', {}, tr(
          '이 작품에서 남긴 장면이 이곳에 나타납니다.',
          'The moment you leave in this work will appear here.',
        )),
        autoPollsCapture ? el('small', {}, tr(
          isSub2
            ? '이 페이지에서는 새 장면을 자동으로 확인합니다.'
            : '연결 중에는 새 장면을 자동으로 확인합니다.',
          isSub2
            ? 'New captures are checked automatically while this page is open.'
            : 'New captures are checked automatically while connected.',
        )) : null,
      ),
    ),
  );
}

function setCapturePanelStatus(stationId, state, detail = '', options = {}) {
  const panel = document.getElementById(`module-capture-${stationId}`);
  const status = document.getElementById(`capture-status-${stationId}`);
  const statusCopy = status?.querySelector('.capture-fetch-status-copy');
  const announcement = status?.querySelector('.capture-poll-announcement');
  if (!panel || !status || !statusCopy || !announcement) return false;
  const normalizedDetail = String(detail || '');
  const unchanged = panel.dataset.fetchState === state
    && (panel.dataset.statusDetail || '') === normalizedDetail;
  panel.dataset.fetchState = state;
  panel.dataset.statusDetail = normalizedDetail;
  panel.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  if (unchanged && !options.force) return false;
  const labels = {
    loading: tr('새 캡처를 확인하고 있습니다…', 'CHECKING FOR A NEW CAPTURE…'),
    waiting: tr('캡처 대기 중', 'WAITING FOR A CAPTURE'),
    ready: tr('캡처가 준비되었습니다', 'YOUR CAPTURE IS READY'),
    offline: tr('네트워크에 연결되면 다시 확인합니다', 'WE WILL CHECK AGAIN WHEN THE NETWORK RETURNS'),
    error: tr('이미지를 불러오지 못했습니다', 'WE COULD NOT LOAD THE IMAGE'),
  };
  statusCopy.textContent = labels[state] || labels.waiting;
  status.querySelector('.capture-retry-button')?.remove();
  if (state === 'error' || state === 'offline') {
    status.append(el('button', {
      class: 'capture-retry-button',
      type: 'button',
      onclick: () => { void refreshCaptureResultPanel(stationId); },
    }, tr('다시 확인', 'TRY AGAIN')));
  }
  if (options.announce || state === 'error' || state === 'offline') {
    announceCaptureStatus(announcement, options.message || labels[state] || labels.waiting);
  }
  if (normalizedDetail) status.dataset.detail = normalizedDetail;
  else delete status.dataset.detail;
  return true;
}

function announceCaptureStatus(node, message) {
  if (!node || !message) return;
  node.textContent = '';
  queueMicrotask(() => {
    if (node.isConnected) node.textContent = message;
  });
}

function captureStoragePath(artifact) {
  if (artifact?.image_path) return artifact.image_path;
  if (artifact?.meta?.storage_path) return artifact.meta.storage_path;
  return null;
}

async function captureDisplayUrl(artifact) {
  if (TEST_MODE) return artifact?.image_url || null;
  const path = captureStoragePath(artifact);
  if (!path) return artifact?.image_url || null;
  const cached = captureUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const url = await createCaptureSignedUrl(path, 1800);
  if (url) captureUrlCache.set(path, { url, expiresAt: Date.now() + 25 * 60 * 1000 });
  return url;
}

async function saveCaptureFromUrl(url, stationId, itemNumber = 1) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`capture download ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `meta-rose-${ensureSession().display_record_no}-${stationId}-${itemNumber}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    logEvent('capture_image_saved', { station_id: stationId, item_number: itemNumber }, stationId);
  } catch (error) {
    console.warn('[capture] direct save failed', error);
    window.open(url, '_blank', 'noopener');
    alert(tr(
      '이미지를 새 화면에 열었습니다. 브라우저의 이미지 저장 기능을 이용해주세요.',
      'The image opened in a new screen. Use your browser’s image save control.',
    ));
  }
}

async function refreshCaptureResultPanel(stationId) {
  const panel = document.getElementById(`module-capture-${stationId}`);
  if (!panel || !panel.isConnected) return false;
  const normalizedStationId = String(stationId).padStart(2, '0');
  panel.setAttribute('aria-busy', 'true');
  panel.dataset.pollAttempt = String((Number(panel.dataset.pollAttempt) || 0) + 1);
  panel.dataset.lastPollStartedAt = new Date().toISOString();
  const fetchedArtifacts = TEST_MODE ? [] : await fetchMyCaptureArtifacts(normalizedStationId);
  const fetchStatus = getArtifactFetchStatus();
  panel.dataset.lastPollCompletedAt = new Date().toISOString();
  panel.dataset.lastPollCount = String(fetchedArtifacts.length);
  // SUB2 may finish its private Storage upload just after station presence
  // closes. Keep every capture belonging to the persistent phone session,
  // remove duplicate rows/paths, and retain chronological carousel order.
  // Existing MAIN1/SUB1 ordering is intentionally left unchanged.
  const artifacts = normalizedStationId === '03'
    ? fetchedArtifacts
      .filter((artifact, index, list) => {
        const id = artifact?.id == null ? null : String(artifact.id);
        const path = captureStoragePath(artifact);
        return !list.slice(0, index).some((previous) => (
          (id && previous?.id != null && String(previous.id) === id)
          || (path && captureStoragePath(previous) === path)
        ));
      })
      .sort((a, b) => (
        new Date(a.occurred_at || a.created_at || 0)
        - new Date(b.occurred_at || b.created_at || 0)
      ))
    : fetchedArtifacts;
  if (!panel.isConnected) return false;
  if (fetchStatus.state === 'error') {
    setCapturePanelStatus(normalizedStationId, 'error', fetchStatus.error || '');
    return false;
  }
  if (fetchStatus.state === 'offline' && !artifacts.length) {
    setCapturePanelStatus(normalizedStationId, 'offline');
    return false;
  }
  if (!artifacts.length) {
    setCapturePanelStatus(normalizedStationId, 'waiting');
    return false;
  }

  const resolved = (await Promise.all(artifacts.map(async (artifact) => ({
    artifact,
    url: await captureDisplayUrl(artifact),
  })))).filter((item) => item.url);
  if (!panel.isConnected) return false;
  if (!resolved.length) {
    setCapturePanelStatus(normalizedStationId, fetchStatus.state === 'offline' ? 'offline' : 'error');
    return false;
  }

  const fingerprint = resolved.map(({ artifact }) => artifact.id || captureStoragePath(artifact) || artifact.value).join('|');
  if (panel.dataset.fingerprint === fingerprint) {
    setCapturePanelStatus(normalizedStationId, 'ready');
    return true;
  }
  panel.dataset.fingerprint = fingerprint;

  let index = 0;
  const stage = el('div', { class: 'capture-result-stage has-capture' });
  const image = el('img', { class: 'capture-result-image', alt: '' });
  const count = el('span', { class: 'capture-result-count', 'aria-hidden': 'true' });
  const carouselAnnouncement = el('span', {
    class: 'capture-carousel-announcement',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  const openLink = el('a', {
    class: 'capture-result-open',
    target: '_blank',
    rel: 'noopener',
  }, tr('이미지 열기', 'OPEN IMAGE'), el('span', { 'aria-hidden': 'true' }, '↗'));
  const saveButton = el('button', {
    class: 'capture-result-save',
    type: 'button',
    onclick: () => { void saveCaptureFromUrl(resolved[index].url, normalizedStationId, index + 1); },
  }, tr('이미지 저장', 'SAVE IMAGE'), el('span', { 'aria-hidden': 'true' }, '↓'));

  const show = (nextIndex, { announce = false } = {}) => {
    index = (nextIndex + resolved.length) % resolved.length;
    image.src = resolved[index].url;
    image.alt = tr(
      `${normalizedStationId} ${workTitle(normalizedStationId)}에서 남긴 장면 ${index + 1} / ${resolved.length}`,
      `Capture ${index + 1} of ${resolved.length} from ${normalizedStationId} ${stationLabel(normalizedStationId)}`,
    );
    openLink.href = resolved[index].url;
    count.textContent = `${index + 1} / ${resolved.length}`;
    if (announce) {
      carouselAnnouncement.textContent = tr(
        `장면 ${index + 1} / ${resolved.length}`,
        `Capture ${index + 1} of ${resolved.length}`,
      );
    }
  };

  stage.append(
    image,
    el('div', { class: 'capture-result-meta' },
      count,
      resolved.length > 1 ? el('div', { class: 'capture-result-nav' },
        el('button', { type: 'button', 'aria-label': tr('이전 장면', 'Previous capture'), onclick: () => show(index - 1, { announce: true }) }, '←'),
        el('button', { type: 'button', 'aria-label': tr('다음 장면', 'Next capture'), onclick: () => show(index + 1, { announce: true }) }, '→'),
      ) : null,
      carouselAnnouncement,
    ),
    el('div', { class: 'capture-result-actions' }, openLink, saveButton),
  );
  panel.querySelector('.capture-result-stage')?.replaceWith(stage);
  show(0);
  setCapturePanelStatus(normalizedStationId, 'ready', '', {
    force: true,
    announce: true,
    message: tr(
      `새 캡처가 준비되었습니다. 전체 ${resolved.length}개.`,
      `A new capture is ready. ${resolved.length} total.`,
    ),
  });
  logEvent('capture_result_available', { count: resolved.length }, stationId);
  return true;
}

function startModuleCapturePolling(stationId) {
  const normalizedStationId = String(stationId).padStart(2, '0');
  if (!['01', '02', '03'].includes(normalizedStationId)) return;
  stopCapturePolling();
  const generation = capturePollGeneration;
  // A TD upload may complete just after station presence closes. Every capture
  // page therefore revalidates by persistent session UUID while it remains
  // open; presence is deliberately not a polling prerequisite.
  const persistentResultPolling = true;
  let inFlight = false;

  const isCurrentCaptureView = () => (
    capturePollGeneration === generation
    && currentView.name === 'module'
    && String(currentView.data.stationId).padStart(2, '0') === normalizedStationId
  );

  const schedule = (delay) => {
    if (!isCurrentCaptureView()) return;
    if (capturePollTimer) clearTimeout(capturePollTimer);
    capturePollTimer = setTimeout(() => { void poll(); }, delay);
  };

  const poll = async () => {
    if (!isCurrentCaptureView()) return;
    if (inFlight) {
      schedule(350);
      return;
    }
    inFlight = true;
    try {
      await refreshCaptureResultPanel(normalizedStationId);
    } catch (error) {
      console.warn(`[capture] station ${normalizedStationId} refresh failed`, error);
    } finally {
      inFlight = false;
    }
    if (isCurrentCaptureView() && persistentResultPolling) {
      schedule(4000);
    }
  };

  capturePollFocusHandler = () => {
    if (document.visibilityState === 'visible') schedule(0);
  };
  capturePollVisibilityHandler = () => {
    if (document.visibilityState === 'visible') schedule(0);
  };
  capturePollPageShowHandler = () => schedule(0);
  capturePollOnlineHandler = () => schedule(0);
  window.addEventListener('focus', capturePollFocusHandler);
  document.addEventListener('visibilitychange', capturePollVisibilityHandler);
  window.addEventListener('pageshow', capturePollPageShowHandler);
  window.addEventListener('online', capturePollOnlineHandler);

  schedule(0);
}

async function returnHomeFromStation(stationId) {
  markStationComplete(stationId);
  return goHome();
}

async function screenModule(stationId, options = {}) {
  const viewGenerationAtRequest = viewGeneration;
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
  if (options.enter && stationId === '04') {
    // 04 itself is non-exclusive, but choosing it is an explicit move away
    // from a previously connected interactive work. Close that exact prior
    // presence so it cannot remain reserved for the next visitor.
    if (session.connected_station && session.connected_station !== '04') {
      await releaseCurrentStation('station_switch_to_record');
    }
    markStationComplete('04');
    logEvent('record_visit', { via, nonexclusive: true, capture_expected: false }, '04');
    entryStatus = { code: 'recorded', stationId: '04' };
  } else if (options.enter && TEST_MODE) {
    const previousConnectedStation = ensureSession().connected_station || null;
    if (previousConnectedStation && previousConnectedStation !== stationId) {
      markStationComplete(previousConnectedStation);
    }
    updateSession({ connected_station: stationId });
    window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: stationId } }));
    logEvent('station_enter', { via, test_mode: true }, stationId);
    entryStatus = { code: 'connected', stationId, testMode: true };
  } else if (options.enter && localOnly) {
    // A local-only visitor may read every page, but must explicitly opt in
    // before a Supabase presence can activate TD or return a capture.
    logEvent('station_local_only_view', { via }, stationId);
  } else if (options.enter) {
    const uiSessionId = ensureSession().id;
    const previousConnectedStation = ensureSession().connected_station || null;
    const currentName = visitorRoseName(ensureSession());
    const currentHasVisitorName = Boolean(currentName);
    const controlFields = {
      color: ensureSession().color,
      lang: ensureSession().lang,
      pseudonym: phoneRoseLabel(ensureSession()),
      final_name: currentName || null,
      final_name_a: currentHasVisitorName ? (ensureSession().emotional_name_a || null) : null,
      final_name_b: currentHasVisitorName ? (ensureSession().emotional_name_b || null) : null,
    };
    const controlsConfirmed = activeDbSessionMatches(uiSessionId)
      ? await confirmSessionControlFields(uiSessionId, controlFields)
      : null;
    const boundStation = controlsConfirmed && ownsActiveTab(uiSessionId)
      ? await enterDbStation(stationId, via, uiSessionId)
      : null;
    entryStatus = getLastStationEntryStatus();
    const entryViewIsCurrent = viewGeneration === viewGenerationAtRequest
      && currentView.name === 'module'
      && String(currentView.data.stationId || '').padStart(2, '0') === stationId;
    if (boundStation === stationId
        && (!entryViewIsCurrent || !ownsActiveTab(uiSessionId))) {
      // The network response arrived after the visitor navigated away or a
      // different tab took control. Close that exact presence and never pull
      // the old screen back into view.
      await leaveDbStation(stationId);
      return;
    }
    if (!entryViewIsCurrent || !ownsActiveTab(uiSessionId)) return;
    if (boundStation === stationId && ownsActiveTab(uiSessionId)) {
      if (previousConnectedStation && previousConnectedStation !== stationId) {
        markStationComplete(previousConnectedStation);
        logEvent('station_leave', {
          reason: 'station_switch',
          next_station: stationId,
        }, previousConnectedStation);
        if (!TEST_MODE) flushAnalyticsEvents('station_switch');
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
  const recordVisited = stationId === '04' && getCompletedStations(freshSession).includes('04');
  rememberView('module', {
    stationId,
    options: { ...options, enter: false, entryStatus },
  });
  applySessionColor(freshSession.color);
  logEvent('module_page_view', { via, connected }, stationId);

  render([
    globalHeader(),
    el('section', { class: 'screen module-screen' },
      personalHeader(stationId === '04' ? null : stationId),
      el('div', { class: 'module-title-block' },
        el('span', { class: 'micro-label' }, tr(`작품 ${stationId} / ${module.ko}`, `MODULE ${stationId} / ${module.en}`)),
        el('h1', { class: 'module-title-display' }, tr(module.ko, module.en)),
      ),
      moduleHero(stationId, module),
      el('section', { class: 'module-info-block module-quick-intro' },
        el('p', {}, tr(module.introKo, module.introEn)),
      ),
      textButton(tr('이 작품에 대해 더 읽기', 'READ MORE ABOUT THIS WORK'), () => {
        navigateWithinPhoneHub(
          () => screenAboutProject(workAboutSection(stationId)),
        );
      }, 'module-full-story'),
      recordVisited ? el('div', { class: 'connected-banner record-visit-banner' },
        el('span', {}, tr('✓ 04 기록', '✓ 04 RECORD')),
        el('span', {}, tr('방문을 나의 장미에 남겼습니다 · 캡처 없음', 'VISIT ADDED TO MY ROSE · NO CAPTURE')),
      ) : stationId === '04' ? null : freshSession.local_only ? el('section', { class: 'tag-instruction local-only-station-notice' },
        el('span', { class: 'tag-symbol', 'aria-hidden': 'true' }, '⌑'),
        el('div', {},
          el('h2', {}, tr('휴대폰에 기록하려면 연결하세요', 'CONNECT TO SAVE ON YOUR PHONE')),
          el('p', {}, tr(
            module.anonymousStartKo || '스태프에게 현재 설치된 현장 시작 방법을 확인해주세요.',
            module.anonymousStartEn || 'Ask staff which on-site start method is currently installed.',
          )),
          textButton(tr('Phone Hub 안내 후 연결', 'REVIEW PHONE HUB & CONNECT'), () => {
            updateSession({
              pending_station: stationId,
              pending_station_via: via,
            });
            screenArrival();
          }, 'local-only-connect'),
        ),
      ) : connected ? stationConnectionPanel(stationId, {
        code: 'connected',
        stationId,
      }) : stationConnectionPanel(stationId, entryStatus),
      el('section', { class: 'module-info-block module-quick-steps' },
        el('span', { class: 'micro-label' }, tr('작동법', 'HOW TO PLAY')),
        el('h2', {}, tr('작동법', 'HOW TO PLAY')),
        el('ol', { class: 'detailed-step-list quick-step-list' }, ...tr(module.quickStepsKo, module.quickStepsEn).map((step) => el('li', {}, step))),
        module.quickNoteKo ? el('p', { class: 'module-quick-note' }, tr(module.quickNoteKo, module.quickNoteEn)) : null,
      ),
      el('section', { class: 'module-info-block troubleshooting-block' },
        disclosure(
          tr('잘 되지 않을 때', 'TROUBLESHOOTING'),
          el('div', { class: 'copy-stack' },
            module.anonymousStartKo ? el('p', { class: 'troubleshooting-no-phone' },
              el('strong', {}, tr('휴대폰이 연결되지 않았을 때. ', 'WHEN THE PHONE IS NOT CONNECTED. ')),
              tr(module.anonymousStartKo, module.anonymousStartEn),
            ) : null,
            ...tr(
              module.troubleshootKo || [],
              module.troubleshootEn || module.helpDetailEn || [],
            ).map((paragraph) => el('p', {}, paragraph)),
          ),
          `troubleshoot_${stationId}`,
        ),
      ),
      captureResultPanel(stationId),
      stationId === '01' ? textButton(
        tr('장미 이름 짓기', 'NAME MY ROSE'),
        () => {
          navigateWithinPhoneHub(
            () => screenMySpecimen({
              returnTo: { name: 'module', data: { stationId, options: { via: 'back' } } },
            }),
          );
        },
        'module-name-optional',
      ) : null,
      !connected ? textButton('HOME', () => { void goHome(); }, 'return-home') : null,
    ),
  ], connected ? [
    primaryButton('HOME', () => { void returnHomeFromStation(stationId); }),
  ] : []);
  startModuleCapturePolling(stationId);
  if (!options.enter
      && !options.skipConnectionRevalidation
      && !TEST_MODE
      && ['01', '02', '03'].includes(stationId)) {
    scheduleVisibleStationRevalidation('screen_entry');
  }
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
        el('span', {}, tr('나의 장미', 'MY ROSE')),
        el('span', {}, `ROSE NO. ${session.display_record_no}`),
      ),
      roseVisual('specimen', tr('현재 나의 장미', 'CURRENT MY ROSE'), traceProfile),
      el('div', { class: 'specimen-name' },
        el('span', {}, tr('나의 장미 이름', 'NAME OF MY ROSE')),
        el('h1', {}, displayName(session)),
      ),
      myRoseNameEditor({ returnTo }),
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
        textButton('HOME', () => { void goHome(); }),
      ),
    ),
  ]);
  void refreshRemoteTraceSummaries();
}

async function screenExitJourney() {
  if (!(await releaseCurrentStation('exit'))) return;
  const session = ensureSession();
  rememberView('exit');
  clearStationQuery();

  const missing = ['01', '02', '03', '04'].filter((stationId) => !getCompletedStations(session).includes(stationId));
  logEvent('exit_entered', { missing_modules: missing }, '05');
  if (!TEST_MODE) flushAnalyticsEvents('exit_entered');

  render([
    globalHeader(),
    el('section', { class: 'screen exit-screen' },
      el('span', { class: 'micro-label' }, tr('05 / 출구', '05 / DEPARTURE')),
      el('h1', { class: 'screen-title' }, tr('나가기 전', 'BEFORE YOU LEAVE')),
      el('p', { class: 'intro-copy' }, tr(
        '지금까지의 장미와 캡처를 보거나, 작품으로 돌아가거나, 경험을 남길 수 있습니다. 모든 작품을 방문하거나 설문을 제출할 필요는 없습니다.',
        'View your rose and captures so far, return to a work, or share feedback. You do not need to visit every work or complete the survey.',
      )),
      textButton(tr('작품으로 돌아가기', 'RETURN TO THE WORKS'), () => { void goHome(); }),
      textButton(tr('경험 남기기', 'SHARE FEEDBACK'), screenSurvey, 'exit-optional-reflection'),
      textButton(tr('나의 장미 보기·이름 짓기', 'VIEW OR NAME MY ROSE'), () => screenMySpecimen()),
    ),
  ], [
    primaryButton(tr('나의 장미 보기', 'VIEW MY ROSE'), () => {
      logEvent('exit_result_view', { visited_modules: getCompletedStations(session), unvisited_modules: missing }, '05');
      screenFinalSpecimen();
    }),
  ]);
}

function saveNaming(a, b, finalName, inputMeta = {}) {
  updateSession({
    emotional_name_a: a,
    emotional_name_b: b,
    emotional_name: finalName,
    name_source: finalName ? 'visitor' : 'none',
  });
  if (!TEST_MODE) {
    saveDbArtifact('naming', finalName, {
      emotional_name_a: a,
      emotional_name_b: b,
      input_summary: inputMeta,
    });
  }
  logEvent('emotional_name_saved', {
    emotional_name_a: a,
    emotional_name_b: b,
    emotional_name: finalName,
    input_summary: inputMeta,
  }, '01');
  if (!TEST_MODE) flushAnalyticsEvents('naming_saved');
}

function myRoseNameEditor({ returnTo = null } = {}) {
  const session = ensureSession();
  const hasVisitorName = session.name_source === 'visitor';
  const aInput = el('input', {
    id: 'my-rose-name-side-a',
    type: 'text',
    value: hasVisitorName ? (session.emotional_name_a || '') : '',
    placeholder: tr('예: 계속 밀어냈던 나', 'Example: the part of me I kept pushing away'),
    maxlength: 60,
  });
  const bInput = el('input', {
    id: 'my-rose-name-side-b',
    type: 'text',
    value: hasVisitorName ? (session.emotional_name_b || '') : '',
    placeholder: tr('예: 그래도 계속 걸어간 나', 'Example: the part that kept moving anyway'),
    maxlength: 60,
  });
  const finalInput = el('input', {
    id: 'my-rose-name-final',
    type: 'text',
    value: session.name_source === 'visitor' ? (session.emotional_name || '') : '',
    placeholder: tr('예: 느리지만 계속 피어나는 장미', 'Example: a rose that opens slowly'),
    maxlength: 60,
  });
  const inputTracking = {
    rejected_side: trackInput(aInput, 'emotional_name_a'),
    other_side: trackInput(bInput, 'emotional_name_b'),
    final_name: trackInput(finalInput, 'emotional_name'),
  };

  const save = () => {
    const a = aInput.value.trim();
    const b = bInput.value.trim();
    const finalName = finalInput.value.trim();
    saveNaming(a, b, finalName, {
      rejected_side: inputTracking.rejected_side.commit(a),
      other_side: inputTracking.other_side.commit(b),
      final_name: inputTracking.final_name.commit(finalName),
    });
    screenMySpecimen({ returnTo });
  };

  return el('section', {
    class: 'my-rose-name-editor',
    'aria-labelledby': 'my-rose-name-heading',
  },
    el('span', { class: 'micro-label' }, tr('장미 이름', 'ROSE NAME')),
    el('h2', { id: 'my-rose-name-heading' }, tr('장미 이름을 짓거나 바꿉니다', 'NAME OR EDIT MY ROSE')),
    el('p', { class: 'intro-copy' }, tr(
      '장미에는 꽃잎과 가시가 함께 있듯, 서로 모순되어 보이는 두 모습을 한 이름 안에 둘 수 있습니다. 비워 두어도 연결·캡처·결과를 모두 이용할 수 있습니다.',
      'Like petals and thorns on the same rose, two apparently contradictory sides may remain in one name. You can leave this blank and still use connections, captures and results.',
    )),
    el('div', { class: 'numbered-input' },
      el('span', {}, '01'),
      el('label', { for: 'my-rose-name-side-a' }, tr('오늘 마주한 한 모습', 'ONE SIDE I MET TODAY')),
      aInput,
    ),
    el('div', { class: 'numbered-input' },
      el('span', {}, '02'),
      el('label', { for: 'my-rose-name-side-b' }, tr('그와 동시에 존재한 다른 모습', 'ANOTHER SIDE THAT EXISTED WITH IT')),
      bInput,
    ),
    el('div', { class: 'numbered-input final-name-input' },
      el('span', {}, '03'),
      el('label', { for: 'my-rose-name-final' }, tr('나의 장미 이름', 'NAME OF MY ROSE')),
      finalInput,
    ),
    el('button', { class: 'secondary-action my-rose-name-save', type: 'button', onclick: save }, tr('장미 이름 저장', 'SAVE ROSE NAME')),
  );
}

// 치료·진단이 아니라 전시의 감정적 깊이·구조·매체 경험을 각각 한 번씩 묻는다.
// 1은 전혀 그렇지 않다, 10은 매우 그렇다. 자유소감은 빈칸으로도 제출할 수 있다.
const SURVEY_QUESTIONS = [
  {
    id: 'overall_meaning',
    ko: '이 전시는 나에게 의미 있는 경험으로 남았습니다.',
    en: 'Overall, this exhibition felt meaningful to me.',
  },
  {
    id: 'experiential_concept',
    ko: '작품의 핵심 생각은 글을 읽는 것뿐 아니라 실제 체험을 통해서도 전달되었습니다.',
    en: 'The central ideas of the works came through the experience itself, not only through written explanation.',
  },
  {
    id: 'technology_supports_meaning',
    ko: '기술은 그 자체를 드러내기보다 작품의 의미를 뒷받침했습니다.',
    en: 'The technology supported the meaning of the works rather than drawing attention to itself.',
  },
  {
    id: 'emotional_complexity',
    ko: '이 전시는 복잡하거나 서로 모순되는 감정을 서둘러 정리하지 않고 바라볼 시간을 주었습니다.',
    en: 'The exhibition gave me time to stay with complex or contradictory emotions without needing to resolve them.',
  },
  {
    id: 'agency',
    ko: '무엇을 가까이 보고, 만지고, 멈출지 내가 선택하고 있다고 느꼈습니다.',
    en: 'I felt that I could choose what to approach, touch, or leave.',
  },
  {
    id: 'embodied_interaction',
    ko: '손과 몸으로 직접 참여한 것이 작품의 의미를 이해하는 데 도움이 되었습니다.',
    en: 'Using my hands and body helped me understand the meaning of the works.',
  },
  {
    id: 'work_continuity',
    ko: '네 작품은 서로 분리된 체험이 아니라 하나의 전시 경험으로 연결되어 느껴졌습니다.',
    en: 'The four works felt connected as parts of one exhibition rather than as separate experiences.',
  },
  {
    id: 'screenshot_value',
    ko: '스크린샷 기능은 다시 돌아보고 싶은 순간을 남기는 데 도움이 되었습니다.',
    en: 'The screenshot function helped me keep a moment I wanted to return to.',
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

// Preserved Seoul combined naming + survey screen. Melbourne separates the two
// so neither optional activity can block captures or results.
function screenFinalReflectionSeoulArchive({ exitFlow = false, returnToStation = null } = {}) {
  const session = ensureSession();
  rememberView('reflection', { exitFlow, returnToStation });
  clearStationQuery();

  const aInput = el('input', { type: 'text', value: session.name_source === 'visitor' ? (session.emotional_name_a || '') : '', placeholder: tr('오늘 마주한, 내가 죽여 온 나', 'The self I have been killing, met today'), maxlength: 60 });
  const bInput = el('input', { type: 'text', value: session.name_source === 'visitor' ? (session.emotional_name_b || '') : '', placeholder: tr('그와 동시에 존재했던 반대편의 나', 'The other side that existed at the same time'), maxlength: 60 });
  const finalInput = el('input', {
    type: 'text',
    value: session.name_source === 'visitor' ? (session.emotional_name || '') : '',
    placeholder: tr('오늘 나를 부를 장미의 이름', 'The rose name that calls me today'),
    maxlength: 60,
  });
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
    placeholder: tr('당신의 경험을 자유롭게 남겨주세요.', 'Leave your experience in your own words.'),
  });
  const surveyTextTracking = trackInput(surveyTextInput, 'survey_reflection');
  const sliderAnswers = {};

  const surveySlider = (question, index) => {
    const stored = Number(session.survey?.[question.id]);
    const hasStoredAnswer = Number.isInteger(stored) && stored >= 1 && stored <= 10;
    if (hasStoredAnswer) sliderAnswers[question.id] = stored;

    const value = el('output', { class: 'survey-slider-value', 'aria-live': 'polite' }, hasStoredAnswer ? String(stored) : tr('선택 전', 'NOT SELECTED'));
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
        '오늘의 인터랙티브 전시 경험이 어땠는지 자유롭게 들려주세요. 자세한 경험을 나누어주시면 작가에게 아주 큰 도움이 됩니다.',
        'Tell us about your interactive exhibition experience in your own words. Sharing the details is a great help to the artist.',
      )),
      surveyTextInput,
    ),
  );

  render([
    globalHeader(),
    el('section', { class: 'screen reflection-screen' },
      el('span', { class: 'micro-label' }, exitFlow ? 'FINAL RECORD' : 'NAME OF THE ROSE'),
      el('h1', { class: 'screen-title' }, tr(exitFlow ? '장미 이름과 경험' : '장미 이름을 짓습니다', exitFlow ? 'ROSE NAME AND EXPERIENCE' : 'NAME OF THE ROSE')),
      el('p', { class: 'intro-copy' }, tr(
        exitFlow ? '마지막으로 오늘 만난 두 얼굴과 그 둘을 함께 부르는 장미 이름을 다시 읽습니다. 이 이름은 결론이 아니라, 전시 밖에서도 다시 돌아볼 수 있는 오늘의 표식입니다.' : '이 전시에서 장미는 오늘의 당신을 대신하는 표본입니다. 꽃잎과 가시처럼 동시에 존재하는 두 얼굴을 적고, 그 둘이 함께 남을 수 있는 장미 이름을 지어주세요. 장미에 붙이는 이름은 곧 오늘의 당신을 부르는 이름입니다.',
        exitFlow ? 'Read the two faces you met today and the rose name that can hold them together. It is not a conclusion, but a mark you may return to beyond the exhibition.' : 'In this exhibition, the rose stands in for who you are today. Name its two coexisting faces, then give the rose one name that can hold them together.',
      )),
      el('div', { class: 'numbered-input' },
        el('span', {}, '01'),
        el('label', {}, tr('오늘 마주한, 내가 죽여 온 나', 'THE SELF I HAVE BEEN KILLING, MET TODAY')),
        aInput,
      ),
      el('div', { class: 'numbered-input' },
        el('span', {}, '02'),
        el('label', {}, tr('그와 동시에 존재했던 반대편의 나', 'THE OTHER SIDE THAT EXISTED AT THE SAME TIME')),
        bInput,
      ),
      el('div', { class: 'numbered-input final-name-input' },
        el('span', {}, '03'),
        el('label', {}, tr('두 얼굴을 함께 부를 오늘의 장미 이름', 'THE ROSE NAME THAT HOLDS BOTH FACES')),
        finalInput,
      ),
      exitFlow ? survey : null,
      error,
      exitFlow ? textButton(tr('입력 없이 나의 장미 보기', 'VIEW MY ROSE WITHOUT WRITING'), screenFinalSpecimen) : null,
      !exitFlow ? textButton('HOME', () => { void goHome(); }) : null,
    ),
  ], [
    primaryButton(exitFlow ? tr('이 장미와 함께 돌아갑니다', 'RETURN WITH THIS ROSE') : tr('장미 이름을 저장합니다', 'SAVE ROSE NAME'), () => {
      const a = aInput.value.trim();
      const b = bInput.value.trim();
      const finalName = finalInput.value.trim();
      if (!a || !b || !finalName) {
        error.textContent = tr('세 항목을 모두 당신의 말로 적어주세요.', 'Complete all three fields.');
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
        if (!TEST_MODE) saveDbSurvey(surveyRows);
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
        void goHome();
      }
    }),
  ]);
}

function screenFinalReflection({ exitFlow = false, returnToStation = null } = {}) {
  const session = ensureSession();
  const hasVisitorName = session.name_source === 'visitor';
  rememberView('reflection', { exitFlow, returnToStation });
  clearStationQuery();

  const aInput = el('input', {
    id: 'rose-name-side-a',
    type: 'text',
    value: hasVisitorName ? (session.emotional_name_a || '') : '',
    placeholder: tr('예: 계속 밀어냈던 나', 'Example: the part of me I kept pushing away'),
    maxlength: 60,
  });
  const bInput = el('input', {
    id: 'rose-name-side-b',
    type: 'text',
    value: hasVisitorName ? (session.emotional_name_b || '') : '',
    placeholder: tr('예: 그래도 계속 걸어간 나', 'Example: the part that kept moving anyway'),
    maxlength: 60,
  });
  const finalInput = el('input', {
    id: 'rose-name-final',
    type: 'text',
    value: session.name_source === 'visitor' ? (session.emotional_name || '') : '',
    placeholder: tr('예: 느리지만 계속 피어나는 장미', 'Example: a rose that opens slowly'),
    maxlength: 60,
  });
  const inputTracking = {
    rejected_side: trackInput(aInput, 'emotional_name_a'),
    other_side: trackInput(bInput, 'emotional_name_b'),
    final_name: trackInput(finalInput, 'emotional_name'),
  };

  const continueAfterNaming = () => {
    if (returnToStation) {
      screenModule(returnToStation, { enter: true, via: 'optional_naming' });
    } else if (exitFlow) {
      screenSurvey();
    } else {
      void goHome();
    }
  };

  const saveOptionalName = () => {
    const a = aInput.value.trim();
    const b = bInput.value.trim();
    const finalName = finalInput.value.trim();
    const inputMeta = {
      rejected_side: inputTracking.rejected_side.commit(a),
      other_side: inputTracking.other_side.commit(b),
      final_name: inputTracking.final_name.commit(finalName),
    };
    if (a || b || finalName) saveNaming(a, b, finalName, inputMeta);
    continueAfterNaming();
  };

  render([
    globalHeader(),
    el('section', { class: 'screen reflection-screen naming-only-screen' },
      el('span', { class: 'micro-label' }, tr('장미의 이름', 'NAME OF THE ROSE')),
      el('h1', { class: 'screen-title' }, tr('장미 이름을 짓습니다', 'NAME YOUR ROSE')),
      el('p', { class: 'intro-copy' }, tr(
        '장미에는 꽃잎과 가시가 함께 있듯, 서로 모순되어 보이는 나의 두 모습을 그대로 둘 수 있습니다. 나중에 다시 짓거나 바꿀 수 있습니다.',
        'Like petals and thorns on the same rose, two apparently contradictory sides of you may remain together. You may return or change the name later.',
      )),
      el('div', { class: 'numbered-input' },
        el('span', {}, '01'),
        el('label', { for: 'rose-name-side-a' }, tr('오늘 마주한 한 모습', 'ONE SIDE I MET TODAY')),
        aInput,
      ),
      el('div', { class: 'numbered-input' },
        el('span', {}, '02'),
        el('label', { for: 'rose-name-side-b' }, tr('그와 동시에 존재한 다른 모습', 'ANOTHER SIDE THAT EXISTED WITH IT')),
        bInput,
      ),
      el('div', { class: 'numbered-input final-name-input' },
        el('span', {}, '03'),
        el('label', { for: 'rose-name-final' }, tr('오늘의 장미 이름', 'NAME OF MY ROSE TODAY')),
        finalInput,
      ),
      textButton(tr('이름 없이 계속', 'CONTINUE WITHOUT A NAME'), continueAfterNaming),
      !exitFlow ? textButton('HOME', () => { void goHome(); }) : null,
    ),
  ], [
    primaryButton(tr('장미 이름 저장', 'SAVE ROSE NAME'), saveOptionalName),
  ]);
}

function screenSurvey() {
  const session = ensureSession();
  rememberView('survey');
  clearStationQuery();
  const selected = {};
  const reflection = el('textarea', {
    id: 'survey-reflection',
    rows: 5,
    maxlength: 600,
    value: session.survey?.reflection || '',
    placeholder: tr('오늘의 경험을 남겨주세요.', 'Please share your experience here.'),
  });
  const error = el('p', { class: 'field-error', role: 'alert' });

  const questionBlock = (question, index) => {
    const stored = Number(session.survey?.[question.id]);
    if (stored >= 1 && stored <= 10) selected[question.id] = stored;
    return el('fieldset', { class: 'survey-question survey-choice-question' },
      el('legend', {}, `${String(index + 1).padStart(2, '0')}. ${tr(question.ko, question.en)}`),
      el('div', { class: 'survey-choice-endpoints' },
        el('span', {}, tr('전혀 그렇지 않다', 'NOT AT ALL')),
        el('span', {}, tr('매우 그렇다', 'VERY MUCH')),
      ),
      el('div', { class: 'survey-number-grid' },
        ...Array.from({ length: 10 }, (_, item) => {
          const value = item + 1;
          const id = `survey-${question.id}-${value}`;
          const input = el('input', {
            id,
            type: 'radio',
            name: `survey-${question.id}`,
            value,
            checked: selected[question.id] === value,
            onchange: () => { selected[question.id] = value; },
          });
          return el('label', { class: 'survey-number-option', for: id }, input, el('span', {}, String(value)));
        }),
      ),
    );
  };

  const submit = () => {
    const note = reflection.value.trim();
    if (!Object.keys(selected).length && !note) {
      error.textContent = tr('한 문항 이상 선택하거나, 건너뛰고 나의 장미로 돌아가세요.', 'Answer at least one question, or skip and return to your rose.');
      return;
    }
    const submissionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
    const meta = {
      survey_version: 'melbourne-2026-v2',
      submission_id: submissionId,
      optional_questions: true,
    };
    const rows = Object.fromEntries(Object.entries(selected).map(([id, value]) => [id, { value, meta }]));
    if (note) rows.reflection = { value: note, meta };
    if (!TEST_MODE) saveDbSurvey(rows);
    updateSession({ survey: { ...session.survey, ...selected, reflection: note, survey_version: meta.survey_version } });
    logEvent('survey_submitted', { answered_count: Object.keys(selected).length, reflection_length: note.length, ...meta }, '05');
    screenFinalSpecimen({ refresh: true });
  };

  render([
    globalHeader(),
    el('section', { class: 'screen survey-screen' },
      el('span', { class: 'micro-label' }, tr('경험 공유 / 선택', 'FEEDBACK / OPTIONAL')),
      el('h1', { class: 'screen-title' }, tr('경험을 남겨주세요', 'SHARE YOUR EXPERIENCE')),
      el('p', { class: 'intro-copy' }, tr(
        '각 문항은 선택입니다. 답하지 않고도 나의 장미와 캡처를 볼 수 있습니다.',
        'Every question is optional. You can view your rose and captures without completing the survey.',
      )),
      el('div', { class: 'survey-question-list' },
        ...SURVEY_QUESTIONS.map((question, index) => el('div', { class: 'survey-question-section' },
          questionBlock(question, index),
        )),
      ),
      el('div', { class: 'survey-text-question' },
        el('label', { for: 'survey-reflection' }, tr(
          '오늘의 인터랙티브 전시 경험을 들려주세요. 자세한 경험을 나누어주시면 작가에게 큰 도움이 됩니다.',
          'Please share your experience of the interactive exhibition. Any details you choose to share are greatly appreciated by the artist.',
        )),
        reflection,
      ),
      error,
      textButton(tr('건너뛰고 나의 장미로', 'SKIP AND RETURN TO MY ROSE'), () => screenFinalSpecimen({ refresh: true })),
    ),
  ], [primaryButton(tr('경험 제출', 'SUBMIT FEEDBACK'), submit)]);
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
  const artifacts = TEST_MODE ? [] : await fetchMyCaptureArtifacts();
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
  const title = displayName(session);

  context.fillStyle = '#070707';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = 'rgba(255,255,255,.22)';
  context.strokeRect(58, 58, 964, 1324);
  context.fillStyle = '#e9e6df';
  context.font = '500 28px Menlo, monospace';
  const canvasTitle = MELBOURNE.title.toUpperCase();
  context.fillText(canvasTitle.length > 44 ? `${canvasTitle.slice(0, 44)}…` : canvasTitle, 84, 120);
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
  context.fillText('MY ROSE / MELBOURNE 2026', 84, 1012);
  context.fillText('MINNIE PARK / THE META ROSE', 84, 1320);

  const link = document.createElement('a');
  link.download = `meta-rose-${session.display_record_no}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  logEvent('image_save', {}, '05');
}

async function shareResult() {
  const session = ensureSession();
  const text = `${MELBOURNE.title}\n${displayName(session)}\nROSE NO. ${session.display_record_no}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: MELBOURNE.title, text, url: location.href });
      logEvent('share_complete', {}, '05');
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${location.href}`);
    alert(tr('결과 링크가 복사되었습니다.', 'Result link copied.'));
  } catch {
    logEvent('share_cancel', {}, '05');
  }
}

// Preserved Seoul terminal result screen. The Melbourne result below is a
// non-terminal view that can be opened at any point in the visit.
function screenFinalSpecimenSeoulArchive({ refresh = false } = {}) {
  const session = ensureSession();
  rememberView('final');
  clearStationQuery();
  applySessionColor(session.color);
  const traceProfile = traceProfileForCurrentSession();
  if (!refresh) {
    const analyticsEventCount = TEST_MODE ? 0 : flushAnalyticsEvents('seoul_archive_result_view');
    if (!TEST_MODE) {
      saveDbSessionSnapshot({
        snapshot_version: 'seoul-archive-nonterminal',
        viewed_at: new Date().toISOString(),
        rose_no: session.display_record_no,
        lang: session.lang,
        color: session.color,
        emotional_name: visitorRoseName(session) || null,
        completed_stations: getCompletedStations(session),
        survey: session.survey || {},
        analytics_event_count: analyticsEventCount,
        finalization_completed: false,
      });
    }
    logEvent('seoul_archive_result_viewed', {}, '05');
    if (!TEST_MODE) void flushDbQueue(true);
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
          el('span', {}, tr('오늘의 장미 이름', 'NAME OF MY ROSE')),
          el('h1', {}, displayName(session)),
        ),
        el('div', { class: 'specimen-stem', 'aria-hidden': 'true' }),
        specimenReference('01', session),
        specimenReference('02', session),
        specimenReference('03', session),
        el('div', { class: 'specimen-stem stem-bottom', 'aria-hidden': 'true' }),
      ),
      el('section', { class: 'final-epilogue' },
        el('p', {}, tr('장례식은 끝났습니다.', 'THE FUNERAL HAS ENDED.')),
        el('p', {}, tr('죽인 것은 사라지지 않았습니다. 다시 부를 이름이 생겼을 뿐입니다.', 'WHAT WAS KILLED DID NOT DISAPPEAR. IT NOW HAS A NAME THAT CAN BE CALLED AGAIN.')),
        el('p', {}, tr('모순은 없어지지 않아도, 어느 쪽에 물을 줄지는 다시 고를 수 있습니다.', 'THE CONTRADICTION MAY REMAIN, BUT YOU MAY CHOOSE AGAIN WHAT TO WATER.')),
      ),
      el('footer', { class: 'specimen-label' },
        el('div', {}, el('span', {}, tr('오늘의 장미 이름', 'NAME OF MY ROSE')), el('strong', {}, displayName(session))),
        el('div', {}, el('span', {}, 'ROSE NO.'), el('strong', {}, session.display_record_no)),
        el('div', {}, el('span', {}, 'DATE'), el('strong', {}, new Date().toLocaleDateString('ko-KR'))),
        el('p', {}, 'META ROSE 2026 / MINNIE PARK'),
      ),
    ),
  ], [
    primaryButton(tr('이미지로 저장', 'SAVE IMAGE'), saveResultImage),
    textButton(tr('설문하기', 'TAKE THE SURVEY'), () => screenFinalReflection({ exitFlow: true }), 'final-survey-link'),
    el('button', { class: 'secondary-action', type: 'button', onclick: shareResult }, tr('공유', 'SHARE'), el('span', { 'aria-hidden': 'true' }, '↗')),
  ]);
  void refreshRemoteTraceSummaries();
  void refreshSpecimenCaptureReferences();
}

function resultCaptureGallery() {
  return el('section', {
    class: 'result-capture-gallery',
    id: 'result-capture-gallery',
    'aria-busy': 'true',
    'data-fetch-state': 'loading',
  },
    el('span', { class: 'micro-label' }, tr('캡처 / 작품 01, 02, 03', 'CAPTURES / WORKS 01, 02, 03')),
    el('h2', {}, tr('내가 남긴 장면', 'MY CAPTURED MOMENTS')),
    el('div', {
      class: 'result-capture-status',
    },
      el('span', { class: 'result-capture-status-copy' }, tr(
        '새 캡처를 확인하고 있습니다…',
        'CHECKING FOR NEW CAPTURES…',
      )),
      el('span', {
        class: 'capture-poll-announcement',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      }),
    ),
    el('div', { class: 'result-capture-items' }),
  );
}

async function refreshResultCaptureGallery() {
  const gallery = document.getElementById('result-capture-gallery');
  if (!gallery?.isConnected) return false;
  const statusRegion = gallery.querySelector('.result-capture-status');
  const statusNode = gallery.querySelector('.result-capture-status-copy');
  const announcement = gallery.querySelector('.capture-poll-announcement');
  const itemsNode = gallery.querySelector('.result-capture-items');
  if (!statusRegion || !statusNode || !announcement || !itemsNode) return false;
  gallery.setAttribute('aria-busy', 'true');

  const fetched = TEST_MODE ? [] : await fetchMyCaptureArtifacts();
  const fetchStatus = getArtifactFetchStatus();
  if (!gallery.isConnected) return false;
  const unique = fetched
    .filter((artifact) => ['01', '02', '03'].includes(String(artifact.station_id || '').padStart(2, '0')))
    .filter((artifact, index, list) => {
      const key = artifact.id || captureStoragePath(artifact) || artifact.value;
      return list.findIndex((candidate) => (candidate.id || captureStoragePath(candidate) || candidate.value) === key) === index;
    })
    .sort((a, b) => new Date(a.occurred_at || a.created_at || 0) - new Date(b.occurred_at || b.created_at || 0));

  if (fetchStatus.state === 'error' || (fetchStatus.state === 'offline' && !unique.length)) {
    const nextState = fetchStatus.state === 'offline' ? 'offline' : 'error';
    const nextDetail = String(fetchStatus.error || '');
    const statusChanged = gallery.dataset.fetchState !== nextState
      || (gallery.dataset.statusDetail || '') !== nextDetail;
    gallery.setAttribute('aria-busy', 'false');
    gallery.dataset.fetchState = nextState;
    gallery.dataset.statusDetail = nextDetail;
    if (statusChanged) {
      const message = nextState === 'offline'
        ? tr('네트워크에 연결되면 다시 확인합니다.', 'WE WILL CHECK AGAIN WHEN THE NETWORK RETURNS.')
        : tr('이미지를 불러오지 못했습니다.', 'WE COULD NOT LOAD THE IMAGES.');
      statusNode.textContent = message;
      statusRegion.querySelector('.capture-retry-button')?.remove();
      statusRegion.append(el('button', { class: 'capture-retry-button', type: 'button', onclick: () => { void refreshResultCaptureGallery(); } }, tr('다시 확인', 'TRY AGAIN')));
      announceCaptureStatus(announcement, message);
    }
    return false;
  }

  const resolved = (await Promise.all(unique.map(async (artifact) => ({
    artifact,
    url: await captureDisplayUrl(artifact),
  })))).filter((item) => item.url);
  if (!gallery.isConnected) return false;
  const fingerprint = resolved.map(({ artifact }) => artifact.id || captureStoragePath(artifact) || artifact.value).join('|');
  const fingerprintChanged = gallery.dataset.fingerprint !== fingerprint;
  const nextState = resolved.length ? 'ready' : 'waiting';
  const statusChanged = gallery.dataset.fetchState !== nextState;
  if (fingerprintChanged) {
    gallery.dataset.fingerprint = fingerprint;
    itemsNode.replaceChildren(...resolved.map(({ artifact, url }, index) => {
      const stationId = String(artifact.station_id || '').padStart(2, '0');
      return el('article', { class: 'result-capture-card' },
        el('img', {
          src: url,
          alt: tr(`${stationId} ${workTitle(stationId)}에서 남긴 장면 ${index + 1}`, `Capture ${index + 1} from ${stationId} ${stationLabel(stationId)}`),
        }),
        el('div', { class: 'result-capture-card-meta' },
          el('strong', {}, `${stationId} / ${workTitle(stationId)}`),
          el('div', { class: 'result-capture-card-actions' },
            el('a', { href: url, target: '_blank', rel: 'noopener' }, tr('이미지 열기', 'OPEN IMAGE')),
            el('button', {
              type: 'button',
              onclick: () => { void saveCaptureFromUrl(url, stationId, index + 1); },
            }, tr('저장', 'SAVE')),
          ),
        ),
      );
    }));
  }
  gallery.setAttribute('aria-busy', 'false');
  gallery.dataset.fetchState = nextState;
  gallery.dataset.statusDetail = '';
  statusRegion.querySelector('.capture-retry-button')?.remove();
  if (fingerprintChanged || statusChanged) {
    statusNode.textContent = resolved.length
      ? tr(`캡처 ${resolved.length}개가 준비되었습니다.`, `${resolved.length} CAPTURE${resolved.length === 1 ? '' : 'S'} READY.`)
      : tr('아직 남긴 캡처가 없습니다.', 'NO CAPTURES YET.');
    if (fingerprintChanged && resolved.length) {
      announceCaptureStatus(announcement, tr(
        `새 캡처가 준비되었습니다. 전체 ${resolved.length}개.`,
        `A new capture is ready. ${resolved.length} total.`,
      ));
    }
  }
  return true;
}

function startResultCapturePolling() {
  stopCapturePolling();
  const generation = capturePollGeneration;
  let inFlight = false;
  const active = () => capturePollGeneration === generation && currentView.name === 'final';
  const schedule = (delay = 4000) => {
    if (!active()) return;
    if (capturePollTimer) clearTimeout(capturePollTimer);
    capturePollTimer = setTimeout(() => { void poll(); }, delay);
  };
  const poll = async () => {
    if (!active() || inFlight) return;
    inFlight = true;
    try { await refreshResultCaptureGallery(); } finally { inFlight = false; }
    schedule(4000);
  };
  capturePollFocusHandler = () => schedule(0);
  capturePollVisibilityHandler = () => { if (document.visibilityState === 'visible') schedule(0); };
  capturePollPageShowHandler = () => schedule(0);
  capturePollOnlineHandler = () => schedule(0);
  window.addEventListener('focus', capturePollFocusHandler);
  document.addEventListener('visibilitychange', capturePollVisibilityHandler);
  window.addEventListener('pageshow', capturePollPageShowHandler);
  window.addEventListener('online', capturePollOnlineHandler);
  schedule(0);
}

function screenFinalSpecimen({ refresh = false } = {}) {
  const session = ensureSession();
  rememberView('final');
  clearStationQuery();
  applySessionColor(session.color);
  const traceProfile = traceProfileForCurrentSession();
  if (!refresh) {
    const analyticsEventCount = TEST_MODE ? 0 : flushAnalyticsEvents('result_view');
    if (!TEST_MODE) {
      saveDbSessionSnapshot({
        snapshot_version: 'melbourne-2026-v1',
        snapshot_type: 'result_view',
        viewed_at: new Date().toISOString(),
        rose_no: session.display_record_no,
        lang: session.lang,
        colour: session.color,
        emotional_name: visitorRoseName(session) || null,
        completed_stations: getCompletedStations(session),
        analytics_event_count: analyticsEventCount,
        finalization_completed: false,
      });
    }
    logEvent('result_viewed', {}, '00');
  }

  const visited = getCompletedStations(session);
  const date = new Intl.DateTimeFormat(session.lang === 'ko' ? 'ko-KR' : 'en-AU', {
    timeZone: MELBOURNE.timeZone,
    dateStyle: 'long',
  }).format(new Date());

  render([
    globalHeader(),
    el('section', { class: 'screen final-specimen-screen melbourne-result-screen' },
      el('div', { class: 'final-header' },
        el('span', {}, tr('나의 장미', 'MY ROSE')),
        el('strong', {}, `ROSE NO. ${session.display_record_no}`),
      ),
      roseVisual('final', tr('나의 메타 로즈', 'MY META ROSE'), traceProfile),
      el('section', { class: 'result-summary' },
        el('h1', {}, displayName(session)),
        textButton(
          visitorRoseName(session) ? tr('장미 이름 바꾸기', 'EDIT MY ROSE NAME') : tr('장미 이름 짓기', 'NAME MY ROSE'),
          () => screenMySpecimen(),
          'result-name-inline',
        ),
        el('dl', {},
          el('div', {}, el('dt', {}, tr('장미 번호', 'ROSE NUMBER')), el('dd', {}, session.display_record_no)),
          el('div', {}, el('dt', {}, tr('선택한 색', 'CHOSEN COLOUR')), el('dd', {}, el('i', { class: 'result-colour-chip', style: { backgroundColor: session.color }, 'aria-hidden': 'true' }), `${roseColourLabel(session.color)} · ${session.color}`)),
          el('div', {}, el('dt', {}, tr('확인된 방문', 'RECORDED VISITS')), el('dd', {}, visited.length ? visited.join(' · ') : tr('아직 없음', 'NONE YET'))),
          el('div', {}, el('dt', {}, 'DATE'), el('dd', {}, date)),
        ),
      ),
      resultCaptureGallery(),
      el('section', { class: 'result-next-actions' },
        el('h2', {}, tr('계속할 수 있습니다', 'CONTINUE WHEN YOU ARE READY')),
        el('p', {}, tr(
          '이 화면은 관람을 종료하지 않습니다. 한 작품만 보았거나 설문을 건너뛰어도 언제든 다시 열 수 있습니다.',
          'Viewing this page does not end your visit. You can return after one work, skip the survey, or reopen it at any time.',
        )),
        primaryButton(tr('작품으로 돌아가기', 'RETURN TO THE WORKS'), () => { void goHome(); }),
        textButton(tr('경험 남기기', 'SHARE FEEDBACK'), screenSurvey, 'final-survey-link'),
      ),
      el('p', { class: 'access-fringe-credit result-credit' }, MELBOURNE.accessCredit),
    ),
  ], [primaryButton(tr('결과 이미지 저장', 'SAVE RESULT IMAGE'), saveResultImage)]);
  void refreshRemoteTraceSummaries();
  startResultCapturePolling();
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
  else if (name === 'survey') screenSurvey();
  else if (name === 'access') screenAccessGuide();
  else if (name === 'no-phone') screenNoPhoneParticipation();
  else if (name === 'final') screenFinalSpecimen();
  else screenHome();
}

async function boot() {
  const bootParams = new URLSearchParams(location.search);

  // Hard boundary: test/preview URLs use only their dedicated browser keys.
  // Keep db.js inactive even if a preview button later simulates connection.
  if (TEST_MODE) setDbRuntimeActive(false);

  // Reset shared session state before any asynchronous Supabase/Auth work can
  // capture and later restore the previous audience session.
  const resetRequested = bootParams.get('reset') === '1';
  if (resetRequested) {
    // Reset must happen before the multi-tab guard reads an old lease. Removing
    // the shared lease first makes this explicit reset tab the only owner.
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(EVENTS_KEY);
    if (!TEST_MODE) resetDbSession();
    localStorage.removeItem(ACTIVE_TAB_KEY);
  }
  initializeActiveTabGuard({ forceClaim: resetRequested });
  if (resetRequested) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('reset');
    history.replaceState({}, '', cleanUrl);
  }
  // SDK 로드·네트워크 실패는 이 흐름을 막지 않는다. db.js가 local queue로 폴백한다.
  // Initialization continues in the background. The entrance route performs
  // its own bounded server reconciliation, so a stalled CDN/auth request can
  // never leave QR/NFC visitors on a blank page.
  if (!TEST_MODE) {
    void initDB();
    startIdleTracking();
  }
  startUiActionTracking();
  const session = ensureSession();
  applySessionColor(session.color);
  $bar.replaceChildren();

  const station = stationFromQuery();
  const stationVia = stationViaFromQuery();
  if (station === '00') {
    await handleEntranceRoute();
    return;
  }
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
      screenModule(station, { enter: false, via: stationVia });
    }
    return;
  }

  if (!session.intro_seen) {
    screenArrival();
  } else if (!isRegistered(session)) {
    screenPersonalSetup();
  } else {
    screenHome();
  }
}

window.addEventListener('DOMContentLoaded', boot);
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.getElementById('inactive-tab-overlay')) return;
  if (document.querySelector('.language-dialog-overlay')) closeLanguageChooser();
  else closeRoseMenu();
});
