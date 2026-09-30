// Map-sheet renderer: a crisp pixel-art vintage survey sheet drawn on the single game canvas.
//
// Static layers are baked once per map into offscreen canvases (via ImageData):
//   - the map layer (hypsometric parchment tint, NW hillshade, water hatching with a
//     tile-true shoreline, contours, cliff hachures, index-contour labels, paper texture)
//     plus a "faded ink" variant,
//   - the fog texture (dense parchment fog, hatching, wind rose) and the TERRA INCOGNITA
//     lettering as separate whole glyphs,
//   - the desk + sheet chrome (neatlines, grid letters, title band, scale bar, north arrow).
// Each frame only diffs state.revealed / state.visible and recomposites the changed tiles,
// then blits the cached layers and draws the dynamic pieces (route, objects, player,
// effects, collapse / summit animations) before handing over to the HUD and overlay; after
// a map change the whole previous frame is dissolved over the result.
import {
  COLLAPSE_ANIM_MS,
  CONTOUR_INTERVAL,
  COST_FLAT,
  COST_GENTLE,
  COST_STEEP,
  INDEX_CONTOUR_EVERY,
  MAP_H,
  MAP_ORIGIN_X,
  MAP_ORIGIN_Y,
  MAP_PX_H,
  MAP_PX_W,
  MAP_W,
  MAX_ELEV_M,
  MOVE_ANIM_MS,
  PALETTE,
  PANORAMA_TILE_THRESHOLD,
  TILE,
  VICTORY_ANIM_MS,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  VISION_HIGH,
  VISION_HIGH_MIN,
  VISION_MID_MIN,
  WATER_LEVEL,
} from './config';
import { GLYPH_H, drawText, fontEpoch, measureText } from './font';
import { REPORT_GHOST_ALPHA, drawHud, drawOverlay, drawUi } from './hud';
import { langVersion, t } from './i18n';
import { TAP_RIPPLE_MS, ui } from './ui';
import { hashSeed, mulberry32 } from './rng';
import { stepEcho } from './echo';
import type { StepEcho } from './echo';
import { visionRadiusFor } from './game';
import { tileIndex, toMeters } from './terrain';
import { DIRS } from './types';
import type { Effect, EffectKind, GameState, MapData, Peak, Point } from './types';
import {
  DitherPatterns,
  SIGHT_EYE_ART,
  bayerT,
  createSpriteBank,
  fillDisc,
  fillRing,
  mixHex,
  packHex,
  plotLine,
  unpackRgb,
  packRgb,
} from './sprites';
import type { Sprite, SpriteBank } from './sprites';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const W = MAP_PX_W;
const H = MAP_PX_H;
const NPIX = W * H;
const NTILES = MAP_W * MAP_H;

/** The paper sheet on the desk (canvas px). The HUD panel sits to its right. */
const SHEET_X = 6;
const SHEET_Y = 6;
const SHEET_W = 996;
const SHEET_H = 788;

/** Map rect edges in canvas px (exclusive right / bottom). */
const MX0 = MAP_ORIGIN_X;
const MY0 = MAP_ORIGIN_Y;
const MX1 = MAP_ORIGIN_X + W;
const MY1 = MAP_ORIGIN_Y + H;

/** Metres per tile implied by the sheet's scale bar. */
const METRES_PER_TILE = 50;
/** Left edge of the symbol legend in the title band. */
const LEGEND_X = 402;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Newly surveyed tiles fade in from the fog over this long. */
const REVEAL_FADE_MS = 260;
/** A fog glyph fades out over this long once ground under it is surveyed. */
const GLYPH_FADE_MS = 300;
/** Period of the beacon ring around a sighted Trig Pillar. */
const TRIG_BEACON_MS = 1600;
/** A newly sighted cache pings for this long, in this many rings. */
const CACHE_BEACON_MS = 1600;
const CACHE_BEACON_PULSES = 2;
/**
 * A big reveal (at least PANORAMA_TILE_THRESHOLD new tiles in one step) follows the survey-burst
 * ring outward. Without a burst on the sheet (the summit step, a smaller sight radius) it
 * spreads as a radius-VISION_HIGH ring of this length would.
 */
const RIPPLE_MS = 900;
/** The "you are here" ring shows for this long after an expedition starts ... */
const YOU_ARE_HERE_START_MS = 3000;
/** ... and again once the surveyor has stood still this long. */
const YOU_ARE_HERE_IDLE_MS = 1500;
/** Each ping of the ring steps outward 1 px this often. */
const YOU_ARE_HERE_STEP_MS = 220;
/** Collapse progress until which the fallen surveyor stays opaque on the ink, and when it is gone. */
const FALLEN_SOLID_UNTIL = 0.45;
const FALLEN_GONE_AT = 0.6;
const BUMP_SHAKE_MS = 160;
/** Vision ring radius eases toward the current radius with this time constant. */
const RING_EASE_MS = 140;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** Land tint ramp, lightest (lit lowland) to darkest (shaded high ground). */
const LAND_RAMP_HEX = ['#fbf6e9', '#f4ecd8', '#efe5ca', '#e8dcbf', '#e1d2b1', '#d9c9a3', '#cfbd95', '#c4b087'];
const FOG_RAMP_HEX = ['#f2e9d4', PALETTE.fog, '#e4d8bb', PALETTE.fogSpeck];
const WATER_HATCH_HEX = mixHex(PALETTE.water, PALETTE.waterInk, 0.42);
const WATER_DEEP_HEX = mixHex(PALETTE.water, PALETTE.waterInk, 0.1);
const MINOR_CONTOUR_HEX = mixHex(PALETTE.inkSoft, PALETTE.inkFaded, 0.3);
const INDEX_CONTOUR_HEX = PALETTE.ink;
/** Sight lines: the heights where the sight radius widens, one per band edge. */
const SIGHT_HEIGHTS: readonly number[] = [VISION_MID_MIN, VISION_HIGH_MIN];
/** Older survey outside the current line of sight is blended this far toward FADE_TARGET. */
const FADE_TARGET_HEX = '#efe6cf';
const FADE_AMOUNT = 0.3;
const FOG_RIM_HEX = '#d3c4a1';
/** Reveal-field window mapped onto the dither threshold (wider = softer fog edge). */
const REVEAL_LO = 0.18;
const REVEAL_SPAN = 0.62;
/** Strength of the billow displacement (field units per 127 at r = 0.5). */
const BILLOW_AMP = (0.3 * 4) / 127;
const SHADOW_HEX = '#170f0c';
/** Multiply tints for the collapse darkening, lightest to darkest (index 0 = none). */
const DIM_STEPS: readonly string[] = Array.from({ length: 11 }, (_, i) => mixHex('#ffffff', '#9c8a70', (i / 10) * 0.75));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/** Deterministic per-pixel hash in [0, 1). */
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

type Noise2 = (x: number, y: number) => number;

/** Seeded smooth value noise in [0, 1). */
function makeValueNoise(seed: number): Noise2 {
  const rng = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rng();
  return (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const a = vals[perm[perm[X] + Y]];
    const b = vals[perm[perm[X + 1] + Y]];
    const c = vals[perm[perm[X] + Y + 1]];
    const d = vals[perm[perm[X + 1] + Y + 1]];
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function makeSurface(w: number, h: number, willReadFrequently = false): Surface {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

function packAll(hexes: readonly string[]): Uint32Array {
  return Uint32Array.from(hexes.map(packHex));
}

/** Draw text with a 1 px knockout outline (4-neighbour) for legibility on busy terrain. */
function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  outline: string,
  align: 'left' | 'center' | 'right' = 'left',
  scale = 1,
): void {
  drawText(ctx, text, x - 1, y, { color: outline, align, scale });
  drawText(ctx, text, x + 1, y, { color: outline, align, scale });
  drawText(ctx, text, x, y - 1, { color: outline, align, scale });
  drawText(ctx, text, x, y + 1, { color: outline, align, scale });
  drawText(ctx, text, x, y, { color, align, scale });
}

/** One letter of the fog lettering, pre-rendered, with the tiles whose survey can touch it. */
interface FogGlyph {
  sprite: Sprite;
  /** Top-left in map px. */
  x: number;
  y: number;
  /** Tiles whose reveal field reaches the glyph box (its own tiles plus a half-tile margin). */
  tiles: number[];
}

function makeFogGlyph(ch: string, x: number, y: number, scale: number, color: string): FogGlyph {
  const w = measureText(ch, scale);
  const h = GLYPH_H * scale;
  const surf = makeSurface(w, h);
  drawText(surf.ctx, ch, 0, 0, { color, scale });
  const tiles: number[] = [];
  const half = TILE / 2;
  const tx0 = clamp(Math.floor((x - half) / TILE), 0, MAP_W - 1);
  const tx1 = clamp(Math.floor((x + w - 1 + half) / TILE), 0, MAP_W - 1);
  const ty0 = clamp(Math.floor((y - half) / TILE), 0, MAP_H - 1);
  const ty1 = clamp(Math.floor((y + h - 1 + half) / TILE), 0, MAP_H - 1);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.push(tileIndex(tx, ty));
  return { sprite: { canvas: surf.canvas, w, h }, x, y, tiles };
}

/** Letter-spaced text centred on cx, laid out as separate fog glyphs. */
function spacedFogGlyphs(text: string, cx: number, y: number, scale: number, gap: number, color: string): FogGlyph[] {
  const chars = Array.from(text.toUpperCase());
  const adv = 6 * scale + gap;
  const total = chars.length * adv - gap - scale;
  let x = Math.round(cx - total / 2);
  const glyphs: FogGlyph[] = [];
  for (const ch of chars) {
    if (ch !== ' ') glyphs.push(makeFogGlyph(ch, x, y, scale, color));
    x += adv;
  }
  return glyphs;
}

// ---------------------------------------------------------------------------
// Map layer: elevation field
// ---------------------------------------------------------------------------

/**
 * Per-pixel elevation at pixel centres. The cost of map.sampleElevation is probed first;
 * when a full-resolution pass would be slow the field is sampled every 2-4 px and
 * bilinearly interpolated (visually indistinguishable at these contour intervals).
 */
function sampleElevationField(map: MapData): { elev: Float32Array; step: number } {
  const PROBE = 3000;
  let checksum = 0;
  const t0 = performance.now();
  for (let i = 0; i < PROBE; i++) {
    checksum += map.sampleElevation(((i * 7919) % 8000) / 100, ((i * 104729) % 6000) / 100);
  }
  const estimateFull = ((performance.now() - t0) / PROBE) * NPIX;
  if (!Number.isFinite(checksum)) console.warn('[renderer] sampleElevation returned non-finite values');
  const step = estimateFull <= 40 ? 1 : estimateFull / 4 <= 50 ? 2 : estimateFull / 9 <= 50 ? 3 : 4;

  const elev = new Float32Array(NPIX);
  if (step === 1) {
    for (let py = 0, p = 0; py < H; py++) {
      const ty = (py + 0.5) / TILE;
      for (let px = 0; px < W; px++, p++) elev[p] = clamp01(map.sampleElevation((px + 0.5) / TILE, ty) || 0);
    }
    return { elev, step };
  }

  const gw = Math.floor((W - 1) / step) + 2;
  const gh = Math.floor((H - 1) / step) + 2;
  const grid = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const ty = (j * step + 0.5) / TILE;
    for (let i = 0; i < gw; i++) grid[j * gw + i] = clamp01(map.sampleElevation((i * step + 0.5) / TILE, ty) || 0);
  }
  const ix = new Int32Array(W);
  const fx = new Float32Array(W);
  for (let px = 0; px < W; px++) {
    ix[px] = Math.floor(px / step);
    fx[px] = (px - ix[px] * step) / step;
  }
  for (let py = 0, p = 0; py < H; py++) {
    const j = Math.floor(py / step);
    const fy = (py - j * step) / step;
    const r0 = j * gw;
    const r1 = r0 + gw;
    for (let px = 0; px < W; px++, p++) {
      const i = ix[px];
      const f = fx[px];
      const a = grid[r0 + i] + (grid[r0 + i + 1] - grid[r0 + i]) * f;
      const b = grid[r1 + i] + (grid[r1 + i + 1] - grid[r1 + i]) * f;
      elev[p] = a + (b - a) * fy;
    }
  }
  return { elev, step };
}

/**
 * Tile cores that must render as their tile's terrain (tile-local px, inclusive): a water
 * tile's central 6 x 6, and for land the same columns carried down over the bottom rows
 * where the surveyor's boots stand.
 */
interface CoreBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const LAND_CORE: CoreBox = { x0: 3, x1: 8, y0: 3, y1: 11 };
const WATER_CORE: CoreBox = { x0: 3, x1: 8, y0: 3, y1: 8 };
/**
 * The coast keeps at least this much (elevation units) away from a core, and corrected pixels
 * are held within this band of the water level (below the lowest contour).
 */
const COAST_MARGIN = 0.004;
/** Reach (px) of a tile's correction beyond its core. */
const COAST_SPREAD = 8;
/** Cap (px) on the signed core distance, so a correction stays local to the coast. */
const COAST_SD_CAP = 6;

function smooth01(t: number): number {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}

/** Distance (px) from pixel centre (px + 0.5, py + 0.5) to the core box of tile (tx, ty). */
function coreDistance(px: number, py: number, tx: number, ty: number, core: CoreBox): number {
  const x = px + 0.5 - tx * TILE;
  const y = py + 0.5 - ty * TILE;
  const dx = Math.max(0, core.x0 - x, x - (core.x1 + 1));
  const dy = Math.max(0, core.y0 - y, y - (core.y1 + 1));
  return Math.hypot(dx, dy);
}

/**
 * Signed distance (px) of a pixel to the tile-true shore: half the difference between its
 * distance to the nearest water core and to the nearest land core, so it is zero midway
 * between cores of different kinds, positive toward land cores, negative toward water cores
 * (at least 1.75 px inside any core), and capped at COAST_SD_CAP.
 */
function shoreDistance(map: MapData, px: number, py: number): number {
  const tx = (px / TILE) | 0;
  const ty = (py / TILE) | 0;
  let dWater = COAST_SD_CAP * 2;
  let dLand = COAST_SD_CAP * 2;
  for (let ny = Math.max(0, ty - 1); ny <= Math.min(MAP_H - 1, ty + 1); ny++) {
    for (let nx = Math.max(0, tx - 1); nx <= Math.min(MAP_W - 1, tx + 1); nx++) {
      if (map.water[tileIndex(nx, ny)]) dWater = Math.min(dWater, coreDistance(px, py, nx, ny, WATER_CORE));
      else dLand = Math.min(dLand, coreDistance(px, py, nx, ny, LAND_CORE));
    }
  }
  return clamp((dWater - dLand) / 2, -COAST_SD_CAP, COAST_SD_CAP);
}

/**
 * Make the drawn coast agree with tile truth: adjusts `elev` in place and returns the
 * per-pixel water mask (elev < WATER_LEVEL).
 *
 * The shoreline is the WATER_LEVEL iso-line of the continuous field, so it keeps its natural
 * shape wherever it already respects the tiles. Where it would cut into a tile's core, the
 * field is pulled toward the tile-true shore: v = (e - WATER_LEVEL) + k * sd, with sd the
 * signed core distance (positive in every land core, negative in every water core). Each
 * offending tile needs a certain k; the k field is spread smoothly around those cores (the
 * largest wins), and since a larger k only pushes every core further to its own side, no
 * correction can break another tile's guarantee. Where the terrain is flat the coast then
 * settles midway between land and water cores; on real slopes it barely moves. A corrected
 * pixel only ever moves toward the water level and never past the thin COAST_MARGIN band
 * around it, so no new contour lines appear. Contours are not untouched, though: on steep
 * banks next to a water tile a thin rim of land above the lowest contour (typically 50-130 px
 * per map, up to a few tens of metres above the water level) is pulled under water, and the
 * contour lines it carried end at the new coast.
 */
function fitShoreline(map: MapData, elev: Float32Array): Uint8Array {
  const need = new Float32Array(NTILES);
  let any = false;
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const i = tileIndex(tx, ty);
      const wet = map.water[i] === 1;
      const core = wet ? WATER_CORE : LAND_CORE;
      let k = 0;
      for (let oy = core.y0; oy <= core.y1; oy++) {
        const py = ty * TILE + oy;
        for (let ox = core.x0; ox <= core.x1; ox++) {
          const px = tx * TILE + ox;
          const e = elev[py * W + px] - WATER_LEVEL;
          // Land needs e + k * sd >= margin (sd > 0); water needs e + k * sd <= -margin (sd < 0).
          const short = wet ? e + COAST_MARGIN : COAST_MARGIN - e;
          if (short <= 0) continue;
          k = Math.max(k, short / Math.abs(shoreDistance(map, px, py)));
        }
      }
      need[i] = k;
      if (k > 0) any = true;
    }
  }

  if (any) {
    // Spread each tile's k around its core (max-union), then pull the field toward the shore.
    const gain = new Float32Array(NPIX);
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const k = need[tileIndex(tx, ty)];
        if (k === 0) continue;
        const core = map.water[tileIndex(tx, ty)] ? WATER_CORE : LAND_CORE;
        const px0 = Math.max(0, tx * TILE + core.x0 - COAST_SPREAD);
        const px1 = Math.min(W - 1, tx * TILE + core.x1 + COAST_SPREAD);
        const py0 = Math.max(0, ty * TILE + core.y0 - COAST_SPREAD);
        const py1 = Math.min(H - 1, ty * TILE + core.y1 + COAST_SPREAD);
        for (let py = py0; py <= py1; py++) {
          for (let px = px0; px <= px1; px++) {
            const d = coreDistance(px, py, tx, ty, core) / COAST_SPREAD;
            if (d >= 1) continue;
            const g = k * (1 - smooth01(d));
            const p = py * W + px;
            if (g > gain[p]) gain[p] = g;
          }
        }
      }
    }
    for (let py = 0, p = 0; py < H; py++) {
      for (let px = 0; px < W; px++, p++) {
        if (gain[p] === 0) continue;
        const e = elev[p];
        const v = e + gain[p] * shoreDistance(map, px, py);
        // A corrected pixel ends between its own value and the COAST_MARGIN band around the
        // water level, so no new contour lines appear (see the doc comment for what is lost).
        elev[p] = clamp(v, Math.min(e, WATER_LEVEL - COAST_MARGIN), Math.max(e, WATER_LEVEL + COAST_MARGIN));
      }
    }
  }

  const water = new Uint8Array(NPIX);
  for (let p = 0; p < NPIX; p++) water[p] = elev[p] < WATER_LEVEL ? 1 : 0;
  return water;
}

