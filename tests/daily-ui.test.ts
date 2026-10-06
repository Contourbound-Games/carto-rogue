// Today's Expedition on screen (Steam edition): the title entry beside the Survey Contracts, the Daily
// card, the HUD run tag, the report band and buttons, and the shared text. Every line is measured in
// both languages against the room it is drawn in.
import { afterEach, describe, expect, it } from 'vitest';
import { MAP_PX_H } from '../src/config';
import { dailyIdentity } from '../src/daily';
import { DailyMenu } from '../src/daily-menu';
import { applyDailyResult, emptyDailyRecords } from '../src/daily-records';
import { hasBitmapGlyphs, measureText } from '../src/font';
import {
  buttonRowWidth,
  contractsEntrySpec,
  DAILY_BAND,
  DAILY_CARD,
  DAILY_CARD_H,
  DAILY_CARD_TEXT_W,
  DAILY_CARD_W,
  dailyBandHeight,
  dailyBeginSpec,
  dailyCardBest,
  dailyCardRules,
  dailyEntrySpec,
  dailyReportButtons,
  dailyReportView,
  dailyStampWidth,
  dailyTagText,
  RUN_TAG_MAX_W,
  runTagBox,
  TITLE_W,
  titleLayout,
} from '../src/hud';
import type { DailyReportView } from '../src/hud';
import { dailyText, dailyTextTables, setLang } from '../src/i18n';
import type { DailyTextKey, Lang } from '../src/i18n';
import { keyToAction, keyToUiKey } from '../src/input';
import { GAME_TITLE, PUBLIC_GAME_URL, dailyShareText } from '../src/share';
import type { DailyRun, DailySheetSummary, ExpeditionStats, GameState } from '../src/types';

const LANGS: readonly Lang[] = ['en', 'ko'];
afterEach(() => setLang('en', false));

const ID = dailyIdentity('2026-10-06');
const sheet = (grade: string, points: number, turns: number, staminaLeft: number): DailySheetSummary => ({ grade, points, turns, staminaLeft });

/** A finished Daily sheet as the report reads it: the attempt, the phase and the sheet's final stats. */
function ended(sheetNo: 0 | 1 | 2, done: DailySheetSummary[], outcome: 'victory' | 'defeat'): GameState {
  const daily: DailyRun = { ...ID, sheet: sheetNo, done };
  const finalStats: ExpeditionStats = {
    outcome,
    turns: 60,
    staminaSpent: 100,
    staminaLeft: outcome === 'victory' ? 30 : 0,
    cachesCollected: 2,
    cachesTotal: 5,
    maxElevation: 0.9,
    percentMapped: 14,
    elapsedMs: 1000,
    grade: outcome === 'victory' ? 'A' : 'F',
    breakdown: outcome === 'victory' ? { route: 0.8, reserve: 0.6, survey: 0.5, score: 0.7 } : null,
  };
  return { daily, finalStats, phase: outcome === 'victory' ? 'victory' : 'gameover' } as unknown as GameState;
}

const S1 = sheet('S', 85, 40, 33);
const S2 = sheet('B', 55, 70, 12);
const none = { days: [], newBestOf: null, today: null };

describe('title entry', () => {
  it('puts TODAY\'S EXPEDITION before SURVEY CONTRACTS on the Steam second row, in both languages, keeping the layout', () => {
    expect(titleLayout(true)).toEqual({ prompt: 526, buttons: 556, contracts: 590, footer: 626 });
    expect(titleLayout(false)).toEqual({ prompt: 538, buttons: 576, contracts: null, footer: 618 });
    expect([dailyEntrySpec().id, contractsEntrySpec().id]).toEqual(['daily', 'contracts']);
    const widths: Record<string, number> = {};
    for (const lang of LANGS) {
      setLang(lang, false);
      widths[lang] = buttonRowWidth([dailyEntrySpec(), contractsEntrySpec()]);
      expect(widths[lang], lang).toBeLessThanOrEqual(TITLE_W - 40);
    }
    expect(widths).toEqual({ en: 458, ko: 246 });
  });

  it('opens the card with T, on the Korean layout too, a key no game action uses', () => {
    expect(keyToUiKey('KeyT', 't')).toBe('daily');
    expect(keyToUiKey('', 'T')).toBe('daily');
    expect(keyToUiKey('', 'ㅅ')).toBe('daily');
    expect(keyToAction('KeyT', 't')).toBeNull();
    expect(keyToAction('', 'ㅅ')).toBeNull();
  });
});

