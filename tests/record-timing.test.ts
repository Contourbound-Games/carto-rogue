// When an expedition's result is kept (main.ts): the game's onEnd hands the ending expedition to the
// RecordKeeper on the very step that ends it, so the result is stored before that input returns, with no
// frame, report, R or page close needed. Every later path (the next frame's sync, R / New Expedition,
// Return to title, pagehide) finds it already recorded, so nothing is stored or counted twice.
//
// `wire` builds the game exactly as main.ts does (onEnd: records.sync) with main.ts's record callback:
// a completed Today's Expedition attempt kept as its date's best, a completed Survey Contract kept in the
// progress, and only plain Standard results added to the archives. Nothing here calls sync by hand
// unless a test says it stands for a frame.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contractCompletedBy, completeContract, CONTRACT_PROGRESS_STORAGE_KEY, emptyContractProgress, saveContractProgress } from '../src/contract-progress';
import type { ContractId } from '../src/contracts';
import { dailyCompletedBy, dailyIdentity } from '../src/daily';
import { DAILY_RECORDS_STORAGE_KEY, loadDailyRecords, recordDailyExpedition, saveDailyRecords } from '../src/daily-records';
import { Game } from '../src/game';
import { generateMap } from '../src/map';
import { applyExpedition, countsTowardRecords, emptyRecords, RECORDS_STORAGE_KEY, RecordKeeper, saveRecords } from '../src/records';
import type { ExpeditionResult } from '../src/records';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, ExpeditionMode, GameState } from '../src/types';
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

/** localStorage, counting the writes to each key. */
const store = new Map<string, string>();
const writes = new Map<string, number>();
beforeEach(() => {
  store.clear();
  writes.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
      writes.set(k, (writes.get(k) ?? 0) + 1);
    },
  };
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

interface Wired {
  game: Game;
  keeper: RecordKeeper;
  /** Every result the keeper handed on, in order. */
  results: ExpeditionResult[];
  archives: () => ReturnType<typeof emptyRecords>;
}

/** A game and record keeper wired as main.ts wires them (Steam edition). */
function wire(options: { seed?: number; mode?: ExpeditionMode; startPlaying?: boolean } = {}): Wired {
  let daily = loadDailyRecords();
  let progress = emptyContractProgress();
  let archives = emptyRecords();
  const results: ExpeditionResult[] = [];
  // As in main.ts: the game exists before the keeper, and onEnd can only run once the keeper does.
  const game = new Game(silent, generateMap, { seed: options.seed ?? 123456, now: 0, mode: options.mode, startPlaying: options.startPlaying, onEnd: (s) => keeper.sync(s) });
  const keeper = new RecordKeeper(game.state, (result, expedition) => {
    results.push(result);
    const nextDaily = recordDailyExpedition(daily, expedition);
    if (nextDaily !== daily) {
      daily = nextDaily;
      saveDailyRecords(nextDaily);
    }
    const completed = contractCompletedBy(expedition);
    if (completed !== null) {
      const next = completeContract(progress, completed);
      if (next !== progress) {
        progress = next;
        saveContractProgress(next);
      }
    }
    if (!countsTowardRecords(result)) return;
    archives = applyExpedition(archives, result);
    saveRecords(archives);
  });
  return { game, keeper, results, archives: () => archives };
}

let clock = 0;
const tick = (): number => (clock += 200);
beforeEach(() => {
  clock = 0;
});

/** Walk the full-knowledge best line to the pillar; with `stopShort`, stop one step before it and return that step. */
function climb(game: Game, stopShort = false): Dir | null {
  const oracle = new Oracle(game.state.map);
  const { summit } = game.state.map;
  for (let k = 0; k < 2000 && game.state.phase === 'playing'; k++) {
    const s = game.state;
    const dir = oracle.step(s.player.x, s.player.y, oracle.plan(s.player.x, s.player.y, s.stamina, s.cacheCollected).next);
    if (!dir) throw new Error('lost the way');
    if (stopShort && s.player.x + DIRS[dir].dx === summit.x && s.player.y + DIRS[dir].dy === summit.y) return dir;
    game.handleAction(dir, tick());
  }
  expect(game.state.phase).toBe('summiting');
  return null;
}

/** Pace beside the spawn until the surveyor collapses. */
function collapse(game: Game): void {
  const { x, y } = game.state.player;
  const { summit } = game.state.map;
  const opposite: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const dir = DIR_LIST.find((d) => game.state.neighborCosts[d] !== null && !(x + DIRS[d].dx === summit.x && y + DIRS[d].dy === summit.y));
  if (!dir) throw new Error('no step beside the spawn');
  for (let k = 0; k < 2000 && game.state.phase === 'playing'; k++) game.handleAction(k % 2 === 0 ? dir : opposite[dir], tick());
  expect(game.state.phase).toBe('collapsing');
}

