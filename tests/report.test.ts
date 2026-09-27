// Expedition report: grade breakdown, recorded step costs and same-sheet retry, on generated maps.
import { describe, expect, it } from 'vitest';
import { COLLAPSE_ANIM_MS, MAP_H, MAP_W, MAX_STAMINA, VICTORY_ANIM_MS } from '../src/config';
import {
  GRADE_THRESHOLDS,
  Game,
  gradeBreakdown,
  gradeForScore,
  gradePoints,
  gradeVictory,
} from '../src/game';
import type { GradeInput } from '../src/game';
import { keyToUiKey } from '../src/input';
import { generateMap, minCostTo } from '../src/map';
import { RecordKeeper } from '../src/records';
import type { ExpeditionResult } from '../src/records';
import { mulberry32 } from '../src/rng';
import { stepCost, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, GameState, MapData } from '../src/types';
import { reportFor } from '../src/ui';

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

/** The grade formula as it stood before the breakdown was split out (the oracle for these tests). */
function referenceGrade(input: GradeInput): { score: number; grade: string } {
  const route =
    input.directCost > 0 && input.staminaSpent > 0 ? Math.min(1, input.directCost / input.staminaSpent) : 1;
  const reserve = Math.min(1, Math.max(0, input.staminaLeft) / 50);
  const survey = Math.min(1, Math.max(0, input.percentMapped) / 25);
  const score = 0.4 * route + 0.35 * reserve + 0.25 * survey;
  const grade = score >= 0.8 ? 'S' : score >= 0.62 ? 'A' : score >= 0.45 ? 'B' : 'C';
  return { score, grade };
}

function randomInputs(n: number): GradeInput[] {
  const rnd = mulberry32(0x6ad3);
  const out: GradeInput[] = [];
  for (let k = 0; k < n; k++) {
    const directCost = 85 + Math.floor(rnd() * 46);
    // Mostly realistic runs, with exact threshold and edge values mixed in.
    out.push({
      directCost,
      staminaSpent: directCost + Math.floor(rnd() * 160),
      staminaLeft: k % 7 === 0 ? 50 : Math.floor(rnd() * 101),
      percentMapped: k % 5 === 0 ? 25 * Math.floor(rnd() * 3) * 0.5 : rnd() * 40,
    });
  }
  out.push({ directCost: 100, staminaSpent: 100, staminaLeft: 50, percentMapped: 5 });
  out.push({ directCost: 100, staminaSpent: 100, staminaLeft: 50, percentMapped: 4.96 });
  out.push({ directCost: 100, staminaSpent: 0, staminaLeft: 0, percentMapped: 0 });
  return out;
}

/** Cheapest step toward the summit (full knowledge), or null at the summit. */
function nextStep(map: MapData, toSummit: Float64Array, x: number, y: number): Dir | null {
  const here = toSummit[tileIndex(x, y)];
  if (here === 0) return null;
  for (const d of DIR_LIST) {
    const c = stepCost(map, x, y, d);
    if (c === null) continue;
    const n = toSummit[tileIndex(x + DIRS[d].dx, y + DIRS[d].dy)];
    if (n + c === here) return d;
  }
  throw new Error('no descending step');
}

/** Walk the cheapest line to the summit on the game's map; returns the time after the last step. */
function walkToSummit(game: Game, t0: number): number {
  const map = game.state.map;
  const toSummit = minCostTo(map, map.summit.x, map.summit.y);
  let now = t0;
  for (let guard = 0; guard < 500 && game.state.phase === 'playing'; guard++) {
    const d = nextStep(map, toSummit, game.state.player.x, game.state.player.y);
    if (!d) break;
    now += 200;
    game.handleAction(d, now);
  }
  return now;
}

/** Pace back and forth beside the spawn until the surveyor collapses. */
function paceToCollapse(game: Game, t0: number): number {
  const s = game.state;
  const pair = DIR_LIST.find((d) => stepCost(s.map, s.player.x, s.player.y, d) !== null) as Dir;
  const back = DIR_LIST.find((d) => DIRS[d].dx === -DIRS[pair].dx && DIRS[d].dy === -DIRS[pair].dy) as Dir;
  let now = t0;
  for (let k = 0; game.state.phase === 'playing' && k < 400; k++) {
    now += 200;
    game.handleAction(k % 2 === 0 ? pair : back, now);
  }
  return now;
}

