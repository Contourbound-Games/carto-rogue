// Today's Expedition as played (Game.startDaily / nextDailySheet / restartDaily): three Standard sheets in
// a row, each a fresh expedition from full stamina and played exactly like the same sheet outside the
// Daily. A collapse ends the attempt; only a summit on all three makes a result (when it is stored:
// tests/record-timing.test.ts). The ways on: NEXT SHEET (Sheet 1 / 2), RESTART DAILY (the same date from
// Sheet 1), and New Expedition, R and Return to title, which all leave the Daily.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STAMINA } from '../src/config';
import { dailyCompletedBy, dailyIdentity, dailyShareOf, utcDateKey } from '../src/daily';
import { DailyMenu } from '../src/daily-menu';
import { Game } from '../src/game';
import { dailyReportView } from '../src/hud';
import { dailyText, setLang } from '../src/i18n';
import { generateMap } from '../src/map';
import { countsTowardRecords, RecordKeeper } from '../src/records';
import type { ExpeditionResult } from '../src/records';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, DailyIdentity, Dir, GameState, MapData } from '../src/types';
import { applyEndChoice, endChoices, reportFor } from '../src/ui';
import { Oracle } from './support/oracle';

const silent: AudioEngine = {
  muted: false,
  unlock: () => undefined,
  toggleMute: () => false,
  footstep: () => undefined,
  bump: () => undefined,
  cacheCollected: () => undefined,
  discovery: () => undefined,
  lowStamina: () => undefined,
  victory: () => undefined,
  defeat: () => undefined,
  expeditionStart: () => undefined,
  stopAll: () => undefined,
};

const DATE = '2026-10-06';
const ID: DailyIdentity = dailyIdentity(DATE);

/** A game on the title card, its maps from the real generator (every call recorded). */
function titleGame(mode: 'standard' | 'explorer' = 'standard'): { game: Game; built: [number, number | undefined][] } {
  const built: [number, number | undefined][] = [];
  const factory = (seed: number, generator?: number): MapData => {
    built.push([seed, generator]);
    return generateMap(seed, generator);
  };
  return { game: new Game(silent, factory, { seed: 123456, now: 0, mode }), built };
}

let clock = 0;
const tick = (): number => (clock += 200);

/** Walk the full-knowledge best line (camps included) to the pillar, then let the end animation finish. */
function climb(game: Game): void {
  const oracle = new Oracle(game.state.map);
  for (let k = 0; k < 2000 && game.state.phase === 'playing'; k++) {
    const s = game.state;
    const plan = oracle.plan(s.player.x, s.player.y, s.stamina, s.cacheCollected);
    const dir = oracle.step(s.player.x, s.player.y, plan.next);
    if (!dir) break;
    game.handleAction(dir, tick());
  }
  expect(game.state.phase).toBe('summiting');
  game.update(tick() + 10_000);
  expect(game.state.phase).toBe('victory');
}

/** Pace back and forth beside the spawn until the surveyor collapses, then let the end animation finish. */
function collapse(game: Game): void {
  const map = game.state.map;
  const { x, y } = game.state.player;
  const opposite: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const dir = DIR_LIST.find((d) => {
    const nx = x + DIRS[d].dx;
    const ny = y + DIRS[d].dy;
    return game.state.neighborCosts[d] !== null && !(nx === map.summit.x && ny === map.summit.y);
  });
  if (!dir) throw new Error('no step beside the spawn');
  for (let k = 0; k < 2000 && game.state.phase === 'playing'; k++) game.handleAction(k % 2 === 0 ? dir : opposite[dir], tick());
  expect(game.state.phase).toBe('collapsing');
  game.update(tick() + 10_000);
  expect(game.state.phase).toBe('gameover');
}

