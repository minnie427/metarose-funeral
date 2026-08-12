# ============================================================
# TD ↔ Supabase 브리지
#
# TouchDesigner의 Text DAT에 통째로 붙여넣고 이름을 `td_bridge` 로.
# 다른 DAT/CHOP에서:  mod('td_bridge').push_event(...)
#
# ★ 설계 원칙 (11 로그 8/5 S11-D~H의 교훈을 그대로 가져옴)
#   1. 통신은 Worker Thread에서. TD를 절대 멈추지 않는다
#   2. 전송 실패가 캡처·게임·렌더에 영향을 주지 않는다 (완전 분리)
#   3. 활성 세션 판별은 `status == 'active'` 로 한다
#      — 서버가 종료 후에도 마지막 metadata를 유지하므로
#        session_id가 비었는지로 판단하면 안 된다 (S11-F)
#   4. 재연결 순간 backoff를 무시하고 즉시 재전송 (S11-H wake)
#   5. 🔴 로컬 CSV 동시 기록은 선택이 아니라 필수 (22 §5-1)
#      B1 지하 = 네트워크 불안정. 3일치를 한 번에 잃으면 검증이 무너진다
#
# 의존성 없음 — Python 표준 라이브러리만 쓴다.
# (TD Web Client DAT의 formParts/mimeParts 미지원 문제를 우회한 것과 같은 이유)
# ============================================================

import csv
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

# ------------------------------------------------------------
# 설정 — config.js와 같은 값을 넣는다
# ------------------------------------------------------------
SUPABASE_URL = ''          # 예: https://abcdefgh.supabase.co
# TD 전용 키: Supabase Dashboard의 Secret / service_role key를 이 TD 컴퓨터에만
# 넣는다. 관객 Phone Hub의 publishable key와 절대 혼용·공개하지 않는다.
SUPABASE_TD_KEY = ''

MODULE = 'td_main1'        # td_main1 | td_sub1 | td_sub2
STATION = '01'             # 00~05
SCHEMA_VERSION = 'fringe2026.1'

# 🔴 로컬 CSV — 이 경로는 반드시 존재해야 한다
CSV_DIR = os.path.expanduser('~/fringe2026_logs')
POLL_SEC = 2.0             # 활성 세션 폴링 주기
MAX_BACKOFF = 60.0
# raw TD 이벤트는 매 프레임/행동마다 클라우드로 보내지 않는다.
# 항상 CSV에는 즉시 남기고, module 종료·캡처·station handoff 때 batch로 올린다.
EVENT_UPLOAD_MODE = 'checkpoint'   # checkpoint | immediate (디버그 전용)

# ------------------------------------------------------------
# 내부 상태
# ------------------------------------------------------------
_q = queue.Queue(maxsize=20000)
_worker = None
_stop = threading.Event()
_wake = threading.Event()

_active = {                # TD가 읽는 현재 활성 세션
    'status': 'idle',
    'session_id': '',
    'color': '',
    'display_name': '',
    'is_final': False,
    'entered_at': '',
    'fetched_at': 0.0,
}
_lock = threading.Lock()
_csv_files = {}
_pending_events = []
_pending_lock = threading.Lock()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _headers():
    return {
        'apikey': SUPABASE_TD_KEY,
        'Authorization': 'Bearer ' + SUPABASE_TD_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    }


def _configured():
    return bool(SUPABASE_URL and SUPABASE_TD_KEY)


# ------------------------------------------------------------
# 로컬 CSV — 클라우드보다 먼저 쓴다. 이게 원본이다.
# ------------------------------------------------------------
def _csv_writer(table):
    if table in _csv_files:
        return _csv_files[table]
    os.makedirs(CSV_DIR, exist_ok=True)
    day = datetime.now().strftime('%Y%m%d')
    path = os.path.join(CSV_DIR, f'{MODULE}_{table}_{day}.csv')
    new = not os.path.exists(path)
    f = open(path, 'a', newline='', encoding='utf-8')
    w = csv.writer(f)
    if new:
        w.writerow(['written_at', 'table', 'json'])
    _csv_files[table] = (f, w)
    return _csv_files[table]


def _csv_append(table, row):
    try:
        f, w = _csv_writer(table)
        w.writerow([_now(), table, json.dumps(row, ensure_ascii=False)])
        f.flush()          # 크래시해도 남아 있어야 한다
    except Exception as e:
        print('[bridge] CSV 실패', e)


