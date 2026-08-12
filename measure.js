// ============================================================
// 폰 허브 — 측정 레이어
//
// 22 §1: "폰은 그 자체로 가장 풍부한 행동 센서다."
// 별도 기능이 아니다. A·B의 모든 행동에 붙는다.
//
//   C5 읽기 행동  — 체류·스크롤 깊이·완독·[더 읽기]·재열람
//   C6 폰 미사용  — visibility. ★ 이 지표는 폰 허브가 자기 사용량을
//                    줄이는 것을 성공으로 측정한다 (22 §1-2)
//   C7 입력 과정  — 선택까지의 시간·수정 횟수·지운 횟수
//   C9 규칙 조회  — 부1 opt-in 규칙을 연 시점·머문 시간.
//                    🔴 몰입 지표(C6)에서 분리 집계 (21 §B5)
// ============================================================

import { CONFIG } from './config.js';
// 읽기·스크롤·입력 과정은 전시 중 작동에 필요하지 않아 checkpoint batch로 보낸다.
import { logAnalyticsEvent as logEvent } from './db.js';

// ------------------------------------------------------------
// C5. 읽기 행동
// ------------------------------------------------------------
const readState = new Map();   // key -> {enteredAt, maxDepth, marks, opens}

export function beginRead(key, el) {
  const prev = readState.get(key);
  const opens = prev ? prev.opens + 1 : 1;

  readState.set(key, {
    enteredAt: performance.now(),
    enteredAtISO: new Date().toISOString(),
    maxDepth: 0,
    marks: new Set(),
    opens,
    el,
    chars: el ? (el.innerText || '').length : 0,
  });

  logEvent('read_begin', {
    payload: { key, open_count: opens, reopened: opens > 1 },
  });

  if (el) attachScroll(key, el);
}

function attachScroll(key, el) {
  const target = el.scrollHeight > el.clientHeight + 8 ? el : window;
  const handler = () => {
    const st = readState.get(key);
    if (!st) return;
    let depth;
    if (target === window) {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      depth = h <= 0 ? 100 : Math.round((window.scrollY / h) * 100);
    } else {
      const h = el.scrollHeight - el.clientHeight;
      depth = h <= 0 ? 100 : Math.round((el.scrollTop / h) * 100);
    }
    depth = Math.max(0, Math.min(100, depth));
    if (depth > st.maxDepth) st.maxDepth = depth;

    const step = CONFIG.MEASURE.scrollDepthStep;
    const mark = Math.floor(depth / step) * step;
    if (mark > 0 && !st.marks.has(mark)) {
      st.marks.add(mark);
      logEvent('read_depth', { payload: { key, depth: mark } });
    }
  };
  target.addEventListener('scroll', handler, { passive: true });
  const st = readState.get(key);
  if (st) st._detach = () => target.removeEventListener('scroll', handler);
  handler();
}

export function endRead(key) {
  const st = readState.get(key);
  if (!st) return null;
  if (st._detach) st._detach();

  const dwellMs = Math.round(performance.now() - st.enteredAt);
  const completed = st.maxDepth >= CONFIG.MEASURE.readEndThreshold;
  // 읽기 속도 — 글자수 ÷ 초. 정독 vs 훑기 (22 §1-1)
  const cps = dwellMs > 0 ? +(st.chars / (dwellMs / 1000)).toFixed(1) : null;

  logEvent('read_end', {
    payload: {
      key,
      dwell_ms: dwellMs,
      max_depth: st.maxDepth,
      completed,
      chars: st.chars,
      chars_per_sec: cps,
      open_count: st.opens,
    },
    occurredAt: new Date().toISOString(),
  });

  readState.delete(key);
  return { dwellMs, maxDepth: st.maxDepth, completed };
}

// [더 읽기] 상세 레이어 — 더 알고 싶어했는가 = 관여도
export function logDetailOpen(key) {
  logEvent('detail_open', { payload: { key } });
  beginRead(key + '.detail');
}
export function logDetailClose(key) {
  endRead(key + '.detail');
}

// ------------------------------------------------------------
// C9. 부1 규칙 조회 — 열람 자체가 지표다 (21 §B5)
//   🔴 이 시간은 몰입 지표에서 빼야 한다. 그래서 event_type을 따로 둔다.
// ------------------------------------------------------------
let rulesOpenedAt = null;
let rulesOpenCount = 0;

export function logRulesOpen() {
  rulesOpenedAt = performance.now();
  rulesOpenCount += 1;
  logEvent('rules_open', {
    station: '02',
    payload: { open_count: rulesOpenCount },
  });
  beginRead('sub1.rules');
}

