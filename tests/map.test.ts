// Map generation, validation and stamina-feasibility tests.
import { describe, expect, it } from 'vitest';
import {
  CACHE_MAX_COUNT,
  CACHE_MIN_COUNT,
  CACHE_MIN_SPACING,
  CACHE_RESTORE,
  DIRECT_COST_MAX,
  DIRECT_COST_MIN,
  FEASIBILITY_MARGIN,
  MAP_H,
  MAP_W,
  MAX_STAMINA,
  SLOPE_GENTLE_MAX,
  SPAWN_MAX_ELEV,
  SPAWN_MIN_ELEV,
  SUMMIT_MIN_ELEV,
  WATER_LEVEL,
} from '../src/config';
import {
  ROUTE_DETOUR_MAX,
  bestArrivalStamina,
  cliffEdgeFraction,
  generateMap,
  minCostFrom,
  minCostTo,
  validateMap,
} from '../src/map';
import { mulberry32 } from '../src/rng';
import { computeEdges, localSlopeAt, reachableFrom, stepCost, tileIndex } from '../src/terrain';
import { DIRS, DIR_LIST } from '../src/types';
import type { CacheSite, MapData, Point } from '../src/types';

/** 40 varied seeds: small, large and arbitrary player-style seeds. */
const SEEDS: number[] = Array.from({ length: 40 }, (_, k) => (k * 7919 + 13) % 999999 || 1);

const cache = new Map<number, MapData>();
function mapFor(seed: number): MapData {
  let m = cache.get(seed);
  if (!m) {
    m = generateMap(seed);
    cache.set(seed, m);
  }
  return m;
}

const chebyshev = (a: Point, b: Point): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const elevAt = (m: MapData, p: Point): number => m.elevation[tileIndex(p.x, p.y)];
/** Tiles between p and the nearest sheet border (0 = on the border row / column). */
const edgeDistance = (p: Point): number => Math.min(p.x, p.y, MAP_W - 1 - p.x, MAP_H - 1 - p.y);

function highestLand(m: MapData): number {
  let top = 0;
  for (let i = 0; i < m.elevation.length; i++) if (!m.water[i]) top = Math.max(top, m.elevation[i]);
  return top;
}

/**
 * Independent re-derivation of cache collectability: a FIFO label-correcting search over (tile, collected
 * caches) that uses terrain.stepCost and the game's arrival order (the summit ends the run, a cache refills
 * before the collapse check, stamina <= 0 anywhere else is fatal). Per cache: can any survivable play take it?
 */
function collectableCaches(m: MapData): boolean[] {
  const n = MAP_W * MAP_H;
  // Per tile and direction: stamina cost (0 = impassable) and the neighbour's index.
  const costs = new Uint8Array(n * 4);
  const target = new Int32Array(n * 4);
  for (let tile = 0; tile < n; tile++) {
    const x = tile % MAP_W;
    const y = (tile - x) / MAP_W;
    DIR_LIST.forEach((dir, d) => {
      costs[tile * 4 + d] = stepCost(m, x, y, dir) ?? 0;
      target[tile * 4 + d] = tileIndex(x + DIRS[dir].dx, y + DIRS[dir].dy);
    });
  }
  const bitAt = new Int8Array(n).fill(-1);
  m.caches.forEach((c, b) => (bitAt[tileIndex(c.x, c.y)] = b));
  const summit = tileIndex(m.summit.x, m.summit.y);
  const best = new Int16Array(n << m.caches.length); // per (mask, tile): best stamina so far, 0 = unreached
  const start = tileIndex(m.spawn.x, m.spawn.y);
  best[start] = MAX_STAMINA;
  const queue = [start];
  const collectable = m.caches.map(() => false);
  for (let h = 0; h < queue.length; h++) {
    const state = queue[h];
    const tile = state % n;
    const mask = (state - tile) / n;
    for (let d = 0; d < 4; d++) {
      const cost = costs[tile * 4 + d];
      if (cost === 0) continue;
      const next = target[tile * 4 + d];
      if (next === summit) continue; // the expedition ends there
      let left = best[state] - cost;
      let nextMask = mask;
      const bit = bitAt[next];
      if (bit >= 0 && !(mask & (1 << bit))) {
        left = Math.min(MAX_STAMINA, left + CACHE_RESTORE);
        nextMask |= 1 << bit;
        if (left > 0) collectable[bit] = true;
      }
      if (left <= 0) continue;
      const idx = nextMask * n + next;
      if (left > best[idx]) {
        best[idx] = left;
        queue.push(idx);
      }
    }
  }
  return collectable;
}

