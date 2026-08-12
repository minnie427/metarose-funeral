# META ROSE 2026 — Phone Hub 통합 MASTER v2

**프로젝트:** 〈오늘 나는 죽인다, 나를〉 / META ROSE 2026  
**문서 상태:** 현행 구현·운영 기준 / 2026-08-12  
**적용 범위:** 관객 Phone Hub, QR·NFC 태깅, Supabase, TouchDesigner 데이터 브리지, 최종 specimen, 설문, 운영·백업  
**이 문서의 우선순위:** 최상위

> 이 문서는 기존 `폰허브_MASTER.md`, `21_폰허브_핸드오버.md`, `22_데이터측정_설계.md`의 초기 계획과, 이후 확정된 안정성·익명성·UI 결정을 통합한 **현재 기준 문서**다.  
> 과거 문서는 판단의 경위만 확인할 때 열고, 구현·운영·TD 전달에는 이 문서를 사용한다.

---

## 0. 한 페이지 요약

### Phone Hub의 역할

Phone Hub는 관객의 개인 앱 설치를 요구하지 않는 모바일 웹앱이다. QR/NFC로 작품의 어느 지점에 들어왔는지 기록하고, 장미 색·감정명·작품별 결과를 **한 세션의 장미 번호**에 연결한다.

다만 Phone Hub는 TouchDesigner 화면을 복제하거나 실시간 상태를 보여주는 대시보드가 아니다.

```text
Phone Hub = 세션의 등뼈 + 작품을 이해하도록 돕는 UI + 최종 기록 UI
TouchDesigner = 실제 작품 경험 + 원시 인터랙션 계산 + 결과 확정
Supabase = 익명 세션과 필요한 결과를 안전하게 연결하는 저장소
```

### 세 가지 절대 원칙

1. **작품이 먼저다.** 인터넷·Supabase·휴대폰 오류가 TD의 렌더, 게임, 캡처를 멈추면 안 된다.
2. **관객끼리의 데이터는 절대 보이지 않는다.** 각 브라우저는 자기 익명 세션만 읽고 쓴다.
3. **원시 데이터는 필요한 곳에만 둔다.** TD 원시 상호작용은 로컬 CSV가 원본이고, Phone에는 요약 결과만 전달한다.

### 최종 여정

```text
ARRIVAL
  → 나의 장미 색 선택
  → HOME
  → 01 명명 / NAMING
  → 감정명명
  → 02 개입 / INTERVENTION
  → 03 목격 / WITNESS
  → 04 기록 / RECORD
  → EXIT
  → 10문항 설문 + 선택 자유 소감
  → FINAL META ROSE SPECIMEN
```

- 02와 03의 순서는 자유다.
- 04는 어느 시점에나 볼 수 있다.
- 모든 작품을 보지 않아도 Exit에서 현재 기록으로 장미를 완성할 수 있다.
- 전체 세션의 종료 시점은 **SUB1 엔딩이 아니라 Exit의 Final Reflection 완료 시점**이다.

### 현재 상태 표기

| 표기 | 뜻 |
| --- | --- |
| **P0 / 구현됨** | 지금 전시에 사용하는 핵심 기능. 실제 코드 또는 Supabase에 존재함. |
| **P0 / 연결 중** | 계약·브리지는 준비됐으나 각 TD의 실제 이벤트 hook 검증이 남음. |
| **P1** | 전시 안정성 확인 뒤 추가 가능한 기능. 현재 관객 경험의 필수 조건 아님. |
| **P2 / 보류** | 이번 전시에서 만들지 않음. |

---

## 1. 시스템 전체 구조

```text
                     ┌────────────────────────┐
                     │ GitHub Pages            │
                     │ 정적 Phone Hub 웹앱     │
                     └───────────┬────────────┘
                                 │ HTTPS
                   ┌─────────────▼─────────────┐
                   │ 관객의 휴대폰 브라우저      │
                   │ anonymous auth + local queue│
                   └───────┬──────────┬────────┘
                           │          │
                   QR/NFC URL         │ REST (publishable key)
                           │          │
┌──────────────────────────▼──────────▼──────────────────────────┐
│ Supabase                                                         │
│ sessions · station_presence · events · artifacts · survey       │
│ RLS: 관객은 자신의 anonymous auth.uid 데이터만 접근             │
└─────────────────────────┬──────────────────────────────────────┘
                          │ service_role key / REST
       ┌──────────────────┼──────────────────┐
       │                  │                  │
┌──────▼──────┐   ┌───────▼──────┐   ┌──────▼───────┐
│ MAIN1 TD    │   │ SUB1 TD       │   │ SUB2 TD      │
│ station 01  │   │ station 02    │   │ station 03   │
└──────┬──────┘   └───────┬──────┘   └──────┬───────┘
       │                  │                  │
       └── 로컬 CSV 원본 ─┴── 로컬 CSV 원본 ┴── 로컬 CSV 원본 ─┘
```

### QR/NFC URL 계약

| station | URL query | 실제 역할 |
| --- | --- | --- |
| `00` | `?station=00` 또는 기본 URL | Arrival |
| `01` | `?station=01` | 명명 / NAMING |
| `02` | `?station=02` | 개입 / INTERVENTION |
| `03` | `?station=03` | 목격 / WITNESS |
| `04` | `?station=04` | 기록 / RECORD |
| `05` | `?station=05` | Exit + Final Reflection |

배포 URL은 다음이다.

```text
https://minnie427.github.io/metarose-funeral/
```

QR/NFC는 서버나 TD를 직접 호출하지 않는다. 단지 관객의 Phone Hub를 특정 station으로 열어 **관객이 의도적으로 연결했다는 사실**을 만든다.

---

## 2. 익명성·권한·데이터 윤리

### 수집하지 않는 것

- 실명, 별명, 전화번호, 이메일, SNS 계정
- GPS·정확한 위치 정보
- 원본 카메라 영상·원본 얼굴 이미지
- 키보드 입력 원문 전체, 터치 좌표 원본, 스크롤 좌표 원본
- 다른 관객의 세션·결과·행동 데이터

### 수집하는 개인 관련 정보의 성격

| 정보 | 이유 | 개인정보 여부 및 처리 |
| --- | --- | --- |
| Supabase Anonymous Auth UID | RLS 접근 제어 | 이름과 연결되지 않는 난수. 관객이 타인의 기록을 못 읽게 하는 기술 키. |
| session UUID / 장미 번호 | 한 관람의 데이터 연결 | 무작위 UUID 앞 8자리만 관객 화면에 장미 번호로 보임. |
| 선택한 색 | 작품 내 개인 시그니처·최종 장미 | `#RRGGBB` 한 값. |
| 감정명·자유 소감 | 관객이 자발적으로 남긴 작품의 언어적 기록 | 민감할 수 있으므로 내부 연구·개선용으로만 보관. 공개·배포하지 않음. |
| 행동 요약 | 경험 개선·상호작용 이해 | 클릭의 라벨·읽기 체류·방문/완료 등. 원시 좌표나 원문은 수집하지 않음. |
| TD 결과 요약 | 최종 장미 변화 | `0/1/2` trace 등 작품 내부 계산 결과만 Phone에 전달. |

