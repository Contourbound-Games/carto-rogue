// Survey Contract conditions (src/contract-conditions.ts): a pure judgement of an expedition. Synthetic
// routes pin every boundary; real expeditions show the steep count matches the game's own report, and
// that judging an expedition never changes it.
import { describe, expect, it } from 'vitest';
import { COST_STEEP, MAP_H, MAP_W, VISION_HIGH_MIN } from '../src/config';
import { aboveHighSightLine, evaluateContract } from '../src/contract-conditions';
import type { ContractCondition, ContractRun } from '../src/contract-conditions';
import { Game } from '../src/game';
import { generateMap, minCostTo } from '../src/map';
import { stepCost, tallySteps, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, ExpeditionStats, GameState, MapData, Point } from '../src/types';

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

const ZERO_STEEP: ContractCondition = { kind: 'maxSteepSteps', max: 0 };
const HOLD_840: ContractCondition = { kind: 'holdSightLine', line: 'high' };

// ----- Synthetic expeditions: a straight walk east along row 1 -----

interface Walk {
  /** Cost of each step (step k goes from x = k to x = k + 1). */
  costs: number[];
  /** Elevation of tile x on the row (default 0.3). */
  elevation?: (x: number) => number;
  /** How the expedition ended: on the summit (the last tile), in a collapse, or not yet. */
  outcome?: 'victory' | 'defeat' | null;
}

function walk(w: Walk): ContractRun {
  const n = w.costs.length;
  const elevation = new Float32Array(MAP_W * MAP_H).fill(0.3);
  for (let x = 0; x <= n; x++) elevation[tileIndex(x, 1)] = w.elevation?.(x) ?? 0.3;
  const outcome = w.outcome === undefined ? 'victory' : w.outcome;
  const summit: Point = outcome === 'victory' ? { x: n, y: 1 } : { x: 70, y: 50 };
  const map = { seed: 1, generator: 1, width: MAP_W, height: MAP_H, elevation, spawn: { x: 0, y: 1 }, summit, caches: [], peaks: [] } as unknown as MapData;
  const trail = Array.from({ length: n + 1 }, (_, x) => ({ x, y: 1 }));
  const finalStats = outcome === null ? null : ({ outcome, staminaLeft: 0, turns: n } as ExpeditionStats);
  return { map, trail, stepCosts: w.costs, finalStats };
}

const judge = (run: ContractRun, ...conditions: ContractCondition[]) => evaluateContract(run, conditions);

describe('summit required', () => {
  it('is met only on a summit, open while under way, broken by a collapse', () => {
    const none: ContractCondition[] = [];
    expect(evaluateContract(walk({ costs: [1, 1] }), none)).toMatchObject({ status: 'met', summit: true });
    expect(evaluateContract(walk({ costs: [1, 1], outcome: null }), none)).toMatchObject({ status: 'open', summit: false });
    expect(evaluateContract(walk({ costs: [1, 1], outcome: 'defeat' }), none)).toMatchObject({ status: 'broken', summit: false });
  });

  it('leaves unbroken conditions open after a collapse, but the Contract is broken', () => {
    const r = judge(walk({ costs: [3, 3], outcome: 'defeat' }), ZERO_STEEP, HOLD_840);
    expect(r.status).toBe('broken');
    expect(r.conditions.map((c) => c.status)).toEqual(['open', 'open']);
  });
});

describe('maxSteepSteps', () => {
  it('counts cost-8 steps and breaks on the turn the budget is exceeded', () => {
    const run = walk({ costs: [1, 3, COST_STEEP, 1, COST_STEEP] });
    expect(judge(run, ZERO_STEEP).conditions[0]).toMatchObject({ status: 'broken', value: 2, brokenOnTurn: 3 });
    expect(judge(run, { kind: 'maxSteepSteps', max: 1 }).conditions[0]).toMatchObject({ status: 'broken', value: 2, brokenOnTurn: 5 });
    expect(judge(run, { kind: 'maxSteepSteps', max: 2 }).conditions[0]).toMatchObject({ status: 'met', value: 2, brokenOnTurn: null });
  });

  it('never counts gentle (3) steps, and is open until the summit', () => {
    expect(judge(walk({ costs: [3, 3, 3] }), ZERO_STEEP).conditions[0]).toMatchObject({ status: 'met', value: 0 });
    expect(judge(walk({ costs: [3, 1], outcome: null }), ZERO_STEEP).conditions[0].status).toBe('open');
  });

  it('agrees with the report tally on real expeditions', () => {
    for (const seed of [205, 4242, 77777]) {
      const s = playCamps(seed);
      expect(judge(s, { kind: 'maxSteepSteps', max: 99 }).conditions[0].value).toBe(tallySteps(s.map, s.trail, s.stepCosts).steep.steps);
    }
  });
});