describe('generateMap over many seeds', () => {
  it('always produces maps that pass validateMap', () => {
    for (const seed of SEEDS) {
      const report = validateMap(mapFor(seed));
      expect(report.reasons, `seed ${seed}`).toEqual([]);
      expect(report.ok, `seed ${seed}`).toBe(true);
    }
  });

  it('keeps the player-facing seed and grid dimensions', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      expect(m.seed).toBe(seed);
      expect(m.width).toBe(MAP_W);
      expect(m.height).toBe(MAP_H);
      expect(m.elevation.length).toBe(MAP_W * MAP_H);
    }
  });

  it('places the spawn in the lowland band on open, cliff-free ground', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      const e = elevAt(m, m.spawn);
      expect(e).toBeGreaterThanOrEqual(SPAWN_MIN_ELEV);
      expect(e).toBeLessThanOrEqual(SPAWN_MAX_ELEV);
      expect(m.passMask[tileIndex(m.spawn.x, m.spawn.y)]).toBe(15);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = m.spawn.x + dx;
          const y = m.spawn.y + dy;
          if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) expect(m.cliffMask[tileIndex(x, y)]).toBe(0);
        }
      }
    }
  });

  it('puts the summit above 0.8 as the highest tile reachable from the spawn', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      const summitElev = elevAt(m, m.summit);
      expect(summitElev).toBeGreaterThan(SUMMIT_MIN_ELEV);
      const reach = reachableFrom(m, m.spawn.x, m.spawn.y);
      expect(reach[tileIndex(m.summit.x, m.summit.y)]).toBe(1);
      for (let i = 0; i < reach.length; i++) if (reach[i]) expect(m.elevation[i]).toBeLessThanOrEqual(summitElev);
      // Peaks are sorted highest first and always include the summit.
      expect(m.peaks[0].elevation).toBeGreaterThanOrEqual(summitElev);
      expect(m.peaks.some((p) => p.x === m.summit.x && p.y === m.summit.y)).toBe(true);
    }
  });

  it('lists peaks highest first, each a strict local maximum', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const m = mapFor(seed);
      expect(m.peaks.length).toBeGreaterThan(0);
      expect(m.peaks.length).toBeLessThanOrEqual(12);
      for (let k = 1; k < m.peaks.length; k++) expect(m.peaks[k - 1].elevation).toBeGreaterThanOrEqual(m.peaks[k].elevation);
      for (const p of m.peaks) {
        expect(p.elevation).toBe(elevAt(m, p));
        const isSummit = p.x === m.summit.x && p.y === m.summit.y;
        if (!isSummit) expect(p.elevation).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it('places 4-6 reachable, well-spaced caches on plateaus or saddles', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      expect(m.caches.length).toBeGreaterThanOrEqual(CACHE_MIN_COUNT);
      expect(m.caches.length).toBeLessThanOrEqual(CACHE_MAX_COUNT);
      const reach = reachableFrom(m, m.spawn.x, m.spawn.y);
      m.caches.forEach((c: CacheSite, k) => {
        expect(c.id).toBe(k);
        expect(['plateau', 'saddle']).toContain(c.kind);
        const i = tileIndex(c.x, c.y);
        expect(m.water[i]).toBe(0);
        expect(reach[i]).toBe(1);
        expect(chebyshev(c, m.spawn)).toBeGreaterThanOrEqual(CACHE_MIN_SPACING);
        expect(chebyshev(c, m.summit)).toBeGreaterThanOrEqual(CACHE_MIN_SPACING);
        for (let j = 0; j < k; j++) expect(chebyshev(c, m.caches[j])).toBeGreaterThanOrEqual(CACHE_MIN_SPACING);
      });
    }
  });

  it('puts saddle caches on level cols, never on a steep crag flank', () => {
    let saddles = 0;
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      const e = m.elevation;
      for (const c of m.caches) {
        if (c.kind !== 'saddle') continue;
        saddles++;
        const i = tileIndex(c.x, c.y);
        const gradient = Math.hypot((e[i + 1] - e[i - 1]) / 2, (e[i + MAP_W] - e[i - MAP_W]) / 2);
        expect(gradient, `seed ${seed} cache ${c.id}`).toBeLessThanOrEqual(0.02);
        // No way out of the col is a steep climb (checked here directly, not only via the HUD reading).
        for (const dir of DIR_LIST) {
          if (!(m.passMask[i] & DIRS[dir].bit)) continue;
          const rise = e[tileIndex(c.x + DIRS[dir].dx, c.y + DIRS[dir].dy)] - e[i];
          expect(rise, `seed ${seed} cache ${c.id} ${dir}`).toBeLessThanOrEqual(SLOPE_GENTLE_MAX);
        }
        expect(localSlopeAt(m, c.x, c.y), `seed ${seed} cache ${c.id}`).not.toBe('steep');
      }
    }
    expect(saddles).toBeGreaterThan(SEEDS.length);
  });

  it('makes every cache collectable by some survivable play', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      expect(collectableCaches(m), `seed ${seed}`).toEqual(m.caches.map(() => true));
    }
  });

  it('keeps the spawn and the summit at least 3 tiles inside the sheet border', () => {
    // Seed 4 once spawned at (1, 21) and seed 2003 put the Trig Pillar on row 0.
    for (const seed of [...SEEDS, 4, 2003]) {
      const m = mapFor(seed);
      expect(edgeDistance(m.spawn), `seed ${seed} spawn`).toBeGreaterThanOrEqual(3);
      expect(edgeDistance(m.summit), `seed ${seed} summit`).toBeGreaterThanOrEqual(3);
    }
  });

  it('never lets higher, unreachable land overlook the summit', () => {
    // On these seeds the first terrain attempt(s) raise a cliff-ringed spire above all reachable ground,
    // so the generator has to move on to another terrain.
    for (const seed of [...SEEDS, 380405, 19, 597, 863801, 203, 2075, 2403, 400535, 876, 2821, 10487]) {
      const m = mapFor(seed);
      expect(highestLand(m) - elevAt(m, m.summit), `seed ${seed}`).toBeLessThanOrEqual(0.004);
      expect(validateMap(m).reasons, `seed ${seed}`).toEqual([]);
    }
  });

  it('puts at least two caches on or near a cheap spawn -> summit route', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      const fromSpawn = minCostFrom(m, m.spawn.x, m.spawn.y);
      const toSummit = minCostTo(m, m.summit.x, m.summit.y);
      const direct = fromSpawn[tileIndex(m.summit.x, m.summit.y)];
      expect(toSummit[tileIndex(m.spawn.x, m.spawn.y)]).toBe(direct);
      const onRoute = m.caches.filter((c) => {
        const i = tileIndex(c.x, c.y);
        return fromSpawn[i] + toSummit[i] - direct <= ROUTE_DETOUR_MAX;
      });
      expect(onRoute.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('meets the direct-cost band and the feasibility margin with consistent stats', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      const report = validateMap(m);
      const direct = minCostFrom(m, m.spawn.x, m.spawn.y)[tileIndex(m.summit.x, m.summit.y)];
      expect(direct).toBeGreaterThanOrEqual(DIRECT_COST_MIN);
      expect(direct).toBeLessThanOrEqual(DIRECT_COST_MAX);
      expect(report.directCost).toBe(direct);
      expect(m.stats.directCost).toBe(direct);

      const best = bestArrivalStamina(m);
      expect(best).toBeGreaterThanOrEqual(FEASIBILITY_MARGIN);
      expect(report.bestArrivalStamina).toBe(best);
      expect(m.stats.bestArrivalStamina).toBe(best);
    }
  });

  it('fills every MapStats field consistently', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      const s = m.stats;
      expect(Number.isInteger(s.attempts) && s.attempts >= 1).toBe(true);
      let water = 0;
      let land = 0;
      for (let i = 0; i < m.water.length; i++) {
        if (m.water[i]) water++;
        else land++;
      }
      expect(s.waterFraction).toBeCloseTo(water / m.water.length, 12);
      expect(s.waterFraction).toBeGreaterThanOrEqual(0.07);
      expect(s.waterFraction).toBeLessThanOrEqual(0.18);
      const reach = reachableFrom(m, m.spawn.x, m.spawn.y);
      const reached = reach.reduce((a, b) => a + b, 0);
      expect(s.reachableFraction).toBeCloseTo(reached / land, 12);
      expect(s.cliffEdges).toBe(computeEdges(m.elevation, m.water).cliffEdges);
      expect(s.cliffEdges).toBeGreaterThan(0);
      expect(cliffEdgeFraction(m)).toBeLessThanOrEqual(0.06);
      expect(Number.isFinite(s.genMs) && s.genMs >= 0).toBe(true);
    }
  });
});

