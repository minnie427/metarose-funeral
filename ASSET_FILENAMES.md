# META ROSE Phone Hub — 이미지 파일명

아래 경로와 파일명을 그대로 사용하면 Phone Hub가 자동으로 이미지를 불러온다.

## 기본 이미지

```text
assets/images/arrival_hero.webp
assets/images/module_01_naming_hero.webp
assets/images/module_02_reenactment_hero.webp
assets/images/module_03_mourning_hero.webp
assets/images/module_04_archive_hero.webp
assets/images/result_01_naming_capture.webp
assets/images/result_02_reenactment_capture.webp
assets/images/result_03_mourning_capture.webp
assets/images/result_04_archive_reference.webp
```

## 360° Floorplan

현재 기본 HOME 플로어플랜은 실측 치수 비율과 창고 노치를 반영한 제1전시실의
ㄱ자형 고해상도 WebP 렌더를 사용한다.

이 기본 2D 도면은 원근·가변 기울기·낮은 벽·두께 그림자를 더한 경량 2.5D 방식이다.
좌우 드래그로 0–359° 회전하고 상하 드래그로 18–68° 기울기를 조절할 수 있다.
벽은 140px 높이의 건축 모형 비율로 표시하고, 지도 위 작품 표시는 벽보다 위에 띄운
`1`, `2`, `3`, `4`와 작은 session color 점만 사용한다. 상단 개구부는 공동
`ENTRANCE / EXIT`, 오른쪽은 제2전시실로 이어지는 `ROOM 2 / PASSAGE`로 표시한다.
상단과 창고의 문짝·문 회전 반경 표시는 사용하지 않는다.

```text
assets/floorplan/gallery-room-1-plan.webp
assets/floorplan/gallery-room-1-plan.png
assets/floorplan/gallery-room-1-plan.svg
```

- `webp`: Phone Hub 실제 기본 이미지
- `png`: 고해상도 확인·출력용 렌더
- `svg`: 수정 가능한 원본 도면

작품 위치 매핑:

```text
01 NAMING       = MAIN 1
02 RE-ENACTMENT = SUB 1
03 MOURNING     = SUB 2
04 ARCHIVE      = SUB 3 VIDEO
INFO TABLE      = 안내 지점 (클릭 없음)
```

화장실·엘리베이터·제2전시실·공용부는 모두 생략한다. 창고는 제1전시실의 실제
돌출 구조를 설명하는 데 필요한 만큼만 흐린 맥락으로 남긴다. 입구, 기둥,
이동식 가벽, INFO TABLE과 작품 위치를 표시한다.

### P2 — 3D 360° 렌더 업그레이드

입체적인 3D 회전이 필요할 때만 10도 간격의 36프레임 turntable render를 추가한다.
프레임이 없거나 로드에 실패하면 현재 2D 회전 도면이 자동 fallback으로 유지된다.

```text
assets/floorplan/floorplan_360_00.webp
assets/floorplan/floorplan_360_01.webp
assets/floorplan/floorplan_360_02.webp
...
assets/floorplan/floorplan_360_35.webp
```

- 모든 프레임은 같은 크기와 카메라 높이를 사용한다.
- 투명 배경 WebP 권장.
- 프레임 번호는 반드시 두 자리로 저장한다.
- `00`은 HOME 진입 시 보이는 기본 정렬이다.

## 테스트 화면

로컬 서버 URL 뒤에 `?test=1`을 붙인다.

```text
http://127.0.0.1:8765/?test=1
```

HOME 하단의 `개발용 화면 / DEVELOPMENT PREVIEW` 또는 장미 메뉴 하단
`TEST MODE / PREVIEW`에서 다음 화면을 바로 열 수 있다.

```text
TAGGED 01
TAGGED 02
TAGGED 03
EXIT
FINAL
```