export function logRulesClose() {
  const r = endRead('sub1.rules');
  const dwellMs = rulesOpenedAt
    ? Math.round(performance.now() - rulesOpenedAt) : null;
  logEvent('rules_close', {
    station: '02',
    payload: {
      dwell_ms: dwellMs,
      open_count: rulesOpenCount,
      exclude_from_immersion: true,   // ★ 분석 시 C6에서 제외할 표식
      read: r,
    },
  });
  rulesOpenedAt = null;
}

// ------------------------------------------------------------
// C6. 폰 미사용 시간 = 몰입 지표
//   화면이 꺼졌거나 다른 앱으로 갔던 시간.
//   "폰을 주머니에 넣고 작품을 본 시간" (22 §1-2)
// ------------------------------------------------------------
let hiddenAt = null;
let awayTotalMs = 0;
let currentStationForIdle = null;

export function startIdleTracking() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      logEvent('phone_away_start', { payload: {} });
    } else if (hiddenAt) {
      const ms = Date.now() - hiddenAt;
      awayTotalMs += ms;
      logEvent('phone_away_end', {
        payload: {
          away_ms: ms,
          away_total_ms: awayTotalMs,
          station: currentStationForIdle,
        },
        // ★ 행동한 순간 = 돌아온 순간이 아니라 떠난 순간부터의 구간
        occurredAt: new Date(hiddenAt).toISOString(),
      });
      hiddenAt = null;
    }
  });

  // 모듈별 미사용 시간을 나누기 위한 마커
  window.addEventListener('fringe:station', (e) => {
    currentStationForIdle = e.detail?.station ?? null;
  });
}

export function getAwayTotalMs() { return awayTotalMs; }

// ------------------------------------------------------------
// C7. 입력 과정 — 결과가 아니라 과정
//   선택까지의 시간 · 수정 횟수 · 지운 횟수
// ------------------------------------------------------------
export function trackInput(el, key) {
  const t0 = performance.now();
  let edits = 0;
  let deletes = 0;
  let maxLen = 0;
  let firstKeyAt = null;

  const onKey = (e) => {
    if (firstKeyAt === null) firstKeyAt = performance.now();
    if (e.key === 'Backspace' || e.key === 'Delete') deletes += 1;
  };
  const onInput = () => {
    edits += 1;
    const len = el.value.length;
    if (len < maxLen) deletes += 1;     // 모바일 IME는 keydown이 안 잡힘
    maxLen = Math.max(maxLen, len);
    if (firstKeyAt === null) firstKeyAt = performance.now();
  };

  el.addEventListener('keydown', onKey);
  el.addEventListener('input', onInput);

  return {
    // 확정 시점에 호출
    commit(value) {
      const now = performance.now();
      const meta = {
        key,
        time_to_first_ms: firstKeyAt ? Math.round(firstKeyAt - t0) : null,
        total_ms: Math.round(now - t0),
        edits,
        deletes,
        final_len: (value ?? el.value ?? '').length,
        max_len: maxLen,
        // 지운 게 많다 = 언어를 찾기 어려웠다 (22 §1-3)
        struggled: deletes > 5 || edits > 40,
      };
      logEvent('input_commit', { payload: meta });
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('input', onInput);
      return meta;
    },
    peek() {
      return { edits, deletes, ms: Math.round(performance.now() - t0) };
    },
  };
}

// 선택형(색 등) — 선택까지 걸린 시간 + 바꾼 횟수
export function trackChoice(key) {
  const t0 = performance.now();
  let changes = 0;
  let first = null;
  return {
    pick(value) {
      if (first === null) first = value; else changes += 1;
      logEvent('choice_change', {
        payload: { key, value, change_index: changes },
      });
    },
    commit(value) {
      const meta = {
        key,
        value,
        first_value: first,
        changed: changes,
        total_ms: Math.round(performance.now() - t0),
        // 자기 규정의 흔들림 (22 §1-3)
        wavered: changes >= 3,
      };
      logEvent('choice_commit', { payload: meta });
      return meta;
    },
  };
}

// ------------------------------------------------------------
// 여정 — 화면 전환 순서 전체 (22 §1-5)
// ------------------------------------------------------------
let lastScreen = null;
let lastScreenAt = null;

export function logScreen(name) {
  const now = performance.now();
  if (lastScreen) {
    logEvent('screen_leave', {
      payload: {
        screen: lastScreen,
        dwell_ms: Math.round(now - lastScreenAt),
        next: name,
      },
    });
  }
  logEvent('screen_enter', { payload: { screen: name, from: lastScreen } });
  lastScreen = name;
  lastScreenAt = now;
}
