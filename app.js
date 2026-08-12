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
} from './db.js';
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
const ARTIST_INSTAGRAM_URL = 'https://www.instagram.com/minniepark/';
// 실제 전시 자산 파일명은 공백을 포함한다. URL에서는 명시적으로 인코딩한다.
const ROSE_SPECIMEN_IMAGE = './assets/images/rose%20specimen.png';

let currentView = { name: 'arrival', data: {} };
let activeReadKey = null;
let uiTrackingStarted = false;

// Phone Hub은 TD의 raw interaction을 읽거나 실시간으로 구독하지 않는다.
// 각 TD가 결과 확정 시 기록한 trace_summary만, MY SPECIMEN / FINAL을
// 열 때 한 번 읽어 장미의 형태에 반영한다.
let remoteTraceCache = {
  sessionId: null,
  fingerprint: '',
  summaries: [],
  request: null,
};

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
  const remote = await startDbSession({ consent });
  if (!remote) return null;
  const local = ensureSession();
  saveSession({
    ...local,
    id: remote.id,
    display_record_no: remote.id.slice(0, 8).toUpperCase(),
    created_at: remote.entered_at || local.created_at,
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

function clearStationQuery() {
  const url = new URL(location.href);
  url.searchParams.delete('station');
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

function roseSpecimenImage(label, className = '') {
  const image = el('img', {
    class: className,
    src: ROSE_SPECIMEN_IMAGE,
    alt: label,
  });
  // PNG가 아직 폴더에 없더라도 작품 화면은 멈추지 않는다. 파일을 넣으면
  // 다음 새로고침부터 자동으로 실제 specimen 이미지가 사용된다.
  image.addEventListener('error', () => {
    if (image.dataset.fallback === 'true') return;
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
      '태깅 완료 상태와 출구, 마지막 총정리 화면을 바로 확인합니다.',
      'Open tagged, exit, and final specimen states directly.',
    )) : null,
    el('div', { class: 'test-preview-grid' },
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
        menuAction('MY SPECIMEN', () => guardedNavigation(screenMySpecimen)),
        menuAction(tr('감정명 붙이기', 'EMOTIONAL NAMING'), () => guardedNavigation(() => screenFinalReflection({ exitFlow: false }))),
        menuAction(tr('프로젝트에 대하여', 'ABOUT THE PROJECT'), () => guardedNavigation(() => screenAboutProject())),
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
          'aria-label': 'Instagram @minniepark',
          onclick: () => logEvent('artist_instagram_open', { handle: '@minniepark' }, null),
        }, '@MINNIEPARK', el('span', { 'aria-hidden': 'true' }, '↗')),
        el('span', {}, 'META ROSE SPECIMEN / SEOUL 2026'),
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
      assetFrame('arrival_hero.webp', {
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
            '얼굴 원본과 휴대폰의 위치 정보는 저장하지 않습니다. 마지막 장미를 완성하고, 작품을 더 잘 만들기 위해서만 사용합니다.',
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
      updateSession({ intro_seen: true, consent: true, local_only: false });
      await createRemoteSession(true);
      screenPersonalSetup();
    }),
    textButton(tr('이 기기에만 저장하고 입장합니다', 'CONTINUE ON THIS DEVICE ONLY'), () => {
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
        const pendingStation = getSession()?.pending_station;
        if (pendingStation === '05') {
          updateSession({ pending_station: null });
          screenExitJourney();
        } else if (pendingStation) {
          updateSession({ pending_station: null });
          screenModule(pendingStation, { enter: true, via: 'qr' });
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
        el('span', { class: 'section-code' }, 'EMOTIONAL NAMING'),
        el('h2', {}, tr('이름은 아직 짓지 않습니다', 'THE NAME COMES LATER')),
        el('p', {}, tr(
          '01의 장미 정원에서 손으로 먼저 만난 뒤, 당신의 말로 하나의 이름을 짓습니다. 그 이름은 02와 03에서 다시 나타납니다.',
          'After meeting the roses by hand in 01, you will make one name in your own words.',
        )),
        disclosure(
          tr('감정명명 더 알아보기', 'MORE ABOUT EMOTIONAL NAMING'),
          el('p', {}, tr(
            '시스템은 감정 단어를 추천하지 않습니다. 미워했던 한 면과 그 안의 다른 한 면을 함께 보고, 마지막 이름을 직접 적습니다.',
            'The system does not suggest emotion words. The final name is yours to write.',
          )),
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
  return el('button', {
    class: `map-hotspot ${className}`,
    type: 'button',
    'aria-label': `${stationId} ${label} ${physicalLabel}`,
    onclick: () => {
      logEvent('floorplan_module_click', { station_id: stationId, via: 'floorplan' }, stationId);
      screenModule(stationId, { via: 'floorplan' });
    },
  },
    el('span', { class: 'hotspot-number' }, String(Number(stationId))),
    el('span', { class: 'hotspot-label' }, workTitle(stationId)),
  );
}

function floorplanViewer(session) {
  const frameCount = 36;
  let frame = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartFrame = 0;
  let planAngle = 0;
  let dragStartAngle = 0;
  let planTilt = 42;
  let dragStartTilt = 42;
  let activePointerId = null;
  let turntableReady = false;

  const planViewCounter = () => `${String(Math.round(planAngle)).padStart(3, '0')}° · ${String(Math.round(planTilt)).padStart(2, '0')}°`;

  const frameName = (index) => `floorplan_360_${String(index).padStart(2, '0')}.webp`;
  const image = el('img', {
    class: 'floorplan-turntable-image',
    src: `./assets/floorplan/${frameName(0)}`,
    alt: 'META ROSE exhibition floorplan 360 view',
  });
  const actualPlan = el('img', {
    class: 'actual-floorplan-image',
    src: './assets/floorplan/gallery-room-1-plan.webp',
    alt: tr(
      '제1전시실을 강조한 실제 갤러리 평면도',
      'Actual gallery floor plan emphasizing Exhibition Room 1',
    ),
  });
  const placeholder = el('div', { class: 'floorplan-asset-placeholder' },
    el('span', {}, 'ACTUAL FLOOR PLAN / ROOM 1'),
    el('strong', {}, 'EXHIBITION ROOM 1'),
    el('small', {}, '360° READY / floorplan_360_00.webp — 35.webp'),
  );

  image.addEventListener('load', () => {
    turntableReady = true;
    image.hidden = false;
    actualPlan.hidden = true;
    placeholder.hidden = true;
    stage.classList.add('has-turntable');
    stage.style.setProperty('--plan-angle', '0deg');
    stage.querySelector('.view-mode').textContent = 'DRAG TO ROTATE 360°';
    stage.querySelector('.frame-counter').textContent = `01 / ${frameCount}`;
  });
  image.addEventListener('error', () => {
    turntableReady = false;
    image.hidden = true;
    actualPlan.hidden = false;
    placeholder.hidden = false;
    stage?.classList.remove('has-turntable');
    stage?.style.setProperty('--plan-angle', `${planAngle}deg`);
    stage?.style.setProperty('--plan-tilt', `${planTilt}deg`);
    if (stage) {
      stage.querySelector('.view-mode').textContent = 'DRAG ↔ ROTATE · ↕ TILT';
      stage.querySelector('.frame-counter').textContent = planViewCounter();
    }
  });

  function showFrame(nextFrame) {
    frame = (nextFrame + frameCount) % frameCount;
    image.src = `./assets/floorplan/${frameName(frame)}`;
    stage.style.setProperty('--turntable-progress', `${frame / (frameCount - 1)}`);
    stage.style.setProperty('--turntable-angle', `${(frame / frameCount) * 360}deg`);
    stage.querySelector('.frame-counter').textContent = `${String(frame + 1).padStart(2, '0')} / ${frameCount}`;
  }

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
        turntable_ready: turntableReady,
        frame: turntableReady ? frame : null,
        angle: turntableReady ? Math.round((frame / frameCount) * 360) : Math.round(planAngle),
        tilt: turntableReady ? null : Math.round(planTilt),
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
      dragStartFrame = frame;
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
      if (turntableReady) {
        const deltaFrames = Math.round(deltaX / 10);
        const nextFrame = dragStartFrame - deltaFrames;
        if (nextFrame !== frame) showFrame(nextFrame);
      } else {
        planAngle = (dragStartAngle + (deltaX * 0.9) + 3600) % 360;
        planTilt = Math.max(18, Math.min(68, dragStartTilt - (deltaY * 0.28)));
        stage.style.setProperty('--plan-angle', `${planAngle}deg`);
        stage.style.setProperty('--plan-tilt', `${planTilt}deg`);
        stage.querySelector('.frame-counter').textContent = planViewCounter();
      }
    },
    onpointerup: finishDrag,
    onpointercancel: finishDrag,
    onlostpointercapture: () => {
      dragging = false;
      activePointerId = null;
      stage.classList.remove('is-dragging');
    },
  },
    image,
    planRotor,
    placeholder,
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
        textButton(tr('프로젝트 상세 내용', 'PROJECT DETAILS'), () => screenAboutProject('about-intro'), 'home-about-primary'),
      ),
      el('div', { class: 'section-heading-row' },
        el('div', {},
          el('span', { class: 'micro-label' }, 'EXHIBITION MAP / B1'),
          el('h1', { class: 'screen-title compact-title' }, 'FLOORPLAN'),
        ),
        el('span', { class: 'map-coordinate' }, '37.5665°N'),
      ),
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
        el('span', {}, session.emotional_name ? tr('오늘의 감정명', 'TODAY\'S EMOTIONAL NAME') : 'NOT YET NAMED'),
        textButton(session.emotional_name ? tr('감정명 보기', 'VIEW NAME') : tr('이름 붙이기', 'NAME YOURSELF'), () => screenFinalReflection({ exitFlow: false })),
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
      tr('더 깊이 읽기', 'READ DEEPER'),
      el('div', { class: 'copy-stack about-deeper-copy' },
        ...deeper.map((paragraph) => el('p', {}, paragraph)),
      ),
      `about_${id}`,
    ) : null,
    el('button', { class: 'about-to-top', type: 'button', onclick: () => scrollToAboutSection('about-top') }, tr('이 페이지의 목차로', 'BACK TO CONTENTS')),
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
      textButton(tr('HOME으로 돌아갑니다', 'RETURN HOME'), screenHome, 'about-back'),
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
        el('summary', {}, tr('이 페이지에서 읽을 내용', 'CONTENTS'), el('span', { 'aria-hidden': 'true' }, '+')),
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
        ],
      }),
      aboutSection({
        id: 'about-ambivalence',
        index: '04',
        title: '양가성과 동시성',
        lead: '미워한 면과 그것의 다른 얼굴을 동시에 바라볼 수 있을까요.',
        body: [
          '이 전시에서 살리는 행동과 죽이는 행동은 선과 악으로 나뉘지 않습니다. 물과 햇빛도 지나치면 한 존재를 압도할 수 있고, 독과 괴물에 반응하는 방식에서도 관객 자신의 태도가 드러납니다. 중요한 것은 어느 버튼이 옳은가가 아니라, 자신이 무엇을 반복해서 선택하는가입니다.',
          '감정명명도 같은 구조를 가집니다. 관객은 먼저 없애고 싶었던 자기의 한 면을 쓰고, 그 안에 함께 있었던 다른 한 면을 씁니다. 두 번째 문장은 첫 번째를 미화하거나 취소하지 않습니다. 서로 모순되는 두 얼굴이 한 이름 안에 함께 남습니다.',
        ],
        deeper: [
          '작품의 끝은 부정적인 면을 제거하고 긍정적인 면이 승리하는 장면이 아닙니다. 죽음 뒤에는 리스폰이 있고, 이전의 흔적은 완전히 사라지지 않습니다. 살아남음과 상처, 돌봄과 파괴가 한 화면 안에서 공존하는 상태가 마지막에 가깝습니다.',
          '그래서 Phone Hub는 관객에게 점수나 성격 분석을 보여주지 않습니다. 내부의 변화는 장미의 모양에만 반영됩니다. 숫자는 모순을 다시 한 줄의 평가로 줄여버리기 때문입니다.',
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
        ],
      }),
      aboutSection({
        id: 'about-ritual',
        index: '06',
        title: '장례식의 순서',
        lead: '명명하고, 재연하고, 애도하고, 마지막에 이름을 내려놓습니다.',
        body: [
          '첫 번째 작품에서 관객은 다른 사람의 손을 빌려 장미를 만지고 이름을 짓습니다. 두 번째에서는 그 이름을 가진 존재를 직접 살리고 죽이며 자신이 자신을 대하는 방식을 다시 연기합니다. 세 번째에서는 자기 화면을 벗어나 다른 사람들의 장례 속에서 자신의 자리를 찾습니다.',
          '마지막의 “놓아주기”는 이름을 삭제하는 일이 아닙니다. 그 이름을 더 이상 혼자 들고 있지 않겠다고 정하는 일입니다. 장례식이 끝나도 죽인 것은 사라지지 않습니다. 다만 다시 부를 수 있는 이름과, 어느 쪽에 물을 줄지 고를 가능성이 남습니다.',
        ],
        deeper: [
          '이 순서는 치료의 단계나 회복의 정답을 제시하지 않습니다. 작품을 본 뒤 더 나아졌다고 말하도록 요구하지도 않습니다. 의식의 역할은 한 사람 안의 모순을 없애는 것이 아니라, 평소에는 겹쳐 보이지 않던 것들을 같은 시간 안에 놓는 것입니다.',
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
          '관객은 장미의 소리를 들은 뒤 감정명을 짓습니다. 먼저 미워했던 자기의 한 면을 적고, 그 안의 다른 얼굴을 적은 다음, 둘이 함께 남을 수 있는 하나의 문장을 만듭니다. 명명은 감정을 분류하는 검사가 아니라 서로 밀어내던 두 얼굴을 같은 이름 아래 잠시 두는 행동입니다.',
          '장미마다 어떤 의미가 있는지는 미리 적어두지 않습니다. 의미를 먼저 읽고 맞는 꽃을 고르는 대신, 손의 감각과 소리의 반응이 먼저 오게 합니다.',
          '장면을 남기는 마지막 행동은 메인1이 내민 손과의 악수입니다. 사람과 사람이 손을 이어 회로를 만들었던 몸이, 이번에는 작품의 몸과 직접 손을 맞잡으며 그 순간을 기록합니다.',
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
        ],
      }),
      aboutSection({
        id: 'about-phone',
        index: '11',
        title: '당신의 장미와 Phone Hub',
        lead: '휴대폰은 작품의 실시간 화면을 복제하지 않고, 흩어진 선택을 한 장미 아래 이어주는 얇은 실입니다.',
        body: [
          '입장에서 고른 색, 01에서 지은 이름, 각 작품에서 직접 남긴 장면이 하나의 장미 번호에 연결됩니다. 작품 앞의 조화 장미에 휴대폰을 대는 행동은 디지털 기록을 시작하는 동시에 전시장 전체에 흩어진 정원을 이어줍니다.',
          'Phone Hub는 관객을 분석한 점수나 성격 유형을 보여주지 않습니다. 중간의 MY SPECIMEN도 완성된 해석이 아니라 지금까지의 흔적입니다. 변화는 숫자가 아니라 장미의 모양과 남겨진 장면으로만 보입니다.',
        ],
        deeper: [
          '작품의 원본 상호작용은 각 TouchDesigner 시스템 안에서 처리하고, 휴대폰에는 필요한 결과만 전달합니다. 네트워크가 잠시 끊겨도 작품이 멈추지 않게 하고, 관객이 기술 상태를 감시하느라 작품에서 눈을 떼지 않게 하기 위한 구조입니다.',
          '당신의 장미 번호는 실명 대신 오늘의 선택들을 다시 찾기 위한 표식입니다. 번호의 목적은 사람을 식별하는 것이 아니라, 떨어져 있는 장면들이 누구의 장미에 돌아가야 하는지 알려주는 것입니다.',
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
        ],
      }),
      el('footer', { class: 'about-page-end' },
        el('p', {}, tr('여기까지 읽어주셔서 고맙습니다.', 'THANK YOU FOR READING.')),
        textButton(tr('HOME으로 돌아갑니다', 'RETURN HOME'), screenHome),
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
    essentialKo: '한 사람이 물에 손을 담급니다. 서로의 손을 이어 하나의 사슬을 만들고, 사슬 끝에 남은 손으로 장미를 만집니다. 장면을 남기려면 메인1이 내민 손과 악수합니다. 혼자서는 작동하지 않습니다.',
    essentialEn: 'Place one hand in the water and hold the person beside you. Touch the roses with your free hand to make today\'s resonance.',
    helpKo: '물에 손을 담근 사람부터 장미까지 손을 이어주세요. 연결된 상태에서 장미를 만지면 소리와 빛이 반응합니다.',
    helpEn: 'Make a chain of hands from the water to the roses. Touch a rose while connected to activate sound and light.',
    helpDetailKo: ['한 사람이 먼저 물에 한 손을 담급니다.', '그 사람의 다른 손을 다음 사람이 잡고, 같은 방식으로 손을 이어 장미가 있는 자리까지 연결합니다.', '사슬의 마지막 사람은 남은 손으로 장미를 만집니다. 짧게 스치거나 오래 쥐어도 됩니다.', '연결이 끊기면 소리도 멈춥니다. 다시 손을 잡으면 이어집니다.', '작품이 내민 손이 나타나면 악수해 장면을 남깁니다. 혼자서는 회로가 완성되지 않습니다.'],
    helpDetailEn: ['One person begins with one hand in the water.', 'Hold hands in a chain until the final person reaches the roses.', 'The last person touches the roses with their free hand. A brief touch or a long hold both work.', 'If the chain breaks, the sound stops. Reconnect your hands to continue.', 'When the work offers a hand, shake it to leave the scene. The circuit cannot close alone.'],
    aboutKo: '생화와 기계가 한 정원 안에 연결되어 있습니다. 장미는 당신이 만지는 동안에만 소리를 얻고, 그 소리는 다른 사람의 손이 이어져 있을 때만 납니다. 여기서 만진 장미의 조합은 뒤이어 지을 감정명의 재료가 됩니다.',
    aboutEn: 'As different bodies become one circuit, the combination of roses becomes material for one emotional name.',
    aboutDetailKo: ['이 정원에서 장미는 장식이 아니라 회로의 끝입니다. 물, 사람의 피부, 손, 생화, 센서와 소리가 하나의 연결 안에 놓입니다.', '누군가가 물에 손을 담그고 다른 사람과 손을 이어야만 장미의 반응이 지속됩니다. 한 사람이 만든 선택은 혼자만의 것이 아니라 잠시 함께 선 사람들의 감각을 통과합니다.', '여러 장미를 어떻게 만졌는지는 정답을 만들지 않습니다. 이후 감정명을 붙일 때, 손으로 먼저 만든 조합을 다시 말로 옮겨보게 합니다.'],
  },
  '02': {
    en: 'INTERVENTION', ko: '개입', phaseKo: '개입', visual: 'reenactment',
    essentialKo: '컨트롤러로 화면 속 존재를 대합니다. 손을 카메라 안에 펼치면 손과 마스크가 나타납니다. 스크린샷을 남기려면 카메라를 바라보고 두 눈을 2초 동안 감아주세요.',
    essentialEn: 'Open your hand toward the screen. Follow the hand and mask, then close both eyes for two seconds to be recorded.',
    helpKo: '컨트롤러의 각 버튼을 눌러 화면 속 존재에 개입해보세요. 화면에 손과 마스크가 나타나면 카메라를 바라보고 두 눈을 감아 장면을 남깁니다.',
    helpEn: 'Use the controller buttons to intervene in the figure. When the hand and mask appear, face the camera and close both eyes to leave a scene.',
    helpDetailKo: ['컨트롤러의 버튼은 서로 다른 변화를 만듭니다. 무엇을 살리고 무엇을 해칠지는 화면의 반응을 보며 직접 발견합니다.', '한 방향의 행동만 반복할 필요는 없습니다. 서로 다른 행동을 섞었을 때 남는 변화도 관찰해보세요.', '손 전체와 얼굴이 카메라 화면 안에 들어오도록 한 걸음 물러섭니다.', '화면에 손과 마스크가 나타나면 카메라를 바라보고 두 눈을 약 2초 동안 감습니다. 눈을 감은 장면이 기록됩니다.'],
    helpDetailEn: ['Each controller button makes a different change. Discover what it protects or harms by watching the response.', 'You do not need to repeat only one kind of action. Notice what remains when different actions are mixed.', 'Step back until your full hand and face are visible to the camera.', 'When the hand and mask appear, face the camera and close both eyes for about two seconds. That moment is recorded.'],
    aboutKo: '01에서 지은 이름이 이 화면으로 옵니다. 살릴 수도 있고 죽일 수도 있습니다. 죽어도 다시 일어나지만 이전의 흔적은 사라지지 않습니다. 여기에는 승리도 패배도 없습니다.',
    aboutEn: 'This scene does not restore a lost emotion exactly. It leaves another form by performing it again with the body.',
    aboutDetailKo: ['이 작품은 자신을 돌보는 행동과 해치는 행동을 같은 손에 놓습니다. 무엇이 옳은 선택인지 알려주지 않으며, 어떤 결과도 승리나 패배로 판정하지 않습니다.', '화면 속 존재는 죽어도 다시 일어나지만, 이전의 흔적을 지우지는 못합니다. 돌봄과 손상은 서로를 취소하지 않고 같은 시간 안에 남습니다.', '마지막에 눈을 감아 남기는 이미지는 행위를 바라보는 자신까지 한 화면에 넣는 장면입니다.'],
  },
  '03': {
    en: 'WITNESS', ko: '목격', phaseKo: '목격', visual: 'mourning',
    essentialKo: '흰 장미 위에 손을 올려주세요. 손이 가까워질수록 시간이 느려집니다. 가장 느린 시간에 머문 뒤 화면을 비스듬히 바라보며 자신의 색을 찾고, 찾은 자리에서 흰 장미를 눌러주세요.',
    essentialEn: 'Place your hand above the flower. Move time with its height and slowly find your color inside the passing images.',
    helpKo: '흰 장미 위에 손을 올려 시간을 늦추고, 가장 느린 시간에 머문 뒤 화면을 비스듬히 보며 자신의 색을 찾으세요.',
    helpEn: 'Slow time by holding your hand over the white rose, then look from an angle to find your color.',
    helpDetailKo: ['흰 장미 위에 손을 가까이 가져가면 화면의 시간이 느려집니다.', '가장 느린 속도에서 약 3초 머물면 짧은 소리가 납니다. 그 뒤 손을 떼어도 느려진 속도는 잠시 유지됩니다.', '정면에서는 보이지 않던 형체가 화면을 비스듬히 볼 때 나타납니다. 자신의 장미 색을 천천히 찾아보세요.', '찾은 자리에서 흰 장미를 눌러주세요. 이 영상은 되감기지 않으므로, 놓친 장면도 지나간 시간의 일부로 남습니다.'],
    helpDetailEn: ['Bring your hand close to the white rose to slow the image.', 'Stay at the slowest speed for about three seconds to hear a short sound. The slowed speed remains briefly after you remove your hand.', 'A form invisible from the front appears when you look at the screen from an angle. Find your rose color slowly.', 'Press the white rose where you find it. The video does not rewind; a missed scene remains part of the passing time.'],
    aboutKo: '흐르는 장면은 모두 다른 사람들의 장례입니다. 당신이 오래 바라본 장면과 처음에 고른 색이 자신의 자리를 정합니다. 찾기는 목적이 아니라 천천히 보게 만드는 도구입니다.',
    aboutEn: 'Here, mourning is not a still scene but finding your trace again among other people\'s time.',
    aboutDetailKo: ['여기에서 장례는 한 사람의 사건이 아니라 세계 안에서 반복되는 수많은 죽음의 언어입니다. 서로 다른 장면이 지나가고, 관객은 그 안에서 자신의 색을 찾습니다.', '자신의 색을 찾는 일은 정답을 맞히는 게임이 아닙니다. 시간을 늦추고, 정면이 아닌 각도에서 보고, 다른 사람의 시간 사이에 자신의 자리를 대입해 보는 행위입니다.', '되감기가 없다는 조건은 지나간 장면을 소유할 수 없게 합니다. 목격은 붙잡는 일이 아니라 지나감 속에서 잠시 알아보는 일입니다.'],
  },
  '04': {
    en: 'RECORD', ko: '기록', phaseKo: '기록', visual: 'archive',
    essentialKo: '헤드폰을 쓰고 편한 자리에서 보시면 됩니다. 영상에는 정해진 처음과 마지막이 없습니다. 어느 장면에서 들어와도 되고, 언제 나가셔도 됩니다.',
    essentialEn: 'Look slowly through the scenes and specimen records left behind.',
    helpKo: '헤드폰을 쓰고 편한 자리에서 영상을 보세요. 어느 장면에서 들어와도 되고, 언제 나가도 됩니다. 장미에 휴대폰을 대면 이곳에 머문 시간이 연결됩니다.',
    helpEn: 'Put on the headphones and watch from any point for as long as you wish. Touch your phone to the rose to connect this stay.',
    helpDetailKo: ['헤드폰을 쓰고 볼 수 있는 위치에 앉거나 섭니다. 사용 전후에는 준비된 티슈로 닦아주세요.', '영상에는 정해진 시작과 끝이 없습니다. 어느 장면에서 들어와도 되고, 한 장면만 보고 나가도 됩니다.', '이 장소를 당신의 장미 번호에 연결하려면 안내판의 장미에 휴대폰을 대거나 QR을 스캔합니다. 휴대폰을 연결하지 않아도 영상 감상은 가능합니다.'],
    helpDetailEn: ['Put on the headphones and sit or stand where you can watch comfortably. Please use the supplied tissue before and after use.', 'The film has no fixed beginning or ending. You may enter at any scene and leave at any time.', 'To connect this visit to your rose number, hold your phone to the rose on the sign or scan the QR. The film can also be watched without connecting your phone.'],
    aboutKo: '장미, 해골, 전선과 센서가 하나의 몸이 되는 동안의 손을 기록했습니다. 완성된 작품 뒤에서 사라지는 절단과 연결, 실패와 반복의 시간도 이 장례의 일부로 남깁니다.',
    aboutEn: 'ARCHIVE is not a fourth distortion axis. It is the documentary frame around the other traces.',
    aboutDetailKo: ['기록은 다른 작품의 결과를 설명하는 부록이 아닙니다. 장미, 해골, 전선, 센서와 사람이 하나의 몸이 되어 가는 제작의 시간을 보여줍니다.', '화면 뒤에는 수많은 절단과 연결, 실패와 반복이 있습니다. 완성된 작품만 남기지 않고 그 과정 자체를 장례의 일부로 놓습니다.', '이곳은 네 번째 점수를 만들지 않습니다. 앞선 경험들을 감싸는 기록의 자리입니다.'],
  },
};

