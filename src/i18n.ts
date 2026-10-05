// English / Korean string tables and the active-language preference.
// Every player-facing string goes through t(). English is the default everywhere (tests run in
// English); the browser build calls initLanguage() to restore the saved choice or follow the
// browser's language. Strings with Hangul are drawn with the Galmuri9 web font (see font.ts).

export type Lang = 'en' | 'ko';

export const LANG_STORAGE_KEY = 'carto-rogue:lang';

const EN = {
  // Field log (<= 30 characters after substitution).
  logSoundOff: 'Sound off.',
  logSoundOn: 'Sound on.',
  logBegin: 'Expedition #{seed} begins.',
  logSeek: 'Seek the Trig Pillar summit.',
  logReached: 'Trig Pillar reached!',
  logCollapse: 'You collapse, exhausted.',
  logTooSpent: 'Too spent. Press again to go.',
  logEdge: 'The edge of the survey sheet.',
  logWater: 'Water blocks the way.',
  logCliff: 'A sheer cliff. No way through.',
  logCacheGain: 'Supply Camp: +{n} stamina',
  logLowStamina: 'Stamina low. Find Supply Camp!',
  logSummitSighted: 'Trig Pillar sighted!',
  logPanorama: 'Panoramic survey! +{tiles} tiles',
  logPanoramaPeaks: 'Panorama +{tiles} tiles, {peaks}',
  onePeak: '1 peak',
  manyPeaks: '{n} peaks',
  logPeak: 'Peak sighted: {m} m',
  logPeaks: '{n} peaks sighted, top {m} m',
  logCacheSpotted: 'Supply Camp spotted.',
  logCachesSpotted: '{n} Supply Camps spotted.',
  logLangSet: 'Language: English.',
  // Floating map labels.
  floatStamina: '+{n} STAMINA',
  floatTrig: 'TRIG PILLAR',
  floatCache: 'SUPPLY CAMP',
  // HUD.
  altimeter: 'ALTIMETER',
  asl: 'ASL',
  sightRadius: 'SIGHT RADIUS',
  tilesN: '{n} TILES',
  panorama: 'PANORAMA',
  slope: 'SLOPE',
  flat: 'FLAT',
  moderate: 'MODERATE',
  steepAlarm: 'STEEP!',
  stamina: 'STAMINA',
  lastStep: 'LAST STEP',
  low: 'LOW!',
  slopeFlat: 'FLAT',
  slopeGentle: 'GENTLE',
  slopeSteep: 'STEEP',
  slopeCliff: 'CLIFF',
  slopeDownhill: 'DOWNHILL',
  stepCost: 'STEP COST',
  compass: 'COMPASS',
  atPillar: 'AT THE PILLAR',
  trigBearing: 'TRIG {b}°',
  trigHunch: 'TRIG HUNCH',
  surveyed: 'SURVEYED',
  turn: 'TURN',
  time: 'TIME',
  caches: 'SUPPLY CAMPS',
  seed: 'SEED',
  fieldLog: 'FIELD LOG',
  awaiting: 'AWAITING ORDERS...',
  arrows: 'ARROWS',
  move: 'MOVE',
  newMap: 'NEW MAP',
  footNew: 'NEW',
  mute: 'MUTE',
  muted: 'MUTED',
  confirm: 'CONFIRM',
  // Title card.
  tagline: 'A SURVEY ROGUELITE OF CONTOURS AND FOG',
  premise: 'SURVEY THE FOG. REACH THE ANCIENT TRIG PILLAR.',
  howToPlay: 'HOW TO PLAY',
  mapLegend: 'MAP LEGEND',
  ruleFlat: 'FLAT, DOWNHILL OR ALONG A CONTOUR',
  ruleGentle: 'GENTLE UPHILL',
  ruleSteep: 'STEEP UPHILL',
  ruleBlock: 'SHEER CLIFFS AND WATER BLOCK YOU',
  ruleCache: 'SUPPLY CAMPS RESTORE STAMINA',
  ruleSight: 'HIGHER GROUND = WIDER SIGHT',
  ruleSightTiles: '{a} / {b} / {c} TILES, WIDENING AT EACH SIGHT LINE',
  ruleStamina: 'EVERY STEP SPENDS STAMINA (START {max}). AT 0 THE SURVEYOR COLLAPSES,',
  ruleLastStep: 'UNLESS A SUPPLY CAMP OR THE TRIG PILLAR CATCHES THAT LAST STEP.',
  legendContour: 'CONTOUR  {m} M',
  legendIndex: 'INDEX CONTOUR  {m} M',
  legendSight: 'SIGHT LINE  {a} / {b} M',
  legendCliff: 'CLIFF HACHURE',
  legendWater: 'WATER',
  legendCache: 'SUPPLY CAMP',
  legendTrig: 'ANCIENT TRIG PILLAR',
  titleFootnote: 'R STARTS A FRESH EXPEDITION WITH A NEW RANDOM SEED AT ANY TIME.  ESC / P PAUSES.',
  pressBegin: 'PRESS ENTER OR SPACE TO BEGIN',
  contourInterval: 'CONTOUR INTERVAL {m} M',
  sheetNo: 'SHEET NO. {seed}',
  // End cards.
  causeExhaustion: 'CAUSE: EXHAUSTION',
  finalEntry: 'EXPEDITION LOG · FINAL ENTRY',
  collapsed: 'THE SURVEYOR HAS COLLAPSED',
  inkBleeds: 'THE INK BLEEDS OUT...',
  sheetHadRoute: 'THIS SHEET HAD A ROUTE TO THE PILLAR',
  mapped: 'MAPPED',
  turns: 'TURNS',
  maxAltitude: 'MAX ALTITUDE',
  grade: 'GRADE',
  expeditionComplete: 'EXPEDITION COMPLETE',
  summitReached: 'SUMMIT REACHED',
  ancientTrig: '— ANCIENT TRIG PILLAR —',
  pillarOccupied: 'TRIG PILLAR OCCUPIED',
  percentMapped: 'PERCENT MAPPED',
  turnsTaken: 'TURNS TAKEN',
  staminaLeft: 'STAMINA LEFT',
  endPrompt: '←→ SELECT  ·  ENTER CHOOSE  ·  H CARD  ·  R NEW EXPEDITION',
  // Expedition report (end cards).
  retrySheet: 'RETRY THIS SHEET',
  newExpedition: 'NEW EXPEDITION',
  hideCard: 'HIDE CARD',
  showReport: 'SHOW REPORT',
  gradeRoute: 'ROUTE',
  gradeReserve: 'RESERVE',
  gradeSurvey: 'SURVEY',
  gradeScore: 'SCORE',
  gradeRouteNote: 'ROUTE EFFICIENCY {p}%  ·  STAMINA SPENT {n}',
  gradeReserveNote: '{n} STAMINA LEFT  ·  FULL MARKS AT {full}',
  gradeSurveyNote: '{p}% SURVEYED  ·  FULL MARKS AT {full}%',
  gradeScale: 'S {s}+  ·  A {a}+  ·  B {b}+  ·  BELOW: C',
  staminaSpent: 'STAMINA SPENT',
  stepsSteep: 'STEEP (8)',
  stepsGentle: 'GENTLE (3)',
  stepsFlat: 'FLAT (1)',
  stepsDownhill: 'DOWNHILL (1)',
  stepsValue: '{n} STEPS · {cost}',
  reportLine: 'TURNS {t}  ·  TIME {time}  ·  SUPPLY CAMPS {c}  ·  TOP {m} M',
  keyVisited: 'VISITED',
  keySeen: 'SEEN',
  keyMissed: 'NOT FOUND',
  keyUnseen: 'UNSURVEYED',
  // Buttons, toasts and the archives ledger.
  copySeed: 'COPY SEED',
  shareResult: 'SHARE RESULT',
  archives: 'ARCHIVES',
  toastLink: 'LINK COPIED!',
  toastResult: 'RESULT COPIED!',
  toastFailed: 'COPY FAILED',
  archivesTitle: 'EXPEDITION ARCHIVES',
  archivesSub: 'LEDGER OF THE SURVEY OFFICE',
  recExpeditions: 'TOTAL EXPEDITIONS',
  recSummits: 'SUMMITS CONQUERED',
  recBestSurvey: 'BEST SURVEYED',
  recBestGrade: 'HIGHEST GRADE',
  recTiles: 'TOTAL TILES MAPPED',
  recFewestTurns: 'FEWEST TURNS TO SUMMIT',
  recEmpty: 'NO EXPEDITIONS ON RECORD YET.',
  recNone: '—',
  archivesClose: 'PRESS L OR ESC TO CLOSE',
  archivesHint: 'L  ARCHIVES',
  enterSeed: 'ENTER SEED',
  seedTitle: 'EXPEDITION SEED',
  seedHint: 'A NUMBER FROM 0 TO 4294967295',
  seedConfirm: 'CONFIRM',
  seedCancel: 'CANCEL',
  seedInvalid: 'Enter a number between 0 and 4294967295',
  // Pause menu.
  pausedTitle: 'EXPEDITION PAUSED',
  pauseResume: 'RESUME',
  pauseToTitle: 'RETURN TO TITLE',
  abandonQuestion: 'ABANDON EXPEDITION?',
  abandonWarning: 'PROGRESS WILL BE LOST',
  abandonConfirm: 'CONFIRM',
  abandonCancel: 'CANCEL',
  pauseHint: 'ESC RESUME  ·  ↑↓ SELECT  ·  ENTER CHOOSE',
  confirmHint: 'ESC BACK  ·  ←→ SELECT  ·  ENTER CHOOSE',
  // Share text.
  shareSummit: 'Summit',
  shareConquered: 'Conquered',
  shareFailed: 'Failed',
  shareTurns: 'Turns',
  shareExplored: 'Explored',
  shareGrade: 'Grade',
  shareMode: 'Mode',
  // Expedition mode (title-card toggle, HUD tag, note).
  modeStandard: 'STANDARD',
  modeExplorer: 'EXPLORER',
  explorerNote: 'COSTLY STEPS ECHO ON THE SHEET · NOT RECORDED IN ARCHIVES',
  // Sheet header / fog lettering on the map.
  sheetTitle: 'SURVEY SHEET No. {seed}',
  sheetSpec: 'CONTOUR INTERVAL {c} M · INDEX {i} M · HEIGHTS IN METRES',
  fieldCopy: 'FIELD COPY',
  legendRoute: 'ROUTE',
  legendCliffShort: 'CLIFF',
  legendWaterShort: 'WATER',
  legendCacheShort: 'CAMP',
  legendSpot: 'SPOT HT',
  legendTrigShort: 'TRIG',
  scale: 'SCALE 1:25 000',
  metres: 'METRES',
  unsurveyed: 'UNSURVEYED GROUND',
} as const;

