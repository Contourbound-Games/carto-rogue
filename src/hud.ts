// Retro brass-instrument HUD for the right-hand panel, plus the full-screen title and
// end-of-expedition cards. Pixel art only: integer fillRects, ordered (Bayer) dithering
// instead of gradients, scanline discs / midpoint circles / Bresenham lines instead of
// anti-aliased paths. Static parts are rasterised once into offscreen layers; gauges,
// lamps, the compass needle and all live values are drawn every frame.
import {
  CACHE_RESTORE,
  CONTOUR_INTERVAL,
  COST_FLAT,
  COST_GENTLE,
  COST_STEEP,
  HUD_H,
  HUD_W,
  HUD_X,
  HUD_Y,
  INDEX_CONTOUR_EVERY,
  LOW_STAMINA,
  MAP_H,
  MAP_ORIGIN_X,
  MAP_ORIGIN_Y,
  MAP_PX_H,
  MAP_PX_W,
  MAP_W,
  MAX_ELEV_M,
  MAX_STAMINA,
  PALETTE,
  TILE,
  VIRTUAL_HEIGHT,
  VIRTUAL_WIDTH,
  VISION_HIGH,
  VISION_HIGH_MIN,
  VISION_LOW,
  VISION_MID,
  VISION_MID_MIN,
  WATER_LEVEL,
} from './config';
import { judgeContract } from './contract-conditions';
import type { ContractCondition, ContractEvaluation } from './contract-conditions';
import { CONTRACT_ROWS } from './contract-menu';
import type { ContractId } from './contracts';
import { EDITION } from './edition';
import { drawHangulTitle, drawText, fitText, fontEpoch, measureText } from './font';
import type { TextOptions } from './font';
import { contractText, getLang, langVersion, t } from './i18n';
import type { ContractTextKey, MessageKey } from './i18n';
import { gradeRank } from './records';
import { mulberry32 } from './rng';
import { SIGHT_EYE_ART } from './sprites';
import { GRADE_THRESHOLDS, GRADE_WEIGHTS, RESERVE_FULL_MARKS, SURVEY_FULL_MARKS, gradePoints } from './game';
import { addButton, clearButtons, reportFor, TOAST_MS, ui } from './ui';
import type { ButtonId } from './ui';
import { provenSolvable } from './map';
import { describeStepBetween, tallySteps, tileIndex, toMeters } from './terrain';
import type { StepKind } from './terrain';
import { DIR_LIST, DIRS } from './types';
import type { Dir, ExpeditionStats, GameState, GradeBreakdown, LogTone, MapData, Point, SlopeClass } from './types';

type Ctx = CanvasRenderingContext2D;
type Pt = readonly [number, number];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Colours beyond the shared palette, tuned to sit with the brass and parchment tones.
// ---------------------------------------------------------------------------
const FACE = '#1c1511';
const FACE_SHADOW = '#110c09';
const FACE_GRAIN = '#261c16';
const LEATHER_LIGHT = '#47362b';
const STITCH = '#5f4a33';
const DIM_TEXT = '#7a6650';
const AMBER = '#dc9a34';
const AMBER_HI = '#f6cf7a';
const AMBER_DIM = '#4b3517';
const AMBER_INK = '#a0661a';
const GREEN_LIT = '#a7bd68';
const GREEN_HI = '#d6e3a0';
const GREEN_SHADE = '#6f803d';
const GREEN_DIM = '#2e3520';
const RED_LIT = '#e0563c';
const RED_HI = '#f39a7e';
const RED_SHADE = '#8f2a1c';
const RED_DIM = '#3d1913';
const GLASS_HI = '#fff6dc';
/** Pale red-ink hatch behind a step that would collapse the surveyor. */
const LETHAL_HATCH = '#e8c3ae';
const VEIL = '#0c0806';
const SHADOW = '#000000';

const hasDom = typeof document !== 'undefined';

// ---------------------------------------------------------------------------
// Pixel primitives
// ---------------------------------------------------------------------------

function fill(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function px(ctx: Ctx, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

function outline(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, t = 1): void {
  fill(ctx, x, y, w, t, color);
  fill(ctx, x, y + h - t, w, t, color);
  fill(ctx, x, y + t, t, h - 2 * t, color);
  fill(ctx, x + w - t, y + t, t, h - 2 * t, color);
}

/** 4x4 ordered-dither thresholds. A pixel is inked at level L (0..16) when BAYER4[i] < L. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function bayerOn(x: number, y: number, level: number): boolean {
  return BAYER4[(y & 3) * 4 + (x & 3)] < level;
}

const patternCache = new WeakMap<Ctx, Map<string, CanvasPattern | null>>();

function ditherPattern(ctx: Ctx, color: string, level: number): CanvasPattern | null {
  let byCtx = patternCache.get(ctx);
  if (!byCtx) {
    byCtx = new Map();
    patternCache.set(ctx, byCtx);
  }
  const key = `${color}|${level}`;
  const hit = byCtx.get(key);
  if (hit !== undefined) return hit;
  let pattern: CanvasPattern | null = null;
  if (hasDom) {
    const tile = document.createElement('canvas');
    tile.width = 4;
    tile.height = 4;
    const g = tile.getContext('2d');
    if (g) {
      g.fillStyle = color;
      for (let i = 0; i < 16; i++) if (BAYER4[i] < level) g.fillRect(i & 3, i >> 2, 1, 1);
      pattern = ctx.createPattern(tile, 'repeat');
    }
  }
  byCtx.set(key, pattern);
  return pattern;
}

/** Ordered-dither fill: `level` of 16 pixels in every 4x4 block take `color`. */
function dither(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, level: number): void {
  const lv = Math.max(0, Math.min(16, Math.round(level)));
  if (lv <= 0 || w <= 0 || h <= 0) return;
  if (lv >= 16) {
    fill(ctx, x, y, w, h, color);
    return;
  }
  const pattern = ditherPattern(ctx, color, lv);
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(x, y, w, h);
    return;
  }
  ctx.fillStyle = color;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) if (bayerOn(xx, yy, lv)) ctx.fillRect(xx, yy, 1, 1);
  }
}

/** Peak opacity of the darkening veil behind the full-screen cards (the end reports have none). */
const VEIL_OPACITY = 0.62;

/**
 * Darkening veil behind the title / end cards. `t` (0..1) is the card's fade-in progress,
 * quantised to 16 steps so the fade keeps a stepped retro feel. A flat translucent wash is
 * used rather than a 1 px dither screen: once the canvas is CSS-scaled to a non-integer
 * factor a pixel screen shimmers into moire, and the wash lets the surveyed sheet (ink
 * spill, summit afterglow) stay legible, dimmed, behind the card.
 */
function veil(ctx: Ctx, t: number, opacity = VEIL_OPACITY): void {
  const steps = Math.max(0, Math.min(16, Math.round(t * 16)));
  if (steps === 0) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * opacity * (steps / 16);
  fill(ctx, 0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT, VEIL);
  ctx.globalAlpha = prev;
}

/** Seeded single-pixel speckle (grain, paper tooth). */
function speckle(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, count: number, seed: number): void {
  const rnd = mulberry32(seed);
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.fillRect(x + Math.floor(rnd() * w), y + Math.floor(rnd() * h), 1, 1);
  }
}