function moduleHero(stationId, module) {
  const fileName = {
    '01': 'module_01_naming_hero.webp',
    '02': 'module_02_reenactment_hero.webp',
    '03': 'module_03_mourning_hero.webp',
    '04': 'module_04_archive_hero.webp',
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

function leaveStation(stationId) {
  markStationComplete(stationId);
  const session = ensureSession();
  if (session.connected_station === stationId) {
    updateSession({ connected_station: null });
    leaveDbStation(stationId);
    window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
    logEvent('station_leave', { reason: 'manual' }, stationId);
    flushAnalyticsEvents('station_leave');
  }
  screenHome();
}

function screenModule(stationId, options = {}) {
  const session = ensureSession();
  const module = MODULES[stationId];
  if (!module) {
    screenHome();
    return;
  }

  if (!isRegistered(session)) {
    updateSession({ pending_station: options.enter ? stationId : null });
    session.intro_seen ? screenPersonalSetup() : screenArrival();
    return;
  }

  const via = options.via || 'floorplan';
  const needsName = ['02', '03'].includes(stationId) && !session.emotional_name;
  if (options.enter && needsName) {
    updateSession({ pending_station: stationId });
    logEvent('station_name_required', { via }, stationId);
  } else if (options.enter) {
    updateSession({ connected_station: stationId });
    enterDbStation(stationId, via);
    window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: stationId } }));
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
      needsName ? el('section', { class: 'naming-prerequisite' },
        el('span', { class: 'instruction-level' }, 'EMOTIONAL NAMING / REQUIRED'),
        el('h2', {}, tr('이 작품에는 당신이 지은 이름이 필요합니다', 'THIS WORK NEEDS YOUR NAME')),
        el('p', {}, tr(
          '01의 장미 정원을 지난 뒤 감정명을 붙이는 것을 권합니다. 그 이름이 이 작품의 화면 안에 나타납니다.',
          'We recommend making your name after the rose garden in 01. That name appears inside this work.',
        )),
        el('div', { class: 'naming-prerequisite-actions' },
          textButton(tr('01 장미 정원으로 갑니다', 'GO TO 01'), () => screenModule('01', { via: 'name_required' })),
          textButton(tr('지금 감정명을 붙입니다', 'MAKE MY NAME NOW'), () => screenFinalReflection({ exitFlow: false, returnToStation: stationId })),
        ),
      ) : connected ? el('div', { class: 'connected-banner' },
        el('span', {}, '● CONNECTED'),
        el('span', {}, `STATION / ${stationId}`),
      ) : el('section', { class: 'tag-instruction' },
        el('span', { class: 'tag-symbol', 'aria-hidden': 'true' }, '⌁'),
        el('div', {},
          el('h2', {}, tr('이 작품을 시작하려면', 'TO BEGIN THIS WORK')),
          el('p', {}, tr('안내판의 장미에 휴대폰을 대거나 옆의 QR을 찍어주세요.', 'Hold your phone to the rose or scan the QR.')),
        ),
      ),
      connected && !needsName ? el('section', { class: 'essential-instruction' },
        el('span', { class: 'instruction-level' }, 'ESSENTIAL / 01'),
        el('h2', {}, tr('지금 해야 할 것', 'WHAT TO DO NOW')),
        el('p', {}, tr(module.essentialKo, module.essentialEn)),
      ) : null,
      el('section', { class: 'module-info-block' },
        el('span', { class: 'micro-label' }, tr('HOW IT WORKS', 'HOW IT WORKS')),
        el('h2', {}, tr('작동법', 'HOW TO USE THIS WORK')),
        el('p', {}, tr(module.helpKo, module.helpEn)),
        disclosure(
          tr('더 자세히 알고 싶어요', 'SHOW DETAILED STEPS'),
          el('ol', { class: 'detailed-step-list' }, ...tr(module.helpDetailKo, module.helpDetailEn).map((step) => el('li', {}, step))),
          `how_to_${stationId}`,
        ),
      ),
      el('section', { class: 'module-info-block' },
        el('span', { class: 'micro-label' }, 'ABOUT THIS WORK'),
        el('h2', {}, tr('이 작품에 대하여', 'ABOUT THIS WORK')),
        el('p', {}, tr(module.aboutKo, module.aboutEn)),
        disclosure(
          tr('더 자세히 알아보기', 'READ MORE ABOUT THIS WORK'),
          el('div', { class: 'copy-stack' }, ...tr(module.aboutDetailKo, module.aboutDetailEn).map((paragraph) => el('p', {}, paragraph))),
          `about_${stationId}`,
        ),
      ),
      textButton(tr('프로젝트 전체에서 이 작품 읽기', 'READ THIS WORK IN THE FULL PROJECT'), () => screenAboutProject(workAboutSection(stationId)), 'module-full-story'),
      !connected ? textButton(tr('HOME으로 돌아가기', 'RETURN HOME'), screenHome, 'return-home') : null,
    ),
  ], connected && !needsName ? [
    primaryButton(stationId === '01' ? tr('감정명을 남깁니다', 'NAME THIS FEELING') : tr('이 작품을 마칩니다', 'FINISH THIS WORK'), () => {
      if (stationId === '01') {
        markStationComplete('01');
        updateSession({ connected_station: null });
        leaveDbStation('01');
        window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
        logEvent('station_leave', { reason: 'manual' }, '01');
        flushAnalyticsEvents('station_leave');
        screenFinalReflection({ exitFlow: false });
      } else {
        leaveStation(stationId);
      }
    }),
  ] : []);
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
        el('span', {}, 'MY SPECIMEN'),
        el('span', {}, `ROSE NO. ${session.display_record_no}`),
      ),
      roseVisual('specimen', 'CURRENT MY ROSE', traceProfile),
      el('div', { class: 'specimen-name' },
        el('span', {}, session.emotional_name ? 'EMOTIONAL NAME' : 'NOT YET NAMED'),
        el('h1', {}, displayName(session)),
      ),
      el('section', { class: 'trace-section' },
        el('div', { class: 'section-heading-row' },
          el('h2', {}, 'CURRENT TRACE'),
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
        textButton(session.emotional_name ? tr('감정명 보기', 'VIEW EMOTIONAL NAME') : tr('감정명명하기', 'EMOTIONAL NAMING'), () => screenFinalReflection({ exitFlow: false })),
        textButton(tr('HOME으로', 'RETURN HOME'), screenHome),
      ),
    ),
  ]);
  void refreshRemoteTraceSummaries();
}

