// Explorer C2 Step Echo (src/echo.ts): presentation only, strictly after the fact. It must echo only
// the step just taken, with the cost the game charged, never read the map, never appear outside
// Explorer play, and never pile up.
import { describe, expect, it } from 'vitest';
import { COST_FLAT, COST_GENTLE, COST_STEEP, MOVE_ANIM_MS } from '../src/config';
import { ECHO_GENTLE_MS, ECHO_STEEP_MS, stepEcho } from '../src/echo';
import type { StepEchoState } from '../src/echo';
import { Game } from '../src/game';
import { generateMap, minCostTo } from '../src/map';
import { mulberry32 } from '../src/rng';
import { stepCost, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, GameState, MapData } from '../src/types';
import { GOLDEN_SEEDS } from './support/fingerprint';

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

const start = (seed: number, mode: 'standard' | 'explorer'): Game =>
  new Game(silent, generateMap, { seed, now: 0, startPlaying: true, mode });

/** The same map with every tile's terrain replaced (an echo must not care). */
function scrambled(map: MapData): MapData {
  const elevation = map.elevation.map((_, i) => ((i * 7919) % 1000) / 1000);
  const passMask = map.passMask.map((_, i) => (i * 31) & 15);
  return { ...map, elevation, passMask };
}

/** Seeded random fresh presses, 200 ms apart; `check` runs after every press at its press time. */
function walk(seed: number, mode: 'standard' | 'explorer', check: (g: Game, now: number, moved: boolean) => void, steps = 200): void {
  const game = start(seed, mode);
  const rng = mulberry32(seed ^ 0xec40);
  for (let k = 0; k < steps && game.state.phase === 'playing'; k++) {
    const now = 200 * (k + 1);
    const turns = game.state.turns;
    game.handleAction(DIR_LIST[Math.floor(rng() * 4)], now);
    check(game, now, game.state.turns > turns);
  }
}

describe('Step Echo appears', () => {
  it('after every step that cost 3 or 8, with the cost charged and the step just taken', () => {
    const seen = new Map<number, number>();
    for (const seed of GOLDEN_SEEDS.slice(0, 30)) {
      walk(seed, 'explorer', (g, now, moved) => {
        const s = g.state;
        if (!moved || s.phase !== 'playing') return;
        const charged = s.stepCosts[s.stepCosts.length - 1];
        const echo = stepEcho(s, now + 400);
        if (charged === COST_FLAT) {
          expect(echo).toBeNull();
          return;
        }
        expect(echo).not.toBeNull();
        expect(echo?.cost).toBe(charged);
        expect(echo?.from).toEqual(s.trail[s.trail.length - 2]);
        expect(echo?.to).toEqual(s.trail[s.trail.length - 1]);
        seen.set(charged, (seen.get(charged) ?? 0) + 1);
      });
    }
    expect(seen.get(COST_GENTLE)).toBeGreaterThan(0);
    expect(seen.get(COST_STEEP)).toBeGreaterThan(0);
  });

  it('draws with the tween, shows the figure on arrival, fades, and is gone after its time', () => {
    for (const [seed, want] of [
      [100006, COST_STEEP],
      [100006, COST_GENTLE],
    ] as const) {
      const game = start(seed, 'explorer');
      const d = DIR_LIST.find((dir) => game.state.neighborCosts[dir] === want) as Dir;
      game.handleAction(d, 1000);
      const s = game.state;
      const life = want === COST_STEEP ? ECHO_STEEP_MS : ECHO_GENTLE_MS;
      expect(stepEcho(s, 999)).toBeNull();
      expect(stepEcho(s, 1000 + MOVE_ANIM_MS / 2)?.progress).toBeCloseTo(0.5);
      expect(stepEcho(s, 1000 + MOVE_ANIM_MS / 2)?.showCost).toBe(false);
      expect(stepEcho(s, 1000 + MOVE_ANIM_MS)?.showCost).toBe(true);
      expect(stepEcho(s, 1000 + MOVE_ANIM_MS)?.alpha).toBe(1);
      const late = stepEcho(s, 1000 + life - 1);
      expect(late?.alpha).toBeGreaterThan(0);
      expect(late?.alpha).toBeLessThan(0.05);
      expect(stepEcho(s, 1000 + life)).toBeNull();
    }
  });
});

