// Pixel-art primitives and hand-designed sprites for the map-sheet renderer.
// Everything here is integer, fillRect / ImageData based: no anti-aliased canvas paths.
import { PALETTE } from './config';
import type { Dir } from './types';

// ---------------------------------------------------------------------------
// Colour packing (ImageData Uint32 views)
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = parseInt(full.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear blend of two hex colours (t = 0 -> a, t = 1 -> b). */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/** Opaque RGB packed for a Uint32Array view over ImageData.data. */
export function packRgb(r: number, g: number, b: number): number {
  return LITTLE_ENDIAN
    ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
}

export function packHex(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return packRgb(r, g, b);
}

export function unpackRgb(c: number): Rgb {
  return LITTLE_ENDIAN
    ? { r: c & 255, g: (c >>> 8) & 255, b: (c >>> 16) & 255 }
    : { r: (c >>> 24) & 255, g: (c >>> 16) & 255, b: (c >>> 8) & 255 };
}

// ---------------------------------------------------------------------------
// Ordered dithering
// ---------------------------------------------------------------------------

/** Classic 4x4 Bayer matrix, values 0..15. */
export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export function bayer4(x: number, y: number): number {
  return BAYER4[((y & 3) << 2) | (x & 3)];
}

/** Bayer threshold in (0, 1) for pixel (x, y). */
export function bayerT(x: number, y: number): number {
  return (BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16;
}

/**
 * Cache of 4x4 repeat patterns that paint `level` of the 16 Bayer cells in a colour.
 * Patterns are anchored to the canvas origin, so overlapping fills stay aligned.
 */
export class DitherPatterns {
  private readonly cache = new Map<string, CanvasPattern | null>();

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  get(color: string, level: number): CanvasPattern | null {
    const lv = Math.max(0, Math.min(16, Math.round(level)));
    const key = `${color}|${lv}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const tile = document.createElement('canvas');
    tile.width = 4;
    tile.height = 4;
    const tctx = tile.getContext('2d');
    let pattern: CanvasPattern | null = null;
    if (tctx) {
      tctx.fillStyle = color;
      for (let i = 0; i < 16; i++) {
        if (BAYER4[i] < lv) tctx.fillRect(i & 3, i >> 2, 1, 1);
      }
      pattern = this.ctx.createPattern(tile, 'repeat');
    }
    this.cache.set(key, pattern);
    return pattern;
  }
}

// ---------------------------------------------------------------------------
// Integer raster primitives
// ---------------------------------------------------------------------------

/** Bresenham line from (x0,y0) to (x1,y1) inclusive; `plot` receives each pixel and its step index. */
export function plotLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number, step: number) => void,
): number {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  let step = 0;
  for (;;) {
    plot(x, y, step++);
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
  return step;
}

/** Filled pixel disc using horizontal spans (current fillStyle). */
export function fillDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const rr = Math.max(0, r);
  const top = Math.ceil(-rr);
  const bottom = Math.floor(rr);
  for (let dy = top; dy <= bottom; dy++) {
    const half = Math.floor(Math.sqrt(Math.max(0, rr * rr - dy * dy)));
    ctx.fillRect(Math.round(cx) - half, Math.round(cy) + dy, half * 2 + 1, 1);
  }
}

/** Filled pixel annulus (ring) between r0 and r1 using horizontal spans. */
export function fillRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r0: number, r1: number): void {
  const inner = Math.max(0, r0);
  const outer = Math.max(inner, r1);
  const icx = Math.round(cx);
  const icy = Math.round(cy);
  for (let dy = Math.ceil(-outer); dy <= Math.floor(outer); dy++) {
    const ho = Math.floor(Math.sqrt(Math.max(0, outer * outer - dy * dy)));
    const hiSq = inner * inner - dy * dy;
    if (hiSq <= 0) {
      ctx.fillRect(icx - ho, icy + dy, ho * 2 + 1, 1);
      continue;
    }
    const hi = Math.ceil(Math.sqrt(hiSq));
    if (hi > ho) continue;
    ctx.fillRect(icx - ho, icy + dy, ho - hi + 1, 1);
    ctx.fillRect(icx + hi, icy + dy, ho - hi + 1, 1);
  }
}

// ---------------------------------------------------------------------------
// Sprite construction from text art
// ---------------------------------------------------------------------------

export type SpriteArt = readonly string[];
export type Legend = Readonly<Record<string, string>>;

export interface Sprite {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

export function mirrorArt(art: SpriteArt): string[] {
  return art.map((row) => row.split('').reverse().join(''));
}

/**
 * Rasterise text art ('.' or ' ' = transparent) into a canvas. With `halo`, a 1 px
 * 4-neighbour halo of that colour is painted around every filled pixel (the canvas
 * grows by 1 px on each side) so small symbols stay legible on busy terrain.
 */
export function makeSprite(art: SpriteArt, legend: Legend, halo?: string): Sprite {
  const pad = halo ? 1 : 0;
  const h = art.length;
  const w = art.reduce((m, row) => Math.max(m, row.length), 0);
  const canvas = document.createElement('canvas');
  canvas.width = w + pad * 2;
  canvas.height = h + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { canvas, w: canvas.width, h: canvas.height };
  const filled = (x: number, y: number): boolean => {
    if (y < 0 || y >= h) return false;
    const ch = art[y][x];
    return ch !== undefined && ch !== '.' && ch !== ' ';
  };
  if (halo) {
    ctx.fillStyle = halo;
    for (let y = -1; y <= h; y++) {
      for (let x = -1; x <= w; x++) {
        if (filled(x, y)) continue;
        if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) {
          ctx.fillRect(x + pad, y + pad, 1, 1);
        }
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const row = art[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const color = legend[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x + pad, y + pad, 1, 1);
    }
  }
  return { canvas, w: canvas.width, h: canvas.height };
}

// ---------------------------------------------------------------------------
// Sprite art
// ---------------------------------------------------------------------------

/** Surveyor legend: wide-brim brass hat, red scarf, field-green coat, backpack and boots. */
const SURVEYOR_LEGEND: Legend = {
  o: PALETTE.ink,
  k: PALETTE.inkSoft,
  y: PALETTE.brassLight,
  h: PALETTE.brass,
  l: PALETTE.brassLight,
  H: PALETTE.brassDark,
  s: '#e3b68b',
  S: '#b98760',
  r: PALETTE.redInkBright,
  c: PALETTE.green,
  g: '#7b8a4e',
  C: '#414a27',
  p: '#8b6a3e',
  P: PALETTE.brassDark,
  T: '#4a3a30',
  b: PALETTE.brassShadow,
};

// 11 x 13. Frame A = stride, frame B = passing step (drawn 1 px higher for the bob). The hands rest
// against the coat (a single skin pixel in the outline), so nothing sticks out of the silhouette.
const SURVEYOR_DOWN_A: SpriteArt = [
  '..ooooo....',
  '.ohhlhho...',
  'oHHHHHHHo..',
  '.oSSSSSo...',
  '.osososo...',
  '.ossssso...',
  'orrrrrrro..',
  'ocPcccPco..',
  'sgPcccPcs..',
  'oCcccccCo..',
  '.oTToTTo...',
  '.obbobbo...',
  '.ooo.ooo...',
];
const SURVEYOR_DOWN_B: SpriteArt = [
  ...SURVEYOR_DOWN_A.slice(0, 10),
  '..oTTTo....',
  '..obbbo....',
  '..ooooo....',
];

// Seen from behind, the brim catches the light, so the back view is not a flat dark box.
const SURVEYOR_UP_A: SpriteArt = [
  '....ooooo..',
  '...ohhlhho.',
  '..oHhllhhHo',
  '...oTTTTTo.',
  '..orpppppro',
  '..ocpPPPpco',
  '..ocpPpPpco',
  '..ocpPPPpco',
  '..scpppppcs',
  '..oCcccccCo',
  '...oTToTTo.',
  '...obbobbo.',
  '...ooo.ooo.',
];
const SURVEYOR_UP_B: SpriteArt = [
  ...SURVEYOR_UP_A.slice(0, 10),
  '....oTTTo..',
  '....obbbo..',
  '....ooooo..',
];

const SURVEYOR_RIGHT_A: SpriteArt = [
  '..ooooo....',
  '.ohhlhho...',
  '.oHHHHHHHo.',
  '..oTSSSSo..',
  '..oTssosso.',
  '..oTsssso..',
  '.oprrrrro..',
  'oPpcccgco..',
  'oPpccccss..',
  'oPpCcccCo..',
  '..oTToTTo..',
  '..obbobbbo.',
  '..ooo.oooo.',
];
const SURVEYOR_RIGHT_B: SpriteArt = [
  ...SURVEYOR_RIGHT_A.slice(0, 10),
  '...oTTTo...',
  '...obbbbo..',
  '...oooooo..',
];

/** Collapsed surveyor lying on the ground (15 x 6). */
const SURVEYOR_FALLEN: SpriteArt = [
  '.......ooooo...',
  '.ooooooPPPPPooo',
  'obbTTTcccccrsso',
  'obbTTTcgcccrsSo',
  '.oooooooooooooo',
  '...............',
];
const FALLEN_HAT: SpriteArt = ['..ooo..', '.ohlho.', 'oHHHHHo', '.ooooo.'];

const OBJECT_LEGEND: Legend = {
  o: PALETTE.ink,
  y: PALETTE.brassLight,
  w: PALETTE.brass,
  W: PALETTE.brassDark,
  R: PALETTE.redInkBright,
  k: PALETTE.brassShadow,
  g: PALETTE.green,
  G: '#414a27',
  l: '#7d8a52',
  d: '#2a1f1a',
};

// Plateau cache: supply crate in 3/4 view with a pennant (10 x 11).
const CRATE_A: SpriteArt = [
  '......oo..',
  '......oRRR',
  '......oRR.',
  '......o...',
  '.oooooooo.',
  'oyyyyyyyyo',
  'oooooooooo',
  'owWwwwwWwo',
  'owWwwwwWwo',
  'okWkkkkWko',
  'oooooooooo',
];
const CRATE_B: SpriteArt = ['......oo..', '......oRR.', '......oRRR', '......oR..', ...CRATE_A.slice(4)];
const CRATE_OPEN: SpriteArt = [
  '..........',
  '..........',
  '.oooo.....',
  'oyyyyo....',
  'oyyyyo....',
  'oooooooooo',
  'oddddddddo',
  'owWwwwwWwo',
  'owWwwwwWwo',
  'okWkkkkWko',
  'oooooooooo',
];

// Saddle cache: A-frame expedition tent with a pennant (11 x 11).
const TENT_A: SpriteArt = [
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
const TENT_B: SpriteArt = [
  '.....oo....',
  '.....oRRR..',
  '.....oRR...',
  '.....oR....',
  ...TENT_A.slice(4),
];
const TENT_OPEN: SpriteArt = [
  '...........',
  '...........',
  '...........',
  '...........',
  '.....o.....',
  '....ogo....',
  '...oglGo...',
  '..ogllGGo..',
  '.oglldGGGo.',
  'ogllddddGGo',
  'ooooooooooo',
];

/** Red-ink tick marking a collected cache (7 x 6, parchment halo added). */
const TICK: SpriteArt = ['......R', '.....RR', 'R...RR.', 'RR.RR..', '.RRR...', '..R....'];

const PILLAR_LEGEND: Legend = {
  o: PALETTE.ink,
  w: '#fbf6ea',
  l: '#e9e1cb',
  m: '#c9bb9b',
  d: '#a39273',
  D: '#7a6a50',
  R: PALETTE.redInk,
};

/**
 * The Ancient Trig Pillar: stone survey pillar with a red trig triangle (9 x 13). An ink cap
 * row and a dark shaded flank keep the pale stone readable on parchment.
 */
const PILLAR: SpriteArt = [
  '.ooooooo.',
  'owwlllmdo',
  'ooooooooo',
  '.owllmDo.',
  '.owlRmDo.',
  '.owRRRDo.',
  '.owllmDo.',
  '.owllmDo.',
  '.owllmDo.',
  'owwllmdDo',
  'owlllmdDo',
  'olllmmdDo',
  'ooooooooo',
];

/**
 * Sight eye (11 x 5, 'o' = ink): the almond eye printed before a sight line's height on the sheet
 * and on its legend symbol. Wider than tall, with a pupil, so it never reads as a leading zero.
 */
export const SIGHT_EYE_ART: SpriteArt = ['...ooooo...', '.oo.....oo.', 'o...ooo...o', '.oo.....oo.', '...ooooo...'];

/** Small pillar for the sheet legend (5 x 8), same stone palette. */
const PILLAR_MINI: SpriteArt = ['ooooo', 'owlmo', 'ooooo', '.olD.', '.olD.', '.olD.', 'owmDo', 'ooooo'];

/** Rasterise an isosceles triangle outline (apex at the top centre, odd width) as text art. */
function triangleArt(w: number, h: number, thick: number, ch: string): string[] {
  const rows = Array.from({ length: h }, () => Array.from({ length: w }, () => '.'));
  const put = (x: number, y: number): void => {
    if (x >= 0 && x < w && y >= 0 && y < h) rows[y][x] = ch;
  };
  const apex = (w - 1) / 2;
  plotLine(0, h - 1, apex, 0, (x, y) => {
    for (let t = 0; t < thick; t++) put(x + t, y);
  });
  plotLine(w - 1, h - 1, apex, 0, (x, y) => {
    for (let t = 0; t < thick; t++) put(x - t, y);
  });
  for (let t = 0; t < thick; t++) for (let x = 0; x < w; x++) put(x, h - 1 - t);
  return rows.map((r) => r.join(''));
}

/** Overlay `top` onto `base` at (ox, oy); '.' cells of `top` are transparent. */
function overlayArt(base: SpriteArt, top: SpriteArt, ox: number, oy: number): string[] {
  return base.map((row, y) => {
    const src = top[y - oy];
    if (src === undefined) return row;
    const cells = row.split('');
    for (let x = 0; x < src.length; x++) if (src[x] !== '.' && cells[x + ox] !== undefined) cells[x + ox] = src[x];
    return cells.join('');
  });
}

/** Base-camp station ring at the start of the route (7 x 7). */
const CAMP_RING: SpriteArt = ['..RRR..', '.R...R.', 'R.....R', 'R..R..R', 'R.....R', '.R...R.', '..RRR..'];

/** Spot-height triangle (5 x 3). */
const SPOT_TRIANGLE: SpriteArt = ['..o..', '.ooo.', 'ooooo'];

export interface SurveyorSprites {
  /** Walk frames, each with a 1 px parchment halo (canvas 13 x 15; the art starts at (1, 1)). */
  frames: Readonly<Record<Dir, readonly [Sprite, Sprite]>>;
  /** Horizontal offset (px) from the tile's left edge to the sprite canvas's left edge, per facing. */
  offsetX: Readonly<Record<Dir, number>>;
  fallen: Sprite;
  fallenHat: Sprite;
}

export interface SpriteBank {
  surveyor: SurveyorSprites;
  crate: readonly [Sprite, Sprite];
  crateOpen: Sprite;
  tent: readonly [Sprite, Sprite];
  tentOpen: Sprite;
  tick: Sprite;
  pillar: Sprite;
  /** Red trig-station triangle drawn behind the pillar (19 x 16 art plus a parchment halo). */
  trigStation: Sprite;
  /** Pillar in its station triangle, sized for the sheet legend (15 x 12). */
  trigLegend: Sprite;
  camp: Sprite;
  spotTriangle: Sprite;
}

export function createSpriteBank(): SpriteBank {
  const S = SURVEYOR_LEGEND;
  // The parchment knockout halo keeps the ink outline from fusing with contour lines.
  const surveyor = (art: SpriteArt): Sprite => makeSprite(art, S, PALETTE.parchment);
  return {
    surveyor: {
      frames: {
        down: [surveyor(SURVEYOR_DOWN_A), surveyor(SURVEYOR_DOWN_B)],
        up: [surveyor(SURVEYOR_UP_A), surveyor(SURVEYOR_UP_B)],
        right: [surveyor(SURVEYOR_RIGHT_A), surveyor(SURVEYOR_RIGHT_B)],
        left: [surveyor(mirrorArt(SURVEYOR_RIGHT_A)), surveyor(mirrorArt(SURVEYOR_RIGHT_B))],
      },
      // Keeps the body column fixed when turning (the staff swaps sides); the halo adds 1 px.
      offsetX: { down: 0, right: 0, up: -2, left: -2 },
      fallen: surveyor(SURVEYOR_FALLEN),
      fallenHat: surveyor(FALLEN_HAT),
    },
    crate: [makeSprite(CRATE_A, OBJECT_LEGEND), makeSprite(CRATE_B, OBJECT_LEGEND)],
    crateOpen: makeSprite(CRATE_OPEN, OBJECT_LEGEND),
    tent: [makeSprite(TENT_A, OBJECT_LEGEND), makeSprite(TENT_B, OBJECT_LEGEND)],
    tentOpen: makeSprite(TENT_OPEN, OBJECT_LEGEND),
    tick: makeSprite(TICK, OBJECT_LEGEND, PALETTE.parchment),
    pillar: makeSprite(PILLAR, PILLAR_LEGEND),
    trigStation: makeSprite(triangleArt(19, 16, 2, 'R'), PILLAR_LEGEND, PALETTE.parchment),
    trigLegend: makeSprite(overlayArt(triangleArt(15, 12, 2, 'R'), PILLAR_MINI, 5, 4), PILLAR_LEGEND),
    camp: makeSprite(CAMP_RING, { R: PALETTE.redInk }, PALETTE.parchment),
    spotTriangle: makeSprite(SPOT_TRIANGLE, { o: PALETTE.ink }, PALETTE.parchment),
  };
}