const ID = dailyIdentity('2026-10-06');
const savedDaily = () => JSON.parse(store.get(DAILY_RECORDS_STORAGE_KEY) ?? 'null') as { days: unknown[] } | null;

/** Sheets 1 and 2 summited (the report each time, then NEXT SHEET), and Sheet 3 walked to one step short of the pillar. */
function toLastStep(w: Wired): Dir {
  w.game.startDaily(tick(), ID);
  for (let k = 0; k < 2; k++) {
    climb(w.game);
    w.game.update(tick() + 10_000);
    expect(w.game.nextDailySheet(tick())).toBe(true);
  }
  const last = climb(w.game, true);
  if (!last) throw new Error('reached the pillar early');
  return last;
}

describe("Today's Expedition: the Sheet 3 summit is kept on the step itself", () => {
  it('is stored when the summit step returns: no frame, no sync, no R; and an R right after changes nothing', () => {
    const w = wire();
    const last = toLastStep(w);
    expect(savedDaily()).toBeNull();
    // The final summit input: the next line is the first thing that runs after it returns.
    w.game.handleAction(last, tick());
    const sheet3: GameState = w.game.state;
    expect(sheet3.phase).toBe('summiting');
    expect(savedDaily()?.days).toEqual([dailyCompletedBy(sheet3)]);
    expect(writes.get(DAILY_RECORDS_STORAGE_KEY)).toBe(1);
    // R at once, still with no frame: a fresh normal expedition, and the best stays as it was.
    w.game.handleAction('restart', tick());
    expect([w.game.state.daily, w.game.state.phase]).toEqual([null, 'playing']);
    expect(savedDaily()?.days).toEqual([dailyCompletedBy(sheet3)]);
    expect(writes.get(DAILY_RECORDS_STORAGE_KEY)).toBe(1);
  });

  it('is kept exactly once, whatever comes after: the next frame, R, New Expedition, Return to title, pagehide', () => {
    const w = wire();
    const last = toLastStep(w);
    w.game.handleAction(last, tick());
    const sheet3 = w.game.state;
    const recordedSheet3 = () => w.results.filter((r) => r.daily === ID.date && r.outcome === 'victory').length;
    expect(recordedSheet3()).toBe(3); // Sheets 1, 2 and 3, each once
    w.keeper.sync(w.game.state); // a frame during the summit animation
    w.game.update(tick() + 10_000);
    w.keeper.sync(w.game.state); // a frame on the report
    w.keeper.abandon(); // pagehide
    w.game.handleAction('restart', tick()); // R
    w.keeper.sync(w.game.state);
    w.keeper.abandon();
    w.game.returnToTitle(tick());
    w.keeper.sync(w.game.state);
    expect(recordedSheet3()).toBe(3);
    expect(w.results.at(-1)).toMatchObject({ outcome: 'victory', daily: ID.date, turns: sheet3.turns });
    expect(writes.get(DAILY_RECORDS_STORAGE_KEY)).toBe(1);
    expect(savedDaily()?.days).toHaveLength(1);
    // Never in the Standard archives.
    expect(store.has(RECORDS_STORAGE_KEY)).toBe(false);
  });

  it('keeps no best for a collapse, though the collapse is handed on once, on its own step', () => {
    const w = wire();
    w.game.startDaily(tick(), ID);
    climb(w.game);
    w.game.update(tick() + 10_000);
    w.game.nextDailySheet(tick());
    collapse(w.game);
    expect(w.results.map((r) => [r.outcome, r.daily])).toEqual([
      ['victory', ID.date],
      ['defeat', ID.date],
    ]);
    w.keeper.sync(w.game.state);
    w.game.update(tick() + 10_000);
    w.keeper.sync(w.game.state);
    w.keeper.abandon();
    w.game.restartDaily(tick());
    w.keeper.sync(w.game.state);
    expect(w.results).toHaveLength(2);
    expect(store.has(DAILY_RECORDS_STORAGE_KEY)).toBe(false);
    expect(store.has(RECORDS_STORAGE_KEY)).toBe(false);
  });
});