describe('the Daily card', () => {
  it('opens on the UTC date it read and begins, closes or hands keys on as the Contract card does', () => {
    const menu = new DailyMenu();
    expect(menu.key(null, 'confirm')).toBe('pass');
    menu.open(5, Date.UTC(2026, 9, 6, 23, 30));
    expect([menu.isOpen, menu.since, menu.date]).toEqual([true, 5, '2026-10-06']);
    menu.open(9, Date.UTC(2026, 9, 7));
    expect([menu.since, menu.date]).toEqual([5, '2026-10-06']); // already open
    expect(menu.key(null, 'confirm')).toBe('begin');
    expect(menu.key(null, 'left')).toBe('handled');
    expect(menu.key('archives', null)).toBe('handled');
    expect(menu.key('daily', null)).toBe('handled');
    expect(menu.isOpen).toBe(false);
    menu.open(0, 0);
    expect(menu.key('close', null)).toBe('handled');
    expect(menu.isOpen).toBe(false);
  });

  it('shows the date\'s best, or that there is none yet', () => {
    const rec = applyDailyResult(emptyDailyRecords(), {
      ...ID,
      seeds: [...ID.seeds],
      totalPoints: 211,
      totalTurns: 140,
      totalStaminaLeft: 75,
      sheets: [S1, S2, sheet('A', 71, 30, 30)],
    });
    expect(dailyCardBest(rec.days, '2026-10-06')).toBe('211/300 · 140 TURNS · 75 STAMINA LEFT');
    expect(dailyCardBest(rec.days, '2026-10-07')).toBe('NO COMPLETED ATTEMPT YET');
    setLang('ko', false);
    expect(dailyCardBest(rec.days, '2026-10-06')).toBe('211/300 · 140턴 · 남은 체력 75');
  });

  it('fits every line in both languages, and fits the map area', () => {
    expect(DAILY_CARD_H + 6).toBeLessThanOrEqual(MAP_PX_H - 16);
    for (const lang of LANGS) {
      setLang(lang, false);
      expect(measureText(dailyText('dailyTitle'), 3), lang).toBeLessThanOrEqual(DAILY_CARD_W - 120);
      for (const line of [dailyText('dailySub'), ...dailyCardRules(), dailyText('dailyHint'), dailyText('dailyStandardOnly'), dailyText('dailySwitch')]) {
        expect(measureText(line, 1), `${lang} ${line}`).toBeLessThanOrEqual(DAILY_CARD_TEXT_W);
      }
      expect(measureText(dailyText('dailyDate', { date: '2026-10-06' }), 2)).toBeLessThanOrEqual(DAILY_CARD_TEXT_W);
      // The best slip: the widest best there can be, or none.
      const widest = dailyText('dailyBestValue', { p: 300, t: 1020, s: 300 });
      for (const line of [widest, dailyText('dailyNoBest')]) expect(measureText(line, 2), `${lang} ${line}`).toBeLessThanOrEqual(DAILY_CARD_W - 80 - 32);
      expect(buttonRowWidth([dailyBeginSpec()])).toBeLessThanOrEqual(DAILY_CARD_TEXT_W);
    }
    // Lines stay in order down the card, above the Explorer note and the hint.
    expect(DAILY_CARD.rules + 2 * DAILY_CARD.rulePitch + 7).toBeLessThan(DAILY_CARD.best);
    expect(DAILY_CARD.best + DAILY_CARD.bestH + 2).toBeLessThan(DAILY_CARD.begin);
    expect(DAILY_CARD.begin + 26 + 2).toBeLessThan(DAILY_CARD_H - 76);
  });
});

describe('the HUD tag', () => {
  it('reads the attempt\'s UTC date and sheet, and fits the run tag in both languages', () => {
    expect([0, 1, 2].map((k) => dailyTagText({ date: '2026-10-06', sheet: k as 0 | 1 | 2 }))).toEqual([
      '2026-10-06 UTC · SHEET 1/3',
      '2026-10-06 UTC · SHEET 2/3',
      '2026-10-06 UTC · SHEET 3/3',
    ]);
    setLang('ko', false);
    expect(dailyTagText({ date: '2026-10-06', sheet: 0 })).toBe('2026-10-06 UTC · 도엽 1/3');
    for (const lang of LANGS) {
      setLang(lang, false);
      for (const date of ['2026-10-06', '2088-08-28']) {
        const w = runTagBox(dailyTagText({ date, sheet: 2 })).w;
        expect(w, `${lang} ${date}`).toBeLessThanOrEqual(RUN_TAG_MAX_W);
      }
    }
  });
});

