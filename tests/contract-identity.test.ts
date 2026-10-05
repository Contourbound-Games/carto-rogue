// Survey Contract identity at runtime: only Game.startContract makes an expedition a Contract, on the
// definition's exact { generator, seed } and in Standard only; Retry keeps it, every other start clears it,
// and the same seed started any other way is no Contract. The identity never changes how a sheet plays.
import { describe, expect, it } from 'vitest';
import { SURVEY_CONTRACTS } from '../src/contracts';
import type { ContractId, SurveyContract } from '../src/contracts';
import { Game } from '../src/game';
import { generateMap, minCostTo } from '../src/map';
import { mulberry32 } from '../src/rng';
import { stepCost, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, GameState, MapData } from '../src/types';
import { mapDigest } from './support/fingerprint';

/** Audio that keeps the name of every call (sounds are gameplay feedback too). */
function recordingAudio(): AudioEngine & { calls: string[] } {
  const calls: string[] = [];
  const log = (name: string) => () => void calls.push(name);
  return {
    calls,
    muted: false,
    unlock: () => undefined,
    toggleMute: () => {
      calls.push('mute');
      return false;
    },
    footstep: (elevation, slope) => void calls.push(`step:${elevation}:${slope}`),
    bump: log('bump'),
    cacheCollected: log('cache'),
    discovery: (kind) => void calls.push(`disc:${kind}`),
    lowStamina: log('low'),
    victory: log('victory'),
    defeat: log('defeat'),
    expeditionStart: log('start'),
    stopAll: log('stop'),
  };
}

/** The real generator, with every map request kept as [seed, generator]. */
function recordingFactory(): { calls: [number, number | undefined][]; make: (seed: number, generator?: number) => MapData } {
  const calls: [number, number | undefined][] = [];
  return {
    calls,
    make: (seed, generator) => {
      calls.push([seed, generator]);
      return generateMap(seed, generator);
    },
  };
}

const contract = (id: ContractId): SurveyContract => SURVEY_CONTRACTS.find((c) => c.id === id) as SurveyContract;

const standardGame = (): Game => new Game(recordingAudio(), generateMap, { seed: 205, now: 0 });

/** Full-knowledge cheapest line to the summit. */
function walkToSummit(game: Game, t0: number): number {
  const map = game.state.map;
  const to = minCostTo(map, map.summit.x, map.summit.y);
  let now = t0;
  for (let guard = 0; guard < 500 && game.state.phase === 'playing'; guard++) {
    const { x, y } = game.state.player;
    const dir = DIR_LIST.find((d) => {
      const c = stepCost(map, x, y, d);
      return c !== null && to[tileIndex(x + DIRS[d].dx, y + DIRS[d].dy)] + c === to[tileIndex(x, y)];
    });
    if (!dir) break;
    game.handleAction(dir, (now += 200));
  }
  return now;
}

/** Pace back and forth beside the spawn until the surveyor collapses. */
function paceToCollapse(game: Game, t0: number): number {
  const s = game.state;
  const pair = DIR_LIST.find((d) => stepCost(s.map, s.player.x, s.player.y, d) !== null) as Dir;
  const back = DIR_LIST.find((d) => DIRS[d].dx === -DIRS[pair].dx && DIRS[d].dy === -DIRS[pair].dy) as Dir;
  let now = t0;
  for (let k = 0; game.state.phase === 'playing' && k < 400; k++) game.handleAction(k % 2 === 0 ? pair : back, (now += 200));
  return now;
}

/** A fresh expedition on exactly this Contract's mountain, whatever started it. */
function expectContractSheet(s: GameState, c: SurveyContract): void {
  expect(s.phase).toBe('playing');
  expect(s.turns).toBe(0);
  expect(s.mode).toBe('standard');
  expect({ seed: s.seed, mapSeed: s.map.seed, generator: s.map.generator }).toEqual({ seed: c.seed, mapSeed: c.seed, generator: c.generator });
  expect(mapDigest(s.map)).toBe(c.mapDigest);
}

describe('a fresh expedition is no Contract', () => {
  it('in Standard and in Explorer, from the title card or a ?seed= link', () => {
    for (const mode of ['standard', 'explorer'] as const) {
      expect(new Game(recordingAudio(), generateMap, { now: 0, mode }).state.contract).toBeNull();
      expect(new Game(recordingAudio(), generateMap, { seed: 205, now: 0, startPlaying: true, mode }).state.contract).toBeNull();
    }
  });
});

describe('starting a Contract', () => {
  it.each(SURVEY_CONTRACTS)('$id starts on its exact { generator, seed } in Standard', (c) => {
    const f = recordingFactory();
    const game = new Game(recordingAudio(), f.make, { seed: 205, now: 0 });
    expect(game.startContract(100, c.id)).toBe(true);
    expect(f.calls.at(-1)).toEqual([c.seed, c.generator]);
    expect(game.state.contract).toBe(c.id);
    expectContractSheet(game.state, c);
  });

  it('is refused in Explorer, leaving the expedition, its sheet, mode and identity as they were', () => {
    const f = recordingFactory();
    const game = new Game(recordingAudio(), f.make, { seed: 205, now: 0, startPlaying: true, mode: 'explorer' });
    game.handleAction('right', 200);
    const before = game.state;
    const snapshot = JSON.stringify([before.seed, before.turns, before.player, before.trail, before.stamina, before.phase]);
    const digest = mapDigest(before.map);
    const requests = f.calls.length;
    for (const c of SURVEY_CONTRACTS) expect(game.startContract(400, c.id)).toBe(false);
    expect(game.state).toBe(before);
    expect(f.calls).toHaveLength(requests);
    expect(JSON.stringify([before.seed, before.turns, before.player, before.trail, before.stamina, before.phase])).toBe(snapshot);
    expect(mapDigest(game.state.map)).toBe(digest);
    expect(game.state.mode).toBe('explorer');
    expect(game.state.contract).toBeNull();
    // The refusal changed nothing persistent either: the next expedition is still Explorer.
    game.handleAction('restart', 600);
    expect(game.state.mode).toBe('explorer');
  });
});