function mapFingerprint(map: MapData): unknown {
  return {
    seed: map.seed,
    elevation: Array.from(map.elevation),
    passMask: Array.from(map.passMask),
    cliffMask: Array.from(map.cliffMask),
    spawn: map.spawn,
    summit: map.summit,
    caches: map.caches,
    directCost: map.stats.directCost,
  };
}

const rawPercent = (s: GameState): number => (s.revealedCount / (MAP_W * MAP_H)) * 100;

describe('grade breakdown', () => {
  it('scores and grades exactly as the original formula', () => {
    for (const input of randomInputs(20000)) {
      const ref = referenceGrade(input);
      const b = gradeBreakdown(input);
      expect(b.score).toBe(ref.score);
      expect(gradeForScore(b.score)).toBe(ref.grade);
      expect(gradeVictory(input)).toBe(ref.grade);
    }
  });

  it('shows whole points that add up, stay within 1 of exact, and clear a threshold exactly when the score does', () => {
    const letter = (total: number): string => GRADE_THRESHOLDS.find(([, min]) => total >= Math.round(min * 100))?.[0] ?? 'C';
    for (const input of randomInputs(20000)) {
      const b = gradeBreakdown(input);
      const p = gradePoints(b);
      expect(p.route + p.reserve + p.survey).toBe(p.total);
      expect(Math.abs(p.route - b.route * 40)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.reserve - b.reserve * 35)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.survey - b.survey * 25)).toBeLessThanOrEqual(1);
      expect(letter(p.total)).toBe(gradeForScore(b.score));
    }
  });

  it('keeps the breakdown of a victory as graded, from the unrounded survey share', () => {
    const game = new Game(silent, generateMap, { seed: 205, now: 0, startPlaying: true });
    walkToSummit(game, 0);
    const s = game.state;
    expect(s.phase).toBe('summiting');
    const fs = s.finalStats!;
    expect(fs.breakdown).toEqual(
      gradeBreakdown({
        percentMapped: rawPercent(s),
        staminaLeft: fs.staminaLeft,
        staminaSpent: fs.staminaSpent,
        directCost: s.map.stats.directCost,
      }),
    );
    expect(fs.grade).toBe(gradeForScore(fs.breakdown!.score));
  });

  it('has no breakdown for a collapse (always F)', () => {
    const game = new Game(silent, generateMap, { seed: 555, now: 0, startPlaying: true });
    paceToCollapse(game, 0);
    expect(game.state.finalStats).toMatchObject({ outcome: 'defeat', grade: 'F', breakdown: null });
  });
});

describe('recorded step costs', () => {
  it('match the trail and add up to the stamina spent', () => {
    for (const [seed, play] of [
      [205, walkToSummit],
      [555, paceToCollapse],
    ] as const) {
      const game = new Game(silent, generateMap, { seed, now: 0, startPlaying: true });
      play(game, 0);
      const s = game.state;
      expect(s.stepCosts).toHaveLength(s.trail.length - 1);
      expect(s.stepCosts.every((c) => c === 1 || c === 3 || c === 8)).toBe(true);
      expect(s.stepCosts.reduce((a, c) => a + c, 0)).toBe(s.staminaSpent);
      s.stepCosts.forEach((c, k) => {
        const a = s.trail[k];
        const b = s.trail[k + 1];
        const d = DIR_LIST.find((dd) => a.x + DIRS[dd].dx === b.x && a.y + DIRS[dd].dy === b.y) as Dir;
        expect(stepCost(s.map, a.x, a.y, d)).toBe(c);
      });
    }
  });
});

