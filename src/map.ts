// Procedural contour-map generation plus an independent connectivity / stamina-feasibility validator.
//
// Terrain recipe (all in continuous tile units so the renderer can sample it per pixel):
//   gently domain-warped hybrid fBm (smooth valley floors, crenulated uplands)
//   + one or two lobed "massif" domes whose flanks are dissected by V-shaped valleys
//   + zero-mean ridged multifractal crests and gorges on the massifs
//   -> coarse monotone quantile remap (hypsometric curve: lakes, lowlands, hills, one high massif)
//   -> smooth terraces in noise-selected mesa regions and, on most maps, a broken cuesta escarpment
//      (together with the steepest crags these are the sheer cliffs).
//
// Objectives are then placed on the result (summit = highest tile of the spawn's component and not topped
// by any other land, spawn in the lowland band at a tuned full-knowledge cost, both clear of the sheet
// edge, caches on plateaus / level saddles, each collectable alive) and every candidate map is accepted
// only if validateMap() re-derives all rules from scratch and reports ok.
import { createNoise2D } from 'simplex-noise';
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
  MAX_GEN_ATTEMPTS,
  MAX_STAMINA,
  SLOPE_GENTLE_MAX,
  SPAWN_MAX_ELEV,
  SPAWN_MIN_ELEV,
  SUMMIT_MIN_ELEV,
  WATER_LEVEL,
} from './config';
import { hashSeed, mulberry32, randInt } from './rng';
import type { Rng } from './rng';
import { computeEdges, inBounds, reachableFrom, stepCost, tileIndex } from './terrain';
import { DIRS, DIR_LIST } from './types';
import type { CacheKind, CacheSite, MapData, MapStats, Peak, Point } from './types';

const N_TILES = MAP_W * MAP_H;
/** Per-direction tables in DIR_LIST order, derived from the shared DIRS contract. */
const DX: readonly number[] = DIR_LIST.map((d) => DIRS[d].dx);
const DY: readonly number[] = DIR_LIST.map((d) => DIRS[d].dy);
const DIR_BIT: readonly number[] = DIR_LIST.map((d) => DIRS[d].bit);
/** Index offset of the neighbour in each direction. */
const NEIGHBOR_DELTA: readonly number[] = DIR_LIST.map((d) => DIRS[d].dy * MAP_W + DIRS[d].dx);

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function chebyshev(a: Point, b: Point): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Euclidean distance (tiles) from p to the straight segment a->b. */
function distToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  const dx = p.x - (a.x + vx * t);
  const dy = p.y - (a.y + vy * t);
  // sqrt, not Math.hypot: this runs in the spawn and cache scoring loops and hypot is several times slower.
  return Math.sqrt(dx * dx + dy * dy);
}

function pointOf(i: number): Point {
  const x = i % MAP_W;
  return { x, y: (i - x) / MAP_W };
}

// ---------------------------------------------------------------------------
// Terrain field
// ---------------------------------------------------------------------------

type Sampler = (tx: number, ty: number) => number;

interface Massif {
  cx: number;
  cy: number;
  /** Rotation of the ellipse. */
  cos: number;
  sin: number;
  invRx: number;
  invRy: number;
  height: number;
}

/** Number of intervals in the baked remap lookup table. */
const REMAP_TABLE_N = 1024;
const FBM_OCTAVES = 6;
const FBM_BROAD_OCTAVES = 3;
/** How strongly the lobe noise distorts the massif outline (fraction of the squared radius). */
const MASSIF_LOBING = 0.4;
/** Depth of the flank valleys, in massif units at mid-flank. */
const VALLEY_DEPTH = 0.1;
/** Terrace band (final elevation) and massif weights over which terracing fades out. */
const TERRACE_FADE = 0.6;
const TERRACE_TOP = 0.7;
const TERRACE_MASSIF_MIN = 0.03;
const TERRACE_MASSIF_MAX = 0.22;
/** Share of maps with a cuesta escarpment, and the elevation band it fades out over. */
const SCARP_CHANCE = 0.7;
const SCARP_FADE = 0.56;
const SCARP_TOP = 0.66;
const RIDGE_OCTAVES = 4;
/** Mean of the 4-octave ridged multifractal below (measured), removed so ridges are relief, not uplift. */
const RIDGE_MEAN = 0.66;

/**
 * Builds the continuous elevation function for one terrain seed.
 * Everything that can be precomputed (noise tables, octave offsets, remap table) is done here so the
 * returned sampler is allocation-free.
 */
