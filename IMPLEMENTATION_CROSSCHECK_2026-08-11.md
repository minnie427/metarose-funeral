# META ROSE SPECIMEN Phone Hub — 구현 크로스체크

> 기준 문서: `폰허브_MASTER.md`  
> 점검 대상: 2026-08-11 현재 `WEB` 프로젝트  
> 범례: **완료** / **부분** / **미구현** / **보류(P1·P2)**

## 0. 결론

현재 프로젝트는 **모바일 화면과 관객 동선 확인용 프로토타입으로는 상당 부분 완성**되었다. Arrival부터 Registration, Home, 네 개 작품 페이지, My Specimen, Exit, Final 화면을 모두 브라우저에서 확인할 수 있다.

그러나 **실제 전시 운영용 전체 시스템이 완료된 상태는 아니다.** 현재 화면을 구동하는 `app.js`는 `db.js`, `measure.js`, `config.js`, `content.js`를 불러오지 않는다. 따라서 파일로 준비된 Supabase·오프라인 큐·측정 코드와 현재 UI가 연결되어 있지 않으며, TD 캡처 결과도 폰으로 전달되지 않는다.

전시 전에 반드시 끝낼 핵심은 다음 네 묶음이다.

1. 현재 UI와 Supabase 세션·이벤트·artifact 저장 연결
2. TD별 캡처 및 summary 결과를 Supabase를 통해 Phone Hub에 전달
3. 명세와 다른 색상 선택·설문·Final Specimen을 확정 사양으로 수정
4. 실제 URL 배포 후 QR/NFC 및 네트워크 장애 리허설

---

## 1. 이번 점검에서 바로 완료한 항목

### 실측 플로어플랜

- **완료** 제1전시실의 창고 돌출부를 포함한 실제 L자형 평면 반영
- **완료** 입구, 문, 기둥, 가벽 및 작품 위치 반영
- **완료** 화장실·엘리베이터 영역을 시각적으로 생략하고 제1전시실 중심으로 정리
- **완료** `MAIN 1`, `SUB 1`, `SUB 2`, `SUB 3 VIDEO`, `INFO TABLE`, `EXIT` 표시
- **완료** 도면의 작품 버튼을 누르면 해당 작품 페이지로 이동
- **완료** 3D 렌더 이미지가 없어도 현재 2D 도면을 원근·가변 기울기·낮은 벽이 있는 경량 2.5D 방식으로 회전
- **완료** 좌우 드래그로 0–359° 회전, 상하 드래그로 18–68° 기울기 조절
- **완료** 지도 위 작품 표시는 `1`, `2`, `3`, `4`로 단순화
- **완료** 회전 후에도 작품 버튼과 EXIT 버튼이 도면 위치를 따라 회전하며 클릭 가능
- **완료** 향후 36프레임 3D 렌더가 들어오면 `floorplan_360_00.webp`–`35.webp`를 자동 사용

---

## 2. 전체 Experience Architecture

| 명세 | 현재 상태 | 판정 | 남은 작업 |
|---|---|---:|---|
| 익명 세션 생성 및 같은 휴대폰에서 복구 | `localStorage`로 동작 | **부분** | Supabase의 canonical session과 연결 |
| Arrival → Registration → Home | 브라우저에서 동작 | **완료** | 실제 문구 최종 교정만 필요 |
| QR/NFC 태깅으로 작품 진입 | `?station=01`–`04` 처리 존재 | **부분** | 실제 배포 URL QR/NFC 제작·현장 테스트 |
| 작품 방문 상태 추적 | 현재 브라우저 안에서 기록 | **부분** | Supabase `station_presence`, `events` 연결 |
| My Specimen 중간 결과 | 화면 및 모듈별 방문 상태 표시 | **완료(화면)** | 실제 TD trace/artifact 반영 필요 |
| Exit에서 미방문 작품 확인 | 확인·돌아가기·건너뛰기 동작 | **완료(화면)** | 서버 session 종료 연결 필요 |
| Final Specimen 생성·공유 | 화면, 저장, Web Share 진입 존재 | **부분** | 실제 artifact·polarity·journey 데이터 반영 |
| KO/EN | 전환 동작 | **완료** | 전체 실제 문구 번역 QA 필요 |

---

## 3. Visual Direction / 공통 UI