/** Take one step (the first open direction), so the expedition counts as begun. */
function step(game: Game): void {
  const dir = DIR_LIST.find((d) => game.state.neighborCosts[d] !== null);
  if (!dir) throw new Error('no open step');
  const turns = game.state.turns;
  game.handleAction(dir, tick());
  expect(game.state.turns).toBe(turns + 1);
}

/** What a sheet's play left behind, for comparing a Daily sheet with the same sheet played plainly. */
function trace(s: GameState) {
  const { elapsedMs: _elapsed, ...stats } = s.finalStats ?? { elapsedMs: 0 };
  return {
    seed: s.seed,
    generator: s.map.generator,
    trail: s.trail,
    stepCosts: s.stepCosts,
    stamina: s.stamina,
    turns: s.turns,
    revealedCount: s.revealedCount,
    revealed: Array.from(s.revealed),
    cacheCollected: s.cacheCollected,
    log: s.log.map((e) => [e.text, e.tone]),
    stats,
  };
}

const store = new Map<string, string>();
beforeEach(() => {
  clock = 0;
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  setLang('en', false);
});

describe('starting an attempt', () => {
  it('starts Sheet 1 on the date\'s first sheet, generator 1, from full stamina', () => {
    const { game, built } = titleGame();
    expect(game.startDaily(tick(), ID)).toBe(true);
    const s = game.state;
    expect([s.phase, s.seed, s.map.generator, s.stamina, s.turns, s.contract]).toEqual(['playing', ID.seeds[0], 1, MAX_STAMINA, 0, null]);
    expect(s.daily).toEqual({ ...ID, seeds: [...ID.seeds], sheet: 0, done: [] });
    expect(built.at(-1)).toEqual([ID.seeds[0], 1]);
  });

  it('is refused in Explorer, leaving the title card, its sheet and its mode as they were', () => {
    const { game } = titleGame('explorer');
    const before = game.state;
    expect(game.startDaily(tick(), ID)).toBe(false);
    expect(game.state).toBe(before);
    expect([game.state.phase, game.state.mode, game.state.daily]).toEqual(['title', 'explorer', null]);
  });

  it('and a Survey Contract clear each other: a run is never both', () => {
    const { game } = titleGame();
    game.startDaily(tick(), ID);
    expect(game.startContract(tick(), 'gentle-ascent')).toBe(true);
    expect([game.state.contract, game.state.daily]).toEqual(['gentle-ascent', null]);
    expect(game.startDaily(tick(), ID)).toBe(true);
    expect([game.state.contract, game.state.daily?.date]).toEqual([null, DATE]);
  });

  it('is no Daily when a Daily seed is typed or linked as a plain seed', () => {
    const { game } = titleGame();
    game.startSeed(tick(), ID.seeds[0], 1);
    expect(game.state.daily).toBeNull();
  });
});