function createTerrainSampler(terrainSeed: number): Sampler {
  const rng = mulberry32(terrainSeed);
  const noiseWarp = createNoise2D(rng);
  const noiseBase = createNoise2D(rng);
  const noiseRidge = createNoise2D(rng);
  const noiseMask = createNoise2D(rng);
  const off = (): number => rng() * 256;

  // --- domain warp: bends every feature into natural, non-blobby outlines.
  // amplitude * frequency is kept near 0.13 (simplex gradients reach ~7): strong enough to meander,
  // weak enough that the warp never folds space into artificial pinched scarps.
  const warpFreq = 1 / lerp(36, 48, rng());
  const warpAmp = lerp(0.12, 0.14, rng()) / warpFreq;
  const wx1 = off();
  const wy1 = off();
  const wx2 = off();
  const wy2 = off();
  const warpFreq2 = warpFreq * 2.6;
  const warpAmp2 = warpAmp * 0.24;
  const wx3 = off();
  const wy3 = off();
  const wx4 = off();
  const wy4 = off();

  // --- base fBm
  const baseFreq = 1 / lerp(34, 46, rng());
  const persistence = lerp(0.44, 0.5, rng());
  const fbmFreq = new Float64Array(FBM_OCTAVES);
  const fbmAmp = new Float64Array(FBM_OCTAVES);
  const fbmOx = new Float64Array(FBM_OCTAVES);
  const fbmOy = new Float64Array(FBM_OCTAVES);
  {
    let f = baseFreq;
    let a = 1;
    let total = 0;
    for (let o = 0; o < FBM_OCTAVES; o++) {
      fbmFreq[o] = f;
      fbmAmp[o] = a;
      fbmOx[o] = off();
      fbmOy[o] = off();
      total += a;
      f *= 1.97;
      a *= persistence;
    }
    for (let o = 0; o < FBM_OCTAVES; o++) fbmAmp[o] /= total;
  }

  // --- ridged multifractal (mountain ranges), confined to the massif region
  const ridgeFreq = 1 / lerp(24, 32, rng());
  const ridgeFreqs = new Float64Array(RIDGE_OCTAVES);
  const ridgeAmps = new Float64Array(RIDGE_OCTAVES);
  const ridgeOx = new Float64Array(RIDGE_OCTAVES);
  const ridgeOy = new Float64Array(RIDGE_OCTAVES);
  {
    let f = ridgeFreq;
    let a = 1;
    for (let o = 0; o < RIDGE_OCTAVES; o++) {
      ridgeFreqs[o] = f;
      ridgeAmps[o] = a;
      ridgeOx[o] = off();
      ridgeOy[o] = off();
      f *= 2.07;
      a *= 0.5;
    }
  }
  const mountainFreq = 1 / lerp(16, 22, rng());
  const mox = off();
  const moy = off();
  // Valleys that dissect the massif flanks into spurs.
  const valleyFreq = 1 / lerp(8, 12, rng());
  const vox = off();
  const voy = off();

  // --- massifs: one dominant dome, sometimes a lesser second one
  const massifs: Massif[] = [];
  const makeMassif = (cx: number, cy: number, r: number, height: number): Massif => {
    const ang = rng() * Math.PI;
    const aspect = lerp(1.0, 1.45, rng());
    return {
      cx,
      cy,
      cos: Math.cos(ang),
      sin: Math.sin(ang),
      invRx: 1 / (r * Math.sqrt(aspect)),
      invRy: Math.sqrt(aspect) / r,
      height,
    };
  };
  const m1x = lerp(14, MAP_W - 14, rng());
  const m1y = lerp(11, MAP_H - 11, rng());
  massifs.push(makeMassif(m1x, m1y, lerp(17, 23, rng()), 1));
  if (rng() < 0.6) {
    // Place the second massif well away from the first.
    let bx = 0;
    let by = 0;
    let bestD = -1;
    for (let k = 0; k < 8; k++) {
      const x = lerp(10, MAP_W - 10, rng());
      const y = lerp(8, MAP_H - 8, rng());
      const d = Math.hypot(x - m1x, y - m1y);
      if (d > bestD) {
        bestD = d;
        bx = x;
        by = y;
      }
    }
    massifs.push(makeMassif(bx, by, lerp(10, 15, rng()), lerp(0.45, 0.75, rng())));
  }
  const massifCount = massifs.length;

  // --- blend weights
  const wBase = lerp(0.5, 0.62, rng());
  const wMassif = lerp(0.85, 1.0, rng());
  const wRidge = lerp(0.36, 0.46, rng());
  const detailLo = lerp(-0.3, -0.15, rng());
  const detailFloor = lerp(0.2, 0.35, rng());
  // Side channel from the most recent raw() call to the terrace / scarp stage (avoids allocating a tuple).
  let lastMassif = 0;
  let lastQx = 0;
  let lastQy = 0;

  /** Raw (un-normalised) field. */
  const raw = (tx: number, ty: number): number => {
    // Two-octave domain warp.
    const qx =
      tx +
      warpAmp * noiseWarp(tx * warpFreq + wx1, ty * warpFreq + wy1) +
      warpAmp2 * noiseWarp(tx * warpFreq2 + wx3, ty * warpFreq2 + wy3);
    const qy =
      ty +
      warpAmp * noiseWarp(tx * warpFreq + wx2, ty * warpFreq + wy2) +
      warpAmp2 * noiseWarp(tx * warpFreq2 + wx4, ty * warpFreq2 + wy4);

    // Hybrid multifractal: broad octaves everywhere, fine detail mostly on the uplands so valley floors
    // and shorelines stay smooth (as on a real sheet) while hills and mountains get crenulated contours.
    let broad = 0;
    for (let o = 0; o < FBM_BROAD_OCTAVES; o++) {
      const f = fbmFreq[o];
      broad += fbmAmp[o] * noiseBase(qx * f + fbmOx[o], qy * f + fbmOy[o]);
    }
    let detail = 0;
    for (let o = FBM_BROAD_OCTAVES; o < FBM_OCTAVES; o++) {
      const f = fbmFreq[o];
      detail += fbmAmp[o] * noiseBase(qx * f + fbmOx[o], qy * f + fbmOy[o]);
    }

    // Lobed massif outline: the same low-frequency noise that shapes the mountain mask pushes spurs out
    // and bays in, so the highland never has a smooth elliptical (straight-looking) flank.
    const lobe = noiseMask(qx * mountainFreq + mox, qy * mountainFreq + moy);
    const lobeScale = 1 - MASSIF_LOBING * lobe;
    let massif = 0;
    for (let k = 0; k < massifCount; k++) {
      const m = massifs[k];
      const dx = qx - m.cx;
      const dy = qy - m.cy;
      const u = (dx * m.cos + dy * m.sin) * m.invRx;
      const v = (dy * m.cos - dx * m.sin) * m.invRy;
      const d2 = (u * u + v * v) * lobeScale;
      if (d2 < 1) {
        const s = 1 - d2;
        massif += m.height * s * s;
      }
    }

    if (massif > 0) {
      // Carve V-shaped valleys along the zero lines of a noise, deepest mid-flank and fading out at the
      // rim and on the crest, so the highland flanks break into spurs and gullies instead of a smooth wall.
      const n = noiseRidge(qx * valleyFreq + vox, qy * valleyFreq + voy);
      const carve = 1 - smoothstep(0.05, 0.6, Math.sqrt(n * n + 0.0025));
      const flank = massif < 1 ? massif * (1 - massif) * 4 : 0;
      massif -= VALLEY_DEPTH * carve * flank;
    }
    lastMassif = massif;
    lastQx = qx;
    lastQy = qy;
    const rugged = smoothstep(detailLo, detailLo + 0.5, broad + massif);
    let h = wBase * (broad + detail * (detailFloor + (1 - detailFloor) * rugged)) + wMassif * massif;

    // Mountain mask: ridges grow out of the massifs with an irregular outline.
    const mask = smoothstep(0.08, 0.55, massif + 0.3 * lobe);
    if (mask > 0) {
      let ridge = 0;
      let weight = 1;
      for (let o = 0; o < RIDGE_OCTAVES; o++) {
        const f = ridgeFreqs[o];
        const n = noiseRidge(qx * f + ridgeOx[o], qy * f + ridgeOy[o]);
        // Soft absolute value keeps the crest line smooth (no crease in the contour lines).
        let r = 1 - Math.sqrt(n * n + 0.0025);
        r *= r * weight;
        ridge += r * ridgeAmps[o];
        weight = r * 2 > 1 ? 1 : r * 2;
      }
      // Zero-mean: ridges add crests and gorges around the massif surface without raising a rim step.
      h += wRidge * mask * (ridge - RIDGE_MEAN);
    }
    return h;
  };

  // --- coarse quantile remap: raw -> target hypsometric curve.
  const samples = new Float64Array(N_TILES);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) samples[y * MAP_W + x] = raw(x + 0.5, y + 0.5);
  }
  samples.sort();
  const quantile = (q: number): number => {
    const pos = q * (N_TILES - 1);
    const i = Math.min(N_TILES - 2, Math.floor(pos));
    return samples[i] + (samples[i + 1] - samples[i]) * (pos - i);
  };
  const waterQ = lerp(0.085, 0.145, rng());
  const peak = lerp(0.875, 0.955, rng());
  const hill = rng();
  const knotQ = [0, waterQ * 0.45, waterQ, waterQ + 0.17, 0.52, 0.76, 0.9, 0.962, 0.988, 1];
  const knotE = [
    0.07,
    0.165,
    WATER_LEVEL,
    0.3,
    lerp(0.37, 0.41, hill),
    lerp(0.46, 0.51, hill),
    lerp(0.56, 0.61, hill),
    lerp(0.66, 0.7, hill),
    0.79,
    peak,
  ];
  const kx = knotQ.map(quantile);
  // Enforce strictly increasing knots (ties can occur on degenerate fields).
  for (let k = 1; k < kx.length; k++) if (kx[k] <= kx[k - 1]) kx[k] = kx[k - 1] + 1e-6;
  const remap = buildMonotoneRemap(kx, knotE);

  // --- terraces / escarpments in noise-selected mesa regions
  const terraceFreq = 1 / lerp(17, 24, rng());
  const tox = off();
  const toy = off();
  const terraceLo = lerp(-0.05, 0.2, rng());
  const terraceHi = terraceLo + 0.16;
  const step = lerp(0.13, 0.16, rng());
  const invStep = 1 / step;
  const phase = rng() * step;
  const tread = lerp(0.1, 0.18, rng());
  const riserStart = lerp(0.7, 0.78, rng());
  const invRiser = 1 / (1 - riserStart);

  // --- cuesta escarpment (most maps): along the zero line of a low-frequency noise the land steps up by
  // scarpHeight over about half a tile (the scarp face), then the dip slope eases back down behind it.
  // A second mask breaks the scarp into segments so ramps and gaps always remain.
  const scarpHeight = rng() < SCARP_CHANCE ? lerp(0.11, 0.15, rng()) : 0;
  const scarpFreq = 1 / lerp(26, 36, rng());
  const scarpSign = rng() < 0.5 ? -1 : 1;
  const sox = off();
  const soy = off();
  const sox2 = off();
  const soy2 = off();
  const scarpFreq2 = scarpFreq * 2.3;
  // Face half-width in noise units: wide enough that the rise is not squeezed into a couple of pixels
  // (bunched contours stay apart and the cliff follows the curving field rather than one tile edge).
  const scarpFace = lerp(0.06, 0.09, rng());
  const scarpBack = lerp(0.3, 0.45, rng());
  const breakFreq = 1 / lerp(9, 14, rng());
  const bkx = off();
  const bky = off();
  const breakLo = lerp(-0.25, 0.05, rng());

  return (tx: number, ty: number): number => {
    let e = remap(raw(tx, ty));
    // Terrace weight at this point (0 outside the mesa regions); the scarp below is damped by it.
    let w = 0;
    // Only the hill country is terraced: shorelines, massif flanks and the summit dome stay natural.
    if (e > 0.27 && e < TERRACE_TOP && lastMassif < TERRACE_MASSIF_MAX) {
      const band =
        smoothstep(0.27, 0.33, e) *
        (1 - smoothstep(TERRACE_FADE, TERRACE_TOP, e)) *
        (1 - smoothstep(TERRACE_MASSIF_MIN, TERRACE_MASSIF_MAX, lastMassif));
      const region = smoothstep(terraceLo, terraceHi, noiseMask(tx * terraceFreq + tox, ty * terraceFreq + toy));
      w = band * region;
      if (w > 0) {
        const k = (e - phase) * invStep;
        const n = Math.floor(k);
        const f = k - n;
        let g = 0;
        if (f > riserStart) {
          const t = (f - riserStart) * invRiser;
          g = t * t * (3 - 2 * t);
        }
        const terraced = phase + step * (n + tread * f + (1 - tread) * g);
        e += w * (terraced - e);
      }
    }
    if (scarpHeight > 0 && e > 0.28 && e < SCARP_TOP && lastMassif < TERRACE_MASSIF_MAX) {
      // Two octaves in warped space so the scarp line meanders with the grain of the land.
      const f =
        scarpSign *
        (noiseRidge(lastQx * scarpFreq + sox, lastQy * scarpFreq + soy) +
          0.4 * noiseRidge(lastQx * scarpFreq2 + sox2, lastQy * scarpFreq2 + soy2));
      if (f > -scarpFace && f < scarpBack) {
        const profile = smoothstep(-scarpFace, scarpFace, f) * (1 - smoothstep(scarpFace, scarpBack, f));
        const band =
          smoothstep(0.28, 0.34, e) *
          (1 - smoothstep(SCARP_FADE, SCARP_TOP, e)) *
          (1 - smoothstep(TERRACE_MASSIF_MIN, TERRACE_MASSIF_MAX, lastMassif));
        const segments = smoothstep(breakLo, breakLo + 0.3, noiseMask(tx * breakFreq + bkx, ty * breakFreq + bky));
        // Inside the terraced mesas the risers already form the cliffs; stacking the scarp on them piles
        // two tile-scale steps into straight, wall-like runs, so the scarp fades out there.
        e += scarpHeight * profile * band * segments * (1 - w);
      }
    }
    return e < 0 ? 0 : e > 1 ? 1 : e;
  };
}