| 확정 사항 | 현재 상태 | 판정 |
|---|---|---:|
| 검정 배경, 흰색 텍스트와 선 | 반영됨 | **완료** |
| 배경 그라데이션 금지 | 현재 주요 화면에 없음 | **완료** |
| 타이틀 중앙 정렬, 바디 왼쪽 정렬 | 반영됨 | **완료** |
| 공통 헤더 제목 클릭 시 Home | 동작함 | **완료** |
| 버튼 중앙 정렬 및 일관된 스타일 | 주요 CTA 반영됨 | **완료** |
| 메뉴 하단 Instagram과 copyright | `@minniepark` URL과 copyright 반영 | **완료** |
| 이미지 placeholder에 실제 파일명 표시 | 반영됨 | **완료** |
| Registration 확인 모달 화면 중앙 | 반영됨 | **완료** |
| 상세 페이지 타이틀 크기 축소 | 반영됨 | **완료** |

---

## 4. Screen-by-Screen

### 4.1 Arrival

- **완료** Arrival 전용 이미지 placeholder와 파일명
- **완료** 세션 번호 및 입장 CTA
- **완료** Registration의 장미 이미지와 중복되지 않는 구조
- **부분** 마스터 문서의 상세 안내·동의·데이터 고지 항목은 아직 충분하지 않음

### 4.2 Registration

- **완료** nickname, 장미 색, 감정명명 안내, 장미 선택 확인
- **완료** 감정명명을 nickname과 동등 이상으로 강조한 섹션
- **미구현(P0)** 마스터 문서는 8–12개의 이산형 palette를 확정하고 자유 color wheel을 금지함. 현재는 연속형 color input 사용
- **부분** “본명이 아닌 가명”이라는 의미는 있으나 확정 문구와 최종 교정 필요

### 4.3 Home / Floorplan

- **완료** 실측 제1전시실 도면
- **완료** 손가락 360° 2.5D 회전 및 회전 각도 표시
- **완료** 작품 버튼, 방문 상태, 프로젝트 소개 → 더보기 순서
- **완료** `?test=1`에서 TAGGED 01/02/03, EXIT, FINAL 개발용 진입 버튼
- **부분(P2)** 36프레임 3D 렌더 자체는 아직 없음. 현재 2D 회전판을 실제 전시 fallback으로 사용 가능

### 4.4 작품별 페이지

- **완료(화면)** 01 NAMING, 02 RE-ENACTMENT, 03 MOURNING, 04 ARCHIVE 페이지
- **완료** 태깅 전/후 문구를 test mode에서 확인 가능
- **완료** My Specimen에서 이전 작품으로 돌아가기
- **부분** 작품 설명과 도움말은 기본 구조만 있음
- **미구현(P0)** TD 캡처 요청, 처리 중, 결과 수신, 재촬영, 결과 carousel

### 4.5 My Specimen

- **완료(화면)** 장미, specimen number, nickname/감정명, 현재 방문 trace
- **완료** 수치 점수를 관객에게 직접 보여주지 않음
- **부분** 현재 trace는 브라우저 방문 상태 중심이며 TD의 `resonance_trace`, `mutation_trace`, `temporal_trace` summary가 연결되지 않음

### 4.6 Exit / Final Reflection

- **완료(화면)** 미방문 작품 표시, 돌아가기, 이대로 완성하기
- **완료** 감정명명 3개 입력 구조
- **부분(P0)** 설문은 현재 유사도 1개 scale 중심. 마스터의 필수 자유응답 + scale 4개 + 선택형 1개가 필요
- **부분(P0)** session 종료가 local state에만 반영되고 Supabase canonical 종료와 연결되지 않음

### 4.7 Final Specimen

- **완료(화면)** 최종 결과 화면, 이미지 저장, 공유 진입
- **미구현(P0)** 실제 TD raw screenshot/artifact
- **미구현(P0)** polarity ratio
- **미구현(P0)** 실제 journey log 기반 방문 목록
- **부분** 지금은 결과 placeholder로 전체 레이아웃만 확인 가능

---

## 5. Interaction / Data Contract

### 준비된 파일

- `supabase_schema.sql`: sessions, station presence, events, artifacts, survey 및 운영 view/function
- `db.js`: Supabase 요청과 local queue를 위한 코드
- `td_bridge.py`: TD 이벤트의 로컬 CSV fallback, Supabase 전송, 현재 station 조회 구조
- `measure.js`: 이벤트 측정용 코드

`measure.js`는 현재 `CONFIG.MEASURE`를 참조하지만 `config.js`에는 해당 설정이 없으므로, UI에 연결하기 전에 설정 계약도 함께 정리해야 한다.

### 실제 연결 상태