/** Bresenham line; `mask` can skip pixels (dithered / dashed strokes). */
function line(
  ctx: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  mask?: (x: number, y: number) => boolean,
): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  ctx.fillStyle = color;
  for (;;) {
    if (!mask || mask(x, y)) ctx.fillRect(x, y, 1, 1);
    if (x === xe && y === ye) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Filled pixel disc centred on pixel (cx, cy), drawn as horizontal spans. */
function disc(ctx: Ctx, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  for (let dy = -r; dy <= r; dy++) {
    const half = Math.floor(Math.sqrt((r + 0.5) * (r + 0.5) - dy * dy));
    ctx.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
  }
}

/** Midpoint circle outline centred on pixel (cx, cy). */
function circle(ctx: Ctx, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  let x = r;
  let y = 0;
  let err = 1 - r;
  while (x >= y) {
    ctx.fillRect(cx + x, cy + y, 1, 1);
    ctx.fillRect(cx - x, cy + y, 1, 1);
    ctx.fillRect(cx + x, cy - y, 1, 1);
    ctx.fillRect(cx - x, cy - y, 1, 1);
    ctx.fillRect(cx + y, cy + x, 1, 1);
    ctx.fillRect(cx - y, cy + x, 1, 1);
    ctx.fillRect(cx + y, cy - x, 1, 1);
    ctx.fillRect(cx - y, cy - x, 1, 1);
    y++;
    if (err < 0) {
      err += 2 * y + 1;
    } else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
}

/** Scanline polygon fill sampling pixel centres (even-odd rule). */
function polygon(ctx: Ctx, pts: readonly Pt[], color: string, mask?: (x: number, y: number) => boolean): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  ctx.fillStyle = color;
  const xs: number[] = [];
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.ceil(xs[k] - 0.5);
      const x1 = Math.ceil(xs[k + 1] - 0.5) - 1;
      if (x1 < x0) continue;
      if (!mask) {
        ctx.fillRect(x0, y, x1 - x0 + 1, 1);
      } else {
        for (let x = x0; x <= x1; x++) if (mask(x, y)) ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

const checker = (x: number, y: number): boolean => ((x + y) & 1) === 0;

/** 3x3 domed brass rivet with its top-left at (x, y). */
function rivet(ctx: Ctx, x: number, y: number): void {
  fill(ctx, x, y, 3, 3, PALETTE.brass);
  fill(ctx, x, y, 2, 1, PALETTE.brassLight);
  px(ctx, x, y + 1, PALETTE.brassLight);
  px(ctx, x + 2, y + 1, PALETTE.brassDark);
  fill(ctx, x + 1, y + 2, 2, 1, PALETTE.brassDark);
  px(ctx, x + 2, y + 2, PALETTE.brassShadow);
}

/** Small diamond ornament centred on pixel (cx, cy). */
function diamond(ctx: Ctx, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  for (let dy = -r; dy <= r; dy++) {
    const half = r - Math.abs(dy);
    ctx.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
  }
}

/** Draw consecutive text runs of different colours; returns the x after the last run. */
function drawRuns(ctx: Ctx, x: number, y: number, runs: readonly [string, string][], scale = 1): number {
  let cx = x;
  for (const [text, color] of runs) {
    drawText(ctx, text, cx, y, { color, scale });
    // Measured width plus the trailing spacing column (Hangul advances differ from the 5x7 cell).
    cx += text.length > 0 ? measureText(text, scale) + scale : 0;
  }
  return cx;
}

/** The 8 neighbours of a pixel: offsets for a 1 px knockout halo around glyphs. */
const KNOCKOUT: readonly Pt[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** Text with a 1 px `halo`-coloured knockout, so it stays legible over lines and hatching. */
function knockoutText(ctx: Ctx, text: string, x: number, y: number, opts: TextOptions, halo: string): void {
  for (const [ox, oy] of KNOCKOUT) drawText(ctx, text, x + ox, y + oy, { ...opts, color: halo, shadow: undefined });
  drawText(ctx, text, x, y, opts);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; g: Ctx } | null {
  if (!hasDom) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingEnabled = false;
  return { canvas, g };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function formatPercent(p: number): string {
  return `${(Math.round(Math.max(0, Math.min(100, p)) * 10) / 10).toFixed(1)}%`;
}

function elapsedMs(state: GameState, now: number): number {
  if (state.phase === 'title' || state.startTime <= 0) return 0;
  return Math.max(0, (state.endTime ?? state.pausedAt ?? now) - state.startTime);
}

function cachesCollected(state: GameState): number {
  let n = 0;
  for (const c of state.cacheCollected) if (c) n++;
  return n;
}

function playerElevation(state: GameState): number {
  const { x, y } = state.player;
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return 0;
  return state.map.elevation[tileIndex(x, y)] ?? 0;
}

function costColorOnPaper(cost: number): string {
  if (cost <= COST_FLAT) return PALETTE.green;
  if (cost <= COST_GENTLE) return AMBER_INK;
  return PALETTE.redInk;
}

function costColorLit(cost: number): string {
  if (cost <= COST_FLAT) return GREEN_LIT;
  if (cost <= COST_GENTLE) return AMBER;
  return RED_LIT;
}

function stepWord(kind: StepKind): string {
  const key: Record<StepKind, MessageKey> = {
    flat: 'slopeFlat',
    downhill: 'slopeDownhill',
    gentle: 'slopeGentle',
    steep: 'slopeSteep',
    cliff: 'slopeCliff',
  };
  return t(key[kind]);
}

/** How the last step reads: its slope class, or downhill for a cost-1 step that dropped beyond the flat band. */
export function lastStepKind(state: GameState, slope: SlopeClass): StepKind {
  if (slope !== 'flat') return slope;
  const p = state.player;
  return describeStepBetween(state.map, { x: p.fromX, y: p.fromY }, p);
}

function toneColorOnPaper(tone: LogTone): string {
  switch (tone) {
    case 'info':
      return PALETTE.ink;
    case 'good':
      return PALETTE.green;
    case 'warn':
      return AMBER_INK;
    case 'bad':
      return PALETTE.redInk;
  }
}

// ---------------------------------------------------------------------------
// HUD layout (absolute virtual px). Sections are stacked top to bottom with even gaps.
// ---------------------------------------------------------------------------

const CX = HUD_X + 11;
const CW = HUD_W - 22;

const SECTION_ORDER = ['cart', 'alti', 'slope', 'stamina', 'mid', 'survey', 'stats', 'log', 'footer'] as const;
type SectionName = (typeof SECTION_ORDER)[number];

const SECTION_H: Record<SectionName, number> = {
  cart: 78,
  alti: 118,
  slope: 30,
  stamina: 58,
  mid: 134,
  survey: 32,
  stats: 66,
  log: 92,
  footer: 40,
};

const SECTIONS: Record<SectionName, Box> = (() => {
  const top = HUD_Y + 12;
  const bottom = HUD_Y + HUD_H - 12;
  let total = 0;
  for (const k of SECTION_ORDER) total += SECTION_H[k];
  const gap = Math.floor((bottom - top - total) / (SECTION_ORDER.length - 1));
  const out = {} as Record<SectionName, Box>;
  let y = top;
  for (const k of SECTION_ORDER) {
    out[k] = { x: CX, y, w: CW, h: SECTION_H[k] };
    y += SECTION_H[k] + gap;
  }
  return out;
})();

const MID_W = Math.floor((CW - 8) / 2);
const STEP_BOX: Box = { x: CX, y: SECTIONS.mid.y, w: MID_W, h: SECTIONS.mid.h };
const COMPASS_BOX: Box = { x: CX + CW - MID_W, y: SECTIONS.mid.y, w: MID_W, h: SECTIONS.mid.h };

/** Interior (inside the 3 px brass plate frame). */
function inner(b: Box): Box {
  return { x: b.x + 3, y: b.y + 3, w: b.w - 6, h: b.h - 6 };
}

// Altimeter geometry
const DRUM_COUNT = 4;
const DRUM_SCALE = 4;
const DRUM_WIN_W = 5 * DRUM_SCALE + 2;
const DRUM_WIN_H = 7 * DRUM_SCALE + 4;
const DRUM_SEP = 2;
const DRUM_BEZEL = 3;
const DRUM_X = SECTIONS.alti.x + 9;
const DRUM_Y = SECTIONS.alti.y + 20;
const DRUM_W = DRUM_BEZEL * 2 + DRUM_COUNT * DRUM_WIN_W + (DRUM_COUNT - 1) * DRUM_SEP;
const DRUM_H = DRUM_BEZEL * 2 + DRUM_WIN_H;
const TUBE_X = SECTIONS.alti.x + SECTIONS.alti.w - 50;
const TUBE_TOP = SECTIONS.alti.y + 11;
const TUBE_BOTTOM = SECTIONS.alti.y + SECTIONS.alti.h - 12;
const TUBE_W = 8;

function tubeY(meters: number): number {
  const innerTop = TUBE_TOP + 1;
  const innerBottom = TUBE_BOTTOM - 1;
  return innerBottom - Math.round((Math.max(0, Math.min(MAX_ELEV_M, meters)) / MAX_ELEV_M) * (innerBottom - innerTop));
}

// Stamina bar geometry
const BAR_SEGMENTS = 20;
const BAR_SEG_W = 9;
const BAR_CAP = 7;
const BAR_W = BAR_CAP * 2 + BAR_SEGMENTS * BAR_SEG_W + (BAR_SEGMENTS - 1);
const BAR_H = 16;
const BAR_X = SECTIONS.stamina.x + Math.floor((SECTIONS.stamina.w - BAR_W) / 2);
const BAR_Y = SECTIONS.stamina.y + 21;

// Step-cost card geometry
const CELL = 30;
const CELL_GAP = 3;
const STEP_CX = STEP_BOX.x + Math.floor(STEP_BOX.w / 2);
const STEP_CY = STEP_BOX.y + 24 + CELL + CELL_GAP + Math.floor(CELL / 2);

function cellOrigin(dir: Dir | 'centre'): Pt {
  const half = Math.floor(CELL / 2);
  const step = CELL + CELL_GAP;
  const ox = STEP_CX - half;
  const oy = STEP_CY - half;
  switch (dir) {
    case 'up':
      return [ox, oy - step];
    case 'down':
      return [ox, oy + step];
    case 'left':
      return [ox - step, oy];
    case 'right':
      return [ox + step, oy];
    case 'centre':
      return [ox, oy];
  }
}

const ARROW: Record<Dir, string> = { up: '↑', right: '→', down: '↓', left: '←' };

// Compass geometry
const COMPASS_R = 45;
const COMPASS_CX = COMPASS_BOX.x + Math.floor(COMPASS_BOX.w / 2);
const COMPASS_CY = COMPASS_BOX.y + 21 + COMPASS_R;
const COMPASS_FACE_R = COMPASS_R - 7;

// ---------------------------------------------------------------------------
// Static HUD layer
// ---------------------------------------------------------------------------

/** Brass-framed plate with a dark enamel or parchment face. */
function plate(ctx: Ctx, b: Box, face: 'dark' | 'paper', rivets = false, seed = 1): void {
  const { x, y, w, h } = b;
  fill(ctx, x, y, w, h, PALETTE.brassShadow);
  fill(ctx, x + 1, y + 1, w - 2, h - 2, PALETTE.brass);
  fill(ctx, x + 1, y + 1, w - 2, 1, PALETTE.brassLight);
  fill(ctx, x + 1, y + 1, 1, h - 2, PALETTE.brassLight);
  fill(ctx, x + 2, y + h - 2, w - 3, 1, PALETTE.brassDark);
  fill(ctx, x + w - 2, y + 2, 1, h - 3, PALETTE.brassDark);
  const i = inner(b);
  if (face === 'dark') {
    fill(ctx, i.x, i.y, i.w, i.h, FACE);
    speckle(ctx, i.x, i.y, i.w, i.h, FACE_GRAIN, Math.floor((i.w * i.h) / 14), seed);
    fill(ctx, i.x, i.y, i.w, 1, FACE_SHADOW);
    fill(ctx, i.x, i.y, 1, i.h, FACE_SHADOW);
  } else {
    fill(ctx, i.x, i.y, i.w, i.h, PALETTE.parchment);
    speckle(ctx, i.x, i.y, i.w, i.h, PALETTE.parchmentDark, Math.floor((i.w * i.h) / 7), seed);
    dither(ctx, i.x, i.y + i.h - 3, i.w, 3, PALETTE.parchmentDark, 6);
    fill(ctx, i.x, i.y, i.w, 1, PALETTE.parchmentShade);
    fill(ctx, i.x, i.y, 1, i.h, PALETTE.parchmentShade);
  }
  if (rivets) {
    rivet(ctx, x, y);
    rivet(ctx, x + w - 3, y);
    rivet(ctx, x, y + h - 3);
    rivet(ctx, x + w - 3, y + h - 3);
  }
}

function label(ctx: Ctx, text: string, x: number, y: number, align: 'left' | 'center' | 'right' = 'left'): void {
  drawText(ctx, text, x, y, { color: PALETTE.brass, align });
}

function drawPanelFrame(ctx: Ctx): void {
  const x = HUD_X;
  const y = HUD_Y;
  const w = HUD_W;
  const h = HUD_H;
  fill(ctx, x, y, w, h, PALETTE.brassShadow);
  fill(ctx, x + 1, y + 1, w - 2, h - 2, PALETTE.brass);
  fill(ctx, x + 1, y + 1, w - 2, 1, PALETTE.brassLight);
  fill(ctx, x + 1, y + 1, 1, h - 2, PALETTE.brassLight);
  fill(ctx, x + 2, y + h - 2, w - 3, 1, PALETTE.brassDark);
  fill(ctx, x + w - 2, y + 2, 1, h - 3, PALETTE.brassDark);
  fill(ctx, x + 5, y + 5, w - 10, h - 10, PALETTE.brassShadow);
  // Leather inlay with grain and a soft dithered vignette toward the frame.
  const lx = x + 6;
  const ly = y + 6;
  const lw = w - 12;
  const lh = h - 12;
  fill(ctx, lx, ly, lw, lh, PALETTE.deskLight);
  speckle(ctx, lx, ly, lw, lh, PALETTE.desk, 3200, 11);
  speckle(ctx, lx, ly, lw, lh, LEATHER_LIGHT, 1100, 12);
  dither(ctx, lx, ly, lw, 2, PALETTE.desk, 10);
  dither(ctx, lx, ly + lh - 2, lw, 2, PALETTE.desk, 10);
  dither(ctx, lx, ly, 2, lh, PALETTE.desk, 10);
  dither(ctx, lx + lw - 2, ly, 2, lh, PALETTE.desk, 10);
  // Saddle stitching just inside the frame.
  const sx0 = lx + 2;
  const sy0 = ly + 2;
  const sx1 = lx + lw - 3;
  const sy1 = ly + lh - 3;
  for (let xx = sx0 + 1; xx < sx1; xx += 4) {
    fill(ctx, xx, sy0, 2, 1, STITCH);
    fill(ctx, xx, sy1, 2, 1, STITCH);
  }
  for (let yy = sy0 + 1; yy < sy1; yy += 4) {
    fill(ctx, sx0, yy, 1, 2, STITCH);
    fill(ctx, sx1, yy, 1, 2, STITCH);
  }
  // Rivets on the frame band.
  rivet(ctx, x + 2, y + 2);
  rivet(ctx, x + w - 5, y + 2);
  rivet(ctx, x + 2, y + h - 5);
  rivet(ctx, x + w - 5, y + h - 5);
  for (let ry = y + 94; ry < y + h - 60; ry += 94) {
    rivet(ctx, x + 2, ry);
    rivet(ctx, x + w - 5, ry);
  }
  rivet(ctx, x + Math.floor(w / 2) - 1, y + 2);
  rivet(ctx, x + Math.floor(w / 2) - 1, y + h - 5);
}

function drawCartouche(ctx: Ctx): void {
  const b = SECTIONS.cart;
  const { x, y, w, h } = b;
  // Ornamental brass border: bevelled band with an engraved groove.
  fill(ctx, x, y, w, h, PALETTE.brassShadow);
  fill(ctx, x + 1, y + 1, w - 2, h - 2, PALETTE.brass);
  fill(ctx, x + 1, y + 1, w - 2, 1, PALETTE.brassLight);
  fill(ctx, x + 1, y + 1, 1, h - 2, PALETTE.brassLight);
  fill(ctx, x + 2, y + h - 2, w - 3, 1, PALETTE.brassDark);
  fill(ctx, x + w - 2, y + 2, 1, h - 3, PALETTE.brassDark);
  outline(ctx, x + 3, y + 3, w - 6, h - 6, PALETTE.brassDark);
  fill(ctx, x + 4, y + 4, w - 8, 1, PALETTE.brassLight);
  // Dotted engraving along the band.
  for (let xx = x + 12; xx < x + w - 12; xx += 4) {
    px(ctx, xx, y + 2, PALETTE.brassDark);
    px(ctx, xx, y + h - 3, PALETTE.brassDark);
  }
  fill(ctx, x + 5, y + 5, w - 10, h - 10, PALETTE.brassShadow);
  const ix = x + 6;
  const iy = y + 6;
  const iw = w - 12;
  const ih = h - 12;
  fill(ctx, ix, iy, iw, ih, PALETTE.parchment);
  speckle(ctx, ix, iy, iw, ih, PALETTE.parchmentDark, Math.floor((iw * ih) / 6), 21);
  dither(ctx, ix, iy, iw, 2, PALETTE.parchmentShade, 8);
  dither(ctx, ix, iy + ih - 2, iw, 2, PALETTE.parchmentShade, 8);
  dither(ctx, ix, iy, 2, ih, PALETTE.parchmentShade, 8);
  dither(ctx, ix + iw - 2, iy, 2, ih, PALETTE.parchmentShade, 8);
  // Contour-line flourishes in two corners (clipped to the parchment).
  ctx.save();
  ctx.beginPath();
  ctx.rect(ix + 3, iy + 3, iw - 6, ih - 6);
  ctx.clip();
  for (const r of [5, 9, 13]) {
    circle(ctx, ix + 3, iy + ih - 4, r, PALETTE.parchmentShade);
    circle(ctx, ix + iw - 4, iy + 3, r, PALETTE.parchmentShade);
  }
  ctx.restore();
  outline(ctx, ix + 3, iy + 3, iw - 6, ih - 6, PALETTE.inkPale);
  // Corner blocks of the neatline.
  for (const [cx, cy] of [
    [ix + 2, iy + 2],
    [ix + iw - 5, iy + 2],
    [ix + 2, iy + ih - 5],
    [ix + iw - 5, iy + ih - 5],
  ] as const) {
    fill(ctx, cx, cy, 3, 3, PALETTE.inkSoft);
  }
  const mid = x + Math.floor(w / 2);
  drawText(ctx, 'THE CARTO-ROGUE', mid, y + 14, {
    scale: 2,
    color: PALETTE.ink,
    align: 'center',
    shadow: PALETTE.parchmentShade,
  });
  // Ornament rule with a red diamond.
  const ry = y + 35;
  fill(ctx, ix + 22, ry, mid - 8 - (ix + 22), 1, PALETTE.inkFaded);
  fill(ctx, mid + 9, ry, ix + iw - 22 - (mid + 9), 1, PALETTE.inkFaded);
  px(ctx, mid - 6, ry, PALETTE.inkFaded);
  px(ctx, mid + 6, ry, PALETTE.inkFaded);
  diamond(ctx, mid, ry, 3, PALETTE.redInk);
  px(ctx, mid, ry, PALETTE.parchment);
  drawHangulTitle(ctx, mid, y + 42, 2, PALETTE.redInk, 'center', PALETTE.parchmentShade);
  rivet(ctx, x + 1, y + 1);
  rivet(ctx, x + w - 4, y + 1);
  rivet(ctx, x + 1, y + h - 4);
  rivet(ctx, x + w - 4, y + h - 4);
}

/**
 * The small label pinned over the cartouche's lower band, centred: the Explorer tag, or in the Steam
 * edition a Survey Contract's name (a run is never both: Contracts are Standard only).
 */
export function runTagBox(text: string): Box {
  const b = SECTIONS.cart;
  const w = measureText(text, 1) + 12;
  return { x: b.x + Math.floor((b.w - w) / 2), y: b.y + b.h - 8, w, h: 13 };
}

/** The widest run tag that stays clear of the cartouche's corner rivets. */
export const RUN_TAG_MAX_W = SECTIONS.cart.w - 8;

/** Explorer only: a small red-ink label pinned over the cartouche's lower band. */
function drawModeTag(ctx: Ctx, state: GameState): void {
  if (state.mode !== 'explorer') return;
  const text = t('modeExplorer');
  const { x, y, w, h } = runTagBox(text);
  fill(ctx, x, y, w, h, PALETTE.redInk);
  fill(ctx, x + 1, y + 1, w - 2, h - 2, PALETTE.parchment);
  drawText(ctx, text, x + Math.floor(w / 2), y + 3, { color: PALETTE.redInk, align: 'center' });
}

/**
 * The Survey Contract tag's text: the Contract's name and nothing else. It takes only the Contract's
 * identity, so it can never show how the expedition is doing against its conditions.
 */
export function contractTagText(id: ContractId): string {
  return contractText(CONTRACT_LINES[id][0]);
}

/**
 * Steam edition, during a Survey Contract: the Contract's name in the Explorer tag's place, drawn in
 * plain ink with a faded rule so it reads as a label rather than as a third mode.
 */
function drawContractTag(ctx: Ctx, id: ContractId): void {
  const text = contractTagText(id);
  const { x, y, w, h } = runTagBox(text);
  fill(ctx, x, y, w, h, PALETTE.parchment);
  outline(ctx, x, y, w, h, PALETTE.inkFaded);
  drawText(ctx, text, x + Math.floor(w / 2), y + 3, { color: PALETTE.inkSoft, align: 'center' });
}

function drawAltimeterStatic(ctx: Ctx): void {
  const b = SECTIONS.alti;
  plate(ctx, b, 'dark', true, 31);
  const i = inner(b);
  label(ctx, t('altimeter'), i.x + 6, i.y + 5);
  // Drum-counter bezel.
  const bx = DRUM_X;
  const by = DRUM_Y;
  fill(ctx, bx - 1, by - 1, DRUM_W + 2, DRUM_H + 2, FACE_SHADOW);
  fill(ctx, bx, by, DRUM_W, DRUM_H, PALETTE.brass);
  fill(ctx, bx, by, DRUM_W, 1, PALETTE.brassLight);
  fill(ctx, bx, by, 1, DRUM_H, PALETTE.brassLight);
  fill(ctx, bx, by + DRUM_H - 1, DRUM_W, 1, PALETTE.brassShadow);
  fill(ctx, bx + DRUM_W - 1, by, 1, DRUM_H, PALETTE.brassShadow);
  for (let k = 0; k < DRUM_COUNT; k++) {
    const wx = bx + DRUM_BEZEL + k * (DRUM_WIN_W + DRUM_SEP);
    const wy = by + DRUM_BEZEL;
    outline(ctx, wx - 1, wy - 1, DRUM_WIN_W + 2, DRUM_WIN_H + 2, PALETTE.brassDark);
    if (k > 0) fill(ctx, wx - DRUM_SEP, wy + 1, 1, DRUM_WIN_H - 2, PALETTE.brassLight);
  }
  // Rivets at the bezel corners.
  px(ctx, bx + 1, by + 1, PALETTE.brassShadow);
  px(ctx, bx + DRUM_W - 2, by + 1, PALETTE.brassShadow);
  px(ctx, bx + 1, by + DRUM_H - 2, PALETTE.brassShadow);
  px(ctx, bx + DRUM_W - 2, by + DRUM_H - 2, PALETTE.brassShadow);
  // Units.
  const ux = bx + DRUM_W + 6;
  drawText(ctx, 'M', ux, by + 3, { scale: 2, color: PALETTE.parchment });
  drawText(ctx, t('asl'), ux, by + 21, { color: PALETTE.brass });

  // Vertical elevation scale 0..1200 m.
  const tx = TUBE_X;
  fill(ctx, tx, TUBE_TOP, TUBE_W, TUBE_BOTTOM - TUBE_TOP + 1, PALETTE.brassDark);
  fill(ctx, tx + 1, TUBE_TOP + 1, TUBE_W - 2, TUBE_BOTTOM - TUBE_TOP - 1, FACE_SHADOW);
  fill(ctx, tx, TUBE_TOP, TUBE_W, 1, PALETTE.brass);
  fill(ctx, tx, TUBE_BOTTOM, TUBE_W, 1, PALETTE.brass);
  for (let m = 0; m <= MAX_ELEV_M; m += 150) {
    const ty = tubeY(m);
    const major = m % 600 === 0;
    fill(ctx, tx + TUBE_W, ty, major ? 5 : 3, 1, major ? PALETTE.brassLight : PALETTE.brass);
    if (major) drawText(ctx, `${m}`, tx + TUBE_W + 7, ty - 3, { color: PALETTE.parchmentShade });
  }
  // Sight-band thresholds (vision widens above these heights).
  for (const e of [VISION_MID_MIN, VISION_HIGH_MIN]) {
    const ty = tubeY(e * MAX_ELEV_M);
    px(ctx, tx + TUBE_W, ty, AMBER);
    px(ctx, tx + TUBE_W + 1, ty, AMBER);
  }
  label(ctx, t('sightRadius'), i.x + 6, SECTIONS.alti.y + 62);
}

function drawSlopeStatic(ctx: Ctx): void {
  const b = SECTIONS.slope;
  plate(ctx, b, 'dark', false, 41);
  label(ctx, t('slope'), b.x + 9, b.y + 12);
}

function drawStaminaStatic(ctx: Ctx): void {
  const b = SECTIONS.stamina;
  plate(ctx, b, 'dark', false, 51);
  label(ctx, t('stamina'), b.x + 9, b.y + 8);
  // Bar frame with riveted end caps.
  const x = BAR_X;
  const y = BAR_Y;
  fill(ctx, x, y, BAR_W, BAR_H, PALETTE.brassShadow);
  fill(ctx, x + 1, y + 1, BAR_W - 2, BAR_H - 2, PALETTE.brass);
  fill(ctx, x + 1, y + 1, BAR_W - 2, 1, PALETTE.brassLight);
  fill(ctx, x + 1, y + 1, 1, BAR_H - 2, PALETTE.brassLight);
  fill(ctx, x + 2, y + BAR_H - 2, BAR_W - 3, 1, PALETTE.brassDark);
  fill(ctx, x + BAR_W - 2, y + 2, 1, BAR_H - 3, PALETTE.brassDark);
  fill(ctx, x + BAR_CAP - 1, y + 2, BAR_W - 2 * BAR_CAP + 2, BAR_H - 4, PALETTE.brassShadow);
  fill(ctx, x + BAR_CAP, y + 3, BAR_W - 2 * BAR_CAP, BAR_H - 6, FACE_SHADOW);
  rivet(ctx, x + 2, y + 6);
  rivet(ctx, x + BAR_W - 5, y + 6);
  label(ctx, t('lastStep'), b.x + 9, b.y + 44);
}

function drawStepCardStatic(ctx: Ctx): void {
  plate(ctx, STEP_BOX, 'paper', false, 61);
  drawText(ctx, t('stepCost'), STEP_CX, STEP_BOX.y + 8, { color: PALETTE.inkSoft, align: 'center' });
  fill(ctx, STEP_BOX.x + 10, STEP_BOX.y + 17, STEP_BOX.w - 20, 1, PALETTE.inkPale);
  for (const d of DIR_LIST) {
    const [cx, cy] = cellOrigin(d);
    outline(ctx, cx, cy, CELL, CELL, PALETTE.inkFaded);
    fill(ctx, cx + 1, cy + CELL - 2, CELL - 2, 1, PALETTE.parchmentShade);
    drawText(ctx, ARROW[d], cx + Math.floor(CELL / 2), cy + 4, { color: PALETTE.inkSoft, align: 'center' });
  }
  // "You are here" marker in the centre cell.
  const [ox, oy] = cellOrigin('centre');
  const mx = ox + Math.floor(CELL / 2);
  const my = oy + Math.floor(CELL / 2);
  circle(ctx, mx, my, 7, PALETTE.inkFaded);
  disc(ctx, mx, my, 3, PALETTE.redInk);
  px(ctx, mx - 1, my - 1, PALETTE.redInkBright);
  for (const [dx, dy] of [
    [0, -10],
    [0, 8],
    [-10, 0],
    [8, 0],
  ] as const) {
    fill(ctx, mx + dx, my + dy, dx === 0 ? 1 : 3, dx === 0 ? 3 : 1, PALETTE.inkFaded);
  }
}

function drawCompassStatic(ctx: Ctx): void {
  plate(ctx, COMPASS_BOX, 'dark', true, 71);
  label(ctx, t('compass'), COMPASS_CX, COMPASS_BOX.y + 8, 'center');
  const cx = COMPASS_CX;
  const cy = COMPASS_CY;
  const R = COMPASS_R;
  // Ring, bezel and face rasterised per pixel (once) with directional lighting.
  for (let dy = -R - 1; dy <= R + 1; dy++) {
    for (let dx = -R - 1; dx <= R + 1; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > R + 0.5) continue;
      const light = d > 0 ? (-dx - dy) / (d * Math.SQRT2) : 0;
      let color: string;
      if (d > R - 0.5) color = PALETTE.brassShadow;
      else if (d > R - 3.5) color = light > 0.45 ? PALETTE.brassLight : light > -0.4 ? PALETTE.brass : PALETTE.brassDark;
      else if (d > R - 5.5) color = light < -0.45 ? PALETTE.brassLight : light < 0.4 ? PALETTE.brass : PALETTE.brassDark;
      else if (d > R - 6.5) color = PALETTE.brassShadow;
      else if (d > COMPASS_FACE_R - 3 && bayerOn(cx + dx, cy + dy, 6)) color = PALETTE.parchmentDark;
      else color = PALETTE.parchment;
      px(ctx, cx + dx, cy + dy, color);
    }
  }
  // Degree notches on the bezel every 30 degrees.
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6;
    const nx = Math.round(cx + Math.cos(a) * (R - 2));
    const ny = Math.round(cy + Math.sin(a) * (R - 2));
    px(ctx, nx, ny, PALETTE.brassShadow);
  }
  // Faint compass rose.
  const rose = (a: number, len: number, w: number, c1: string, c2: string): void => {
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const tip: Pt = [cx + 0.5 + ux * len, cy + 0.5 + uy * len];
    const o: Pt = [cx + 0.5, cy + 0.5];
    const l: Pt = [cx + 0.5 - uy * w, cy + 0.5 + ux * w];
    const r: Pt = [cx + 0.5 + uy * w, cy + 0.5 - ux * w];
    polygon(ctx, [tip, l, o], c1);
    polygon(ctx, [tip, o, r], c2);
  };
  for (let k = 0; k < 4; k++) {
    rose(((k * 2 + 1) * Math.PI) / 4, 14, 3, PALETTE.parchmentDark, PALETTE.parchmentDark);
  }
  for (let k = 0; k < 4; k++) rose((k * Math.PI) / 2, 21, 4, PALETTE.parchmentDark, PALETTE.parchmentShade);
  // Ticks: 16 points.
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8 - Math.PI / 2;
    const r0 = k % 4 === 0 ? COMPASS_FACE_R - 7 : k % 2 === 0 ? COMPASS_FACE_R - 5 : COMPASS_FACE_R - 3;
    const r1 = COMPASS_FACE_R - 1;
    line(
      ctx,
      cx + Math.cos(a) * r0,
      cy + Math.sin(a) * r0,
      cx + Math.cos(a) * r1,
      cy + Math.sin(a) * r1,
      k % 4 === 0 ? PALETTE.ink : k % 2 === 0 ? PALETTE.inkSoft : PALETTE.inkFaded,
    );
  }
  drawCardinals(ctx);
}

/** Cardinal letters: [letter, dx, dy of the glyph's top-centre from the dial centre, colour]. */
const CARDINALS: readonly (readonly [string, number, number, string])[] = (() => {
  const lr = COMPASS_FACE_R - 13;
  return [
    ['N', 1, -lr - 3, PALETTE.redInk],
    ['S', 1, lr - 3, PALETTE.ink],
    ['E', lr + 1, -3, PALETTE.ink],
    ['W', -lr + 1, -3, PALETTE.ink],
  ];
})();

/**
 * N / E / S / W with a 1 px parchment knockout. Drawn into the static dial and again over
 * the needle each frame, so a needle pointing at a letter never hides it.
 */
function drawCardinals(ctx: Ctx): void {
  for (const [ch, dx, dy, color] of CARDINALS) {
    knockoutText(ctx, ch, COMPASS_CX + dx, COMPASS_CY + dy, { color, align: 'center' }, PALETTE.parchment);
  }
}

function drawSurveyStatic(ctx: Ctx): void {
  const b = SECTIONS.survey;
  plate(ctx, b, 'dark', false, 81);
  label(ctx, t('surveyed'), b.x + 9, b.y + 8);
  const bx = b.x + 9;
  const by = b.y + 20;
  const bw = b.w - 18;
  fill(ctx, bx, by, bw, 7, PALETTE.brassDark);
  fill(ctx, bx + 1, by + 1, bw - 2, 5, FACE_SHADOW);
  fill(ctx, bx, by + 6, bw, 1, PALETTE.brass);
}

function drawStatsStatic(ctx: Ctx): void {
  const b = SECTIONS.stats;
  plate(ctx, b, 'dark', false, 91);
  const colB = b.x + Math.floor(b.w / 2) + 4;
  label(ctx, t('turn'), b.x + 9, b.y + 8);
  label(ctx, t('time'), colB, b.y + 8);
  label(ctx, t('caches'), b.x + 9, b.y + 37);
  label(ctx, t('seed'), colB, b.y + 37);
  // Engraved dividers.
  const vx = b.x + Math.floor(b.w / 2) - 3;
  fill(ctx, vx, b.y + 7, 1, b.h - 14, FACE_SHADOW);
  fill(ctx, vx + 1, b.y + 7, 1, b.h - 14, FACE_GRAIN);
  fill(ctx, b.x + 8, b.y + 33, b.w - 16, 1, FACE_SHADOW);
  fill(ctx, b.x + 8, b.y + 34, b.w - 16, 1, FACE_GRAIN);
}

const LOG_LINES = 4;
const LOG_LINE_H = 16;
const LOG_TOP = SECTIONS.log.y + 22;

function drawLogStatic(ctx: Ctx): void {
  const b = SECTIONS.log;
  plate(ctx, b, 'paper', false, 101);
  const fw = drawText(ctx, t('fieldLog'), b.x + 9, b.y + 8, { color: PALETTE.inkSoft });
  fill(ctx, b.x + 9 + fw + 5, b.y + 11, b.w - 23 - fw, 1, PALETTE.inkPale);
  for (let k = 0; k < LOG_LINES; k++) {
    const ly = LOG_TOP + k * LOG_LINE_H + 10;
    for (let xx = b.x + 8; xx < b.x + b.w - 8; xx += 2) px(ctx, xx, ly, PALETTE.parchmentShade);
  }
  // Margin rule, like a surveyor's field book.
  fill(ctx, b.x + 16, b.y + 18, 1, b.h - 22, '#d7b0a0');
}

function drawFooterStatic(ctx: Ctx): void {
  const b = SECTIONS.footer;
  plate(ctx, b, 'dark', false, 111);
  const key = PALETTE.parchment;
  const txt = PALETTE.brass;
  // Compact hints: the icon buttons on the right take the rest of the bar.
  drawRuns(ctx, b.x + 9, b.y + 9, [
    ['WASD', key],
    [` ${t('move')}`, txt],
  ]);
  drawRuns(ctx, b.x + 9, b.y + 23, [
    ['R', key],
    [` ${t('footNew')} `, txt],
    ['M', key],
    [` ${t('mute')}`, txt],
  ]);
}

// Footer icon buttons, right-aligned: [EN/KO] [fullscreen] [speaker].
const FOOT_ICON_Y = SECTIONS.footer.y + 9;
const SPEAKER_BOX: Box = { x: SECTIONS.footer.x + SECTIONS.footer.w - 36, y: FOOT_ICON_Y - 1, w: 28, h: 29 };
const FULLSCREEN_BOX: Box = { x: SPEAKER_BOX.x - 22, y: FOOT_ICON_Y + 1, w: 18, h: 18 };
const LANG_BOX: Box = { x: FULLSCREEN_BOX.x - 44, y: FOOT_ICON_Y + 1, w: 40, h: 18 };
const MENU_BOX: Box = { x: LANG_BOX.x - 22, y: FOOT_ICON_Y + 1, w: 18, h: 18 };

/** Pause-menu button: three brass bars. Live only while an expedition is being played. */
function drawMenuButton(ctx: Ctx, state: GameState): void {
  const b = MENU_BOX;
  const live = state.phase === 'playing';
  const c = live ? PALETTE.brassLight : DIM_TEXT;
  fill(ctx, b.x, b.y, b.w, b.h, FACE_SHADOW);
  outline(ctx, b.x, b.y, b.w, b.h, ui.pause.isOpen ? PALETTE.brassLight : PALETTE.brassDark);
  for (let k = 0; k < 3; k++) fill(ctx, b.x + 4, b.y + 5 + k * 4, b.w - 8, 2, c);
  if (!live) return;
  hoverFrame(ctx, b, 'pause');
  addButton('pause', b.x - 2, b.y - 3, b.w + 4, b.h + 6);
}

/** Hover frame shared by the footer buttons. */
function hoverFrame(ctx: Ctx, b: Box, id: ButtonId): void {
  if (ui.hover === id) outline(ctx, b.x - 1, b.y - 1, b.w + 2, b.h + 2, PALETTE.brassLight);
}

/** Language switch: the active language lit, the other dim. */
function drawLangButton(ctx: Ctx): void {
  const b = LANG_BOX;
  fill(ctx, b.x, b.y, b.w, b.h, FACE_SHADOW);
  outline(ctx, b.x, b.y, b.w, b.h, PALETTE.brassDark);
  const ko = getLang() === 'ko';
  drawText(ctx, 'EN', b.x + 4, b.y + 6, { color: ko ? DIM_TEXT : PALETTE.brassLight });
  drawText(ctx, '/', b.x + 17, b.y + 6, { color: DIM_TEXT });
  drawText(ctx, 'KO', b.x + 25, b.y + 6, { color: ko ? PALETTE.brassLight : DIM_TEXT });
  hoverFrame(ctx, b, 'lang');
  addButton('lang', b.x - 2, b.y - 3, b.w + 4, b.h + 6);
}

/** Four corner brackets: pointing out to enter fullscreen, in to leave it. */
function drawFullscreenButton(ctx: Ctx): void {
  const b = FULLSCREEN_BOX;
  const c = ui.fullscreenAvailable ? PALETTE.brassLight : DIM_TEXT;
  fill(ctx, b.x, b.y, b.w, b.h, FACE_SHADOW);
  outline(ctx, b.x, b.y, b.w, b.h, PALETTE.brassDark);
  const x0 = b.x + 4;
  const y0 = b.y + 4;
  const x1 = b.x + b.w - 5;
  const y1 = b.y + b.h - 5;
  const len = 4;
  for (const [cx, cy, sx, sy] of [
    [x0, y0, 1, 1],
    [x1, y0, -1, 1],
    [x0, y1, 1, -1],
    [x1, y1, -1, -1],
  ] as const) {
    if (ui.fullscreen) {
      // Brackets whose corner points into the middle.
      const ix = cx + sx * (len - 1);
      const iy = cy + sy * (len - 1);
      fill(ctx, Math.min(cx, ix), iy, len, 1, c);
      fill(ctx, ix, Math.min(cy, iy), 1, len, c);
    } else {
      fill(ctx, Math.min(cx, cx + sx * (len - 1)), cy, len, 1, c);
      fill(ctx, cx, Math.min(cy, cy + sy * (len - 1)), 1, len, c);
    }
  }
  if (!ui.fullscreenAvailable) return;
  hoverFrame(ctx, b, 'fullscreen');
  addButton('fullscreen', b.x - 2, b.y - 3, b.w + 4, b.h + 6);
}

function drawStatic(ctx: Ctx): void {
  drawPanelFrame(ctx);
  drawCartouche(ctx);
  drawAltimeterStatic(ctx);
  drawSlopeStatic(ctx);
  drawStaminaStatic(ctx);
  drawStepCardStatic(ctx);
  drawCompassStatic(ctx);
  drawSurveyStatic(ctx);
  drawStatsStatic(ctx);
  drawLogStatic(ctx);
  drawFooterStatic(ctx);
}

let staticLayer: HTMLCanvasElement | null | undefined;
/** Language + web-font epoch the cached layers were painted with. */
let paintedTextKey = '';

/** Drop every cached raster that contains text once the language or the loaded font changes. */
function refreshTextCaches(): void {
  const key = `${langVersion()}|${fontEpoch()}`;
  if (key === paintedTextKey) return;
  paintedTextKey = key;
  staticLayer = undefined;
  cardCache.clear();
}

function getStaticLayer(): HTMLCanvasElement | null {
  refreshTextCaches();
  if (staticLayer !== undefined) return staticLayer;
  const made = makeCanvas(HUD_W, HUD_H);
  if (!made) {
    staticLayer = null;
    return null;
  }
  made.g.translate(-HUD_X, -HUD_Y);
  drawStatic(made.g);
  staticLayer = made.canvas;
  return staticLayer;
}

// ---------------------------------------------------------------------------
// Dynamic HUD parts
// ---------------------------------------------------------------------------

/** Odometer easing state so the altimeter drums roll between readings on one map. */
const altimeterAnim: { shown: number; last: number; map: MapData | null } = {
  shown: Number.NaN,
  last: 0,
  map: null,
};

function easedAltitude(target: number, now: number, map: MapData): number {
  const a = altimeterAnim;
  // A new map (R or a fresh expedition) snaps the drums rather than rolling through old heights.
  if (!Number.isFinite(a.shown) || now < a.last || now - a.last > 1000 || map !== a.map) {
    a.shown = target;
  } else {
    const k = 1 - Math.exp(-(now - a.last) / 70);
    a.shown += (target - a.shown) * k;
    if (Math.abs(target - a.shown) < 0.05) a.shown = target;
  }
  a.last = now;
  a.map = map;
  return a.shown;
}

/** Odometer drums print an open zero (the font's slashed zero reads poorly at 4x). */
function drumGlyph(digit: number): string {
  return digit === 0 ? 'O' : `${digit}`;
}

function drawAltimeter(ctx: Ctx, state: GameState, now: number): void {
  const elev = playerElevation(state);
  const meters = toMeters(elev);
  const shown = easedAltitude(meters, now, state.map);
  const whole = Math.floor(Math.max(0, Math.min(9999, shown)));
  const frac = Math.max(0, Math.min(9999, shown)) - whole;
  for (let k = 0; k < DRUM_COUNT; k++) {
    const power = DRUM_COUNT - 1 - k;
    const unit = 10 ** power;
    const digit = Math.floor(whole / unit) % 10;
    const roll = power === 0 || whole % unit === unit - 1 ? frac : 0;
    const wx = DRUM_X + DRUM_BEZEL + k * (DRUM_WIN_W + DRUM_SEP);
    const wy = DRUM_Y + DRUM_BEZEL;
    // Drum face with cylinder curvature (dithered toward the rims), digits on top.
    fill(ctx, wx, wy, DRUM_WIN_W, DRUM_WIN_H, PALETTE.parchment);
    fill(ctx, wx, wy, DRUM_WIN_W, 1, PALETTE.inkPale);
    dither(ctx, wx, wy + 1, DRUM_WIN_W, 2, PALETTE.parchmentShade, 8);
    dither(ctx, wx, wy + DRUM_WIN_H - 3, DRUM_WIN_W, 2, PALETTE.parchmentShade, 8);
    fill(ctx, wx, wy + DRUM_WIN_H - 1, DRUM_WIN_W, 1, PALETTE.inkPale);
    // Leading zeros print in pale ink: a dimmed digit, not an empty window.
    const leading = power > 0 && whole < unit && !(roll > 0 && digit === 9);
    const color = leading ? PALETTE.inkPale : PALETTE.ink;
    const offset = Math.round(roll * DRUM_WIN_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(wx, wy + 1, DRUM_WIN_W, DRUM_WIN_H - 2);
    ctx.clip();
    drawText(ctx, drumGlyph(digit), wx + 1, wy + 2 - offset, { scale: DRUM_SCALE, color });
    if (offset > 0) {
      drawText(ctx, drumGlyph((digit + 1) % 10), wx + 1, wy + 2 - offset + DRUM_WIN_H, {
        scale: DRUM_SCALE,
        color: PALETTE.ink,
      });
    }
    ctx.restore();
  }

  // Elevation column + pointer.
  const tx = TUBE_X;
  const top = tubeY(meters);
  const waterTop = tubeY(WATER_LEVEL * MAX_ELEV_M);
  const innerBottom = TUBE_BOTTOM - 1;
  const colTop = Math.max(TUBE_TOP + 1, top);
  for (let yy = colTop; yy <= innerBottom; yy++) {
    const inWater = yy >= waterTop;
    fill(ctx, tx + 1, yy, TUBE_W - 2, 1, inWater ? PALETTE.waterInk : PALETTE.brass);
    px(ctx, tx + 2, yy, inWater ? PALETTE.water : PALETTE.brassLight);
    px(ctx, tx + TUBE_W - 2, yy, inWater ? '#3a525a' : PALETTE.brassDark);
  }
  for (let k = -3; k <= 3; k++) {
    fill(ctx, tx - 6, top + k, 5 - Math.abs(k), 1, PALETTE.redInkBright);
  }
  px(ctx, tx - 6, top, RED_HI);

  // Sight radius readout and PANORAMA badge.
  const i = inner(SECTIONS.alti);
  const radius = state.visionRadius;
  const high = radius >= VISION_HIGH;
  drawText(ctx, t('tilesN', { n: radius }), i.x + 6, SECTIONS.alti.y + 73, {
    scale: 2,
    color: high ? PALETTE.brassLight : PALETTE.parchment,
  });
  const bx = i.x + 6;
  const by = SECTIONS.alti.y + 94;
  const bw = 104;
  const bh = 16;
  if (high) {
    const glow = Math.floor(now / 350) % 2 === 0;
    fill(ctx, bx - 1, by - 1, bw + 2, bh + 2, glow ? PALETTE.brassLight : PALETTE.brass);
    fill(ctx, bx, by, bw, bh, PALETTE.brassLight);
    dither(ctx, bx, by + bh - 4, bw, 4, PALETTE.brass, 8);
    fill(ctx, bx, by, bw, 1, GLASS_HI);
    badgeText(ctx, t('panorama'), bx + Math.floor(bw / 2), by, PALETTE.ink);
  } else {
    outline(ctx, bx, by, bw, bh, PALETTE.brassShadow);
    badgeText(ctx, t('panorama'), bx + Math.floor(bw / 2), by, '#4a3a2c');
  }
}

/**
 * Badge caption in a 16 px tall box at (cx, top): 2x bitmap Latin, or 1x Galmuri Hangul (its 9 px
 * glyphs would not fit the box doubled).
 */
function badgeText(ctx: Ctx, text: string, cx: number, top: number, color: string): void {
  if (getLang() === 'ko') drawText(ctx, text, cx, top + 5, { color, align: 'center' });
  else drawText(ctx, text, cx, top + 2, { scale: 2, color, align: 'center' });
}

type LampColor = 'green' | 'amber' | 'red';

const LAMP: Record<LampColor, { lit: string; hi: string; shade: string; dim: string }> = {
  green: { lit: GREEN_LIT, hi: GREEN_HI, shade: GREEN_SHADE, dim: GREEN_DIM },
  amber: { lit: AMBER, hi: AMBER_HI, shade: AMBER_INK, dim: AMBER_DIM },
  red: { lit: RED_LIT, hi: RED_HI, shade: RED_SHADE, dim: RED_DIM },
};

function lamp(ctx: Ctx, cx: number, cy: number, kind: LampColor, on: boolean): void {
  const c = LAMP[kind];
  if (on) {
    // Dithered glow halo.
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 5.5 && d <= 8.5 && bayerOn(cx + dx, cy + dy, d < 7 ? 6 : 2)) px(ctx, cx + dx, cy + dy, c.shade);
      }
    }
  }
  disc(ctx, cx, cy, 5, PALETTE.brassDark);
  circle(ctx, cx, cy, 5, PALETTE.brass);
  px(ctx, cx - 3, cy - 4, PALETTE.brassLight);
  px(ctx, cx - 4, cy - 3, PALETTE.brassLight);
  disc(ctx, cx, cy, 3, on ? c.lit : c.dim);
  if (on) {
    px(ctx, cx + 2, cy + 1, c.shade);
    px(ctx, cx + 1, cy + 2, c.shade);
    fill(ctx, cx - 2, cy - 1, 2, 1, c.hi);
    px(ctx, cx - 1, cy - 2, GLASS_HI);
  } else {
    px(ctx, cx - 1, cy - 2, '#5a4a3a');
  }
}