/**
 * Monotone (Fritsch-Carlson PCHIP) interpolant through the knots, baked into a lookup table, with smooth
 * tanh roll-offs outside the sampled range so the result stays in (0, 1) and is C1 at the joins.
 */
function buildMonotoneRemap(xs: number[], ys: number[]): (v: number) => number {
  const n = xs.length;
  const h: number[] = [];
  const delta: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    h.push(xs[k + 1] - xs[k]);
    delta.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (delta[k - 1] * delta[k] <= 0) {
      m[k] = 0;
    } else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k]);
    }
  }
  const hermite = (v: number): number => {
    let k = 0;
    while (k < n - 2 && v > xs[k + 1]) k++;
    const t = (v - xs[k]) / h[k];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[k] +
      (t3 - 2 * t2 + t) * h[k] * m[k] +
      (-2 * t3 + 3 * t2) * ys[k + 1] +
      (t3 - t2) * h[k] * m[k + 1]
    );
  };
  const x0 = xs[0];
  const xN = xs[n - 1];
  const y0 = ys[0];
  const yN = ys[n - 1];
  const m0 = m[0];
  const mN = m[n - 1];
  const span = xN - x0;
  const scale = REMAP_TABLE_N / span;
  const table = new Float64Array(REMAP_TABLE_N + 1);
  for (let i = 0; i <= REMAP_TABLE_N; i++) table[i] = hermite(x0 + (span * i) / REMAP_TABLE_N);
  table[0] = y0;
  table[REMAP_TABLE_N] = yN;
  const lowRoom = y0;
  const highRoom = 1 - yN;
  return (v: number): number => {
    const t = (v - x0) * scale;
    if (t < 0) return y0 - lowRoom * Math.tanh(((x0 - v) * m0) / lowRoom);
    if (t >= REMAP_TABLE_N) return yN + highRoom * Math.tanh(((v - xN) * mN) / highRoom);
    const i = t | 0;
    return table[i] + (table[i + 1] - table[i]) * (t - i);
  };
}

// ---------------------------------------------------------------------------
// Tile grid
// ---------------------------------------------------------------------------

interface TerrainGrid {
  sample: Sampler;
  elevation: Float32Array;
  water: Uint8Array;
  passMask: Uint8Array;
  cliffMask: Uint8Array;
  cliffEdges: number;
  landEdges: number;
  waterFraction: number;
}

/** Number of undirected edges between two adjacent land tiles. */
function countLandEdges(water: Uint8Array): number {
  let count = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      if (water[i]) continue;
      if (x + 1 < MAP_W && !water[i + 1]) count++;
      if (y + 1 < MAP_H && !water[i + MAP_W]) count++;
    }
  }
  return count;
}

function buildGrid(sample: Sampler): TerrainGrid {
  const elevation = new Float32Array(N_TILES);
  const water = new Uint8Array(N_TILES);
  let waterCount = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      const e = Math.fround(sample(x + 0.5, y + 0.5));
      elevation[i] = e;
      if (e < WATER_LEVEL) {
        water[i] = 1;
        waterCount++;
      }
    }
  }
  const { passMask, cliffMask, cliffEdges } = computeEdges(elevation, water);
  const landEdges = countLandEdges(water);
  return {
    sample,
    elevation,
    water,
    passMask,
    cliffMask,
    cliffEdges,
    landEdges,
    waterFraction: waterCount / N_TILES,
  };
}

// ---------------------------------------------------------------------------
// Path costs
// ---------------------------------------------------------------------------

/** The only MapData fields terrain.stepCost reads. */
export type CostSource = Pick<MapData, 'elevation' | 'passMask'>;

/**
 * Per tile and direction (DIR_LIST order) the stamina cost of the step, 0 = impassable.
 * Built with terrain.stepCost so the rules live in exactly one place.
 */
export function buildStepCosts(map: CostSource): Uint8Array {
  const costs = new Uint8Array(N_TILES * 4);
  // stepCost only touches passMask and elevation, so a bare terrain grid can be costed before the
  // objectives (and hence a full MapData) exist.
  const view = map as MapData;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      if (!map.passMask[i]) continue;
      for (let d = 0; d < 4; d++) {
        // Guard against corrupted masks pointing off the grid (validateMap reports those separately).
        if (!inBounds(x + DX[d], y + DY[d])) continue;
        const c = stepCost(view, x, y, DIR_LIST[d]);
        if (c !== null) costs[i * 4 + d] = c;
      }
    }
  }
  return costs;
}

/** Binary min-heap of tile indices keyed by float priorities (lazy deletion by the caller). */
class MinHeap {
  private nodes = new Int32Array(1024);
  private keys = new Float64Array(1024);
  size = 0;