# ------------------------------------------------------------
# 공개 API — TD 쪽에서 부르는 것들
# ------------------------------------------------------------
def push_event(event_type, payload=None, scope='team', session_id=None,
               occurred_at=None):
    """인터랙션 하나를 기록한다.

    scope — 21 §4 귀속 규칙:
      메인1 장미 터치·조합      = 'team'   (인간사슬은 구조적으로 2인+)
      부1 게임 플레이           = 'team'
      부1 엔딩 저장             = 'individual'
      부2 발견·엔딩             = 'individual' (색 시그니처가 식별자)

    session_id를 안 주면 현재 활성 세션에 귀속된다.
    활성 세션이 없으면 session_id=None으로 남고, 서버가 나중에
    시각으로 맞춘다(v_attribution_gap에서 결합 누락률로 잡힌다).
    """
    with _lock:
        sid = session_id or (_active['session_id'] or None)

    row = {
        'session_id': sid,
        'station_id': STATION,
        'event_type': event_type,
        'scope': scope,
        'occurred_at': occurred_at or _now(),   # ★ 행동한 순간
        'seq': None,
        'event_uid': str(uuid.uuid4()),
        'source': MODULE,
        'payload': payload or {},
        'schema_version': SCHEMA_VERSION,
    }
    _csv_append('events', row)
    if EVENT_UPLOAD_MODE == 'immediate':
        _enqueue('events', row)
    else:
        with _pending_lock:
            _pending_events.append(row)
    return row


def checkpoint(reason='module_checkpoint', session_id=None, summary=None):
    """TD raw log를 안전한 이동 지점에서 한 묶음으로 Supabase에 보낸다.

    CSV는 각 상호작용 순간에 이미 기록되어 있고, 이 함수는 네트워크 전송만
    묶는다. 전송 실패 시 worker queue가 재시도하며 event_uid로 중복을 막는다.
    summary는 Phone Hub에 필요한 단일 결과값(trace)을 artifact로 즉시 남긴다.
    """
    with _lock:
        sid = session_id or (_active['session_id'] or None)

    with _pending_lock:
        if sid:
            rows = [r for r in _pending_events if r.get('session_id') == sid]
            _pending_events[:] = [r for r in _pending_events if r.get('session_id') != sid]
        else:
            rows = list(_pending_events)
            _pending_events.clear()

    checkpoint_row = {
        'session_id': sid,
        'station_id': STATION,
        'event_type': 'td_checkpoint',
        'scope': 'individual',
        'occurred_at': _now(),
        'seq': None,
        'event_uid': str(uuid.uuid4()),
        'source': MODULE,
        'payload': {'reason': reason, 'event_count': len(rows)},
        'schema_version': SCHEMA_VERSION,
    }
    _csv_append('events', checkpoint_row)
    rows.append(checkpoint_row)
    if rows:
        _enqueue('events_batch', rows)

    if summary is not None:
        push_artifact('trace_summary', value=reason, meta=summary, session_id=sid)
    return len(rows)


def push_artifact(art_type, value=None, image_path=None, meta=None,
                  session_id=None):
    """관객이 남긴 것. 이미지는 경로만 보낸다.

    ⚠️ 21 §5 — 700명 × 4장 × 500KB ≈ 1.4GB > 무료 1GB.
       이미지 원본은 이 PC에 두고 DB에는 경로만 남긴다.
    """
    with _lock:
        sid = session_id or (_active['session_id'] or None)
    row = {
        'session_id': sid,
        'station_id': STATION,
        'type': art_type,
        'value': value,
        'image_path': image_path,
        'meta': meta or {},
        'occurred_at': _now(),
    }
    _csv_append('artifacts', row)
    _enqueue('artifacts', row)
    return row


def end_session_by_ending(session_id=None):
    """호환용 별칭. 부1 엔딩은 전체 세션을 종료하지 않는다.
    Exit 설문 완료만 session 종료다.
    """
    with _lock:
        sid = session_id or (_active['session_id'] or None)
    if not sid:
        return None
    push_event('ending_reached', {'by': MODULE}, scope='individual', session_id=sid)
    checkpoint('ending_reached', session_id=sid)
    return sid