/** Two-pass 3-4 chamfer distance from land, in thirds of a pixel (0 on land). */
function chamferFromLand(water: Uint8Array): Uint16Array {
  const d = new Uint16Array(NPIX);
  const INF = 60000;
  for (let p = 0; p < NPIX; p++) d[p] = water[p] ? INF : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (d[p] === 0) continue;
      let v = d[p];
      if (x > 0 && d[p - 1] + 3 < v) v = d[p - 1] + 3;
      if (y > 0) {
        if (d[p - W] + 3 < v) v = d[p - W] + 3;
        if (x > 0 && d[p - W - 1] + 4 < v) v = d[p - W - 1] + 4;
        if (x < W - 1 && d[p - W + 1] + 4 < v) v = d[p - W + 1] + 4;
      }
      d[p] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const p = y * W + x;
      if (d[p] === 0) continue;
      let v = d[p];
      if (x < W - 1 && d[p + 1] + 3 < v) v = d[p + 1] + 3;
      if (y < H - 1) {
        if (d[p + W] + 3 < v) v = d[p + W] + 3;
        if (x < W - 1 && d[p + W + 1] + 4 < v) v = d[p + W + 1] + 4;
        if (x > 0 && d[p + W - 1] + 4 < v) v = d[p + W - 1] + 4;
      }
      d[p] = v;
    }
  }
  return d;
}

/** Contour mark values (see markContours). */
const MARK_MINOR = 1;
const MARK_INDEX = 2;
const MARK_SIGHT = 3;

/**
 * Contour marks: 1 = minor contour pixel, 2 = index contour pixel (2 px thick), 3 = sight line
 * pixel (2 px thick). A land pixel is on a contour where its contour level differs from its right
 * or bottom land neighbour; index lines also mark the neighbour so they straddle the boundary.
 * Sight lines follow the band edges of visionRadiusFor itself, so every tile centre lies on the
 * side of the line that sets its sight radius; they take over the contour they coincide with.
 */
function markContours(lvl: Int16Array, water: Uint8Array, elev: Float32Array): Uint8Array {
  const mark = new Uint8Array(NPIX);
  const crossesIndex = (a: number, b: number): boolean => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let l = lo + 1; l <= hi; l++) if (l % INDEX_CONTOUR_EVERY === 0) return true;
    return false;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (water[p]) continue;
      const a = lvl[p];
      if (x < W - 1 && !water[p + 1] && lvl[p + 1] !== a) {
        if (crossesIndex(a, lvl[p + 1])) {
          mark[p] = MARK_INDEX;
          mark[p + 1] = MARK_INDEX;
        } else if (mark[p] === 0) mark[p] = MARK_MINOR;
      }
      if (y < H - 1 && !water[p + W] && lvl[p + W] !== a) {
        if (crossesIndex(a, lvl[p + W])) {
          mark[p] = MARK_INDEX;
          mark[p + W] = MARK_INDEX;
        } else if (mark[p] === 0) mark[p] = MARK_MINOR;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (water[p]) continue;
      const r = visionRadiusFor(elev[p]);
      for (const q of [x < W - 1 ? p + 1 : -1, y < H - 1 ? p + W : -1]) {
        if (q < 0 || water[q] || visionRadiusFor(elev[q]) === r) continue;
        mark[p] = MARK_SIGHT;
        mark[q] = MARK_SIGHT;
      }
    }
  }
  return mark;
}

/** Faint foxing stains (tide-marked blotches) seeded from the map seed; 0..~1 per pixel. */
function buildStains(seed: number): Float32Array {
  const stain = new Float32Array(NPIX);
  const rng = mulberry32(hashSeed(seed, 0x57a1));
  const noise = makeValueNoise(hashSeed(seed, 0x57a2));
  const count = 6 + Math.floor(rng() * 4);
  for (let k = 0; k < count; k++) {
    const cx = rng() * W;
    const cy = rng() * H;
    const r = 7 + rng() * rng() * 34;
    const strength = 0.45 + rng() * 0.45;
    const reach = r * 1.3;
    const x0 = Math.max(0, Math.floor(cx - reach));
    const x1 = Math.min(W - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach));
    const y1 = Math.min(H - 1, Math.ceil(cy + reach));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const d = Math.hypot(px - cx, py - cy);
        const rr = r * (0.74 + 0.52 * noise(px / 8 + k * 37, py / 8));
        const q = d / rr;
        if (q >= 1) continue;
        const v = (0.3 * (1 - q) + (q > 0.78 ? (0.6 * (q - 0.78)) / 0.22 : 0)) * strength;
        const p = py * W + px;
        if (v > stain[p]) stain[p] = v;
      }
    }
  }
  return stain;
}

// ---------------------------------------------------------------------------
// Map layer: labels
// ---------------------------------------------------------------------------

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

interface SpotHeight {
  tile: number;
  /** Tile centre (map px). */
  cx: number;
  cy: number;
  summit: boolean;
  label: Sprite;
  lx: number;
  ly: number;
}

/** Which lines a label pass annotates, and how. */
interface LineLabelSpec {
  /** Mark value of the labelled lines (MARK_INDEX or MARK_SIGHT). */
  mark: number;
  /** Label text at a line pixel, or null to place none there. */
  text: (p: number) => string | null;
  /** Width of the label box (px) for a text. */
  width: (text: string) => number;
  /** At most this many labels on the sheet, and this many per connected line. */
  max: number;
  perLine: number;
  /** Salt for the tie-breaking jitter. */
  salt: number;
}

/** Index contours: their height in metres, up to two per line. */
function indexLabelSpec(lvl: Int16Array): LineLabelSpec {
  return {
    mark: MARK_INDEX,
    text: (p) => {
      const lv = lvl[p];
      const level = lv % INDEX_CONTOUR_EVERY === 0 ? lv : (lv + 1) % INDEX_CONTOUR_EVERY === 0 ? lv + 1 : -1;
      return level <= 0 ? null : String(Math.round(level * CONTOUR_INTERVAL * MAX_ELEV_M));
    },
    width: (text) => measureText(text) + 4,
    max: 12,
    perLine: 2,
    salt: 0x1abe1,
  };
}

const SIGHT_EYE_W = SIGHT_EYE_ART[0].length;

/** Sight lines: eye mark and height (480 / 840), one per line, a few per sheet. */
function sightLabelSpec(elev: Float32Array): LineLabelSpec {
  return {
    mark: MARK_SIGHT,
    text: (p) => {
      // The straddling pixel pair sits either side of the edge: the height is the nearest band edge.
      let best = SIGHT_HEIGHTS[0];
      for (const h of SIGHT_HEIGHTS) if (Math.abs(elev[p] - h) < Math.abs(elev[p] - best)) best = h;
      return String(toMeters(best));
    },
    width: (text) => SIGHT_EYE_W + measureText(text) + 7,
    max: 6,
    perLine: 1,
    salt: 0x5167,
  };
}

/**
 * Choose a handful of upright line labels: on long lines of the spec's kind, where the line
 * runs roughly horizontally, on land, away from objects, cliffs, the sheet edge and each other.
 */
function placeLineLabels(
  map: MapData,
  spotPeaks: readonly Peak[],
  elev: Float32Array,
  water: Uint8Array,
  mark: Uint8Array,
  reserved: readonly LabelBox[],
  spec: LineLabelSpec,
): LabelBox[] {
  // Connected components of the labelled lines' pixels (8-connected).
  const comp = new Int32Array(NPIX).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(NPIX);
  for (let p0 = 0; p0 < NPIX; p0++) {
    if (mark[p0] !== spec.mark || comp[p0] !== -1) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = p0;
    comp[p0] = id;
    while (top > 0) {
      const p = stack[--top];
      size++;
      const x = p % W;
      const y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (mark[q] === spec.mark && comp[q] === -1) {
            comp[q] = id;
            stack[top++] = q;
          }
        }
      }
    }
    sizes.push(size);
  }

  const avoid: Point[] = [map.spawn, map.summit, ...map.caches, ...spotPeaks].map((o) => ({
    x: o.x * TILE + TILE / 2,
    y: o.y * TILE + TILE / 2,
  }));
  const rng = mulberry32(hashSeed(map.seed, spec.salt));

  interface Candidate extends LabelBox {
    comp: number;
    score: number;
    cx: number;
    cy: number;
  }
  const candidates: Candidate[] = [];
  for (let y = 16; y < H - 16; y += 3) {
    for (let x = 24; x < W - 24; x += 3) {
      const p = y * W + x;
      if (mark[p] !== spec.mark) continue;
      const c = comp[p];
      if (sizes[c] < 170) continue;
      const gx = elev[p + 3] - elev[p - 3];
      const gy = elev[p + 3 * W] - elev[p - 3 * W];
      if (Math.abs(gy) < 1.7 * Math.abs(gx) || Math.abs(gy) < 1e-4) continue;
      const text = spec.text(p);
      if (text === null) continue;
      const w = spec.width(text);
      const h = 9;
      const bx = x - (w >> 1);
      const by = y - 4;
      if (bx < 4 || by < 4 || bx + w > W - 4 || by + h > H - 4) continue;
      let ok = true;
      let clutter = 0;
      for (let yy = by - 1; yy <= by + h && ok; yy++) {
        for (let xx = bx - 1; xx <= bx + w; xx++) {
          const q = yy * W + xx;
          if (water[q]) {
            ok = false;
            break;
          }
          if (mark[q] !== 0 && comp[q] !== c) clutter++;
        }
      }
      if (!ok || clutter > 22) continue;
      const cx = bx + w / 2;
      const cy = by + h / 2;
      if (avoid.some((o) => Math.abs(o.x - cx) < w / 2 + 14 && Math.abs(o.y - cy) < 18)) continue;
      if (reserved.some((r) => bx < r.x + r.w + 6 && bx + w + 6 > r.x && by < r.y + r.h + 6 && by + h + 6 > r.y)) {
        continue;
      }
      // No cliff hachures under the label.
      const tx0 = Math.floor((bx - 2) / TILE);
      const tx1 = Math.floor((bx + w + 2) / TILE);
      const ty0 = Math.floor((by - 2) / TILE);
      const ty1 = Math.floor((by + h + 2) / TILE);
      for (let ty = ty0; ty <= ty1 && ok; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (map.cliffMask[tileIndex(clamp(tx, 0, MAP_W - 1), clamp(ty, 0, MAP_H - 1))]) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      candidates.push({ x: bx, y: by, w, h, text, comp: c, score: clutter + rng() * 8, cx, cy });
    }
  }
  candidates.sort((a, b) => a.score - b.score);

  const chosen: Candidate[] = [];
  const perComp = new Map<number, number>();
  for (const cand of candidates) {
    if (chosen.length >= spec.max) break;
    const n = perComp.get(cand.comp) ?? 0;
    if (n >= spec.perLine) continue;
    let fits = true;
    for (const o of chosen) {
      const d = Math.hypot(o.cx - cand.cx, o.cy - cand.cy);
      if (d < 150 || (o.comp === cand.comp && d < 320)) {
        fits = false;
        break;
      }
    }
    if (!fits) continue;
    chosen.push(cand);
    perComp.set(cand.comp, n + 1);
  }
  return chosen.map(({ x, y, w, h, text }) => ({ x, y, w, h, text }));
}

/** Nearby peaks closer than this (tiles) and within SPOT_MERGE_ELEV of a kept one share its label. */
const SPOT_MERGE_TILES = 10;
const SPOT_MERGE_ELEV = 2 * CONTOUR_INTERVAL;

/**
 * Peaks that get a printed spot height. The summit always does. Other peaks are skipped on
 * the outermost tile ring (they are only maxima because the sheet ends there) and when a
 * higher kept peak within SPOT_MERGE_TILES is less than two contour intervals above them
 * (duplicate heights on one plateau or crest).
 */
function selectSpotPeaks(map: MapData): Peak[] {
  const isSummit = (p: Peak): boolean => p.x === map.summit.x && p.y === map.summit.y;
  const ranked = [...map.peaks].sort((a, b) => Number(isSummit(b)) - Number(isSummit(a)) || b.elevation - a.elevation);
  const kept: Peak[] = [];
  for (const peak of ranked) {
    if (!isSummit(peak)) {
      if (peak.x === 0 || peak.y === 0 || peak.x === MAP_W - 1 || peak.y === MAP_H - 1) continue;
      const merged = kept.some(
        (k) =>
          Math.hypot(k.x - peak.x, k.y - peak.y) <= SPOT_MERGE_TILES &&
          Math.abs(k.elevation - peak.elevation) < SPOT_MERGE_ELEV,
      );
      if (merged) continue;
    }
    kept.push(peak);
  }
  return kept;
}