describe('the report band', () => {
  it('after Sheet 1: the summited sheet, the next one and the one to come; no stamp, no notice', () => {
    const view = dailyReportView(ended(0, [], 'victory'), { ...none, today: '2026-10-09' });
    expect(view).toEqual({
      kind: 'next',
      label: "TODAY'S EXPEDITION · 2026-10-06 UTC",
      headline: 'SHEET 1 OF 3 SUMMITED',
      stamp: null,
      rows: [
        { label: 'SHEET 1', value: 'A · 70 PTS · 60 TURNS · 30 LEFT', tone: 'ink' },
        { label: 'SHEET 2', value: 'NEXT', tone: 'red' },
        { label: 'SHEET 3', value: 'TO COME', tone: 'soft' },
      ],
      notice: null,
    });
    expect(dailyBandHeight(view as DailyReportView)).toBe(92);
  });

  it('after a collapse: where it ended, the sheets before it and those never reached; not recorded', () => {
    const view = dailyReportView(ended(1, [S1], 'defeat'), none);
    expect(view).toMatchObject({
      kind: 'failed',
      headline: 'ENDED ON SHEET 2 OF 3',
      stamp: { text: 'NOT RECORDED', red: false },
      rows: [
        { label: 'SHEET 1', value: 'S · 85 PTS · 40 TURNS · 33 LEFT', tone: 'ink' },
        { label: 'SHEET 2', value: 'COLLAPSED', tone: 'red' },
        { label: 'SHEET 3', value: 'NOT REACHED', tone: 'soft' },
      ],
      notice: null,
    });
  });

  it('after the third summit: every sheet, the total, and the date\'s best when it differs (NEW BEST when it just became it)', () => {
    const state = ended(2, [S1, S2], 'victory');
    const total = { label: 'TOTAL', value: '210/300 · 170 TURNS · 75 LEFT', tone: 'ink' };
    const plain = dailyReportView(state, none);
    expect(plain).toMatchObject({ kind: 'final', headline: 'ALL THREE SUMMITS', stamp: { text: 'COMPLETED', red: true } });
    expect(plain?.rows.slice(3)).toEqual([total]);

    const newBest = dailyReportView(state, { ...none, newBestOf: state });
    expect(newBest?.rows.slice(3)).toEqual([total, { label: 'BEST ON THIS DATE', value: 'NEW BEST', tone: 'red' }]);

    const better = applyDailyResult(emptyDailyRecords(), {
      ...ID,
      seeds: [...ID.seeds],
      totalPoints: 250,
      totalTurns: 120,
      totalStaminaLeft: 90,
      sheets: [sheet('S', 90, 40, 30), sheet('S', 80, 40, 30), sheet('A', 80, 40, 30)],
    });
    const behind = dailyReportView(state, { ...none, days: better.days });
    expect(behind?.rows.slice(3)).toEqual([total, { label: 'BEST ON THIS DATE', value: '250/300 · 120 TURNS · 90 LEFT', tone: 'soft' }]);

    // Matching the kept best exactly (a tie keeps the earlier one): nothing more to say.
    const tie = applyDailyResult(emptyDailyRecords(), { ...ID, seeds: [...ID.seeds], totalPoints: 210, totalTurns: 170, totalStaminaLeft: 75, sheets: [S1, S2, sheet('A', 70, 60, 30)] });
    expect(dailyReportView(state, { ...none, days: tie.days })?.rows.slice(3)).toEqual([total]);

    // The new-day notice on top of everything: the tallest band, and the card still fits the map area.
    const tallest = dailyReportView(state, { ...none, newBestOf: state, today: '2026-10-07' }) as DailyReportView;
    expect(tallest.notice).toBe("A NEW TODAY'S EXPEDITION IS OPEN");
    expect(dailyBandHeight(tallest)).toBe(134);
    expect(440 + dailyBandHeight(tallest) + 6).toBeLessThanOrEqual(MAP_PX_H - 16);
  });

  it('is only for a finished Daily sheet', () => {
    expect(dailyReportView({ ...ended(0, [], 'victory'), daily: null } as GameState, none)).toBeNull();
    expect(dailyReportView({ ...ended(0, [], 'victory'), phase: 'summiting' } as GameState, none)).toBeNull();
  });

  it('fits every line in both languages, the widest values and the new-day notice included', () => {
    const inner = 600 - 2 * DAILY_BAND.margin;
    for (const lang of LANGS) {
      setLang(lang, false);
      const stamps = [dailyText('stampCompleted'), dailyText('stampNotRecorded')];
      const widestStamp = Math.max(...stamps.map(dailyStampWidth));
      for (const headline of [dailyText('bandCleared', { n: 2 }), dailyText('bandEnded', { n: 3 }), dailyText('bandAllSummits')]) {
        expect(measureText(headline, 2) + 12 + widestStamp, `${lang} ${headline}`).toBeLessThanOrEqual(inner);
      }
      expect(measureText(dailyText('bandLabel', { date: '2026-10-06' })) + 12 + widestStamp, lang).toBeLessThanOrEqual(inner);
      const values = [
        dailyText('rowResult', { g: 'S', p: 100, t: 340, s: 100 }),
        dailyText('rowTotalValue', { p: 300, t: 1020, s: 300 }),
        dailyText('rowBestValue', { p: 300, t: 1020, s: 300 }),
        dailyText('rowNewBest'),
        dailyText('rowCollapsed'),
        dailyText('rowNotReached'),
      ];
      const labels = [dailyText('rowSheet', { n: 3 }), dailyText('rowTotal'), dailyText('rowBest')];
      for (const label of labels) {
        for (const value of values) {
          expect(12 + measureText(label) + 12 + measureText(value), `${lang} ${label} / ${value}`).toBeLessThanOrEqual(inner);
        }
      }
      expect(12 + measureText(dailyText('newDayOpen')), lang).toBeLessThanOrEqual(inner);
    }
  });
});

