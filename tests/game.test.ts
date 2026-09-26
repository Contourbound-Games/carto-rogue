// Game-logic tests on hand-built 80x60 maps (no DOM, no real audio), plus vision checks on
// generated maps where idealised terrain would hide the problem.
import { describe, expect, it } from 'vitest';
import {
  CACHE_RESTORE,
  COLLAPSE_ANIM_MS,
  LOW_STAMINA,
  MAP_H,
  MAP_W,
  MAX_STAMINA,
  MOVE_REPEAT_MS,
  PALETTE,
  PANORAMA_COOLDOWN_TURNS,
  PANORAMA_TILE_THRESHOLD,
  VICTORY_ANIM_MS,
  VISION_HIGH,
  VISION_LOW,
  VISION_MID,
  WATER_LEVEL,
} from '../src/config';
import {
  Game,
  LOG_CAP,
  gradeVictory,
  groundHeight,
  hasLineOfSight,
  panoramaText,
  visionRadiusFor,
} from '../src/game';
import { setLang } from '../src/i18n';
import { keyToAction, parseSeed } from '../src/input';
import { generateMap, minCostTo } from '../src/map';
import { computeEdges, localSlopeAt, reachableFrom, stepCost, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { AudioEngine, Dir, DiscoveryKind, GameState, MapData, Peak, Point, SlopeClass } from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureSpec {
  /** Uniform elevation used when `elevation` is not given. */
  base?: number;
  elevation?: (x: number, y: number) => number;
  spawn?: Point;
  summit?: Point;
  caches?: Point[];
  /** Extra peaks; the summit is always appended as a peak, as the generator does. */
  peaks?: Peak[];
  directCost?: number;
}

function bilinear(elevation: Float32Array, tx: number, ty: number): number {
  const u = Math.min(MAP_W - 1, Math.max(0, tx - 0.5));
  const v = Math.min(MAP_H - 1, Math.max(0, ty - 0.5));
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(MAP_W - 1, x0 + 1);
  const y1 = Math.min(MAP_H - 1, y0 + 1);
  const fx = u - x0;
  const fy = v - y0;
  const e = (x: number, y: number): number => elevation[y * MAP_W + x];
  const top = e(x0, y0) * (1 - fx) + e(x1, y0) * fx;
  const bottom = e(x0, y1) * (1 - fx) + e(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function buildMap(spec: FixtureSpec = {}): MapData {
  const tiles = MAP_W * MAP_H;
  const elevation = new Float32Array(tiles);
  const water = new Uint8Array(tiles);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = tileIndex(x, y);
      elevation[i] = spec.elevation ? spec.elevation(x, y) : (spec.base ?? 0.3);
      water[i] = elevation[i] < WATER_LEVEL ? 1 : 0;
    }
  }
  const { passMask, cliffMask, cliffEdges } = computeEdges(elevation, water);
  const spawn = spec.spawn ?? { x: 40, y: 30 };
  const summit = spec.summit ?? { x: 70, y: 10 };
  const peaks: Peak[] = [
    ...(spec.peaks ?? []),
    { x: summit.x, y: summit.y, elevation: elevation[tileIndex(summit.x, summit.y)] },
  ];
  let waterTiles = 0;
  for (let i = 0; i < tiles; i++) waterTiles += water[i];
  return {
    seed: 0,
    width: MAP_W,
    height: MAP_H,
    elevation,
    water,
    passMask,
    cliffMask,
    spawn,
    summit,
    caches: (spec.caches ?? []).map((c, id) => ({ id, x: c.x, y: c.y, kind: 'plateau' as const })),
    peaks,
    stats: {
      attempts: 1,
      waterFraction: waterTiles / tiles,
      reachableFraction: 1,
      directCost: spec.directCost ?? 100,
      bestArrivalStamina: 40,
      cliffEdges,
      genMs: 0,
    },
    sampleElevation: (tx, ty) => bilinear(elevation, tx, ty),
  };
}

/** Recording AudioEngine. */
class MockAudio implements AudioEngine {
  muted: boolean;
  readonly calls: string[] = [];
  readonly footsteps: { elevation: number; slope: SlopeClass }[] = [];
  readonly discoveries: DiscoveryKind[] = [];

  constructor(muted = false) {
    this.muted = muted;
  }
  unlock(): void {
    this.calls.push('unlock');
  }
  toggleMute(): boolean {
    this.muted = !this.muted;
    this.calls.push('toggleMute');
    return this.muted;
  }
  footstep(elevation: number, slope: SlopeClass): void {
    this.footsteps.push({ elevation, slope });
    this.calls.push('footstep');
  }
  bump(): void {
    this.calls.push('bump');
  }
  cacheCollected(): void {
    this.calls.push('cacheCollected');
  }
  discovery(kind: DiscoveryKind): void {
    this.discoveries.push(kind);
    this.calls.push(`discovery:${kind}`);
  }
  lowStamina(): void {
    this.calls.push('lowStamina');
  }
  victory(): void {
    this.calls.push('victory');
  }
  defeat(): void {
    this.calls.push('defeat');
  }
  expeditionStart(): void {
    this.calls.push('expeditionStart');
  }
  stopAll(): void {
    this.calls.push('stopAll');
  }
  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
  reset(): void {
    this.calls.length = 0;
    this.footsteps.length = 0;
    this.discoveries.length = 0;
  }
}

interface Harness {
  game: Game;
  audio: MockAudio;
  seeds: number[];
  /** Monotonic clock: every call returns a time 200 ms after the previous one. */
  tick: () => number;
  move: (...dirs: ('up' | 'right' | 'down' | 'left')[]) => void;
  s: () => GameState;
}

/** Game on a fixture map (initial seed 0, which randomSeed() never produces). */
function setup(spec: FixtureSpec = {}, opts: { start?: boolean; muted?: boolean } = {}): Harness {
  const map = buildMap(spec);
  const seeds: number[] = [];
  const factory = (seed: number): MapData => {
    seeds.push(seed);
    return { ...map, seed };
  };
  const audio = new MockAudio(opts.muted ?? false);
  const game = new Game(audio, factory, { seed: 0, now: 0 });
  let clock = 0;
  const tick = (): number => (clock += 200);
  if (opts.start ?? true) {
    game.handleAction('confirm', tick());
    audio.reset();
  }
  return {
    game,
    audio,
    seeds,
    tick,
    move: (...dirs) => {
      for (const d of dirs) game.handleAction(d, tick());
    },
    s: () => game.state,
  };
}

function discCount(radius: number): number {
  const reach2 = (radius + 0.5) ** 2;
  let n = 0;
  for (let dy = -radius - 1; dy <= radius + 1; dy++) {
    for (let dx = -radius - 1; dx <= radius + 1; dx++) if (dx * dx + dy * dy <= reach2) n++;
  }
  return n;
}

const at = (x: number, y: number): number => tileIndex(x, y);
const logTexts = (state: GameState): string[] => state.log.map((l) => l.text);

/**
 * A 0.65 shelf west of x = 41, then a 0.69 (mid-band) crest with a 0.72 (high-band) knoll every
 * `period` tiles from x = 41. Walking east, each knoll is a big high-ground reveal: its radius-10
 * disc reaches `period` tiles past the last knoll's, while the crest between sees nothing new.
 */
const knolls =
  (period: number) =>
  (x: number): number =>
    x < 41 ? 0.65 : (x - 41) % period === 0 ? 0.72 : 0.69;

/** Steps right once and returns the number of tiles the step revealed for the first time. */
function stepRight(h: Harness, repeat = false): number {
  const before = h.s().revealedCount;
  h.game.handleAction('right', h.tick(), repeat);
  return h.s().revealedCount - before;
}

// ---------------------------------------------------------------------------
// Title phase
// ---------------------------------------------------------------------------

describe('title phase', () => {
  it('builds a complete initial state with a revealed patch around the spawn', () => {
    const { s } = setup({}, { start: false });
    const state = s();
    expect(state.phase).toBe('title');
    expect(state.startTime).toBe(0);
    expect(state.endTime).toBeNull();
    expect(state.stamina).toBe(MAX_STAMINA);
    expect(state.turns).toBe(0);
    expect(state.trail).toEqual([{ x: 40, y: 30 }]);
    expect(state.revealedCount).toBe(discCount(VISION_LOW));
    expect(state.revealed[at(40, 30)]).toBe(1);
    expect(state.visionRadius).toBe(VISION_LOW);
    expect(state.neighborCosts).toEqual({ up: 1, right: 1, down: 1, left: 1 });
    expect(state.log.length).toBeLessThanOrEqual(LOG_CAP);
  });

  it('starts on confirm without moving', () => {
    const { game, audio, s } = setup({}, { start: false });
    game.handleAction('confirm', 500);
    expect(s().phase).toBe('playing');
    expect(s().startTime).toBe(500);
    expect(s().phaseStart).toBe(500);
    expect(s().player).toMatchObject({ x: 40, y: 30 });
    expect(s().turns).toBe(0);
    expect(audio.count('expeditionStart')).toBe(1);
    expect(logTexts(s())).toContain('Expedition #0 begins.');
  });

  it('starts on a direction key, and that first key does not move', () => {
    const { game, audio, s } = setup({}, { start: false });
    game.handleAction('left', 700);
    expect(s().phase).toBe('playing');
    expect(s().player).toMatchObject({ x: 40, y: 30 });
    expect(s().stamina).toBe(MAX_STAMINA);
    expect(s().turns).toBe(0);
    expect(audio.count('footstep')).toBe(0);
    game.handleAction('left', 900);
    expect(s().player).toMatchObject({ x: 39, y: 30 });
  });

  it('restart from the title goes straight into a new expedition', () => {
    const { game, s, seeds } = setup({}, { start: false });
    game.handleAction('restart', 300);
    expect(s().phase).toBe('playing');
    expect(seeds.length).toBe(2);
    expect(s().seed).toBe(seeds[1]);
  });
});

// ---------------------------------------------------------------------------
// Movement & blocking
// ---------------------------------------------------------------------------

describe('movement', () => {
  it('moves in all four directions on flat ground', () => {
    const { game, s, audio } = setup();
    const t1 = 1000;
    game.handleAction('up', t1);
    expect(s().player).toMatchObject({ x: 40, y: 29, fromX: 40, fromY: 30, facing: 'up', moveStart: t1 });
    game.handleAction('right', 1200);
    expect(s().player).toMatchObject({ x: 41, y: 29, facing: 'right' });
    game.handleAction('down', 1400);
    expect(s().player).toMatchObject({ x: 41, y: 30, facing: 'down' });
    game.handleAction('left', 1600);
    expect(s().player).toMatchObject({ x: 40, y: 30, fromX: 41, fromY: 30, facing: 'left', moveStart: 1600 });
    expect(s().turns).toBe(4);
    expect(s().stamina).toBe(MAX_STAMINA - 4);
    expect(s().staminaSpent).toBe(4);
    expect(s().trail).toEqual([
      { x: 40, y: 30 },
      { x: 40, y: 29 },
      { x: 41, y: 29 },
      { x: 41, y: 30 },
      { x: 40, y: 30 },
    ]);
    expect(s().lastMove).toEqual({ cost: 1, slope: 'flat' });
    expect(audio.count('footstep')).toBe(4);
  });

  it('blocks the map edge without cost or turn and records a bump', () => {
    const { game, s, audio } = setup({ spawn: { x: 0, y: 30 } });
    game.handleAction('left', 1234);
    const state = s();
    expect(state.player).toMatchObject({ x: 0, y: 30, bumpStart: 1234, bumpDir: 'left', facing: 'left' });
    expect(state.stamina).toBe(MAX_STAMINA);
    expect(state.turns).toBe(0);
    expect(state.trail.length).toBe(1);
    expect(audio.count('bump')).toBe(1);
    expect(audio.count('footstep')).toBe(0);
    expect(logTexts(state)).toContain('The edge of the survey sheet.');
    expect(state.neighborCosts.left).toBeNull();
  });

  it('blocks water, while the lake itself is still surveyed', () => {
    const { game, s, audio } = setup({ elevation: (x, y) => (x === 39 && y === 30 ? 0.1 : 0.3) });
    expect(s().neighborCosts.left).toBeNull();
    game.handleAction('left', 1000);
    expect(s().player).toMatchObject({ x: 40, y: 30, bumpStart: 1000, bumpDir: 'left' });
    expect(s().stamina).toBe(MAX_STAMINA);
    expect(s().turns).toBe(0);
    expect(audio.count('bump')).toBe(1);
    expect(logTexts(s())).toContain('Water blocks the way.');
    expect(s().revealed[at(39, 30)]).toBe(1);
  });

  it('blocks sheer cliffs', () => {
    const { game, s, audio } = setup({ elevation: (x, y) => (x === 41 && y === 30 ? 0.45 : 0.3) });
    game.handleAction('right', 1000);
    expect(s().player).toMatchObject({ x: 40, y: 30, bumpDir: 'right', bumpStart: 1000 });
    expect(s().stamina).toBe(MAX_STAMINA);
    expect(s().turns).toBe(0);
    expect(audio.count('bump')).toBe(1);
    expect(logTexts(s())).toContain('A sheer cliff. No way through.');
    expect(s().neighborCosts.right).toBeNull();
    for (const line of s().log) expect(line.text.length).toBeLessThanOrEqual(30);
  });

  it('charges exactly 1 / 3 / 8 by slope and only 1 for the downhill return', () => {
    const row = [0.3, 0.305, 0.33, 0.4];
    const { game, s, audio } = setup({
      elevation: (x, y) => (y === 30 && x >= 40 && x <= 43 ? row[x - 40] : 0.3),
    });
    game.handleAction('right', 1000);
    expect(s().stamina).toBe(99);
    expect(s().lastMove).toEqual({ cost: 1, slope: 'flat' });
    game.handleAction('right', 1200);
    expect(s().stamina).toBe(96);
    expect(s().lastMove).toEqual({ cost: 3, slope: 'gentle' });
    expect(s().neighborCosts).toEqual({ up: 1, right: 8, down: 1, left: 1 });
    expect(s().localSlope).toBe('steep');
    game.handleAction('right', 1400);
    expect(s().stamina).toBe(88);
    expect(s().lastMove).toEqual({ cost: 8, slope: 'steep' });
    game.handleAction('left', 1600);
    expect(s().stamina).toBe(87);
    expect(s().lastMove).toEqual({ cost: 1, slope: 'flat' });
    expect(s().staminaSpent).toBe(13);
    expect(s().turns).toBe(4);
    expect(audio.footsteps.map((f) => f.slope)).toEqual(['flat', 'gentle', 'steep', 'flat']);
    expect(audio.footsteps[2].elevation).toBeCloseTo(0.4, 5);
    expect(s().maxElevation).toBeCloseTo(0.4, 5);
  });

  it('throttles held-key auto-repeat to MOVE_REPEAT_MS', () => {
    const { game, s } = setup();
    game.handleAction('right', 1000);
    expect(s().turns).toBe(1);
    game.handleAction('right', 1050, true);
    expect(s().turns).toBe(1);
    game.handleAction('right', 1000 + MOVE_REPEAT_MS - 1, true);
    expect(s().turns).toBe(1);
    game.handleAction('right', 1000 + MOVE_REPEAT_MS, true);
    expect(s().turns).toBe(2);
    // Fresh key presses are never throttled.
    game.handleAction('right', 1000 + MOVE_REPEAT_MS + 10);
    expect(s().turns).toBe(3);
  });

  it('does not spam the log when repeatedly bumping the same obstacle', () => {
    const { game, s, audio } = setup({ spawn: { x: 0, y: 30 } });
    const before = s().log.length;
    game.handleAction('left', 1000);
    game.handleAction('left', 1300);
    game.handleAction('left', 1600);
    expect(audio.count('bump')).toBe(3);
    expect(s().log.length).toBe(before + 1);
    game.handleAction('left', 5000);
    expect(s().log.length).toBe(Math.min(LOG_CAP, before + 2));
  });
});

describe('held keys', () => {
  const FATAL_TEXT = 'Too spent. Press again to go.';

  it('refuses a fatal held-key step, while a fresh press still takes it', () => {
    const { game, s, audio } = setup();
    s().stamina = 2;
    game.handleAction('right', 1000);
    expect(s().stamina).toBe(1);
    audio.reset();
    game.handleAction('right', 1000 + MOVE_REPEAT_MS, true);
    expect(s().player).toMatchObject({ x: 41, y: 30, bumpStart: 1000 + MOVE_REPEAT_MS, bumpDir: 'right' });
    expect(s().stamina).toBe(1);
    expect(s().turns).toBe(1);
    expect(s().phase).toBe('playing');
    expect(audio.calls).toEqual(['bump']);
    expect(s().log.at(-1)).toMatchObject({ text: FATAL_TEXT, tone: 'warn' });
    expect(FATAL_TEXT.length).toBeLessThanOrEqual(30);
    // Still holding: more thuds, but the warning is not repeated line after line.
    game.handleAction('right', 1000 + 2 * MOVE_REPEAT_MS, true);
    game.handleAction('right', 1000 + 3 * MOVE_REPEAT_MS, true);
    expect(audio.count('bump')).toBe(3);
    expect(logTexts(s()).filter((t) => t === FATAL_TEXT)).toHaveLength(1);
    // A deliberate fresh press follows the normal rules.
    game.handleAction('right', 2000);
    expect(s().phase).toBe('collapsing');
    expect(s().player).toMatchObject({ x: 42, y: 30 });
  });

  it('lets held-key steps through when they are not fatal', () => {
    const { game, s } = setup();
    s().stamina = 3;
    game.handleAction('right', 1000);
    game.handleAction('right', 1000 + MOVE_REPEAT_MS, true);
    expect(s().player.x).toBe(42);
    expect(s().stamina).toBe(1);
    expect(logTexts(s())).not.toContain(FATAL_TEXT);
  });

  it('lets a held key finish on the summit or an uncollected cache, which catch the last step', () => {
    const summit = setup({ summit: { x: 42, y: 30 }, elevation: (x, y) => (x === 42 && y === 30 ? 0.37 : 0.3) });
    summit.game.handleAction('right', 1000);
    summit.s().stamina = 5;
    summit.game.handleAction('right', 1000 + MOVE_REPEAT_MS, true);
    expect(summit.s().phase).toBe('summiting');

    const cache = setup({ caches: [{ x: 42, y: 30 }] });
    cache.game.handleAction('right', 1000);
    cache.s().stamina = 1;
    cache.game.handleAction('right', 1000 + MOVE_REPEAT_MS, true);
    expect(cache.s().phase).toBe('playing');
    expect(cache.s().cacheCollected).toEqual([true]);
    expect(cache.s().stamina).toBe(CACHE_RESTORE);
  });

  it('stops a held key where a cache comes into view until the key is pressed again', () => {
    const { game, s, audio } = setup({ caches: [{ x: 45, y: 30 }] });
    game.handleAction('right', 1000);
    game.handleAction('right', 1000 + MOVE_REPEAT_MS, true);
    expect(s().player.x).toBe(42);
    expect(s().cacheSighted).toEqual([true]);
    audio.reset();
    for (let k = 2; k <= 6; k++) game.handleAction('right', 1000 + k * MOVE_REPEAT_MS, true);
    expect(s().player.x).toBe(42);
    expect(audio.calls).toEqual([]);
    game.handleAction('right', 2000);
    expect(s().player.x).toBe(43);
    // The fresh press starts a new hold, which carries on normally.
    game.handleAction('right', 2000 + MOVE_REPEAT_MS, true);
    expect(s().player.x).toBe(44);
  });

  it('stops a held key after a panorama or a summit sighting', () => {
    const panorama = setup({ elevation: (x) => (x >= 41 ? 0.72 : 0.65) });
    panorama.game.handleAction('right', 1000);
    expect(panorama.s().effects.some((e) => e.kind === 'survey-burst')).toBe(true);
    panorama.game.handleAction('right', 1000 + MOVE_REPEAT_MS, true);
    expect(panorama.s().player.x).toBe(41);

    const summit = setup({ summit: { x: 45, y: 30 } });
    summit.game.handleAction('right', 1000);
    summit.game.handleAction('right', 1000 + MOVE_REPEAT_MS, true);
    expect(summit.s().summitSighted).toBe(true);
    expect(summit.s().player.x).toBe(42);
    summit.game.handleAction('right', 1000 + 2 * MOVE_REPEAT_MS, true);
    expect(summit.s().player.x).toBe(42);
  });

  it('keeps walking a held key over a big reveal inside the panorama cooldown', () => {
    const h = setup({ elevation: knolls(PANORAMA_COOLDOWN_TURNS) });
    // The burst on the first knoll (x 41) stops the hold.
    stepRight(h);
    stepRight(h, true);
    expect(h.s().player.x).toBe(41);
    // A fresh press, then a hold across the next knoll (x 45): it is no new panorama, so no halt.
    stepRight(h);
    const fresh: number[] = [];
    for (let k = 0; k <= PANORAMA_COOLDOWN_TURNS; k++) fresh.push(stepRight(h, true));
    expect(fresh[PANORAMA_COOLDOWN_TURNS - 2]).toBeGreaterThanOrEqual(PANORAMA_TILE_THRESHOLD);
    expect(h.s().player.x).toBe(43 + PANORAMA_COOLDOWN_TURNS);
    expect(h.audio.discoveries).toEqual(['panorama']);
  });
});

// ---------------------------------------------------------------------------
// Stamina, caches and outcomes
// ---------------------------------------------------------------------------

describe('caches and stamina', () => {
  it('restores CACHE_RESTORE stamina once per cache', () => {
    const { game, s, audio } = setup({ caches: [{ x: 41, y: 30 }] });
    s().stamina = 50;
    game.handleAction('right', 1000);
    expect(s().stamina).toBe(50 - 1 + CACHE_RESTORE);
    expect(s().cacheCollected).toEqual([true]);
    expect(audio.count('cacheCollected')).toBe(1);
    expect(logTexts(s())).toContain(`Cache: +${CACHE_RESTORE} stamina`);
    const kinds = s().effects.map((e) => e.kind);
    expect(kinds).toContain('cache-sparkle');
    expect(s().effects.find((e) => e.kind === 'float-text')?.text).toBe(`+${CACHE_RESTORE} STAMINA`);
    game.handleAction('left', 1200);
    game.handleAction('right', 1400);
    expect(s().stamina).toBe(50 - 3 + CACHE_RESTORE);
    expect(audio.count('cacheCollected')).toBe(1);
  });

  it('caps the restore at MAX_STAMINA and reports the actual gain', () => {
    const { game, s } = setup({ caches: [{ x: 41, y: 30 }] });
    s().stamina = 90;
    game.handleAction('right', 1000);
    expect(s().stamina).toBe(MAX_STAMINA);
    expect(s().effects.find((e) => e.kind === 'float-text')?.text).toBe('+11 STAMINA');
    expect(logTexts(s())).toContain('Cache: +11 stamina');
  });

  it('collects a cache before checking for collapse (rule 3 order)', () => {
    const { game, s, audio } = setup({ caches: [{ x: 41, y: 30 }] });
    s().stamina = 1;
    game.handleAction('right', 1000);
    expect(s().phase).toBe('playing');
    expect(s().stamina).toBe(CACHE_RESTORE);
    expect(audio.count('defeat')).toBe(0);
  });

  it('warns once when stamina drops below LOW_STAMINA and pulses on every move', () => {
    const { game, s, audio } = setup();
    s().stamina = LOW_STAMINA + 1;
    game.handleAction('right', 1000);
    expect(audio.count('lowStamina')).toBe(0);
    game.handleAction('right', 1200);
    game.handleAction('right', 1400);
    expect(audio.count('lowStamina')).toBe(2);
    expect(logTexts(s()).filter((t) => t.startsWith('Stamina low')).length).toBe(1);
  });

  it('collapses at 0 stamina, then shows Game Over after COLLAPSE_ANIM_MS', () => {
    const { game, s, audio } = setup();
    s().stamina = 2;
    game.handleAction('right', 1000);
    expect(s().phase).toBe('playing');
    game.handleAction('right', 1200);
    const state = s();
    expect(state.phase).toBe('collapsing');
    expect(state.stamina).toBe(0);
    expect(state.phaseStart).toBe(1200);
    expect(state.endTime).toBe(1200);
    expect(audio.count('defeat')).toBe(1);
    expect(state.finalStats).toMatchObject({ outcome: 'defeat', grade: 'F', turns: 2, staminaSpent: 2, staminaLeft: 0 });
    expect(state.log.at(-1)?.tone).toBe('bad');
    // Movement is ignored while the ink bleeds out.
    game.handleAction('left', 1300);
    expect(state.player).toMatchObject({ x: 42, y: 30 });
    game.update(1200 + COLLAPSE_ANIM_MS - 1);
    expect(s().phase).toBe('collapsing');
    game.update(1200 + COLLAPSE_ANIM_MS);
    expect(s().phase).toBe('gameover');
    expect(s().phaseStart).toBe(1200 + COLLAPSE_ANIM_MS);
  });

  it('clamps an overdrawn collapse to zero', () => {
    const { game, s } = setup({ elevation: (x) => (x === 41 ? 0.37 : 0.3) });
    s().stamina = 3;
    game.handleAction('right', 1000);
    expect(s().phase).toBe('collapsing');
    expect(s().stamina).toBe(0);
    expect(s().staminaSpent).toBe(8);
  });

  it('confirm on the Game Over card starts a new expedition', () => {
    const { game, s, seeds } = setup();
    s().stamina = 1;
    game.handleAction('right', 1000);
    game.update(1000 + COLLAPSE_ANIM_MS);
    expect(s().phase).toBe('gameover');
    game.handleAction('confirm', 5000);
    expect(s().phase).toBe('playing');
    expect(s().stamina).toBe(MAX_STAMINA);
    expect(seeds.length).toBe(2);
    expect(s().seed).not.toBe(0);
  });
});

describe('summit', () => {
  const summitSpec: FixtureSpec = {
    summit: { x: 41, y: 30 },
    elevation: (x, y) => (x === 41 && y === 30 ? 0.37 : 0.3),
  };

  it('wins on reaching the summit even when the final step overdraws stamina', () => {
    const { game, s, audio } = setup(summitSpec);
    s().stamina = 3;
    game.handleAction('right', 1000);
    const state = s();
    expect(state.phase).toBe('summiting');
    expect(state.phaseStart).toBe(1000);
    expect(state.endTime).toBe(1000);
    expect(state.stamina).toBe(0);
    expect(audio.count('victory')).toBe(1);
    expect(audio.count('defeat')).toBe(0);
    expect(state.effects.some((e) => e.kind === 'summit-flare')).toBe(true);
    expect(state.finalStats?.outcome).toBe('victory');
    expect(state.finalStats?.staminaSpent).toBe(8);
    expect(['S', 'A', 'B', 'C']).toContain(state.finalStats?.grade);
  });

  it('moves to the Victory card after VICTORY_ANIM_MS and restarts on confirm', () => {
    const { game, s, audio } = setup(summitSpec);
    game.handleAction('right', 1000);
    game.handleAction('left', 1100);
    expect(s().player).toMatchObject({ x: 41, y: 30 });
    game.update(1000 + VICTORY_ANIM_MS - 1);
    expect(s().phase).toBe('summiting');
    game.update(1000 + VICTORY_ANIM_MS);
    expect(s().phase).toBe('victory');
    const stats = s().finalStats;
    expect(stats).toMatchObject({ outcome: 'victory', turns: 1, staminaLeft: MAX_STAMINA - 8, cachesTotal: 0 });
    expect(stats?.percentMapped).toBeCloseTo((s().revealedCount / (MAP_W * MAP_H)) * 100, 1);
    audio.reset();
    game.handleAction('confirm', 9000);
    expect(s().phase).toBe('playing');
    expect(s().finalStats).toBeNull();
    expect(audio.calls).toEqual(['stopAll', 'expeditionStart']);
  });

  it('grades victories by route efficiency, reserve and survey coverage', () => {
    expect(gradeVictory({ percentMapped: 30, staminaLeft: 60, staminaSpent: 100, directCost: 100 })).toBe('S');
    expect(gradeVictory({ percentMapped: 18, staminaLeft: 30, staminaSpent: 125, directCost: 100 })).toBe('A');
    expect(gradeVictory({ percentMapped: 25, staminaLeft: 5, staminaSpent: 200, directCost: 100 })).toBe('B');
    expect(gradeVictory({ percentMapped: 8, staminaLeft: 2, staminaSpent: 260, directCost: 100 })).toBe('C');
  });
});

describe('terminal steps', () => {
  it('plays only the fanfare on a summit step that also bursts a panorama', () => {
    // 0.65 plateau; the summit is the lone 0.72 tile, so stepping onto it opens the high-ground view.
    const { game, s, audio } = setup({
      summit: { x: 42, y: 30 },
      elevation: (x, y) => (x === 42 && y === 30 ? 0.72 : 0.65),
    });
    game.handleAction('right', 1000);
    expect(s().summitSighted).toBe(true);
    audio.reset();
    const before = s().revealedCount;
    game.handleAction('right', 1200);
    expect(s().phase).toBe('summiting');
    expect(s().revealedCount - before).toBeGreaterThanOrEqual(PANORAMA_TILE_THRESHOLD);
    expect(audio.calls).toEqual(['footstep', 'victory']);
    // The summit-flare plays alone; the panorama is still logged.
    const kinds = s().effects.filter((e) => e.start === 1200).map((e) => e.kind);
    expect(kinds).toEqual(['summit-flare']);
    expect(logTexts(s()).some((t) => t.startsWith('Panoramic survey!'))).toBe(true);
    expect(s().log.at(-1)?.text).toBe('Trig Pillar reached!');
  });

  it('plays only the drone on a collapse step that sights a cache', () => {
    const { game, s, audio } = setup({ caches: [{ x: 44, y: 30 }] });
    expect(s().cacheSighted).toEqual([false]);
    s().stamina = 1;
    game.handleAction('right', 1000);
    expect(s().phase).toBe('collapsing');
    expect(s().cacheSighted).toEqual([true]);
    expect(audio.calls).toEqual(['footstep', 'defeat']);
    expect(logTexts(s()).slice(-2)).toEqual(['Supply cache spotted.', 'You collapse, exhausted.']);
  });

  it('keeps discovery chimes on ordinary steps', () => {
    const { game, audio } = setup({ caches: [{ x: 44, y: 30 }] });
    game.handleAction('right', 1000);
    expect(audio.calls).toEqual(['footstep', 'discovery:cache']);
  });
});

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

describe('vision', () => {
  it('maps elevation to vision radius bands', () => {
    expect(visionRadiusFor(0.3)).toBe(VISION_LOW);
    expect(visionRadiusFor(0.399)).toBe(VISION_LOW);
    expect(visionRadiusFor(0.4)).toBe(VISION_MID);
    expect(visionRadiusFor(0.55)).toBe(VISION_MID);
    expect(visionRadiusFor(0.7)).toBe(VISION_MID);
    expect(visionRadiusFor(0.701)).toBe(VISION_HIGH);
    expect(visionRadiusFor(0.8)).toBe(VISION_HIGH);
  });

  it.each([
    [0.3, VISION_LOW, 37],
    [0.55, VISION_MID, 97],
    [0.8, VISION_HIGH, discCount(VISION_HIGH)],
  ])('flat plateau at %f sees radius %i (%i tiles)', (elev, radius, tiles) => {
    const { s } = setup({ base: elev });
    const state = s();
    expect(state.visionRadius).toBe(radius);
    expect(state.revealedCount).toBe(tiles);
    let visible = 0;
    for (let i = 0; i < state.visible.length; i++) visible += state.visible[i];
    expect(visible).toBe(tiles);
    // Straight out to the radius is visible, one tile further is not.
    expect(state.visible[at(40 + radius, 30)]).toBe(1);
    expect(state.visible[at(40, 30 - radius)]).toBe(1);
    expect(state.revealed[at(40 + radius + 1, 30)]).toBe(0);
    expect(state.revealed[at(40, 30 + radius + 1)]).toBe(0);
  });

  it('uses the centre distance radius + 0.5 on diagonals', () => {
    const { s } = setup({ base: 0.8 });
    expect(s().visible[at(47, 37)]).toBe(1); // 7,7 -> 9.90
    expect(s().visible[at(48, 38)]).toBe(0); // 8,8 -> 11.31
    expect(s().visible[at(49, 34)]).toBe(1); // 9,4 -> 9.85
    expect(s().visible[at(50, 33)]).toBe(1); // 10,3 -> 10.44
    expect(s().visible[at(50, 34)]).toBe(0); // 10,4 -> 10.77
  });

  it('lets a ridge block line of sight from a valley', () => {
    const ridge: FixtureSpec = { elevation: (x) => (x === 42 ? 0.38 : 0.3) };
    const { s } = setup(ridge);
    const state = s();
    expect(state.visionRadius).toBe(VISION_LOW);
    expect(state.visible[at(42, 30)]).toBe(1); // the ridge crest itself
    expect(state.visible[at(43, 30)]).toBe(0); // dead ground behind it
    expect(state.revealed[at(43, 30)]).toBe(0);
    expect(state.visible[at(37, 30)]).toBe(1); // open side
    expect(hasLineOfSight(state.map, 40, 30, 43, 30)).toBe(false);
    expect(hasLineOfSight(state.map, 40, 30, 37, 30)).toBe(true);
    // Without the ridge the same tile is in view.
    expect(setup().s().visible[at(43, 30)]).toBe(1);
  });

  it('keeps lowland sightlines strict but gives the high ground clearance over minor crests', () => {
    // A 1-tile crest one contour interval (0.03 = 36 m) high, then a 0.06 one: same geometry at two altitudes.
    const crest = (base: number, height: number) => (x: number) => (x === 44 ? base + height : base);
    expect(hasLineOfSight(buildMap({ elevation: crest(0.3, 0.03) }), 40, 30, 47, 30)).toBe(false);
    expect(hasLineOfSight(buildMap({ elevation: crest(0.55, 0.03) }), 40, 30, 47, 30)).toBe(false);
    expect(hasLineOfSight(buildMap({ elevation: crest(0.8, 0.03) }), 40, 30, 47, 30)).toBe(true);
    expect(hasLineOfSight(buildMap({ elevation: crest(0.8, 0.06) }), 40, 30, 47, 30)).toBe(false);
  });

  it('looks across a lake to the far shore and sees the water at its surface', () => {
    // Low shores (0.24) around a deep lake (bed 0.05, surface WATER_LEVEL).
    const lake = (x: number, y: number): number => (x >= 42 && x <= 44 && y >= 28 && y <= 32 ? 0.05 : 0.24);
    const { s } = setup({ elevation: lake });
    const map = s().map;
    expect(map.water[at(43, 30)]).toBe(1);
    expect(hasLineOfSight(map, 40, 30, 45, 30)).toBe(true);
    expect(hasLineOfSight(map, 40, 30, 46, 31)).toBe(true);
    expect(hasLineOfSight(map, 45, 30, 40, 29)).toBe(true);
    // Aimed at the lake bed, the sightline would dive under the near bank; the surface is in view.
    expect(s().visible[at(43, 30)]).toBe(1);
    // From the water's edge the whole width of the lake is surveyed.
    const shore = setup({ elevation: lake, spawn: { x: 41, y: 30 } }).s();
    for (let x = 42; x <= 44; x++) expect(shore.visible[at(x, 30)]).toBe(1);
  });

  it('handles sightlines along the sheet edge', () => {
    // Corner spawn: only the in-sheet quarter of the disc is surveyed.
    const corner = setup({ spawn: { x: 0, y: 0 } });
    let quarter = 0;
    for (let y = 0; y <= VISION_LOW; y++) {
      for (let x = 0; x <= VISION_LOW; x++) if (x * x + y * y <= (VISION_LOW + 0.5) ** 2) quarter++;
    }
    expect(corner.s().revealedCount).toBe(quarter);
    expect(corner.s().visible[at(3, 0)]).toBe(1);
    expect(corner.s().visible[at(0, 3)]).toBe(1);
    // A crest on the edge row still blocks a sightline that runs along it.
    const edgeRidge = buildMap({ elevation: (x, y) => (x === 2 && y === MAP_H - 1 ? 0.38 : 0.3) });
    expect(hasLineOfSight(edgeRidge, 0, MAP_H - 1, 4, MAP_H - 1)).toBe(false);
    expect(hasLineOfSight(edgeRidge, 0, MAP_H - 2, 4, MAP_H - 2)).toBe(true);
    expect(hasLineOfSight(edgeRidge, MAP_W - 1, MAP_H - 1, MAP_W - 5, MAP_H - 1)).toBe(true);
  });

  it('clamps groundHeight to the sheet instead of reading past its edges', () => {
    const map = buildMap({ elevation: (x, y) => 0.3 + x * 0.001 + y * 0.0001 });
    const e = (x: number, y: number): number => map.elevation[at(x, y)];
    expect(groundHeight(map, 40.5, 30.5)).toBeCloseTo(e(40, 30), 6);
    expect(groundHeight(map, 41, 30.5)).toBeCloseTo((e(40, 30) + e(41, 30)) / 2, 6);
    expect(groundHeight(map, 0.2, 30.5)).toBeCloseTo(e(0, 30), 6);
    expect(groundHeight(map, 40.5, 59.9)).toBeCloseTo(e(40, 59), 6);
    expect(groundHeight(map, -3, -3)).toBeCloseTo(e(0, 0), 6);
    expect(groundHeight(map, MAP_W + 4, MAP_H + 4)).toBeCloseTo(e(MAP_W - 1, MAP_H - 1), 6);
  });

  it('always shows the 8 neighbours, even below a towering wall', () => {
    const { s } = setup({ elevation: (x, y) => (Math.abs(x - 40) + Math.abs(y - 30) === 1 ? 0.39 : 0.3) });
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) expect(s().visible[at(40 + dx, 30 + dy)]).toBe(1);
    }
  });

  it('keeps surveyed tiles revealed after moving away', () => {
    const { game, s } = setup();
    expect(s().revealed[at(37, 30)]).toBe(1);
    const initial = s().revealedCount;
    for (let i = 0; i < 4; i++) game.handleAction('right', 1000 + i * 200);
    expect(s().player.x).toBe(44);
    expect(s().visible[at(37, 30)]).toBe(0);
    expect(s().revealed[at(37, 30)]).toBe(1);
    expect(s().revealedCount).toBeGreaterThan(initial);
    let revealed = 0;
    for (let i = 0; i < s().revealed.length; i++) revealed += s().revealed[i];
    expect(s().revealedCount).toBe(revealed);
  });
});