function drawSlope(ctx: Ctx, state: GameState, now: number): void {
  const b = SECTIONS.slope;
  const cy = b.y + 15;
  const blinkOn = Math.floor(now / 260) % 2 === 0;
  const s = state.localSlope;
  lamp(ctx, b.x + 54, cy, 'green', s === 'flat');
  lamp(ctx, b.x + 69, cy, 'amber', s === 'moderate');
  lamp(ctx, b.x + 84, cy, 'red', s === 'steep' && blinkOn);
  const tx = b.x + 98;
  if (s === 'flat') drawText(ctx, t('flat'), tx, b.y + 8, { scale: 2, color: GREEN_LIT });
  else if (s === 'moderate') drawText(ctx, t('moderate'), tx, b.y + 8, { scale: 2, color: AMBER });
  else drawText(ctx, t('steepAlarm'), tx, b.y + 8, { scale: 2, color: blinkOn ? RED_LIT : RED_SHADE });
}

function drawStamina(ctx: Ctx, state: GameState, now: number): void {
  const b = SECTIONS.stamina;
  const stamina = Math.max(0, Math.min(MAX_STAMINA, state.stamina));
  const low = stamina < LOW_STAMINA;
  const pulse = (Math.sin((now / 1000) * Math.PI * 2 * 1.4) + 1) / 2;
  const pulseStep = low ? Math.min(2, Math.floor(pulse * 3)) : 1;
  const ramp = [
    { main: RED_SHADE, hi: PALETTE.redInkBright, shade: '#5e1a12' },
    { main: PALETTE.redInkBright, hi: RED_LIT, shade: RED_SHADE },
    { main: RED_LIT, hi: RED_HI, shade: PALETTE.redInkBright },
  ];
  let seg: { main: string; hi: string; shade: string };
  if (low) seg = ramp[pulseStep];
  else if (stamina <= MAX_STAMINA / 2) seg = { main: AMBER, hi: AMBER_HI, shade: AMBER_INK };
  else seg = { main: GREEN_LIT, hi: GREEN_HI, shade: GREEN_SHADE };

  const perSeg = MAX_STAMINA / BAR_SEGMENTS;
  const sx0 = BAR_X + BAR_CAP;
  const sy = BAR_Y + 4;
  const sh = BAR_H - 8;
  for (let k = 0; k < BAR_SEGMENTS; k++) {
    const x = sx0 + k * (BAR_SEG_W + 1);
    const amount = (stamina - k * perSeg) / perSeg;
    if (amount >= 1) {
      fill(ctx, x, sy, BAR_SEG_W, sh, seg.main);
      fill(ctx, x, sy, BAR_SEG_W, 1, seg.hi);
      fill(ctx, x, sy + sh - 2, BAR_SEG_W, 2, seg.shade);
    } else if (amount > 0) {
      dither(ctx, x, sy, BAR_SEG_W, sh, seg.main, Math.max(3, Math.round(amount * 16)));
    } else {
      fill(ctx, x, sy, BAR_SEG_W, sh, FACE);
      fill(ctx, x, sy + sh - 1, BAR_SEG_W, 1, FACE_GRAIN);
    }
  }
  if (low && pulseStep === 2) outline(ctx, BAR_X - 1, BAR_Y - 1, BAR_W + 2, BAR_H + 2, PALETTE.redInkBright);

  // Numeric readout.
  const right = b.x + b.w - 9;
  const numColor = low ? (pulseStep === 0 ? PALETTE.redInkBright : RED_LIT) : PALETTE.parchment;
  const maxW = drawText(ctx, `/${MAX_STAMINA}`, right, b.y + 11, { color: PALETTE.brass, align: 'right' });
  drawText(ctx, `${Math.round(stamina)}`, right - maxW - 1, b.y + 4, { scale: 2, color: numColor, align: 'right' });

  // Last move cost.
  const lx = b.x + 9 + measureText(`${t('lastStep')} `) + 2;
  const lm = state.lastMove;
  if (lm) {
    const cost = `-${lm.cost}`;
    const w = drawText(ctx, cost, lx, b.y + 44, { color: costColorLit(lm.cost) });
    drawText(ctx, stepWord(lastStepKind(state, lm.slope)), lx + w + 6, b.y + 44, { color: DIM_TEXT });
  } else {
    drawText(ctx, '--', lx, b.y + 44, { color: DIM_TEXT });
  }
  if (low && Math.floor(now / 400) % 2 === 0) {
    drawText(ctx, t('low'), right, b.y + 44, { color: RED_LIT, align: 'right' });
  }
}