### 관객 간 분리 방식 — P0 / 구현됨

1. Phone Hub가 Supabase **Anonymous Sign-In**으로 브라우저 전용 익명 사용자(`auth.uid`)를 만든다.
2. `sessions.auth_uid`에 해당 UID를 저장한다.
3. RLS(Row Level Security)가 `sessions`, `station_presence`, `events`, `artifacts`, `survey`에서 **그 UID의 session만** select/insert/update하도록 제한한다.
4. TD는 전시장 컴퓨터 안에만 둔 Secret/service_role key로 필요한 운영 view를 읽고 결과를 쓴다.
5. publishable key는 브라우저에 있어도 되는 공개용 키지만, service_role key는 절대 Phone Hub·GitHub·문서·QR에 넣지 않는다.

### 동의하지 않는 입장

Arrival에서 `이 기기에만 저장하고 입장합니다`를 선택할 수 있다.

- Phone Hub 화면은 로컬에서 정상 작동한다.
- 원격 Supabase 세션을 만들지 않는다.
- 로컬 분석 buffer는 다음 관객 세션에 귀속되지 않도록 분리한다.
- 즉, 작품 경험은 가능하되 내부 데이터 수집에는 참여하지 않는 흐름이다.

---

## 3. 관객 경험 및 업데이트된 UI 명세

## 3-1. 공통 시각·레이아웃 규칙 — P0 / 구현됨

| 항목 | 현행 규칙 |
| --- | --- |
| 화면 폭 | 모바일 기준 최대폭 `430px` |
| 앱 패딩 | `.app { padding: 0 25px 72px; }` |
| 색 | 배경 검정, 텍스트·선·테두리 모두 흰색 계열. 그라데이션 사용 금지. |
| 정렬 | 모든 페이지의 제목·섹션 타이틀은 중앙 정렬. 본문·긴 설명은 읽기 편하도록 좌측 정렬 유지. |
| 여백 | 화면 상·하 여백을 넉넉하게 사용. 고정 하단 action이 있을 때 본문이 가려지지 않음. |
| 버튼 | 행동 버튼은 한 줄 전체 폭. 같은 줄에 두 개를 쪼개 배치하지 않음. 두 행동이 필요하면 세로로 쌓음. |
| 도움/상세 | 기본 설명을 먼저 보이고, 자세한 설명은 `더 자세히…` disclosure에서 자발적으로 연다. |
| 헤더 | 좌측 `META ROSE / 2026`을 누르면 HOME(미등록이면 Arrival)으로 감. 우측 언어 버튼과 장미 메뉴. |
| 푸터 | 메뉴 하단 인스타그램 `@MINNIEPARK`, 앱 푸터 저작권 `© 2026 MINNIE PARK. ALL RIGHTS RESERVED.` |

## 3-2. 공통 장미 UI — P0 / 구현됨

- 실제 asset: `assets/images/rose specimen.png`
- 사용 위치: `LIVE SPECIMEN`, MY SPECIMEN, FINAL specimen, 상단 장미 메뉴 버튼
- 원본 이미지를 바꾸지 않고 세션 색을 CSS overlay(`mix-blend-mode: color`)로 입힌다.
- Live specimen에는 흰 scanline 애니메이션과 scan corner가 돈다.
- Phone Hub는 장미의 trace 값을 숫자로 설명하지 않는다. summary가 있을 때 장미의 scale·기울기·강도만 변한다.

## 3-3. 화면별 명세

### A. Arrival / 첫 화면

**목적:** 작품의 세계와 Phone Hub의 역할을 설명하고, 관객이 데이터 참여 여부와 입장 방식을 고르게 한다.

| 요소 | 현행 내용 |
| --- | --- |
| 제목 | `오늘 나는 죽인다, 나를` / `TODAY I KILL MY SELF` — `META ROSE SPECIMEN`이 첫 타이틀로 나오지 않음. |
| 비주얼 | `assets/images/arrival_hero.webp` 자리. 현재 파일이 없으면 파일명과 용도가 적힌 placeholder가 표시됨. |
| 장미 번호 | 무작위 session UUID의 앞 8자리. `ROSE NO. XXXXXXXX` |
| 본문 | 바니타스, 살아 있는 동안 자기 일부를 죽이는 질문, 선택권을 설명. |
| 상세 | “당신의 장미에 남는 것”, “당신의 속도로 보셔도 됩니다” disclosure. |
| 주요 행동 | 전체 폭 `내 장미를 만들고 입장합니다` → 원격 익명 session 생성 → 색 선택. |
| 대안 행동 | `이 기기에만 저장하고 입장합니다`은 테두리 버튼이 아니라 주요 버튼 아래의 작은 텍스트 action. |

### B. 나의 장미 색 선택 / Registration

| 항목 | 현행 규칙 |
| --- | --- |
| 제목 | `나의 장미 색을 고릅니다` |
| 색 선택 | 8개 고정 프리셋을 보여주지 않음. 브라우저의 native color palette를 직접 열어 하나의 색을 고름. |
| 미리보기 | 현재 선택색이 Live specimen에 즉시 반영됨. |
| 감정명 | 첫 입장에서 입력하지 않음. 01 이후의 감정명명으로 안내. |
| 확인 | `이 색으로 나의 장미를 만듭니다` → 화면 중앙 confirmation overlay → `이 장미로 결정합니다` |
| 고정성 | 확인 후 이번 관람의 색은 바꾸지 않는다는 안내. |

### C. HOME

순서는 아래처럼 고정한다.

```text
개인 헤더 / 나의 장미 현황
→ 프로젝트 소개: 제목 + 짧은 소개 + 프로젝트 상세 내용 버튼
→ FLOORPLAN
→ 동선 안내
→ 01~04 작품 목록
→ 감정명 action
```

#### 개인 헤더

- 작은 장미, `ROSE NO.`, 현재 감정명 또는 `아직 이름 없음`을 보여준다.
- 작품 상세에서 이 헤더를 누르면 MY SPECIMEN으로 간다.
- MY SPECIMEN의 뒤로가기는 원래 들어온 작품 상세로 돌아간다. HOME에서 들어오면 HOME으로 돌아간다.

#### Floorplan

- 실제 제1전시실의 비율·창고 노치를 반영한 `gallery-room-1-plan.webp`를 사용한다.
- 제2전시실·엘리베이터·화장실 등은 생략해 제1전시실을 중심으로 보이게 한다.
- `1 / 2 / 3 / 4` 번호와 작품명, 세션색의 작은 dot을 표시한다.
- 번호 또는 하단 작품명 행을 누르면 해당 작품 상세로 간다.
- 기본은 경량 2.5D 방식이다. 좌우 드래그는 회전, 상하 드래그는 기울기 조절이다.
- `floorplan_360_00.webp`~`35.webp`가 생기면 36프레임 실제 turntable로 자동 전환된다. 현재 이 3D frame set은 **P1**이다.
- 입구이자 출구는 `IN / OUT`으로 표시하며 Exit 화면으로 갈 수 있다.