  push(node: number, key: number): void {
    if (this.size === this.nodes.length) {
      const nodes = new Int32Array(this.size * 2);
      const keys = new Float64Array(this.size * 2);
      nodes.set(this.nodes);
      keys.set(this.keys);
      this.nodes = nodes;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.nodes[i] = this.nodes[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.nodes[i] = node;
    this.keys[i] = key;
  }

  /** Key of the top element (call before pop). */
  topKey(): number {
    return this.keys[0];
  }

  pop(): number {
    const top = this.nodes[0];
    const last = --this.size;
    const node = this.nodes[last];
    const key = this.keys[last];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= last) break;
      if (c + 1 < last && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.nodes[i] = this.nodes[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.nodes[i] = node;
    this.keys[i] = key;
    return top;
  }
}

/** Forward Dijkstra: minimum cost from `start` to every tile. */
function dijkstraFrom(costs: Uint8Array, start: number): Float64Array {
  const dist = new Float64Array(N_TILES).fill(Infinity);
  dist[start] = 0;
  const heap = new MinHeap();
  heap.push(start, 0);
  while (heap.size > 0) {
    const du = heap.topKey();
    const u = heap.pop();
    if (du > dist[u]) continue;
    for (let d = 0; d < 4; d++) {
      const c = costs[u * 4 + d];
      if (c === 0) continue;
      const v = u + NEIGHBOR_DELTA[d];
      const nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        heap.push(v, nd);
      }
    }
  }
  return dist;
}

/** Reverse Dijkstra: minimum cost from every tile to `target` (edge u->v weighted by the cost of u->v). */
function dijkstraTo(costs: Uint8Array, target: number): Float64Array {
  const dist = new Float64Array(N_TILES).fill(Infinity);
  dist[target] = 0;
  const heap = new MinHeap();
  heap.push(target, 0);
  while (heap.size > 0) {
    const dv = heap.topKey();
    const v = heap.pop();
    if (dv > dist[v]) continue;
    const vx = v % MAP_W;
    const vy = (v - vx) / MAP_W;
    for (let d = 0; d < 4; d++) {
      // u steps onto v in direction d, so u = v - offset(d).
      const ux = vx - DX[d];
      const uy = vy - DY[d];
      if (ux < 0 || uy < 0 || ux >= MAP_W || uy >= MAP_H) continue;
      const u = uy * MAP_W + ux;
      const c = costs[u * 4 + d];
      if (c === 0) continue;
      const nd = dv + c;
      if (nd < dist[u]) {
        dist[u] = nd;
        heap.push(u, nd);
      }
    }
  }
  return dist;
}

/** Forward Dijkstra over step costs from (sx, sy). Infinity = unreachable. */
export function minCostFrom(map: MapData, sx: number, sy: number): Float64Array {
  if (!inBounds(sx, sy)) return new Float64Array(N_TILES).fill(Infinity);
  return dijkstraFrom(buildStepCosts(map), tileIndex(sx, sy));
}

/** Reverse Dijkstra: minimum cost of reaching (tx, ty) from every tile. Infinity = cannot reach it. */
export function minCostTo(map: MapData, tx: number, ty: number): Float64Array {
  if (!inBounds(tx, ty)) return new Float64Array(N_TILES).fill(Infinity);
  return dijkstraTo(buildStepCosts(map), tileIndex(tx, ty));
}

interface StaminaResult {
  /** Best stamina left on arrival at the summit, -Infinity if unreachable. */
  arrival: number;
  /** Per cache (input order): 1 if some survivable play collects it, 0 if every way there is fatal. */
  collectable: Uint8Array;
}

/**
 * Stamina-aware optimal-play search mirroring GAME RULE 3 exactly.
 * State = (tile, bitmask of collected caches). Within one mask it is a max-stamina shortest-path problem
 * (bucket queue, stamina 1..MAX); entering an uncollected cache moves to mask|bit with stamina refilled.
 * A step reaching stamina <= 0 is survivable only onto the summit or onto an uncollected cache that lifts
 * stamina back above 0.
 */
function staminaSearch(costs: Uint8Array, spawn: number, summit: number, caches: readonly number[]): StaminaResult {
  const k = caches.length;
  const collectable = new Uint8Array(k);
  if (spawn === summit) return { arrival: MAX_STAMINA, collectable };
  const layers = 1 << k;
  const cacheBit = new Int8Array(N_TILES).fill(-1);
  for (let b = 0; b < k; b++) cacheBit[caches[b]] = b;
  const best = new Int8Array(layers * N_TILES); // 0 = unreached; live stamina is always >= 1
  const buckets: number[][] = [];
  for (let s = 0; s <= MAX_STAMINA; s++) buckets.push([]);
  let arrival = -Infinity;
  best[spawn] = MAX_STAMINA;

  for (let m = 0; m < layers; m++) {
    const base = m * N_TILES;
    let seeded = false;
    if (m === 0) {
      buckets[MAX_STAMINA].push(spawn);
      seeded = true;
    }
    for (let b = 0; b < k; b++) {
      if (!(m & (1 << b))) continue;
      const s = best[base + caches[b]];
      if (s > 0) {
        buckets[s].push(caches[b]);
        seeded = true;
      }
    }
    if (!seeded) continue;

    for (let s = MAX_STAMINA; s >= 1; s--) {
      const bucket = buckets[s];
      // Steps always cost >= 1, so this bucket cannot grow while it is being drained.
      for (let bi = 0; bi < bucket.length; bi++) {
        const u = bucket[bi];
        if (best[base + u] !== s) continue; // superseded by a better entry
        for (let d = 0; d < 4; d++) {
          const c = costs[u * 4 + d];
          if (c === 0) continue;
          const v = u + NEIGHBOR_DELTA[d];
          const left = s - c;
          if (v === summit) {
            // (a) victory regardless of remaining stamina
            if (left > arrival) arrival = left;
            continue;
          }
          const bit = cacheBit[v];
          if (bit >= 0 && !(m & (1 << bit))) {
            // (b) collect, then (c) collapse check
            const refilled = Math.min(MAX_STAMINA, left + CACHE_RESTORE);
            if (refilled <= 0) continue;
            collectable[bit] = 1;
            const idx = (m | (1 << bit)) * N_TILES + v;
            if (refilled > best[idx]) best[idx] = refilled;
            continue;
          }
          if (left <= 0) continue; // (c) collapse
          if (left > best[base + v]) {
            best[base + v] = left;
            buckets[left].push(v);
          }
        }
      }
      bucket.length = 0;
    }
  }
  return { arrival, collectable };
}

/** Best stamina left on arriving at the summit with optimal full-knowledge play (-Infinity if impossible). */
export function bestArrivalStamina(map: MapData): number {
  const { spawn, summit } = map;
  if (!inBounds(spawn.x, spawn.y) || !inBounds(summit.x, summit.y)) return -Infinity;
  const caches = map.caches.filter((c) => inBounds(c.x, c.y)).map((c) => tileIndex(c.x, c.y));
  const spawnIdx = tileIndex(spawn.x, spawn.y);
  return staminaSearch(buildStepCosts(map), spawnIdx, tileIndex(summit.x, summit.y), caches).arrival;
}

// ---------------------------------------------------------------------------
// Validation (independent re-check from scratch)
// ---------------------------------------------------------------------------

export interface ValidationReport {
  ok: boolean;
  reasons: string[];
  summitReachable: boolean;
  cachesReachable: boolean[];
  spawnElevationOk: boolean;
  summitElevationOk: boolean;
  summitIsHighestReachable: boolean;
  cacheCountOk: boolean;
  directCost: number;
  bestArrivalStamina: number;
}

/** Spawn and summit keep at least this many tiles of sheet on every side (x, y >= 3 and <= size - 4). */
const EDGE_MARGIN = 3;
/**
 * No land tile anywhere (not even an unclimbable cliff-ringed spire) may top the summit by more than this
 * (5 m, within-tile noise), so the Trig Pillar never stands below a higher printed spot height.
 */
const SUMMIT_RIVAL_TOL = 0.004;

/** True within EDGE_MARGIN - 1 tiles of the sheet border, where the view disc and sprites hit the frame. */
function nearSheetEdge(x: number, y: number): boolean {
  return x < EDGE_MARGIN || y < EDGE_MARGIN || x >= MAP_W - EDGE_MARGIN || y >= MAP_H - EDGE_MARGIN;
}

/** True if (x, y) or any of its 8 neighbours touches a cliff edge. */
function nearCliff(cliffMask: Uint8Array, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (inBounds(nx, ny) && cliffMask[ny * MAP_W + nx]) return true;
    }
  }
  return false;
}

