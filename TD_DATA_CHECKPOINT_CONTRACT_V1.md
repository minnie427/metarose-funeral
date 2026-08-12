# META ROSE — TD 데이터 체크포인트 계약 v1

전시 안정성을 우선한다. TD는 Phone Hub와 실시간으로 직접 통신하지 않는다.

```text
TD 상호작용 발생
  → TD 로컬 CSV에 즉시 기록 (원본·필수)
  → 의미 있는 이동 지점에서 이벤트 묶음만 Supabase로 전송
  → Phone Hub에는 trace summary / artifact만 사용
```

`td_bridge.py`의 `push_event()`는 네트워크와 무관하게 즉시 CSV에 기록한다. `checkpoint()`가 호출될 때에만 메모리에 모인 원본 이벤트가 Supabase `events`로 batch 전송된다. 재전송은 `event_uid`로 중복을 막는다.

## 절대 원칙

- TD 렌더/게임/캡처 루프에서 HTTP 요청을 하지 않는다.
- 전송 실패는 작품 작동에 영향을 주지 않는다. 로컬 CSV가 원본이다.
- Phone Hub는 raw TD 이벤트를 읽거나 polling하지 않는다.
- `trace_summary` 한 건만 Phone Hub 최종 장미 표현에 사용한다.
- 전체 Phone Hub session의 종료는 **Exit 설문 완료**다. SUB1 엔딩은 세션 종료가 아니라 해당 모듈의 체크포인트다.
- TD에는 Supabase **Secret/service_role key만** 로컬로 입력한다. 이 키는 Phone Hub, GitHub, 문서 공유본에 절대 넣지 않는다.

## 체크포인트: 반드시 호출할 시점

1. 결과가 확정되는 순간: `combo_commit`, `capture_saved`, `ending_reached`, `assigned`, `found`, 아카이브 저장 등
2. 한 플레이/모듈이 끝나는 순간
3. Phone Hub가 다음 station 또는 Exit로 태깅되어 해당 TD의 active session이 바뀔 때 — bridge가 자동 호출
4. TD 종료·재시작 직전 — `stop()`이 자동 호출

예시:

```python
mod('td_bridge').push_event('combo_commit', {...}, scope='team')
mod('td_bridge').checkpoint('combo_committed', summary={'resonance_trace': 2})
```

## MAIN1 — 01 명명 / NAMING

| 원본 이벤트 | payload 필수값 |
|---|---|
| `rose_touch` | `channel`, `hold_ms`, `polarity` |
| `first_touch` | `delay_ms` |
| `combo_commit` | `channels`, `positive`, `negative`, `polarity` |
| `combo_change` | `count`, `from`, `to` |
| `circuit_break` | `duration_ms` |
| `circuit_join` | `total_held_ms` |
| `reset_pressed` | `count` |
| `capture_saved` | `image_path`, `combo` |

완료 시: `checkpoint('main1_complete', summary={'resonance_trace': 0|1|2})`.

## SUB1 — 02 개입 / INTERVENTION

| 원본 이벤트 | payload 필수값 |
|---|---|
| `item_use` | `item` (`water/sun/poison/monster`), `kind` (`save/kill`), `vitality` |
| `first_item` | `delay_ms`, `item` |
| `respawn` | `count`, `trauma_marks` |
| `ending_reached` | `vitality`, `thorn`, `distance`, `play_ms` |
| `replay_start` | `count` |
| `replay_delta` | `prev`, `now`, `changed` |
| `eye_capture` | `image_path`, `false_positive` |

눈 감기 스크린샷은 `eye_capture`로만 남긴다. 파일 원본은 TD 로컬 보관이며 DB에는 경로·메타데이터만 남긴다.

엔딩 도달 시: `end_session_by_ending()` 또는 `checkpoint('ending_reached', summary={'mutation_trace': 0|1|2})`. 이름은 호환성 때문에 남았지만 Phone Hub 세션을 끝내지 않는다.

## SUB2 — 03 목격 / WITNESS

| 원본 이벤트 | payload 필수값 |
|---|---|
| `speed_change` | `mm`, `speed`, `slow` |
| `slow_count` | `index`, `style`, `clip` |
| `assigned` | `style`, `clip`, `slow_clips`, `color_rgb` |
| `found` | `attempts`, `seconds_to_find`, `dwell_total_s` |
| `missed_pass` | `count` |
| `easteregg_heard` | `presence`, `clip` |

배정/발견 확정 시: `checkpoint('found', summary={'temporal_trace': 0|1|2})`.

## SUB3 — 04 기록 / RECORD

기록 모듈의 화면·선택·저장 결과는 확정 전이다. 구현 시 동일한 원칙으로 다음을 남긴다.

- 아카이브 열람·선택·저장/제출 결과
- 결과가 확정된 때의 `checkpoint('record_complete', summary={...})`
- 원본 이미지·영상은 TD/운영 저장소에 보관하고, Supabase에는 경로·요약만 남긴다.

## TD에서 필요한 최소 설정

```python
SUPABASE_URL = 'https://…supabase.co'
SUPABASE_TD_KEY = 'Secret/service_role key — TD 컴퓨터에만'
MODULE = 'td_main1'  # 또는 td_sub1 / td_sub2
STATION = '01'       # 01 / 02 / 03
```

`start()`는 Execute DAT의 onStart에서 한 번만 호출한다. TD별 실제 이벤트 hook 설치는 아직 별도 작업이며, 이 문서는 그 구현 계약이다.