### D. 프로젝트 상세 / ABOUT THE PROJECT

- HOME의 `프로젝트 상세 내용`에서 열리는 하나의 긴 읽기 페이지다.
- 상단 목차에서 아래 section으로 자동 스크롤한다.
- 포함 주제: 시작된 질문, 바니타스, 장미, 양가성·동시성, 선택권, 장례의 순서, 작품별 의도, Phone Hub의 위치, 관객을 대하는 작가의 위치.
- 각 section은 짧은 lead와 본문으로 시작하고, 필요 시 `더 깊이 읽기`를 열 수 있다.
- HOME으로 돌아가기와 메뉴 열기를 제공한다.

### E. 작품 상세 공통

작품 이름은 아래로 확정한다.

| station | 한글 | 영문 | 작품의 위치 |
| --- | --- | --- | --- |
| 01 | 명명 | NAMING | MAIN1 / 장미·손·악수 |
| 02 | 개입 | INTERVENTION | SUB1 / 돌봄·손상·눈 감기 캡처 |
| 03 | 목격 | WITNESS | SUB2 / 시간 지연·색 찾기 |
| 04 | 기록 | RECORD | SUB3 / 제작·아카이브 영상 |

공통 구성:

1. 작품 제목과 hero asset 자리
2. QR/NFC 태깅 전이라면 “이 작품을 시작하려면” 안내
3. 태깅 후에는 `CONNECTED`와 “지금 해야 할 것”
4. `작동법` — 기본 행동 설명은 즉시 보임
5. `더 자세히 알고 싶어요` — 단계별 상세 행동
6. `이 작품에 대하여` — 짧은 개념 설명은 즉시 보임
7. `더 자세히 알아보기` — 작품의 상세 맥락
8. 프로젝트 전체 설명의 해당 section으로 연결

#### 01 명명 / NAMING — 작동법 요약

- 한 사람이 물에 한 손을 담근다.
- 다른 손들을 이어 장미까지 사람의 사슬을 만든다.
- 마지막 사람은 남은 손으로 장미를 만진다.
- 연결이 끊기면 반응도 멈추며, 다시 연결할 수 있다.
- 작품이 내민 손이 나타날 때 악수해 장면을 남긴다.
- 작품 후 감정명을 짓는 것이 권장·핵심 흐름이다.

#### 02 개입 / INTERVENTION — 작동법 요약

- 컨트롤러의 버튼으로 화면 속 존재에 개입한다.
- 무엇을 살리고 해치는지는 직접 반응을 보며 발견한다.
- 손과 얼굴이 카메라 안에 들어오도록 한 뒤, 손·마스크가 보이면 약 2초 눈을 감는다.
- 눈을 감은 장면이 기록된다.

#### 03 목격 / WITNESS — 작동법 요약

- 흰 장미 위에 손을 가져가면 시간이 느려진다.
- 가장 느린 상태에 잠시 머문 뒤, 화면을 비스듬히 보며 자신의 색을 찾는다.
- 찾은 위치의 흰 장미를 누른다.
- 영상은 되감기지 않는다.

#### 04 기록 / RECORD — 작동법 요약

- 헤드폰을 쓰고 편한 자리에서 영상을 본다.
- 정해진 시작·끝 없이 어느 장면에서 들어오고 나가도 된다.
- 이 장소를 장미 번호와 연결하려면 안내판의 장미에 휴대폰을 대거나 QR을 스캔한다.

### F. MY SPECIMEN

- 중간 결과를 보는 개인 기록 페이지다. 분석 대시보드가 아니다.
- 현재 장미, 장미 번호, 감정명, 01~04 방문/trace 상태를 보여준다.
- `RESONANCE: HIGH`처럼 점수를 설명하지 않는다. trace가 있으면 `기록됨`만 표시한다.
- 작품 상세의 개인 헤더에서 들어왔다면, 맨 위 `01 명명으로 돌아갑니다` 같은 돌아가기 action이 나타난다.

### G. Exit + Final Reflection

1. `?station=05` 진입 시 현재 열린 station presence를 닫는다.
2. 빠진 작품이 있으면 목록과 함께:
   - `돌아가서 보기`
   - 전체 폭 `이대로 나의 장미를 완성합니다`
3. 감정명이 없으면 여기서 지을 수 있다.
4. 10개 1–10 slider를 모두 한 번씩 움직여 답한다.
5. 자유 소감은 선택 입력이다.
6. 제출 후 FINAL META ROSE SPECIMEN으로 간다.

### H. FINAL META ROSE SPECIMEN

- 최종 장미, 감정명, 장미 번호, 날짜, 01~04 기록 reference를 보인다.
- trace summary가 있다면 최종 장미의 시각 강도에만 반영한다.
- 전체 폭 `이미지로 저장`, 그 아래 `공유하기`가 세로로 배치된다.
- 결과 진입 시 session snapshot을 남기고 `sessions.status = ended`, `end_reason = survey_done`으로 마감한다.

### I. 장미 메뉴

- 메뉴 제목·항목은 정확한 화면 중앙에 정렬된다. 좌우 index/arrow는 같은 폭의 grid column으로 배치해 시각적 중심을 흐리지 않는다.
- HOME, 01~04, MY SPECIMEN, 감정명명, 프로젝트에 대하여, 언어 전환, Instagram이 있다.
- 개발 모드에서만 `?test=1`로 TEST MODE / PREVIEW가 보인다.

---

## 4. 관객 Phone Hub 데이터 — 무엇을 수집하는가

## 4-1. 데이터 흐름과 전송 시점

```text
Phone UI 행동
  → 앱 localStorage에 먼저 기록
  → [중요한 canonical 상태] 일반 offline queue
  → [분석 행동] analytics buffer
  → 안전한 checkpoint에서 Supabase events로 batch 이동
```

### 전송의 성격

| 구분 | 예시 | 전송 방식 |
| --- | --- | --- |
| Canonical 상태 | session 생성, 색, 감정명, station enter/leave, 설문, 최종 종료 | 큐에 즉시 넣고 가능한 즉시 전송. 실패하면 재시도. |
| 분석 이벤트 | 클릭, 읽기 체류, 스크롤 도달, 상세 열기, 화면별 탐색 | analytics buffer에 모은 뒤 batch. |
| 안정성 checkpoint | station leave, 감정명 저장, Exit, 최종 결과, 탭이 숨겨짐, 재연결, 2분 주기 | analytics buffer를 일반 queue로 옮기고 전송 시도. |

일반 queue는 약 8초 주기로 flush를 시도한다. analytics backup은 2분 주기다. 네트워크가 복구되거나 페이지가 background로 가는 순간에는 backoff를 무시하고 즉시 재시도한다.

**한계:** 브라우저가 강제 종료되거나 localStorage가 지워지기 전에 아직 전송되지 않은 analytics buffer 일부는 잃을 수 있다. 그래서 작품 결과·설문·감정명·station 기록은 분석 데이터와 별도로 더 이른 시점에 저장한다.