/**
 * Re-derives every map rule from the raw data: grid consistency with sampleElevation / computeEdges,
 * spawn / summit / cache placement (cache kinds re-classified from the elevations), BFS reachability,
 * direct cost and the stamina-aware feasibility search (which also proves every cache collectable alive).
 */
export function validateMap(map: MapData): ValidationReport {
  const reasons: string[] = [];
  const report: ValidationReport = {
    ok: false,
    reasons,
    summitReachable: false,
    cachesReachable: map.caches.map(() => false),
    spawnElevationOk: false,
    summitElevationOk: false,
    summitIsHighestReachable: false,
    cacheCountOk: false,
    directCost: Infinity,
    bestArrivalStamina: -Infinity,
  };

  // --- grid consistency
  if (
    map.width !== MAP_W ||
    map.height !== MAP_H ||
    map.elevation.length !== N_TILES ||
    map.water.length !== N_TILES ||
    map.passMask.length !== N_TILES ||
    map.cliffMask.length !== N_TILES
  ) {
    reasons.push('grid dimensions do not match MAP_W x MAP_H');
    return report;
  }
  let sampleMismatch = 0;
  let waterMismatch = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      const e = map.elevation[i];
      if (e !== Math.fround(map.sampleElevation(x + 0.5, y + 0.5)) || !(e >= 0 && e <= 1)) sampleMismatch++;
      if (map.water[i] !== (e < WATER_LEVEL ? 1 : 0)) waterMismatch++;
    }
  }
  if (sampleMismatch > 0) reasons.push(`${sampleMismatch} tile elevations differ from sampleElevation at tile centres`);
  if (waterMismatch > 0) reasons.push(`${waterMismatch} water flags disagree with WATER_LEVEL`);
  const edges = computeEdges(map.elevation, map.water);
  let edgeMismatch = 0;
  for (let i = 0; i < N_TILES; i++) {
    if (edges.passMask[i] !== map.passMask[i] || edges.cliffMask[i] !== map.cliffMask[i]) edgeMismatch++;
  }
  if (edgeMismatch > 0) reasons.push(`${edgeMismatch} tiles have passMask/cliffMask inconsistent with computeEdges`);

  // --- spawn
  const { spawn, summit } = map;
  const spawnIn = inBounds(spawn.x, spawn.y) && Number.isInteger(spawn.x) && Number.isInteger(spawn.y);
  const summitIn = inBounds(summit.x, summit.y) && Number.isInteger(summit.x) && Number.isInteger(summit.y);
  if (!spawnIn) reasons.push('spawn out of bounds');
  if (!summitIn) reasons.push('summit out of bounds');
  if (!spawnIn || !summitIn) return report;
  const spawnIdx = tileIndex(spawn.x, spawn.y);
  const summitIdx = tileIndex(summit.x, summit.y);
  const spawnElev = map.elevation[spawnIdx];
  report.spawnElevationOk = !map.water[spawnIdx] && spawnElev >= SPAWN_MIN_ELEV && spawnElev <= SPAWN_MAX_ELEV;
  if (!report.spawnElevationOk) reasons.push(`spawn elevation ${spawnElev.toFixed(3)} outside spawn band`);
  if (map.passMask[spawnIdx] !== 15) reasons.push('spawn does not have four passable neighbours');
  if (nearCliff(map.cliffMask, spawn.x, spawn.y)) reasons.push('spawn is within 1 tile of a cliff');
  if (nearSheetEdge(spawn.x, spawn.y)) reasons.push(`spawn within ${EDGE_MARGIN - 1} tiles of the sheet edge`);
  if (spawnIdx === summitIdx) reasons.push('spawn coincides with summit');

  // --- summit
  const summitElev = map.elevation[summitIdx];
  report.summitElevationOk = !map.water[summitIdx] && summitElev > SUMMIT_MIN_ELEV;
  if (!report.summitElevationOk) reasons.push(`summit elevation ${summitElev.toFixed(3)} not above ${SUMMIT_MIN_ELEV}`);
  if (nearSheetEdge(summit.x, summit.y)) reasons.push(`summit within ${EDGE_MARGIN - 1} tiles of the sheet edge`);
  let top = summitIdx;
  for (let i = 0; i < N_TILES; i++) if (!map.water[i] && map.elevation[i] > map.elevation[top]) top = i;
  if (map.elevation[top] > summitElev + SUMMIT_RIVAL_TOL) {
    const p = pointOf(top);
    reasons.push(`land at (${p.x},${p.y}) is ${(map.elevation[top] - summitElev).toFixed(3)} higher than the summit`);
  }

  // --- reachability (BFS)
  const reach = reachableFrom(map, spawn.x, spawn.y);
  report.summitReachable = reach[summitIdx] === 1;
  if (!report.summitReachable) reasons.push('summit not reachable from spawn');
  let highest = -Infinity;
  for (let i = 0; i < N_TILES; i++) if (reach[i] && map.elevation[i] > highest) highest = map.elevation[i];
  report.summitIsHighestReachable = report.summitReachable && summitElev >= highest;
  if (!report.summitIsHighestReachable) reasons.push('summit is not the highest tile reachable from spawn');

  // --- caches
  const n = map.caches.length;
  report.cacheCountOk = n >= CACHE_MIN_COUNT && n <= CACHE_MAX_COUNT;
  if (!report.cacheCountOk) reasons.push(`cache count ${n} outside ${CACHE_MIN_COUNT}..${CACHE_MAX_COUNT}`);
  const cacheIdx: number[] = [];
  map.caches.forEach((c, k) => {
    if (!inBounds(c.x, c.y) || !Number.isInteger(c.x) || !Number.isInteger(c.y)) {
      reasons.push(`cache ${k} out of bounds`);
      return;
    }
    const i = tileIndex(c.x, c.y);
    cacheIdx.push(i);
    report.cachesReachable[k] = reach[i] === 1;
    if (!report.cachesReachable[k]) reasons.push(`cache ${k} not reachable from spawn`);
    if (map.water[i]) reasons.push(`cache ${k} on water`);
    if (c.id !== k) reasons.push(`cache ${k} has id ${c.id}`);
    if (c.kind !== 'plateau' && c.kind !== 'saddle') {
      reasons.push(`cache ${k} has unknown kind`);
    } else {
      // Re-classified from the elevations (plateau at the looser tolerance the generator may fall back to).
      const kind = siteKind(classifyTile(map.elevation, map.water, i, PLATEAU_TOL_LOOSE));
      if (kind !== c.kind) reasons.push(`cache ${k} kind mismatch: ${c.kind} on ${kind ?? 'neither'}`);
    }
    if (chebyshev(c, spawn) < CACHE_MIN_SPACING) reasons.push(`cache ${k} too close to spawn`);
    if (chebyshev(c, summit) < CACHE_MIN_SPACING) reasons.push(`cache ${k} too close to summit`);
    for (let j = 0; j < k; j++) {
      if (chebyshev(c, map.caches[j]) < CACHE_MIN_SPACING) reasons.push(`caches ${j} and ${k} too close`);
    }
  });

  // --- peaks
  if (!map.peaks.some((p) => p.x === summit.x && p.y === summit.y)) reasons.push('peaks do not include the summit');

  // --- costs (only meaningful once the summit is reachable at all)
  if (!report.summitReachable) {
    reasons.push('direct cost undefined: summit unreachable');
  } else {
    const costs = buildStepCosts(map);
    report.directCost = dijkstraFrom(costs, spawnIdx)[summitIdx];
    if (!(report.directCost >= DIRECT_COST_MIN && report.directCost <= DIRECT_COST_MAX)) {
      reasons.push(`direct cost ${report.directCost} outside ${DIRECT_COST_MIN}..${DIRECT_COST_MAX}`);
    }
    if (cacheIdx.length === n && n <= 8) {
      const search = staminaSearch(costs, spawnIdx, summitIdx, cacheIdx);
      report.bestArrivalStamina = search.arrival;
      search.collectable.forEach((ok, k) => {
        if (!ok) reasons.push(`cache ${k} can never be reached alive`);
      });
    }
    if (!(report.bestArrivalStamina >= FEASIBILITY_MARGIN)) {
      reasons.push(`best arrival stamina ${report.bestArrivalStamina} below margin ${FEASIBILITY_MARGIN}`);
    }
  }

  report.ok = reasons.length === 0;
  return report;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/** The 16 tiles of the radius-2 square ring in circular order (for saddle detection). */