describe('an attempt, sheet by sheet', () => {
  it('plays each sheet exactly like the same sheet outside the Daily, each from full stamina', () => {
    const { game } = titleGame();
    game.startDaily(tick(), ID);
    for (let k = 0; k < 3; k++) {
      expect(game.state.daily?.sheet).toBe(k);
      expect([game.state.seed, game.state.stamina, game.state.turns]).toEqual([ID.seeds[k], MAX_STAMINA, 0]);
      climb(game);
      const daily = trace(game.state);
      // The same sheet and the same inputs as a plain expedition.
      const plain = titleGame().game;
      plain.startSeed(tick(), ID.seeds[k], 1);
      climb(plain);
      expect(daily).toEqual(trace(plain.state));
      if (k < 2) expect(game.nextDailySheet(tick())).toBe(true);
    }
    expect(game.state.daily?.done).toHaveLength(2);
  });

  it('moves on only from a summit on Sheet 1 or 2, carrying its summary and nothing else', () => {
    const { game } = titleGame();
    game.startDaily(tick(), ID);
    expect(game.nextDailySheet(tick())).toBe(false); // still playing
    climb(game);
    const sheet1 = game.state;
    expect(game.nextDailySheet(tick())).toBe(true);
    const s = game.state;
    expect(s).not.toBe(sheet1);
    expect([s.seed, s.phase, s.stamina, s.daily?.sheet]).toEqual([ID.seeds[1], 'playing', MAX_STAMINA, 1]);
    expect(s.daily?.done).toEqual([
      { grade: sheet1.finalStats?.grade, points: expect.any(Number), turns: sheet1.turns, staminaLeft: sheet1.finalStats?.staminaLeft },
    ]);
    climb(game);
    expect(game.nextDailySheet(tick())).toBe(true);
    climb(game);
    // After Sheet 3 there is no next sheet.
    const last = game.state;
    expect(game.nextDailySheet(tick())).toBe(false);
    expect(game.state).toBe(last);
  });

  it('ends the attempt on a collapse: no next sheet and no result', () => {
    const { game } = titleGame();
    game.startDaily(tick(), ID);
    climb(game);
    game.nextDailySheet(tick());
    collapse(game);
    expect(game.nextDailySheet(tick())).toBe(false);
    expect(dailyCompletedBy(game.state)).toBeNull();
    expect(dailyShareOf(game.state)).toEqual({ date: DATE, completed: false, endedOnSheet: 2 });
  });

  it('never retries a single sheet', () => {
    const { game } = titleGame();
    game.startDaily(tick(), ID);
    collapse(game);
    const ended = game.state;
    expect(game.retrySheet(tick())).toBe(false);
    expect(applyEndChoice(game, 'retry', tick())).toBe(false);
    expect(game.state).toBe(ended);
  });

  it('makes a result of three summits: totals of points, turns and stamina left, no elapsed time', () => {
    const { game } = titleGame();
    game.startDaily(tick(), ID);
    const sheets: GameState[] = [];
    for (let k = 0; k < 3; k++) {
      climb(game);
      sheets.push(game.state);
      if (k < 2) game.nextDailySheet(tick());
    }
    const result = dailyCompletedBy(game.state);
    expect(result).not.toBeNull();
    expect(result?.sheets.map((s) => [s.grade, s.turns, s.staminaLeft])).toEqual(
      sheets.map((s) => [s.finalStats?.grade, s.turns, s.finalStats?.staminaLeft]),
    );
    expect(result?.totalTurns).toBe(sheets.reduce((n, s) => n + s.turns, 0));
    expect(result?.totalStaminaLeft).toBe(sheets.reduce((n, s) => n + (s.finalStats?.staminaLeft ?? 0), 0));
    expect(result?.totalPoints).toBe(result?.sheets.reduce((n, s) => n + s.points, 0));
    expect(result?.totalPoints).toBeLessThanOrEqual(300);
    expect(JSON.stringify(result)).not.toMatch(/elapsed/i);
    expect([result?.date, result?.revision, result?.generator, result?.seeds]).toEqual([DATE, 1, 1, [...ID.seeds]]);
  });

  it('keeps every Daily sheet out of the Standard archives, whatever its outcome', () => {
    const results: ExpeditionResult[] = [];
    const { game } = titleGame();
    const keeper = new RecordKeeper(game.state, (r) => results.push(r));
    game.startDaily(tick(), ID);
    keeper.sync(game.state);
    climb(game);
    keeper.sync(game.state);
    game.nextDailySheet(tick());
    keeper.sync(game.state);
    collapse(game);
    keeper.sync(game.state);
    game.restartDaily(tick());
    keeper.sync(game.state);
    step(game);
    game.handleAction('restart', tick()); // abandoned after a step
    keeper.sync(game.state);
    expect(results.map((r) => [r.outcome, r.daily])).toEqual([
      ['victory', DATE],
      ['defeat', DATE],
      ['abandoned', DATE],
    ]);
    expect(results.every((r) => !countsTowardRecords(r))).toBe(true);
  });
});