describe('Standard expeditions: recorded on their last step, once', () => {
  for (const end of ['summit', 'collapse'] as const) {
    it(`a ${end} goes into the archives as it happens, and no frame, R or pagehide adds it again`, () => {
      const w = wire({ startPlaying: true });
      if (end === 'summit') climb(w.game);
      else collapse(w.game);
      expect(w.results.map((r) => r.outcome)).toEqual([end === 'summit' ? 'victory' : 'defeat']);
      expect(w.archives()).toMatchObject({ expeditions: 1, summits: end === 'summit' ? 1 : 0 });
      expect(JSON.parse(store.get(RECORDS_STORAGE_KEY) ?? 'null')).toEqual(w.archives());
      w.keeper.sync(w.game.state);
      w.game.update(tick() + 10_000);
      w.keeper.sync(w.game.state);
      w.keeper.abandon();
      w.game.handleAction('restart', tick());
      w.keeper.sync(w.game.state);
      w.keeper.abandon();
      expect(w.results).toHaveLength(1);
      expect(w.archives().expeditions).toBe(1);
      expect(writes.get(RECORDS_STORAGE_KEY)).toBe(1);
    });
  }

  it('an expedition left behind after a step is still recorded as abandoned, once, when the next state is synced', () => {
    const w = wire({ startPlaying: true });
    const dir = DIR_LIST.find((d) => w.game.state.neighborCosts[d] !== null) as Dir;
    w.game.handleAction(dir, tick());
    w.keeper.sync(w.game.state);
    expect(w.results).toHaveLength(0);
    w.game.handleAction('restart', tick());
    w.keeper.sync(w.game.state);
    w.keeper.sync(w.game.state);
    w.keeper.abandon();
    expect(w.results.map((r) => r.outcome)).toEqual(['abandoned']);
    expect(w.archives().expeditions).toBe(1);
  });

  it('Explorer results are handed on as they happen, and still kept out of the archives', () => {
    const w = wire({ startPlaying: true, mode: 'explorer' });
    climb(w.game);
    expect(w.results.map((r) => [r.outcome, r.mode])).toEqual([['victory', 'explorer']]);
    expect(store.has(RECORDS_STORAGE_KEY)).toBe(false);
  });
});

describe('Survey Contracts: completion kept on the summit step, once', () => {
  const STEP: Record<string, Dir> = { U: 'up', R: 'right', D: 'down', L: 'left' };
  // The approved witness for Hold the High Ground (tests/contracts.test.ts).
  const HOLD = 'RRRRRRDDRRRUDDRRRURRRRRRURRRURRDRRRRRRDRRRU';
  const completedSaved = (): ContractId[] => (JSON.parse(store.get(CONTRACT_PROGRESS_STORAGE_KEY) ?? 'null') as { completed: ContractId[] } | null)?.completed ?? [];

  it('stores a completed Contract when the summit step returns, and never again', () => {
    const w = wire();
    expect(w.game.startContract(tick(), 'hold-the-high-ground')).toBe(true);
    for (const letter of HOLD) w.game.handleAction(STEP[letter], tick());
    expect(w.game.state.phase).toBe('summiting');
    expect(completedSaved()).toEqual(['hold-the-high-ground']);
    expect(writes.get(CONTRACT_PROGRESS_STORAGE_KEY)).toBe(1);
    w.keeper.sync(w.game.state);
    w.game.update(tick() + 10_000);
    w.keeper.sync(w.game.state);
    w.keeper.abandon();
    w.game.retrySheet(tick());
    w.keeper.sync(w.game.state);
    expect(w.results.filter((r) => r.contract === 'hold-the-high-ground')).toHaveLength(1);
    expect(writes.get(CONTRACT_PROGRESS_STORAGE_KEY)).toBe(1);
    // A Contract run never enters the archives.
    expect(store.has(RECORDS_STORAGE_KEY)).toBe(false);
  });

  it('an incomplete Contract (a collapse) is handed on once and completes nothing', () => {
    const w = wire();
    w.game.startContract(tick(), 'hold-the-high-ground');
    collapse(w.game);
    w.keeper.sync(w.game.state);
    w.game.update(tick() + 10_000);
    w.keeper.sync(w.game.state);
    w.keeper.abandon();
    expect(w.results.map((r) => [r.outcome, r.contract])).toEqual([['defeat', 'hold-the-high-ground']]);
    expect(store.has(CONTRACT_PROGRESS_STORAGE_KEY)).toBe(false);
    expect(store.has(RECORDS_STORAGE_KEY)).toBe(false);
  });
});

describe('the game tells of an end once, on the step that ends it', () => {
  it('calls onEnd once per summit or collapse, with the ended expedition, and never for anything else', () => {
    const ended: GameState[] = [];
    const game = new Game(silent, generateMap, { seed: 123456, now: 0, startPlaying: true, onEnd: (s) => ended.push(s) });
    climb(game);
    expect(ended).toEqual([game.state]);
    expect(ended[0].finalStats?.outcome).toBe('victory');
    game.update(tick() + 10_000);
    game.handleAction('confirm', tick());
    game.retrySheet(tick());
    game.returnToTitle(tick());
    expect(ended).toHaveLength(1);
    game.handleAction('restart', tick());
    collapse(game);
    expect(ended).toHaveLength(2);
    expect(ended[1]).toBe(game.state);
    expect(ended[1].finalStats?.outcome).toBe('defeat');
  });
});