/**
 * True when stepping `d` would empty the stamina bar and end the expedition: the cost is at
 * least the stamina left and the target is neither the Trig Pillar nor an uncollected cache
 * (both of which still catch a last step).
 */
function isLethalStep(state: GameState, d: Dir, cost: number): boolean {
  if (state.phase !== 'playing' || cost < state.stamina) return false;
  const nx = state.player.x + DIRS[d].dx;
  const ny = state.player.y + DIRS[d].dy;
  const { summit, caches } = state.map;
  if (nx === summit.x && ny === summit.y) return false;
  return !caches.some((c, k) => !state.cacheCollected[k] && c.x === nx && c.y === ny);
}

/** Diagonal hatch inside a step cell, clipped to rows [y0, y1). */
function hatchCell(ctx: Ctx, cx: number, cy: number, y0: number, y1: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx + 1, y0, CELL - 2, y1 - y0);
  ctx.clip();
  for (let k = -CELL; k < CELL; k += 4) line(ctx, cx + k, cy + CELL, cx + k + CELL, cy, color);
  ctx.restore();
}

function drawStepCard(ctx: Ctx, state: GameState): void {
  for (const d of DIR_LIST) {
    const [cx, cy] = cellOrigin(d);
    const cost = state.neighborCosts[d];
    const mid = cx + Math.floor(CELL / 2);
    if (cost === null) {
      hatchCell(ctx, cx, cy, cy + 13, cy + CELL - 2, PALETTE.parchmentShade);
      drawText(ctx, 'X', mid, cy + 14, { scale: 2, color: PALETTE.inkPale, align: 'center' });
    } else if (isLethalStep(state, d, cost)) {
      // Red-ruled, hatched cell: the cost, then a '!' (its stroke sits 2 font px into the glyph cell).
      hatchCell(ctx, cx, cy, cy + 1, cy + CELL - 1, LETHAL_HATCH);
      outline(ctx, cx - 1, cy - 1, CELL + 2, CELL + 2, PALETTE.redInk, 2);
      const paper = PALETTE.parchment;
      knockoutText(ctx, ARROW[d], mid, cy + 4, { color: PALETTE.redInk, align: 'center' }, paper);
      const text = `${cost}`;
      const tw = measureText(text, 2);
      const left = mid - Math.floor((tw + 5) / 2);
      knockoutText(ctx, text, left, cy + 14, { scale: 2, color: PALETTE.redInk }, paper);
      knockoutText(ctx, '!', left + tw + 3 - 4, cy + 14, { scale: 2, color: PALETTE.redInkBright }, paper);
    } else {
      drawText(ctx, `${cost}`, mid, cy + 14, { scale: 2, color: costColorOnPaper(cost), align: 'center' });
    }
  }
}

function drawCompass(ctx: Ctx, state: GameState, now: number): void {
  const cx = COMPASS_CX;
  const cy = COMPASS_CY;
  const dx = state.map.summit.x - state.player.x;
  const dy = state.map.summit.y - state.player.y;
  const base = dx === 0 && dy === 0 ? -Math.PI / 2 : Math.atan2(dy, dx);
  const solid = state.summitSighted;
  // Screen y points down, so atan2(dy, dx) maps straight onto a north-up dial.
  // Gentle +-6 degree wobble from two incommensurate sines (|wobble| <= 1).
  const amp = (6 * Math.PI) / 180;
  const wobble = Math.sin(now * 0.0021) * (0.65 + 0.35 * Math.sin(now * 0.00077));
  const a = base + amp * wobble;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const o: Pt = [cx + 0.5, cy + 0.5];
  // The tip reaches into the ring of cardinal letters, which are redrawn on top below.
  const tip: Pt = [o[0] + ux * (COMPASS_FACE_R - 9), o[1] + uy * (COMPASS_FACE_R - 9)];
  const tail: Pt = [o[0] - ux * 17, o[1] - uy * 17];
  const hw = 3.6;
  const l: Pt = [o[0] - uy * hw, o[1] + ux * hw];
  const r: Pt = [o[0] + uy * hw, o[1] - ux * hw];
  if (solid) {
    polygon(ctx, [tail, l, o], PALETTE.inkSoft);
    polygon(ctx, [tail, o, r], PALETTE.ink);
    polygon(ctx, [tip, l, o], PALETTE.redInkBright);
    polygon(ctx, [tip, o, r], PALETTE.redInk);
  } else {
    // A faint hunch: half-tone needle in soft ink, tail barely there.
    polygon(ctx, [tail, l, o], PALETTE.inkPale, checker);
    polygon(ctx, [tail, o, r], PALETTE.inkPale, checker);
    polygon(ctx, [tip, l, o], PALETTE.inkFaded, checker);
    polygon(ctx, [tip, o, r], PALETTE.inkSoft, checker);
    // Complete the spine with the opposite dither phase so the bearing reads as a line.
    line(ctx, o[0] - 0.5, o[1] - 0.5, tip[0] - 0.5, tip[1] - 0.5, PALETTE.inkFaded, (x, y) => !checker(x, y));
  }
  // Pivot cap.
  disc(ctx, cx, cy, 2, PALETTE.brassDark);
  px(ctx, cx, cy, PALETTE.brass);
  px(ctx, cx - 1, cy - 1, PALETTE.brassLight);
  drawCardinals(ctx);

  const ly = COMPASS_BOX.y + COMPASS_BOX.h - 16;
  if (dx === 0 && dy === 0) {
    drawText(ctx, t('atPillar'), cx + 1, ly, { color: PALETTE.brassLight, align: 'center' });
  } else if (solid) {
    const bearing = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) % 360;
    const txt = t('trigBearing', { b: `${bearing < 100 ? (bearing < 10 ? '00' : '0') : ''}${bearing}` });
    drawText(ctx, txt, cx + 1, ly, { color: RED_LIT, align: 'center' });
  } else {
    drawText(ctx, t('trigHunch'), cx + 1, ly, { color: DIM_TEXT, align: 'center' });
  }
}

function drawSurvey(ctx: Ctx, state: GameState): void {
  const b = SECTIONS.survey;
  const pct = (state.revealedCount / (MAP_W * MAP_H)) * 100;
  drawText(ctx, formatPercent(pct), b.x + b.w - 9, b.y + 8, { color: PALETTE.parchment, align: 'right' });
  const bx = b.x + 10;
  const by = b.y + 21;
  const bw = b.w - 20;
  const fw = Math.round((bw * Math.max(0, Math.min(100, pct))) / 100);
  if (fw > 0) {
    fill(ctx, bx, by, fw, 4, PALETTE.parchmentShade);
    fill(ctx, bx, by, fw, 1, PALETTE.parchment);
    for (let xx = bx + 1; xx < bx + fw; xx += 3) px(ctx, xx, by + 2, PALETTE.inkPale);
  }
  for (let k = 1; k < 10; k++) {
    const tx = bx + Math.round((bw * k) / 10);
    px(ctx, tx, by + 3, tx < bx + fw ? PALETTE.inkFaded : PALETTE.brassDark);
  }
}

function drawStats(ctx: Ctx, state: GameState, now: number): void {
  const b = SECTIONS.stats;
  const colA = b.x + 9;
  const colB = b.x + Math.floor(b.w / 2) + 4;
  const v = PALETTE.parchment;
  drawText(ctx, `${state.turns}`, colA, b.y + 18, { scale: 2, color: v });
  drawText(ctx, formatTime(elapsedMs(state, now)), colB, b.y + 18, { scale: 2, color: v });
  const got = cachesCollected(state);
  const total = state.map.caches.length;
  const w = drawText(ctx, `${got}/${total}`, colA, b.y + 47, { scale: 2, color: v });
  // Cache pips.
  let pxX = colA + w + 6;
  const room = b.x + Math.floor(b.w / 2) - 8;
  for (let k = 0; k < total && pxX + 4 <= room; k++) {
    const on = state.cacheCollected[k] === true;
    fill(ctx, pxX, b.y + 52, 4, 4, on ? PALETTE.brassLight : FACE_SHADOW);
    outline(ctx, pxX - 1, b.y + 51, 6, 6, on ? PALETTE.brass : PALETTE.brassShadow);
    pxX += 7;
  }
  // Random seeds have at most 6 digits; a long ?seed= value drops to 1x so it stays inside the plate.
  const seedText = String(state.seed);
  const seedRoom = b.x + b.w - 9 - colB;
  if (measureText(seedText, 2) <= seedRoom) {
    drawText(ctx, seedText, colB, b.y + 47, { scale: 2, color: v });
  } else {
    drawText(ctx, fitText(seedText, seedRoom, 1), colB, b.y + 51, { color: v });
  }
}

function drawLog(ctx: Ctx, state: GameState, now: number): void {
  const b = SECTIONS.log;
  const entries = state.log.slice(-LOG_LINES);
  const tx = b.x + 21;
  const maxW = b.x + b.w - 8 - tx;
  if (entries.length === 0) {
    drawText(ctx, t('awaiting'), tx, LOG_TOP + (LOG_LINES - 1) * LOG_LINE_H, { color: PALETTE.inkPale });
    return;
  }
  const firstSlot = LOG_LINES - entries.length;
  entries.forEach((e, k) => {
    const y = LOG_TOP + (firstSlot + k) * LOG_LINE_H;
    const newest = k === entries.length - 1;
    const age = now - e.time;
    if (newest && age >= 0 && age < 700) {
      dither(ctx, b.x + 8, y - 2, b.w - 16, 11, PALETTE.brassLight, age < 350 ? 8 : 4);
    }
    const color = toneColorOnPaper(e.tone);
    fill(ctx, b.x + 10, y + 2, 3, 3, color);
    const faded = !newest && e.tone === 'info';
    drawText(ctx, fitText(e.text, maxW), tx, y, { color: faded ? PALETTE.inkSoft : color });
  });
}

function drawSpeaker(ctx: Ctx, muted: boolean, now: number): void {
  const x = SPEAKER_BOX.x + 2;
  const y = SPEAKER_BOX.y + 4;
  hoverFrame(ctx, SPEAKER_BOX, 'mute');
  addButton('mute', SPEAKER_BOX.x, SPEAKER_BOX.y, SPEAKER_BOX.w, SPEAKER_BOX.h);
  const c = muted ? DIM_TEXT : PALETTE.brassLight;
  // Body and cone.
  fill(ctx, x, y + 4, 4, 6, c);
  for (let k = 0; k < 5; k++) fill(ctx, x + 4 + k, y + 4 - k, 1, 6 + 2 * k, c);
  px(ctx, x + 1, y + 5, muted ? '#5a4a3a' : GLASS_HI);
  if (muted) {
    line(ctx, x + 12, y + 3, x + 20, y + 11, RED_LIT);
    line(ctx, x + 13, y + 3, x + 21, y + 11, RED_LIT);
    line(ctx, x + 20, y + 3, x + 12, y + 11, RED_LIT);
    line(ctx, x + 21, y + 3, x + 13, y + 11, RED_LIT);
    drawText(ctx, t('muted'), x + 11, y + 16, { color: RED_LIT, align: 'center' });
  } else {
    // Sound waves: arcs of midpoint circles, right side only.
    const wave = Math.floor(now / 300) % 3;
    const ccx = x + 8;
    const ccy = y + 7;
    for (const [r, idx] of [
      [5, 0],
      [8, 1],
      [11, 2],
    ] as const) {
      const color = idx <= wave ? PALETTE.brassLight : PALETTE.brassDark;
      let xx = r;
      let yy = 0;
      let err = 1 - r;
      ctx.fillStyle = color;
      while (xx >= yy) {
        for (const [ax, ay] of [
          [xx, yy],
          [xx, -yy],
          [yy, xx],
          [yy, -xx],
        ] as const) {
          if (ax > 0 && Math.abs(ay) <= ax * 0.85) ctx.fillRect(ccx + ax, ccy + ay, 1, 1);
        }
        yy++;
        if (err < 0) err += 2 * yy + 1;
        else {
          xx--;
          err += 2 * (yy - xx) + 1;
        }
      }
    }
  }
}

/** Draw the right-hand HUD panel. Call every frame. */
export function drawHud(ctx: CanvasRenderingContext2D, state: GameState, now: number): void {
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  // Buttons are re-registered by whatever draws them this frame.
  clearButtons();
  const layer = getStaticLayer();
  if (layer) ctx.drawImage(layer, HUD_X, HUD_Y);
  else drawStatic(ctx);
  drawAltimeter(ctx, state, now);
  drawSlope(ctx, state, now);
  drawStamina(ctx, state, now);
  drawStepCard(ctx, state);
  drawCompass(ctx, state, now);
  drawSurvey(ctx, state);
  drawStats(ctx, state, now);
  drawLog(ctx, state, now);
  drawModeTag(ctx, state);
  if (EDITION === 'steam' && state.contract !== null) drawContractTag(ctx, state.contract);
  drawSpeaker(ctx, state.muted, now);
  drawLangButton(ctx);
  drawFullscreenButton(ctx);
  drawMenuButton(ctx, state);
  ctx.imageSmoothingEnabled = smoothing;
}

// ---------------------------------------------------------------------------
// Full-screen cards
// ---------------------------------------------------------------------------

const cardCache = new Map<string, HTMLCanvasElement | null>();
const CARD_SHADOW = 6;
/**
 * The cards lie on the map sheet, at least this far inside the map neatline (shadow
 * included), so they never touch the neatline or the HUD panel beside the sheet.
 */
const CARD_INSET = 8;

/**
 * Draw a cached card image (paper + static art painted by `paint` in local coordinates).
 * Falls back to painting directly when offscreen canvases are unavailable.
 */
function blitCard(ctx: Ctx, key: string, w: number, h: number, x: number, y: number, paint: (g: Ctx) => void): void {
  let img = cardCache.get(key);
  if (img === undefined) {
    const made = makeCanvas(w + CARD_SHADOW, h + CARD_SHADOW);
    if (made) {
      paint(made.g);
      img = made.canvas;
    } else {
      img = null;
    }
    cardCache.set(key, img);
  }
  if (img) {
    ctx.drawImage(img, x, y);
  } else {
    ctx.save();
    ctx.translate(x, y);
    paint(ctx);
    ctx.restore();
  }
}

/** Smooth seeded value noise in 0..1. */
function valueNoise(seed: number): (x: number, y: number) => number {
  const hash = (ix: number, iy: number): number => {
    let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  return (x: number, y: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Aged parchment with mottling, darkened deckled edges and a dithered drop shadow. */
function paintPaper(g: Ctx, w: number, h: number, seed: number): void {
  dither(g, CARD_SHADOW, CARD_SHADOW, w, h, SHADOW, 9);
  const tones = [PALETTE.parchment, PALETTE.parchmentDark, PALETTE.parchmentShade, PALETTE.inkPale].map(hexRgb);
  const noise = valueNoise(seed);
  const img = g.createImageData(w, h);
  const data = img.data;
  const rnd = mulberry32(seed ^ 0x5bd1e995);
  // Deckle: per-column / per-row notch depth along each edge.
  const notchTop = Array.from({ length: w }, () => (rnd() < 0.18 ? 1 + Math.floor(rnd() * 2) : 0));
  const notchBottom = Array.from({ length: w }, () => (rnd() < 0.18 ? 1 + Math.floor(rnd() * 2) : 0));
  const notchLeft = Array.from({ length: h }, () => (rnd() < 0.18 ? 1 + Math.floor(rnd() * 2) : 0));
  const notchRight = Array.from({ length: h }, () => (rnd() < 0.18 ? 1 + Math.floor(rnd() * 2) : 0));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (y < notchTop[x] || h - 1 - y < notchBottom[x] || x < notchLeft[y] || w - 1 - x < notchRight[y]) {
        data[o + 3] = 0;
        continue;
      }
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      const edgeDark = edge < 22 ? (1 - edge / 22) ** 2 : 0;
      const mottle = noise(x / 46, y / 46) * 0.65 + noise(x / 11 + 40, y / 11 + 40) * 0.35;
      const v = Math.max(0, mottle - 0.58) * 1.2 + edgeDark * 1.9;
      const t = v * 2 + BAYER4[(y & 3) * 4 + (x & 3)] / 16;
      const idx = Math.max(0, Math.min(3, Math.floor(t)));
      const [r, gg, bb] = tones[idx];
      data[o] = r;
      data[o + 1] = gg;
      data[o + 2] = bb;
      data[o + 3] = 255;
    }
  }
  const tmp = makeCanvas(w, h);
  if (tmp) {
    tmp.g.putImageData(img, 0, 0);
    g.drawImage(tmp.canvas, 0, 0);
  } else {
    fill(g, 0, 0, w, h, PALETTE.parchment);
  }
}

/** Double ink neatline with corner blocks and centred diamonds on the top/bottom rules. */
function paintNeatline(g: Ctx, w: number, h: number, accent: string): void {
  const m = 14;
  outline(g, m, m, w - 2 * m, h - 2 * m, PALETTE.ink, 2);
  outline(g, m + 5, m + 5, w - 2 * (m + 5), h - 2 * (m + 5), PALETTE.inkSoft);
  for (const [cx, cy] of [
    [m - 3, m - 3],
    [w - m - 5, m - 3],
    [m - 3, h - m - 5],
    [w - m - 5, h - m - 5],
  ] as const) {
    fill(g, cx, cy, 8, 8, PALETTE.ink);
    fill(g, cx + 2, cy + 2, 4, 4, accent);
  }
  const mid = Math.floor(w / 2);
  for (const yy of [m, h - m - 2]) {
    fill(g, mid - 10, yy - 1, 21, 4, PALETTE.parchment);
    diamond(g, mid, yy + 1, 5, PALETTE.ink);
    diamond(g, mid, yy + 1, 2, accent);
  }
}

function rule(g: Ctx, cx: number, y: number, half: number, color: string, accent: string): void {
  fill(g, cx - half, y, half - 10, 1, color);
  fill(g, cx + 11, y, half - 10, 1, color);
  px(g, cx - 8, y, color);
  px(g, cx + 8, y, color);
  diamond(g, cx, y, 3, accent);
}

// ----- Legend symbols (drawn procedurally inside a 40x18 swatch) -----

function wavyPoints(x: number, y: number, w: number, amp: number, phase: number): Pt[] {
  const pts: Pt[] = [];
  for (let k = 0; k <= w; k += 2) pts.push([x + k, y + Math.round(Math.sin((k / w) * Math.PI * 2 + phase) * amp)]);
  return pts;
}

function polyline(g: Ctx, pts: readonly Pt[], color: string, thick = 1): void {
  for (let k = 0; k + 1 < pts.length; k++) {
    for (let t = 0; t < thick; t++) line(g, pts[k][0], pts[k][1] + t, pts[k + 1][0], pts[k + 1][1] + t, color);
  }
}

// Styles follow the map sheet: minor contours in soft ink, index contours 2 px in ink,
// cliffs as short tapered hachure ticks hanging toward the low side, inked shorelines.

function symContour(g: Ctx, x: number, y: number): void {
  polyline(g, wavyPoints(x, y + 9, 40, 3, 0.4), PALETTE.inkSoft);
}

function symIndexContour(g: Ctx, x: number, y: number): void {
  polyline(g, wavyPoints(x, y + 8, 40, 3, 0.4), PALETTE.ink, 2);
}

/** Sight line: a 2 px amber contour broken by the eye its labels carry on the sheet. */
function symSightLine(g: Ctx, x: number, y: number): void {
  const pts = wavyPoints(x, y + 8, 40, 3, 0.4);
  polyline(g, pts.filter(([px]) => px <= x + 12), PALETTE.sightInk, 2);
  polyline(g, pts.filter(([px]) => px >= x + 28), PALETTE.sightInk, 2);
  SIGHT_EYE_ART.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) if (row[rx] === 'o') px(g, x + 15 + rx, y + 6 + ry, PALETTE.sightInk);
  });
}