export type MessageKey = keyof typeof EN;

const KO: Record<MessageKey, string> = {
  logSoundOff: '소리 꺼짐.',
  logSoundOn: '소리 켜짐.',
  logBegin: '원정 #{seed} 출발.',
  logSeek: '삼각점 정상을 찾아라.',
  logReached: '삼각점 정상 도달!',
  logCollapse: '탈진하여 쓰러졌다.',
  logTooSpent: '기력 부족. 다시 누르면 강행.',
  logEdge: '측량 도면의 끝이다.',
  logWater: '물이 길을 막는다.',
  logCliff: '깎아지른 절벽. 지날 수 없다.',
  logCacheGain: '보급: 스태미나 +{n}',
  logLowStamina: '스태미나 부족! 보급을 찾아라',
  logSummitSighted: '삼각점 발견!',
  logPanorama: '파노라마 측량! +{tiles}칸',
  logPanoramaPeaks: '파노라마 +{tiles}칸, {peaks}',
  onePeak: '봉우리 1',
  manyPeaks: '봉우리 {n}',
  logPeak: '봉우리 발견: {m}m',
  logPeaks: '봉우리 {n}개, 최고 {m}m',
  logCacheSpotted: '보급캠프 발견.',
  logCachesSpotted: '보급캠프 {n}곳 발견.',
  logLangSet: '언어: 한국어.',
  floatStamina: '스태미나 +{n}',
  floatTrig: '삼각점',
  floatCache: '보급캠프',
  altimeter: '고도계',
  asl: '해발',
  sightRadius: '시야 반경',
  tilesN: '{n}칸',
  panorama: '파노라마',
  slope: '경사',
  flat: '평탄',
  moderate: '완만',
  steepAlarm: '급경사!',
  stamina: '스태미나',
  lastStep: '직전 걸음',
  low: '부족!',
  slopeFlat: '평탄',
  slopeGentle: '완만',
  slopeSteep: '급경사',
  slopeCliff: '절벽',
  slopeDownhill: '내리막',
  stepCost: '걸음 비용',
  compass: '나침반',
  atPillar: '삼각점 도착',
  trigBearing: '삼각점 {b}°',
  trigHunch: '방향 짐작',
  surveyed: '측량률',
  turn: '턴',
  time: '시간',
  caches: '보급',
  seed: '시드',
  fieldLog: '야장',
  awaiting: '지시 대기 중...',
  arrows: '방향키',
  move: '이동',
  newMap: '새 지도',
  footNew: '새 지도',
  mute: '음소거',
  muted: '음소거',
  confirm: '확인',
  tagline: '등고선과 안개의 측량 로그라이트',
  premise: '안개를 측량하고, 고대 삼각점에 도달하라.',
  howToPlay: '플레이 방법',
  mapLegend: '범례',
  ruleFlat: '평지 · 내리막 · 등고선을 따라 걷기',
  ruleGentle: '완만한 오르막',
  ruleSteep: '가파른 오르막',
  ruleBlock: '절벽과 물은 지나갈 수 없다',
  ruleCache: '보급캠프에서 스태미나 회복',
  ruleSight: '높은 곳일수록 넓은 시야',
  ruleSightTiles: '{a} / {b} / {c}칸 · 시야 경계선을 넘을 때마다 넓어진다',
  ruleStamina: '걸음마다 스태미나를 쓴다 (시작 {max}). 0이 되면 측량사가 쓰러진다.',
  ruleLastStep: '단, 마지막 걸음이 보급캠프나 삼각점에 닿으면 무사하다.',
  legendContour: '주곡선  {m} M',
  legendIndex: '계곡선  {m} M',
  legendSight: '시야 경계선  {a} / {b} M',
  legendCliff: '절벽 기호',
  legendWater: '물',
  legendCache: '보급캠프',
  legendTrig: '고대 삼각점',
  titleFootnote: 'R 키로 언제든 새 시드의 원정을 시작할 수 있다.  ESC / P: 일시 정지.',
  pressBegin: 'ENTER 또는 SPACE로 출발',
  contourInterval: '등고선 간격 {m} M',
  sheetNo: '도엽 번호 {seed}',
  causeExhaustion: '원인: 탈진',
  finalEntry: '원정 일지 · 마지막 기록',
  collapsed: '측량사가 쓰러졌다',
  inkBleeds: '잉크가 번져 나간다...',
  sheetHadRoute: '이 도엽에는 삼각점까지 가는 길이 있었다',
  mapped: '측량률',
  turns: '턴 수',
  maxAltitude: '최고 고도',
  grade: '등급',
  expeditionComplete: '원정 완료',
  summitReached: '정상 정복',
  ancientTrig: '— 고대 삼각점 —',
  pillarOccupied: '삼각점 점령',
  percentMapped: '측량률',
  turnsTaken: '소요 턴',
  staminaLeft: '남은 스태미나',
  endPrompt: '←→ 선택  ·  ENTER 결정  ·  H 카드  ·  R 새 원정',
  retrySheet: '같은 도엽 재도전',
  newExpedition: '새 원정',
  hideCard: '카드 숨기기',
  showReport: '보고서 보기',
  gradeRoute: '경로',
  gradeReserve: '비축',
  gradeSurvey: '측량',
  gradeScore: '점수',
  gradeRouteNote: '경로 효율 {p}%  ·  소비 스태미나 {n}',
  gradeReserveNote: '남은 스태미나 {n}  ·  {full} 이상이면 만점',
  gradeSurveyNote: '측량 {p}%  ·  {full}% 이상이면 만점',
  gradeScale: 'S {s}+  ·  A {a}+  ·  B {b}+  ·  그 아래 C',
  staminaSpent: '소비 스태미나',
  stepsSteep: '급경사 (8)',
  stepsGentle: '완만 (3)',
  stepsFlat: '평지 (1)',
  stepsDownhill: '내리막 (1)',
  stepsValue: '{n}걸음 · {cost}',
  reportLine: '턴 {t}  ·  시간 {time}  ·  보급캠프 {c}  ·  최고 {m} M',
  keyVisited: '방문',
  keySeen: '발견',
  keyMissed: '미발견',
  keyUnseen: '미측량',
  copySeed: '링크 복사',
  shareResult: '결과 복사',
  archives: '원정 기록실',
  toastLink: '링크를 복사했다!',
  toastResult: '결과를 복사했다!',
  toastFailed: '복사 실패',
  archivesTitle: '원정 기록실',
  archivesSub: '측량국 원정 대장',
  recExpeditions: '총 원정',
  recSummits: '정상 정복',
  recBestSurvey: '최고 측량률',
  recBestGrade: '최고 등급',
  recTiles: '누적 측량 칸',
  recFewestTurns: '최단 정복 턴',
  recEmpty: '아직 원정 기록이 없다.',
  recNone: '—',
  archivesClose: 'L 또는 ESC: 닫기',
  archivesHint: 'L  원정 기록실',
  enterSeed: '시드 입력',
  seedTitle: '원정 시드',
  seedHint: '0 ~ 4294967295 사이의 숫자',
  seedConfirm: '확인',
  seedCancel: '취소',
  seedInvalid: '0 ~ 4294967295 범위의 숫자를 입력하세요',
  pausedTitle: '원정 일시 정지',
  pauseResume: '계속하기',
  pauseToTitle: '타이틀로',
  abandonQuestion: '원정을 포기하시겠습니까?',
  abandonWarning: '현재 원정 기록이 중단됩니다',
  abandonConfirm: '포기',
  abandonCancel: '취소',
  pauseHint: 'ESC 계속  ·  ↑↓ 선택  ·  ENTER 결정',
  confirmHint: 'ESC 뒤로  ·  ←→ 선택  ·  ENTER 결정',
  shareSummit: '정상',
  shareConquered: '정복',
  shareFailed: '실패',
  shareTurns: '턴',
  shareExplored: '탐사',
  shareGrade: '등급',
  shareMode: '모드',
  modeStandard: '표준',
  modeExplorer: '탐험가',
  explorerNote: '비용이 큰 걸음은 지도에 잠시 되짚어 표시 · 원정 기록실에 남지 않음',
  sheetTitle: '측량 도엽 제{seed}호',
  sheetSpec: '주곡선 {c}M · 계곡선 {i}M · 높이 단위 미터',
  fieldCopy: '현장용',
  legendRoute: '경로',
  legendCliffShort: '절벽',
  legendWaterShort: '물',
  legendCacheShort: '보급',
  legendSpot: '표고점',
  legendTrigShort: '삼각점',
  scale: '축척 1:25 000',
  metres: '미터',
  unsurveyed: '미측량 지역',
};