describe('same-sheet retry', () => {
  it('starts a fresh expedition on the same seed and the same terrain, after a collapse or a summit', () => {
    for (const [seed, play, endMs] of [
      [555, paceToCollapse, COLLAPSE_ANIM_MS],
      [205, walkToSummit, VICTORY_ANIM_MS],
    ] as const) {
      const game = new Game(silent, generateMap, { seed, now: 0, startPlaying: true });
      const first = mapFingerprint(game.state.map);
      const now = play(game, 0) + endMs + 10;
      game.update(now);
      expect(['gameover', 'victory']).toContain(game.state.phase);
      game.retrySheet(now + 100);
      const s = game.state;
      expect(s.seed).toBe(seed);
      expect(mapFingerprint(s.map)).toEqual(first);
      expect(s.phase).toBe('playing');
      expect(s.turns).toBe(0);
      expect(s.stamina).toBe(MAX_STAMINA);
      expect(s.trail).toEqual([s.map.spawn]);
      expect(s.stepCosts).toEqual([]);
      expect(s.finalStats).toBeNull();
      // Exactly the start a fresh ?seed= link gives.
      const fresh = new Game(silent, generateMap, { seed, now: 0, startPlaying: true });
      expect(Array.from(s.revealed)).toEqual(Array.from(fresh.state.revealed));
      expect(s.player.x).toBe(fresh.state.player.x);
      expect(s.player.y).toBe(fresh.state.player.y);
    }
  });

  it('plays and grades a retry exactly like the first attempt', () => {
    const game = new Game(silent, generateMap, { seed: 205, now: 0, startPlaying: true });
    const now = walkToSummit(game, 0) + VICTORY_ANIM_MS + 10;
    game.update(now);
    const first = { ...game.state.finalStats!, elapsedMs: 0 };
    game.retrySheet(now + 100);
    walkToSummit(game, now + 100);
    expect({ ...game.state.finalStats!, elapsedMs: 0 }).toEqual(first);
  });

  it('is a new expedition only through restart, which rolls a different seed', () => {
    const game = new Game(silent, generateMap, { seed: 555, now: 0, startPlaying: true });
    const now = paceToCollapse(game, 0) + COLLAPSE_ANIM_MS + 10;
    game.update(now);
    game.handleAction('restart', now + 100);
    expect(game.state.seed).not.toBe(555);
  });

  it('records each attempt exactly once', () => {
    const game = new Game(silent, generateMap, { seed: 555, now: 0, startPlaying: true });
    const results: ExpeditionResult[] = [];
    const keeper = new RecordKeeper(game.state, (r) => results.push(r));
    let now = paceToCollapse(game, 0) + COLLAPSE_ANIM_MS + 10;
    game.update(now);
    keeper.sync(game.state);
    keeper.sync(game.state);
    game.retrySheet((now += 100));
    keeper.sync(game.state);
    expect(results.map((r) => r.outcome)).toEqual(['defeat']);
    now = paceToCollapse(game, now) + COLLAPSE_ANIM_MS + 10;
    game.update(now);
    keeper.sync(game.state);
    expect(results.map((r) => r.outcome)).toEqual(['defeat', 'defeat']);
  });
});

describe('report interface state', () => {
  it('starts on retry after a collapse and on a new expedition after a summit, fresh for each expedition', () => {
    const lost = new Game(silent, generateMap, { seed: 555, now: 0, startPlaying: true });
    lost.update(paceToCollapse(lost, 0) + COLLAPSE_ANIM_MS + 10);
    const r = reportFor(lost.state);
    expect(r.choice).toBe('retry');
    r.cardHidden = true;
    expect(reportFor(lost.state).cardHidden).toBe(true);

    const won = new Game(silent, generateMap, { seed: 205, now: 0, startPlaying: true });
    won.update(walkToSummit(won, 0) + VICTORY_ANIM_MS + 10);
    expect(reportFor(won.state)).toMatchObject({ choice: 'new', cardHidden: false });
  });

  it('maps H (and the Korean-layout key) to the report card toggle', () => {
    expect(keyToUiKey('KeyH', 'h')).toBe('card');
    expect(keyToUiKey('', 'H')).toBe('card');
    expect(keyToUiKey('', 'ㅗ')).toBe('card');
  });
});