/** Cliff hachure ticks: [left root column along the rim, length, tip column 0 | 1]. */
const CLIFF_TICKS: readonly (readonly [number, number, 0 | 1])[] = [
  [5, 4, 0],
  [14, 5, 1],
  [24, 4, 1],
];

/**
 * Cliff: a short, gently arched 2 px contour with three tapered ticks (2 px wide at the
 * root, 1 px at the tip) hanging toward the low side, all in ink like the map's cliff ticks.
 * The sheet legend uses the same symbol.
 */
function symCliff(g: Ctx, x: number, y: number): void {
  const x0 = x + 5;
  const len = 31;
  const top = (k: number): number => y + 6 - Math.round(Math.sin((k / (len - 1)) * Math.PI) * 1.6);
  for (let k = 0; k < len; k++) fill(g, x0 + k, top(k), 1, 2, PALETTE.ink);
  for (const [k, tickLen, tip] of CLIFF_TICKS) {
    for (const c of [0, 1]) fill(g, x0 + k + c, top(k + c) + 2, 1, c === tip ? tickLen : 2, PALETTE.ink);
  }
}

const WATER_HATCH = '#96a7a2';

function symWater(g: Ctx, x: number, y: number): void {
  fill(g, x, y + 1, 40, 16, PALETTE.water);
  outline(g, x, y + 1, 40, 16, PALETTE.ink);
  outline(g, x + 3, y + 4, 34, 10, PALETTE.waterInk);
  for (const [wx, wy, len] of [
    [x + 7, y + 7, 12],
    [x + 22, y + 7, 9],
    [x + 12, y + 10, 14],
  ] as const) {
    fill(g, wx, wy, len, 1, WATER_HATCH);
  }
}

/** Blit a small row-string pixel-art icon at an integer scale ('.' = transparent). */
function drawArt(
  g: Ctx,
  art: readonly string[],
  colors: Readonly<Record<string, string>>,
  x: number,
  y: number,
  scale: number,
): void {
  art.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const c = colors[row[rx]];
      if (c) fill(g, x + rx * scale, y + ry * scale, scale, scale, c);
    }
  });
}

// Map-object icons, matching the sprites drawn on the sheet.
const OBJECT_COLORS: Readonly<Record<string, string>> = {
  o: PALETTE.ink,
  y: PALETTE.brassLight,
  w: PALETTE.brass,
  W: PALETTE.brassDark,
  R: PALETTE.redInkBright,
  g: PALETTE.green,
  G: '#414a27',
  l: '#7d8a52',
  d: PALETTE.desk,
  s: '#fbf6ea',
  L: '#e9e1cb',
  m: '#c9bb9b',
  D: '#a39273',
  r: PALETTE.redInk,
};

const ART_CRATE: readonly string[] = [
  '......oo..',
  '......oRR.',
  '......oRRR',
  '......oRR.',
  '......o...',
  'ooooooooo.',
  'oyyyyyyyo.',
  'owWwwwWwo.',
  'owWwwwWwo.',
  'owWwwwWwo.',
  'ooooooooo.',
];

const ART_TENT: readonly string[] = [
  '.....oo....',
  '.....oRR...',
  '.....oRRR..',
  '.....oRR...',
  '.....o.....',
  '....ogo....',
  '...oglGo...',
  '..ogglGGo..',
  '.oggdddGGo.',
  'oggdddddGGo',
  'ooooooooooo',
];

const ART_PILLAR: readonly string[] = [
  '.ooooooo.',
  'osLLLLLLo',
  'ommmmmmmo',
  '.oLLLmDo.',
  '.osLrmDo.',
  '.osrrrDo.',
  '.oLLLmDo.',
  '.osLLmDo.',
  '.oLLLmDo.',
  'osLLLmmDo',
  'osLLLmmDo',
  'oLLLmmmDo',
  'ooooooooo',
];

/** Plateau crate and saddle tent side by side (both are supply caches). */
function symCache(g: Ctx, x: number, y: number): void {
  drawArt(g, ART_CRATE, OBJECT_COLORS, x + 1, y - 2, 2);
  drawArt(g, ART_TENT, OBJECT_COLORS, x + 21, y - 2, 2);
}

/** The Ancient Trig Pillar standing in its red trig-station triangle. */
function symTrig(g: Ctx, x: number, y: number): void {
  const cx = x + 20;
  const base = y + 20;
  for (let k = 0; k <= 14; k++) {
    fill(g, cx - 16 + k, base - k, 2, 1, PALETTE.redInk);
    fill(g, cx + 15 - k, base - k, 2, 1, PALETTE.redInk);
  }
  fill(g, cx - 16, base, 33, 2, PALETTE.redInk);
  drawArt(g, ART_PILLAR, OBJECT_COLORS, cx - 9, base - 25, 2);
}

function symEye(g: Ctx, x: number, y: number): void {
  const cx = x + 20;
  const cy = y + 9;
  for (let dx = -10; dx <= 10; dx++) {
    const hh = Math.round(Math.sqrt(1 - (dx / 10.5) ** 2) * 5);
    px(g, cx + dx, cy - hh, PALETTE.ink);
    px(g, cx + dx, cy + hh, PALETTE.ink);
  }
  disc(g, cx, cy, 3, PALETTE.waterInk);
  disc(g, cx, cy, 1, PALETTE.ink);
  px(g, cx - 1, cy - 2, PALETTE.parchment);
}

function costBadge(g: Ctx, x: number, y: number, text: string, color: string): void {
  const w = 44;
  const h = 22;
  fill(g, x, y, w, h, PALETTE.ink);
  fill(g, x + 1, y + 1, w - 2, h - 2, PALETTE.parchmentDark);
  fill(g, x + 1, y + 1, w - 2, 1, PALETTE.parchment);
  fill(g, x + 1, y + h - 3, w - 2, 2, PALETTE.parchmentShade);
  drawText(g, text, x + Math.floor(w / 2) + 1, y + 4, { scale: 2, color, align: 'center' });
}

const KEY_H = 24;

/** Keycap width: single characters print large, key names (ENTER, SPACE) small. */
function keycapWidth(text: string): number {
  return Array.from(text).length === 1 ? KEY_H : measureText(text, 1) + 14;
}

function keycap(g: Ctx, x: number, y: number, text: string): number {
  const w = keycapWidth(text);
  const h = KEY_H;
  const big = Array.from(text).length === 1;
  fill(g, x, y, w, h, PALETTE.ink);
  fill(g, x + 1, y + 1, w - 2, h - 2, PALETTE.parchmentShade);
  fill(g, x + 2, y + 1, w - 4, h - 6, PALETTE.parchment);
  fill(g, x + 2, y + 1, w - 4, 1, '#fbf6e9');
  fill(g, x + 2, y + h - 5, w - 4, 1, PALETTE.parchmentDark);
  drawText(g, text, x + Math.floor(w / 2) + 1, y + (big ? 3 : 7), { scale: big ? 2 : 1, color: PALETTE.ink, align: 'center' });
  return w;
}

// ----- Title card -----

const CONTOUR_M = Math.round(CONTOUR_INTERVAL * MAX_ELEV_M);

// Card plus shadow centred on the map area, CARD_INSET inside the neatline: clear of the HUD.
export const TITLE_W = MAP_PX_W - 2 * CARD_INSET - CARD_SHADOW;
const TITLE_H = 660;

/**
 * Where the lower part of the title card sits (card-relative y): the begin prompt, the button row and
 * the footer line. The Steam edition adds a second row for the Survey Contracts, moving the rest up and
 * the footer down a little; the itch edition keeps its layout exactly.
 */
export function titleLayout(steam: boolean): { prompt: number; buttons: number; contracts: number | null; footer: number } {
  return steam
    ? { prompt: 526, buttons: 556, contracts: 590, footer: TITLE_H - 34 }
    : { prompt: 538, buttons: 576, contracts: null, footer: TITLE_H - 42 };
}
const TITLE_X = MAP_ORIGIN_X + CARD_INSET;
const TITLE_Y = MAP_ORIGIN_Y + Math.floor((MAP_PX_H - TITLE_H - CARD_SHADOW) / 2);

function paintTitleCard(g: Ctx): void {
  const w = TITLE_W;
  const h = TITLE_H;
  const mid = Math.floor(w / 2);
  paintPaper(g, w, h, 1898);
  paintNeatline(g, w, h, PALETTE.redInk);

  drawText(g, t('tagline'), mid, 34, { color: PALETTE.inkFaded, align: 'center' });
  drawText(g, 'THE CARTO-ROGUE', mid, 52, {
    scale: 5,
    color: PALETTE.ink,
    align: 'center',
    shadow: PALETTE.parchmentShade,
    shadowOffset: 3,
  });
  drawHangulTitle(g, mid, 100, 3, PALETTE.redInk, 'center', PALETTE.parchmentShade);
  rule(g, mid, 148, 300, PALETTE.inkFaded, PALETTE.redInk);
  drawText(g, t('premise'), mid, 160, { scale: 2, color: PALETTE.ink, align: 'center' });

  // Left column: how to play.
  const lx = 56;
  const colTop = 204;
  drawText(g, t('howToPlay'), lx, colTop, { scale: 2, color: PALETTE.redInk });
  fill(g, lx, colTop + 18, 420, 1, PALETTE.inkFaded);
  const rows: [string, string, string][] = [
    [`${COST_FLAT}`, PALETTE.green, t('ruleFlat')],
    [`${COST_GENTLE}`, AMBER_INK, t('ruleGentle')],
    [`${COST_STEEP}`, PALETTE.redInk, t('ruleSteep')],
    ['X', PALETTE.inkFaded, t('ruleBlock')],
    [`+${CACHE_RESTORE}`, PALETTE.brassDark, t('ruleCache')],
  ];
  rows.forEach(([badge, color, text], k) => {
    const ry = colTop + 30 + k * 32;
    costBadge(g, lx, ry, badge, color);
    drawText(g, text, lx + 56, ry + 4, { scale: 2, color: PALETTE.ink });
  });
  const eyeY = colTop + 30 + rows.length * 32;
  fill(g, lx, eyeY, 44, 22, PALETTE.ink);
  fill(g, lx + 1, eyeY + 1, 42, 20, PALETTE.parchmentDark);
  symEye(g, lx + 2, eyeY + 2);
  drawText(g, t('ruleSight'), lx + 56, eyeY + 4, { scale: 2, color: PALETTE.ink });
  drawText(g, t('ruleSightTiles', { a: VISION_LOW, b: VISION_MID, c: VISION_HIGH }), lx + 56, eyeY + 23, { color: PALETTE.inkSoft });
  // The last step is judged after arrival, so a cache or the pillar still catches it.
  drawText(g, t('ruleStamina', { max: MAX_STAMINA }), lx, eyeY + 38, {
    color: PALETTE.inkSoft,
  });
  drawText(g, t('ruleLastStep'), lx, eyeY + 49, {
    color: PALETTE.inkSoft,
  });

  // Right column: map legend. Its rule ends as far from the right edge as the left column starts.
  const rx = w - lx - 334;
  drawText(g, t('mapLegend'), rx, colTop, { scale: 2, color: PALETTE.redInk });
  fill(g, rx, colTop + 18, 334, 1, PALETTE.inkFaded);
  const legend: [(gg: Ctx, x: number, y: number) => void, string][] = [
    [symContour, t('legendContour', { m: CONTOUR_M })],
    [symIndexContour, t('legendIndex', { m: CONTOUR_M * INDEX_CONTOUR_EVERY })],
    [symSightLine, t('legendSight', { a: toMeters(VISION_MID_MIN), b: toMeters(VISION_HIGH_MIN) })],
    [symCliff, t('legendCliff')],
    [symWater, t('legendWater')],
    [symCache, t('legendCache')],
    [symTrig, t('legendTrig')],
  ];
  legend.forEach(([sym, text], k) => {
    const ry = colTop + 30 + k * 32;
    sym(g, rx + 2, ry + 2);
    drawText(g, text, rx + 58, ry + 4, { scale: 2, color: PALETTE.ink });
  });

  // Controls strip.
  const cy = 474;
  rule(g, mid, cy - 14, 420, PALETTE.inkPale, PALETTE.inkFaded);
  const items: ({ key: string } | { text: string })[] = [
    { key: 'W' },
    { key: 'A' },
    { key: 'S' },
    { key: 'D' },
    { text: '/' },
    { key: '↑' },
    { key: '←' },
    { key: '↓' },
    { key: '→' },
    { text: t('move') },
    { key: 'R' },
    { text: t('newMap') },
    { key: 'M' },
    { text: t('mute') },
    { key: 'ENTER' },
    { key: 'SPACE' },
    { text: t('confirm') },
  ];
  const widthOf = (it: { key: string } | { text: string }): number =>
    'key' in it ? keycapWidth(it.key) : measureText(it.text, 2);
  const gapAfter = (k: number): number => {
    const it = items[k];
    const next = items[k + 1];
    if (!next) return 0;
    if ('key' in it && 'key' in next) return 4;
    if ('text' in it && it.text === '/') return 8;
    if ('key' in it) return 8;
    return 'text' in next && next.text === '/' ? 8 : 30;
  };
  let total = 0;
  items.forEach((it, k) => {
    total += widthOf(it) + gapAfter(k);
  });
  let ix = mid - Math.floor(total / 2);
  items.forEach((it, k) => {
    if ('key' in it) keycap(g, ix, cy, it.key);
    else drawText(g, it.text, ix, cy + 5, { scale: 2, color: it.text === '/' ? PALETTE.inkFaded : PALETTE.ink });
    ix += widthOf(it) + gapAfter(k);
  });
  drawText(g, t('titleFootnote'), mid, cy + 36, {
    color: PALETTE.inkFaded,
    align: 'center',
  });
}

function drawTitle(ctx: Ctx, state: GameState, now: number): void {
  const e = easeOutCubic((now - state.phaseStart) / 400);
  veil(ctx, e);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * e;
  const x = TITLE_X;
  const y = TITLE_Y + Math.round((1 - e) * 24);
  blitCard(ctx, 'title', TITLE_W, TITLE_H, x, y, paintTitleCard);
  const mid = x + Math.floor(TITLE_W / 2);
  const layout = titleLayout(EDITION === 'steam');
  const blink = (now - state.phaseStart) % 1100 < 760;
  if (blink) {
    drawText(ctx, t('pressBegin'), mid, y + layout.prompt, {
      scale: 3,
      color: PALETTE.redInk,
      align: 'center',
      shadow: PALETTE.parchmentShade,
      shadowOffset: 2,
    });
  }
  buttonRow(ctx, titleButtonSpecs(state), mid, y + layout.buttons);
  if (EDITION === 'steam' && layout.contracts !== null) buttonRow(ctx, [contractsEntrySpec()], mid, y + layout.contracts);
  const footer = y + layout.footer;
  drawSheetNo(ctx, state, x + TITLE_W - 36, footer);
  drawText(ctx, t('contourInterval', { m: CONTOUR_M }), x + 36, footer, { color: PALETTE.inkFaded });
  if (state.mode === 'explorer') {
    drawText(ctx, t('explorerNote'), mid, footer, { color: PALETTE.redInk, align: 'center' });
  } else {
    drawText(ctx, t('archivesHint'), mid, footer, { color: PALETTE.inkFaded, align: 'center' });
  }
  ctx.globalAlpha = prev;
}

// ----- Grade stamps -----

/** Seal / stamp 'S' with both ends rounded: at 7x the font's square-cornered S reads as a 5. */
const GRADE_S: readonly string[] = ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'];

/** The grade letter on a seal or stamp, top-left at (x, y). */
function drawGrade(g: Ctx, grade: string, x: number, y: number, scale: number, color: string): void {
  if (grade === 'S') drawArt(g, GRADE_S, { '#': color }, x, y, scale);
  else drawText(g, grade, x, y, { scale, color });
}

function paintWaxSeal(g: Ctx, grade: string, R: number): void {
  const c = R + 4;
  const rnd = mulberry32(grade.charCodeAt(0) * 7919 + R);
  const ph1 = rnd() * 6.28;
  const ph2 = rnd() * 6.28;
  const edgeR = (a: number): number => R + 1.6 * Math.sin(a * 7 + ph1) + 1.1 * Math.sin(a * 12 + ph2) + 0.6 * Math.sin(a * 3);
  for (let dy = -c; dy <= c; dy++) {
    for (let dx = -c; dx <= c; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.atan2(dy, dx);
      const er = edgeR(a);
      const x = c + dx;
      const y = c + dy;
      if (d > er + 0.5) {
        // Drop shadow of the wax blob.
        const sd = Math.sqrt((dx - 2) * (dx - 2) + (dy - 3) * (dy - 3));
        if (sd <= er + 0.5 && bayerOn(x, y, 8)) px(g, x, y, '#3a1a12');
        continue;
      }
      const light = d > 0 ? (-dx - dy) / (d * Math.SQRT2) : 0;
      let col: string = PALETTE.redInk;
      if (d > er - 2) col = light > 0.2 ? '#b8412c' : '#6e1d14';
      else if (d > R - 9 && d <= R - 7) col = light > 0 ? '#c9563c' : '#8a271b';
      else if (d > R - 11 && d <= R - 9) col = light > 0 ? '#6e1d14' : '#b8412c';
      else if (light > 0.35 && bayerOn(x, y, Math.round((light - 0.35) * 14))) col = '#b33a27';
      else if (light < -0.35 && bayerOn(x, y, Math.round((-light - 0.35) * 14))) col = '#7c2117';
      px(g, x, y, col);
    }
  }
  // Beads around the rim.
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const bx = Math.round(c + Math.cos(a) * (R - 4.5));
    const by = Math.round(c + Math.sin(a) * (R - 4.5));
    px(g, bx, by, '#6e1d14');
    px(g, bx - 1, by - 1, '#c9563c');
  }
  const scale = grade.length > 1 ? 4 : 7;
  const tw = measureText(grade, scale);
  const tx = c - Math.floor(tw / 2);
  const ty = c - Math.floor((7 * scale) / 2);
  drawGrade(g, grade, tx + 2, ty + 2, scale, '#5a150e');
  drawGrade(g, grade, tx - 1, ty - 1, scale, '#d8735a');
  drawGrade(g, grade, tx, ty, scale, '#b8412c');
}