const TABLES: Record<Lang, Record<MessageKey, string>> = { en: EN, ko: KO };

let current: Lang = 'en';
let version = 0;
const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
  return current;
}

/** Bumped on every language change, so caches of rendered text can key on it. */
export function langVersion(): number {
  return version;
}

export function setLang(lang: Lang, persist = true): void {
  if (lang === current) return;
  current = lang;
  version++;
  if (persist) {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // Storage may be blocked (private mode, sandboxed iframe); the choice just won't persist.
    }
  }
  for (const fn of listeners) fn(lang);
}

export function toggleLang(): Lang {
  setLang(current === 'en' ? 'ko' : 'en');
  return current;
}

export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'ko';
}

/** Restore the saved language, else follow the browser (Korean browsers start in Korean). */
export function initLanguage(): Lang {
  let saved: string | null;
  try {
    saved = localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    saved = null;
  }
  if (isLang(saved)) {
    setLang(saved, false);
  } else if (typeof navigator !== 'undefined' && /^ko\b/i.test(navigator.language ?? '')) {
    setLang('ko', false);
  }
  return current;
}

/** Look up `key` in the active language and substitute {name} placeholders. */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>, lang: Lang = current): string {
  const template = TABLES[lang][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Both tables, for tests that check coverage and placeholders. */
export function messageTables(): Readonly<Record<Lang, Readonly<Record<MessageKey, string>>>> {
  return TABLES;
}

// Survey Contract card (Steam edition). Kept apart from the tables above and read only by Steam-edition
// code, so the itch build leaves these strings out entirely.
const CONTRACT_EN = {
  contractsTitle: 'SURVEY CONTRACTS',
  contractsSub: 'THREE SET SHEETS · THE SAME MOUNTAIN EVERY TIME',
  contractsRule: 'EVERY CONTRACT: REACH THE TRIG PILLAR. A COLLAPSE FAILS IT.',
  contractGentleName: 'GENTLE ASCENT',
  contractGentleGoal: 'NO STEEP UPHILL STEP ALL THE WAY UP',
  contractHoldName: 'HOLD THE HIGH GROUND',
  contractHoldGoal: 'ONCE ABOVE THE {m} M SIGHT LINE, NEVER STEP BELOW IT',
  contractMasterName: 'MASTER SURVEYOR',
  contractMasterGoal: 'BOTH: NO STEEP UPHILL STEP, AND HOLD THE {m} M LINE',
  contractCompleted: 'COMPLETED',
  contractsHint: '↑↓ SELECT · ENTER BEGIN · C / ESC CLOSE',
  contractsStandardOnly: 'SURVEY CONTRACTS USE STANDARD RULES.',
  contractsSwitch: 'SWITCH TO STANDARD TO BEGIN.',
};

export type ContractTextKey = keyof typeof CONTRACT_EN;

const CONTRACT_KO: Record<ContractTextKey, string> = {
  contractsTitle: '측량 계약',
  contractsSub: '정해진 도엽 세 장 · 언제나 같은 산',
  contractsRule: '모든 계약: 삼각점 정상 도달. 탈진하면 실패.',
  contractGentleName: '완만한 등정',
  contractGentleGoal: '정상까지 가파른 오르막 걸음 없이',
  contractHoldName: '고지 사수',
  contractHoldGoal: '{m} M 시야 경계선 위에 오른 뒤 다시 내려가지 않기',
  contractMasterName: '측량 명인',
  contractMasterGoal: '두 조건 모두: 가파른 오르막 없이, {m} M 선 지키기',
  contractCompleted: '완료',
  contractsHint: '↑↓ 선택 · ENTER 시작 · C / ESC 닫기',
  contractsStandardOnly: '측량 계약은 표준 규칙으로만 진행합니다.',
  contractsSwitch: '시작하려면 표준으로 바꾸세요.',
};

const CONTRACT_TABLES: Record<Lang, Record<ContractTextKey, string>> = { en: CONTRACT_EN, ko: CONTRACT_KO };

/** t() for the Survey Contract card: call it only from Steam-edition code. */
export function contractText(key: ContractTextKey, params?: Readonly<Record<string, string | number>>, lang: Lang = current): string {
  const template = CONTRACT_TABLES[lang][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The Survey Contract tables, for tests. */
export function contractTextTables(): Readonly<Record<Lang, Readonly<Record<ContractTextKey, string>>>> {
  return CONTRACT_TABLES;
}