describe('Step Echo does not appear', () => {
  it('in Standard, ever', () => {
    for (const seed of GOLDEN_SEEDS.slice(0, 30)) {
      walk(seed, 'standard', (g, now) => {
        for (const t of [now, now + 100, now + 400, now + 900]) expect(stepEcho(g.state, t)).toBeNull();
      });
    }
  });

  it('before the first step', () => {
    const s = start(100006, 'explorer').state;
    for (let t = 0; t <= 3000; t += 100) expect(stepEcho(s, t)).toBeNull();
  });

  it('for a blocked press: the latest real step keeps its echo (or none), nothing new', () => {
    let blocked = 0;
    for (const seed of GOLDEN_SEEDS.slice(30, 60)) {
      const game = start(seed, 'explorer');
      const rng = mulberry32(seed ^ 0xb10c);
      for (let k = 0; k < 200 && game.state.phase === 'playing'; k++) {
        const now = 200 * (k + 1);
        const d = DIR_LIST[Math.floor(rng() * 4)];
        const wall = game.state.neighborCosts[d] === null;
        const before = stepEcho(game.state, now + 50);
        const last = game.state.lastMove;
        game.handleAction(d, now);
        if (!wall) continue;
        blocked++;
        expect(game.state.lastMove).toBe(last);
        expect(stepEcho(game.state, now + 50)).toEqual(before);
      }
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it('once the expedition ends, on the title card, or on a retried sheet', () => {
    // Collapse on costly steps: pace back and forth on a slope.
    const game = start(100006, 'explorer');
    let now = 0;
    for (let k = 0; game.state.phase === 'playing' && k < 200; k++) {
      now += 200;
      game.handleAction(k % 2 === 0 ? 'down' : 'up', now);
    }
    expect(game.state.phase).toBe('collapsing');
    expect(game.state.lastMove?.cost).toBeGreaterThan(COST_FLAT);
    expect(stepEcho(game.state, now + 50)).toBeNull();
    game.update(now + 5000);
    expect(game.state.phase).toBe('gameover');
    expect(stepEcho(game.state, now + 100)).toBeNull();
    game.retrySheet(now + 6000);
    expect(stepEcho(game.state, now + 6050)).toBeNull();
    game.returnToTitle(now + 7000);
    expect(stepEcho(game.state, now + 7050)).toBeNull();

    // Reach the summit on a full-knowledge line: summiting and victory show no echo.
    const win = start(205, 'explorer');
    const map = win.state.map;
    const toSummit = minCostTo(map, map.summit.x, map.summit.y);
    let t = 0;
    for (let k = 0; win.state.phase === 'playing' && k < 400; k++) {
      const { x, y } = win.state.player;
      const here = toSummit[tileIndex(x, y)];
      const d = DIR_LIST.find((dir) => {
        const c = stepCost(map, x, y, dir);
        return c !== null && toSummit[tileIndex(x + DIRS[dir].dx, y + DIRS[dir].dy)] + c === here;
      }) as Dir;
      t += 200;
      win.handleAction(d, t);
    }
    expect(['summiting', 'gameover', 'collapsing']).toContain(win.state.phase);
    expect(stepEcho(win.state, t + 50)).toBeNull();
  });
});

describe('Step Echo data', () => {
  it('depends only on the step taken: bare state and scrambled terrain give the same echo', () => {
    const game = start(100006, 'explorer');
    game.handleAction('down', 1000);
    const s = game.state;
    expect(s.lastMove?.cost).toBe(COST_STEEP);
    const bare: StepEchoState = { mode: s.mode, phase: s.phase, player: s.player, lastMove: s.lastMove };
    const onScrambledSheet: GameState = { ...s, map: scrambled(s.map), revealed: new Uint8Array(s.revealed.length) };
    for (const t of [1000, 1050, 1300, 1800]) {
      expect(stepEcho(bare, t)).toEqual(stepEcho(s, t));
      expect(stepEcho(onScrambledSheet, t)).toEqual(stepEcho(s, t));
    }
  });

  it('never piles up: a new step replaces the last one outright', () => {
    for (const seed of GOLDEN_SEEDS.slice(0, 20)) {
      let previousTo: { x: number; y: number } | null = null;
      walk(seed, 'explorer', (g, now, moved) => {
        previousTo ??= g.state.trail[0];
        const echo = stepEcho(g.state, now + 10);
        // The echo is of this step alone: it starts where the step before ended, never further back.
        if (moved && echo) expect(echo.from).toEqual(previousTo);
        if (moved) previousTo = { x: g.state.player.x, y: g.state.player.y };
      });
    }
  });
});