function paintInkStamp(g: Ctx, grade: string, R: number): void {
  const c = R + 4;
  const rnd = mulberry32(grade.charCodeAt(0) * 104729 + R);
  const ink = PALETTE.inkSoft;
  for (let dy = -c; dy <= c; dy++) {
    for (let dx = -c; dx <= c; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      const ring = (d > R - 3 && d <= R) || (d > R - 7 && d <= R - 5.5);
      if (ring && rnd() > 0.14) px(g, c + dx, c + dy, ink);
    }
  }
  const scale = grade.length > 1 ? 4 : 7;
  const tw = measureText(grade, scale);
  drawGrade(g, grade, c - Math.floor(tw / 2), c - Math.floor((7 * scale) / 2), scale, ink);
  // Worn rubber: knock random paper-coloured holes into the letter.
  for (let k = 0; k < 70; k++) {
    const hx = c - Math.floor(tw / 2) + Math.floor(rnd() * tw);
    const hy = c - Math.floor((7 * scale) / 2) + Math.floor(rnd() * 7 * scale);
    px(g, hx, hy, PALETTE.parchmentDark);
  }
}

function drawStamp(ctx: Ctx, grade: string, style: 'wax' | 'ink', cx: number, cy: number, R: number): void {
  const size = (R + 4) * 2 + 1;
  const key = `stamp|${style}|${grade}|${R}`;
  let img = cardCache.get(key);
  if (img === undefined) {
    const made = makeCanvas(size, size);
    if (made) {
      if (style === 'wax') paintWaxSeal(made.g, grade, R);
      else paintInkStamp(made.g, grade, R);
      img = made.canvas;
    } else {
      img = null;
    }
    cardCache.set(key, img);
  }
  const x = cx - (R + 4);
  const y = cy - (R + 4);
  if (img) {
    ctx.drawImage(img, x, y);
  } else {
    ctx.save();
    ctx.translate(x, y);
    if (style === 'wax') paintWaxSeal(ctx, grade, R);
    else paintInkStamp(ctx, grade, R);
    ctx.restore();
  }
}

// ----- End cards -----

function statsFor(state: GameState, now: number): ExpeditionStats {
  if (state.finalStats) return state.finalStats;
  return {
    outcome: state.phase === 'victory' ? 'victory' : 'defeat',
    turns: state.turns,
    staminaSpent: state.staminaSpent,
    staminaLeft: Math.max(0, state.stamina),
    cachesCollected: cachesCollected(state),
    cachesTotal: state.map.caches.length,
    maxElevation: state.maxElevation,
    percentMapped: (state.revealedCount / (MAP_W * MAP_H)) * 100,
    elapsedMs: elapsedMs(state, now),
    grade: '?',
    breakdown: null,
  };
}

/** Name ....... value rows at 2x; a row's optional third entry inks its value in that colour. */
function statRows(
  ctx: Ctx,
  rows: readonly (readonly [string, string, string?])[],
  x: number,
  y: number,
  w: number,
  rowH: number,
): void {
  rows.forEach(([name, value, color], k) => {
    const ry = y + k * rowH;
    drawText(ctx, name, x, ry, { scale: 2, color: PALETTE.inkSoft });
    drawText(ctx, value, x + w, ry, { scale: 2, color: color ?? PALETTE.ink, align: 'right' });
    for (let xx = x + measureText(name, 2) + 6; xx < x + w - measureText(value, 2) - 6; xx += 4) {
      px(ctx, xx, ry + 12, PALETTE.inkPale);
    }
  });
}

// Both end cards are expedition reports of one size, tucked into a corner of the sheet so the
// surveyed route and the terrain around it stay readable beside them.
const DEFEAT_W = 600;
const DEFEAT_H = 440;
const VICTORY_W = 600;
const VICTORY_H = 440;
/**
 * Top of the footer line (cause / pillar note on the left, sheet number on the right), measured up
 * from the card's bottom edge. The neatline's inner rule lies 20 px up, so even a 12 px Hangul line
 * ends 2 px clear of it.
 */
const REPORT_FOOT_Y = 34;
/**
 * Height of the foot of either report card (summary line, map key, both button rows, prompt, footer),
 * measured up from the card's bottom edge. Everything above it (headline, stats or breakdown, grade)
 * ends by DEFEAT_H - REPORT_FOOT_H on a plain card.
 */
const REPORT_FOOT_H = 164;

/** A plain card's paper is cached as `kind`; one stretched for a Contract band by its height too. */
function cardKey(kind: 'victory' | 'defeat', h: number, plainH: number): string {
  return h === plainH ? kind : `${kind}-${h}`;
}

function paintDefeatCard(g: Ctx, h: number): void {
  paintPaper(g, DEFEAT_W, h, 404);
  paintNeatline(g, DEFEAT_W, h, PALETTE.inkFaded);
  drawText(g, t('causeExhaustion'), 36, h - REPORT_FOOT_Y, { color: PALETTE.inkFaded });
  const mid = Math.floor(DEFEAT_W / 2);
  drawText(g, t('finalEntry'), mid, 34, { color: PALETTE.inkFaded, align: 'center' });
  drawText(g, t('collapsed'), mid, 52, {
    scale: 3,
    color: PALETTE.ink,
    align: 'center',
    shadow: PALETTE.parchmentShade,
    shadowOffset: 2,
  });
  // The subtitle under the headline depends on the sheet (see defeatSubtitle) and is drawn per frame.
  rule(g, mid, 110, 240, PALETTE.inkFaded, PALETTE.redInk);
}

/** Top of the defeat card's subtitle, under the headline. */
const DEFEAT_SUBTITLE_Y = 84;
/** The defeat card's stat rows: top of the first and the row pitch (six rows clear the summary line). */
const DEFEAT_ROWS_Y = 122;
const DEFEAT_ROW_H = 25;
/** Width of a stat row (name, leader dots, value); it ends well clear of the grade stamp. */
const DEFEAT_ROW_W = 344;

/**
 * The defeat card's subtitle: on a sheet the generator proved solvable (every generated one), that a
 * route to the Trig Pillar existed. Retrospective and route-free: it names no path and no number.
 */
export function defeatSubtitle(map: MapData): string {
  return provenSolvable(map) ? t('sheetHadRoute') : t('inkBleeds');
}

/**
 * Blots that soak into the defeat card as it appears: [x, y, radius, delay 0..1]. The lower
 * two sit in the bottom corners, outside the button rows, so their drips never reach a label.
 */
const BLOTS: readonly (readonly [number, number, number, number])[] = [
  [30, DEFEAT_H - 66, 9, 0],
  [DEFEAT_W - 32, DEFEAT_H - 70, 7, 0.3],
  [DEFEAT_W - 46, 46, 5, 0.55],
  [44, 58, 4, 0.75],
];

/** Relative lengths of a blot's drips, so no two runs look alike. */
const DRIP_LENGTH: readonly number[] = [1, 0.5, 0.75];

/** One ink blot: solid core, feathered (dithered) rim, lobes, droplets and runs. */
function inkBlot(ctx: Ctx, cx: number, cy: number, r: number, grow: number, seed: number): void {
  if (grow <= 0) return;
  const rnd = mulberry32(seed);
  const rr = Math.max(1, Math.round(r * grow));
  const halo = rr + 3;
  for (let dy = -halo; dy <= halo; dy++) {
    for (let dx = -halo; dx <= halo; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > rr + 0.5 && d <= halo + 0.5 && bayerOn(cx + dx, cy + dy, d <= rr + 1.5 ? 8 : 3)) {
        px(ctx, cx + dx, cy + dy, PALETTE.inkSoft);
      }
    }
  }
  disc(ctx, cx, cy, rr, PALETTE.ink);
  for (let k = 0; k < 5; k++) {
    const a = rnd() * Math.PI * 2;
    const lr = Math.max(1, Math.round(rr * (0.3 + rnd() * 0.3)));
    disc(ctx, Math.round(cx + Math.cos(a) * rr * 0.85), Math.round(cy + Math.sin(a) * rr * 0.85), lr, PALETTE.ink);
  }
  for (let k = 0; k < 7; k++) {
    const a = rnd() * Math.PI * 2;
    const d = rr + 3 + rnd() * 12 * grow;
    const dr = rnd() < 0.3 ? 1 : 0;
    disc(ctx, Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d), dr, PALETTE.ink);
  }
  // Runs: two or three drips of different lengths, spread across the blot's lower half.
  // Each wobbles a pixel either way, tapers from 2 px to 1 px and ends in a rounded bulb.
  const drips = rr >= 9 ? 3 : 2;
  for (let k = 0; k < drips; k++) {
    const rx = Math.round(cx + rr * (((k + 0.25 + rnd() * 0.5) / drips) * 1.2 - 0.6));
    const len = Math.round((6 + rnd() * 12) * DRIP_LENGTH[k] * grow);
    if (len < 2) continue;
    const yEnd = cy + rr + len;
    const taper = cy + rr + Math.round(len * 0.6);
    let prevL = rx;
    let prevR = rx + 1;
    for (let yy = cy; yy <= yEnd; yy++) {
      let l = rx + Math.round(Math.sin(yy / 5 + k * 2.3) * 0.6);
      let r = l + (yy < taper ? 1 : 0);
      // Keep every row touching the one above (no corner-only steps), so the run never looks broken.
      if (r < prevL) r = prevL;
      if (l > prevR) l = prevR;
      fill(ctx, l, yy, r - l + 1, 1, PALETTE.ink);
      prevL = l;
      prevR = r;
    }
    dripBulb(ctx, prevL, yEnd + 1, len >= 8);
  }
}

/** Rounded bulb at the foot of a 1 px drip in column x, starting at row y. */
function dripBulb(ctx: Ctx, x: number, y: number, big: boolean): void {
  if (big) {
    fill(ctx, x, y, 2, 1, PALETTE.ink);
    fill(ctx, x - 1, y + 1, 4, 2, PALETTE.ink);
    fill(ctx, x, y + 3, 2, 1, PALETTE.ink);
  } else {
    fill(ctx, x - 1, y, 3, 2, PALETTE.ink);
    px(ctx, x, y + 2, PALETTE.ink);
  }
}

/** The ink bleeds out: blots spread over ~1.6 s after the card appears. The lower blots keep to the
 * bottom corners of a card `h` tall. */
function drawBleed(ctx: Ctx, x: number, y: number, h: number, t: number): void {
  BLOTS.forEach(([bx, by, r, delay], k) => {
    const grow = easeOutCubic(clamp01((t - delay * 0.5) / 0.5));
    inkBlot(ctx, x + bx, y + by + (by > DEFEAT_H / 2 ? h - DEFEAT_H : 0), r, grow, 900 + k);
  });
}

function paintVictoryCard(g: Ctx, h: number): void {
  paintPaper(g, VICTORY_W, h, 1200);
  paintNeatline(g, VICTORY_W, h, PALETTE.redInk);
  const mid = Math.floor(VICTORY_W / 2);
  drawText(g, t('expeditionComplete'), mid, 34, { color: PALETTE.inkFaded, align: 'center' });
  drawText(g, t('summitReached'), mid, 48, {
    scale: 4,
    color: PALETTE.ink,
    align: 'center',
    shadow: PALETTE.parchmentShade,
    shadowOffset: 2,
  });
  const tw = measureText(t('summitReached'), 4);
  symTrig(g, mid - Math.floor(tw / 2) - 62, 53);
  symTrig(g, mid + Math.floor(tw / 2) + 22, 53);
  drawText(g, t('ancientTrig'), mid, 88, { scale: 2, color: PALETTE.redInk, align: 'center' });
  rule(g, mid, 112, 240, PALETTE.inkFaded, PALETTE.redInk);
  drawText(g, t('pillarOccupied'), 36, h - REPORT_FOOT_Y, { color: PALETTE.inkFaded });
}

/** Clear sheet wanted between the summit and the victory card (the radiance disc is ~42 px). */
const SUMMIT_CLEARANCE = 48;

/** Surveyed tiles whose centres lie under the box (x, y, w, h); route tiles count nine times. */
function surveyUnder(state: GameState, x: number, y: number, w: number, h: number): number {
  const tx0 = Math.max(0, Math.ceil((x - MAP_ORIGIN_X) / TILE - 0.5));
  const tx1 = Math.min(MAP_W, Math.ceil((x + w - MAP_ORIGIN_X) / TILE - 0.5));
  const ty0 = Math.max(0, Math.ceil((y - MAP_ORIGIN_Y) / TILE - 0.5));
  const ty1 = Math.min(MAP_H, Math.ceil((y + h - MAP_ORIGIN_Y) / TILE - 0.5));
  let n = 0;
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) n += state.revealed[tileIndex(tx, ty)];
  }
  // The route is what the report is read by, so a corner hiding less of it wins over plain survey.
  for (const p of state.trail) if (p.x >= tx0 && p.x < tx1 && p.y >= ty0 && p.y < ty1) n += 8;
  return n;
}

/**
 * Top-left of an end card (card w x h), in one of the four map-area corners (inside the neatline,
 * shadow included). The corner that leaves the focus tile (the summit after a victory, the place
 * of collapse after a defeat) clearest wins (a focus under every corner goes to the one it sits
 * least deep in); among corners that all leave it clear, the one hiding the least of the survey
 * and its route, then the one farthest from the focus.
 */
function reportCardOrigin(state: GameState, cardW: number, cardH: number, focus: Point): Pt {
  const sx = MAP_ORIGIN_X + (focus.x + 0.5) * TILE;
  const sy = MAP_ORIGIN_Y + (focus.y + 0.5) * TILE;
  const w = cardW + CARD_SHADOW;
  const h = cardH + CARD_SHADOW;
  const left = MAP_ORIGIN_X + CARD_INSET;
  const right = MAP_ORIGIN_X + MAP_PX_W - CARD_INSET - w;
  const top = MAP_ORIGIN_Y + CARD_INSET;
  const bottom = MAP_ORIGIN_Y + MAP_PX_H - CARD_INSET - h;
  let best: Pt = [left, top];
  let bestClear = -Infinity;
  let bestHidden = Infinity;
  let bestFar = -1;
  for (const y of [top, bottom]) {
    for (const x of [left, right]) {
      // Distance from the summit to the card; negative (depth) when the card covers it.
      const gapX = Math.max(x - sx, 0, sx - (x + w));
      const gapY = Math.max(y - sy, 0, sy - (y + h));
      const depth = Math.min(sx - x, x + w - sx, sy - y, y + h - sy);
      const clear = Math.min(SUMMIT_CLEARANCE, gapX > 0 || gapY > 0 ? Math.hypot(gapX, gapY) : -depth);
      const hidden = surveyUnder(state, x, y, w, h);
      const far = Math.hypot(x + w / 2 - sx, y + h / 2 - sy);
      const better =
        clear !== bestClear ? clear > bestClear : hidden !== bestHidden ? hidden < bestHidden : far > bestFar;
      if (better) {
        best = [x, y];
        bestClear = clear;
        bestHidden = hidden;
        bestFar = far;
      }
    }
  }
  return best;
}

/** Eased 0..1 progress of the ~400 ms fade / slide-in after the phase began. */
function endCardAnim(state: GameState, now: number): number {
  return easeOutCubic((now - state.phaseStart) / 400);
}

/** Sheet number footer, right-aligned. The seed prints unpadded, as in the sheet header. */
function drawSheetNo(ctx: Ctx, state: GameState, right: number, y: number): void {
  drawText(ctx, t('sheetNo', { seed: state.seed }), right, y, { color: PALETTE.inkFaded, align: 'right' });
}


/** Card position for this end: the chosen corner, sliding in from the sheet's middle. */
function reportPlacement(state: GameState, now: number, w: number, h: number): { x: number; y: number; restY: number } {
  const focus = state.phase === 'victory' ? state.map.summit : state.player;
  const [x, restY] = reportCardOrigin(state, w, h, focus);
  const inward = restY + h / 2 < MAP_ORIGIN_Y + MAP_PX_H / 2 ? 1 : -1;
  return { x, y: restY + inward * Math.round((1 - endCardAnim(state, now)) * 40), restY };
}

/** With the card tucked away only a SHOW REPORT tab stays, at the card's corner of the sheet. */
function drawReportTab(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const spec: ButtonSpec = { id: 'toggleCard', runs: [[t('showReport'), PALETTE.redInk]] };
  const bw = buttonWidth(spec);
  const right = x + w / 2 > MAP_ORIGIN_X + MAP_PX_W / 2;
  const bottom = y + h / 2 > MAP_ORIGIN_Y + MAP_PX_H / 2;
  paperButton(ctx, spec, right ? x + w + CARD_SHADOW - bw - 2 : x, bottom ? y + h + CARD_SHADOW - BTN_H - 2 : y);
}

/** The summary line, the map key and both button rows at the foot of either report card. */
function drawReportFoot(ctx: Ctx, state: GameState, s: ExpeditionStats, x: number, y: number, w: number, h: number): void {
  const report = reportFor(state);
  const cx = x + Math.floor(w / 2);
  drawText(
    ctx,
    t('reportLine', {
      t: s.turns,
      time: formatTime(s.elapsedMs),
      c: `${s.cachesCollected}/${s.cachesTotal}`,
      m: toMeters(s.maxElevation),
    }),
    x + 36,
    y + h - 164,
    { color: PALETTE.inkSoft },
  );
  drawReportKey(ctx, x + 36, y + h - 148);
  buttonRow(ctx, [
    { id: 'retrySheet', runs: [[t('retrySheet'), PALETTE.redInk]], selected: report.choice === 'retry' },
    { id: 'newExpedition', runs: [[t('newExpedition'), PALETTE.ink]], selected: report.choice === 'new' },
  ], cx, y + h - 124);
  buttonRow(ctx, [
    { id: 'copySeed', runs: [[t('copySeed'), PALETTE.ink]], icon: 'pin' },
    { id: 'share', runs: [[t('shareResult'), PALETTE.ink]], icon: 'share' },
    { id: 'toggleCard', runs: [[t('hideCard'), PALETTE.inkSoft]] },
  ], cx, y + h - 90);
  drawText(ctx, t('endPrompt'), cx, y + h - 54, { color: PALETTE.inkFaded, align: 'center' });
  drawSheetNo(ctx, state, x + w - 36, y + h - REPORT_FOOT_Y);
}

/**
 * Key to the report map, in the sheet's own symbols: the route inked by step cost (dashed 1,
 * solid 3, heavy 8), Supply Camps visited / seen / never found, and the ground never surveyed.
 */