describe('Retry keeps the Contract', () => {
  it('after a summit and after a collapse, attempt after attempt, on the same mountain', () => {
    const c = contract('hold-the-high-ground');
    const f = recordingFactory();
    const game = new Game(recordingAudio(), f.make, { seed: 205, now: 0 });
    game.startContract(100, c.id);

    let now = walkToSummit(game, 100) + 5000;
    game.update(now);
    expect(game.state.phase).toBe('victory');
    game.retrySheet((now += 100));
    expect(f.calls.at(-1)).toEqual([c.seed, c.generator]);
    expect(game.state.contract).toBe(c.id);
    expectContractSheet(game.state, c);

    now = paceToCollapse(game, now) + 5000;
    game.update(now);
    expect(game.state.phase).toBe('gameover');
    game.retrySheet(now + 100);
    expect(f.calls.at(-1)).toEqual([c.seed, c.generator]);
    expect(game.state.contract).toBe(c.id);
    expectContractSheet(game.state, c);
  });
});

describe('every other start clears the Contract', () => {
  const c = contract('gentle-ascent');
  const starts: [string, (game: Game) => void][] = [
    ['R / New Expedition (restart)', (game) => game.handleAction('restart', 1000)],
    ['a typed seed', (game) => game.startSeed(1000, 721405)],
    ['a new expedition', (game) => game.newExpedition(1000)],
    ['the title card (pause menu exit)', (game) => game.returnToTitle(1000)],
  ];

  it.each(starts)('%s, and a later Retry does not bring it back', (_name, begin) => {
    const game = standardGame();
    game.startContract(100, c.id);
    game.handleAction('down', 200);
    begin(game);
    expect(game.state.contract).toBeNull();
    if (game.state.phase === 'title') game.handleAction('confirm', 1100);
    game.handleAction('right', 1200);
    game.retrySheet(1400);
    expect(game.state.contract).toBeNull();
  });
});

describe("a Contract's seed started as a plain seed is no Contract", () => {
  it.each(SURVEY_CONTRACTS)('$id: the same mountain, typed or linked, without the identity', (c) => {
    const linked = new Game(recordingAudio(), generateMap, { seed: c.seed, now: 0, startPlaying: true });
    expectContractSheet(linked.state, c);
    expect(linked.state.contract).toBeNull();

    const typed = standardGame();
    typed.startSeed(100, c.seed);
    expectContractSheet(typed.state, c);
    expect(typed.state.contract).toBeNull();
    typed.retrySheet(200);
    expect(typed.state.contract).toBeNull();
  });
});

/** Everything of the state except the Contract identity (the map by its digest). */
function gameplay(s: GameState): unknown {
  const { map, contract: _contract, ...rest } = s;
  return { map: mapDigest(map), ...rest, revealed: Array.from(s.revealed), visible: Array.from(s.visible) };
}

describe('the identity never changes how a sheet plays', () => {
  it.each(SURVEY_CONTRACTS)('$id plays input for input exactly as its plain seed', (c) => {
    const asContract = { audio: recordingAudio(), game: null as unknown as Game };
    const asSeed = { audio: recordingAudio(), game: null as unknown as Game };
    asContract.game = new Game(asContract.audio, generateMap, { seed: 205, now: 0 });
    asSeed.game = new Game(asSeed.audio, generateMap, { seed: 205, now: 0 });
    asContract.game.startContract(100, c.id);
    asSeed.game.startSeed(100, c.seed);
    expect(asContract.game.state.contract).toBe(c.id);
    expect(asSeed.game.state.contract).toBeNull();

    // One seeded input stream for both: steps, held repeats, bumps, mute and pauses, to the end.
    const rng = mulberry32(c.seed);
    let now = 100;
    const both = (act: (g: Game) => void): void => {
      for (const run of [asContract, asSeed]) {
        act(run.game);
        run.game.update(now);
      }
      expect(gameplay(asContract.game.state)).toEqual(gameplay(asSeed.game.state));
      expect(asContract.audio.calls).toEqual(asSeed.audio.calls);
    };
    for (let k = 0; k < 900 && asSeed.game.state.phase === 'playing'; k++) {
      const r = rng();
      now += 40 + Math.floor(rng() * 180);
      if (r < 0.02) both((g) => g.handleAction('mute', now));
      else if (r < 0.03) {
        both((g) => g.pause(now));
        now += 700;
        both((g) => g.resume(now));
      } else {
        const dir = DIR_LIST[Math.floor(rng() * 4)];
        const repeat = rng() < 0.3;
        both((g) => g.handleAction(dir, now, repeat));
      }
    }
    now += 5000;
    both(() => undefined);
    expect(asSeed.game.state.finalStats).not.toBeNull();
    // A Retry of each is again the identical fresh start.
    now += 100;
    both((g) => g.retrySheet(now));
    expect(asContract.game.state.contract).toBe(c.id);
  });
});