| 계약 | 현재 상태 | 판정 |
|---|---|---:|
| Phone → Supabase session | 현재 `app.js`가 `db.js`를 import하지 않음 | **미구현(P0)** |
| Phone → Supabase event | localStorage 이벤트만 기록 | **미구현(P0)** |
| Phone → station enter/leave | local state만 변경 | **미구현(P0)** |
| TD → Supabase raw log | bridge 골격 존재, 실제 TD 프로젝트에 미삽입 | **부분(P0)** |
| TD → artifact/trace summary | 계약 파일은 있으나 실제 결과 전송 미연결 | **미구현(P0)** |
| Supabase → Phone artifact | 현재 화면에서 조회하지 않음 | **미구현(P0)** |
| survey 저장 | UI와 Supabase 미연결 | **미구현(P0)** |
| offline queue | `db.js`에는 있으나 현재 UI가 사용하지 않음 | **부분(P0)** |
| realtime raw TD polling 금지 | 현재 UI가 raw TD 값을 실시간 복제하지 않음 | **원칙 준수** |

### 반드시 유지할 안정성 원칙

- Phone Hub는 TD 실시간 대시보드가 아니다.
- TD는 raw interaction을 자기 쪽에서 계산·저장하고 Phone에는 필요한 결과만 전달한다.
- Phone과 TD는 직접 WebSocket으로 연결하지 않고 Supabase를 중간 backbone으로 사용한다.
- 네트워크 실패가 작품 프레임이나 Phone UI를 멈추게 해서는 안 된다.
- TD는 먼저 로컬 CSV에 기록하고, 네트워크 전송은 비동기로 처리한다.
- Phone은 실패한 요청을 local queue에 남기고 재시도한다.

---

## 6. 모듈별 결과 계약

| 모듈 | Phone 화면 | TD 결과 계약 | 현재 판정 |
|---|---:|---|---:|
| MAIN 1 / NAMING | 있음 | `resonance_trace` + 필요한 캡처 | **부분** |
| SUB 1 / RE-ENACTMENT | 있음 | `mutation_trace` + ending artifact | **부분** |
| SUB 2 / MOURNING | 있음 | `temporal_trace` + 2인 screenshot | **부분** |
| SUB 3 / ARCHIVE | 있음 | 방문 및 영상 관련 summary | **부분** |

각 trace는 raw interaction 전체가 아니라 TD 내부에서 종합한 단일 요약값으로 전송한다. MVP에서는 `0/1/2` 또는 `low/mid/high` 중 하나로 통일하면 된다.

---

## 7. 전시 전 개발 우선순위

### P0 — 실제 운영 전에 반드시 완료

1. `app.js`를 `config.js`·`db.js`와 연결하고 Supabase URL/key 설정
2. session 생성·복구·station enter/leave·exit·survey·artifact 조회를 실제 DB에 연결
3. local queue를 현재 UI 흐름에 연결하고 비행기 모드/복구 테스트
4. Registration의 연속 color wheel을 확정 palette 버튼으로 교체
5. 개인정보·촬영·보관·삭제 관련 최소 동의 문구 확정
6. 마스터 설문 구조로 수정
7. MAIN 1, SUB 1, SUB 2, SUB 3의 TD bridge 삽입 및 각 summary/artifact 저장
8. Final Specimen에 실제 캡처·polarity·journey 데이터 반영
9. 실제 URL 배포, Supabase 허용 설정, QR/NFC 최종 제작
10. 휴대폰 2대 이상 + TD 4대 + 현장 Wi-Fi로 전체 동선 리허설

### P1 — 핵심 운영 이후 추가

- 작품 도움말의 세부 규칙과 ending condition
- live congestion
- 측정 이벤트 전체 연결 및 운영 대시보드
- 결과 carousel과 재촬영 UX 정교화
- 영문 전체 카피 감수

### P2 — 전시 안정성을 해치지 않을 때만

- 36프레임 3D floorplan turntable 렌더
- 고급 분석과 A/B 관련 기능
- 추가 애니메이션 및 비필수 미세 인터랙션

자동 감지 및 A/B 기능은 현재 마스터 범위에서 제외된 상태를 유지한다.

---

## 8. 현재 바로 테스트 가능한 경로

- 일반 진입: `/`
- 개발 모드: `/?test=1`
- Station QR simulation: `/?station=01`, `02`, `03`, `04`
- Home 개발 버튼: `TAGGED 01`, `TAGGED 02`, `TAGGED 03`, `EXIT`, `FINAL`

## 9. 최종 판정

**UI/UX 프로토타입:** 사용 가능  
**실측 플로어플랜:** 사용 가능, 2D 360° 회전 가능  
**현장용 Phone Hub 전체 시스템:** 아직 미완성  
**가장 큰 blocker:** 현재 UI와 Supabase·TD bridge·artifact pipeline의 실제 연결

이 문서는 화면이 보인다는 이유만으로 backend/data 항목을 완료 처리하지 않는다. P0 항목의 실제 저장·복구·TD 연동·현장 네트워크 테스트가 끝난 뒤에만 전시 운영 완료로 판정한다.