function buildSpotHeights(map: MapData, spotPeaks: readonly Peak[]): SpotHeight[] {
  const spots: SpotHeight[] = [];
  for (const peak of spotPeaks) {
    const summit = peak.x === map.summit.x && peak.y === map.summit.y;
    const text = String(toMeters(peak.elevation));
    const tw = measureText(text);
    const surf = makeSurface(tw + 2, 9);
    drawOutlinedText(surf.ctx, text, 1, 1, PALETTE.ink, PALETTE.parchment);
    const cx = peak.x * TILE + TILE / 2;
    const cy = peak.y * TILE + TILE / 2;
    // The summit label clears the trig-station triangle around the pillar.
    let lx = summit ? cx + 10 : cx + 4;
    const ly = summit ? cy - 11 : cy - 5;
    if (lx + tw + 2 > W - 2) lx = (summit ? cx - 10 : cx - 4) - (tw + 2);
    spots.push({
      tile: tileIndex(peak.x, peak.y),
      cx,
      cy,
      summit,
      label: { canvas: surf.canvas, w: tw + 2, h: 9 },
      lx,
      ly: Math.max(0, ly),
    });
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Map layer: pixels
// ---------------------------------------------------------------------------

interface SheetLayers {
  /** Surveyed map pixels (current line of sight). */
  base: Uint32Array;
  /** The same map with ink faded, for older survey outside the current sight. */
  faded: Uint32Array;
  /** Fog texture over unsurveyed ground. */
  fog: Uint32Array;
  spots: SpotHeight[];
  /** Fog lettering (TERRA INCOGNITA, the wind-rose N), drawn over the composite per whole glyph. */
  fogGlyphs: FogGlyph[];
  sampleStep: number;
  timings: Record<string, number>;
}

function buildMapPixels(
  map: MapData,
  spotPeaks: readonly Peak[],
  elev: Float32Array,
  stain: Float32Array,
  scratch: Surface,
  timings: Record<string, number>,
): Uint32Array {
  let t = performance.now();
  const lap = (name: string): void => {
    const now = performance.now();
    timings[name] = Math.round((now - t) * 10) / 10;
    t = now;
  };

  const water = fitShoreline(map, elev);
  lap('shore');
  const lvl = new Int16Array(NPIX);
  // Levels below the shoreline collapse into one, so no contour is drawn under sea level
  // where the tile-true coast reaches past the field's own shoreline.
  const minLevel = Math.floor(WATER_LEVEL / CONTOUR_INTERVAL);
  for (let p = 0; p < NPIX; p++) lvl[p] = Math.max(minLevel, Math.floor(elev[p] / CONTOUR_INTERVAL));
  const dist = chamferFromLand(water);
  const mark = markContours(lvl, water, elev);
  lap('contours');

  const spotsReserved: LabelBox[] = spotPeaks.map((pk) => ({
    x: pk.x * TILE - 8,
    y: pk.y * TILE - 8,
    w: 50,
    h: 26,
    text: '',
  }));
  // Sight lines are labelled first: their few labels are what tell the player what the amber line is.
  const sightLabels = placeLineLabels(map, spotPeaks, elev, water, mark, spotsReserved, sightLabelSpec(elev));
  const labels = placeLineLabels(map, spotPeaks, elev, water, mark, [...spotsReserved, ...sightLabels], indexLabelSpec(lvl));
  const knock = new Uint8Array(NPIX);
  for (const lb of [...labels, ...sightLabels]) {
    for (let y = lb.y; y < lb.y + lb.h; y++) knock.fill(1, y * W + lb.x, y * W + lb.x + lb.w);
  }
  lap('labels');
  const ticks = buildCliffTicks(map, water);
  lap('cliffs');

  const img = scratch.ctx.createImageData(W, H);
  const out = new Uint32Array(img.data.buffer);
  const ramp = packAll(LAND_RAMP_HEX);
  const RAMP_MAX = ramp.length - 1;
  const cWater = packHex(PALETTE.water);
  const cWaterDeep = packHex(WATER_DEEP_HEX);
  const cWaterInk = packHex(PALETTE.waterInk);
  const cHatch = packHex(WATER_HATCH_HEX);
  const cInk = packHex(PALETTE.ink);
  const cMinor = packHex(MINOR_CONTOUR_HEX);
  const cIndex = packHex(INDEX_CONTOUR_HEX);
  const cSight = packHex(PALETTE.sightInk);
  const cSpeck = packHex(PALETTE.inkPale);
  const seed = map.seed | 0;
  const waveSeed = (seed % 997) * 0.37;
  const BAND_SPAN = 5.2;
  const TRANSITION = 0.3;
  const SHADE_K = 7.5;

  // Coast ripple thresholds (chamfer units: 3 = 1 px).
  const RIPPLE = [9, 19, 31];
  const HATCH_FROM = 40;

  for (let py = 0, p = 0; py < H; py++) {
    for (let px = 0; px < W; px++, p++) {
      if (water[p]) {
        const d = dist[p];
        const l = px > 0 ? dist[p - 1] : d;
        const r = px < W - 1 ? dist[p + 1] : d;
        const u = py > 0 ? dist[p - W] : d;
        const dn = py < H - 1 ? dist[p + W] : d;
        const nmin = Math.min(l, r, u, dn);
        let col = cWater;
        if (nmin === 0) {
          col = cInk; // crisp shoreline
        } else if (d >= RIPPLE[0] && nmin < RIPPLE[0]) {
          col = cWaterInk;
        } else if (d >= RIPPLE[1] && nmin < RIPPLE[1]) {
          if (hash2(px >> 2, py >> 2, seed ^ 0x3c1) > 0.2) col = cWaterInk;
        } else if (d >= RIPPLE[2] && nmin < RIPPLE[2]) {
          if (hash2(px >> 3, py >> 3, seed ^ 0x3c2) > 0.35) col = cHatch;
        } else if (d >= HATCH_FROM) {
          // Wavy, broken horizontal hatching; sparser in open water.
          const k = Math.floor((py + 1) / 4);
          const off = Math.round(Math.sin(px * 0.075 + k * 1.9 + waveSeed) * 0.9);
          if (4 * k + off === py && (d < 150 || (k & 1) === 0)) {
            const s = px + k * 13;
            const seg = Math.floor(s / 23);
            if (s % 23 < 17 && hash2(seg, k, seed ^ 0x5a7) > 0.2) col = cHatch;
          }
          if (col === cWater && d > 150 && bayerT(px, py) < 0.22) col = cWaterDeep;
        }
        out[p] = col;
        continue;
      }

      // Hypsometric band with narrow dithered transitions.
      const e = elev[p];
      const b = 1 + ((e - WATER_LEVEL) / (1 - WATER_LEVEL)) * BAND_SPAN;
      const fl = Math.floor(b);
      const f = b - fl;
      let c = fl + (f > 1 - TRANSITION ? (f - (1 - TRANSITION)) / TRANSITION : 0);
      // NW-lit hillshade (lighter where the ground rises toward the south-east).
      const pl = px >= 2 ? p - 2 : p;
      const pr = px < W - 2 ? p + 2 : p;
      const pu = py >= 2 ? p - 2 * W : p;
      const pd = py < H - 2 ? p + 2 * W : p;
      const gx = (elev[pr] - elev[pl]) * 3;
      const gy = (elev[pd] - elev[pu]) * 3;
      let s = (gx + gy) * SHADE_K;
      s = s > 0.12 ? s - 0.12 : s < -0.12 ? s + 0.12 : 0;
      c -= clamp(s, -1.6, 1.6);
      c += stain[p] * 1.1;
      let idx = Math.floor(c + bayerT(px, py));
      const h = hash2(px, py, seed);
      if (h < 0.011) idx++;
      idx = idx < 0 ? 0 : idx > RAMP_MAX ? RAMP_MAX : idx;
      let col = ramp[idx];
      if (h > 0.9982) col = cSpeck;
      // Label boxes keep the plain tint; cliff ticks knock the contours out beside them.
      const m = mark[p];
      const tk = ticks[p];
      if (!knock[p]) {
        if (tk === TICK_PIXEL) col = cInk;
        else if (m !== 0 && tk !== TICK_HALO) col = m === MARK_SIGHT ? cSight : m === MARK_INDEX ? cIndex : cMinor;
      }
      out[p] = col;
    }
  }
  lap('pixels');

  drawGridCrosses(out, water, packHex(PALETTE.inkFaded), knock);

  scratch.ctx.putImageData(img, 0, 0);
  for (const lb of labels) drawText(scratch.ctx, lb.text, lb.x + 2, lb.y + 1, { color: PALETTE.ink });
  scratch.ctx.fillStyle = PALETTE.sightInk;
  for (const lb of sightLabels) {
    SIGHT_EYE_ART.forEach((row, ry) => {
      for (let rx = 0; rx < SIGHT_EYE_W; rx++) if (row[rx] === 'o') scratch.ctx.fillRect(lb.x + 2 + rx, lb.y + 2 + ry, 1, 1);
    });
    drawText(scratch.ctx, lb.text, lb.x + SIGHT_EYE_W + 4, lb.y + 1, { color: PALETTE.sightInk });
  }
  const final = new Uint32Array(scratch.ctx.getImageData(0, 0, W, H).data.buffer);
  lap('finish');
  return final;
}

/** Cliff-symbol raster: 1 = hachure tick pixel, 2 = parchment knockout beside a tick. */
const TICK_PIXEL = 1;
const TICK_HALO = 2;

/** Per cliff edge (or merged stair corner) this many ticks, each this long (px). */
const TICKS_MIN = 2;
const TICKS_MAX = 3;
const TICK_LEN_MIN = 4;
const TICK_LEN_MAX = 5;
/** Tick roots sit where the face has dropped to this share of its height (0.5 = mid-face). */
const TICK_ROOT_LEVEL = 0.3;

/**
 * Cartographic cliff symbol: short tapered hachure ticks hanging from the face, with no rim
 * line (the bunched contours already mark the edge).
 *
 * For every cliff edge a few ticks sit at hashed offsets along the edge. Each tick is rooted
 * where the continuous field, on the line between the two tile centres, has dropped to the
 * foot of the face (TICK_ROOT_LEVEL of its height; found by bisection with
 * map.sampleElevation), and points down the true fall line there, so the symbol follows the
 * curving face rather than the tile grid and hangs just below the contour bundle.
 * Where two cliff edges meet at a tile corner with the same high side (a stair step of the
 * grid), their ticks are merged onto the diagonal between the two edge midpoints.
 * Returns the tick raster; beside each tick's tail the contour lines are knocked out so the
 * ticks read as a symbol of their own instead of rails on a line.
 */
function buildCliffTicks(map: MapData, water: Uint8Array): Uint8Array {
  const out = new Uint8Array(NPIX);
  const seed = map.seed | 0;
  const E = map.elevation;
  const f = (x: number, y: number): number => map.sampleElevation(x, y);

  /** Point (tile units) on the segment through p along n (half-length 0.5) at elevation `target`. */
  const faceCrossing = (px: number, py: number, nx: number, ny: number, target: number): [number, number] => {
    let a = -0.5;
    let b = 0.5;
    const fa = f(px + nx * a, py + ny * a) - target;
    const fb = f(px + nx * b, py + ny * b) - target;
    if (fa > 0 && fb < 0) {
      for (let k = 0; k < 7; k++) {
        const m = (a + b) / 2;
        if (f(px + nx * m, py + ny * m) - target > 0) a = m;
        else b = m;
      }
      const t = (a + b) / 2;
      return [px + nx * t, py + ny * t];
    }
    // The field is not monotonic here: take the sample closest to the target.
    let best = 0;
    let bestErr = Infinity;
    for (let k = 0; k <= 8; k++) {
      const t = -0.5 + k / 8;
      const err = Math.abs(f(px + nx * t, py + ny * t) - target);
      if (err < bestErr) {
        bestErr = err;
        best = t;
      }
    }
    return [px + nx * best, py + ny * best];
  };

  const plot = (x: number, y: number, value: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = y * W + x;
    if (water[p]) return;
    if (value === TICK_PIXEL) out[p] = TICK_PIXEL;
    else if (out[p] === 0) out[p] = TICK_HALO;
  };

  /** One tapered tick hanging from the face crossing, down the local fall line. */
  const tick = (px: number, py: number, nx: number, ny: number, target: number, h: number): void => {
    const [rx, ry] = faceCrossing(px, py, nx, ny, target);
    const g = 0.06;
    const gx = f(rx + g, ry) - f(rx - g, ry);
    const gy = f(rx, ry + g) - f(rx, ry - g);
    const gl = Math.hypot(gx, gy);
    let dx = nx;
    let dy = ny;
    if (gl > 1e-6 && (-gx * nx - gy * ny) / gl > 0.3) {
      dx = -gx / gl;
      dy = -gy / gl;
    }
    const len = TICK_LEN_MIN + Math.floor(h * (TICK_LEN_MAX - TICK_LEN_MIN + 1));
    // The 2 px root sits at the foot of the contour bundle; the tail hangs out on the low side.
    const sx = rx * TILE - 0.5;
    const sy = ry * TILE - 0.5;
    const ex = sx + dx * (len - 1);
    const ey = sy + dy * (len - 1);
    // Width 2 px at the root: the second column/row goes to the side of the minor axis.
    const wideX = Math.abs(dy) > Math.abs(dx) ? 1 : 0;
    const wideY = 1 - wideX;
    const pixels: [number, number][] = [];
    const tail: [number, number][] = [];
    plotLine(sx, sy, ex, ey, (x, y, i) => {
      pixels.push([x, y]);
      if (i < 2) pixels.push([x + wideX, y + wideY]);
      if (i >= 1) tail.push([x, y]);
    });
    // Parchment knockout beside the tail keeps it apart from the contours below the face.
    for (const [x, y] of tail) {
      plot(x - 1, y, TICK_HALO);
      plot(x + 1, y, TICK_HALO);
      plot(x, y - 1, TICK_HALO);
      plot(x, y + 1, TICK_HALO);
    }
    for (const [x, y] of pixels) plot(x, y, TICK_PIXEL);
  };

  /** Ticks spread along the segment a -> b (tile units), crossing the face along n. */
  const tickRun = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    nx: number,
    ny: number,
    target: number,
    key: number,
  ): void => {
    const n = TICKS_MIN + Math.floor(hash2(key, 1, seed ^ 0xc11f) * (TICKS_MAX - TICKS_MIN + 1));
    for (let k = 0; k < n; k++) {
      const jitter = (hash2(key, k + 2, seed ^ 0xc120) - 0.5) * 0.5;
      const t = clamp01((k + 0.5 + jitter) / n);
      tick(ax + (bx - ax) * t, ay + (by - ay) * t, nx, ny, target, hash2(key, k + 9, seed ^ 0xc121));
    }
  };

  // Edge ids: 2 * tile + 0 for the right edge, 2 * tile + 1 for the down edge.
  const isCliff = (tx: number, ty: number, down: boolean): boolean => {
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
    const bit = down ? DIRS.down.bit : DIRS.right.bit;
    return (map.cliffMask[tileIndex(tx, ty)] & bit) !== 0 && (down ? ty + 1 < MAP_H : tx + 1 < MAP_W);
  };
  const used = new Uint8Array(NTILES * 2);
  const edgeId = (tx: number, ty: number, down: boolean): number => tileIndex(tx, ty) * 2 + (down ? 1 : 0);

  // Stair corners first. Per tile corner (cx, cy: 0/1 from the tile's top-left): the tile
  // whose down edge is this tile's top/bottom side (h) and whose right edge is its left/right
  // side (v), as offsets from the tile.
  const CORNERS: readonly { cx: number; cy: number; h: readonly [number, number]; v: readonly [number, number] }[] = [
    { cx: 1, cy: 1, h: [0, 0], v: [0, 0] },
    { cx: 0, cy: 1, h: [0, 0], v: [-1, 0] },
    { cx: 1, cy: 0, h: [0, -1], v: [0, 0] },
    { cx: 0, cy: 0, h: [0, -1], v: [-1, 0] },
  ];
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const i = tileIndex(tx, ty);
      for (const c of CORNERS) {
        const hx = tx + c.h[0];
        const hy = ty + c.h[1];
        const vx = tx + c.v[0];
        const vy = ty + c.v[1];
        if (!isCliff(hx, hy, true) || !isCliff(vx, vy, false)) continue;
        const hid = edgeId(hx, hy, true);
        const vid = edgeId(vx, vy, false);
        if (used[hid] || used[vid]) continue;
        const nbV = tileIndex(tx, ty + (c.cy === 1 ? 1 : -1));
        const nbH = tileIndex(tx + (c.cx === 1 ? 1 : -1), ty);
        const high = E[i] > E[nbV] && E[i] > E[nbH];
        const low = E[i] < E[nbV] && E[i] < E[nbH];
        if (!high && !low) continue;
        used[hid] = 1;
        used[vid] = 1;
        // Diagonal from the side-edge midpoint to the top/bottom-edge midpoint.
        const ax = tx + c.cx;
        const ay = ty + 0.5;
        const bx = tx + 0.5;
        const by = ty + c.cy;
        let nx = (c.cx - 0.5) * Math.SQRT2;
        let ny = (c.cy - 0.5) * Math.SQRT2;
        if (low) {
          nx = -nx;
          ny = -ny;
        }
        const other = (E[nbV] + E[nbH]) / 2;
        const target = Math.min(E[i], other) + Math.abs(E[i] - other) * TICK_ROOT_LEVEL;
        tickRun(ax, ay, bx, by, nx, ny, target, hid);
      }
    }
  }
  // Remaining straight edges.
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const i = tileIndex(tx, ty);
      for (const down of [false, true]) {
        if (!isCliff(tx, ty, down)) continue;
        const id = edgeId(tx, ty, down);
        if (used[id]) continue;
        const j = down ? i + MAP_W : i + 1;
        const sign = E[i] > E[j] ? 1 : -1;
        const target = Math.min(E[i], E[j]) + Math.abs(E[i] - E[j]) * TICK_ROOT_LEVEL;
        if (down) tickRun(tx, ty + 1, tx + 1, ty + 1, 0, sign, target, id);
        else tickRun(tx + 1, ty, tx + 1, ty + 1, sign, 0, target, id);
      }
    }
  }
  return out;
}

/** Small "+" survey crosses every 10 tiles (they line up with the sheet's grid letters). */
function drawGridCrosses(out: Uint32Array, water: Uint8Array, color: number, knock: Uint8Array): void {
  for (let gy = 10; gy < MAP_H; gy += 10) {
    for (let gx = 10; gx < MAP_W; gx += 10) {
      const cx = gx * TILE;
      const cy = gy * TILE;
      for (let k = -3; k <= 3; k++) {
        for (const [x, y] of [
          [cx + k, cy],
          [cx, cy + k],
        ]) {
          const p = y * W + x;
          if (!water[p] && !knock[p]) out[p] = color;
        }
      }
    }
  }
}

/** Blend every pixel toward the faded-ink target (cached per distinct colour). */
function buildFaded(base: Uint32Array): Uint32Array {
  const faded = new Uint32Array(NPIX);
  const target = unpackRgb(packHex(FADE_TARGET_HEX));
  const cache = new Map<number, number>();
  for (let p = 0; p < NPIX; p++) {
    const c = base[p];
    let f = cache.get(c);
    if (f === undefined) {
      const { r, g, b } = unpackRgb(c);
      f = packRgb(
        Math.round(r + (target.r - r) * FADE_AMOUNT),
        Math.round(g + (target.g - g) * FADE_AMOUNT),
        Math.round(b + (target.b - b) * FADE_AMOUNT),
      );
      cache.set(c, f);
    }
    faded[p] = f;
  }
  return faded;
}

// ---------------------------------------------------------------------------
// Fog texture
// ---------------------------------------------------------------------------

function fillTriangleBuf(
  buf: Uint32Array,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  color: number,
): void {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * area;
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * area;
      const w2 = ((ax - px) * (by - py) - (ay - py) * (bx - px)) * area;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) buf[y * W + x] = color;
    }
  }
}

function lineBuf(buf: Uint32Array, x0: number, y0: number, x1: number, y1: number, color: number, dotted = 0): void {
  plotLine(x0, y0, x1, y1, (x, y, i) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (dotted > 0 && i % dotted !== 0) return;
    buf[y * W + x] = color;
  });
}

function ringBuf(buf: Uint32Array, cx: number, cy: number, r: number, color: number, dotted = 0): void {
  const steps = Math.max(8, Math.round(Math.PI * 2 * r));
  for (let i = 0; i < steps; i++) {
    if (dotted > 0 && i % dotted !== 0) continue;
    const a = (i / steps) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(a) * r);
    const y = Math.round(cy + Math.sin(a) * r);
    if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = color;
  }
}

/** Faint portolan-style wind rose with rhumb lines, drawn into the fog texture. */
function drawWindRose(buf: Uint32Array, cx: number, cy: number, R: number): void {
  const dark = packHex('#d0c29e');
  const light = packHex('#f1e9d5');
  const edge = packHex('#c3b28c');
  const rhumb = packHex('#dbcfae');
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    lineBuf(buf, cx + Math.cos(a) * R * 1.1, cy + Math.sin(a) * R * 1.1, cx + Math.cos(a) * 1400, cy + Math.sin(a) * 1400, rhumb, 3);
  }
  ringBuf(buf, cx, cy, R * 0.66, edge);
  ringBuf(buf, cx, cy, R * 0.66 + 3, edge);
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const r0 = R * 0.66;
    const r1 = r0 + (k % 4 === 0 ? 6 : 3);
    lineBuf(buf, cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, edge);
  }
  const point = (angle: number, len: number, half: number): void => {
    const tx = cx + Math.sin(angle) * len;
    const ty = cy - Math.cos(angle) * len;
    const lx = cx + Math.sin(angle - Math.PI / 2) * half;
    const ly = cy - Math.cos(angle - Math.PI / 2) * half;
    const rx = cx + Math.sin(angle + Math.PI / 2) * half;
    const ry = cy - Math.cos(angle + Math.PI / 2) * half;
    fillTriangleBuf(buf, cx, cy, tx, ty, lx, ly, dark);
    fillTriangleBuf(buf, cx, cy, tx, ty, rx, ry, light);
    lineBuf(buf, lx, ly, tx, ty, edge);
    lineBuf(buf, rx, ry, tx, ty, edge);
    lineBuf(buf, cx, cy, tx, ty, edge);
  };
  for (let k = 0; k < 4; k++) point(Math.PI / 4 + (k * Math.PI) / 2, R * 0.62, R * 0.12);
  for (let k = 0; k < 4; k++) point((k * Math.PI) / 2, R, R * 0.17);
}

