// Checks on the Explorer validation tooling itself (tests/support): the bots see only what the
// screen shows, the path solver agrees with the game's own, and the oracle plays as it should.
import { describe, expect, it } from 'vitest';
import { Game } from '../src/game';
import { generateMap, minCostTo } from '../src/map';
import { stepCost, tileIndex } from '../src/terrain';
import { DIR_LIST } from '../src/types';
import type { AudioEngine, MapData } from '../src/types';
import { makeBot } from './support/bots';
import { observe } from './support/observation';
import { Oracle } from './support/oracle';
import { INF, N_TILES, dial } from './support/paths';
import { runBot } from './support/sweep';

const silent: AudioEngine = {
  unlock: () => {},
  muted: false,
  toggleMute: () => false,
  footstep: () => {},
  bump: () => {},
  cacheCollected: () => {},
  discovery: () => {},
  lowStamina: () => {},
  victory: () => {},
  defeat: () => {},
  expeditionStart: () => {},
  stopAll: () => {},
};

/** The same map with every unsurveyed tile's terrain replaced (elevation, water, passability). */
function scrambleUnseen(map: MapData, revealed: Uint8Array): MapData {
  const elevation = map.elevation.slice();
  const passMask = map.passMask.slice();
  for (let i = 0; i < elevation.length; i++) {
    if (revealed[i]) continue;
    elevation[i] = ((i * 7919) % 1000) / 1000;
    passMask[i] = (i * 31) & 15;
  }
  return { ...map, elevation, passMask };
}

describe('observation', () => {
  it('shows nothing of the unsurveyed ground', () => {
    const game = new Game(silent, generateMap, { seed: 205, now: 0, startPlaying: true });
    for (let k = 0; k < 12; k++) game.handleAction(DIR_LIST[k % 2 === 0 ? 1 : 2], 200 * (k + 1));
    const s = game.state;
    const obs = observe(s);
    const scrambled = observe(s, scrambleUnseen(s.map, s.revealed));
    expect(scrambled.band).toEqual(obs.band);
    expect(Array.from(scrambled.exact)).toEqual(Array.from(obs.exact));
    expect(scrambled.pass).toEqual(obs.pass);
    for (let i = 0; i < N_TILES; i++) {
      if (s.revealed[i]) continue;
      expect(obs.band[i]).toBe(-1);
      expect(obs.pass[i]).toBe(0);
      expect(Number.isNaN(obs.exact[i])).toBe(true);
    }
  });

  it('lists only surveyed camps, in either mode', () => {
    for (const seed of [205, 555, 31337]) {
      for (const mode of ['standard', 'explorer'] as const) {
        const game = new Game(silent, generateMap, { seed, now: 0, startPlaying: true, mode });
        const surveyed = game.state.map.caches.filter((c) => game.state.revealed[tileIndex(c.x, c.y)]);
        expect(observe(game.state).camps.map((c) => [c.x, c.y])).toEqual(surveyed.map((c) => [c.x, c.y]));
      }
    }
  });

  it('is identical in both modes (the Explorer Step Echo is not given to bots)', () => {
    const std = new Game(silent, generateMap, { seed: 555, now: 0, startPlaying: true });
    const exp = new Game(silent, generateMap, { seed: 555, now: 0, startPlaying: true, mode: 'explorer' });
    for (let k = 0; k < 10; k++) {
      std.handleAction('right', 200 * (k + 1));
      exp.handleAction('right', 200 * (k + 1));
      expect(observe(exp.state)).toEqual(observe(std.state));
    }
  });
});

describe('path solver', () => {
  it('matches the game map search on exact step costs', () => {
    for (const seed of [205, 555]) {
      const map = generateMap(seed);
      const w = new Int16Array(N_TILES * 4);
      for (let i = 0; i < N_TILES; i++) {
        const x = i % map.width;
        const y = (i / map.width) | 0;
        DIR_LIST.forEach((d, k) => {
          w[i * 4 + k] = stepCost(map, x, y, d) ?? -1;
        });
      }
      const mine = dial(w, tileIndex(map.summit.x, map.summit.y), true, 8);
      const theirs = minCostTo(map, map.summit.x, map.summit.y);
      for (let i = 0; i < N_TILES; i++) expect(mine[i] === INF ? Infinity : mine[i]).toBe(theirs[i]);
    }
  });
});

describe('bots', () => {
  it('oracle plans at least the generator feasibility margin and wins', () => {
    for (const seed of [205, 555, 31337, 424242]) {
      const map = generateMap(seed);
      const plan = new Oracle(map).plan(map.spawn.x, map.spawn.y, 100, map.caches.map(() => false));
      expect(plan.arrival).toBeLessThanOrEqual(map.stats.bestArrivalStamina);
      expect(plan.arrival).toBeGreaterThanOrEqual(20);
      const r = runBot(seed, 'standard', 'oracle');
      expect(r.outcome).toBe('victory');
    }
  });

  it('every observation bot finishes its expedition without walking into walls', () => {
    for (const name of ['contour', 'exact', 'bearing', 'bearingCost'] as const) {
      for (const mode of ['standard', 'explorer'] as const) {
        const r = runBot(205, mode, name);
        expect(['victory', 'defeat']).toContain(r.outcome);
        expect(r.bumps).toBe(0);
      }
    }
  });

  it('decides from the observation alone', () => {
    const game = new Game(silent, generateMap, { seed: 555, now: 0, startPlaying: true, mode: 'explorer' });
    for (let k = 0; k < 6; k++) game.handleAction('right', 200 * (k + 1));
    const s = game.state;
    for (const name of ['contour', 'exact', 'bearing', 'bearingCost'] as const) {
      const real = makeBot(name).decide(observe(s));
      const fake = makeBot(name).decide(observe(s, scrambleUnseen(s.map, s.revealed)));
      expect(fake).toBe(real);
    }
  });
});