describe('the report buttons', () => {
  const ids = (state: GameState, choice: 'next' | 'restart' | 'new') =>
    dailyReportButtons(state, choice)?.map((row) => row.map((b) => [b.id, b.selected ?? false]));

  it('go on to the next sheet between sheets (no share), else restart the Daily (with share); New always leaves', () => {
    expect(ids(ended(0, [], 'victory'), 'next')).toEqual([
      [['nextSheet', true], ['newExpedition', false]],
      [['copySeed', false], ['toggleCard', false]],
    ]);
    for (const state of [ended(1, [S1], 'defeat'), ended(2, [S1, S2], 'victory')]) {
      expect(ids(state, 'new')).toEqual([
        [['restartDaily', false], ['newExpedition', true]],
        [['copySeed', false], ['share', false], ['toggleCard', false]],
      ]);
    }
    expect(dailyReportButtons({ ...ended(0, [], 'victory'), daily: null } as GameState, 'retry')).toBeNull();
  });

  it('fit the card in both languages', () => {
    for (const lang of LANGS) {
      setLang(lang, false);
      for (const state of [ended(0, [], 'victory'), ended(2, [S1, S2], 'victory')]) {
        for (const row of dailyReportButtons(state, 'new') ?? []) expect(buttonRowWidth(row), lang).toBeLessThanOrEqual(600 - 40);
      }
    }
  });
});

describe('sharing', () => {
  it('shares a completed attempt by its date and totals, with no seed and no link', () => {
    const done = { date: '2026-10-06', completed: true as const, totalPoints: 211, totalTurns: 140, totalStaminaLeft: 75, grades: ['A', 'S', 'B'] };
    expect(dailyShareText(done, 'en')).toBe(
      `${GAME_TITLE} | Today's Expedition: 2026-10-06 UTC | Completed | Score: 211/300 | Turns: 140 | Stamina left: 75 | Sheets: A / S / B`,
    );
    expect(dailyShareText(done, 'ko')).toBe(`${GAME_TITLE} | 오늘의 원정: 2026-10-06 UTC | 완주 | 점수: 211/300 | 턴: 140 | 남은 체력: 75 | 도엽: A / S / B`);
    const failed = { date: '2026-10-06', completed: false as const, endedOnSheet: 2 };
    expect(dailyShareText(failed, 'en')).toBe(`${GAME_TITLE} | Today's Expedition: 2026-10-06 UTC | Ended on sheet 2 of 3`);
    expect(dailyShareText(failed, 'ko')).toBe(`${GAME_TITLE} | 오늘의 원정: 2026-10-06 UTC | 도엽 2/3에서 종료`);
    for (const text of [done, failed].flatMap((s) => [dailyShareText(s, 'en'), dailyShareText(s, 'ko')])) {
      expect(text).not.toContain(PUBLIC_GAME_URL);
      expect(text).not.toMatch(/https?:|steam/i);
      for (const seed of ID.seeds) expect(text).not.toContain(String(seed));
    }
  });
});

describe('Daily text', () => {
  it('has every line in both languages with the same placeholders, all drawn from bitmap glyphs', () => {
    const { en, ko } = dailyTextTables();
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as DailyTextKey[]) {
      expect(ko[key].length, key).toBeGreaterThan(0);
      expect(placeholders(ko[key]), key).toEqual(placeholders(en[key]));
      for (const text of [en[key], ko[key]]) expect(hasBitmapGlyphs(text.replace(/\{\w+\}/g, '')), `${key}: run npm run gen:glyphs`).toBe(true);
    }
    expect(dailyText('dailyTitle', undefined, 'en')).toBe("TODAY'S EXPEDITION");
    expect(dailyText('dailyTitle', undefined, 'ko')).toBe('오늘의 원정');
  });
});