function screenExitJourney() {
  const session = ensureSession();
  rememberView('exit');
  clearStationQuery();

  if (session.connected_station) {
    leaveDbStation(session.connected_station);
    window.dispatchEvent(new CustomEvent('fringe:station', { detail: { station: null } }));
    logEvent('station_leave', { reason: 'exit' }, session.connected_station);
    updateSession({ connected_station: null });
  }

  const missing = ['01', '02', '03', '04'].filter((stationId) => !getCompletedStations(session).includes(stationId));
  logEvent('exit_entered', { missing_modules: missing }, '05');
  flushAnalyticsEvents('exit_entered');

  if (!missing.length) {
    screenFinalReflection({ exitFlow: true });
    return;
  }

  render([
    globalHeader(),
    el('section', { class: 'screen exit-screen' },
      el('span', { class: 'micro-label' }, '05 / JOURNEY CHECK'),
      el('h1', { class: 'screen-title' }, tr('아직 지나지 않은 곳이 있습니다.', 'SOME PLACES REMAIN.')),
      el('div', { class: 'missing-list' },
        ...missing.map((stationId) => el('button', { type: 'button', onclick: () => screenModule(stationId, { via: 'exit' }) },
          el('span', {}, stationId),
          el('strong', {}, workTitle(stationId)),
          el('span', {}, '↗'),
        )),
      ),
      el('p', { class: 'intro-copy' }, tr('모든 곳을 지나지 않아도, 지금까지 남긴 것으로 당신의 장미를 완성할 수 있습니다.', 'You may complete your rose with what you have left so far.')),
      textButton(tr('돌아가서 보기', 'RETURN TO EXHIBITION'), screenHome),
    ),
  ], [
    primaryButton(tr('이대로 나의 장미를 완성합니다', 'COMPLETE MY ROSE'), () => {
      logEvent('exit_continue_incomplete', { missing_modules: missing }, '05');
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
    placeholder: tr('원한다면, 지금 남기고 싶은 마음이나 장면을 적어주세요.', 'If you wish, leave a feeling or scene you want to keep.'),
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
    el('span', { class: 'micro-label' }, 'FINAL REFLECTION / 10 QUESTIONS'),
    el('p', { class: 'survey-scale-note' }, tr('약 1분 · 각 막대를 1–10 사이에서 드래그해주세요.', 'About 1 minute · drag each scale from 1 to 10.')),
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
      el('span', { class: 'micro-label' }, exitFlow ? 'FINAL REFLECTION' : 'EMOTIONAL NAMING'),
      el('h1', { class: 'screen-title' }, tr(exitFlow ? '당신의 장미를 완성합니다' : '감정명을 붙입니다', exitFlow ? 'COMPLETE YOUR ROSE' : 'EMOTIONAL NAMING')),
      el('p', { class: 'intro-copy' }, tr(
        '미워했던 한 면과 그 안에 함께 있던 다른 한 면을 놓고, 두 얼굴이 함께 남을 수 있는 하나의 이름을 지어주세요.',
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
        el('label', {}, tr('마지막으로, 오늘의 나에게 하나의 이름을 붙입니다.', 'FINALLY, GIVE TODAY\'S SELF ONE NAME.')),
        finalInput,
      ),
      exitFlow ? survey : null,
      error,
      !exitFlow ? textButton(tr('취소하고 HOME으로', 'CANCEL AND RETURN HOME'), screenHome) : null,
    ),
  ], [
    primaryButton(exitFlow ? tr('당신의 장미를 완성합니다', 'COMPLETE YOUR ROSE') : tr('이 감정명으로 합니다', 'SAVE THIS NAME'), () => {
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
        updateSession({ pending_station: null });
        screenModule(returnToStation, { enter: true, via: 'emotional_naming' });
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
  return el('article', { class: `specimen-reference ${visited ? 'is-visited' : ''}` },
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
  context.fillText('EMOTIONAL NAME / META ROSE', 84, 1012);
  context.fillText('MINNIE PARK / META ROSE 2026', 84, 1320);

  const link = document.createElement('a');
  link.download = `meta-rose-${session.display_record_no}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  logEvent('image_save', {}, '05');
}

async function shareResult() {
  const session = ensureSession();
  const text = `META ROSE SPECIMEN\n${session.emotional_name || '아직 이름 없음'}\nROSE NO. ${session.display_record_no}`;
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
        el('span', {}, 'FINAL META ROSE SPECIMEN'),
        el('strong', {}, `ROSE NO. ${session.display_record_no}`),
      ),
      el('div', { class: 'vertical-specimen' },
        roseVisual('final', 'FINAL META ROSE SPECIMEN', traceProfile),
        el('div', { class: 'specimen-stem stem-top', 'aria-hidden': 'true' }),
        el('div', { class: 'final-emotional-name' },
          el('span', {}, 'EMOTIONAL NAME'),
          el('h1', {}, session.emotional_name || tr('아직 이름 없음', 'NOT YET NAMED')),
        ),
        el('div', { class: 'specimen-stem', 'aria-hidden': 'true' }),
        specimenReference('01', session),
        specimenReference('02', session),
        specimenReference('03', session),
        specimenReference('04', session),
        el('div', { class: 'specimen-stem stem-bottom', 'aria-hidden': 'true' }),
      ),
      el('footer', { class: 'specimen-label' },
        el('div', {}, el('span', {}, 'EMOTIONAL NAME'), el('strong', {}, session.emotional_name || tr('아직 이름 없음', 'NOT YET NAMED'))),
        el('div', {}, el('span', {}, 'ROSE NO.'), el('strong', {}, session.display_record_no)),
        el('div', {}, el('span', {}, 'DATE'), el('strong', {}, new Date().toLocaleDateString('ko-KR'))),
        el('p', {}, 'META ROSE 2026 / MINNIE PARK'),
      ),
    ),
  ], [
    primaryButton(tr('이미지로 저장', 'SAVE IMAGE'), saveResultImage),
    el('button', { class: 'secondary-action', type: 'button', onclick: shareResult }, tr('공유하기', 'SHARE'), el('span', { 'aria-hidden': 'true' }, '↗')),
  ]);
  void refreshRemoteTraceSummaries();
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
  else screenHome();
}

function boot() {
  // SDK 로드·네트워크 실패는 이 흐름을 막지 않는다. db.js가 local queue로 폴백한다.
  void initDB();
  startIdleTracking();
  startUiActionTracking();
  if (new URLSearchParams(location.search).get('reset') === '1') {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(EVENTS_KEY);
    resetDbSession();
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('reset');
    history.replaceState({}, '', cleanUrl);
  }

  const session = ensureSession();
  applySessionColor(session.color);
  $bar.replaceChildren();

  const station = stationFromQuery();
  if (station === '05') {
    if (!session.intro_seen || !isRegistered(session)) {
      updateSession({ pending_station: station });
      session.intro_seen ? screenPersonalSetup() : screenArrival();
    } else {
      screenExitJourney();
    }
    return;
  }

  if (station && MODULES[station]) {
    if (!session.intro_seen || !isRegistered(session)) {
      updateSession({ pending_station: station });
      session.intro_seen ? screenPersonalSetup() : screenArrival();
    } else {
      screenModule(station, { enter: true, via: 'qr' });
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