describe('determinism and tile / field consistency', () => {
  it('reproduces the identical map for the same seed', () => {
    for (const seed of [1, 424242, 999999, 31337]) {
      const a = generateMap(seed);
      const b = generateMap(seed);
      expect(Array.from(b.elevation)).toEqual(Array.from(a.elevation));
      expect(Array.from(b.passMask)).toEqual(Array.from(a.passMask));
      expect(b.spawn).toEqual(a.spawn);
      expect(b.summit).toEqual(a.summit);
      expect(b.caches).toEqual(a.caches);
      expect(b.peaks).toEqual(a.peaks);
      expect(b.stats.attempts).toBe(a.stats.attempts);
      for (const [x, y] of [
        [0.1, 0.1],
        [12.34, 56.78],
        [79.9, 59.9],
        [40.5, 30.25],
      ]) {
        expect(b.sampleElevation(x, y)).toBe(a.sampleElevation(x, y));
      }
    }
  });

  it('gives different seeds different maps', () => {
    const a = mapFor(SEEDS[0]);
    const b = mapFor(SEEDS[1]);
    let diff = 0;
    for (let i = 0; i < a.elevation.length; i++) if (a.elevation[i] !== b.elevation[i]) diff++;
    expect(diff).toBeGreaterThan(a.elevation.length * 0.9);
  });

  it('stores exactly fround(sampleElevation) at every tile centre, with matching water and edge masks', () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const m = mapFor(seed);
      for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
          const i = tileIndex(x, y);
          expect(m.elevation[i]).toBe(Math.fround(m.sampleElevation(x + 0.5, y + 0.5)));
          expect(m.water[i]).toBe(m.elevation[i] < WATER_LEVEL ? 1 : 0);
        }
      }
      const edges = computeEdges(m.elevation, m.water);
      expect(Array.from(m.passMask)).toEqual(Array.from(edges.passMask));
      expect(Array.from(m.cliffMask)).toEqual(Array.from(edges.cliffMask));
    }
  });

  it('samples a continuous, bounded field (tiny steps give tiny changes)', () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const m = mapFor(seed);
      const rng = mulberry32(seed ^ 0xabcdef);
      for (let k = 0; k < 20000; k++) {
        const x = -0.5 + rng() * (MAP_W + 1);
        const y = -0.5 + rng() * (MAP_H + 1);
        const e = m.sampleElevation(x, y);
        expect(e >= 0 && e <= 1).toBe(true);
        // The steepest cliff faces measure about 1.6 elevation units per tile; 3 leaves ample margin
        // while any jump (discontinuity) would blow straight through it.
        for (const h of [1e-3, 1e-5]) {
          expect(Math.abs(m.sampleElevation(x + h, y) - e)).toBeLessThanOrEqual(3 * h + 1e-12);
          expect(Math.abs(m.sampleElevation(x, y + h) - e)).toBeLessThanOrEqual(3 * h + 1e-12);
        }
      }
    }
  });

  it('includes lakes, sheer cliffs and a real mountain', () => {
    for (const seed of SEEDS) {
      const m = mapFor(seed);
      let hasWater = false;
      let maxLand = 0;
      for (let i = 0; i < m.elevation.length; i++) {
        if (m.water[i]) hasWater = true;
        else maxLand = Math.max(maxLand, m.elevation[i]);
      }
      expect(hasWater).toBe(true);
      expect(maxLand).toBeGreaterThan(0.8);
      expect(cliffEdgeFraction(m)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule-mirroring checks on hand-built maps
// ---------------------------------------------------------------------------

/**
 * A serpentine one-tile corridor of flat land (every step costs 1) through a lake: rows y = 2, 4, 6 ...
 * joined alternately at x = 78 and x = 1. Returns the map and the ordered corridor tiles.
 */
function corridorMap(): { map: MapData; path: Point[] } {
  const elevation = new Float32Array(MAP_W * MAP_H).fill(0.1);
  const path: Point[] = [];
  for (let r = 0; 2 + 2 * r < MAP_H - 1; r++) {
    const y = 2 + 2 * r;
    const leftToRight = r % 2 === 0;
    for (let k = 0; k < 78; k++) path.push({ x: leftToRight ? 1 + k : 78 - k, y });
    if (y + 2 < MAP_H - 1) path.push({ x: leftToRight ? 78 : 1, y: y + 1 });
  }
  for (const p of path) elevation[tileIndex(p.x, p.y)] = Math.fround(0.3);
  const water = new Uint8Array(MAP_W * MAP_H);
  for (let i = 0; i < water.length; i++) water[i] = elevation[i] < WATER_LEVEL ? 1 : 0;
  const { passMask, cliffMask, cliffEdges } = computeEdges(elevation, water);
  const map: MapData = {
    seed: 0,
    width: MAP_W,
    height: MAP_H,
    elevation,
    water,
    passMask,
    cliffMask,
    spawn: path[0],
    summit: path[1],
    caches: [],
    peaks: [],
    stats: {
      attempts: 1,
      waterFraction: 0,
      reachableFraction: 1,
      directCost: 0,
      bestArrivalStamina: 0,
      cliffEdges,
      genMs: 0,
    },
    sampleElevation: (tx: number, ty: number) => {
      const x = Math.min(MAP_W - 1, Math.max(0, Math.floor(tx)));
      const y = Math.min(MAP_H - 1, Math.max(0, Math.floor(ty)));
      return elevation[tileIndex(x, y)];
    },
  };
  return { map, path };
}

describe('stamina search mirrors GAME RULE 3', () => {
  const { map: base, path } = corridorMap();
  const scenario = (summitAt: number, cachesAt: number[]): MapData => ({
    ...base,
    spawn: path[0],
    summit: path[summitAt],
    caches: cachesAt.map((k, id) => ({ id, x: path[k].x, y: path[k].y, kind: 'plateau' })),
  });

  it('builds a corridor long enough for the scenarios', () => {
    expect(path.length).toBeGreaterThan(300);
    const d = minCostFrom(base, path[0].x, path[0].y);
    expect(d[tileIndex(path[250].x, path[250].y)]).toBe(250);
  });

  it('allows victory on the step that empties the stamina, but not one step further', () => {
    expect(bestArrivalStamina(scenario(70, []))).toBe(30);
    expect(bestArrivalStamina(scenario(100, []))).toBe(0);
    expect(bestArrivalStamina(scenario(101, []))).toBe(-Infinity);
  });

  it('collects a cache before the collapse check (landing on it at 0 stamina survives)', () => {
    // Stamina hits 0 exactly on the cache at step 100, is refilled to 40, then 40 more steps are possible.
    expect(bestArrivalStamina(scenario(139, [100]))).toBe(1);
    expect(bestArrivalStamina(scenario(140, [100]))).toBe(0);
    expect(bestArrivalStamina(scenario(141, [100]))).toBe(-Infinity);
    // One step short of the cache is fatal: stamina would reach 0 on an ordinary tile.
    expect(bestArrivalStamina(scenario(141, [101]))).toBe(-Infinity);
  });

  it('caps refills at MAX_STAMINA and collects every cache stepped on', () => {
    // At the cache (step 30) stamina is 70; 70 + 40 is capped at 100.
    expect(bestArrivalStamina(scenario(125, [30]))).toBe(5);
    // Two caches in a row: 50 -> 90 at step 50, 80 -> 100 at step 60, then 60 steps to the summit.
    expect(bestArrivalStamina(scenario(120, [50, 60]))).toBe(40);
    // A cache beyond the summit is irrelevant.
    expect(bestArrivalStamina(scenario(90, [95]))).toBe(10);
  });

  it('agrees with validateMap on the synthetic corridor', () => {
    const report = validateMap(scenario(120, [50, 60]));
    expect(report.bestArrivalStamina).toBe(40);
    expect(report.summitReachable).toBe(true);
    expect(report.directCost).toBe(120);
    // The corridor is deliberately not a legal expedition map; the validator must say why.
    expect(report.ok).toBe(false);
    expect(report.summitElevationOk).toBe(false);
    expect(report.cacheCountOk).toBe(false);
    expect(report.reasons.some((r) => r.includes('never be reached alive'))).toBe(false);
  });

  it('rejects a cache that no survivable play can collect', () => {
    // Beyond the summit, where the run ends.
    expect(validateMap(scenario(90, [95])).reasons).toContain('cache 0 can never be reached alive');
    // Beyond the point of collapse: stamina 40 + 40 at step 60 runs out at step 140, short of step 170.
    expect(validateMap(scenario(250, [60, 170])).reasons).toContain('cache 1 can never be reached alive');
    expect(validateMap(scenario(250, [60, 170])).reasons).not.toContain('cache 0 can never be reached alive');
    expect(collectableCaches(scenario(250, [60, 170]))).toEqual([true, false]);
    expect(collectableCaches(scenario(120, [50, 60]))).toEqual([true, true]);
  });
});

describe('validateMap re-derives the objective rules', () => {
  it('rejects a cache whose kind does not match the terrain under it', () => {
    const m = mapFor(SEEDS[0]);
    const c = m.caches[0];
    const other = c.kind === 'plateau' ? 'saddle' : 'plateau';
    const relabelled: MapData = { ...m, caches: m.caches.map((s) => (s === c ? { ...s, kind: other } : s)) };
    expect(validateMap(relabelled).reasons).toContain(`cache 0 kind mismatch: ${other} on ${c.kind}`);
  });

  it('rejects a spawn or summit on the sheet rim', () => {
    const m = mapFor(SEEDS[1]);
    expect(validateMap({ ...m, spawn: { x: 1, y: m.spawn.y } }).reasons).toContain(
      'spawn within 2 tiles of the sheet edge',
    );
    expect(validateMap({ ...m, summit: { x: m.summit.x, y: MAP_H - 2 } }).reasons).toContain(
      'summit within 2 tiles of the sheet edge',
    );
  });

  it('rejects land anywhere that tops the summit by more than 5 m', () => {
    const m = mapFor(SEEDS[2]);
    const summitElev = elevAt(m, m.summit);
    const far = m.peaks.find((p) => chebyshev(p, m.summit) > 10) ?? m.spawn;
    const raise = (by: number): string[] => {
      const elevation = Float32Array.from(m.elevation);
      elevation[tileIndex(far.x, far.y)] = summitElev + by;
      return validateMap({ ...m, elevation }).reasons.filter((r) => r.includes('higher than the summit'));
    };
    expect(raise(0.003)).toEqual([]);
    expect(raise(0.01)).toEqual([`land at (${far.x},${far.y}) is 0.010 higher than the summit`]);
  });
});

describe('path costs', () => {
  it('are asymmetric: uphill steps cost more than the same steps downhill', () => {
    const m = mapFor(SEEDS[3]);
    const up = minCostFrom(m, m.spawn.x, m.spawn.y)[tileIndex(m.summit.x, m.summit.y)];
    const down = minCostFrom(m, m.summit.x, m.summit.y)[tileIndex(m.spawn.x, m.spawn.y)];
    expect(down).toBeLessThan(up);
  });

  it('match terrain.stepCost along every edge (Dijkstra relaxation is tight)', () => {
    const m = mapFor(SEEDS[5]);
    const d = minCostFrom(m, m.spawn.x, m.spawn.y);
    const dirs = ['up', 'right', 'down', 'left'] as const;
    const off = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] } as const;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const du = d[tileIndex(x, y)];
        if (!Number.isFinite(du)) continue;
        for (const dir of dirs) {
          const c = stepCost(m, x, y, dir);
          if (c === null) continue;
          const v = tileIndex(x + off[dir][0], y + off[dir][1]);
          expect(d[v]).toBeLessThanOrEqual(du + c);
        }
      }
    }
    expect(d[tileIndex(m.spawn.x, m.spawn.y)]).toBe(0);
  });

  it('reports Infinity for unreachable tiles', () => {
    const m = mapFor(SEEDS[0]);
    const d = minCostFrom(m, m.spawn.x, m.spawn.y);
    for (let i = 0; i < d.length; i++) if (m.water[i]) expect(d[i]).toBe(Infinity);
  });
});

describe('performance', () => {
  it('generates maps fast enough for an instant restart', () => {
    const times: number[] = [];
    for (const seed of [11, 22, 33, 44, 55, 66, 77, 88, 99, 111]) {
      const t0 = performance.now();
      generateMap(seed);
      times.push(performance.now() - t0);
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    // Typical runs are ~15 ms; the bounds leave headroom for slow CI machines.
    expect(mean).toBeLessThan(150);
    expect(Math.max(...times)).toBeLessThan(600);
  });

  it('samples elevation well under a microsecond-scale budget per call', () => {
    const m = mapFor(SEEDS[2]);
    const n = 200000;
    let sink = 0;
    const t0 = performance.now();
    for (let k = 0; k < n; k++) sink += m.sampleElevation((k % 960) / 12, ((k / 960) | 0) / 12);
    const perCall = (performance.now() - t0) / n;
    expect(sink).toBeGreaterThan(0);
    expect(perCall).toBeLessThan(0.005); // ms, i.e. < 5 us even on a slow machine (~0.3 us typical)
  });
});