## 4-2. 관객별 canonical 데이터

| 데이터 | 저장 위치 | 값 / 범위 | 목적 |
| --- | --- | --- | --- |
| 익명 접근 UID | `sessions.auth_uid` | Supabase Anonymous Auth UUID | RLS 권한 분리. 신원 확인용 아님. |
| session ID | `sessions.id` | UUID | 모든 데이터 연결 키. |
| 장미 번호 | 화면 local state + session ID 앞 8자리 | 예: `A3F91C2B` | 관객에게 보이는 익명 표식. |
| 세션 상태 | `sessions.status`, `entered_at`, `exited_at`, `end_reason` | active / ended | 운영·세션 종료 분석. |
| 참여 선택 | `sessions.consent`, `consent_at` | boolean / timestamp | 원격 기록 참여 여부. |
| 언어 | `sessions.lang` | ko / en | 언어 사용 상황. |
| 색 | `sessions.color` | `#RRGGBB` | 작품 내 색 시그니처·최종 장미. |
| 감정명 3필드 | `sessions.final_name_a`, `final_name_b`, `final_name` | 관객이 직접 쓴 문자열 | 명명 경험 및 최종 specimen. |
| 작품 상태 | Phone local state `completed_stations`, Exit snapshot | 01~04 list | 관람 여정 및 미방문 안내. |
| 최종 snapshot | `artifacts.type = session_snapshot` | 색·이름·방문·설문·언어·완료 시각 | 전시 종료 뒤 세션 재구성용 경량 인덱스. |

`pseudonym`, `teams`, `round_no`, `ticket_type`, `ab_group`, `color_name`은 과거 스키마 호환을 위해 남아 있을 수 있지만, **현재 Phone UI는 입력하거나 사용하지 않는다.**

## 4-3. Phone Hub 이벤트 전체 목록

아래는 현재 코드가 남기는 event type 전체다. 행동이 실제로 발생한 경우에만 한 행씩 `events`에 남는다. 공통 필드는 모두 `session_id`, `station_id`, `occurred_at`, `seq`, `source = phone`, `payload`, `schema_version`이다.

### A. 여정·네비게이션·메뉴

| event type | 주요 payload | 목적 |
| --- | --- | --- |
| `session_created` | initial language | 브라우저에서 임시 Phone session이 생성된 시점. |
| `arrival_enter_clicked` | 없음 | 원격 기록 참여를 선택한 Arrival action. |
| `arrival_local_only_clicked` | 없음 | 로컬 전용 입장 선택. |
| `home_enter` | 없음 | HOME 진입. |
| `about_page_enter` | initial section | 프로젝트 상세 페이지 진입. |
| `about_anchor_selected` | section id | 상세 목차에서 어떤 주제를 선택했는지. |
| `module_page_view` | `via`, `connected` | 작품 페이지 접근 경로와 태깅 여부. |
| `floorplan_module_click` | station id, via | 지도에서 작품으로 이동. |
| `floorplan_rotate` | frame/angle/tilt | 도면을 실제로 탐색했는지. 좌표·드래그 원본은 저장하지 않음. |
| `menu_open` | current view | 장미 메뉴 사용. |
| `menu_item_selected` | item, navigation via | 메뉴의 정보 구조 사용성. |
| `language_selected` | language | 언어 전환. |
| `ui_control_click` | view, control type, class, 표시 label | 버튼·summary·link 사용. 입력 텍스트나 touch coordinate는 포함하지 않음. |

`db.js` 데이터 레이어는 위 UI event와 별도로 `session_start`, `session_end`, `survey_submit` 같은 전송 lifecycle marker도 남긴다. 최종 분석에서는 UI의 `session_created`와 DB의 `session_start`를 같은 의미의 중복 방문수로 합산하지 않고, 각각 **로컬 UI 생성**과 **원격 session 저장 lifecycle**으로 구분한다.

### B. 장미·명명·station 태깅

| event type | 주요 payload | 목적 |
| --- | --- | --- |
| `specimen_registered` | color, 색 선택 소요 시간, 색 변경 횟수 | 장미 색 확정. |
| `station_enter` | via: QR/NFC/manual | 관객 session과 station의 연결 시작. **canonical**. |
| `station_leave` | reason | 관객 session과 station의 연결 종료. **canonical**. |
| `station_name_required` | via | 감정명이 필요한 작품에 이름 없이 진입했을 때의 UX 지점. |
| `emotional_name_saved` | 감정명 3필드, 입력 과정 요약 | 관객이 직접 만든 감정명 저장. 원문은 session/artifact에도 저장됨. |
| `artifact_saved` | artifact type | naming 등의 artifact 저장 사실. |

### C. 읽기·상세 설명·몰입 관련

| event type | 주요 payload | 목적 |
| --- | --- | --- |
| `read_begin` | page key, 재열람 횟수 | 읽기 시작. 현재 Arrival과 프로젝트 상세에서 적용됨. |
| `read_depth` | 25/50/75/100% 도달 | raw scroll 값 대신 구간 도달만 저장. |
| `read_end` | dwell ms, 최대 depth, completed, chars/sec | 읽기 체류·완독 추정. |
| `*_open`, `*_close` | disclosure dwell ms | Arrival·작동법·작품 설명·프로젝트 상세의 각 disclosure 열람 시간. 예: `how_to_02_open`. |
| `phone_away_start` | 없음 | 브라우저가 hidden이 된 시점. |
| `phone_away_end` | away ms, total, station | 화면 밖에서 작품을 본 시간의 보조 지표. 위치 추적이 아님. |
| `analytics_checkpoint` | reason, event count | 내부 전송 상태를 읽기 위한 marker. |

### D. 입력·설문·종료

| event type | 주요 payload | 목적 |
| --- | --- | --- |
| `input_commit` | 첫 입력까지 시간, 전체 시간, edits, deletes, 길이, struggled | 감정명·자유 소감을 쓰는 과정의 요약. 키 입력 원문 전체는 이벤트에 넣지 않음. |
| `exit_entered` | missing module list | Exit에 왔을 때의 관람 상태. |
| `exit_continue_incomplete` | missing module list | 미방문 상태에서도 완료하기 선택. |
| `survey_completed` | 10개 응답, 자유 소감 길이, 소요 시간 | 설문 제출. 설문 원문·수치는 별도 `survey` table에도 저장. |
| `session_snapshot_saved` | snapshot version, 완료 station 수 | 최종 session index 저장. |
| `result_entered` | 없음 | FINAL specimen 도달. |
| `image_save` | 없음 | 결과 이미지 다운로드. |
| `share_complete` / `share_cancel` | 없음 | Web Share 사용 완료·취소. |

### E. 측정 모듈에 준비됐지만 현재 화면에서 아직 직접 호출하지 않는 것

`measure.js`에는 `screen_enter/screen_leave`, `detail_open/detail_close`, `rules_open/rules_close`, `choice_change/choice_commit` helper가 남아 있다. 이는 이후 특정 작품의 규칙 disclosure 또는 추가 화면을 계측할 때 사용할 수 있는 기반이다.