function drawReportKey(ctx: Ctx, x: number, y: number): void {
  const gap = 12;
  const label = (text: string, lx: number): number => {
    drawText(ctx, text, lx, y + 2, { color: PALETTE.inkSoft });
    return lx + measureText(text) + gap;
  };
  const mid = y + 5;
  let cx = x;
  for (let k = 0; k < 3; k++) fill(ctx, cx + k * 5, mid - 1, 3, 2, PALETTE.redInk);
  cx = label(`${COST_FLAT}`, cx + 16);
  fill(ctx, cx, mid - 1, 14, 2, PALETTE.redInk);
  cx = label(`${COST_GENTLE}`, cx + 17);
  fill(ctx, cx, mid - 2, 14, 4, PALETTE.redInk);
  cx = label(`${COST_STEEP}`, cx + 17) + 4;
  // Supply Camps, as the sheet draws them after an expedition.
  drawArt(ctx, ART_CRATE, OBJECT_COLORS, cx, y - 2, 1);
  line(ctx, cx + 11, y + 4, cx + 12, y + 5, PALETTE.green);
  line(ctx, cx + 12, y + 5, cx + 15, y + 1, PALETTE.green);
  cx = label(t('keyVisited'), cx + 18);
  drawArt(ctx, ART_CRATE, OBJECT_COLORS, cx, y - 2, 1);
  cx = label(t('keySeen'), cx + 13);
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * REPORT_GHOST_ALPHA;
  drawArt(ctx, ART_CRATE, OBJECT_COLORS, cx, y - 2, 1);
  ctx.globalAlpha = a;
  drawText(ctx, '?', cx + 10, y - 3, { color: PALETTE.inkFaded });
  cx = label(t('keyMissed'), cx + 17);
  // Unsurveyed ground: the sheet seen through the fog.
  fill(ctx, cx, y - 1, 14, 10, PALETTE.fog);
  for (let k = 0; k < 14; k += 3) px(ctx, cx + k, y + 7 - Math.floor(k / 2), PALETTE.fogSpeck);
  outline(ctx, cx, y - 1, 14, 10, PALETTE.inkPale);
  label(t('keyUnseen'), cx + 18);
}

/** Supply Camps never sighted are drawn at this opacity on the report map and in its key. */
export const REPORT_GHOST_ALPHA = 0.45;

/** Row height of the grade breakdown (name, bar and points, then a small note beneath). */
const BREAKDOWN_ROW_H = 38;
const BREAKDOWN_LABEL_W = 104;
const BREAKDOWN_BAR_W = 140;
const BREAKDOWN_POINTS_W = 68;

/**
 * Route / Reserve / Survey as they were graded: a bar for each part (0..1), its whole points out
 * of 40 / 35 / 25, what it measured, then the total out of 100 and the grade thresholds.
 */
function drawBreakdown(ctx: Ctx, b: GradeBreakdown, s: ExpeditionStats, x: number, y: number): void {
  const pts = gradePoints(b);
  const full = (w: number): number => Math.round(w * 100);
  const rows: [string, number, number, number, string][] = [
    [t('gradeRoute'), b.route, pts.route, full(GRADE_WEIGHTS.route),
      t('gradeRouteNote', { p: Math.round(b.route * 100), n: s.staminaSpent })],
    [t('gradeReserve'), b.reserve, pts.reserve, full(GRADE_WEIGHTS.reserve),
      t('gradeReserveNote', { n: Math.max(0, Math.round(s.staminaLeft)), full: RESERVE_FULL_MARKS })],
    [t('gradeSurvey'), b.survey, pts.survey, full(GRADE_WEIGHTS.survey),
      t('gradeSurveyNote', { p: formatPercent(s.percentMapped).replace('%', ''), full: SURVEY_FULL_MARKS })],
  ];
  const barX = x + BREAKDOWN_LABEL_W;
  const right = barX + BREAKDOWN_BAR_W + BREAKDOWN_POINTS_W;
  rows.forEach(([name, value, points, max, note], k) => {
    const ry = y + k * BREAKDOWN_ROW_H;
    drawText(ctx, name, x, ry, { scale: 2, color: PALETTE.ink });
    outline(ctx, barX, ry + 2, BREAKDOWN_BAR_W, 11, PALETTE.ink);
    fill(ctx, barX + 1, ry + 3, BREAKDOWN_BAR_W - 2, 9, PALETTE.parchmentShade);
    const fillW = Math.round((BREAKDOWN_BAR_W - 2) * clamp01(value));
    if (fillW > 0) fill(ctx, barX + 1, ry + 3, fillW, 9, PALETTE.redInk);
    drawText(ctx, `${points}/${max}`, right, ry, { scale: 2, color: PALETTE.ink, align: 'right' });
    drawText(ctx, note, x, ry + 19, { color: PALETTE.inkSoft });
  });
  const sy = y + rows.length * BREAKDOWN_ROW_H;
  drawText(ctx, t('gradeScore'), x, sy, { scale: 2, color: PALETTE.ink });
  drawText(ctx, `${pts.total}/100`, right, sy, { scale: 2, color: PALETTE.redInk, align: 'right' });
  for (let xx = x + measureText(t('gradeScore'), 2) + 6; xx < right - measureText(`${pts.total}/100`, 2) - 6; xx += 4) {
    px(ctx, xx, sy + 12, PALETTE.inkPale);
  }
  const [[, s0], [, a0], [, b0]] = GRADE_THRESHOLDS;
  drawText(ctx, t('gradeScale', { s: full(s0), a: full(a0), b: full(b0) }), x, sy + 19, { color: PALETTE.inkSoft });
}

function drawGameOver(ctx: Ctx, state: GameState, now: number): void {
  const e = endCardAnim(state, now);
  const s = statsFor(state, now);
  // A Survey Contract expedition (Steam edition) adds its result band; any other keeps the plain card.
  const contract = EDITION === 'steam' ? contractReport(state) : null;
  const h = reportCardHeight(DEFEAT_H, contract);
  const { x, y, restY } = reportPlacement(state, now, DEFEAT_W, h);
  if (reportFor(state).cardHidden) {
    drawReportTab(ctx, x, restY, DEFEAT_W, h);
    return;
  }
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * e;
  // The paper swallows taps (only its buttons act); tapping the sheet beside it hides it.
  addButton('reportCard', x, y, DEFEAT_W, h);
  blitCard(ctx, cardKey('defeat', h, DEFEAT_H), DEFEAT_W, h, x, y, (g) => paintDefeatCard(g, h));
  const subtitle = defeatSubtitle(state.map);
  drawText(ctx, subtitle, x + Math.floor(DEFEAT_W / 2), y + DEFEAT_SUBTITLE_Y, { scale: 2, color: PALETTE.redInk, align: 'center' });
  drawBleed(ctx, x, y, h, clamp01((now - state.phaseStart) / 1600));
  // Where the stamina went: steep steps are what usually empties the pack. Cost-1 steps are split
  // into flat ground and descents, which cost the same now but give up height to be climbed again.
  const steps = tallySteps(state.map, state.trail, state.stepCosts);
  const row = (key: MessageKey, kind: keyof typeof steps, color?: string): [string, string, string?] => [
    t(key),
    t('stepsValue', { n: steps[kind].steps, cost: steps[kind].cost }),
    color,
  ];
  const rows: [string, string, string?][] = [
    [t('staminaSpent'), `${s.staminaSpent}`],
    row('stepsSteep', 'steep', PALETTE.redInk),
    row('stepsGentle', 'gentle'),
    row('stepsFlat', 'flat'),
    row('stepsDownhill', 'downhill'),
    [t('mapped'), formatPercent(s.percentMapped)],
  ];
  statRows(ctx, rows, x + 40, y + DEFEAT_ROWS_Y, DEFEAT_ROW_W, DEFEAT_ROW_H);
  const sx = x + DEFEAT_W - 118;
  const sy = y + 190;
  drawStamp(ctx, s.grade, 'ink', sx, sy, 50);
  drawText(ctx, t('grade'), sx + 1, sy + 62, { scale: 2, color: PALETTE.inkSoft, align: 'center' });
  if (contract) drawContractBand(ctx, contract, x, y + DEFEAT_H - REPORT_FOOT_H, DEFEAT_W);
  drawReportFoot(ctx, state, s, x, y, DEFEAT_W, h);
  ctx.globalAlpha = prev;
}

function drawVictory(ctx: Ctx, state: GameState, now: number): void {
  const e = endCardAnim(state, now);
  const s = statsFor(state, now);
  const contract = EDITION === 'steam' ? contractReport(state) : null;
  const h = reportCardHeight(VICTORY_H, contract);
  const { x, y, restY } = reportPlacement(state, now, VICTORY_W, h);
  if (reportFor(state).cardHidden) {
    drawReportTab(ctx, x, restY, VICTORY_W, h);
    return;
  }
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * e;
  addButton('reportCard', x, y, VICTORY_W, h);
  blitCard(ctx, cardKey('victory', h, VICTORY_H), VICTORY_W, h, x, y, (g) => paintVictoryCard(g, h));
  if (s.breakdown) drawBreakdown(ctx, s.breakdown, s, x + 36, y + 124);
  // The wax seal drops in shortly after the card settles.
  const since = now - state.phaseStart;
  const sealT = clamp01((since - 350) / 220);
  const sx = x + VICTORY_W - 96;
  const sealY = y + 188;
  if (sealT > 0) {
    const sy = sealY - Math.round((1 - easeOutCubic(sealT)) * 18);
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * sealT;
    drawStamp(ctx, s.grade, 'wax', sx, sy, 58);
    drawText(ctx, t('grade'), sx + 1, sealY + 72, { scale: 2, color: PALETTE.inkSoft, align: 'center' });
    ctx.globalAlpha = a;
  }
  if (contract) drawContractBand(ctx, contract, x, y + VICTORY_H - REPORT_FOOT_H, VICTORY_W);
  drawReportFoot(ctx, state, s, x, y, VICTORY_W, h);
  ctx.globalAlpha = prev;
}

// ----- Survey Contract band (Steam edition): this expedition's Contract result -----

/**
 * Room the Contract band takes, between a report card's body and its foot (the card grows by this).
 * Offsets inside it: a rule, the section label and the Contract's name with the result stamp beside
 * it, then one row per condition.
 */
export const CONTRACT_BAND_H = 92;
export const CONTRACT_BAND = { rule: 6, label: 12, name: 24, stampH: 28, rows: 46, rowPitch: 14, margin: 40 } as const;

/** One condition of the Contract and how this expedition left it. */
export interface ContractReportRow {
  label: string;
  status: 'met' | 'broken' | 'notReached';
}

/** The Contract band's content: which Contract, whether this expedition completed it, and why. */
export interface ContractReportView {
  name: string;
  completed: boolean;
  rows: ContractReportRow[];
}

/**
 * A condition's short label on the report. Every approved maxSteepSteps condition allows none
 * (max 0), which is what its label says; the sight line is the drawn 840 m one.
 */
export function conditionLabel(condition: ContractCondition): string {
  return condition.kind === 'maxSteepSteps'
    ? contractText('conditionNoSteep')
    : contractText('conditionHoldLine', { m: toMeters(VISION_HIGH_MIN) });
}

/**
 * The band for Contract `id` judged as `evaluation`: the summit first, then each condition met or
 * broken. A condition still open (unbroken when the surveyor collapsed) is left out: it was never
 * decided. No turn or count is shown.
 */
export function contractReportView(id: ContractId, evaluation: ContractEvaluation): ContractReportView {
  const rows: ContractReportRow[] = [
    { label: contractText('conditionSummit'), status: evaluation.summit ? 'met' : 'notReached' },
  ];
  for (const r of evaluation.conditions) {
    if (r.status !== 'open') rows.push({ label: conditionLabel(r.condition), status: r.status });
  }
  return { name: contractLines(id)[0], completed: evaluation.status === 'met', rows };
}

/** The finished expedition's Contract band, judged afresh from the expedition itself; null for any other. */
export function contractReport(state: GameState): ContractReportView | null {
  const evaluation = judgeContract(state);
  return evaluation && state.contract !== null ? contractReportView(state.contract, evaluation) : null;
}

/** A report card's height: `plainH`, or taller by the Contract band when there is one. */
export function reportCardHeight(plainH: number, contract: ContractReportView | null): number {
  return contract ? plainH + CONTRACT_BAND_H : plainH;
}

const CONTRACT_STATUS_TEXT: Readonly<Record<ContractReportRow['status'], ContractTextKey>> = {
  met: 'reportMet',
  broken: 'reportBroken',
  notReached: 'reportNotReached',
};

/** The result stamp's text and width (double rule, scale-2 text). */
export function contractStamp(completed: boolean): { text: string; w: number } {
  const text = contractText(completed ? 'reportCompleted' : 'reportNotCompleted');
  return { text, w: measureText(text, 2) + 20 };
}

/** The Contract band of a report card `w` wide, its top at `top` (where the plain card's foot began). */
function drawContractBand(ctx: Ctx, view: ContractReportView, x: number, top: number, w: number): void {
  const B = CONTRACT_BAND;
  const left = x + B.margin;
  const right = x + w - B.margin;
  rule(ctx, x + Math.floor(w / 2), top + B.rule, Math.floor(w / 2) - B.margin, PALETTE.inkFaded, PALETTE.redInk);
  drawText(ctx, contractText('reportContract'), left, top + B.label, { color: PALETTE.inkFaded });
  drawText(ctx, view.name, left, top + B.name, { scale: 2, color: PALETTE.ink });
  // The result as a stamp: red when the Contract was completed, plain ink when it was not.
  const stamp = contractStamp(view.completed);
  const color = view.completed ? PALETTE.redInk : PALETTE.inkSoft;
  const sx = right - stamp.w;
  const sy = top + B.label;
  outline(ctx, sx, sy, stamp.w, B.stampH, color);
  outline(ctx, sx + 2, sy + 2, stamp.w - 4, B.stampH - 4, color);
  drawText(ctx, stamp.text, sx + Math.floor(stamp.w / 2), sy + 7, { scale: 2, color, align: 'center' });
  view.rows.forEach((row, k) => {
    const ry = top + B.rows + k * B.rowPitch;
    const value = contractText(CONTRACT_STATUS_TEXT[row.status]);
    const valueColor = row.status === 'met' ? PALETTE.ink : PALETTE.redInk;
    drawText(ctx, row.label, left + 12, ry, { color: PALETTE.inkSoft });
    drawText(ctx, value, right, ry, { color: valueColor, align: 'right' });
    for (let xx = left + 12 + measureText(row.label) + 6; xx < right - measureText(value) - 6; xx += 4) {
      px(ctx, xx, ry + 6, PALETTE.inkPale);
    }
  });
}

// ----- Paper buttons (title and end cards) -----

export const BTN_H = 26;
const BTN_PAD = 10;
const BTN_ICON_W = 14;

type ButtonIcon = 'pin' | 'share' | 'seal' | 'keypad';

interface ButtonSpec {
  id: ButtonId;
  /** Text runs [text, colour]; drawn at 2x. */
  runs: readonly [string, string][];
  icon?: ButtonIcon;
  /** Keyboard selection (end cards): drawn like a hovered button, with a double red rule. */
  selected?: boolean;
}

/** Map-pin glyph for "copy seed link": '#' red ink, 'o' the hole. */
const PIN_ART: readonly string[] = [
  '..###..',
  '.#####.',
  '##ooo##',
  '##ooo##',
  '.#####.',
  '.#####.',
  '..###..',
  '..###..',
  '...#...',
  '...#...',
];

function drawButtonIcon(ctx: Ctx, icon: ButtonIcon, x: number, y: number, face: string): void {
  if (icon === 'pin') {
    drawArt(ctx, PIN_ART, { '#': PALETTE.redInk, o: face }, x + 3, y + 8, 1);
  } else if (icon === 'share') {
    // Arrow leaving an open box.
    fill(ctx, x + 1, y + 11, 1, 7, PALETTE.ink);
    fill(ctx, x + 1, y + 17, 9, 1, PALETTE.ink);
    fill(ctx, x + 9, y + 14, 1, 4, PALETTE.ink);
    fill(ctx, x + 1, y + 11, 3, 1, PALETTE.ink);
    line(ctx, x + 4, y + 14, x + 10, y + 8, PALETTE.redInk);
    line(ctx, x + 5, y + 14, x + 11, y + 8, PALETTE.redInk);
    fill(ctx, x + 7, y + 7, 5, 1, PALETTE.redInk);
    fill(ctx, x + 11, y + 7, 1, 5, PALETTE.redInk);
  } else if (icon === 'keypad') {
    // A 3x3 numeric keypad.
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) fill(ctx, x + 1 + c * 4, y + 8 + r * 4, 3, 3, r === 2 && c === 2 ? PALETTE.redInk : PALETTE.inkSoft);
    }
  } else {
    // A tiny wax seal.
    disc(ctx, x + 6, y + 13, 5, PALETTE.redInk);
    circle(ctx, x + 6, y + 13, 3, '#6e1d14');
    px(ctx, x + 4, y + 11, '#d8735a');
    px(ctx, x + 6, y + 13, '#d8735a');
  }
}

function runsWidth(runs: readonly [string, string][]): number {
  return measureText(runs.map(([s]) => s).join(''), 2);
}

function buttonWidth(spec: ButtonSpec): number {
  return BTN_PAD * 2 + (spec.icon ? BTN_ICON_W + 4 : 0) + runsWidth(spec.runs);
}

/** A parchment push-button with an ink rim; registers its hit box. Returns its width. */
function paperButton(ctx: Ctx, spec: ButtonSpec, x: number, y: number): number {
  const w = buttonWidth(spec);
  const hover = ui.hover === spec.id;
  const face = hover || spec.selected ? PALETTE.parchment : PALETTE.parchmentDark;
  fill(ctx, x + 2, y + 2, w, BTN_H, PALETTE.parchmentShade);
  fill(ctx, x, y, w, BTN_H, PALETTE.ink);
  fill(ctx, x + 1, y + 1, w - 2, BTN_H - 2, face);
  fill(ctx, x + 1, y + 1, w - 2, 1, '#fbf6e9');
  fill(ctx, x + 1, y + BTN_H - 3, w - 2, 2, PALETTE.parchmentShade);
  if (hover || spec.selected) outline(ctx, x + 2, y + 2, w - 4, BTN_H - 5, PALETTE.redInk);
  if (spec.selected) outline(ctx, x - 2, y - 2, w + 4, BTN_H + 4, PALETTE.redInk);
  let tx = x + BTN_PAD;
  if (spec.icon) {
    drawButtonIcon(ctx, spec.icon, tx, y - 4, face);
    tx += BTN_ICON_W + 4;
  }
  drawRuns(ctx, tx, y + 6, spec.runs, 2);
  addButton(spec.id, x, y, w, BTN_H);
  return w;
}

/** A row of buttons centred on cx. */
function buttonRow(ctx: Ctx, specs: readonly ButtonSpec[], cx: number, y: number, gap = 14): void {
  const total = buttonRowWidth(specs, gap);
  let x = cx - Math.floor(total / 2);
  for (const spec of specs) x += paperButton(ctx, spec, x, y) + gap;
}

function langToggleSpec(): ButtonSpec {
  const ko = getLang() === 'ko';
  return {
    id: 'lang',
    runs: [
      ['KO', ko ? PALETTE.redInk : PALETTE.inkPale],
      [' / ', PALETTE.inkFaded],
      ['EN', ko ? PALETTE.inkPale : PALETTE.redInk],
    ],
  };
}

/** STANDARD / EXPLORER, the chosen mode inked red (title card only). */
function modeToggleSpec(state: GameState): ButtonSpec {
  const explorer = state.mode === 'explorer';
  return {
    id: 'mode',
    runs: [
      [t('modeStandard'), explorer ? PALETTE.inkPale : PALETTE.redInk],
      [' / ', PALETTE.inkFaded],
      [t('modeExplorer'), explorer ? PALETTE.redInk : PALETTE.inkPale],
    ],
  };
}

