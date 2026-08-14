# META ROSE Phone Hub — Pattern Entry V1

## 확정 범위

- Phone Hub 안의 작품 상세 페이지에서 입장한다. NFC/QR로 새 탭을 여는 방식은 비상용으로 유지한다.
- 관객은 작품 앞의 흑백 장미 패턴과 같은 패턴을 휴대전화에서 선택한다.
- 문구는 작품별로 `명명의 장미`, `개입의 장미`, `목격의 장미`, `기록의 장미`를 사용한다.
- 정답 패턴 선택 시 짧은 흑백 확인 동작 뒤 Supabase 연결을 시도한다.
- Rose Specimen 중앙 중첩 및 관객 컬러 전환 애니메이션은 V2로 보류했다. `playPatternSuccessTransition()` 안에 추가할 수 있게 분리했다.

## 물리 패턴 에셋

- `assets/patterns/station-01-naming.svg`
- `assets/patterns/station-02-intervention.svg`
- `assets/patterns/station-03-witness.svg`
- `assets/patterns/station-04-record.svg`

각 파일은 Phone Hub의 선택지와 같은 벡터 패턴이다. 작품 앞 안내물에는 해당 작품의 파일 하나만 사용한다. 패턴 옆에 숫자를 추가하지 않는다.

## 잠금 계약

`station_locks`에는 01–04 한 행씩만 존재한다. 입장 방식이 패턴, NFC, QR 중 무엇이든 `claim_station()`을 거쳐야 한다.

- 한 작품에는 동시에 한 세션만 연결된다.
- 같은 관객이 다른 작품 연결에 성공하면 이전 작품 presence와 lock을 같은 트랜잭션에서 자동 종료한다. Phone Hub도 이전 작품을 완료 처리하고 `station_leave.reason = station_switch`를 남긴다.
- 이동하려는 작품이 이미 사용 중이면 이전 작품 연결은 끊지 않는다.
- 이미 점유 중이면 두 번째 관객에게 `다른 장미가 연결되어 있습니다`를 표시하고 TD 세션을 바꾸지 않는다.
- 연결 성공 뒤 휴대전화는 60초마다 lease를 갱신한다.
- lease는 5분이며 네트워크 단절 또는 브라우저 이탈 뒤 자동 만료된다.
- TD는 기존과 같은 `v_active_at_station` URL과 컬럼만 읽는다. TD 작품·캡처 노드는 수정하지 않는다.
- 브라우저의 지연 큐에는 station 활성화 INSERT가 들어가지 않는다. 늦게 전송되어 관객이 떠난 뒤 TD가 켜지는 일을 막는다.

## 배포 순서

1. 최신 Phone Hub 코드를 먼저 GitHub Pages에 배포한다.
2. Supabase SQL Editor에서 `supabase_migration_20260814_exclusive_station_locks.sql`만 실행한다.
3. `supabase_verify_20260814_exclusive_station_locks.sql`을 새 쿼리에서 실행한다.
4. 휴대전화에서 `?reset=1`로 새 장미 번호를 만든다.
5. `?test=1`의 `PATTERN 01`로 UI만 먼저 확인한다.
6. 실제 01 상세 페이지에서 올바른 패턴을 선택하고 Phone Hub, `station_locks`, `v_active_at_station`, TD UUID가 모두 같은지 확인한다.

전체 `supabase_schema.sql`은 다시 실행하지 않는다. migration 직전에는 실제 관객이 작품에 연결되어 있지 않아야 한다.
Migration은 전환 시점에 남아 있는 01–04의 과거 열린 presence에 `left_at`만 기록한다. 행과 기존 데이터는 삭제하지 않는다.

## 지금 가능한 단일 휴대전화 검사

1. 네 패턴이 모두 보이고 실제 작품 패턴 하나와 명확히 구분되는지 확인한다.
2. 오답 선택 시 연결 요청 없이 다시 확인하라는 문구가 나오는지 확인한다.
3. 정답 선택 시 짧은 선택 전환 후 `CONNECTED`가 나오는지 확인한다.
4. Supabase `station_locks`와 `v_active_at_station`에서 휴대전화와 같은 전체 UUID를 확인한다.
5. TD `b.active()`에서 같은 전체 UUID와 색이 보이는지 확인한다.
6. 작품 종료 후 해당 lock이 `idle`, TD가 `idle`인지 확인한다.
7. 같은 휴대전화로 01에서 02로 이동했을 때 01이 닫히고 02만 활성인지 확인한다.

## 전시 전 남겨둔 2대 휴대전화 검사

두 번째 휴대전화가 준비되면 딱 한 번만 수행한다.

1. A가 01 정답 패턴으로 연결한다.
2. A가 연결된 동안 B도 01 정답 패턴을 선택한다.
3. B에는 `다른 장미가 명명과 연결되어 있습니다`가 표시되어야 한다.
4. TD와 `v_active_at_station`은 계속 A의 UUID여야 한다.
5. A가 종료한 뒤 B가 다시 선택하면 B로 연결되어야 한다.

이 검사는 독점성의 최종 물리 검증이며 현재 단일 휴대전화 검사로 대체할 수 없다.