현재 P0 판단에서는 **실제로 호출되는 이벤트만 분석의 근거**로 사용한다. helper가 파일에 존재한다는 이유로 데이터가 이미 수집되고 있다고 가정하면 안 된다.

## 4-4. 최종 설문 — P0 / 구현됨

형식: 모든 척도 문항은 **1–10 range slider**, 자유 소감은 선택 입력(최대 600자).

| ID | 현재 문항 | 검증하려는 경험 |
| --- | --- | --- |
| `emotional_depth` | 이 전시는 내게 깊고 분명한 감정적 경험으로 남았습니다. | 감정 경험의 깊이 |
| `self_relevance` | 이 전시에서 마주한 장미 또는 장면은 지금의 나와 연결되어 있었습니다. | 자기 관련성 |
| `ambivalence` | 내 안의 서로 다른 면을 한쪽만 지우지 않고 함께 바라볼 수 있었습니다. | 양가성 수용 |
| `emotional_reframing` | 관람 전과 비교해, 내 감정을 조금 다른 방식으로 바라보게 되었습니다. | 감정 관점 변화 |
| `agency` | 무엇을 가까이 보고, 만지고, 멈출지 내가 선택하고 있다고 느꼈습니다. | 선택권·주체성 |
| `interaction_meaning` | 손과 몸으로 한 상호작용이 단순한 조작 이상으로 느껴졌습니다. | 몸의 상호작용 의미 |
| `journey_continuity` | 각 작품이 흩어진 경험이 아니라 하나의 흐름으로 이어졌습니다. | 여정 연결성 |
| `lingering` | 전시를 떠난 뒤에도 오늘의 장미 또는 이름을 다시 생각할 것 같습니다. | 잔존성 |
| `phone_hub_clarity` | Phone Hub는 다음에 무엇을 할지 이해하는 데 도움이 되었습니다. | Phone Hub 명료성 |
| `phone_hub_immersion` | Phone Hub는 작품 감상에서 나를 떼어놓기보다, 전시 안에 머물게 했습니다. | Phone Hub가 몰입에 준 영향 |

자유 소감 prompt:

```text
원한다면, 지금 남기고 싶은 마음이나 장면을 적어주세요.
```

분석 시 척도는 하나의 총점으로 무리하게 합치지 않는다. 감정 깊이, 연결성, 선택권, 상호작용 의미, Phone Hub 명료성·몰입을 서로 다른 축으로 읽는다.

---

## 5. TD 데이터 — 무엇을 수집하고 왜 수집하는가

## 5-1. TD 데이터 원칙

```text
TD interaction
  → 즉시 TD 로컬 CSV (원본)
  → TD 내부에서 작품적 의미를 계산
  → 결과가 확정된 checkpoint에서 raw event 묶음을 Supabase events에 batch 전송
  → trace_summary artifact 하나를 Supabase에 전송
  → Phone은 MY SPECIMEN / FINAL 진입 시 자기 trace_summary만 1회 읽기
```

| 하지 않는 것 | 이유 |
| --- | --- |
| TD의 매 프레임 HTTP 요청 | 프레임 저하·작품 중단 위험 |
| TD → Phone WebSocket 실시간 상태 전송 | 유지보수·네트워크 장애 지점 증가 |
| Phone에서 TD raw event polling | 관객 화면이 TD 상태의 복제본이 됨 |
| TD 원본 이미지·영상의 즉시 Supabase Storage 업로드 | 무료 Storage·전송·화질·민감 이미지 위험 |

## 5-2. TD가 Supabase에서 읽는 최소 정보

TD는 약 2초마다 service_role 권한으로 `v_active_at_station`을 읽는다. 각 TD가 필요한 값은 다음뿐이다.

| 필드 | 사용 |
| --- | --- |
| `session_id` | TD event·artifact의 관객 귀속 |
| `color` | 작품 화면의 관객 장미 색 |
| `display_name` | final_name이 있으면 감정명. 없으면 빈 값(legacy pseudonym은 현재 UI에서 쓰지 않음). |
| `is_final` | view 기준 final_name 존재 여부. 세션 종료 여부가 아님. |

Phone이 station QR/NFC를 태깅하면 `station_presence`의 열린 행이 생기고, view는 해당 station에서 가장 최근의 active session을 TD에 제공한다. 다른 관객 세션을 Phone에 노출하지 않는다.

## 5-3. MAIN1 / 01 명명 — raw 데이터 계약

| 원본 event | 필수 payload | 수집 목적 |
| --- | --- | --- |
| `rose_touch` | channel, hold_ms, polarity | 어느 장미·얼마나 오래·어떤 극성을 만졌는지. |
| `first_touch` | delay_ms | 첫 행동까지의 시간. |
| `combo_commit` | channels, positive, negative, polarity | 장미 조합이 확정된 순간. |
| `combo_change` | count, from, to | 조합의 변경 과정. |
| `circuit_break` | duration_ms | 인간사슬의 끊김. |
| `circuit_join` | total_held_ms | 회로 연결 지속 시간. |
| `reset_pressed` | count | 다시 선택한 횟수. |
| `capture_saved` | image_path, combo | 캡처 파일의 TD 로컬 경로와 조합 메타. |

결과 확정 시:

```python
checkpoint('main1_complete', summary={'resonance_trace': 0 | 1 | 2})
```

`resonance_trace`는 raw event의 어떤 조합으로 계산할지 TD 내부에서 결정한다. Phone은 계산식이나 점수값을 설명하지 않고 장미의 시각 변화만 반영한다.

## 5-4. SUB1 / 02 개입 — raw 데이터 계약

| 원본 event | 필수 payload | 수집 목적 |
| --- | --- | --- |
| `item_use` | item(water/sun/poison/monster), kind(save/kill), vitality | 돌봄·손상 행위의 종류와 당시 상태. |
| `first_item` | delay_ms, item | 첫 개입까지의 시간. |
| `respawn` | count, trauma_marks | 죽음·되살아남 이후의 흔적. |
| `ending_reached` | vitality, thorn, distance, play_ms | 작품의 엔딩 도달 상태. |
| `replay_start` | count | 재시작. |
| `replay_delta` | prev, now, changed | replay 전후 변화. |
| `eye_capture` | image_path, false_positive | 눈 감기 캡처의 TD 로컬 파일 경로와 오류 판정. |

결과 확정 시:

```python
checkpoint('ending_reached', summary={'mutation_trace': 0 | 1 | 2})
```

SUB1의 `ending_reached`는 **모듈 checkpoint**다. 전체 Phone Hub session을 종료하지 않는다.

## 5-5. SUB2 / 03 목격 — raw 데이터 계약