/** Complete the whole attempt (three summits), returning the game on the Sheet 3 report. */
function completeAttempt(game: Game, id: DailyIdentity = ID): void {
  game.startDaily(tick(), id);
  for (let k = 0; k < 3; k++) {
    climb(game);
    if (k < 2) game.nextDailySheet(tick());
  }
}

describe('the ways on (R / New Expedition / Return to title / RESTART DAILY)', () => {
  const leftDaily = (game: Game) => {
    const s = game.state;
    expect([s.daily, s.contract]).toEqual([null, null]);
    expect(ID.seeds).not.toContain(s.seed);
  };

  it('R leaves the Daily for a fresh normal expedition: while playing, on every report, during the summit', () => {
    const playing = titleGame().game;
    playing.startDaily(tick(), ID);
    step(playing);
    playing.handleAction('restart', tick());
    leftDaily(playing);
    expect(playing.state.phase).toBe('playing');

    const between = titleGame().game;
    between.startDaily(tick(), ID);
    climb(between);
    between.handleAction('restart', tick());
    leftDaily(between);

    const failed = titleGame().game;
    failed.startDaily(tick(), ID);
    collapse(failed);
    failed.handleAction('restart', tick());
    leftDaily(failed);

    const done = titleGame().game;
    completeAttempt(done);
    done.handleAction('restart', tick());
    leftDaily(done);
  });

  it('New Expedition leaves it from every report; Return to title leaves it too', () => {
    for (const end of ['next', 'failed', 'final'] as const) {
      const { game } = titleGame();
      if (end === 'final') completeAttempt(game);
      else {
        game.startDaily(tick(), ID);
        if (end === 'next') climb(game);
        else collapse(game);
      }
      expect(endChoices(game.state)[1]).toBe('new');
      expect(applyEndChoice(game, 'new', tick())).toBe(true);
      leftDaily(game);
    }
    const { game } = titleGame();
    game.startDaily(tick(), ID);
    step(game);
    game.returnToTitle(tick());
    expect([game.state.phase, game.state.daily]).toEqual(['title', null]);
  });

  it('offers NEXT SHEET after Sheet 1 / 2 (selected), RESTART DAILY after a collapse (selected) or the last summit', () => {
    const between = titleGame().game;
    between.startDaily(tick(), ID);
    climb(between);
    expect(endChoices(between.state)).toEqual(['next', 'new']);
    expect(reportFor(between.state).choice).toBe('next');

    const failed = titleGame().game;
    failed.startDaily(tick(), ID);
    collapse(failed);
    expect(endChoices(failed.state)).toEqual(['restart', 'new']);
    expect(reportFor(failed.state).choice).toBe('restart');

    const done = titleGame().game;
    completeAttempt(done);
    expect(endChoices(done.state)).toEqual(['restart', 'new']);
    expect(reportFor(done.state).choice).toBe('new');
  });

  it('RESTART DAILY starts the same attempt again from Sheet 1: the same date and sheets, nothing carried', () => {
    for (const end of ['failed', 'final'] as const) {
      const { game } = titleGame();
      if (end === 'final') completeAttempt(game);
      else {
        game.startDaily(tick(), ID);
        climb(game);
        game.nextDailySheet(tick());
        collapse(game);
      }
      expect(applyEndChoice(game, 'restart', tick())).toBe(true);
      const s = game.state;
      expect([s.phase, s.seed, s.stamina, s.turns]).toEqual(['playing', ID.seeds[0], MAX_STAMINA, 0]);
      expect(s.daily).toEqual({ ...ID, seeds: [...ID.seeds], sheet: 0, done: [] });
    }
  });

  it('and the Daily card hands R on (closing itself) and keeps every other key', () => {
    const menu = new DailyMenu();
    menu.open(0, Date.UTC(2026, 9, 6, 12));
    expect(menu.key(null, 'up')).toBe('handled');
    expect(menu.key(null, 'mute')).toBe('pass');
    expect(menu.key(null, 'restart')).toBe('pass');
    expect(menu.isOpen).toBe(false);
  });
});