describe('holdSightLine', () => {
  const heights = [0.3, 0.5, VISION_HIGH_MIN + 0.01, 0.75, VISION_HIGH_MIN - 0.01, 0.6, 0.85];
  const run = walk({ costs: Array(heights.length - 1).fill(3), elevation: (x) => heights[x] });

  it('places tiles on the side of the line the sheet draws (the widest sight band)', () => {
    expect(aboveHighSightLine(VISION_HIGH_MIN)).toBe(false);
    expect(aboveHighSightLine(VISION_HIGH_MIN + 1e-4)).toBe(true);
  });

  it('breaks on the first step back below the line once crossed, and counts every step below', () => {
    expect(judge(run, HOLD_840).conditions[0]).toMatchObject({ status: 'broken', value: 2, brokenOnTurn: 4 });
  });

  it('allows any wandering below the line before it is first crossed', () => {
    const low = [0.3, 0.25, 0.35, 0.3, 0.72, 0.8];
    const r = walk({ costs: Array(low.length - 1).fill(1), elevation: (x) => low[x] });
    expect(judge(r, HOLD_840).conditions[0]).toMatchObject({ status: 'met', value: 0 });
  });

  it('is open until the summit', () => {
    const r = walk({ costs: [1, 1], elevation: (x) => [0.3, 0.8, 0.85][x], outcome: null });
    expect(judge(r, HOLD_840).conditions[0]).toMatchObject({ status: 'open', value: 0, brokenOnTurn: null });
  });
});

// ----- Real expeditions -----

/** Cheapest step toward the target of `to` (a cost-to-go table), or null on it. */
function descend(map: MapData, to: Float64Array, x: number, y: number): Dir | null {
  const here = to[tileIndex(x, y)];
  if (here === 0 || !Number.isFinite(here)) return null;
  for (const dir of DIR_LIST) {
    const c = stepCost(map, x, y, dir);
    if (c !== null && to[tileIndex(x + DIRS[dir].dx, y + DIRS[dir].dy)] + c === here) return dir;
  }
  return null;
}

/** A full-knowledge expedition that detours to the cheapest camp whenever the summit is out of reach. */
function playCamps(seed: number): GameState {
  const game = new Game(silent, generateMap, { seed, now: 0, startPlaying: true });
  const map = game.state.map;
  const toSummit = minCostTo(map, map.summit.x, map.summit.y);
  const toCamp = map.caches.map((c) => minCostTo(map, c.x, c.y));
  for (let k = 0, now = 0; k < 800 && game.state.phase === 'playing'; k++) {
    const s = game.state;
    const i = tileIndex(s.player.x, s.player.y);
    let to = toSummit;
    if (toSummit[i] >= s.stamina) {
      let best = Infinity;
      toCamp.forEach((t, c) => {
        if (!s.cacheCollected[c] && t[i] < best) {
          best = t[i];
          to = t;
        }
      });
    }
    const dir = descend(map, to, s.player.x, s.player.y);
    if (!dir) break;
    game.handleAction(dir, (now += 200));
  }
  return game.state;
}

describe('on real expeditions', () => {
  it('never changes the expedition it judges', () => {
    const s = playCamps(4242);
    expect(s.finalStats?.outcome).toBe('victory');
    const snapshot = (st: GameState) =>
      JSON.stringify([st.phase, st.stamina, st.turns, st.trail, st.stepCosts, st.revealedCount, st.cacheCollected, st.finalStats, st.map.caches]) +
      st.revealed.join('') +
      st.map.elevation.join(',');
    const before = snapshot(s);
    Object.freeze(s.trail);
    Object.freeze(s.stepCosts);
    Object.freeze(s.finalStats);
    Object.freeze(s.map.caches);
    evaluateContract(s, [ZERO_STEEP, HOLD_840]);
    expect(snapshot(s)).toBe(before);
  });
});