| 원본 event | 필수 payload | 수집 목적 |
| --- | --- | --- |
| `speed_change` | mm, speed, slow | 손으로 시간을 느리게 한 상태. |
| `slow_count` | index, style, clip | 느리게 본 장면의 누적. |
| `assigned` | style, clip, slow_clips, color_rgb | 관객 색과 장면이 배정된 결과. |
| `found` | attempts, seconds_to_find, dwell_total_s | 자기 색을 찾은 결과. |
| `missed_pass` | count | 지나간 장면·놓침. |
| `easteregg_heard` | presence, clip | 선택적 발견. |

결과 확정 시:

```python
checkpoint('found', summary={'temporal_trace': 0 | 1 | 2})
```

## 5-6. SUB3 / 04 기록 — P0 최소 / P1 확장

P0에서는 QR/NFC 태깅·Phone 상세 설명·관람 완료 상태만 우선한다. 이 모듈은 네 번째 점수를 강제하지 않는다.

P1에서 필요할 경우에만:

- 아카이브 열람·선택·저장/제출
- `record_complete` checkpoint
- `archive_trace` 또는 generic `trace`

를 추가한다. 원본 영상·이미지는 여전히 TD/운영 저장소에 보관하고 Supabase에는 경로·요약만 기록한다.

## 5-7. TD 브리지 구현 방식

`td_bridge.py`는 표준 Python 라이브러리만 사용한다.

| 기능 | 구현 |
| --- | --- |
| 원본 보호 | `push_event()`가 Supabase보다 먼저 로컬 CSV에 append + flush |
| 네트워크 분리 | worker thread가 REST 요청·재시도를 담당 |
| 전송 큐 | 최대 20,000 job. 꽉 차도 CSV가 남아 TD는 계속 동작 |
| raw batch | 기본 `EVENT_UPLOAD_MODE = checkpoint` |
| 중복 방지 | 모든 TD event에 `event_uid`, DB unique index |
| 재시도 | exponential backoff 최대 60초, `wake()` 시 즉시 재시도 |
| active session | `status = active` 및 열린 station_presence 기준. 이전 관객의 색·이름은 session이 사라지면 즉시 비움. |
| 종료 보호 | `stop()`에서 checkpoint 후 CSV close |

TD 내부에서 쓰는 최소 호출:

```python
# Execute DAT onStart
mod('td_bridge').start()

# 이벤트가 일어난 순간 — 로컬 CSV에는 즉시 남음
mod('td_bridge').push_event('rose_touch', {
    'channel': 7,
    'hold_ms': 3200,
    'polarity': 'negative',
}, scope='team')

# 작품 결과 확정 순간 — raw batch + trace summary
mod('td_bridge').checkpoint(
    'main1_complete',
    summary={'resonance_trace': 2},
)
```

### TD별 현행 상태

| TD | 상태 | 다음 검증 |
| --- | --- | --- |
| MAIN1 / 01 | **P0 / bridge 설치·Supabase REST 연결 테스트 완료** | 실제 장미 터치·조합·캡처 callback에서 `push_event()`/`checkpoint()`가 호출되는지 플레이 테스트. |
| SUB1 / 02 | **P0 / 계약 확정, 연결 전** | 삼성 노트북으로 복사 뒤 bridge 설치, item·eye capture hook, mutation trace 규칙 연결. |
| SUB2 / 03 | **P0 / 계약 확정, 연결 전** | MacBook Air 설치, speed/found hook, temporal trace 규칙 연결. |
| SUB3 / 04 | **P1** | 아카이브의 실제 상호작용 확정 후 최소 checkpoint 결정. |

---

## 6. Supabase 구현 명세

## 6-1. 현재 구성

| 항목 | 현행 |
| --- | --- |
| Project URL | `https://veeqthtxkeirphghoelk.supabase.co` |
| Browser key | publishable key만 `config.js`에 있음. 공개 정적 웹에 두어도 되는 키. |
| TD key | Secret/service_role key. TD 각 컴퓨터의 local config에만 넣음. |
| Authentication | Anonymous Sign-Ins 사용. |
| RLS | sessions / presence / events / artifacts / survey 활성화 및 owner policy 적용. |
| Schema | `supabase_schema.sql` + privacy/checkpoint migration 적용. |

## 6-2. 테이블별 역할

| 테이블 | 누가 쓰는가 | 현행 사용 | 핵심 필드 |
| --- | --- | --- | --- |
| `sessions` | Phone write/read, TD read | 관객 1명 = 1 익명 session | id, auth_uid, status, color, final_name, entered/exited_at |
| `station_presence` | Phone write, TD view read | QR/NFC로 session과 station 결합 | session_id, station_id, entered_at, left_at, via |
| `events` | Phone·TD write, 내부 분석 | 행동/원시 결과의 long table | event_uid, session_id, station_id, event_type, scope, occurred_at, seq, source, payload |
| `artifacts` | Phone·TD write, Phone own read | naming, trace_summary, session_snapshot, 파일 경로 meta | session_id, station_id, type, value, image_path, meta |
| `survey` | Phone write, 내부 분석 | 10 slider + reflection | session_id, question_id, answer, answer_num, meta |
| `teams` | 현재 미사용 | legacy / P2 | 현행 분석 대상 아님 |
| `anon_presence` | 현재 미사용 | 자동 공간 감지용 P2 | 의도적으로 session_id 없음 |

### 핵심 database view / function

| 이름 | 접근 권한 | 역할 |
| --- | --- | --- |
| `v_active_at_station` | service_role만 | TD가 현재 station의 가장 최근 active session을 읽음. |
| `v_live_count` | service_role만 | 운영용 active/total count. Phone UI에는 현재 미노출. |
| `v_returning` | service_role만 | 같은 session의 station 재방문 분석. |
| `v_naming_shift` | service_role만 | legacy naming field 비교용. 현재 pseudonym 입력 없음. |
| `v_attribution_gap` | service_role만 | TD event 중 session 귀속 실패 비율. |
| `close_stale_sessions(minutes)` | service_role만 | 운영자가 긴 미종료 session을 마감할 때 쓰는 안전망. |

### RLS를 이해하는 가장 짧은 규칙

```text
Phone browser:
  auth.uid() == sessions.auth_uid 인 row만 읽고 쓸 수 있다.

TD / 운영:
  service_role key로 제한된 내부 view를 읽고 raw/summary를 쓴다.

관객 A:
  관객 B의 emotion name, survey, trace, artifact, session을 읽을 수 없다.
```

## 6-3. Phone → Supabase 저장 매핑

| Phone 행동 | DB write |
| --- | --- |
| 원격 입장 | `sessions INSERT` + `session_start` event |
| 색 확정 | `sessions.color UPDATE` + `specimen_registered` event |
| 작품 QR/NFC | `station_presence INSERT` + `station_enter` event |
| 작품 leave / Exit | 열린 `station_presence.left_at UPDATE` + `station_leave` event |
| 감정명 저장 | `sessions.final_name_a/b/final_name UPDATE` + `artifacts.naming INSERT` + event |
| survey submit | `survey` 11행(10 scale + reflection) INSERT + event |
| FINAL 진입 | `artifacts.session_snapshot INSERT` + `sessions.status=ended` UPDATE |
| Phone 분석 행동 | `events INSERT` — analytics checkpoint 뒤 전송 |