const RING: ReadonlyArray<readonly [number, number]> = [
  [-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
  [2, -1], [2, 0], [2, 1], [2, 2],
  [1, 2], [0, 2], [-1, 2], [-2, 2],
  [-2, 1], [-2, 0], [-2, -1],
];

/** classifyTile labels; 0 = neither. */
const KIND_PLATEAU = 1;
const KIND_SADDLE = 2;

/** Cache kind of a classifyTile label, null when the tile is neither. */
function siteKind(kind: number): CacheKind | null {
  return kind === KIND_SADDLE ? 'saddle' : kind === KIND_PLATEAU ? 'plateau' : null;
}

const PLATEAU_MIN_ELEV = 0.35;
const SADDLE_MIN_ELEV = 0.26;
const SADDLE_DEADBAND = 0.004;
const SADDLE_MIN_RELIEF = 0.018;
/** A col is a critical point: its +-1 tile central-difference gradient must stay below this (per tile). */
const SADDLE_MAX_GRADIENT = 0.02;
const ringSigns = new Int8Array(16);
const ringRunSign = new Int8Array(16);
const ringRunLen = new Int8Array(16);

/**
 * Cyclic sign changes around the ring after discarding level samples and single-sample flickers,
 * so only coherent high / low sectors count (a true saddle has two of each: 4 changes).
 */
function ringSignChanges(signs: Int8Array): number {
  const n = signs.length;
  // Start just after a sign change so no run wraps around the array end.
  let start = -1;
  let prev = 0;
  for (let k = 0; k < 2 * n && start < 0; k++) {
    const s = signs[k % n];
    if (s === 0) continue;
    if (prev !== 0 && s !== prev) start = k % n;
    prev = s;
  }
  if (start < 0) return 0;
  let runs = 0;
  for (let k = 0; k < n; k++) {
    const s = signs[(start + k) % n];
    if (s === 0) continue;
    if (runs > 0 && ringRunSign[runs - 1] === s) ringRunLen[runs - 1]++;
    else {
      ringRunSign[runs] = s;
      ringRunLen[runs] = 1;
      runs++;
    }
  }
  // Drop flickers, then merge neighbouring runs that now share a sign (cyclically).
  let kept = 0;
  let first = 0;
  let last = 0;
  for (let r = 0; r < runs; r++) {
    if (ringRunLen[r] < 2) continue;
    const s = ringRunSign[r];
    if (kept === 0) first = s;
    else if (s === last) continue;
    last = s;
    kept++;
  }
  if (kept > 1 && first === last) kept--;
  return kept < 2 ? 0 : kept;
}

/**
 * Classifies land tile i as plateau (flat radius-2 neighbourhood at elevation >= 0.35) or saddle (ring
 * around it alternates higher / lower at least twice: >= 4 sign changes, and the centre itself is level:
 * no neighbour step beyond SLOPE_GENTLE_MAX and a small gradient, so crag flanks do not count).
 * Returns 0 for neither, which includes water and the 2-tile rim where the ring would leave the sheet.
 */
function classifyTile(elevation: Float32Array, water: Uint8Array, i: number, plateauTol: number): number {
  const x = i % MAP_W;
  const y = (i - x) / MAP_W;
  if (x < 2 || y < 2 || x >= MAP_W - 2 || y >= MAP_H - 2 || water[i]) return 0;
  const e = elevation[i];

  // Saddle test on the radius-2 ring.
  if (e >= SADDLE_MIN_ELEV) {
    let maxUp = 0;
    let maxDown = 0;
    for (let r = 0; r < RING.length; r++) {
      const d = elevation[(y + RING[r][1]) * MAP_W + x + RING[r][0]] - e;
      if (d > maxUp) maxUp = d;
      if (d < maxDown) maxDown = d;
      ringSigns[r] = d > SADDLE_DEADBAND ? 1 : d < -SADDLE_DEADBAND ? -1 : 0;
    }
    if (maxUp >= SADDLE_MIN_RELIEF && -maxDown >= SADDLE_MIN_RELIEF && ringSignChanges(ringSigns) >= 4) {
      let near = 0;
      for (let d = 0; d < 4; d++) near = Math.max(near, Math.abs(elevation[i + NEIGHBOR_DELTA[d]] - e));
      const gx = (elevation[i + 1] - elevation[i - 1]) / 2;
      const gy = (elevation[i + MAP_W] - elevation[i - MAP_W]) / 2;
      if (near <= SLOPE_GENTLE_MAX && Math.hypot(gx, gy) <= SADDLE_MAX_GRADIENT) return KIND_SADDLE;
    }
  }

  // Plateau test over the 5x5 block.
  if (e < PLATEAU_MIN_ELEV) return 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const j = (y + dy) * MAP_W + x + dx;
      if (water[j] || Math.abs(elevation[j] - e) > plateauTol) return 0;
    }
  }
  return KIND_PLATEAU;
}

const PEAK_RADIUS = 3;
const PEAK_MIN_ELEV = 0.5;
const PEAK_MAX_COUNT = 12;

/** Notable local maxima (strict max within PEAK_RADIUS), highest first, always including the summit. */
function findPeaks(elevation: Float32Array, water: Uint8Array, summit: Point): Peak[] {
  const peaks: Peak[] = [];
  const r2 = PEAK_RADIUS * PEAK_RADIUS;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      const e = elevation[i];
      if (water[i] || e < PEAK_MIN_ELEV) continue;
      let isMax = true;
      for (let dy = -PEAK_RADIUS; dy <= PEAK_RADIUS && isMax; dy++) {
        for (let dx = -PEAK_RADIUS; dx <= PEAK_RADIUS; dx++) {
          if ((dx === 0 && dy === 0) || dx * dx + dy * dy > r2) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          if (elevation[ny * MAP_W + nx] >= e) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ x, y, elevation: e });
    }
  }
  peaks.sort((a, b) => b.elevation - a.elevation || a.y - b.y || a.x - b.x);
  const top = peaks.slice(0, PEAK_MAX_COUNT);
  if (!top.some((p) => p.x === summit.x && p.y === summit.y)) {
    const summitPeak = { x: summit.x, y: summit.y, elevation: elevation[tileIndex(summit.x, summit.y)] };
    if (top.length >= PEAK_MAX_COUNT) top.pop();
    top.push(summitPeak);
    top.sort((a, b) => b.elevation - a.elevation || a.y - b.y || a.x - b.x);
  }
  return top;
}

