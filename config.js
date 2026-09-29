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

  // Venue facts stay null until they are checked on site. Once confirmed,
  // add percentage coordinates such as { x: 32, y: 46 } for a work. Verified
  // venue facts may be plain strings or bilingual objects such as
  // { ko: '북쪽 문', en: 'North door' }. The UI keeps null values labelled
  // TBC and renders confirmed values without changing the component.
  VENUE_LAYOUT: {
    footprint: 'rectangle',
    positionsConfirmed: false,
    // Temporary editorial layout requested for the preview. These are not
    // verified physical positions. Replace `works` with measured x/y values
    // and set positionsConfirmed=true only after the on-site check.
    provisionalWorks: {
      '01': { x: 88, y: 50, wall: 'east' },
      '02': { x: 62, y: 15, wall: 'north' },
      '03': { x: 42, y: 85, wall: 'south' },
      '04': { x: 10, y: 78, wall: 'south-west' },
    },
    // Preview-only map graphics. These coordinates are deliberately separate
    // from the verified access fields below, so tomorrow's site check can
    // replace them without turning an unconfirmed route into a public claim.
    provisionalAccessPreview: {
      entry: { x: 5, y: 53, labelKo: '입구', labelEn: 'ENTRY' },
      exit: { x: 5, y: 68, labelKo: '출구', labelEn: 'EXIT' },
      routePoints: [
        { x: 5, y: 53 },
        { x: 24, y: 53 },
        { x: 24, y: 34 },
        { x: 78, y: 34 },
        { x: 88, y: 50 },
      ],
      // Keep the two off-room directions inside the view frame so their labels
      // remain readable; their edge placement and wording indicate that the
      // destination continues beyond the provisional room footprint.
      toilet: { x: 96, y: 18, labelKo: '화장실 방향 →', labelEn: 'TOILET DIRECTION →' },
      otherRoom: { x: 4, y: 88, labelKo: '← 다른 방', labelEn: '← OTHER ROOM' },
    },
    works: {
      '01': null,
      '02': null,
      '03': null,
      '04': null,
    },
    entryExit: null,
    stepFreeEntrance: null,
    accessibleRoute: null,
    accessibleToilet: null,
    quietSpace: null,
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