## 6-4. TD → Supabase 저장 매핑

| TD 행동 | DB write |
| --- | --- |
| 모든 raw interaction | TD local CSV 즉시 기록. checkpoint 시 `events` batch INSERT. |
| TD checkpoint | `events.event_type = td_checkpoint` |
| trace 결과 | `artifacts.type = trace_summary`, `meta = {resonance_trace / mutation_trace / temporal_trace}` |
| 캡처 결과 | `events`에 `image_path`; 필요시 `artifacts`에도 local path/meta. 원본 file 자체는 올리지 않음. |

## 6-5. `events` 테이블을 나중에 읽는 법

`events`는 모든 행동을 하나의 긴 table에 저장한다. 새 작품 event가 생겨도 schema를 매번 바꾸지 않고 `event_type`과 `payload JSONB`로 확장한다.

나중 분석의 기본 축:

```text
session_id     : 한 관객의 전체 여정
station_id     : 어느 작품에서 일어났는지
occurred_at    : 행동이 실제 일어난 순서·간격
source         : phone / td_main1 / td_sub1 / td_sub2
scope          : individual / team / anonymous
event_type     : 행동의 종류
payload        : 작품 특유의 세부값
```

`created_at`은 전송·서버 기록 시각이며, 분석의 체류·순서에는 `occurred_at`을 사용한다.

---

## 7. Phone과 TD가 만나는 결과 계약

## 7-1. trace summary contract — P0

| station | artifact type | `meta` 예시 | Phone에서의 사용 |
| --- | --- | --- | --- |
| 01 | `trace_summary` | `{ "resonance_trace": 2 }` | MY/FINAL 장미 intensity |
| 02 | `trace_summary` | `{ "mutation_trace": 1 }` | MY/FINAL 장미 intensity |
| 03 | `trace_summary` | `{ "temporal_trace": 2 }` | MY/FINAL 장미 intensity |
| 04 | `trace_summary` | `{ "archive_trace": 1 }` 또는 `{ "trace": 1 }` | P1. 현재 강제하지 않음. |

규칙:

- 값은 `0`, `1`, `2`만 사용한다. `low/mid/high`를 쓰려면 TD와 Phone normaliser를 함께 바꾼다.
- 같은 station에서 여러 checkpoint가 있으면 Phone은 가장 최근 `occurred_at`의 summary 하나만 사용한다.
- Phone은 MY SPECIMEN과 FINAL 화면을 열 때 자기 `artifacts`를 한 번 읽는다. 지속 polling하지 않는다.
- 관객 화면에는 숫자·점수·원시 계산값을 보이지 않는다.

## 7-2. 이미지·영상 계약

| 항목 | P0 현행 | P1 이후 검토 |
| --- | --- | --- |
| TD capture 원본 | TD 로컬 disk | 필요 시 운영 storage 백업 |
| Supabase `artifacts.image_path` | 로컬 경로·파일 식별자만 | path 관리 규칙 강화 |
| Phone에서 capture 보기 | placeholder/reference UI만 | Storage signed URL을 통한 자기 결과 보기 |
| 동영상 | 업로드하지 않음 | 전시 후 선택적 저용량 derivative만 검토 |

이 분리는 화질을 일부러 낮추기 위한 것이 아니다. 전시 3일 동안 **원본 화질·전송 지연·무료 Storage 용량·민감 이미지 처리**를 Phone Hub의 안정성에서 분리하기 위한 결정이다.

---

## 8. 안정성·장애 대응·운영

## 8-1. graceful degradation

| 장애 | 관객 경험 | 데이터 처리 |
| --- | --- | --- |
| Supabase 접속 실패 | Phone Hub UI는 local mode로 계속 진행 | browser queue에 보관, 다음 연결 때 재시도 |
| Phone 네트워크 끊김 | 작품 경험 계속 | localStorage queue에 보관 |
| TD 네트워크 실패 | TD 작품은 영향 없이 계속 | CSV 원본 보관, worker retry |
| TD worker queue 포화 | TD 작품 계속 | 추가 cloud job은 못 넣어도 CSV 원본이 남음 |
| Phone이 꺼짐 | 물리 작품은 계속 | 마지막 미전송 analytics 일부 손실 가능 |
| TD 재시작 | 작품 재시작 | `stop()` checkpoint와 CSV close 후 재연결 |
| 관객이 Exit를 안 찍음 | 작품은 끝남 | 운영자가 `close_stale_sessions()`로 stale session 마감 가능 |

## 8-2. 전시 전 필수 점검

### Phone Hub

- [ ] `config.js`에는 Project URL + publishable key만 있다. service_role key가 없다.
- [ ] Supabase Authentication에서 Anonymous Sign-In이 활성화돼 있다.
- [ ] `?station=00`~`?station=05` URL이 각각 올바른 화면으로 간다.
- [ ] `?test=1`에서 TAGGED 01~04, EXIT, FINAL이 보인다.
- [ ] 색 선택 → confirmation → HOME → 01 → 감정명 → 02/03 → Exit → 설문 → Final 한 바퀴 테스트.
- [ ] 다른 private browser/incognito에서 새 session이 생기고 기존 session이 보이지 않는지 확인.
- [ ] `assets/images/rose specimen.png`가 Live specimen·메뉴에 보이는지 확인.
- [ ] Arrival/모듈/result hero placeholder는 실제 이미지를 넣을지, placeholder 상태로 둘지 결정.

### Supabase

- [ ] `sessions`, `station_presence`, `events`, `artifacts`, `survey` table이 존재.
- [ ] session 생성 후 `auth_uid`가 채워짐.
- [ ] station enter/leave, 색, 감정명, 설문 row가 Table Editor에 보임.
- [ ] 다른 브라우저 anonymous user가 기존 session을 읽지 못함.
- [ ] `v_active_at_station`은 service_role TD에서만 읽힘.

### 각 TD

- [ ] TD 파일은 iCloud/Google Drive sync 폴더가 아니라 각 컴퓨터의 로컬 drive에서 실행.
- [ ] `~/fringe2026_logs` 또는 지정 CSV folder가 실제 쓰기 가능.
- [ ] `configuration_status()`에서 module, station, Supabase true 확인.
- [ ] TD Secret key는 TD local config에만 존재.
- [ ] station QR을 태깅한 뒤 `active()['session_id']`가 채워짐.
- [ ] 실제 한 플레이에서 raw CSV와 `events` checkpoint, `trace_summary`가 모두 남음.
- [ ] TD를 껐다 켜도 이전 관객의 color/display_name이 남지 않음.

## 8-3. 전시 중 운영 루틴

| 시점 | 해야 할 일 |
| --- | --- |
| 전시 시작 전 | 각 TD bridge status / Internet / QR 1회 점검. |
| 각 모듈 첫 테스트 | station 태깅 → TD active session → event/CSV 한 건을 확인. |
| 네트워크 이상 | 작품을 멈추지 않음. TD CSV와 Phone queue를 우선 유지. |
| 관객 종료 | Exit QR 안내. 강제하지 않고, 필요한 경우 현재 장미 완성 선택을 제공. |
| 하루 종료 | 각 TD의 CSV folder를 별도 저장소에 복사. Supabase tables CSV export. |
| 전시 종료 | Supabase `sessions/events/artifacts/survey/station_presence` export. 필요한 경우 stale session close 후 export. |

