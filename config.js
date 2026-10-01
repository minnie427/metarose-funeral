export const PUBLIC_TITLE = 'The Meta Rose: Shared Resonance';

export const CONFIG = {
  APP_BASE_URL: '',
  SUPABASE_URL: 'https://veeqthtxkeirphghoelk.supabase.co',
  // 이름은 legacy지만, 현재 Supabase의 publishable key를 넣는다.
  SUPABASE_ANON_KEY: 'sb_publishable_kZWUVks4jhb9VJk7nJpTbg_anm5yBIT',

  EXHIBITION: {
    id: 'meta-rose-melbourne-2026',
    title: PUBLIC_TITLE,
    titleEn: PUBLIC_TITLE,
    series: 'Melbourne Fringe Festival 2026',
    venue: 'The Mission to Seafarers Victoria',
    // Public dates and exact room are added only after the Melbourne on-site check.
    dates: [],
    timeZone: 'Australia/Melbourne',
    defaultLanguage: 'en',
    instagram: '',
  },

  // Melbourne installation positions and access directions confirmed on site.
  // Percent coordinates remain editable here if the physical layout changes.
  VENUE_LAYOUT: {
    footprint: 'rectangle',
    positionsConfirmed: true,
    provisionalWorks: {
      '01': { x: 12, y: 50, wall: 'west' },
      '02': { x: 77, y: 40, wall: 'east' },
      '03': { x: 42, y: 19, wall: 'north' },
      '04': { x: 90, y: 87, wall: 'south-east' },
    },
    // One doorway serves as both entrance and exit. The ramp is at this door.
    // Outside the door, the courtyard is immediately left; toilets are reached
    // by turning right and asking venue staff after entering the internal area.
    provisionalAccessPreview: {
      entryExit: { x: 65, y: 101, labelKo: '입구 / 출구 · 피드백', labelEn: 'ENTRY / EXIT · FEEDBACK' },
      roseInstallation: { x: 29, y: 50, labelKo: '장미 설치', labelEn: 'ROSE INSTALLATION' },
      routePoints: [
        { x: 12, y: 50 },
        { x: 77, y: 40 },
        { x: 42, y: 19 },
        { x: 90, y: 87 },
      ],
      toiletRoutePoints: [
        { x: 50, y: 52 },
        { x: 50, y: 88 },
        { x: 65, y: 88 },
        { x: 65, y: 104 },
        { x: 65, y: 117 },
        { x: 96, y: 117 },
      ],
      courtyardRoutePoints: [
        { x: 50, y: 52 },
        { x: 50, y: 88 },
        { x: 65, y: 88 },
        { x: 65, y: 104 },
        { x: 65, y: 117 },
        { x: 7, y: 117 },
      ],
      toilet: { x: 96, y: 117, labelKo: '홀 안으로 들어가 스태프에게 문의', labelEn: 'GO INSIDE HALL · ASK STAFF' },
      courtyard: { x: 7, y: 117, labelKo: '코트야드 · 테이블 / 의자', labelEn: 'COURTYARD · TABLES / CHAIRS' },
    },
    works: {
      '01': { x: 12, y: 50, wall: 'west' },
      '02': { x: 77, y: 40, wall: 'east' },
      '03': { x: 42, y: 19, wall: 'north' },
      '04': { x: 90, y: 87, wall: 'south-east' },
    },
    entryExit: { ko: '하나의 문을 입구와 출구로 함께 사용합니다.', en: 'The same doorway is used for entry and exit.' },
    stepFreeEntrance: { ko: '입구와 출구에 휠체어용 램프가 있습니다.', en: 'A wheelchair ramp is located at the entrance and exit.' },
    accessibleRoute: { ko: '램프를 통해 전시실로 이동할 수 있습니다.', en: 'The ramp provides the route into the exhibition room.' },
    accessibleToilet: { ko: '출입구로 나가 오른쪽으로 간 뒤, 내부에서 스태프에게 물어보는 것이 가장 빠릅니다.', en: 'Exit, turn right and enter the internal area. Ask venue staff for the quickest toilet direction.' },
    quietSpace: { ko: '출입구로 나가 왼쪽의 코트야드에 테이블과 의자가 있어 잠시 쉬어갈 수 있습니다.', en: 'The courtyard immediately left of the exit has tables and chairs where you may pause.' },
  },

  RESULT_OBSERVATION_MINUTES: 10,

  STATIONS: {
    '00': { key: 'arrival', name: 'ARRIVAL', screen: 'arrival' },
    '01': { key: 'main1', name: '01 명명 / NAMING', screen: 'main1' },
    '02': { key: 'sub1', name: '02 개입 / INTERVENTION', screen: 'sub1' },
    '03': { key: 'sub2', name: '03 목격 / WITNESS', screen: 'sub2' },
    '04': { key: 'archive', name: '04 기록 / RECORD', screen: 'archive' },
    '05': { key: 'exit', name: '05 EXIT', screen: 'exit' },
  },

  PALETTE: [
    { hex: '#F25C54', name: 'rose' },
    { hex: '#FFB3A7', name: 'peach' },
    { hex: '#FACD7D', name: 'amber' },
    { hex: '#8BD3C7', name: 'mint' },
    { hex: '#4DD0E1', name: 'aqua' },
    { hex: '#7AA5FF', name: 'blue' },
    { hex: '#B08CFF', name: 'violet' },
    { hex: '#F68AD3', name: 'magenta' },
  ],

  SHOW_COLOR_NAMES: true,
  DEBUG: false,
  ALLOW_SKIP: true,

  MEASURE: {
    queueFlushMs: 8000,
    queueMaxBackoffMs: 60000,
    analyticsBackupMs: 120000,
    // 스크롤 원본이 아니라 25% 단위의 도달 지점만 저장한다.
    scrollDepthStep: 25,
    readEndThreshold: 80,
  },
};

export const STATION_LIST = Object.entries(CONFIG.STATIONS)
  .map(([id, v]) => ({ id, ...v }));