/** Where the fog flourishes go: away from the spawn so they are seen for a while. */
function fogLayout(map: MapData): { roseX: number; roseY: number; textX: number; textY: number } {
  const sx = map.spawn.x * TILE;
  const sy = map.spawn.y * TILE;
  return {
    roseX: sx < W / 2 ? W - 120 : 120,
    roseY: sy < H / 2 ? H - 120 : 120,
    textX: W / 2 + (sx < W / 2 ? 70 : -70),
    textY: sy < H / 2 ? Math.round(H * 0.62) : Math.round(H * 0.3),
  };
}

/**
 * The fog lettering is not baked into the fog texture (a reveal would slice letters in half):
 * each glyph is drawn whole over the composite and fades out once ground under it is surveyed.
 */
function buildFogGlyphs(map: MapData): FogGlyph[] {
  const { roseX, roseY, textX, textY } = fogLayout(map);
  return [
    ...spacedFogGlyphs('TERRA INCOGNITA', textX, textY, 4, 6, '#d6c9a6'),
    ...spacedFogGlyphs(t('unsurveyed'), textX, textY + 40, 1, 3, '#cfc19c'),
    makeFogGlyph('N', Math.round(roseX - measureText('N') / 2), roseY - 64 - 12, 1, '#c3b28c'),
  ];
}

function buildFogPixels(map: MapData, stain: Float32Array, scratch: Surface): Uint32Array {
  const img = scratch.ctx.createImageData(W, H);
  const out = new Uint32Array(img.data.buffer);
  const seed = map.seed | 0;
  const cloud = makeValueNoise(hashSeed(seed, 0xf06));
  const ramp = packAll(FOG_RAMP_HEX);
  const cHatch = packHex('#dccfad');
  const cSpeck = packHex(PALETTE.fogSpeck);
  const cDark = packHex(PALETTE.inkPale);
  for (let py = 0, p = 0; py < H; py++) {
    for (let px = 0; px < W; px++, p++) {
      const n = cloud(px / 120, py / 120) * 0.62 + cloud(px / 37 + 17.3, py / 37 + 9.1) * 0.38;
      const c = 1.3 + (n - 0.5) * 2.4 + stain[p] * 1.2;
      let idx = Math.floor(c + bayerT(px, py) - 0.5);
      idx = idx < 0 ? 0 : idx > 3 ? 3 : idx;
      let col = ramp[idx];
      if ((px + py) % 9 === 0) {
        const t = px - py + 4096;
        if (t % 26 < 18 && hash2(Math.floor(t / 26), (px + py) / 9, seed ^ 0x6d) > 0.3) col = cHatch;
      }
      const h = hash2(px, py, seed ^ 0x55aa);
      if (h < 0.012) col = cSpeck;
      else if (h > 0.9986) col = cDark;
      out[p] = col;
    }
  }

  const { roseX, roseY } = fogLayout(map);
  drawWindRose(out, roseX, roseY, 64);
  return out;
}

interface FogEdgeField {
  /** Per-pixel dither threshold (1..254): Bayer order blended with fine noise. */
  threshold: Uint8Array;
  /** Per-pixel billow displacement of the reveal field, -127..127 (applied inside the edge band only). */
  billow: Int8Array;
}

function buildFogEdgeField(): FogEdgeField {
  const threshold = new Uint8Array(NPIX);
  const billow = new Int8Array(NPIX);
  const noise = makeValueNoise(0xc10d);
  const low = makeValueNoise(0xb111);
  for (let py = 0, p = 0; py < H; py++) {
    for (let px = 0; px < W; px++, p++) {
      const n = noise(px / 6.5, py / 6.5) * 0.65 + noise(px / 2.7 + 40, py / 2.7) * 0.35;
      const t = 0.08 + 0.84 * (0.55 * bayerT(px, py) + 0.45 * n);
      threshold[p] = clamp(Math.round(t * 255), 1, 254);
      const b = low(px / 11, py / 11) * 0.7 + low(px / 4.5 + 9, py / 4.5 + 3) * 0.3;
      billow[p] = clamp(Math.round((b - 0.5) * 2 * 127), -127, 127);
    }
  }
  return { threshold, billow };
}

function buildSheetLayers(map: MapData, scratch: Surface): SheetLayers {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const { elev, step } = sampleElevationField(map);
  timings.elevation = Math.round((performance.now() - t) * 10) / 10;
  t = performance.now();
  const stain = buildStains(map.seed);
  timings.stains = Math.round((performance.now() - t) * 10) / 10;
  const spotPeaks = selectSpotPeaks(map);
  const base = buildMapPixels(map, spotPeaks, elev, stain, scratch, timings);
  t = performance.now();
  const faded = buildFaded(base);
  timings.faded = Math.round((performance.now() - t) * 10) / 10;
  t = performance.now();
  const fog = buildFogPixels(map, stain, scratch);
  const fogGlyphs = buildFogGlyphs(map);
  timings.fog = Math.round((performance.now() - t) * 10) / 10;
  t = performance.now();
  const spots = buildSpotHeights(map, spotPeaks);
  timings.spots = Math.round((performance.now() - t) * 10) / 10;
  return { base, faded, fog, spots, fogGlyphs, sampleStep: step, timings };
}

/**
 * Ground never surveyed, as the expedition report shows it: the faded sheet seen through the fog,
 * a 50/50 mix of the faded map and the fog texture (every byte lane averaged, alpha kept opaque).
 */
function buildHindsight(faded: Uint32Array, fog: Uint32Array): Uint32Array {
  const out = new Uint32Array(NPIX);
  for (let p = 0; p < NPIX; p++) {
    out[p] = ((((faded[p] >>> 1) & 0x7f7f7f7f) + ((fog[p] >>> 1) & 0x7f7f7f7f)) | 0xff000000) >>> 0;
  }
  return out;
}

/** Every tile on: the report shows the whole sheet. */
const ALL_TILES = new Uint8Array(NTILES).fill(1);

/** True on the end cards, where the sheet becomes the expedition report. */
function isReport(state: GameState): boolean {
  return state.phase === 'gameover' || state.phase === 'victory';
}

/** The collapse ink and the dimmed sheet clear away over this long once the report is up. */
const REPORT_CLEAR_MS = 700;

// ---------------------------------------------------------------------------
// Fog compositor: survey reveal with dithered, animated edges
// ---------------------------------------------------------------------------

/** For each pixel offset inside a tile: tile delta of the left/top bilinear sample and its weight. */
const OFF_D = new Int8Array(TILE);
const OFF_F = new Float32Array(TILE);
for (let o = 0; o < TILE; o++) {
  const u = (o + 0.5) / TILE - 0.5;
  const d = Math.floor(u);
  OFF_D[o] = d;
  OFF_F[o] = u - d;
}

class SurveyCompositor {
  readonly surface: Surface;
  private readonly img: ImageData;
  private readonly buf: Uint32Array;
  private readonly revCopy = new Uint8Array(NTILES);
  private readonly visCopy = new Uint8Array(NTILES);
  /** Animated reveal amount per tile (0..1). */
  private readonly revAmt = new Float32Array(NTILES);
  private readonly visAmt = new Float32Array(NTILES);
  private readonly revStart = new Float64Array(NTILES);
  private animating: number[] = [];
  private readonly dirty = new Uint8Array(NTILES);
  private dirtyList: number[] = [];
  private layers: SheetLayers | null = null;
  /** Replaces the faded layer while set: the report's look for ground never surveyed. */
  private unseen: Uint32Array | null = null;
  private readonly rimColor = packHex(FOG_RIM_HEX);

  constructor(private readonly edge: FogEdgeField) {
    this.surface = makeSurface(W, H);
    this.img = this.surface.ctx.createImageData(W, H);
    this.buf = new Uint32Array(this.img.data.buffer);
  }

  /** Full rebuild for a new map: current survey state appears instantly. */
  reset(layers: SheetLayers, state: GameState): void {
    this.layers = layers;
    this.unseen = null;
    this.revCopy.set(state.revealed);
    this.visCopy.set(state.visible);
    for (let i = 0; i < NTILES; i++) {
      this.revAmt[i] = state.revealed[i] ? 1 : 0;
      this.visAmt[i] = state.visible[i] ? 1 : 0;
    }
    this.revStart.fill(-Infinity);
    this.animating = [];
    this.dirty.fill(0);
    this.dirtyList = [];
    for (let ty = 0; ty < MAP_H; ty++) for (let tx = 0; tx < MAP_W; tx++) this.compositeTile(tx, ty);
    this.surface.ctx.putImageData(this.img, 0, 0);
  }

  /**
   * Swap the layer drawn where a tile is surveyed but not in sight (null = the ordinary faded
   * ink). Every tile is recomposited on a change.
   */
  setUnseen(layer: Uint32Array | null): void {
    if (layer === this.unseen) return;
    this.unseen = layer;
    for (let i = 0; i < NTILES; i++) this.markDirty(i);
  }

  /**
   * Diff the shown survey (`rev`, drawn at all) and sight (`vis`, drawn crisp) against the last
   * frame and recomposite what changed. During play they are state.revealed / state.visible; the
   * report passes the whole sheet and the survey, so surveyed ground is crisp and the rest unseen.
   */
  update(state: GameState, now: number, rev: Uint8Array = state.revealed, vis: Uint8Array = state.visible): void {
    const fresh: number[] = [];
    for (let i = 0; i < NTILES; i++) {
      const r = rev[i] ? 1 : 0;
      if (r !== this.revCopy[i]) {
        this.revCopy[i] = r;
        if (r) {
          this.revStart[i] = now;
          this.animating.push(i);
          fresh.push(i);
        } else {
          this.revAmt[i] = 0;
          this.markDirty(i);
        }
      }
      const v = vis[i] ? 1 : 0;
      if (v !== this.visCopy[i]) {
        this.visCopy[i] = v;
        this.visAmt[i] = v;
        this.markDirty(i);
      }
    }
    // Ordinary steps fade in at once; a panoramic one ripples out with the survey ring.
    if (fresh.length >= PANORAMA_TILE_THRESHOLD) this.ripple(state, fresh, now);
    if (this.animating.length > 0) {
      const still: number[] = [];
      for (const i of this.animating) {
        if (!this.revCopy[i]) continue;
        const k = clamp01((now - this.revStart[i]) / REVEAL_FADE_MS);
        if (k < 1) still.push(i);
        // A tile still waiting for the ring stays fogged: nothing to recomposite yet.
        if (now <= this.revStart[i]) continue;
        this.revAmt[i] = 1 - (1 - k) * (1 - k);
        this.markDirty(i);
      }
      this.animating = still;
    }
    if (this.dirtyList.length === 0) return;

    let bx0 = MAP_W;
    let by0 = MAP_H;
    let bx1 = -1;
    let by1 = -1;
    for (const i of this.dirtyList) {
      this.dirty[i] = 0;
      const tx = i % MAP_W;
      const ty = (i - tx) / MAP_W;
      this.compositeTile(tx, ty);
      if (tx < bx0) bx0 = tx;
      if (tx > bx1) bx1 = tx;
      if (ty < by0) by0 = ty;
      if (ty > by1) by1 = ty;
    }
    this.dirtyList = [];
    this.surface.ctx.putImageData(
      this.img,
      0,
      0,
      bx0 * TILE,
      by0 * TILE,
      (bx1 - bx0 + 1) * TILE,
      (by1 - by0 + 1) * TILE,
    );
  }

  /**
   * Whether tile i shows as surveyed at `now`: revealed and its fade begun. Objects and labels
   * on it wait for this, so they appear with their ground during a panoramic ripple.
   */
  isShown(i: number, now: number): boolean {
    return this.revCopy[i] === 1 && now >= this.revStart[i];
  }

  /** When tile i's reveal fade begins (-Infinity for ground surveyed when the sheet was built). */
  revealTime(i: number): number {
    return this.revStart[i];
  }

  /**
   * Delay each freshly revealed tile until the survey ring (easeOutCubic over the burst's
   * duration) has passed its centre. Without a burst on the sheet an unseen ring of the same
   * speed is assumed to start now at the player.
   */
  private ripple(state: GameState, fresh: readonly number[], now: number): void {
    const burst = state.effects.find((e) => e.kind === 'survey-burst' && now - e.start < e.duration);
    const t0 = burst ? burst.start : now;
    const ox = burst ? burst.x : state.player.x;
    const oy = burst ? burst.y : state.player.y;
    const reach = (burst?.radius ?? state.visionRadius) + 0.5;
    const span = burst ? burst.duration : (RIPPLE_MS * Math.min(reach, VISION_HIGH + 0.5)) / (VISION_HIGH + 0.5);
    for (const i of fresh) {
      const tx = i % MAP_W;
      const f = Math.hypot(tx - ox, (i - tx) / MAP_W - oy) / reach;
      // Ground beyond the ring's reach is not part of this view and is not held back.
      if (f < 1) this.revStart[i] = t0 + span * (1 - Math.cbrt(1 - f));
    }
  }

  /** A tile's change affects the bilinear reveal field of its 3x3 neighbourhood. */
  private markDirty(i: number): void {
    const tx = i % MAP_W;
    const ty = (i - tx) / MAP_W;
    for (let y = Math.max(0, ty - 1); y <= Math.min(MAP_H - 1, ty + 1); y++) {
      for (let x = Math.max(0, tx - 1); x <= Math.min(MAP_W - 1, tx + 1); x++) {
        const j = y * MAP_W + x;
        if (!this.dirty[j]) {
          this.dirty[j] = 1;
          this.dirtyList.push(j);
        }
      }
    }
  }