---

## 9. P1/P2 보류 항목

| 항목 | 상태 | 보류 이유 |
| --- | --- | --- |
| TD 원본 이미지·영상 Storage 업로드 | P1 | 용량, 전송, 화질, 민감 이미지, 운영 검증 필요 |
| Phone에서 실제 capture 보여주기 | P1 | Storage 결정과 함께 진행 |
| 36-frame 실제 3D floorplan turntable | P1 | render asset 준비 필요. 현재 2.5D fallback 사용 가능 |
| SUB3 record trace | P1 | 작품 상호작용과 결과 규칙 확정 후 결정 |
| 운영자 live dashboard | P1 | 관객 UI에 필요하지 않음 |
| 팀·round·동반 관객 매칭 | P2 | 현행 개인 session·익명성 구조에 불필요 |
| 실시간 혼잡도/대기열 표시 | P2 | 운영 위험과 작품 리듬을 고려해 관객 UI에서 제거 |
| 자동 위치 감지·자동 태깅 | P2 | 개인정보·오탐·운영 난이도 |
| Phone ↔ TD live frame/WebSocket | P2 | 안정성 원칙 위반 |
| 다른 관객 결과·메시지·공개 feed | P2 | 관객 간 데이터 분리 원칙 위반 |
| LLM 해석·감정 추천 | P2 | 감정명은 관객의 언어여야 함 |

---

## 10. 파일 지도와 수정 위치

| 파일 | 역할 |
| --- | --- |
| `app.js` | 화면 흐름, UI, session local state, QR route, trace 표시, 설문 |
| `styles.css` | 전 페이지 UI 규칙, 레이아웃, floorplan, specimen scan |
| `db.js` | Anonymous Auth, RLS 경유 DB write/read, offline queue, analytics buffer |
| `measure.js` | 읽기·visibility·입력 측정 helper |
| `config.js` | Project URL, publishable key, station 정의, queue interval |
| `supabase_schema.sql` | 첫 Supabase 구축 SQL |
| `supabase_migration_20260812_private_sessions.sql` | Auth UID·RLS·TD checkpoint privacy migration |
| `td_bridge.py` | TD 공통 Supabase/CSV bridge 원본 |
| `TD_DATA_CHECKPOINT_CONTRACT_V1.md` | TD별 raw event·summary 계약 |
| `assets/images/rose specimen.png` | Live specimen·메뉴 장미 원본 |
| `ASSET_FILENAMES.md` | Arrival/module/result/floorplan asset 파일명 규칙 |
| `FINAL_REFLECTION_SURVEY_CANDIDATES_V1.md` | 전시용 설문 후보·검토용 |
| `FINAL_REFLECTION_SURVEY_BANK_100_V1.md` | 향후 설문 후보 100개·분석 근거 |
| `PHONE_HUB_CURRENT_DELTA_FROM_HANDOVER_20260812.md` | 이전 핸드오버와 현행 구조의 차이 기록 |

### 실제 asset 파일명

```text
assets/images/rose specimen.png                    # 현재 존재 / 사용 중
assets/images/arrival_hero.webp                    # P0 교체 대기
assets/images/module_01_naming_hero.webp           # P0 교체 대기
assets/images/module_02_reenactment_hero.webp      # P0 교체 대기
assets/images/module_03_mourning_hero.webp         # P0 교체 대기
assets/images/module_04_archive_hero.webp          # P0 교체 대기
assets/images/result_01_naming_capture.webp        # P1 또는 placeholder
assets/images/result_02_reenactment_capture.webp   # P1 또는 placeholder
assets/images/result_03_mourning_capture.webp      # P1 또는 placeholder
assets/images/result_04_archive_reference.webp     # P1 또는 placeholder
```

파일이 없을 때 app은 멈추지 않고, 어떤 이미지가 필요한지 이름과 용도가 적힌 placeholder를 표시한다.

---

## 11. 배포 기준

### GitHub Pages

저장소:

```text
/Users/minniepark/Desktop/dev/metarose-funeral
```

배포 절차:

```text
변경 확인 → git commit → VS Code Source Control의 Sync Changes → GitHub Pages 반영 확인
```

GitHub authentication이 터미널에 연결돼 있지 않을 수 있으므로, 현행 운영에서는 VS Code의 `Sync Changes`가 가장 안전한 push 경로다.

### iCloud 작업 폴더

```text
/Users/minniepark/Library/Mobile Documents/com~apple~CloudDocs/
2026 ART/META ROSE26_THE FUNERAL/WEB
```

- 웹 문서는 iCloud에 보관 가능하다.
- 단, TouchDesigner `.toe`와 TD 실행 파일은 iCloud/Google Drive 동기화 폴더에서 직접 실행하지 않는다.
- TD는 각 전시 컴퓨터의 로컬 폴더에서 실행하고, 원본 `.toe`는 복제본으로 작업한다.

---

## 12. 변경 이력

### v2 / 2026-08-12

- 가명 입력·팀/round·실시간 혼잡도·Phone capture upload 중심의 초기 설계를 현행 구조에서 분리.
- “Phone Hub는 TD 실시간 대시보드가 아니다”를 최상위 원칙으로 고정.
- Anonymous Auth + RLS 기반의 관객 간 session 분리 반영.
- TD local CSV → checkpoint batch → trace summary 구조 반영.
- Exit 설문 완료만 전체 session 종료로 통일.
- 10개 1–10 설문 + 선택 자유 소감 반영.
- 명명·개입·목격·기록 작품명 확정.
- 현행 UI: 25px padding, white-only, no gradients, 중앙 타이틀, 단일 full-width action, native color picker, 실제 rose specimen PNG, HOME 정보 순서, floorplan 명칭·링크, 상세 작동법·작품 설명, MY SPECIMEN return path 반영.

---

## 13. 다음 작업의 우선순위

1. **GitHub Pages 최신 커밋 Sync** — 최신 UI를 공개 URL에 반영.
2. **MAIN1 실제 플레이 callback 검증** — CSV + events + resonance trace까지 한 관객 session으로 확인.
3. **SUB1 bridge 설치와 mutation trace** — 삼성 로컬 drive에서 실행.
4. **SUB2 bridge 설치와 temporal trace** — MacBook Air 로컬 drive에서 실행.
5. **전 모듈 통합 리허설** — QR 00→01→name→02/03→04→05→survey→final.
6. **필요한 hero asset만 배치** — placeholder가 의도와 다르면 파일명 규칙대로 넣기.
7. **전시 전날 백업·네트워크 장애 리허설** — TD CSV와 Phone offline queue가 남는지 확인.

이 순서에서 이미지·영상 Storage·3D floorplan·대시보드는 P0 리허설이 안정된 뒤에만 판단한다.