/** The title card's button row, the same in both editions. */
export function titleButtonSpecs(state: GameState): ButtonSpec[] {
  return [
    langToggleSpec(),
    modeToggleSpec(state),
    { id: 'copySeed', runs: [[t('copySeed'), PALETTE.ink]], icon: 'pin' },
    { id: 'seedEntry', runs: [[t('enterSeed'), PALETTE.inkSoft]], icon: 'keypad' },
    { id: 'archives', runs: [[t('archives'), PALETTE.ink]], icon: 'seal' },
  ];
}

/** The Steam edition's second title row: the way into the Survey Contract card. */
export function contractsEntrySpec(): ButtonSpec {
  return { id: 'contracts', runs: [[contractText('contractsTitle'), PALETTE.ink]] };
}

/** Width of a buttonRow of `specs` (gap included), for layout checks. */
export function buttonRowWidth(specs: readonly ButtonSpec[], gap = 14): number {
  return specs.reduce((sum, s) => sum + buttonWidth(s), 0) + gap * (specs.length - 1);
}

// ----- Expedition archives (career ledger) -----

const ARCH_W = 620;
const ARCH_H = 470;
const ARCH_ROW_TOP = 150;
const ARCH_ROW_H = 38;
const ARCH_MARGIN_X = 74;
const LEDGER_RULE = '#b9c7c4';

function paintArchivesCard(g: Ctx): void {
  const w = ARCH_W;
  const h = ARCH_H;
  const mid = Math.floor(w / 2);
  paintPaper(g, w, h, 1703);
  paintNeatline(g, w, h, PALETTE.inkFaded);
  drawText(g, t('archivesSub'), mid, 34, { color: PALETTE.inkFaded, align: 'center' });
  drawText(g, t('archivesTitle'), mid, 56, {
    scale: 3,
    color: PALETTE.ink,
    align: 'center',
    shadow: PALETTE.parchmentShade,
    shadowOffset: 2,
  });
  rule(g, mid, 100, 220, PALETTE.inkFaded, PALETTE.redInk);
  // Ledger ruling: pale blue lines, a red margin, and a double rule before the value column.
  for (let k = 0; k <= 6; k++) {
    const ly = ARCH_ROW_TOP - 10 + k * ARCH_ROW_H;
    fill(g, 30, ly, w - 60, 1, LEDGER_RULE);
  }
  const top = ARCH_ROW_TOP - 24;
  const bottom = ARCH_ROW_TOP - 10 + 6 * ARCH_ROW_H;
  fill(g, ARCH_MARGIN_X - 12, top, 1, bottom - top, '#d7b0a0');
  fill(g, ARCH_MARGIN_X - 10, top, 1, bottom - top, '#d7b0a0');
  fill(g, w - 190, top, 1, bottom - top, '#d7b0a0');
  for (let k = 0; k < 6; k++) {
    drawText(g, `${k + 1}`, ARCH_MARGIN_X - 30, ARCH_ROW_TOP + k * ARCH_ROW_H + 4, { color: PALETTE.inkFaded });
  }
}

function drawArchives(ctx: Ctx, now: number): void {
  const e = easeOutCubic((now - ui.archivesSince) / 300);
  veil(ctx, e);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * e;
  const x = MAP_ORIGIN_X + Math.floor((MAP_PX_W - ARCH_W - CARD_SHADOW) / 2);
  const y = MAP_ORIGIN_Y + Math.floor((MAP_PX_H - ARCH_H - CARD_SHADOW) / 2) + Math.round((1 - e) * 24);
  blitCard(ctx, 'archives', ARCH_W, ARCH_H, x, y, paintArchivesCard);
  const rec = ui.records;
  const none = t('recNone');
  const summitShare = rec.expeditions > 0 ? ` (${Math.round((rec.summits / rec.expeditions) * 100)}%)` : '';
  const rows: [MessageKey, string][] = [
    ['recExpeditions', `${rec.expeditions}`],
    ['recSummits', `${rec.summits}${summitShare}`],
    ['recBestSurvey', rec.expeditions > 0 ? formatPercent(rec.bestSurveyed) : none],
    ['recBestGrade', ''],
    ['recFewestTurns', rec.fewestTurns !== null ? `${rec.fewestTurns}` : none],
    ['recTiles', `${rec.tilesMapped}`],
  ];
  const valueX = x + ARCH_W - 50;
  rows.forEach(([key, value], k) => {
    const ry = y + ARCH_ROW_TOP + k * ARCH_ROW_H;
    drawText(ctx, t(key), x + ARCH_MARGIN_X, ry, { scale: 2, color: PALETTE.inkSoft });
    if (key === 'recBestGrade') {
      if (rec.bestGrade === null || gradeRank(rec.bestGrade) < 0) {
        drawText(ctx, none, valueX, ry, { scale: 2, color: PALETTE.redInk, align: 'right' });
      } else {
        // The grade as a small inked stamp.
        const cx = valueX - 14;
        const cy = ry + 7;
        circle(ctx, cx, cy, 14, PALETTE.redInk);
        circle(ctx, cx, cy, 12, PALETTE.redInk);
        drawText(ctx, rec.bestGrade, cx + 1, cy - 6, { scale: 2, color: PALETTE.redInk, align: 'center' });
      }
    } else {
      drawText(ctx, value, valueX, ry, { scale: 2, color: PALETTE.redInk, align: 'right' });
    }
  });
  const footY = y + ARCH_ROW_TOP - 10 + 6 * ARCH_ROW_H + 18;
  if (rec.expeditions === 0) {
    drawText(ctx, t('recEmpty'), x + Math.floor(ARCH_W / 2), footY, { color: PALETTE.inkFaded, align: 'center' });
  }
  drawText(ctx, t('archivesClose'), x + Math.floor(ARCH_W / 2), y + ARCH_H - 40, {
    color: PALETTE.inkSoft,
    align: 'center',
  });
  // Close box in the top-right corner.
  const bx = x + ARCH_W - 50;
  const by = y + 24;
  const hover = ui.hover === 'closeArchives';
  fill(ctx, bx, by, 24, 24, PALETTE.ink);
  fill(ctx, bx + 1, by + 1, 22, 22, hover ? PALETTE.parchment : PALETTE.parchmentDark);
  drawText(ctx, 'X', bx + 13, by + 5, { scale: 2, color: hover ? PALETTE.redInk : PALETTE.inkSoft, align: 'center' });
  addButton('closeArchives', bx, by, 24, 24);
  ctx.globalAlpha = prev;
}

function drawToast(ctx: Ctx, now: number): void {
  const toast = ui.toast;
  if (!toast) return;
  const age = now - toast.start;
  if (age < 0 || age >= TOAST_MS) return;
  const fade = age > TOAST_MS - 400 ? (TOAST_MS - age) / 400 : 1;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.max(0, Math.round(fade * 4) / 4);
  const w = measureText(toast.text, 2) + 32;
  const h = 30;
  const x = MAP_ORIGIN_X + Math.floor((MAP_PX_W - w) / 2);
  const y = MAP_ORIGIN_Y + MAP_PX_H - 70 - Math.round(Math.max(0, 1 - age / 160) * 10);
  const ink = toast.tone === 'good' ? PALETTE.green : PALETTE.redInk;
  fill(ctx, x + 3, y + 3, w, h, SHADOW);
  fill(ctx, x, y, w, h, PALETTE.ink);
  fill(ctx, x + 1, y + 1, w - 2, h - 2, PALETTE.parchment);
  outline(ctx, x + 3, y + 3, w - 6, h - 6, ink);
  drawText(ctx, toast.text, x + Math.floor(w / 2), y + 8, { scale: 2, color: ink, align: 'center' });
  ctx.globalAlpha = prev;
}

// ----- Pause menu -----

const PAUSE_W = 420;
const PAUSE_H = 250;
const PAUSE_BTN_H = 30;

/** Parchment card with a riveted brass rim (drawn once per language into the card cache). */
function paintPauseCard(g: Ctx): void {
  const w = PAUSE_W;
  const h = PAUSE_H;
  paintPaper(g, w, h, 2718);
  paintNeatline(g, w, h, PALETTE.inkFaded);
  // Brass rim over the paper edge.
  outline(g, 0, 0, w, h, PALETTE.brassShadow);
  outline(g, 1, 1, w - 2, h - 2, PALETTE.brass, 2);
  fill(g, 1, 1, w - 2, 1, PALETTE.brassLight);
  fill(g, 1, 1, 1, h - 2, PALETTE.brassLight);
  outline(g, 3, 3, w - 6, h - 6, PALETTE.brassDark);
  for (const [rx, ry] of [
    [4, 4],
    [w - 7, 4],
    [4, h - 7],
    [w - 7, h - 7],
  ] as const) {
    rivet(g, rx, ry);
  }
}

/** One pause-card button; the highlighted one gets a red rule, a pointer and bolder paper. */
function pauseButton(ctx: Ctx, id: ButtonId, label: string, x: number, y: number, w: number, selected: boolean, danger: boolean): void {
  const h = PAUSE_BTN_H;
  fill(ctx, x + 2, y + 2, w, h, PALETTE.parchmentShade);
  fill(ctx, x, y, w, h, PALETTE.ink);
  fill(ctx, x + 1, y + 1, w - 2, h - 2, selected ? PALETTE.parchment : PALETTE.parchmentDark);
  fill(ctx, x + 1, y + h - 3, w - 2, 2, PALETTE.parchmentShade);
  const ink = danger ? PALETTE.redInk : PALETTE.ink;
  if (selected) {
    outline(ctx, x + 2, y + 2, w - 4, h - 5, danger ? PALETTE.redInkBright : PALETTE.redInk, 2);
    drawText(ctx, '→', x + 10, y + 10, { color: PALETTE.redInk });
  }
  drawText(ctx, label, x + Math.floor(w / 2) + 1, y + 8, { scale: 2, color: selected ? ink : PALETTE.inkSoft, align: 'center' });
  addButton(id, x, y, w, h);
}

function drawPauseCard(ctx: Ctx, now: number): void {
  const menu = ui.pause;
  const e = easeOutCubic((now - menu.since) / 220);
  veil(ctx, e);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * e;
  const x = MAP_ORIGIN_X + Math.floor((MAP_PX_W - PAUSE_W - CARD_SHADOW) / 2);
  const y = MAP_ORIGIN_Y + Math.floor((MAP_PX_H - PAUSE_H - CARD_SHADOW) / 2) + Math.round((1 - e) * 16);
  blitCard(ctx, 'pause', PAUSE_W, PAUSE_H, x, y, paintPauseCard);
  const mid = x + Math.floor(PAUSE_W / 2);
  if (menu.view === 'menu') {
    drawText(ctx, t('pausedTitle'), mid, y + 30, { scale: 2, color: PALETTE.ink, align: 'center', shadow: PALETTE.parchmentShade });
    rule(ctx, mid, y + 56, 140, PALETTE.inkFaded, PALETTE.redInk);
    const bw = 280;
    const bx = mid - bw / 2;
    pauseButton(ctx, 'pauseResume', t('pauseResume'), bx, y + 78, bw, menu.selected === 'resume', false);
    pauseButton(ctx, 'pauseToTitle', t('pauseToTitle'), bx, y + 122, bw, menu.selected === 'title', false);
    drawText(ctx, t('pauseHint'), mid, y + PAUSE_H - 44, { color: PALETTE.inkFaded, align: 'center' });
  } else {
    drawText(ctx, t('abandonQuestion'), mid, y + 34, { scale: 2, color: PALETTE.ink, align: 'center', shadow: PALETTE.parchmentShade });
    drawText(ctx, t('abandonWarning'), mid, y + 64, { color: PALETTE.redInk, align: 'center' });
    rule(ctx, mid, y + 84, 140, PALETTE.inkFaded, PALETTE.redInk);
    const bw = 150;
    const gap = 20;
    const bx = mid - bw - gap / 2;
    pauseButton(ctx, 'pauseAbandon', t('abandonConfirm'), bx, y + 112, bw, menu.selected === 'abandon', true);
    pauseButton(ctx, 'pauseCancel', t('abandonCancel'), bx + bw + gap, y + 112, bw, menu.selected === 'cancel', false);
    drawText(ctx, t('confirmHint'), mid, y + PAUSE_H - 44, { color: PALETTE.inkFaded, align: 'center' });
  }
  ctx.globalAlpha = prev;
}

// ----- Survey Contract card (Steam edition) -----

export const CONTRACTS_W = 640;
const CONTRACTS_H = 440;
const CONTRACT_ROW_TOP = 132;
const CONTRACT_ROW_H = 60;
const CONTRACT_ROW_GAP = 12;
const CONTRACT_ROW_X = 40;
export const CONTRACT_ROW_W = CONTRACTS_W - 2 * CONTRACT_ROW_X;
/** Left edge of a row's text (after the selection arrow) and the room kept on the right for the stamp. */
const CONTRACT_TEXT_X = 34;
export const CONTRACT_TEXT_W = CONTRACT_ROW_W - CONTRACT_TEXT_X - 110;

/** Each Contract's name and one-line condition on the card. */
const CONTRACT_LINES: Readonly<Record<ContractId, readonly [ContractTextKey, ContractTextKey]>> = {
  'gentle-ascent': ['contractGentleName', 'contractGentleGoal'],
  'hold-the-high-ground': ['contractHoldName', 'contractHoldGoal'],
  'master-surveyor': ['contractMasterName', 'contractMasterGoal'],
};

/** A Contract's name and condition line, in the active language. */
export function contractLines(id: ContractId): [string, string] {
  const [name, goal] = CONTRACT_LINES[id];
  return [contractText(name), contractText(goal, { m: toMeters(VISION_HIGH_MIN) })];
}

function paintContractsCard(g: Ctx): void {
  const w = CONTRACTS_W;
  const mid = Math.floor(w / 2);
  paintPaper(g, w, CONTRACTS_H, 3109);
  paintNeatline(g, w, CONTRACTS_H, PALETTE.redInk);
  drawText(g, contractText('contractsSub'), mid, 34, { color: PALETTE.inkFaded, align: 'center' });
  drawText(g, contractText('contractsTitle'), mid, 56, {
    scale: 3,
    color: PALETTE.ink,
    align: 'center',
    shadow: PALETTE.parchmentShade,
    shadowOffset: 2,
  });
  rule(g, mid, 98, 220, PALETTE.inkFaded, PALETTE.redInk);
  drawText(g, contractText('contractsRule'), mid, 110, { color: PALETTE.inkSoft, align: 'center' });
}

/** One Contract row: the highlighted one gets a red rule and a pointer; a completed one a small stamp. */
function contractRow(ctx: Ctx, id: ContractId, x: number, y: number, selected: boolean, completed: boolean): void {
  const w = CONTRACT_ROW_W;
  const h = CONTRACT_ROW_H;
  fill(ctx, x + 2, y + 2, w, h, PALETTE.parchmentShade);
  fill(ctx, x, y, w, h, PALETTE.ink);
  fill(ctx, x + 1, y + 1, w - 2, h - 2, selected ? PALETTE.parchment : PALETTE.parchmentDark);
  fill(ctx, x + 1, y + h - 3, w - 2, 2, PALETTE.parchmentShade);
  if (selected) {
    outline(ctx, x + 2, y + 2, w - 4, h - 5, PALETTE.redInk, 2);
    drawText(ctx, '→', x + 12, y + 14, { color: PALETTE.redInk });
  }
  const [name, goal] = contractLines(id);
  drawText(ctx, name, x + CONTRACT_TEXT_X, y + 12, { scale: 2, color: selected ? PALETTE.ink : PALETTE.inkSoft });
  drawText(ctx, goal, x + CONTRACT_TEXT_X, y + 36, { color: PALETTE.inkSoft });
  if (completed) {
    const label = contractText('contractCompleted');
    const lw = measureText(label, 1) + 12;
    const sx = x + w - 18 - lw;
    const sy = y + Math.floor((h - 19) / 2);
    outline(ctx, sx, sy, lw, 19, PALETTE.redInk);
    outline(ctx, sx + 2, sy + 2, lw - 4, 15, PALETTE.redInk);
    drawText(ctx, label, sx + Math.floor(lw / 2), sy + 6, { color: PALETTE.redInk, align: 'center' });
  }
  addButton(`contract:${id}`, x, y, w, h);
}

function drawContracts(ctx: Ctx, state: GameState, now: number): void {
  // Modal: only the card's own buttons answer while it is open.
  clearButtons();
  const menu = ui.contracts;
  const e = easeOutCubic((now - menu.since) / 300);
  veil(ctx, e);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * e;
  const x = MAP_ORIGIN_X + Math.floor((MAP_PX_W - CONTRACTS_W - CARD_SHADOW) / 2);
  const y = MAP_ORIGIN_Y + Math.floor((MAP_PX_H - CONTRACTS_H - CARD_SHADOW) / 2) + Math.round((1 - e) * 24);
  blitCard(ctx, 'contracts', CONTRACTS_W, CONTRACTS_H, x, y, paintContractsCard);
  CONTRACT_ROWS.forEach((id, k) => {
    const ry = y + CONTRACT_ROW_TOP + k * (CONTRACT_ROW_H + CONTRACT_ROW_GAP);
    contractRow(ctx, id, x + CONTRACT_ROW_X, ry, menu.selected === id, menu.isCompleted(id));
  });
  const mid = x + Math.floor(CONTRACTS_W / 2);
  if (state.mode === 'explorer') {
    // Contracts are played by the Standard rules only; the mode is switched on the title card itself.
    drawText(ctx, contractText('contractsStandardOnly'), mid, y + CONTRACTS_H - 76, { color: PALETTE.redInk, align: 'center' });
    drawText(ctx, contractText('contractsSwitch'), mid, y + CONTRACTS_H - 62, { color: PALETTE.redInk, align: 'center' });
  }
  drawText(ctx, contractText('contractsHint'), mid, y + CONTRACTS_H - 40, { color: PALETTE.inkSoft, align: 'center' });
  // Close box in the top-right corner, as on the archives ledger.
  const bx = x + CONTRACTS_W - 50;
  const by = y + 24;
  const hover = ui.hover === 'closeContracts';
  fill(ctx, bx, by, 24, 24, PALETTE.ink);
  fill(ctx, bx + 1, by + 1, 22, 22, hover ? PALETTE.parchment : PALETTE.parchmentDark);
  drawText(ctx, 'X', bx + 13, by + 5, { scale: 2, color: hover ? PALETTE.redInk : PALETTE.inkSoft, align: 'center' });
  addButton('closeContracts', bx, by, 24, 24);
  ctx.globalAlpha = prev;
}

/** Interface layers above the cards: the archives ledger, the Contract card, the pause menu and toasts. Draw after drawOverlay. */
export function drawUi(ctx: CanvasRenderingContext2D, state: GameState, now: number): void {
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  refreshTextCaches();
  if (ui.archivesOpen) drawArchives(ctx, now);
  if (EDITION === 'steam' && ui.contracts.isOpen) drawContracts(ctx, state, now);
  if (ui.pause.isOpen) drawPauseCard(ctx, now);
  drawToast(ctx, now);
  ctx.imageSmoothingEnabled = smoothing;
}

/** Full-screen cards (title / game over / victory). Draw last, after the map and HUD. */
export function drawOverlay(ctx: CanvasRenderingContext2D, state: GameState, now: number): void {
  if (state.phase !== 'title' && state.phase !== 'gameover' && state.phase !== 'victory') return;
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  if (state.phase === 'title') drawTitle(ctx, state, now);
  else if (state.phase === 'gameover') drawGameOver(ctx, state, now);
  else drawVictory(ctx, state, now);
  ctx.imageSmoothingEnabled = smoothing;
}