def active():
    """TD가 매 프레임 읽어도 되는 현재 세션. 네트워크를 타지 않는다.

    ★ 게이트는 이렇게 쓴다 (S11-F·S11-H 교훈):
        a = mod('td_bridge').active()
        if a['status'] == 'active' and a['session_id']:
            ...  # 여기서만 촬영·기록을 허용
    """
    with _lock:
        return dict(_active)


def session_color(default=(0.69, 0.23, 0.23)):
    """세션 색을 (r, g, b) 0~1 튜플로. Constant TOP/CHOP에 바로 넣는다."""
    with _lock:
        hexv = _active.get('color') or ''
    if not hexv.startswith('#') or len(hexv) != 7:
        return default
    try:
        return tuple(int(hexv[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
    except Exception:
        return default


def display_name():
    """화면에 띄울 이름. 최종 명명이 있으면 그것, 없으면 가명."""
    with _lock:
        return _active.get('display_name') or ''


def queue_size():
    return _q.qsize()


def wake():
    """네트워크가 돌아온 순간 호출 — backoff를 무시하고 즉시 재전송."""
    _wake.set()


# ------------------------------------------------------------
# 워커
# ------------------------------------------------------------
def _enqueue(kind, row):
    try:
        _q.put_nowait({'kind': kind, 'row': row, 'tries': 0, 'next_at': 0.0})
    except queue.Full:
        # 큐가 가득 차도 CSV에는 이미 들어갔다. 여기서 죽지 않는다.
        print('[bridge] 큐 가득참 — CSV만 유지')


def _post(path, body, ignore_duplicates=False):
    headers = _headers()
    if ignore_duplicates:
        headers['Prefer'] = 'return=minimal,resolution=ignore-duplicates'
    req = urllib.request.Request(
        SUPABASE_URL.rstrip('/') + '/rest/v1/' + path,
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.status


def _patch(path, body):
    req = urllib.request.Request(
        SUPABASE_URL.rstrip('/') + '/rest/v1/' + path,
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers=_headers(), method='PATCH')
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.status


def _get(path):
    req = urllib.request.Request(
        SUPABASE_URL.rstrip('/') + '/rest/v1/' + path,
        headers=_headers(), method='GET')
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode('utf-8'))


def _send(job):
    kind, row = job['kind'], job['row']
    if kind == 'events':
        _post('events', row)
    elif kind == 'events_batch':
        _post('events?on_conflict=event_uid', row, ignore_duplicates=True)
    elif kind == 'artifacts':
        _post('artifacts', row)
    elif kind == 'sessions_update':
        _patch('sessions?id=eq.' + row['id'], row['patch'])
    else:
        raise ValueError('unknown kind ' + kind)


def _poll_active():
    """★ status == 'active' 인 세션만 가져온다 (S11-F).

    v_active_at_station 뷰가 스테이션별로 가장 최근 결합을 준다.
    """
    try:
        rows = _get(
            'v_active_at_station?station_id=eq.' + STATION + '&select=*')
    except Exception:
        return
    with _lock:
        previous_sid = _active.get('session_id') or ''
        if rows:
            r = rows[0]
            _active.update({
                'status': 'active',
                'session_id': r.get('session_id') or '',
                'color': r.get('color') or '',
                'display_name': r.get('display_name') or '',
                'is_final': bool(r.get('is_final')),
                'entered_at': r.get('entered_at') or '',
                'fetched_at': time.time(),
            })
        else:
            # 🔴 활성 세션이 없으면 반드시 값을 비운다.
            #    지우지 않으면 이전 관객의 색·이름이 남아 다음 사람에게
            #    적용된다 (S11-F가 지적한 바로 그 사고).
            _active.update({
                'status': 'idle', 'session_id': '', 'color': '',
                'display_name': '', 'is_final': False,
                'fetched_at': time.time(),
            })
        current_sid = _active.get('session_id') or ''
    # 관객이 다음 station으로 태깅하거나 Exit로 가면 열린 raw batch를 자동 백업한다.
    if previous_sid and previous_sid != current_sid:
        checkpoint('station_handoff', session_id=previous_sid)


def _loop():
    last_poll = 0.0
    while not _stop.is_set():
        if not _configured():
            time.sleep(1.0)
            continue

        # 1) 활성 세션 폴링
        if time.time() - last_poll > POLL_SEC:
            _poll_active()
            last_poll = time.time()

        # 2) 큐 비우기
        pending = []
        drained = 0
        woke = _wake.is_set()
        while drained < 50:
            try:
                job = _q.get_nowait()
            except queue.Empty:
                break
            drained += 1
            if not woke and job['next_at'] > time.time():
                pending.append(job)
                continue
            try:
                _send(job)
            except Exception as e:
                job['tries'] += 1
                backoff = min(2 ** job['tries'], MAX_BACKOFF)
                job['next_at'] = 0.0 if woke else time.time() + backoff
                job['last_error'] = str(e)[:200]
                pending.append(job)
        for j in pending:
            try:
                _q.put_nowait(j)
            except queue.Full:
                pass
        if woke:
            _wake.clear()

        time.sleep(0.25)


def start():
    """TD 시작 시 한 번 호출. Execute DAT의 onStart에 넣으면 된다."""
    global _worker
    if _worker and _worker.is_alive():
        return
    _stop.clear()
    _worker = threading.Thread(target=_loop, daemon=True,
                               name='fringe_bridge')
    _worker.start()
    print('[bridge] 시작 ·', MODULE, 'station', STATION,
          '· supabase', 'ON' if _configured() else 'OFF(CSV만)')


def stop():
    checkpoint('td_stop')
    _stop.set()
    for f, _ in _csv_files.values():
        try:
            f.close()
        except Exception:
            pass
    _csv_files.clear()


# ------------------------------------------------------------
# TD에서 쓰는 법 (요약)
# ------------------------------------------------------------
"""
[1] Execute DAT · onStart
        mod('td_bridge').start()

[2] 세션 게이트 — 촬영·기록 전에 반드시 (S11-H 3단 게이트와 같은 자리)
        a = mod('td_bridge').active()
        if a['status'] != 'active' or not a['session_id']:
            return          # 조용히 무시. 에러 아님.

[3] 세션 색 적용 — Constant TOP
        r, g, b = mod('td_bridge').session_color()
        op('constant_session_color').par.colorr = r
        op('constant_session_color').par.colorg = g
        op('constant_session_color').par.colorb = b

[4] 메인1 — 장미 터치
        mod('td_bridge').push_event('rose_touch', {
            'channel': 7, 'hold_ms': 3200,
            'polarity': 'negative',        # 결과 화면의 극성 비율이 이걸 쓴다
        }, scope='team')

    메인1 — 조합 확정
        mod('td_bridge').push_event('combo_commit', {
            'channels': [3, 7, 11],
            'positive': 1, 'negative': 2,
            'polarity': 'negative',
        }, scope='team')

    메인1 — 회로 끊김 (★ 이 작품 고유의 관계 데이터, 22 §2-1)
        mod('td_bridge').push_event('circuit_break', {'duration_ms': 800},
                                    scope='team')

[5] 부1 — 아이템 사용
        mod('td_bridge').push_event('item_use', {
            'item': 'poison', 'kind': 'kill', 'vitality': 0.42,
        }, scope='team')

    부1 — 엔딩 (촬영 여부와 무관하게 raw batch를 백업한다.
                  전체 Phone Hub 세션 종료는 Exit 설문 완료 시에만 한다.)
        mod('td_bridge').end_session_by_ending()

    부1 — 윙크 촬영 결과
        mod('td_bridge').push_artifact('capture',
            image_path='/Users/.../captures/xxx.png',
            meta={'trigger': 'wink'})

[6] 부2 — 배정·발견
        mod('td_bridge').push_event('assigned', {
            'style': 2, 'clip': 17, 'slow_clips': [4, 9, 17],
        }, scope='individual')
        mod('td_bridge').push_event('found', {
            'attempts': 3, 'seconds_to_find': 214,
            'dwell_total_s': 96.4,        # ★ 목격의 정량화, 부2 고유 지표
        }, scope='individual')
        mod('td_bridge').checkpoint('found', summary={'temporal_trace': 2})

[7] 회차 종료마다 대조 (22 §5-2)
        print('큐 잔량', mod('td_bridge').queue_size())
        # 0이 아니면 아직 안 올라간 것이 있다는 뜻.
        # CSV 행수와 Supabase 행수를 비교해 유실을 즉시 발견할 것.

[8] 네트워크 복구를 감지했을 때
        mod('td_bridge').wake()
"""