  private compositeTile(tx: number, ty: number): void {
    const layers = this.layers;
    if (!layers) return;
    const { base, fog } = layers;
    const faded = this.unseen ?? layers.faded;
    const thr = this.edge.threshold;
    const billow = this.edge.billow;
    const R = this.revAmt;
    const V = this.visAmt;
    const out = this.buf;
    const rim = this.rimColor;
    for (let oy = 0; oy < TILE; oy++) {
      const py = ty * TILE + oy;
      const ja = clamp(ty + OFF_D[oy], 0, MAP_H - 1) * MAP_W;
      const jb = clamp(ty + OFF_D[oy] + 1, 0, MAP_H - 1) * MAP_W;
      const fv = OFF_F[oy];
      for (let ox = 0; ox < TILE; ox++) {
        const px = tx * TILE + ox;
        const p = py * W + px;
        const ia = clamp(tx + OFF_D[ox], 0, MAP_W - 1);
        const ib = clamp(tx + OFF_D[ox] + 1, 0, MAP_W - 1);
        const fu = OFF_F[ox];
        const top = R[ja + ia] + (R[ja + ib] - R[ja + ia]) * fu;
        const bot = R[jb + ia] + (R[jb + ib] - R[jb + ia]) * fu;
        const r0 = top + (bot - top) * fv;
        // Billowing, cloud-like edge: displace the field only where it is in transition.
        const r = r0 + billow[p] * BILLOW_AMP * r0 * (1 - r0);
        const rv = ((r - REVEAL_LO) / REVEAL_SPAN) * 255;
        const th = thr[p];
        if (rv > th) {
          const vt = V[ja + ia] + (V[ja + ib] - V[ja + ia]) * fu;
          const vb = V[jb + ia] + (V[jb + ib] - V[jb + ia]) * fu;
          const vv = ((vt + (vb - vt) * fv - REVEAL_LO) / REVEAL_SPAN) * 255;
          out[p] = vv > th ? base[p] : faded[p];
        } else if (r > 0.03 && rv > th - 40) {
          out[p] = rim;
        } else {
          out[p] = fog[p];
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Expedition route (red-ink dashed line through tile centres)
// ---------------------------------------------------------------------------

const DASH_PERIOD = 9;
const DASH_ON = 5;

class RouteLayer {
  readonly surface = makeSurface(W, H);
  private trailRef: Point[] | null = null;
  /** Number of segments baked into the canvas. */
  private baked = 0;
  /** Dash phase (px) at the end of the baked segments. */
  private dashPos = 0;

  sync(trail: Point[]): void {
    if (trail !== this.trailRef || trail.length - 1 < this.baked) {
      this.surface.ctx.clearRect(0, 0, W, H);
      this.trailRef = trail;
      this.baked = 0;
      this.dashPos = 0;
    }
    const ctx = this.surface.ctx;
    ctx.fillStyle = PALETTE.redInk;
    // Keep the newest segment dynamic so it can grow with the move tween.
    while (this.baked < trail.length - 2) {
      const i = this.baked;
      this.dashPos += drawRouteSegment(ctx, trail[i], trail[i + 1], this.dashPos, 1, 0, 0);
      if (i >= 1 && isTurn(trail[i - 1], trail[i], trail[i + 1])) drawTurnDot(ctx, trail[i], 0, 0);
      this.baked++;
    }
  }

  /** Draw the baked route plus the live newest segment (progress 0..1) onto ctx at the map origin. */
  draw(ctx: CanvasRenderingContext2D, trail: Point[], progress: number): void {
    ctx.drawImage(this.surface.canvas, MX0, MY0);
    const n = trail.length;
    ctx.fillStyle = PALETTE.redInk;
    if (n >= 2) {
      drawRouteSegment(ctx, trail[n - 2], trail[n - 1], this.dashPos, progress, MX0, MY0);
      if (n >= 3 && isTurn(trail[n - 3], trail[n - 2], trail[n - 1])) drawTurnDot(ctx, trail[n - 2], MX0, MY0);
    }
  }
}

function isTurn(a: Point, b: Point, c: Point): boolean {
  return Math.sign(b.x - a.x) !== Math.sign(c.x - b.x) || Math.sign(b.y - a.y) !== Math.sign(c.y - b.y);
}

function drawRouteSegment(
  ctx: CanvasRenderingContext2D,
  a: Point,
  b: Point,
  dashStart: number,
  progress: number,
  ox: number,
  oy: number,
): number {
  const x0 = a.x * TILE + TILE / 2;
  const y0 = a.y * TILE + TILE / 2;
  const x1 = b.x * TILE + TILE / 2;
  const y1 = b.y * TILE + TILE / 2;
  const len = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const limit = Math.round(len * clamp01(progress));
  plotLine(x0, y0, x1, y1, (x, y, i) => {
    if (i === 0 || i > limit) return;
    if ((dashStart + i) % DASH_PERIOD < DASH_ON) ctx.fillRect(ox + x - 1, oy + y - 1, 2, 2);
  });
  return len;
}

/** One report route step at the map origin: 2 px dashes (cost 1), a 2 px line (3) or a 4 px line (8). */
function drawCostSegment(ctx: CanvasRenderingContext2D, a: Point, b: Point, dashStart: number, cost: number): number {
  const x0 = a.x * TILE + TILE / 2;
  const y0 = a.y * TILE + TILE / 2;
  const x1 = b.x * TILE + TILE / 2;
  const y1 = b.y * TILE + TILE / 2;
  plotLine(x0, y0, x1, y1, (x, y, i) => {
    if (i === 0) return;
    if (cost >= COST_STEEP) ctx.fillRect(MX0 + x - 2, MY0 + y - 2, 4, 4);
    else if (cost >= COST_GENTLE || (dashStart + i) % DASH_PERIOD < DASH_ON) ctx.fillRect(MX0 + x - 1, MY0 + y - 1, 2, 2);
  });
  return Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
}

function drawTurnDot(ctx: CanvasRenderingContext2D, p: Point, ox: number, oy: number): void {
  const cx = ox + p.x * TILE + TILE / 2;
  const cy = oy + p.y * TILE + TILE / 2;
  ctx.fillRect(cx - 2, cy - 1, 4, 2);
  ctx.fillRect(cx - 1, cy - 2, 2, 4);
}

// ---------------------------------------------------------------------------
// Collapse: "ink bleeds out"
// ---------------------------------------------------------------------------

/** Arrival-time jitter (Bayer) that dithers the advancing ink front. */
const INK_JITTER = 0.035;
/** The wet, lighter edge runs this far ahead of the solid ink. */
const INK_EDGE = 0.02;

/**
 * Procedural ink spill that bleeds out of the fallen surveyor. Every pixel gets an arrival
 * time in [0, 1]: a pool under the body whose ragged, lobed rim keeps spreading, capillary
 * tendrils that creep downhill across the terrain, a few flung droplets and drips running
 * down the sheet. Near the neatline the pool and tendrils spill toward the middle of the
 * sheet instead of vanishing under the frame. Pixels are bucket-sorted by arrival time so
 * each frame only paints the pixels the ink front passed since the previous frame (no
 * per-frame full-map work).
 */
class InkBleed {
  readonly surface = makeSurface(W, H);
  readonly key: string;
  private readonly img: ImageData;
  private readonly buf: Uint32Array;
  private readonly order: Int32Array;
  private readonly times: Float32Array;
  private core = 0;
  private edge = 0;
  private readonly cInk = packHex(PALETTE.ink);
  private readonly cDeep = packHex('#2b211f');
  private readonly cEdge = packHex(PALETTE.inkSoft);
  private readonly isCore = new Uint8Array(NPIX);

  constructor(map: MapData, tileX: number, tileY: number) {
    const seed = map.seed;
    this.key = `${seed}:${tileX}:${tileY}`;
    this.img = this.surface.ctx.createImageData(W, H);
    this.buf = new Uint32Array(this.img.data.buffer);

    // The pool wells up under the fallen body (which lies across the lower half of the tile).
    const cx = tileX * TILE + TILE / 2;
    const cy = tileY * TILE + TILE / 2 + 2;
    const rng = mulberry32(hashSeed(seed, 0x1a4b + tileX * 131 + tileY));
    const noise = makeValueNoise(hashSeed(seed, 0x1a4c));
    const R0 = 58 + rng() * 22;
    // Edge bias: how close the spill is to the neatline, and which way the sheet's middle lies.
    const exN = clamp((cx - W / 2) / (W / 2), -1, 1);
    const eyN = clamp((cy - H / 2) / (H / 2), -1, 1);
    const edgeness = Math.max(Math.abs(exN), Math.abs(eyN)) ** 2;
    const inLen = Math.hypot(exN, eyN) || 1;
    const inX = -exN / inLen;
    const inY = -eyN / inLen;

    // Pool silhouette: radius as a periodic function of angle, tabulated. Broad lobes give
    // the rim its bulges; a few narrower ones rag it.
    const ANG = 1024;
    const radius = new Float32Array(ANG);
    const lobes: { a: number; amp: number; sharp: number }[] = [];
    const lobeCount = 7 + Math.floor(rng() * 5);
    for (let k = 0; k < lobeCount; k++) {
      lobes.push({ a: rng() * Math.PI * 2, amp: 0.1 + rng() * 0.26, sharp: 3 + rng() * 10 });
    }
    const ragged = 2 + Math.floor(rng() * 2);
    for (let k = 0; k < ragged; k++) {
      lobes.push({ a: rng() * Math.PI * 2, amp: 0.06 + rng() * 0.12, sharp: 12 + rng() * 8 });
    }
    for (let i = 0; i < ANG; i++) {
      const th = (i / ANG) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      let f = 0.6 + 0.42 * noise(c * 1.4 + 11, s * 1.4 + 7) + 0.2 * noise(c * 4.5 + 31, s * 4.5 + 19);
      for (const lobe of lobes) {
        const d = Math.cos(th - lobe.a);
        if (d > 0) f += lobe.amp * Math.pow(d, lobe.sharp);
      }
      f *= 1 + 0.9 * edgeness * Math.max(0, -(c * exN + s * eyN));
      radius[i] = R0 * f;
    }
    const radiusAt = (th: number): number => {
      const u = ((th / (Math.PI * 2)) * ANG + ANG) % ANG;
      const i0 = Math.floor(u);
      const t = u - i0;
      return radius[i0] + (radius[(i0 + 1) % ANG] - radius[i0]) * t;
    };

    /** A disc of ink stamped along a path, arriving at time t. */
    interface Dab {
      x: number;
      y: number;
      r: number;
      t: number;
    }
    const dabs: Dab[] = [];

    // Droplets flung just beyond the lobes, plus a few strays.
    for (const lobe of lobes) {
      if (rng() < 0.4) continue;
      const tip = radiusAt(lobe.a);
      const d = tip * (1.08 + rng() * 0.3);
      const a = lobe.a + (rng() - 0.5) * 0.1;
      dabs.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: 1.2 + rng() * 2.8, t: 0.4 + rng() * 0.4 });
    }
    for (let k = 0; k < 4; k++) {
      const a = rng() * Math.PI * 2;
      const d = radiusAt(a) * (1.15 + rng() * 0.45);
      dabs.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: 1.5 + rng() * rng() * 5, t: 0.3 + rng() * 0.5 });
    }

    // Capillary tendrils: random walks from the rim that creep downhill over the terrain
    // (and away from the neatline), thinning as they go.
    const g = 0.08;
    const downhill = (x: number, y: number): [number, number] => {
      const tx = x / TILE;
      const ty = y / TILE;
      const gx = map.sampleElevation(tx + g, ty) - map.sampleElevation(tx - g, ty);
      const gy = map.sampleElevation(tx, ty + g) - map.sampleElevation(tx, ty - g);
      const gl = Math.hypot(gx, gy);
      return gl > 1e-5 ? [-gx / gl, -gy / gl] : [0, 0];
    };
    // Near the bottom neatline there is no room for drips, so more tendrils carry the spill.
    const nearBottom = cy > H - R0 * 2;
    const tendrils = 10 + Math.floor(rng() * 6) + (nearBottom ? 6 : 0);
    for (let k = 0; k < tendrils; k++) {
      let a = rng() * Math.PI * 2;
      const r0 = radiusAt(a) * 0.85;
      let x = cx + Math.cos(a) * r0;
      let y = cy + Math.sin(a) * r0;
      const len = 25 + rng() * 75;
      const w0 = 1.5 + rng() * 1.8;
      const tStart = 0.3 + rng() * 0.2;
      for (let st = 0; st < len; st++) {
        const fr = st / len;
        a += (noise(x / 9 + k * 13, y / 9) - 0.5) * 0.6;
        const [hx, hy] = downhill(x, y);
        let dx = Math.cos(a) + hx * 0.9 + inX * edgeness * 0.6;
        let dy = Math.sin(a) + hy * 0.9 + inY * edgeness * 0.6;
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl;
        dy /= dl;
        x += dx;
        y += dy;
        a = Math.atan2(dy, dx);
        if (x < -4 || y < -4 || x > W + 4 || y > H + 4) break;
        dabs.push({ x, y, r: (w0 * (1 - fr * 0.7)) / 2, t: tStart + fr * (0.97 - tStart) });
      }
    }

    // Drips run down the sheet from the lower rim: they leave the pool wide, wander a little,
    // thin out and end in a small bead.
    const dripCount = nearBottom ? 0 : 4 + Math.floor(rng() * 4);
    for (let k = 0; k < dripCount; k++) {
      const a = Math.PI / 2 + (rng() * 2 - 1) * 1.05;
      const edgeR = radiusAt(a) * 0.8;
      const x0 = cx + Math.cos(a) * edgeR;
      const y0 = cy + Math.sin(a) * edgeR;
      const s = 0.3 + rng() * 0.3;
      const dur = Math.min(0.97 - s, 0.3 + rng() * 0.35);
      const len = Math.min(40 + rng() * 140, H - 6 - y0);
      if (len < 12) continue;
      const w = 2.5 + rng() * 2;
      const phase = rng() * 10;
      const sway = 0.8 + rng() * 1.6;
      for (let st = 0; st <= len; st++) {
        const along = st / len;
        const x = x0 + Math.sin(st / 23 + phase) * sway * along;
        const y = y0 + st;
        dabs.push({ x, y, r: (w - along ** 0.7 * (w - 1)) / 2, t: s + dur * along ** 0.85 });
        if (st === Math.floor(len)) dabs.push({ x, y: y + 1, r: 1.6 + rng() * 0.8, t: s + dur });
      }
    }

    let maxR = 0;
    for (let i = 0; i < ANG; i++) maxR = Math.max(maxR, radius[i]);
    let minX = cx - maxR - 2;
    let maxX = cx + maxR + 2;
    let minY = cy - maxR - 2;
    let maxY = cy + maxR + 2;
    for (const d of dabs) {
      minX = Math.min(minX, d.x - d.r - 2);
      maxX = Math.max(maxX, d.x + d.r + 2);
      minY = Math.min(minY, d.y - d.r - 2);
      maxY = Math.max(maxY, d.y + d.r + 2);
    }
    const x0 = clamp(Math.floor(minX), 0, W - 1);
    const x1 = clamp(Math.ceil(maxX), 0, W - 1);
    const y0 = clamp(Math.floor(minY), 0, H - 1);
    const y1 = clamp(Math.ceil(maxY), 0, H - 1);

    const LIMIT = 1 + INK_EDGE;
    const BUCKETS = 1024;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const tField = new Float32Array(bw * bh);

    // The pool: the radius grows like t^0.625, so it starts small under the body and keeps
    // spreading instead of reaching a third of its size in the first frames.
    const reach2 = maxR * maxR * 1.1;
    for (let py = y0, q = 0; py <= y1; py++) {
      const dy = py - cy;
      for (let px = x0; px <= x1; px++, q++) {
        const dx = px - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach2) {
          tField[q] = Infinity;
          continue;
        }
        const rn = radiusAt(Math.atan2(dy, dx)) * (0.97 + 0.06 * noise(px / 3.1 + 70, py / 3.1));
        tField[q] = Math.pow(d2 / (rn * rn), 0.8);
      }
    }
    for (const d of dabs) {
      const r = d.r + 0.5;
      for (let py = Math.max(y0, Math.floor(d.y - r)); py <= Math.min(y1, Math.ceil(d.y + r)); py++) {
        for (let px = Math.max(x0, Math.floor(d.x - r)); px <= Math.min(x1, Math.ceil(d.x + r)); px++) {
          const ddx = px - d.x;
          const ddy = py - d.y;
          if (ddx * ddx + ddy * ddy > r * r) continue;
          const q = (py - y0) * bw + (px - x0);
          // Droplets darken from the middle out; path dabs arrive all at once.
          const t = d.t + (d.r > 2 ? 0.08 * ((ddx * ddx + ddy * ddy) / (r * r)) : 0);
          if (t < tField[q]) tField[q] = t;
        }
      }
    }
    // Dither the advancing front and count arrivals per time bucket.
    const counts = new Int32Array(BUCKETS + 1);
    let n = 0;
    for (let py = y0, q = 0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++, q++) {
        const T = tField[q] + bayerT(px, py) * INK_JITTER;
        tField[q] = T;
        if (T <= LIMIT) {
          counts[Math.min(BUCKETS, Math.floor((T / LIMIT) * BUCKETS))]++;
          n++;
        }
      }
    }
    // Bucket sort by arrival time.
    const starts = new Int32Array(BUCKETS + 2);
    for (let b = 0; b <= BUCKETS; b++) starts[b + 1] = starts[b] + counts[b];
    this.order = new Int32Array(n);
    this.times = new Float32Array(n);
    const fillPos = starts.slice();
    for (let py = y0, q = 0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++, q++) {
        const T = tField[q];
        if (T > LIMIT) continue;
        const b = Math.min(BUCKETS, Math.floor((T / LIMIT) * BUCKETS));
        const at = fillPos[b]++;
        this.order[at] = py * W + px;
        this.times[at] = T;
      }
    }
  }

  /** Advance the ink fronts to progress p (0..1) and upload only the touched rectangle. */
  advance(p: number): void {
    const n = this.order.length;
    let dx0 = W;
    let dy0 = H;
    let dx1 = -1;
    let dy1 = -1;
    const touch = (q: number): void => {
      const x = q % W;
      const y = (q - x) / W;
      if (x < dx0) dx0 = x;
      if (x > dx1) dx1 = x;
      if (y < dy0) dy0 = y;
      if (y > dy1) dy1 = y;
    };
    const edgeFront = p + INK_EDGE;
    while (this.edge < n && this.times[this.edge] <= edgeFront) {
      const q = this.order[this.edge++];
      if (this.isCore[q]) continue;
      this.buf[q] = this.cEdge;
      touch(q);
    }
    while (this.core < n && this.times[this.core] <= p) {
      const q = this.order[this.core++];
      this.isCore[q] = 1;
      const x = q % W;
      const y = (q - x) / W;
      this.buf[q] = hash2(x, y, 0x1c) < 0.1 ? this.cDeep : this.cInk;
      touch(q);
    }
    if (dx1 >= dx0) {
      this.surface.ctx.putImageData(this.img, 0, 0, dx0, dy0, dx1 - dx0 + 1, dy1 - dy0 + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome: desk, paper sheet, neatlines, title band
// ---------------------------------------------------------------------------

function buildDesk(): Surface {
  const surf = makeSurface(VIRTUAL_WIDTH, VIRTUAL_HEIGHT, true);
  const img = surf.ctx.createImageData(VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
  const out = new Uint32Array(img.data.buffer);
  const ramp = packAll(['#1d1511', PALETTE.desk, '#33261f', PALETTE.deskLight]);
  const noise = makeValueNoise(0xde5c);
  for (let y = 0, p = 0; y < VIRTUAL_HEIGHT; y++) {
    for (let x = 0; x < VIRTUAL_WIDTH; x++, p++) {
      const warp = noise(x / 300, y / 40) * 18;
      const grain = noise(x / 210, (y + warp) / 7) * 0.62 + noise(x / 48 + 13, (y + warp) / 2.4) * 0.38;
      const edge = Math.min(x, y, VIRTUAL_WIDTH - 1 - x, VIRTUAL_HEIGHT - 1 - y);
      const vignette = edge < 60 ? (60 - edge) / 60 : 0;
      const c = 1.15 + (grain - 0.5) * 2.3 - vignette * 0.9;
      let idx = Math.floor(c + bayerT(x, y) - 0.5);
      idx = idx < 0 ? 0 : idx > 3 ? 3 : idx;
      out[p] = ramp[idx];
    }
  }
  surf.ctx.putImageData(img, 0, 0);
  return surf;
}

function hline(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, t = 1): void {
  ctx.fillRect(x0, y, x1 - x0 + 1, t);
}

function vline(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number, t = 1): void {
  ctx.fillRect(x, y0, t, y1 - y0 + 1);
}

/** Outline of the rectangle expanded by `o` px around the map (inclusive pixel edges). */
function mapFrame(ctx: CanvasRenderingContext2D, o: number, t = 1): void {
  const x0 = MX0 - o - (t - 1);
  const y0 = MY0 - o - (t - 1);
  const x1 = MX1 - 1 + o;
  const y1 = MY1 - 1 + o;
  hline(ctx, x0, x1 + (t - 1), y0, t);
  hline(ctx, x0, x1 + (t - 1), y1, t);
  vline(ctx, x0, y0, y1 + (t - 1), t);
  vline(ctx, x1, y0, y1 + (t - 1), t);
}

function buildChrome(desk: Surface, map: MapData, patterns: DitherPatterns, sprites: SpriteBank): Surface {
  const surf = makeSurface(VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
  const ctx = surf.ctx;
  ctx.drawImage(desk.canvas, 0, 0);

  // Paper shadow and sheet.
  ctx.fillStyle = SHADOW_HEX;
  ctx.fillRect(SHEET_X + 4, SHEET_Y + 5, SHEET_W, SHEET_H);
  ctx.fillStyle = '#1f1612';
  ctx.fillRect(SHEET_X + 2, SHEET_Y + 2, SHEET_W, SHEET_H);
  ctx.fillStyle = PALETTE.parchment;
  ctx.fillRect(SHEET_X, SHEET_Y, SHEET_W, SHEET_H);

  // Aged edges: dithered darkening bands and a crisp paper border.
  const band = (inset: number, width: number, color: string, level: number): void => {
    const pat = patterns.get(color, level);
    if (!pat) return;
    ctx.fillStyle = pat;
    const x0 = SHEET_X + inset;
    const y0 = SHEET_Y + inset;
    const w = SHEET_W - inset * 2;
    const h = SHEET_H - inset * 2;
    ctx.fillRect(x0, y0, w, width);
    ctx.fillRect(x0, y0 + h - width, w, width);
    ctx.fillRect(x0, y0 + width, width, h - width * 2);
    ctx.fillRect(x0 + w - width, y0 + width, width, h - width * 2);
  };
  band(0, 5, PALETTE.parchmentDark, 6);
  band(0, 2, PALETTE.parchmentShade, 8);
  ctx.fillStyle = PALETTE.parchmentShade;
  ctx.fillRect(SHEET_X, SHEET_Y, SHEET_W, 1);
  ctx.fillRect(SHEET_X, SHEET_Y + SHEET_H - 1, SHEET_W, 1);
  ctx.fillRect(SHEET_X, SHEET_Y, 1, SHEET_H);
  ctx.fillRect(SHEET_X + SHEET_W - 1, SHEET_Y, 1, SHEET_H);

  // Margin speckle (the map area is covered by the survey composite).
  const seed = map.seed | 0;
  for (let y = SHEET_Y + 2; y < SHEET_Y + SHEET_H - 2; y++) {
    for (let x = SHEET_X + 2; x < SHEET_X + SHEET_W - 2; x++) {
      if (x >= MX0 - 10 && x < MX1 + 10 && y >= MY0 - 10 && y < MY1 + 10) continue;
      const h = hash2(x, y, seed ^ 0x77);
      if (h < 0.014) {
        ctx.fillStyle = h < 0.002 ? PALETTE.inkPale : PALETTE.parchmentDark;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  // Neatlines: thin inner line and a graduated band between two hairlines, then a heavy
  // outer line (kept compact so the grid labels get clean paper in the margin).
  ctx.fillStyle = PALETTE.ink;
  mapFrame(ctx, 1);
  mapFrame(ctx, 4);
  mapFrame(ctx, 6, 2);
  const seg = TILE * 5;
  for (let k = 0; k < MAP_W / 5; k += 2) {
    const x = MX0 + k * seg;
    ctx.fillRect(x, MY0 - 3, seg, 2);
    ctx.fillRect(x, MY1 + 1, seg, 2);
  }
  for (let k = 0; k < MAP_H / 5; k += 2) {
    const y = MY0 + k * seg;
    ctx.fillRect(MX0 - 3, y, 2, seg);
    ctx.fillRect(MX1 + 1, y, 2, seg);
  }
  // Band corners.
  ctx.fillRect(MX0 - 3, MY0 - 3, 2, 2);
  ctx.fillRect(MX1 + 1, MY0 - 3, 2, 2);
  ctx.fillRect(MX0 - 3, MY1 + 1, 2, 2);
  ctx.fillRect(MX1 + 1, MY1 + 1, 2, 2);
  // Grid ticks every 10 tiles, outside the heavy line.
  for (let gx = 10; gx < MAP_W; gx += 10) {
    const x = MX0 + gx * TILE;
    vline(ctx, x, MY1 + 8, MY1 + 9);
    vline(ctx, x, MY0 - 10, MY0 - 9);
  }
  for (let gy = 10; gy < MAP_H; gy += 10) {
    const y = MY0 + gy * TILE;
    hline(ctx, MX0 - 10, MX0 - 9, y);
    hline(ctx, MX1 + 8, MX1 + 9, y);
  }
  // Grid letters (columns) and numbers (rows), each on a patch of clean paper so the
  // aged sheet edge never touches the glyphs.
  const marginLabel = (text: string, cx: number, y: number): void => {
    const w = measureText(text);
    ctx.fillStyle = PALETTE.parchment;
    ctx.fillRect(Math.round(cx - w / 2) - 1, y - 1, w + 2, 9);
    drawText(ctx, text, cx, y, { color: PALETTE.inkSoft, align: 'center' });
  };
  for (let k = 0; k < MAP_W / 10; k++) marginLabel(String.fromCharCode(65 + k), MX0 + k * 120 + 60, MY1 + 8);
  for (let k = 0; k < MAP_H / 10; k++) {
    const y = MY0 + k * 120 + 60 - 3;
    marginLabel(String(k + 1), MX0 - 13, y);
    marginLabel(String(k + 1), MX1 + 12, y);
  }

  drawTitleBand(ctx, map);
  drawLegend(ctx, sprites);
  return surf;
}

/** Compact map legend in the title band, drawn with the same symbols as the map. */
function drawLegend(ctx: CanvasRenderingContext2D, sprites: SpriteBank): void {
  const x0 = LEGEND_X;
  const col = 76;
  const rows = [15, 31];
  const label = (x: number, y: number, text: string, dx = 17): void => {
    drawText(ctx, text, x + dx, y, { color: PALETTE.inkSoft });
  };
  ctx.fillStyle = PALETTE.inkPale;
  ctx.fillRect(x0 - 8, 13, 1, 30);

  // Route: red dashes.
  let x = x0;
  let y = rows[0];
  ctx.fillStyle = PALETTE.redInk;
  for (let k = 0; k < 3; k++) ctx.fillRect(x + k * 5, y + 3, 3, 2);
  label(x, y, t('legendRoute'));

  // Cliff: a 2 px contour with tapered hachure ticks hanging toward the lower side.
  x = x0 + col;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(x, y + 1, 13, 2);
  for (let k = 0; k < 3; k++) {
    const tx = x + 2 + k * 4;
    ctx.fillRect(tx, y + 3, 2, 2);
    ctx.fillRect(tx, y + 5, 1, 2);
  }
  label(x, y, t('legendCliffShort'));

  // Water: hatched swatch with a shoreline.
  x = x0 + col * 2;
  ctx.fillStyle = PALETTE.water;
  ctx.fillRect(x, y, 13, 7);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(x, y, 13, 1);
  ctx.fillStyle = PALETTE.waterInk;
  ctx.fillRect(x, y + 2, 13, 1);
  ctx.fillStyle = WATER_HATCH_HEX;
  ctx.fillRect(x + 1, y + 4, 5, 1);
  ctx.fillRect(x + 8, y + 4, 4, 1);
  ctx.fillRect(x + 3, y + 6, 7, 1);
  label(x, y, t('legendWaterShort'));

  // Cache: both kinds, the plateau crate and the saddle tent.
  y = rows[1];
  x = x0;
  const crate = sprites.crate[0];
  const tent = sprites.tent[0];
  ctx.drawImage(crate.canvas, x + 1, y + 7 - crate.h);
  ctx.drawImage(tent.canvas, x + 12, y + 7 - tent.h);
  label(x, y, t('legendCacheShort'), 25);

  // Spot height.
  x = x0 + col;
  ctx.drawImage(sprites.spotTriangle.canvas, x + 3, y + 2);
  label(x, y, t('legendSpot'));

  // Trig pillar in its station triangle, as drawn on the map.
  x = x0 + col * 2;
  ctx.drawImage(sprites.trigLegend.canvas, x - 1, y - 3);
  label(x, y, t('legendTrigShort'));
}

function drawTitleBand(ctx: CanvasRenderingContext2D, map: MapData): void {
  // Same plain form as the HUD and the cards (no zero padding).
  const titleW = drawText(ctx, t('sheetTitle', { seed: String(map.seed) }), MX0 - 4, 14, { color: PALETTE.ink, scale: 2 });
  drawText(ctx, t('sheetSpec', { c: 30, i: 150 }), MX0 - 4, 34, {
    color: PALETTE.inkSoft,
  });

  // Red "FIELD COPY" stamp, when the sheet number leaves room before the legend.
  const sx = MX0 - 4 + titleW + 22;
  const sw = measureText(t('fieldCopy')) + 12;
  if (sx + sw <= LEGEND_X - 12) {
    ctx.fillStyle = PALETTE.redInk;
    ctx.fillRect(sx, 13, sw, 1);
    ctx.fillRect(sx, 27, sw, 1);
    ctx.fillRect(sx, 13, 1, 15);
    ctx.fillRect(sx + sw - 1, 13, 1, 15);
    ctx.fillRect(sx + 2, 15, sw - 4, 1);
    ctx.fillRect(sx + 2, 25, sw - 4, 1);
    ctx.fillRect(sx + 2, 15, 1, 11);
    ctx.fillRect(sx + sw - 3, 15, 1, 11);
    drawText(ctx, t('fieldCopy'), sx + 6, 17, { color: PALETTE.redInk });
  }

  // Scale bar: 1 km = 20 tiles, with a subdivided extension to the left of zero.
  const x0 = 690;
  const unit = (250 / METRES_PER_TILE) * TILE; // 250 m in px
  const y = 24;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(x0 - unit, y, unit * 5 + 1, 1);
  ctx.fillRect(x0 - unit, y + 5, unit * 5 + 1, 1);
  ctx.fillRect(x0 - unit, y, 1, 6);
  ctx.fillRect(x0 + unit * 4, y, 1, 6);
  for (let k = 0; k < 4; k++) {
    const sx0 = x0 + k * unit;
    ctx.fillRect(sx0, y, 1, 6);
    if (k % 2 === 0) ctx.fillRect(sx0, y + 1, unit, 4);
  }
  // The extension alternates the other way round, so the cell touching zero is open and
  // the zero division reads against the solid first segment.
  const sub = unit / 5;
  for (let k = 0; k < 5; k++) {
    const sx0 = x0 - unit + k * sub;
    ctx.fillRect(sx0, y, 1, 6);
    if (k % 2 === 1) ctx.fillRect(sx0, y + 1, sub, 4);
  }
  for (let k = -1; k <= 4; k++) {
    drawText(ctx, String(Math.abs(k) * 250), x0 + k * unit, 14, { color: PALETTE.ink, align: 'center' });
  }
  drawText(ctx, t('scale'), x0 + unit * 1.5, 34, { color: PALETTE.inkSoft, align: 'center' });
  // Unit under the far end of the bar, clear of the north arrow.
  drawText(ctx, t('metres'), x0 + unit * 4, 34, { color: PALETTE.inkSoft, align: 'right' });

  // North arrow (half-shaded arrowhead on a staff).
  const nx = 962;
  ctx.fillStyle = PALETTE.ink;
  for (let r = 0; r < 18; r++) {
    const half = Math.floor(r / 3);
    ctx.fillRect(nx - half, 14 + r, half, 1); // shaded left half
    ctx.fillRect(nx - half, 14 + r, 1, 1);
    ctx.fillRect(nx + half, 14 + r, 1, 1);
  }
  vline(ctx, nx, 13, 44);
  hline(ctx, nx - 5, nx + 5, 31);
  drawText(ctx, 'N', nx + 9, 16, { color: PALETTE.ink });
}

/** Paper fold creases across the whole sheet, baked into a transparent overlay. */
function buildCreases(seed: number): Surface {
  const surf = makeSurface(SHEET_W, SHEET_H);
  const ctx = surf.ctx;
  const rng = mulberry32(hashSeed(seed, 0xc4ea5e));
  const shade = 'rgba(58,46,43,0.11)';
  const light = 'rgba(255,252,242,0.42)';
  const soft = 'rgba(58,46,43,0.045)';
  const wobble = (t: number, a: number, b: number): number =>
    Math.round(Math.sin(t / 150 + a) * 1.2 + Math.sin(t / 47 + b) * 0.6);
  for (let k = 1; k <= 2; k++) {
    const base = Math.round((SHEET_W * k) / 3 + (rng() - 0.5) * 16);
    const a = rng() * 10;
    const b = rng() * 10;
    for (let y = 0; y < SHEET_H; y++) {
      const x = base + wobble(y, a, b);
      ctx.fillStyle = shade;
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = light;
      ctx.fillRect(x + 1, y, 1, 1);
      ctx.fillStyle = soft;
      ctx.fillRect(x - 3, y, 3, 1);
    }
  }
  const baseY = Math.round(SHEET_H / 2 + (rng() - 0.5) * 16);
  const a = rng() * 10;
  const b = rng() * 10;
  for (let x = 0; x < SHEET_W; x++) {
    const y = baseY + wobble(x, a, b);
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, 1, 1);
    ctx.fillStyle = light;
    ctx.fillRect(x, y + 1, 1, 1);
    ctx.fillStyle = soft;
    ctx.fillRect(x, y - 3, 1, 3);
  }
  return surf;
}

// ---------------------------------------------------------------------------
// Map change: dithered wipe from the old frame to the new one
// ---------------------------------------------------------------------------

const SHEET_WIPE_MS = 300;
/**
 * The wipe runs top to bottom in this many bands, each lagging the one above; the lag of the
 * last band (in units of one band's dissolve) keeps the dithered front, where old and new
 * frames mix, to a few bands.
 */
const WIPE_BANDS = 16;
const WIPE_SPREAD = 2.5;

/**
 * Keeps the whole outgoing frame (sheet, HUD and any title or end card) and dissolves it away
 * (ordered dither) over the new one, so everything changes over together.
 */
class SheetWipe {
  private readonly surface = makeSurface(VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
  private readonly patterns = new DitherPatterns(this.surface.ctx);
  private start = -Infinity;

  /** Take the frame currently shown on `canvas` as the outgoing image. */
  capture(canvas: HTMLCanvasElement): void {
    const ctx = this.surface.ctx;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(canvas, 0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT, 0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    ctx.globalCompositeOperation = 'source-over';
  }

  begin(now: number): void {
    this.start = now;
  }

  /** Erase a little more of the outgoing frame (monotonic per band) and draw what is left. */
  draw(ctx: CanvasRenderingContext2D, now: number): void {
    const k = Math.max(0, (now - this.start) / SHEET_WIPE_MS);
    if (k >= 1) return;
    const sctx = this.surface.ctx;
    sctx.globalCompositeOperation = 'destination-out';
    const bandH = Math.ceil(VIRTUAL_HEIGHT / WIPE_BANDS);
    for (let b = 0; b < WIPE_BANDS; b++) {
      const level = Math.round(16 * clamp01(k * (1 + WIPE_SPREAD) - (WIPE_SPREAD * b) / (WIPE_BANDS - 1)));
      const pat = level > 0 ? this.patterns.get('#000000', level) : null;
      if (!pat) continue;
      sctx.fillStyle = pat;
      sctx.fillRect(0, b * bandH, VIRTUAL_WIDTH, bandH);
    }
    sctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.surface.canvas, 0, 0);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type EffectLayer = 'ground' | 'label' | 'air';

/** Which pass draws an effect (see Renderer.drawEffects). */
function effectLayer(kind: EffectKind): EffectLayer {
  if (kind === 'summit-flare') return 'ground';
  return kind === 'float-text' ? 'label' : 'air';
}

export interface RendererStats {
  /** Wall-clock time of the last full map-layer rebuild (ms). */
  mapBuildMs: number;
  /** Elevation sampling stride used for the last rebuild (1 = every pixel). */
  sampleStep: number;
  /** Per-stage timings of the last rebuild (ms). */
  buildTimings: Record<string, number>;
  /** Time spent in the last render() call, including HUD and overlay (ms). */
  frameMs: number;
}

export class Renderer {
  readonly stats: RendererStats = { mapBuildMs: 0, sampleStep: 1, buildTimings: {}, frameMs: 0 };

  private readonly ctx: CanvasRenderingContext2D;
  private readonly patterns: DitherPatterns;
  private readonly sprites: SpriteBank;
  private readonly scratch: Surface;
  private readonly desk: Surface;
  private readonly compositor: SurveyCompositor;
  private readonly route = new RouteLayer();
  private readonly wipe = new SheetWipe();

  private map: MapData | null = null;
  private layers: SheetLayers | null = null;
  private chrome: Surface | null = null;
  private creases: Surface | null = null;
  private ink: InkBleed | null = null;
  /** The report's never-surveyed layer for the current sheet, built the first time a report shows. */
  private hindsight: Uint32Array | null = null;
  /** Per fog glyph: when it started fading out (Infinity = still shown, -Infinity = gone). */
  private glyphFade = new Float64Array(0);
  /** Per cache: sighting as last seen here, and when it was newly sighted (-Infinity = never on this sheet). */
  private cacheSeen: boolean[] = [];
  private cacheSightedAt: number[] = [];
  private ringRadius = 0;
  private lastNow = 0;
  /** Language + web-font epoch the sheet header and fog lettering were drawn with. */
  private textKey = '';

  constructor(canvas: HTMLCanvasElement) {
    if (canvas.width !== VIRTUAL_WIDTH) canvas.width = VIRTUAL_WIDTH;
    if (canvas.height !== VIRTUAL_HEIGHT) canvas.height = VIRTUAL_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    ctx.imageSmoothingEnabled = false;
    this.patterns = new DitherPatterns(ctx);
    this.sprites = createSpriteBank();
    this.scratch = makeSurface(W, H, true);
    this.desk = buildDesk();
    this.compositor = new SurveyCompositor(buildFogEdgeField());
  }

  render(state: GameState, now: number): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    if (state.map !== this.map || !this.layers || !this.chrome || !this.creases) {
      // A new map replacing one already on screen (R): keep the whole old frame for the wipe.
      const replacing = this.chrome !== null;
      if (replacing) this.wipe.capture(ctx.canvas);
      this.rebuild(state);
      if (replacing) this.wipe.begin(performance.now());
    }
    if (this.textKey !== `${langVersion()}|${fontEpoch()}`) this.refreshText(state);
    const layers = this.layers;
    const chrome = this.chrome;
    const creases = this.creases;
    if (!layers || !chrome || !creases) return;

    // On the end cards the sheet is the expedition report: all of it on show, the surveyed ground
    // crisp and the rest seen through the fog. Only the drawing changes; the game state does not.
    if (isReport(state)) {
      this.hindsight ??= buildHindsight(layers.faded, layers.fog);
      this.compositor.setUnseen(this.hindsight);
      this.compositor.update(state, now, ALL_TILES, state.revealed);
    } else {
      this.compositor.setUnseen(null);
      this.compositor.update(state, now);
    }
    this.route.sync(state.trail);

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.drawImage(chrome.canvas, 0, 0);
    ctx.drawImage(this.compositor.surface.canvas, MX0, MY0);
    this.drawFogLettering(layers.fogGlyphs, now);
    ctx.drawImage(creases.canvas, SHEET_X, SHEET_Y);

    ctx.save();
    ctx.beginPath();
    ctx.rect(MX0, MY0, W, H);
    ctx.clip();
    const pos = this.playerPixel(state, now);
    this.drawSpotHeights(layers.spots, now);
    this.drawVisionRing(state, pos, now);
    this.drawRoute(state, now);
    const echo = stepEcho(state, now);
    if (echo) this.drawEchoStroke(echo);
    this.drawPhaseUnder(state, now);
    this.drawEffects(state, now, 'ground');
    // An echo just drawn beside the surveyor already shows where he is; the ring would cover its figure.
    if (!echo) this.drawYouAreHere(state, pos.x, pos.y, now);
    this.drawObjects(state, now, pos.t);
    this.drawEffects(state, now, 'label');
    if (echo) this.drawEchoCost(echo);
    this.drawPlayer(state, pos, now);
    this.drawEffects(state, now, 'air');
    this.drawPhaseOver(state, pos, now);
    ctx.restore();

    this.drawSheetDim(state, now);
    ctx.restore();

    this.drawTapRipples(now);
    drawHud(ctx, state, now);
    drawOverlay(ctx, state, now);
    drawUi(ctx, state, now);
    // Last, so the old frame (sheet, HUD and card) dissolves over the new one as one piece.
    this.wipe.draw(ctx, now);
    this.lastNow = now;
    this.stats.frameMs = Math.round((performance.now() - t0) * 100) / 100;
  }

  // -------------------------------------------------------------------------
  // Layer management
  // -------------------------------------------------------------------------

  private rebuild(state: GameState): void {
    const t0 = performance.now();
    const map = state.map;
    this.map = map;
    this.layers = buildSheetLayers(map, this.scratch);
    this.chrome = buildChrome(this.desk, map, this.patterns, this.sprites);
    this.creases = buildCreases(map.seed);
    this.compositor.reset(this.layers, state);
    this.hindsight = null;
    this.glyphFade = Float64Array.from(this.layers.fogGlyphs, (g) =>
      g.tiles.some((i) => state.revealed[i]) ? -Infinity : Infinity,
    );
    this.cacheSeen = state.cacheSighted.slice();
    this.cacheSightedAt = state.cacheSighted.map(() => -Infinity);
    this.ink = null;
    this.ringRadius = (state.visionRadius + 0.5) * TILE + 4;
    this.stats.mapBuildMs = Math.round((performance.now() - t0) * 10) / 10;
    this.stats.sampleStep = this.layers.sampleStep;
    this.stats.buildTimings = { ...this.layers.timings };
    this.textKey = `${langVersion()}|${fontEpoch()}`;
  }

  /** Language switch or the web font arriving: redraw the lettered chrome and fog glyphs only. */
  private refreshText(state: GameState): void {
    this.textKey = `${langVersion()}|${fontEpoch()}`;
    if (!this.map || !this.layers) return;
    this.chrome = buildChrome(this.desk, this.map, this.patterns, this.sprites);
    this.layers.fogGlyphs = buildFogGlyphs(this.map);
    this.glyphFade = Float64Array.from(this.layers.fogGlyphs, (g) =>
      g.tiles.some((i) => state.revealed[i]) ? -Infinity : Infinity,
    );
  }

  /** Ink ripples where the map was tapped / clicked (mouse and touch movement feedback). */
  private drawTapRipples(now: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(MX0, MY0, W, H);
    ctx.clip();
    for (const tap of ui.taps) {
      const k = (now - tap.start) / TAP_RIPPLE_MS;
      if (k < 0 || k >= 1) continue;
      const cx = MX0 + tap.x * TILE + TILE / 2;
      const cy = MY0 + tap.y * TILE + TILE / 2;
      const r = Math.round(3 + k * 9);
      const level = Math.max(2, Math.round((1 - k) * 16));
      const pat = this.patterns.get(PALETTE.redInk, level);
      if (!pat) continue;
      ctx.fillStyle = pat;
      fillRing(ctx, cx, cy, r - 1.5, r + 0.5);
      if (k < 0.35) {
        ctx.fillStyle = PALETTE.redInk;
        ctx.fillRect(cx - 1, cy - 1, 2, 2);
      }
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Player position / pose
  // -------------------------------------------------------------------------

  /** Tweened player tile-centre position in canvas px, plus the move progress. */
  private playerPixel(state: GameState, now: number): { x: number; y: number; t: number } {
    const p = state.player;
    const t = MOVE_ANIM_MS > 0 ? clamp01((now - p.moveStart) / MOVE_ANIM_MS) : 1;
    const fx = p.fromX + (p.x - p.fromX) * t;
    const fy = p.fromY + (p.y - p.fromY) * t;
    let x = Math.round(MX0 + fx * TILE + TILE / 2);
    let y = Math.round(MY0 + fy * TILE + TILE / 2);
    const since = now - p.bumpStart;
    if (since >= 0 && since < BUMP_SHAKE_MS) {
      const k = since / BUMP_SHAKE_MS;
      const amp = Math.round(Math.sin(k * Math.PI * 3) * (1 - k) * 3);
      x += DIRS[p.bumpDir].dx * amp;
      y += DIRS[p.bumpDir].dy * amp;
    }
    return { x, y, t };
  }

  // -------------------------------------------------------------------------
  // Map overlays
  // -------------------------------------------------------------------------

  /** Fog lettering, whole glyphs only: a glyph fades out in steps once ground under it is surveyed. */
  private drawFogLettering(glyphs: readonly FogGlyph[], now: number): void {
    const ctx = this.ctx;
    const comp = this.compositor;
    for (let g = 0; g < glyphs.length; g++) {
      const glyph = glyphs[g];
      if (this.glyphFade[g] === Infinity && glyph.tiles.some((i) => comp.isShown(i, now))) this.glyphFade[g] = now;
      const k = (now - this.glyphFade[g]) / GLYPH_FADE_MS;
      if (k >= 1) continue;
      ctx.globalAlpha = k <= 0 ? 1 : Math.ceil((1 - k) * 3) / 3;
      ctx.drawImage(glyph.sprite.canvas, MX0 + glyph.x, MY0 + glyph.y);
    }
    ctx.globalAlpha = 1;
  }

  private drawSpotHeights(spots: readonly SpotHeight[], now: number): void {
    const ctx = this.ctx;
    const tri = this.sprites.spotTriangle;
    for (const s of spots) {
      if (!this.compositor.isShown(s.tile, now)) continue;
      if (!s.summit) ctx.drawImage(tri.canvas, MX0 + s.cx - 3, MY0 + s.cy - 3);
      ctx.drawImage(s.label.canvas, MX0 + s.lx, MY0 + s.ly);
    }
  }

  /** Faint marching dotted circle showing the current line-of-sight radius. */
  private drawVisionRing(state: GameState, pos: { x: number; y: number }, now: number): void {
    const target = (state.visionRadius + 0.5) * TILE + 4;
    const dt = Math.max(0, Math.min(100, now - this.lastNow));
    this.ringRadius += (target - this.ringRadius) * (1 - Math.exp(-dt / RING_EASE_MS));
    if (Math.abs(target - this.ringRadius) < 0.3) this.ringRadius = target;
    if (state.phase !== 'playing') return;
    const ctx = this.ctx;
    const r = this.ringRadius;
    const circumference = Math.PI * 2 * r;
    const dots = Math.max(12, Math.round(circumference / 5));
    const phase = (now / 2400) % 1;
    ctx.fillStyle = PALETTE.inkFaded;
    for (let i = 0; i < dots; i++) {
      const a = ((i + phase) / dots) * Math.PI * 2;
      ctx.fillRect(Math.round(pos.x + Math.cos(a) * r), Math.round(pos.y + Math.sin(a) * r), 1, 1);
    }
    // Bearing ticks at the cardinal points.
    ctx.fillStyle = PALETTE.inkSoft;
    const ri = Math.round(r);
    ctx.fillRect(pos.x, pos.y - ri - 2, 1, 4);
    ctx.fillRect(pos.x, pos.y + ri - 1, 1, 4);
    ctx.fillRect(pos.x - ri - 2, pos.y, 4, 1);
    ctx.fillRect(pos.x + ri - 1, pos.y, 4, 1);
  }

  private drawRoute(state: GameState, now: number): void {
    const trail = state.trail;
    if (trail.length === 0) return;
    const ctx = this.ctx;
    const camp = this.sprites.camp;
    const start = trail[0];
    ctx.drawImage(camp.canvas, MX0 + start.x * TILE + TILE / 2 - 4, MY0 + start.y * TILE + TILE / 2 - 4);
    if (isReport(state)) {
      this.drawCostRoute(state);
      return;
    }
    const progress = clamp01((now - state.player.moveStart) / Math.max(1, MOVE_ANIM_MS));
    this.route.draw(ctx, trail, progress);
  }

  /**
   * The report's route, inked by what each step cost: dashed for 1 (flat), solid for 3 (gentle
   * uphill), heavy for 8 (steep), so the stretches that emptied the pack stand out on the terrain.
   */
  private drawCostRoute(state: GameState): void {
    const ctx = this.ctx;
    const { trail, stepCosts } = state;
    ctx.fillStyle = PALETTE.redInk;
    let dash = 0;
    for (let k = 0; k + 1 < trail.length; k++) {
      dash += drawCostSegment(ctx, trail[k], trail[k + 1], dash, stepCosts[k] ?? COST_FLAT);
      if (k >= 1 && isTurn(trail[k - 1], trail[k], trail[k + 1])) drawTurnDot(ctx, trail[k], MX0, MY0);
    }
  }

  /**
   * Explorer Step Echo, the stroke: the step just taken re-inked as the report inks its route (solid
   * for 3, heavy for 8) on a thin parchment halo, drawn out with the surveyor's tween and fading away.
   */
  private drawEchoStroke(echo: StepEcho): void {
    const ctx = this.ctx;
    const heavy = echo.cost >= COST_STEEP;
    const w = heavy ? 4 : 2;
    const x0 = echo.from.x * TILE + TILE / 2;
    const y0 = echo.from.y * TILE + TILE / 2;
    const x1 = echo.to.x * TILE + TILE / 2;
    const y1 = echo.to.y * TILE + TILE / 2;
    const limit = Math.round(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * echo.progress);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * echo.alpha;
    for (const [color, size] of [
      [PALETTE.parchment, w + 2],
      [PALETTE.redInk, w],
    ] as const) {
      ctx.fillStyle = color;
      const h = size / 2;
      plotLine(x0, y0, x1, y1, (x, y, i) => {
        if (i <= limit) ctx.fillRect(MX0 + x - h, MY0 + y - h, size, size);
      });
    }
    ctx.globalAlpha = prev;
  }

  /**
   * Explorer Step Echo, the figure: the stamina the step cost, small, in map ink beside the middle of
   * the step (above a sideways step, right of an up-or-down one), once the surveyor has arrived.
   */
  private drawEchoCost(echo: StepEcho): void {
    if (!echo.showCost) return;
    const ctx = this.ctx;
    const mx = MX0 + ((echo.from.x + echo.to.x) / 2) * TILE + TILE / 2;
    const my = MY0 + ((echo.from.y + echo.to.y) / 2) * TILE + TILE / 2;
    const sideways = echo.from.y === echo.to.y;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * echo.alpha;
    const text = `${echo.cost}`;
    if (sideways) drawOutlinedText(ctx, text, Math.round(mx), Math.round(my) - 13, PALETTE.redInk, PALETTE.parchment, 'center');
    else drawOutlinedText(ctx, text, Math.round(mx) + 8, Math.round(my) - 3, PALETTE.redInk, PALETTE.parchment, 'left');
    ctx.globalAlpha = prev;
  }

  /** Caches and the Trig Pillar; `moveT` is the player's step progress (for the summit shuffle). */
  private drawObjects(state: GameState, now: number, moveT: number): void {
    const ctx = this.ctx;
    const map = state.map;
    const flagFrame = Math.floor(now / 420) % 2;
    const report = isReport(state);
    map.caches.forEach((cache, i) => {
      const tile = tileIndex(cache.x, cache.y);
      const collected = state.cacheCollected[i] === true;
      if (state.cacheSighted[i] && !this.cacheSeen[i]) {
        // Newly in sight: the beacon starts once its ground is on the sheet.
        this.cacheSeen[i] = true;
        if (!collected) this.cacheSightedAt[i] = Math.max(now, this.compositor.revealTime(tile));
      }
      if (!this.compositor.isShown(tile, now)) return;
      const x = MX0 + cache.x * TILE;
      const y = MY0 + cache.y * TILE;
      const frame = (flagFrame + i) % 2;
      let sprite: Sprite;
      if (cache.kind === 'saddle') sprite = collected ? this.sprites.tentOpen : this.sprites.tent[frame];
      else sprite = collected ? this.sprites.crateOpen : this.sprites.crate[frame];
      // On the report a camp the expedition never sighted is a ghost with a query mark.
      const ghost = report && !state.cacheSighted[i];
      if (!collected) this.drawCacheBeacon(x + TILE / 2, y + TILE - 6, now - this.cacheSightedAt[i]);
      if (ghost) ctx.globalAlpha = REPORT_GHOST_ALPHA;
      this.drawGroundShadow(x + TILE / 2, y + TILE - 1, 5);
      ctx.drawImage(sprite.canvas, x + Math.floor((TILE - sprite.w) / 2), y + TILE - sprite.h);
      ctx.globalAlpha = 1;
      if (ghost) drawText(ctx, '?', x + TILE - 2, y - 6, { color: PALETTE.inkSoft, shadow: PALETTE.parchment });
      if (collected) ctx.drawImage(this.sprites.tick.canvas, x + 5, y - 3);
    });

    const summitTile = tileIndex(map.summit.x, map.summit.y);
    if (this.compositor.isShown(summitTile, now)) {
      // With the surveyor on the summit the pillar steps aside; the station stays centred.
      const cx = MX0 + map.summit.x * TILE + TILE / 2;
      const baseY = MY0 + map.summit.y * TILE + TILE - 1;
      const shift = -this.summitOffset(state, moveT);
      this.drawTrigPillar(cx, shift, baseY, now, state.summitSighted && state.phase === 'playing');
    }
  }

  /**
   * With the surveyor on the summit he and the pillar stand side by side: his x offset (the
   * pillar takes the opposite one). He keeps to the side he came from, easing over while he
   * steps in from the east or west, so the two sprites never cross.
   */
  private summitOffset(state: GameState, moveT: number): number {
    const { player, map } = state;
    if (player.x !== map.summit.x || player.y !== map.summit.y) return 0;
    const side = player.fromX > map.summit.x ? 1 : -1;
    return Math.round(side * 4 * (player.fromX === map.summit.x ? 1 : moveT));
  }

  /** Brief brass beacon pinging out from a cache that has just come into sight (`age` in ms). */
  private drawCacheBeacon(cx: number, cy: number, age: number): void {
    if (!(age >= 0 && age < CACHE_BEACON_MS)) return;
    const period = CACHE_BEACON_MS / CACHE_BEACON_PULSES;
    const k = (age % period) / period;
    const pat = this.patterns.get(PALETTE.brass, Math.round(14 - k * 12));
    if (!pat) return;
    this.ctx.fillStyle = pat;
    const r = 7 + k * 16;
    fillRing(this.ctx, cx, cy, r - 1.5, r + 0.5);
  }

  /** Flat, crisp contact shadow (two rows) under a sprite standing at (cx, y). */
  private drawGroundShadow(cx: number, y: number, half: number): void {
    const ctx = this.ctx;
    const x = Math.round(cx - half);
    const yy = Math.round(y);
    ctx.fillStyle = 'rgba(58,46,43,0.26)';
    ctx.fillRect(x + 1, yy, half * 2 - 2, 1);
    ctx.fillRect(x + 2, yy + 1, half * 2 - 4, 1);
  }

  /**
   * Ancient Trig Pillar standing in its red trig-station triangle (centred on cx, the pillar
   * shifted by `shift`), with a periodic glint. With `beacon` (the pillar has been sighted) a
   * slow dithered ring pings around the station so the objective can be picked out on the
   * full sheet.
   */
  private drawTrigPillar(cx: number, shift: number, baseY: number, now: number, beacon: boolean): void {
    const ctx = this.ctx;
    const pillar = this.sprites.pillar;
    const station = this.sprites.trigStation;
    if (beacon) {
      const k = (now % TRIG_BEACON_MS) / TRIG_BEACON_MS;
      const pat = k < 0.5 ? this.patterns.get(PALETTE.redInk, Math.round(7 - k * 10)) : null;
      if (pat) {
        ctx.fillStyle = pat;
        const r = 12 + k * 22;
        fillRing(ctx, cx, baseY - 8, r - 1, r + 0.5);
      }
    }
    // Station triangle behind the pillar: apex 5 px above the cap, base 2 px above the tile's
    // bottom row so a surveyor standing on the tile below (hat and halo) never overlaps it.
    ctx.drawImage(station.canvas, cx - Math.floor(station.w / 2), baseY - station.h);
    this.drawGroundShadow(cx + shift + 1, baseY, 5);
    const left = cx + shift - 4;
    const top = baseY - pillar.h + 1;
    ctx.drawImage(pillar.canvas, left, top);

    const cycle = (now % 2800) / 2800;
    if (cycle < 0.16) {
      // Glint sweeping up the lit edge of the shaft.
      const k = cycle / 0.16;
      const gy = Math.round(top + 10 - k * 8);
      ctx.fillStyle = '#fffdf6';
      ctx.fillRect(left + 2, gy, 1, 2);
    } else if (cycle < 0.26) {
      const k = (cycle - 0.16) / 0.1;
      const arm = k < 0.5 ? 2 : 1;
      const sx = left + 1;
      const sy = top + 1;
      ctx.fillStyle = PALETTE.brassLight;
      ctx.fillRect(sx - arm, sy, arm * 2 + 1, 1);
      ctx.fillRect(sx, sy - arm, 1, arm * 2 + 1);
      ctx.fillStyle = '#fffdf6';
      ctx.fillRect(sx, sy, 1, 1);
    }
  }

  private drawPlayer(state: GameState, pos: { x: number; y: number; t: number }, now: number): void {
    const ctx = this.ctx;
    const phase = state.phase;
    const surveyor = this.sprites.surveyor;
    const x = pos.x + this.summitOffset(state, pos.t);

    if (phase === 'collapsing' || phase === 'gameover') {
      // Swallowed by the ink while it spreads; on the report the fallen surveyor marks where it ended.
      if (phase === 'collapsing' && clamp01((now - state.phaseStart) / COLLAPSE_ANIM_MS) >= FALLEN_GONE_AT) return;
      const f = surveyor.fallen;
      this.drawGroundShadow(x, pos.y + 5, 7);
      // Halo sprites: the art sits 1 px inside the canvas.
      ctx.drawImage(f.canvas, x - Math.floor(f.w / 2), pos.y + 7 - f.h);
      ctx.drawImage(surveyor.fallenHat.canvas, x + 6, pos.y - 2);
      return;
    }

    // Once on the summit (the step tween done) the surveyor turns to face the viewer.
    const celebrating = (phase === 'summiting' || phase === 'victory') && pos.t >= 1;
    const facing = celebrating ? 'down' : state.player.facing;
    const moving = pos.t > 0 && pos.t < 1;
    const frameIdx = moving && pos.t >= 0.25 && pos.t < 0.75 ? 1 : 0;
    const sprite = surveyor.frames[facing][frameIdx];
    const tileLeft = x - TILE / 2;
    const bob = frameIdx === 1 ? -1 : 0;
    this.drawGroundShadow(x, pos.y + 5, 5);
    // The feet stay on the tile's bottom row (the halo adds 1 px below the art).
    ctx.drawImage(sprite.canvas, tileLeft + surveyor.offsetX[facing], pos.y + 7 - sprite.h + bob);
  }

  /**
   * "You are here": a red-ink ring pinging outward around the surveyor for the first seconds
   * of an expedition and whenever the player has been idle for a while. It is drawn beneath
   * the map objects, so it never covers a cache or the pillar next to him.
   */
  private drawYouAreHere(state: GameState, x: number, y: number, now: number): void {
    if (state.phase !== 'playing') return;
    const player = state.player;
    const idle = now - Math.max(player.moveStart, player.bumpStart);
    if (now - state.startTime >= YOU_ARE_HERE_START_MS && idle < YOU_ARE_HERE_IDLE_MS) return;
    const step = Math.floor(now / YOU_ARE_HERE_STEP_MS) % 4;
    const pat = this.patterns.get(PALETTE.redInk, 12 - step * 2);
    if (!pat) return;
    this.ctx.fillStyle = pat;
    const r = 9 + step;
    fillRing(this.ctx, x, y - 1, r - 1, r + 0.5);
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  /**
   * One pass of the effects: 'ground' (the summit flare) goes beneath the objects and the
   * surveyor, 'label' (float texts) over the objects but beneath the surveyor, 'air' on top.
   */
  private drawEffects(state: GameState, now: number, layer: EffectLayer): void {
    for (const e of state.effects) {
      if (effectLayer(e.kind) !== layer) continue;
      const age = now - e.start;
      if (age < 0 || age >= e.duration || e.duration <= 0) continue;
      const t = age / e.duration;
      switch (e.kind) {
        case 'float-text': {
          // A sighting on a panoramic step waits for its ground to appear, then plays out in the time left.
          const tile = tileIndex(clamp(Math.floor(e.x), 0, MAP_W - 1), clamp(Math.floor(e.y), 0, MAP_H - 1));
          const wait = clamp(this.compositor.revealTime(tile) - e.start, 0, e.duration / 2);
          if (age >= wait) this.drawFloatText(e, (age - wait) / (e.duration - wait));
          break;
        }
        case 'survey-burst':
          this.drawSurveyBurst(e, t);
          break;
        case 'cache-sparkle':
          this.drawCacheSparkle(e, t);
          break;
        case 'summit-flare':
          this.drawSummitFlare(e, t, now);
          break;
      }
    }
  }

  private drawFloatText(e: Effect, t: number): void {
    if (!e.text) return;
    const ctx = this.ctx;
    const w = measureText(e.text);
    const cx = clamp(Math.round(MX0 + (e.x + 0.5) * TILE), MX0 + w / 2 + 3, MX1 - w / 2 - 3);
    const rise = Math.round(easeOutCubic(t) * 18);
    const y = Math.max(MY0 + 3, Math.round(MY0 + e.y * TILE - 12 - rise));
    const alpha = t < 0.55 ? 1 : Math.ceil((1 - (t - 0.55) / 0.45) * 4) / 4;
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    // A parchment plate with a pale rule knocks the contours out, like the baked map labels.
    const left = Math.round(cx - w / 2) - 2;
    ctx.fillStyle = PALETTE.parchment;
    ctx.fillRect(left, y - 2, w + 4, GLYPH_H + 4);
    ctx.fillStyle = PALETTE.inkPale;
    ctx.fillRect(left + 1, y + GLYPH_H + 2, w + 2, 1);
    drawOutlinedText(ctx, e.text, cx, y, e.color ?? PALETTE.ink, PALETTE.parchment, 'center');
    ctx.globalAlpha = 1;
  }

  /** Expanding dashed survey ring with bearing ticks and a fainter echo. */
  private drawSurveyBurst(e: Effect, t: number): void {
    const ctx = this.ctx;
    const cx = Math.round(MX0 + (e.x + 0.5) * TILE);
    const cy = Math.round(MY0 + (e.y + 0.5) * TILE);
    const rMax = ((e.radius ?? 10) + 0.5) * TILE;
    const r = Math.max(2, easeOutCubic(t) * rMax);
    const dissolve = t > 0.5 ? (t - 0.5) * 2 : 0;
    const color = e.color ?? PALETTE.brass;
    const seed = Math.floor(e.start);
    const ring = (radius: number, dash: number, on: number, fill: string, thick: number, fade: number): void => {
      const steps = Math.max(16, Math.round(Math.PI * 2 * radius));
      ctx.fillStyle = fill;
      for (let i = 0; i < steps; i++) {
        if (i % dash >= on) continue;
        if (hash2(i, seed, 0xb1) < fade) continue;
        const a = (i / steps) * Math.PI * 2;
        ctx.fillRect(Math.round(cx + Math.cos(a) * radius), Math.round(cy + Math.sin(a) * radius), thick, thick);
      }
    };
    ring(r, 8, 5, color, 2, dissolve);
    ring(r * 0.72, 6, 2, PALETTE.inkSoft, 1, Math.min(1, dissolve + 0.2));
    // Bearing ticks every 45 degrees.
    ctx.fillStyle = PALETTE.ink;
    if (dissolve < 0.8) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const len = k % 2 === 0 ? 6 : 3;
        plotLine(
          cx + Math.cos(a) * (r - len),
          cy + Math.sin(a) * (r - len),
          cx + Math.cos(a) * (r + 1),
          cy + Math.sin(a) * (r + 1),
          (x, y) => ctx.fillRect(x, y, 1, 1),
        );
      }
    }
  }

  private drawCacheSparkle(e: Effect, t: number): void {
    const ctx = this.ctx;
    const cx = MX0 + (e.x + 0.5) * TILE;
    const cy = MY0 + (e.y + 0.5) * TILE;
    const seed = Math.floor(e.start);
    const glint = e.color ?? PALETTE.brassLight;
    // Brass arms with dark end caps read on pale parchment; the early glints are the largest.
    const peak = t < 0.3 ? 4 : 3;
    for (let i = 0; i < 8; i++) {
      const delay = hash2(i, seed, 0x51) * 0.4;
      const q = (t - delay) / 0.6;
      if (q <= 0 || q >= 1) continue;
      const ang = hash2(i, seed, 0x52) * Math.PI * 2;
      const dist = 3 + hash2(i, seed, 0x53) * 10 + q * 4;
      const x = Math.round(cx + Math.cos(ang) * dist);
      const y = Math.round(cy + Math.sin(ang) * dist - q * 7);
      const size = Math.round(peak * (q < 0.4 ? q / 0.4 : (1 - q) / 0.6));
      if (size >= 1) {
        ctx.fillStyle = PALETTE.brass;
        ctx.fillRect(x - size, y, size * 2 + 1, 1);
        ctx.fillRect(x, y - size, 1, size * 2 + 1);
        ctx.fillStyle = PALETTE.brassDark;
        ctx.fillRect(x - size, y, 1, 1);
        ctx.fillRect(x + size, y, 1, 1);
        ctx.fillRect(x, y - size, 1, 1);
        ctx.fillRect(x, y + size, 1, 1);
      }
      ctx.fillStyle = glint;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  /** Star-burst of spikes radiating from the pillar top. */
  private drawSummitFlare(e: Effect, t: number, now: number): void {
    const ctx = this.ctx;
    const cx = Math.round(MX0 + (e.x + 0.5) * TILE);
    const cy = Math.round(MY0 + e.y * TILE - 2);
    const env = Math.sin(Math.PI * clamp01(t));
    const spin = now / 2600;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + spin;
      const major = k % 2 === 0;
      // Spikes start outside the pillar and surveyor sprites (they are drawn beneath both).
      const r0 = major ? 16 : 14;
      const r1 = r0 + (major ? 10 + 46 * env : 5 + 22 * env);
      const color = major ? PALETTE.brassLight : PALETTE.redInkBright;
      const len = r1 - r0;
      ctx.fillStyle = color;
      plotLine(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, (x, y, i) => {
        // Outer third breaks up into dots (dithered fade toward the tip).
        if (i > len * 0.66 && i % 2 === 1) return;
        ctx.fillRect(x, y, 1, 1);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Phase animations
  // -------------------------------------------------------------------------

  /** Summit radiance painted beneath the pillar and the surveyor so both stay crisp. */
  private drawPhaseUnder(state: GameState, now: number): void {
    const phase = state.phase;
    if (phase !== 'summiting' && phase !== 'victory') return;
    const { x: cx, y: cy } = summitGlowCentre(state.map);
    const light = '#fffbef';
    const R =
      phase === 'summiting'
        ? 10 + 40 * easeOutCubic(clamp01((now - state.phaseStart) / VICTORY_ANIM_MS))
        : 42 + Math.round(Math.sin(now / 520) * 2);
    // Dithered outer glow around a solid core, so the pillar and surveyor stand on clean light.
    const levels: [number, number][] = [
      [1, 3],
      [0.74, 6],
      [0.52, 9],
      [0.38, 12],
    ];
    for (const [f, lv] of levels) {
      const pat = this.patterns.get(light, lv);
      if (!pat) continue;
      this.ctx.fillStyle = pat;
      fillDisc(this.ctx, cx, cy, R * f);
    }
    this.ctx.fillStyle = light;
    fillDisc(this.ctx, cx, cy, R * 0.28);
  }

  private drawPhaseOver(state: GameState, pos: { x: number; y: number }, now: number): void {
    const phase = state.phase;
    if (phase === 'collapsing' || phase === 'gameover') {
      const p = phase === 'gameover' ? 1 : clamp01((now - state.phaseStart) / COLLAPSE_ANIM_MS);
      const key = `${state.map.seed}:${state.player.x}:${state.player.y}`;
      if (!this.ink || this.ink.key !== key) this.ink = new InkBleed(state.map, state.player.x, state.player.y);
      this.ink.advance(p);
      // The spill lifts off in steps once the report is up, so the ground it covered can be read.
      const lift = phase === 'gameover' ? 1 - clamp01((now - state.phaseStart) / REPORT_CLEAR_MS) : 1;
      if (lift > 0) {
        this.ctx.globalAlpha = Math.ceil(lift * 4) / 4;
        this.ctx.drawImage(this.ink.surface.canvas, MX0, MY0);
        this.ctx.globalAlpha = 1;
      }
      if (phase === 'collapsing' && p < FALLEN_GONE_AT) {
        // The fallen surveyor stays readable on top of the fresh ink, then fades in steps.
        const fade = (FALLEN_GONE_AT - p) / (FALLEN_GONE_AT - FALLEN_SOLID_UNTIL);
        this.ctx.globalAlpha = p < FALLEN_SOLID_UNTIL ? 1 : Math.ceil(fade * 3) / 3;
        this.drawPlayer(state, { ...pos, t: 1 }, now);
        this.ctx.globalAlpha = 1;
      }
      return;
    }
    this.ink = null;
    if (phase === 'summiting') {
      const p = clamp01((now - state.phaseStart) / VICTORY_ANIM_MS);
      const { x: cx, y: cy } = summitGlowCentre(state.map);
      this.drawSummitRings(cx, cy, p);
      this.drawRays(cx, cy, 20 + 250 * easeOutCubic(p), now / 5200, 1);
    } else if (phase === 'victory') {
      const { x: cx, y: cy } = summitGlowCentre(state.map);
      this.drawRays(cx, cy, 150, now / 9000, 2);
    }
  }

  /** Expanding red-ink survey rings (dithered, thinning as they travel). */
  private drawSummitRings(cx: number, cy: number, p: number): void {
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const k = p * 1.5 - i * 0.22;
      if (k <= 0 || k >= 1) continue;
      const r = 12 + k * 270;
      const pat = this.patterns.get(PALETTE.redInk, Math.round(12 * (1 - k)) + 3);
      if (!pat) continue;
      ctx.fillStyle = pat;
      fillRing(ctx, cx, cy, r - 1.5, r + 1.5);
    }
  }

  /** Radiating brass rays: bold near the summit, dissolving (dithered) toward their tips. */
  private drawRays(cx: number, cy: number, len: number, spin: number, dotEvery: number): void {
    const ctx = this.ctx;
    const r0 = 18;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + spin;
      const major = k % 2 === 0;
      const L = major ? len : len * 0.62;
      const span = Math.max(1, L - r0);
      let current = '';
      plotLine(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * L, cy + Math.sin(a) * L, (x, y, i) => {
        const f = i / span;
        if (i % dotEvery !== 0) return;
        if (f > 0.3 && hash2(i, k, 0x7a) < ((f - 0.3) / 0.7) * 0.95) return;
        const color = f < 0.25 ? PALETTE.brassLight : PALETTE.brass;
        if (color !== current) {
          ctx.fillStyle = color;
          current = color;
        }
        const size = major && f < 0.35 ? 2 : 1;
        ctx.fillRect(x, y, size, size);
      });
    }
  }

  /** The sheet darkens (stepped multiply tint) while the ink spreads, and clears for the report. */
  private drawSheetDim(state: GameState, now: number): void {
    const phase = state.phase;
    if (phase !== 'collapsing' && phase !== 'gameover') return;
    const since = now - state.phaseStart;
    const p = phase === 'gameover' ? 1 - clamp01(since / REPORT_CLEAR_MS) : clamp01(since / COLLAPSE_ANIM_MS);
    const level = Math.round(p * DIM_STEPS.length - 0.5);
    if (level <= 0) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = DIM_STEPS[Math.min(DIM_STEPS.length - 1, level)];
    ctx.fillRect(SHEET_X, SHEET_Y, SHEET_W, SHEET_H);
    ctx.globalCompositeOperation = 'source-over';
  }
}

/** Centre of the summit radiance (just above the pillar base). */
function summitGlowCentre(map: MapData): Point {
  return {
    x: Math.round(MX0 + (map.summit.x + 0.5) * TILE),
    y: Math.round(MY0 + (map.summit.y + 0.5) * TILE) - 4,
  };
}