/** Connected land components over passable steps (passability is symmetric). -1 = water. */
function labelComponents(grid: TerrainGrid): { comp: Int32Array; count: number } {
  const comp = new Int32Array(N_TILES).fill(-1);
  const queue = new Int32Array(N_TILES);
  let count = 0;
  for (let s = 0; s < N_TILES; s++) {
    if (grid.water[s] || comp[s] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = count;
    while (head < tail) {
      const u = queue[head++];
      const mask = grid.passMask[u];
      for (let d = 0; d < 4; d++) {
        if (!(mask & DIR_BIT[d])) continue;
        const v = u + NEIGHBOR_DELTA[d];
        if (comp[v] !== -1) continue;
        comp[v] = count;
        queue[tail++] = v;
      }
    }
    count++;
  }
  return { comp, count };
}

// ---------------------------------------------------------------------------
// Objective placement
// ---------------------------------------------------------------------------

/**
 * Preferred sub-band of the direct cost (inside DIRECT_COST_MIN..MAX). Tuned with a fog-limited
 * play-through bot: just under half of the maps (about 46%) need a cache even with full knowledge, a
 * sensible route under fog typically needs one or two, and most seeds stay winnable without knowing the map.
 */
const DIRECT_COST_SWEET_MIN = 85;
const DIRECT_COST_SWEET_MAX = 105;
/** A cache counts as "on the route" if visiting it costs at most this much extra stamina. */
export const ROUTE_DETOUR_MAX = 24;
/** Progress along the direct cost (from the spawn) at which route caches are sought, one per entry. */
const ROUTE_TARGETS: readonly number[] = [0.3, 0.55, 0.78];
/**
 * Route-cache preference for sites near the straight spawn->summit line (score per tile off the line).
 * Under fog the player navigates by the HUD compass bearing, not the full-knowledge optimum, so a
 * route cache that also sits near that bearing is one a sensible player can actually come across.
 */
const ROUTE_BEARING_WEIGHT = 3;
/**
 * Exploration caches lose this much score per tile off the spawn->summit line: they still spread out,
 * but stay within panorama reach of the bearing instead of drifting into the far corners of the sheet.
 */
const EXPLORE_BEARING_WEIGHT = 1.5;
/**
 * Spawn preference for bearings that pass real cache sites: every plateau / saddle within
 * SPAWN_BEARING_RADIUS tiles of the straight spawn->summit line (and far enough from both ends to hold a
 * cache) adds SPAWN_BEARING_SITE_WEIGHT times the spawn's base pick weight. True cols are far rarer than
 * the crag flanks a ring test alone would accept, so a random spawn often has no site near its bearing at
 * all, and then no route cache can be one a player following the compass comes across (measured with the
 * fog-limited bot: about 60% wins without this preference, about 68% with it).
 */
const SPAWN_BEARING_RADIUS = 3;
const SPAWN_BEARING_SITE_WEIGHT = 3;
const SPAWN_TRIES = 4;
const CACHE_TRIES = 3;
/** Exploration caches: spacing beyond this (tiles) earns no extra score; costs beyond the cap are penalised. */
const EXPLORE_SPREAD_CAP = 20;
const EXPLORE_COST_MAX = 120;
/** Plateau flatness tolerance (max |delta| over the 5x5 block), with a looser fallback on rugged maps. */
const PLATEAU_TOL = 0.035;
const PLATEAU_TOL_LOOSE = 0.05;
const MIN_SITE_COUNT = 40;

interface Candidate {
  i: number;
  x: number;
  y: number;
  kind: CacheKind;
}

function weightedPick<T>(rng: Rng, items: readonly T[], weight: (t: T) => number): T | null {
  let total = 0;
  for (const it of items) total += weight(it);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const it of items) {
    r -= weight(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

/**
 * Relative pick weight of spawn tile i: sweet-band direct cost, and cache sites near its bearing
 * (`sites` = the component's sites already spaced from the summit).
 */
function spawnWeight(i: number, summit: Point, costTo: Float64Array, sites: readonly Candidate[]): number {
  const p = pointOf(i);
  let nearBearing = 0;
  for (const c of sites) {
    if (chebyshev(c, p) >= CACHE_MIN_SPACING && distToSegment(c, p, summit) <= SPAWN_BEARING_RADIUS) nearBearing++;
  }
  const cost = costTo[i];
  const sweet = cost >= DIRECT_COST_SWEET_MIN && cost <= DIRECT_COST_SWEET_MAX ? 3 : 1;
  return sweet * (1 + SPAWN_BEARING_SITE_WEIGHT * nearBearing);
}

/** Legal spawn tiles of one component (validateMap's spawn rules, plus the direct-cost band). */
function spawnCandidates(grid: TerrainGrid, comp: Int32Array, compId: number, costTo: Float64Array): number[] {
  const out: number[] = [];
  for (let y = EDGE_MARGIN; y < MAP_H - EDGE_MARGIN; y++) {
    for (let x = EDGE_MARGIN; x < MAP_W - EDGE_MARGIN; x++) {
      const i = y * MAP_W + x;
      if (comp[i] !== compId) continue;
      const e = grid.elevation[i];
      if (e < SPAWN_MIN_ELEV || e > SPAWN_MAX_ELEV) continue;
      if (grid.passMask[i] !== 15) continue;
      const c = costTo[i];
      if (c < DIRECT_COST_MIN || c > DIRECT_COST_MAX) continue;
      if (nearCliff(grid.cliffMask, x, y)) continue;
      out.push(i);
    }
  }
  return out;
}

/**
 * Chooses cache sites: up to three (at least two) along cheap spawn->summit routes at staggered progress,
 * the rest spread out for exploration. Returns null if not enough sites satisfy the spacing rules.
 */
function pickCaches(
  rng: Rng,
  sites: readonly Candidate[],
  spawn: Point,
  summit: Point,
  fromSpawn: Float64Array,
  toSummit: Float64Array,
): Candidate[] | null {
  const direct = toSummit[tileIndex(spawn.x, spawn.y)];
  const count = randInt(rng, CACHE_MIN_COUNT, CACHE_MAX_COUNT);
  const chosen: Candidate[] = [];
  const spacingOk = (c: Candidate): boolean =>
    chebyshev(c, spawn) >= CACHE_MIN_SPACING &&
    chebyshev(c, summit) >= CACHE_MIN_SPACING &&
    chosen.every((o) => chebyshev(c, o) >= CACHE_MIN_SPACING);
  const pool = sites.filter((c) => Number.isFinite(fromSpawn[c.i]) && Number.isFinite(toSummit[c.i]) && spacingOk(c));
  if (pool.length < count) return null;

  // Route caches: small detour, staggered along the way (early, midway and nearer the top).
  for (const target of ROUTE_TARGETS) {
    let best: Candidate | null = null;
    let bestScore = Infinity;
    for (const c of pool) {
      if (!spacingOk(c)) continue;
      const detour = fromSpawn[c.i] + toSummit[c.i] - direct;
      if (detour > ROUTE_DETOUR_MAX) continue;
      const score =
        detour +
        Math.abs(fromSpawn[c.i] - target * direct) * 0.6 +
        distToSegment(c, spawn, summit) * ROUTE_BEARING_WEIGHT +
        rng() * 6;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) chosen.push(best);
  }
  if (chosen.length < 2) return null;

  // Exploration caches: spread out, off the map rim, reachable on roughly one refill, mixing both kinds.
  while (chosen.length < count) {
    const anchors: Point[] = [spawn, summit, ...chosen];
    const hasSaddle = chosen.some((c) => c.kind === 'saddle');
    const hasPlateau = chosen.some((c) => c.kind === 'plateau');
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of pool) {
      if (!spacingOk(c)) continue;
      let dmin = Infinity;
      for (const a of anchors) dmin = Math.min(dmin, Math.hypot(c.x - a.x, c.y - a.y));
      const cost = fromSpawn[c.i];
      let score =
        Math.min(dmin, EXPLORE_SPREAD_CAP) + rng() * 8 - distToSegment(c, spawn, summit) * EXPLORE_BEARING_WEIGHT;
      if (cost > EXPLORE_COST_MAX) score -= (cost - EXPLORE_COST_MAX) * 0.15;
      if (nearSheetEdge(c.x, c.y)) score -= 5;
      if ((!hasSaddle && c.kind === 'saddle') || (!hasPlateau && c.kind === 'plateau')) score += 3;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen.length >= CACHE_MIN_COUNT ? chosen : null;
}

function assembleMap(
  seed: number,
  grid: TerrainGrid,
  spawn: Point,
  summit: Point,
  caches: readonly Candidate[],
  stats: MapStats,
): MapData {
  const cacheSites: CacheSite[] = caches.map((c, id) => ({ id, x: c.x, y: c.y, kind: c.kind }));
  return {
    seed,
    width: MAP_W,
    height: MAP_H,
    elevation: grid.elevation,
    water: grid.water,
    passMask: grid.passMask,
    cliffMask: grid.cliffMask,
    spawn: { x: spawn.x, y: spawn.y },
    summit: { x: summit.x, y: summit.y },
    caches: cacheSites,
    peaks: findPeaks(grid.elevation, grid.water, summit),
    stats,
    sampleElevation: grid.sample,
  };
}

/** Terrain-level sanity limits before any objective placement is attempted. */
const WATER_FRACTION_MIN = 0.07;
const WATER_FRACTION_MAX = 0.18;
const CLIFF_FRACTION_MIN = 0.008;
const CLIFF_FRACTION_MAX = 0.06;

/** Tries to place objectives on one terrain; returns a validated map or null. */
function placeObjectives(seed: number, grid: TerrainGrid, rng: Rng, attempt: number, t0: number): MapData | null {
  const costs = buildStepCosts(grid);
  const { comp, count } = labelComponents(grid);

  // Highest tile per component; the summit is the highest tile of the spawn's component.
  const compMax = new Int32Array(count).fill(-1);
  const compSize = new Int32Array(count);
  let landTiles = 0;
  for (let i = 0; i < N_TILES; i++) {
    const c = comp[i];
    if (c < 0) continue;
    landTiles++;
    compSize[c]++;
    if (compMax[c] < 0 || grid.elevation[i] > grid.elevation[compMax[c]]) compMax[c] = i;
  }
  const order: number[] = [];
  for (let c = 0; c < count; c++) if (grid.elevation[compMax[c]] > SUMMIT_MIN_ELEV) order.push(c);
  order.sort((a, b) => grid.elevation[compMax[b]] - grid.elevation[compMax[a]]);

  let sitesCache: Candidate[] | null = null;
  const siteList = (tol: number): Candidate[] => {
    const out: Candidate[] = [];
    for (let i = 0; i < N_TILES; i++) {
      const kind = siteKind(classifyTile(grid.elevation, grid.water, i, tol));
      if (kind === null) continue;
      const p = pointOf(i);
      out.push({ i, x: p.x, y: p.y, kind });
    }
    return out;
  };

  // order[0] holds the highest land tile of the whole sheet.
  const topElev = order.length > 0 ? grid.elevation[compMax[order[0]]] : 0;
  for (const compId of order.slice(0, 2)) {
    const summitIdx = compMax[compId];
    // A fallback component whose top is overlooked by a higher (unreachable) spire, or a top on the
    // sheet's rim, would break validateMap's summit rules: leave it to the next terrain attempt.
    if (grid.elevation[summitIdx] + SUMMIT_RIVAL_TOL < topElev) continue;
    const summit = pointOf(summitIdx);
    if (nearSheetEdge(summit.x, summit.y)) continue;
    const toSummit = dijkstraTo(costs, summitIdx);
    const candidates = spawnCandidates(grid, comp, compId, toSummit);
    if (candidates.length === 0) continue;

    if (!sitesCache) {
      sitesCache = siteList(PLATEAU_TOL);
      if (sitesCache.length < MIN_SITE_COUNT) sitesCache = siteList(PLATEAU_TOL_LOOSE);
    }
    const sites = sitesCache.filter((c) => comp[c.i] === compId);
    const summitSpaced = sites.filter((c) => chebyshev(c, summit) >= CACHE_MIN_SPACING);
    const weights = new Float64Array(N_TILES);
    for (const i of candidates) weights[i] = spawnWeight(i, summit, toSummit, summitSpaced);
    const tried: Point[] = [];
    for (let s = 0; s < SPAWN_TRIES; s++) {
      const fresh = candidates.filter((i) => {
        const p = pointOf(i);
        return tried.every((t) => chebyshev(p, t) >= 6);
      });
      const i = weightedPick(rng, fresh, (idx) => weights[idx]);
      if (i === null) break;
      const spawn = pointOf(i);
      tried.push(spawn);
      const fromSpawn = dijkstraFrom(costs, i);

      for (let t = 0; t < CACHE_TRIES; t++) {
        const caches = pickCaches(rng, sites, spawn, summit, fromSpawn, toSummit);
        if (!caches) break;
        const stats: MapStats = {
          attempts: attempt,
          waterFraction: grid.waterFraction,
          reachableFraction: compSize[compId] / Math.max(1, landTiles),
          directCost: toSummit[i],
          bestArrivalStamina: 0,
          cliffEdges: grid.cliffEdges,
          genMs: 0,
        };
        const map = assembleMap(seed, grid, spawn, summit, caches, stats);
        const report = validateMap(map);
        if (report.ok) {
          stats.directCost = report.directCost;
          stats.bestArrivalStamina = report.bestArrivalStamina;
          stats.genMs = performance.now() - t0;
          return map;
        }
      }
    }
  }
  return null;
}

/** Terrain seed for a given attempt: the player-facing seed is kept, variants are derived from it. */
function terrainSeedFor(seed: number, attempt: number): number {
  return hashSeed(seed >>> 0, attempt);
}

/**
 * Generates a complete, validated expedition map for `seed` (deterministic per seed).
 * Always returns a map for which validateMap(...).ok is true; failing terrains are regenerated from
 * derived seeds (hashSeed(seed, attempt)), beyond MAX_GEN_ATTEMPTS if that were ever necessary.
 */
export function generateMap(seed: number): MapData {
  const t0 = performance.now();
  for (let attempt = 1; ; attempt++) {
    const terrainSeed = terrainSeedFor(seed, attempt);
    const grid = buildGrid(createTerrainSampler(terrainSeed));
    const cliffFraction = grid.cliffEdges / Math.max(1, grid.landEdges);
    // Beyond the attempt budget only hard rules matter; aesthetic limits are relaxed.
    const strict = attempt <= MAX_GEN_ATTEMPTS;
    if (
      strict &&
      (grid.waterFraction < WATER_FRACTION_MIN ||
        grid.waterFraction > WATER_FRACTION_MAX ||
        cliffFraction < CLIFF_FRACTION_MIN ||
        cliffFraction > CLIFF_FRACTION_MAX)
    ) {
      continue;
    }
    const rng = mulberry32(hashSeed(terrainSeed, 0x5eed));
    const map = placeObjectives(seed, grid, rng, attempt, t0);
    if (map) return map;
  }
}

/** Fraction of land-to-land edges that are sheer cliffs, read from cliffMask (diagnostics and tests). */
export function cliffEdgeFraction(map: MapData): number {
  let cliffs = 0;
  for (let i = 0; i < N_TILES; i++) {
    // Count each undirected edge once, from its left / upper tile.
    if (map.cliffMask[i] & DIRS.right.bit) cliffs++;
    if (map.cliffMask[i] & DIRS.down.bit) cliffs++;
  }
  const land = countLandEdges(map.water);
  return land === 0 ? 0 : cliffs / land;
}
