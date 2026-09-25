// Pure terrain rules shared by map validation, game logic and tests.
import {
  CLIFF_DELTA,
  COST_FLAT,
  COST_GENTLE,
  COST_STEEP,
  MAP_H,
  MAP_W,
  MAX_ELEV_M,
  SLOPE_FLAT_MAX,
  SLOPE_GENTLE_MAX,
  WATER_LEVEL,
} from './config';
import { DIRS, DIR_LIST } from './types';
import type { Dir, LocalSlope, MapData, SlopeClass } from './types';

export function tileIndex(x: number, y: number): number {
  return y * MAP_W + x;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
}

export function toMeters(elevation: number): number {
  return Math.round(elevation * MAX_ELEV_M);
}

/** Classify a step by delta = elev(to) - elev(from). */
export function classifySlope(delta: number): SlopeClass {
  if (Math.abs(delta) > CLIFF_DELTA) return 'cliff';
  if (delta <= SLOPE_FLAT_MAX) return 'flat';
  if (delta <= SLOPE_GENTLE_MAX) return 'gentle';
  return 'steep';
}

/** Stamina cost of a slope class; Infinity for cliffs. */
export function slopeCost(slope: SlopeClass): number {
  switch (slope) {
    case 'flat':
      return COST_FLAT;
    case 'gentle':
      return COST_GENTLE;
    case 'steep':
      return COST_STEEP;
    case 'cliff':
      return Infinity;
  }
}

export function isWaterElevation(elevation: number): boolean {
  return elevation < WATER_LEVEL;
}

/**
 * Build passability and cliff bitmasks from tile elevations.
 * A step is passable when the target is in bounds, both tiles are land and |delta| <= CLIFF_DELTA.
 * cliffMask marks land-to-land edges whose |delta| exceeds CLIFF_DELTA (symmetric).
 */
export function computeEdges(
  elevation: Float32Array,
  water: Uint8Array,
): { passMask: Uint8Array; cliffMask: Uint8Array; cliffEdges: number } {
  const passMask = new Uint8Array(MAP_W * MAP_H);
  const cliffMask = new Uint8Array(MAP_W * MAP_H);
  let cliffEdges = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = tileIndex(x, y);
      if (water[i]) continue;
      for (const d of DIR_LIST) {
        const { dx, dy, bit } = DIRS[d];
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const j = tileIndex(nx, ny);
        if (water[j]) continue;
        if (Math.abs(elevation[j] - elevation[i]) > CLIFF_DELTA) {
          cliffMask[i] |= bit;
          if (d === 'right' || d === 'down') cliffEdges++;
        } else {
          passMask[i] |= bit;
        }
      }
    }
  }
  return { passMask, cliffMask, cliffEdges };
}

/** Slope class of stepping from (x,y) in `dir`, or null if the step is impossible (edge / water / cliff). */
export function stepSlope(map: MapData, x: number, y: number, dir: Dir): SlopeClass | null {
  if (!inBounds(x, y)) return null;
  const i = tileIndex(x, y);
  const { dx, dy, bit } = DIRS[dir];
  if (!(map.passMask[i] & bit)) return null;
  const j = tileIndex(x + dx, y + dy);
  return classifySlope(map.elevation[j] - map.elevation[i]);
}

/** Stamina cost of stepping from (x,y) in `dir`, or null if impassable. */
export function stepCost(map: MapData, x: number, y: number, dir: Dir): number | null {
  const slope = stepSlope(map, x, y, dir);
  return slope === null ? null : slopeCost(slope);
}

/**
 * HUD slope danger reading, in step with the step costs: the steepest UPHILL delta over the
 * passable neighbours ('steep' = some step costs COST_STEEP, 'moderate' = the dearest costs
 * COST_GENTLE, 'flat' = every step costs COST_FLAT). Downhill steps cost only COST_FLAT and cliff
 * edges cannot be taken at all (the step-cost panel marks those), so neither raises the alarm.
 */
export function localSlopeAt(map: MapData, x: number, y: number): LocalSlope {
  const i = tileIndex(x, y);
  const mask = map.passMask[i];
  let steepest = 0;
  for (const d of DIR_LIST) {
    const { dx, dy, bit } = DIRS[d];
    if (!(mask & bit)) continue;
    steepest = Math.max(steepest, map.elevation[tileIndex(x + dx, y + dy)] - map.elevation[i]);
  }
  if (steepest <= SLOPE_FLAT_MAX) return 'flat';
  if (steepest <= SLOPE_GENTLE_MAX) return 'moderate';
  return 'steep';
}

/** BFS over passable steps. Returns a per-tile 0/1 reachability array. */
export function reachableFrom(map: MapData, sx: number, sy: number): Uint8Array {
  const seen = new Uint8Array(MAP_W * MAP_H);
  if (!inBounds(sx, sy) || map.water[tileIndex(sx, sy)]) return seen;
  const queue = new Int32Array(MAP_W * MAP_H);
  let head = 0;
  let tail = 0;
  const start = tileIndex(sx, sy);
  seen[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const i = queue[head++];
    const x = i % MAP_W;
    const y = (i - x) / MAP_W;
    const mask = map.passMask[i];
    for (const d of DIR_LIST) {
      const { dx, dy, bit } = DIRS[d];
      if (!(mask & bit)) continue;
      const j = tileIndex(x + dx, y + dy);
      if (seen[j]) continue;
      seen[j] = 1;
      queue[tail++] = j;
    }
  }
  return seen;
}
