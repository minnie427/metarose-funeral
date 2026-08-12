export const CONFIG = {
  APP_BASE_URL: '',
  SUPABASE_URL: 'https://veeqthtxkeirphghoelk.supabase.co',
  // 이름은 legacy지만, 현재 Supabase의 publishable key를 넣는다.
  SUPABASE_ANON_KEY: 'sb_publishable_kZWUVks4jhb9VJk7nJpTbg_anm5yBIT',

  EXHIBITION: {
    title: 'META ROSE SPECIMEN',
    titleEn: 'META ROSE SPECIMEN',
    series: 'Seoul Fringe 2026',
    venue: 'Phone Hub',
    dates: ['2026-08-11'],
    instagram: '',
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

  SHOW_COLOR_NAMES: false,
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