describe('vision on generated maps', () => {
  /** Tiles in view with the surveyor standing on (x,y), through the real vision update. */
  function visibleFrom(map: MapData, x: number, y: number): number {
    const game = new Game(new MockAudio(), () => ({ ...map, spawn: { x, y } }), { seed: map.seed });
    return game.state.visible.reduce((n, v) => n + v, 0);
  }

  /** A cheapest (cache-free) spawn -> summit route, walking down the minCostTo field. */
  function cheapestRoute(map: MapData): Dir[] {
    const toSummit = minCostTo(map, map.summit.x, map.summit.y);
    const route: Dir[] = [];
    let { x, y } = map.spawn;
    while (x !== map.summit.x || y !== map.summit.y) {
      let next: Dir | null = null;
      for (const d of DIR_LIST) {
        const cost = stepCost(map, x, y, d);
        if (cost !== null && toSummit[tileIndex(x + DIRS[d].dx, y + DIRS[d].dy)] + cost === toSummit[tileIndex(x, y)]) {
          next = d;
          break;
        }
      }
      if (next === null) throw new Error(`seed ${map.seed}: no cheapest step from ${x},${y}`);
      route.push(next);
      x += DIRS[next].dx;
      y += DIRS[next].dy;
    }
    return route;
  }

  it('opens up most of the radius-10 disc from high ground (seeds 1-10)', () => {
    // Real terrain is rounded: with strict sightlines the shoulder of the hill underfoot hid most of
    // the disc (p10 about 50 tiles, mean about 112 here). With the high-band clearance: about 134 / 200.
    const views: number[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const map = generateMap(seed);
      const reach = reachableFrom(map, map.spawn.x, map.spawn.y);
      for (let y = VISION_HIGH; y < MAP_H - VISION_HIGH; y++) {
        for (let x = VISION_HIGH; x < MAP_W - VISION_HIGH; x++) {
          const i = tileIndex(x, y);
          if (reach[i] && visionRadiusFor(map.elevation[i]) === VISION_HIGH) views.push(visibleFrom(map, x, y));
        }
      }
    }
    views.sort((a, b) => a - b);
    const mean = views.reduce((a, b) => a + b, 0) / views.length;
    expect(views.length).toBeGreaterThan(500);
    // Even the poorest vantages beat a flat mid-band disc, and the average one sees half the panorama.
    expect(views[Math.floor(views.length * 0.1)]).toBeGreaterThanOrEqual(discCount(VISION_MID));
    expect(mean).toBeGreaterThanOrEqual(discCount(VISION_HIGH) / 2);
  }, 30_000);

  it('usually fires the panorama on the first step into the high band (cheapest routes, seeds 1-60)', () => {
    // Strict sightlines: about 30% of routes; with the clearance: about 80%.
    const seeds = 60;
    let bursts = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const map = generateMap(seed);
      const game = new Game(new MockAudio(), () => map, { seed });
      let now = 0;
      game.handleAction('confirm', (now += 200));
      for (const dir of cheapestRoute(map)) {
        const before = game.state.revealedCount;
        // The route ignores caches; only the view along it matters here.
        game.state.stamina = MAX_STAMINA;
        game.handleAction(dir, (now += 200));
        if (game.state.visionRadius === VISION_HIGH) {
          if (game.state.revealedCount - before >= PANORAMA_TILE_THRESHOLD) bursts++;
          break;
        }
      }
    }
    expect(bursts).toBeGreaterThanOrEqual((seeds * 2) / 3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Slope reading
// ---------------------------------------------------------------------------

describe('slope reading', () => {
  it('reads only passable uphill steps, like the step costs', () => {
    const at41 = (e: number) => (x: number, y: number) => (x === 41 && y === 30 ? e : 0.3);
    // Downhill by 0.045 costs 1: flat, although the ground falls away steeply.
    expect(localSlopeAt(buildMap({ elevation: at41(0.255) }), 40, 30)).toBe('flat');
    // Next to a cliff (0.15 up, impassable) every step that can be taken costs 1: flat.
    expect(localSlopeAt(buildMap({ elevation: at41(0.45) }), 40, 30)).toBe('flat');
    // Water neighbours are not steps either.
    expect(localSlopeAt(buildMap({ elevation: at41(0.1) }), 40, 30)).toBe('flat');
    expect(localSlopeAt(buildMap({ elevation: at41(0.31) }), 40, 30)).toBe('flat');
    expect(localSlopeAt(buildMap({ elevation: at41(0.33) }), 40, 30)).toBe('moderate');
    expect(localSlopeAt(buildMap({ elevation: at41(0.37) }), 40, 30)).toBe('steep');
    // The same neighbour seen from above: all downhill.
    expect(localSlopeAt(buildMap({ elevation: at41(0.37) }), 41, 30)).toBe('flat');
  });

  it('matches the dearest available step on generated maps', () => {
    const reading: Record<number, string> = { 1: 'flat', 3: 'moderate', 8: 'steep' };
    const mismatches: string[] = [];
    for (const seed of [1, 2, 3]) {
      const map = generateMap(seed);
      for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
          let dearest = 1;
          for (const d of DIR_LIST) dearest = Math.max(dearest, stepCost(map, x, y, d) ?? 1);
          if (localSlopeAt(map, x, y) !== reading[dearest]) mismatches.push(`seed ${seed} tile ${x},${y}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('is what the HUD reads after a step', () => {
    // East of (41,30) the ground falls 0.045 (a cost-1 step), north of it rises 0.03 (cost 3).
    const { game, s } = setup({
      elevation: (x, y) => (x === 42 && y === 30 ? 0.255 : x === 41 && y === 29 ? 0.33 : 0.3),
    });
    game.handleAction('right', 1000);
    expect(s().neighborCosts).toEqual({ up: 3, right: 1, down: 1, left: 1 });
    expect(s().localSlope).toBe('moderate');
    game.handleAction('down', 1200);
    expect(s().localSlope).toBe('flat');
  });
});

// ---------------------------------------------------------------------------
// Discoveries
// ---------------------------------------------------------------------------

describe('discoveries', () => {
  it('plays only the highest-priority chime but records every sighting', () => {
    const { game, s, audio } = setup({
      summit: { x: 44, y: 30 },
      caches: [{ x: 44, y: 31 }],
      peaks: [{ x: 44, y: 29, elevation: 0.75 }],
    });
    expect(s().summitSighted).toBe(false);
    expect(s().cacheSighted).toEqual([false]);
    game.handleAction('right', 1000);
    expect(audio.discoveries).toEqual(['summit']);
    expect(s().summitSighted).toBe(true);
    expect(s().cacheSighted).toEqual([true]);
    expect(s().peakSighted).toEqual([true, true]);
    const texts = logTexts(s());
    expect(texts).toContain('Trig Pillar sighted!');
    // The peak is tracked, but its line would only crowd the summit sighting out of the 4-line log.
    expect(texts.some((t) => t.startsWith('Peak'))).toBe(false);
    expect(texts).toContain('Supply cache spotted.');
    const label = s().effects.find((e) => e.kind === 'float-text');
    expect(label).toMatchObject({ x: 44, y: 30 });
    expect(s().effects.some((e) => e.kind === 'summit-flare')).toBe(false);
  });

  it('chimes for a lone cache or peak sighting', () => {
    const cache = setup({ caches: [{ x: 44, y: 31 }] });
    cache.game.handleAction('right', 1000);
    expect(cache.audio.discoveries).toEqual(['cache']);

    const peak = setup({ peaks: [{ x: 44, y: 29, elevation: 0.5 }] });
    peak.game.handleAction('right', 1000);
    expect(peak.audio.discoveries).toEqual(['peak']);
    expect(logTexts(peak.s())).toContain('Peak sighted: 600 m');
  });

  it('bursts a panoramic survey when climbing into high vision', () => {
    const { game, s, audio } = setup({ elevation: (x) => (x >= 41 ? 0.72 : 0.65) });
    expect(s().visionRadius).toBe(VISION_MID);
    const before = s().revealedCount;
    game.handleAction('right', 1000);
    expect(s().lastMove).toEqual({ cost: 8, slope: 'steep' });
    expect(s().visionRadius).toBe(VISION_HIGH);
    const fresh = s().revealedCount - before;
    expect(fresh).toBeGreaterThanOrEqual(40);
    expect(audio.discoveries).toEqual(['panorama']);
    const burst = s().effects.find((e) => e.kind === 'survey-burst');
    expect(burst).toMatchObject({ x: 41, y: 30, radius: VISION_HIGH, start: 1000 });
    expect(logTexts(s())).toContain(`Panoramic survey! +${fresh} tiles`);
  });

  it('ranks summit above panorama, and panorama above peaks and caches', () => {
    const plateau = (x: number): number => (x >= 41 ? 0.72 : 0.65);
    const withSummit = setup({ elevation: plateau, summit: { x: 48, y: 30 } });
    expect(withSummit.s().summitSighted).toBe(false);
    withSummit.game.handleAction('right', 1000);
    expect(withSummit.s().summitSighted).toBe(true);
    expect(withSummit.s().effects.some((e) => e.kind === 'survey-burst')).toBe(true);
    expect(withSummit.audio.discoveries).toEqual(['summit']);

    const withOthers = setup({
      elevation: plateau,
      caches: [{ x: 45, y: 24 }],
      peaks: [{ x: 45, y: 36, elevation: 0.72 }],
    });
    expect(withOthers.s().cacheSighted).toEqual([false]);
    withOthers.game.handleAction('right', 1000);
    expect(withOthers.s().cacheSighted).toEqual([true]);
    expect(withOthers.s().peakSighted[0]).toBe(true);
    expect(withOthers.audio.discoveries).toEqual(['panorama']);
  });

  it('folds new peaks into the panorama line', () => {
    const plateau = (x: number): number => (x >= 41 ? 0.72 : 0.65);
    const peaks: Peak[] = [
      { x: 45, y: 36, elevation: 0.72 },
      { x: 48, y: 26, elevation: 0.72 },
      { x: 36, y: 22, elevation: 0.65 },
    ];
    const { game, s } = setup({ elevation: plateau, peaks });
    const before = s().revealedCount;
    game.handleAction('right', 1000);
    const fresh = s().revealedCount - before;
    const texts = logTexts(s());
    expect(texts.slice(-1)).toEqual([`Panorama +${fresh} tiles, 3 peaks`]);
    expect(texts.some((t) => t.startsWith('Peak') || t.includes('peaks sighted'))).toBe(false);
    expect(s().peakSighted).toEqual([true, true, true, false]);
    // Worst case: the cooldown's running total can pass one 349-tile disc, but never the whole
    // sheet, and a sheet has at most a dozen peaks.
    expect(panoramaText(MAP_W * MAP_H, 12).length).toBeLessThanOrEqual(30);
    expect(panoramaText(MAP_W * MAP_H, 0).length).toBeLessThanOrEqual(30);

    const single = setup({ elevation: plateau, peaks: peaks.slice(0, 1) });
    single.game.handleAction('right', 1000);
    expect(logTexts(single.s()).at(-1)).toMatch(/^Panorama \+\d+ tiles, 1 peak$/);
  });

  it('keeps a big reveal inside PANORAMA_COOLDOWN_TURNS quiet and adds it to the panorama line', () => {
    // The next knoll is reached exactly PANORAMA_COOLDOWN_TURNS turns after the burst on the first.
    const h = setup({ elevation: knolls(PANORAMA_COOLDOWN_TURNS) });
    const first = stepRight(h);
    expect(h.s().visionRadius).toBe(VISION_HIGH);
    expect(h.audio.discoveries).toEqual(['panorama']);
    const entry = h.s().log.at(-1);
    expect(entry?.text).toBe(`Panoramic survey! +${first} tiles`);
    const lines = h.s().log.length;

    const fresh: number[] = [];
    for (let k = 0; k < PANORAMA_COOLDOWN_TURNS; k++) fresh.push(stepRight(h));
    const second = fresh.at(-1) ?? 0;
    expect(h.s().turns).toBe(1 + PANORAMA_COOLDOWN_TURNS);
    expect(h.s().visionRadius).toBe(VISION_HIGH);
    // A reveal that would have burst on its own, while the crest between the knolls saw nothing new.
    expect(second).toBeGreaterThanOrEqual(PANORAMA_TILE_THRESHOLD);
    expect(fresh.slice(0, -1).every((n) => n === 0)).toBe(true);
    expect(h.audio.discoveries).toEqual(['panorama']);
    expect(h.s().effects.filter((e) => e.kind === 'survey-burst')).toHaveLength(1);
    // The same line, updated in place and marked as the newest again.
    expect(h.s().log).toHaveLength(lines);
    expect(h.s().log.at(-1)).toBe(entry);
    expect(entry).toMatchObject({ text: `Panoramic survey! +${first + second} tiles`, time: h.s().player.moveStart });
  });

  it('bursts again once the panorama cooldown has run out', () => {
    const h = setup({ elevation: knolls(PANORAMA_COOLDOWN_TURNS + 1) });
    const first = stepRight(h);
    let second = 0;
    for (let k = 0; k <= PANORAMA_COOLDOWN_TURNS; k++) second = stepRight(h);
    expect(h.s().turns).toBe(2 + PANORAMA_COOLDOWN_TURNS);
    expect(second).toBeGreaterThanOrEqual(PANORAMA_TILE_THRESHOLD);
    expect(h.audio.discoveries).toEqual(['panorama', 'panorama']);
    const bursts = h.s().effects.filter((e) => e.kind === 'survey-burst');
    expect(bursts.map((e) => e.x)).toEqual([41, 42 + PANORAMA_COOLDOWN_TURNS]);
    expect(logTexts(h.s()).slice(-2)).toEqual([`Panoramic survey! +${first} tiles`, `Panoramic survey! +${second} tiles`]);
  });

  it('folds peaks seen inside the cooldown into the panorama line, which still chime', () => {
    // (45,36) is in view from the first knoll; (55,30) only from the second one, at x 45.
    const early: Peak = { x: 45, y: 36, elevation: 0.72 };
    const late: Peak = { x: 55, y: 30, elevation: 0.72 };
    const walk = (peaks: Peak[]): { h: Harness; tiles: number } => {
      const h = setup({ elevation: knolls(PANORAMA_COOLDOWN_TURNS), peaks });
      let tiles = 0;
      for (let k = 0; k <= PANORAMA_COOLDOWN_TURNS; k++) tiles += stepRight(h);
      return { h, tiles };
    };

    const plain = walk([late]);
    expect(plain.h.s().peakSighted).toEqual([true, false]);
    expect(logTexts(plain.h.s()).at(-1)).toBe(`Panorama +${plain.tiles} tiles, 1 peak`);
    expect(logTexts(plain.h.s()).some((t) => t.startsWith('Panoramic') || t.startsWith('Peak'))).toBe(false);
    expect(plain.h.audio.discoveries).toEqual(['panorama', 'peak']);

    const folded = walk([early, late]);
    expect(folded.h.s().peakSighted).toEqual([true, true, false]);
    expect(logTexts(folded.h.s()).filter((t) => t.startsWith('Panoram'))).toEqual([
      `Panorama +${folded.tiles} tiles, 2 peaks`,
    ]);
    expect(folded.h.audio.discoveries).toEqual(['panorama', 'peak']);
  });

  it('leaves the panorama line alone once another line has followed it', () => {
    const h = setup({ elevation: knolls(PANORAMA_COOLDOWN_TURNS) });
    const first = stepRight(h);
    h.game.handleAction('mute', h.tick());
    let second = 0;
    for (let k = 0; k < PANORAMA_COOLDOWN_TURNS; k++) second = stepRight(h);
    expect(second).toBeGreaterThanOrEqual(PANORAMA_TILE_THRESHOLD);
    // Still inside the cooldown: no burst, chime or new line, and the old line keeps its count.
    expect(h.audio.discoveries).toEqual(['panorama']);
    expect(h.s().effects.filter((e) => e.kind === 'survey-burst')).toHaveLength(1);
    expect(logTexts(h.s()).slice(-2)).toEqual([`Panoramic survey! +${first} tiles`, 'Sound off.']);
  });

  it('starts every expedition with the panorama cooldown cleared', () => {
    const h = setup({ elevation: knolls(PANORAMA_COOLDOWN_TURNS) });
    stepRight(h);
    h.game.newExpedition(h.tick(), 77);
    expect(h.s().turns).toBe(0);
    stepRight(h);
    expect(h.audio.discoveries).toEqual(['panorama', 'panorama']);
    expect(h.s().effects.filter((e) => e.kind === 'survey-burst')).toHaveLength(1);
    expect(logTexts(h.s()).at(-1)).toMatch(/^Panoramic survey! \+\d+ tiles$/);
  });

  it('labels every newly spotted cache on the sheet, like the summit', () => {
    const { game, s } = setup({
      summit: { x: 44, y: 30 },
      // The third cache is already in view at the spawn, so it is not news.
      caches: [
        { x: 44, y: 31 },
        { x: 44, y: 29 },
        { x: 41, y: 31 },
      ],
    });
    expect(s().cacheSighted).toEqual([false, false, true]);
    game.handleAction('right', 1000);
    const labels = s().effects.filter((e) => e.kind === 'float-text');
    expect(labels.map((e) => [e.text, e.x, e.y])).toEqual([
      ['TRIG PILLAR', 44, 30],
      ['CACHE', 44, 31],
      ['CACHE', 44, 29],
    ]);
    for (const e of labels.slice(1)) {
      expect(e).toMatchObject({ color: PALETTE.brassDark, start: 1000, duration: labels[0].duration });
    }
    expect(logTexts(s())).toContain('2 supply caches spotted.');
    // Walking out of view and back does not label them again.
    game.handleAction('left', 1200);
    game.handleAction('left', 1400);
    game.handleAction('right', 1600);
    game.handleAction('right', 1800);
    expect(s().effects.filter((e) => e.kind === 'float-text' && e.text === 'CACHE')).toHaveLength(2);
  });

  it('drops the sighting label of a cache once it is collected', () => {
    const { s, move } = setup({ caches: [{ x: 44, y: 31 }] });
    move('right');
    expect(s().effects.filter((e) => e.text === 'CACHE')).toHaveLength(1);
    // Collected well inside the label's lifetime: only the pickup text floats over the cache.
    move('right', 'right', 'right', 'down');
    expect(s().cacheCollected).toEqual([true]);
    expect(s().effects.filter((e) => e.kind === 'float-text').map((e) => e.text)).toEqual(['+5 STAMINA']);
  });

  it('prunes expired effects in update()', () => {
    const { game, s } = setup({ caches: [{ x: 41, y: 30 }] });
    game.handleAction('right', 1000);
    expect(s().effects.length).toBeGreaterThan(0);
    game.update(1100);
    expect(s().effects.length).toBeGreaterThan(0);
    game.update(60000);
    expect(s().effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Restart, mute and log
// ---------------------------------------------------------------------------

describe('restart and mute', () => {
  it('restart gives a new seed and resets everything', () => {
    const { game, s, audio, seeds } = setup({ caches: [{ x: 41, y: 30 }] });
    const initialRevealed = s().revealed.slice();
    const oldMap = s().map;
    s().stamina = 60;
    game.handleAction('right', 1000);
    game.handleAction('right', 1200);
    game.handleAction('up', 1400);
    expect(s().cacheCollected).toEqual([true]);
    expect(s().effects.length).toBeGreaterThan(0);
    audio.reset();

    game.handleAction('restart', 2000);
    const state = s();
    expect(audio.calls).toEqual(['stopAll', 'expeditionStart']);
    expect(seeds).toHaveLength(2);
    const seed = seeds[1];
    expect(seed).not.toBe(0);
    expect(seed).toBeGreaterThanOrEqual(1);
    expect(seed).toBeLessThanOrEqual(999999);
    expect(state.seed).toBe(seed);
    expect(state.map.seed).toBe(seed);
    expect(state.map).not.toBe(oldMap);
    expect(state.phase).toBe('playing');
    expect(state.phaseStart).toBe(2000);
    expect(state.startTime).toBe(2000);
    expect(state.endTime).toBeNull();
    expect(state.finalStats).toBeNull();
    expect(state.stamina).toBe(MAX_STAMINA);
    expect(state.turns).toBe(0);
    expect(state.staminaSpent).toBe(0);
    expect(state.trail).toEqual([{ x: 40, y: 30 }]);
    expect(state.player).toMatchObject({ x: 40, y: 30, fromX: 40, fromY: 30, bumpStart: -Infinity });
    expect(state.revealedCount).toBe(discCount(VISION_LOW));
    expect(Array.from(state.revealed)).toEqual(Array.from(initialRevealed));
    expect(state.cacheCollected).toEqual([false]);
    expect(state.effects).toEqual([]);
    expect(state.lastMove).toBeNull();
    expect(state.log.map((l) => l.text)[0]).toBe(`Expedition #${seed} begins.`);
    expect(state.log.every((l) => l.time === 2000)).toBe(true);
  });

  it('restart works during end animations and on end cards', () => {
    const { game, s, seeds } = setup();
    s().stamina = 1;
    game.handleAction('right', 1000);
    expect(s().phase).toBe('collapsing');
    game.handleAction('restart', 1100);
    expect(s().phase).toBe('playing');
    expect(seeds).toHaveLength(2);
    // A held R key does not regenerate the map over and over.
    game.handleAction('restart', 1200, true);
    expect(seeds).toHaveLength(2);
  });

  it('newExpedition accepts an explicit seed', () => {
    const { game, s, seeds } = setup();
    game.newExpedition(4000, 424242);
    expect(seeds.at(-1)).toBe(424242);
    expect(s().seed).toBe(424242);
    expect(s().phase).toBe('playing');
  });

  it('mute toggles state.muted in any phase and starts from the engine value', () => {
    const { game, s, audio } = setup({}, { start: false, muted: true });
    expect(s().muted).toBe(true);
    game.handleAction('mute', 100);
    expect(s().muted).toBe(false);
    expect(s().phase).toBe('title');
    game.handleAction('confirm', 200);
    game.handleAction('mute', 300);
    expect(s().muted).toBe(true);
    game.handleAction('mute', 400, true); // auto-repeat of a held M is ignored
    expect(s().muted).toBe(true);
    expect(audio.count('toggleMute')).toBe(2);
    game.handleAction('restart', 500);
    expect(s().muted).toBe(true);
  });

  it('caps the log and keeps every line within 30 characters', () => {
    const { game, s } = setup({ spawn: { x: 0, y: 30 } });
    for (let i = 0; i < 12; i++) game.handleAction('mute', 1000 + i * 10);
    game.handleAction('left', 2000);
    expect(s().log.length).toBeLessThanOrEqual(LOG_CAP);
    for (const line of s().log) expect(line.text.length).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// Input mapping
// ---------------------------------------------------------------------------

describe('parseSeed', () => {
  it('treats an absent or blank parameter as no seed', () => {
    expect(parseSeed(null)).toBeUndefined();
    expect(parseSeed('')).toBeUndefined();
    expect(parseSeed('   ')).toBeUndefined();
  });

  it('accepts every 32-bit unsigned integer Number() can read', () => {
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed('-0')).toBe(0);
    expect(parseSeed('12345')).toBe(12345);
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed('4294967295')).toBe(0xffffffff);
    expect(parseSeed('0x10')).toBe(16);
    expect(parseSeed('1e3')).toBe(1000);
  });

  it('rejects anything else', () => {
    for (const raw of ['-5', '4294967296', '12.5', 'abc', '1e10', 'Infinity', 'NaN', '7 seas']) {
      expect(parseSeed(raw), raw).toBeNull();
    }
  });
});

describe('keyToAction', () => {
  it('maps physical codes first', () => {
    expect(keyToAction('KeyW', 'w')).toBe('up');
    expect(keyToAction('KeyA', 'a')).toBe('left');
    expect(keyToAction('KeyS', 's')).toBe('down');
    expect(keyToAction('KeyD', 'd')).toBe('right');
    expect(keyToAction('ArrowUp', 'ArrowUp')).toBe('up');
    expect(keyToAction('ArrowRight', 'ArrowRight')).toBe('right');
    expect(keyToAction('ArrowDown', 'ArrowDown')).toBe('down');
    expect(keyToAction('ArrowLeft', 'ArrowLeft')).toBe('left');
    expect(keyToAction('KeyR', 'r')).toBe('restart');
    expect(keyToAction('KeyM', 'm')).toBe('mute');
    expect(keyToAction('Enter', 'Enter')).toBe('confirm');
    expect(keyToAction('NumpadEnter', 'Enter')).toBe('confirm');
    expect(keyToAction('Space', ' ')).toBe('confirm');
    // Layout independence: AZERTY's physical W key produces 'z'.
    expect(keyToAction('KeyW', 'z')).toBe('up');
  });

  it('handles the Korean layout and IME composition', () => {
    expect(keyToAction('KeyW', 'ㅈ')).toBe('up');
    expect(keyToAction('KeyA', 'ㅁ')).toBe('left');
    expect(keyToAction('KeyS', 'ㄴ')).toBe('down');
    expect(keyToAction('KeyD', 'ㅇ')).toBe('right');
    expect(keyToAction('KeyR', 'ㄱ')).toBe('restart');
    expect(keyToAction('KeyM', 'ㅡ')).toBe('mute');
    expect(keyToAction('KeyW', 'Process')).toBe('up');
    expect(keyToAction('', 'ㅈ')).toBe('up');
  });

  it('falls back to the key value, case-insensitively', () => {
    expect(keyToAction('', 'W')).toBe('up');
    expect(keyToAction('', 'a')).toBe('left');
    expect(keyToAction('', 'S')).toBe('down');
    expect(keyToAction('', 'd')).toBe('right');
    expect(keyToAction('', 'R')).toBe('restart');
    expect(keyToAction('', 'm')).toBe('mute');
    expect(keyToAction('', 'Enter')).toBe('confirm');
    expect(keyToAction('', ' ')).toBe('confirm');
    expect(keyToAction('Unidentified', 'ArrowLeft')).toBe('left');
  });

  it('ignores everything else', () => {
    expect(keyToAction('KeyQ', 'q')).toBeNull();
    expect(keyToAction('ShiftLeft', 'Shift')).toBeNull();
    expect(keyToAction('Escape', 'Escape')).toBeNull();
    expect(keyToAction('', 'constructor')).toBeNull();
    expect(keyToAction('Tab', 'Tab')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shared seed links and localisation
// ---------------------------------------------------------------------------

describe('seed links and language', () => {
  it('starts straight into play on the requested seed when startPlaying is set', () => {
    const map = buildMap();
    const audio = new MockAudio();
    const seeds: number[] = [];
    const game = new Game(
      audio,
      (seed) => {
        seeds.push(seed);
        return { ...map, seed };
      },
      { seed: 721405, now: 50, startPlaying: true },
    );
    expect(seeds).toEqual([721405]);
    expect(game.state.phase).toBe('playing');
    expect(game.state.startTime).toBe(50);
    expect(game.state.seed).toBe(721405);
    expect(audio.count('expeditionStart')).toBe(1);
    expect(game.state.log.map((e) => e.text)).toContain('Expedition #721405 begins.');
  });

  it('writes log lines and float texts in the active language', () => {
    setLang('ko', false);
    try {
      const h = setup();
      expect(h.s().log.map((e) => e.text)).toContain('삼각점 정상을 찾아라.');
      const x = h.s().player.x;
      h.s().player.x = 0;
      h.move('left');
      expect(h.s().log.at(-1)?.text).toBe('측량 도면의 끝이다.');
      h.s().player.x = x;
    } finally {
      setLang('en', false);
    }
    expect(panoramaText(40, 0)).toBe('Panoramic survey! +40 tiles');
  });
});

describe('typed seed (ENTER SEED)', () => {
  it('startSeed begins a fresh expedition on exactly that seed, like a ?seed= link', () => {
    const h = setup({}, { start: false });
    expect(h.s().phase).toBe('title');
    h.game.startSeed(1000, 721405);
    expect(h.seeds.at(-1)).toBe(721405);
    expect(h.s().phase).toBe('playing');
    expect(h.s().seed).toBe(721405);
    expect(h.s().turns).toBe(0);
    expect(h.s().stamina).toBe(MAX_STAMINA);
    expect(h.audio.count('stopAll')).toBe(1);
    expect(h.audio.count('expeditionStart')).toBe(1);

    const viaLink = new Game(new MockAudio(), (seed) => ({ ...buildMap(), seed }), { seed: 721405, now: 1000, startPlaying: true });
    expect(viaLink.state.seed).toBe(h.s().seed);
    expect(viaLink.state.player).toEqual(h.s().player);
    expect(Array.from(viaLink.state.revealed)).toEqual(Array.from(h.s().revealed));
  });
});