describe('the UTC day and the attempt', () => {
  it('BEGIN uses the date of the moment it is chosen, and says so when the day changed since the card opened', () => {
    const { game } = titleGame();
    const menu = new DailyMenu();
    menu.open(0, Date.UTC(2026, 9, 6, 23, 59, 59, 999));
    expect(menu.date).toBe('2026-10-06');
    const begun = menu.begin(game, tick(), Date.UTC(2026, 9, 7, 0, 0, 0, 0));
    expect(begun).toEqual({ started: true, date: '2026-10-07', dateChanged: true });
    expect(game.state.daily?.date).toBe('2026-10-07');
    expect(game.state.daily?.seeds).toEqual(dailyIdentity('2026-10-07').seeds);
    expect(menu.isOpen).toBe(false);

    const same = new DailyMenu();
    same.open(0, Date.UTC(2026, 9, 6, 8));
    expect(same.begin(titleGame().game, tick(), Date.UTC(2026, 9, 6, 9))).toEqual({ started: true, date: DATE, dateChanged: false });
  });

  it('a refused BEGIN (Explorer) keeps the card open, showing the date it read', () => {
    const { game } = titleGame('explorer');
    const menu = new DailyMenu();
    menu.open(0, Date.UTC(2026, 9, 6, 23, 59));
    expect(menu.begin(game, tick(), Date.UTC(2026, 9, 7, 0, 1))).toEqual({ started: false, date: '2026-10-07', dateChanged: true });
    expect([menu.isOpen, menu.date, game.state.daily]).toEqual([true, '2026-10-07', null]);
  });

  it('keeps an attempt begun before midnight on its date: its result and RESTART DAILY after midnight', () => {
    const { game } = titleGame();
    const menu = new DailyMenu();
    menu.open(0, Date.UTC(2026, 9, 6, 23, 50));
    menu.begin(game, tick(), Date.UTC(2026, 9, 6, 23, 55));
    for (let k = 0; k < 3; k++) {
      climb(game);
      if (k < 2) game.nextDailySheet(tick());
    }
    // It is past midnight now; the game reads no clock, so the attempt is still 6 October's.
    expect(dailyCompletedBy(game.state)?.date).toBe(DATE);
    expect(applyEndChoice(game, 'restart', tick())).toBe(true);
    expect(game.state.daily?.date).toBe(DATE);
    expect(game.state.daily?.seeds).toEqual(ID.seeds);
  });

  it('says a new day is open on a collapse or final report once the UTC date moved on, never between sheets', () => {
    const today = (epochMs: number) => ({ days: [], newBestOf: null, today: utcDateKey(epochMs) });
    const failed = titleGame().game;
    failed.startDaily(tick(), ID);
    collapse(failed);
    expect(dailyReportView(failed.state, today(Date.UTC(2026, 9, 6, 23, 59)))?.notice).toBeNull();
    expect(dailyReportView(failed.state, today(Date.UTC(2026, 9, 7, 0, 0)))?.notice).toBe(dailyText('newDayOpen'));
    expect(dailyReportView(failed.state, { days: [], newBestOf: null, today: null })?.notice).toBeNull();

    const done = titleGame().game;
    completeAttempt(done);
    expect(dailyReportView(done.state, today(Date.UTC(2026, 9, 8)))?.notice).toBe(dailyText('newDayOpen'));
    setLang('ko', false);
    expect(dailyReportView(done.state, today(Date.UTC(2026, 9, 8)))?.notice).toBe('새 오늘의 원정이 열렸습니다');

    const between = titleGame().game;
    between.startDaily(tick(), ID);
    climb(between);
    expect(dailyReportView(between.state, today(Date.UTC(2026, 9, 8)))?.notice).toBeNull();
  });
});
