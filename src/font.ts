// Pixel fonts: hand-designed 5x7 bitmap glyphs plus six hand-drawn 11x12 Hangul syllables for
// the title "등고선 탐사대", drawn with integer fillRects and cached per colour/scale in small
// offscreen atlases. Korean interface text uses the Galmuri9 pixel web font instead, rasterised
// at its native size and thresholded to 1 bit (see the web-font section below).
import { PALETTE } from './config';
import { GALMURI_ASCENT, GALMURI_GLYPHS } from './galmuri9-glyphs';
import type { GalmuriGlyph } from './galmuri9-glyphs';

export interface TextOptions {
  color?: string;
  scale?: number;
  align?: 'left' | 'center' | 'right';
  /** Optional drop-shadow colour, drawn `shadowOffset` px (default 1) down-right of the text. */
  shadow?: string;
  /** Drop-shadow offset in canvas px (default 1). */
  shadowOffset?: number;
}

/** Base glyph cell (font pixels). */
export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** Horizontal advance per character (glyph + 1 px spacing). */
export const GLYPH_ADVANCE = 6;
/** Vertical advance per text line. */
export const LINE_HEIGHT = 9;

/** Hangul syllable cell (font pixels). */
export const HANGUL_W = 11;
export const HANGUL_H = 12;
const HANGUL_GAP = 2;
const HANGUL_SPACE = 6;
export const HANGUL_TITLE = '등고선 탐사대';

// ---------------------------------------------------------------------------
// Glyph designs ('#' = ink, '.' = paper). Rows may be shorter than the cell; missing
// pixels are blank. A Latin row may use a 6th column (the spacing column) to join runs.
// ---------------------------------------------------------------------------

const LATIN: Record<string, readonly string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],

  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],

  ' ': [],
  '.': ['', '', '', '', '', '.##..', '.##..'],
  ',': ['', '', '', '', '.##..', '..#..', '.#...'],
  ':': ['', '.##..', '.##..', '', '.##..', '.##..', ''],
  ';': ['', '.##..', '.##..', '', '.##..', '..#..', '.#...'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '', '..#..'],
  '-': ['', '', '', '.###.', '', '', ''],
  '+': ['', '..#..', '..#..', '#####', '..#..', '..#..', ''],
  '/': ['', '....#', '...#.', '..#..', '.#...', '#....', ''],
  '\\': ['', '#....', '.#...', '..#..', '...#.', '....#', ''],
  '%': ['##...', '##..#', '...#.', '..#..', '.#...', '#..##', '...##'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  "'": ['..#..', '..#..', '.#...'],
  '"': ['.#.#.', '.#.#.', '.#.#.'],
  '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
  '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
  '=': ['', '', '#####', '', '#####', '', ''],
  _: ['', '', '', '', '', '', '#####'],
  '[': ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.'],
  ']': ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.'],
  '{': ['...##', '..#..', '..#..', '.#...', '..#..', '..#..', '...##'],
  '}': ['##...', '..#..', '..#..', '...#.', '..#..', '..#..', '##...'],
  '*': ['', '..#..', '#.#.#', '.###.', '#.#.#', '..#..', ''],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '@': ['.###.', '#...#', '....#', '.##.#', '#.#.#', '#.#.#', '.###.'],
  '$': ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '^': ['..#..', '.#.#.', '#...#'],
  '~': ['', '', '.#...', '#.#.#', '...#.', '', ''],
  '|': ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  '`': ['.#...', '..#..'],
  '°': ['.##..', '#..#.', '#..#.', '.##..'],
  '·': ['', '', '', '..#..'],
  '—': ['', '', '', '######'],
  '…': ['', '', '', '', '', '', '#.#.#'],
  '×': ['', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', ''],
  '↑': ['..#..', '.###.', '#.#.#', '..#..', '..#..', '..#..', '..#..'],
  '→': ['', '..#..', '...#.', '#####', '...#.', '..#..', ''],
  '↓': ['..#..', '..#..', '..#..', '..#..', '#.#.#', '.###.', '..#..'],
  '←': ['', '..#..', '.#...', '#####', '.#...', '..#..', ''],
};

/** Typographic look-alikes mapped onto existing glyphs. */
const ALIASES: Record<string, string> = {
  '–': '-',
  '−': '-',
  '‐': '-',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  'º': '°',
  '˚': '°',
  '•': '·',
  '∙': '·',
  '▲': '↑',
  '▶': '→',
  '►': '→',
  '▼': '↓',
  '◀': '←',
  '◄': '←',
};

/** Unknown characters render as this small box. */
const BOX_GLYPH: readonly string[] = ['', '.###.', '.#.#.', '.#.#.', '.#.#.', '.###.', ''];

// Hangul syllables, 11 x 12, 1 px strokes, laid out like a classic 12-dot bitmap face.
const HANGUL: Record<string, readonly string[]> = {
  // ㄷ over ㅡ over ㅇ
  등: [
    '.#########.',
    '.#.........',
    '.#.........',
    '.#########.',
    '...........',
    '###########',
    '...........',
    '...#####...',
    '..#.....#..',
    '..#.....#..',
    '..#.....#..',
    '...#####...',
  ],
  // ㄱ over ㅗ
  고: [
    '.#########.',
    '.........#.',
    '.........#.',
    '.........#.',
    '.........#.',
    '.........#.',
    '...........',
    '.....#.....',
    '.....#.....',
    '.....#.....',
    '###########',
    '...........',
  ],
  // ㅅ + ㅓ over ㄴ
  선: [
    '...#......#',
    '...#......#',
    '..#.#.....#',
    '.#...#..###',
    '#.....#...#',
    '..........#',
    '..........#',
    '...........',
    '.#.........',
    '.#.........',
    '.#.........',
    '.##########',
  ],
  // ㅌ + ㅏ over ㅁ
  탐: [
    '#######.#..',
    '#.......#..',
    '#######.#..',
    '#.......###',
    '#######.#..',
    '........#..',
    '........#..',
    '...........',
    '.#########.',
    '.#.......#.',
    '.#.......#.',
    '.#########.',
  ],
  // ㅅ + ㅏ
  사: [
    '...#....#..',
    '...#....#..',
    '...#....#..',
    '..#.#...#..',
    '..#.#...#..',
    '.#...#..###',
    '.#...#..#..',
    '#.....#.#..',
    '#.....#.#..',
    '........#..',
    '........#..',
    '........#..',
  ],
  // ㄷ + ㅐ
  대: [
    '.......#..#',
    '.......#..#',
    '#####..#..#',
    '#......#..#',
    '#......#..#',
    '#......####',
    '#......#..#',
    '#......#..#',
    '#####..#..#',
    '.......#..#',
    '.......#..#',
    '.......#..#',
  ],
};

// ---------------------------------------------------------------------------
// Compilation: each glyph becomes a list of horizontal runs [x, y, len, ...].
// ---------------------------------------------------------------------------

function compileRuns(rows: readonly string[]): Int16Array {
  const runs: number[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === '#') {
        const start = x;
        while (x < row.length && row[x] === '#') x++;
        runs.push(start, y, x - start);
      } else {
        x++;
      }
    }
  });
  return Int16Array.from(runs);
}

const LATIN_CHARS: string[] = Object.keys(LATIN);
const LATIN_RUNS: Int16Array[] = LATIN_CHARS.map((ch) => compileRuns(LATIN[ch]));
const BOX_INDEX = LATIN_RUNS.length;
LATIN_RUNS.push(compileRuns(BOX_GLYPH));
const SPACE_INDEX = LATIN_CHARS.indexOf(' ');

const GLYPH_INDEX = new Map<string, number>();
LATIN_CHARS.forEach((ch, i) => GLYPH_INDEX.set(ch, i));
for (const [from, to] of Object.entries(ALIASES)) {
  const i = GLYPH_INDEX.get(to);
  if (i !== undefined) GLYPH_INDEX.set(from, i);
}

const HANGUL_CHARS: string[] = Object.keys(HANGUL);
const HANGUL_RUNS: Int16Array[] = HANGUL_CHARS.map((ch) => compileRuns(HANGUL[ch]));
const HANGUL_INDEX = new Map<string, number>(HANGUL_CHARS.map((ch, i) => [ch, i]));

function glyphIndexOf(ch: string): number {
  return GLYPH_INDEX.get(ch) ?? BOX_INDEX;
}

// ---------------------------------------------------------------------------
// Atlas cache: one strip canvas per (set, colour, scale); glyphs are rasterised lazily.
// ---------------------------------------------------------------------------

interface Atlas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  ready: Uint8Array;
  cellW: number;
  cellH: number;
}

const MAX_ATLASES = 96;
const atlasCache = new Map<string, Atlas | null>();
const canUseCanvas = typeof document !== 'undefined';

function getAtlas(set: 'latin' | 'hangul', color: string, scale: number): Atlas | null {
  const key = `${set}|${color}|${scale}`;
  const hit = atlasCache.get(key);
  if (hit !== undefined) return hit;
  let atlas: Atlas | null = null;
  if (canUseCanvas) {
    const count = set === 'latin' ? LATIN_RUNS.length : HANGUL_RUNS.length;
    // Latin cells span the full advance so a glyph may use the spacing column (em dash).
    const cellW = (set === 'latin' ? GLYPH_ADVANCE : HANGUL_W) * scale;
    const cellH = (set === 'latin' ? GLYPH_H : HANGUL_H) * scale;
    const canvas = document.createElement('canvas');
    canvas.width = cellW * count;
    canvas.height = cellH;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = color;
      atlas = { canvas, ctx, ready: new Uint8Array(count), cellW, cellH };
    }
  }
  if (atlasCache.size >= MAX_ATLASES) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = atlasCache.keys().next().value;
    if (oldest !== undefined) atlasCache.delete(oldest);
  }
  atlasCache.set(key, atlas);
  return atlas;
}

function fillRuns(
  ctx: CanvasRenderingContext2D,
  runs: Int16Array,
  x: number,
  y: number,
  scale: number,
): void {
  for (let i = 0; i < runs.length; i += 3) {
    ctx.fillRect(x + runs[i] * scale, y + runs[i + 1] * scale, runs[i + 2] * scale, scale);
  }
}

/** Draw one glyph from `runsTable[index]` with its top-left at integer (x, y). */
function blitGlyph(
  ctx: CanvasRenderingContext2D,
  set: 'latin' | 'hangul',
  index: number,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  const runsTable = set === 'latin' ? LATIN_RUNS : HANGUL_RUNS;
  const runs = runsTable[index];
  if (runs.length === 0) return;
  const atlas = getAtlas(set, color, scale);
  if (!atlas) {
    ctx.fillStyle = color;
    fillRuns(ctx, runs, x, y, scale);
    return;
  }
  const sx = index * atlas.cellW;
  if (!atlas.ready[index]) {
    fillRuns(atlas.ctx, runs, sx, 0, scale);
    atlas.ready[index] = 1;
  }
  ctx.drawImage(atlas.canvas, sx, 0, atlas.cellW, atlas.cellH, x, y, atlas.cellW, atlas.cellH);
}

function normScale(scale: number | undefined): number {
  return Math.max(1, Math.round(scale ?? 1));
}

/** Number of code points in `line` (low surrogates are not counted). */
function charCount(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Extended lines (Korean UI strings). Hangul is drawn from Galmuri9's own bitmap glyphs (the
// author's pixel design, extracted by scripts/gen-galmuri.mjs), Latin letters and digits from the
// 5x7 font above, so mixed lines stay pixel-exact. A character in neither table falls back to the
// Galmuri9 web font linked from index.html, rasterised and thresholded to 1 bit. Each distinct
// line is composed once into a white mask, then tinted per colour and blitted at an integer scale.
// ---------------------------------------------------------------------------

/** CSS family of the Korean pixel web font (loaded by the stylesheet link in index.html). */
export const WEB_FONT_FAMILY = 'Galmuri9';
/** Web-font size whose 1 px pixels match the bitmap glyphs' pixels. */
const WEB_FONT_PX = 10;
/** Baseline row inside the line raster (Galmuri9's ascent): Hangul occupies rows 2..10. */
const RASTER_BASELINE = GALMURI_ASCENT;
/** Raster rows per line (room for descenders). */
const RASTER_H = 14;
/**
 * Raster top relative to the requested glyph top, in font px: Latin glyphs sit on raster rows
 * 3..9 and the 9 px Hangul on rows 2..10, one pixel above and below, so mixed text shares a line.
 */
const RASTER_TOP = -3;
/** Galmuri9's word space. */
const EXT_SPACE = 4;
/** Width estimate for a web-font-only character where no canvas exists (headless tests). */
const WEB_FALLBACK_ADVANCE = 10;
const MAX_EXT_LINES = 600;

interface ExtLine {
  mask: HTMLCanvasElement;
  w: number;
  tints: Map<string, HTMLCanvasElement>;
}

let webFontReady = false;
let epoch = 0;
const extLines = new Map<string, ExtLine | null>();
let measureCtx: CanvasRenderingContext2D | null = null;

/** Bumped when the web font finishes loading: caches of measured / rendered text key on it. */
export function fontEpoch(): number {
  return epoch;
}

/**
 * Wait for the Galmuri9 web font (up to `timeoutMs`) and invalidate lines that used a stand-in
 * face for characters outside the bitmap tables. Resolves to whether the web font is available.
 */
export async function loadWebFont(timeoutMs = 4000): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return false;
  const spec = `${WEB_FONT_PX}px ${WEB_FONT_FAMILY}`;
  try {
    await Promise.race([
      document.fonts.load(spec, '가A1'),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Treated as unavailable below.
  }
  webFontReady = document.fonts.check(spec, '가');
  extLines.clear();
  epoch++;
  return webFontReady;
}

/** True while the Galmuri9 web font is loaded (only needed for characters outside the tables). */
export function webFontAvailable(): boolean {
  return webFontReady;
}

function needsExtended(line: string): boolean {
  for (const ch of line) {
    if (ch !== ' ' && !GLYPH_INDEX.has(ch)) return true;
  }
  return false;
}

/** True when every character of `text` has a bitmap glyph (5x7 or Galmuri9): no web font needed. */
export function hasBitmapGlyphs(text: string): boolean {
  for (const ch of text.toUpperCase()) {
    if (ch !== ' ' && ch !== '\n' && !GLYPH_INDEX.has(ch) && !(ch in GALMURI_GLYPHS)) return false;
  }
  return true;
}

function webFontCss(): string {
  return `${WEB_FONT_PX}px ${WEB_FONT_FAMILY}, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
}

function webCharAdvance(ch: string): number {
  if (!canUseCanvas) return WEB_FALLBACK_ADVANCE;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return WEB_FALLBACK_ADVANCE;
  measureCtx.font = webFontCss();
  return Math.max(1, Math.round(measureCtx.measureText(ch).width));
}

function extAdvance(ch: string): number {
  if (ch === ' ') return EXT_SPACE;
  if (GLYPH_INDEX.has(ch)) return GLYPH_ADVANCE;
  const glyph = GALMURI_GLYPHS[ch];
  return glyph ? glyph[0] : webCharAdvance(ch);
}

function extLineWidth(line: string): number {
  let w = 0;
  for (const ch of line) w += extAdvance(ch);
  // Every advance includes one trailing spacing column.
  return Math.max(0, w - 1);
}

/** Plot one Galmuri9 bitmap glyph with its origin at (x, baseline). */
function plotGalmuri(g: CanvasRenderingContext2D, glyph: GalmuriGlyph, x: number, baseline: number): void {
  const [, xOff, yOff, w, h, hex] = glyph;
  const top = baseline - (yOff + h);
  hex.split(' ').forEach((rowHex, r) => {
    const bits = rowHex.length * 4;
    const row = parseInt(rowHex, 16);
    let run = -1;
    for (let c = 0; c <= w; c++) {
      const on = c < w && ((row >>> (bits - 1 - c)) & 1) === 1;
      if (on && run < 0) run = c;
      if (!on && run >= 0) {
        g.fillRect(x + xOff + run, top + r, c - run, 1);
        run = -1;
      }
    }
  });
}

function rasteriseExtLine(line: string): ExtLine | null {
  if (!canUseCanvas) return null;
  const w = extLineWidth(line);
  const mask = document.createElement('canvas');
  mask.width = w + 2;
  mask.height = RASTER_H;
  const g = mask.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.fillStyle = '#ffffff';
  g.font = webFontCss();
  g.textBaseline = 'alphabetic';
  let x = 0;
  let usedWebFont = false;
  for (const ch of line) {
    if (ch !== ' ') {
      const latin = GLYPH_INDEX.get(ch);
      const glyph = GALMURI_GLYPHS[ch];
      if (latin !== undefined) {
        fillRuns(g, LATIN_RUNS[latin], x, -RASTER_TOP, 1);
      } else if (glyph) {
        plotGalmuri(g, glyph, x, RASTER_BASELINE);
      } else {
        g.fillText(ch, x, RASTER_BASELINE);
        usedWebFont = true;
      }
    }
    x += extAdvance(ch);
  }
  if (usedWebFont) {
    // Web-font glyphs are anti-aliased: snap them to 1 bit like the bitmap pixels around them.
    const img = g.getImageData(0, 0, mask.width, mask.height);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      const on = d[i] >= 128;
      d[i - 3] = 255;
      d[i - 2] = 255;
      d[i - 1] = 255;
      d[i] = on ? 255 : 0;
    }
    g.putImageData(img, 0, 0);
  }
  return { mask, w, tints: new Map() };
}

function extLine(line: string): ExtLine | null {
  const hit = extLines.get(line);
  if (hit !== undefined) return hit;
  const made = rasteriseExtLine(line);
  if (extLines.size >= MAX_EXT_LINES) {
    const oldest = extLines.keys().next().value;
    if (oldest !== undefined) extLines.delete(oldest);
  }
  extLines.set(line, made);
  return made;
}

function extTint(entry: ExtLine, color: string): HTMLCanvasElement | null {
  const hit = entry.tints.get(color);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = entry.mask.width;
  c.height = entry.mask.height;
  const g = c.getContext('2d');
  if (!g) return null;
  g.drawImage(entry.mask, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  entry.tints.set(color, c);
  return c;
}

function drawExtLine(ctx: CanvasRenderingContext2D, line: string, x: number, y: number, scale: number, color: string): void {
  const entry = extLine(line);
  if (!entry) return;
  const tinted = extTint(entry, color);
  if (!tinted) return;
  ctx.drawImage(tinted, x, y + RASTER_TOP * scale, tinted.width * scale, tinted.height * scale);
}

function lineWidth(line: string, scale: number): number {
  const upper = line.toUpperCase();
  if (needsExtended(upper)) return extLineWidth(upper) * scale;
  const n = charCount(line);
  return n > 0 ? (n * GLYPH_ADVANCE - 1) * scale : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Pixel width of `text` (widest line if it contains newlines) at an integer scale. */
export function measureText(text: string, scale?: number): number {
  const s = normScale(scale);
  let widest = 0;
  for (const line of text.split('\n')) widest = Math.max(widest, lineWidth(line, s));
  return widest;
}

/** Height in px of `text` including line spacing between lines (no trailing gap). */
export function measureTextHeight(text: string, scale?: number): number {
  const s = normScale(scale);
  const lines = text.split('\n').length;
  return ((lines - 1) * LINE_HEIGHT + GLYPH_H) * s;
}

/** Truncate `text` with an ellipsis so it is at most `maxWidth` px wide at `scale`. */
export function fitText(text: string, maxWidth: number, scale?: number): string {
  const s = normScale(scale);
  if (measureText(text, s) <= maxWidth) return text;
  const chars = Array.from(text);
  if (needsExtended(text.toUpperCase())) {
    // Proportional web-font text: drop characters until the ellipsised line fits.
    for (let n = chars.length - 1; n > 0; n--) {
      const candidate = chars.slice(0, n).join('').trimEnd() + '…';
      if (measureText(candidate, s) <= maxWidth) return candidate;
    }
    return '';
  }
  const maxChars = Math.max(0, Math.floor((maxWidth / s + 1) / GLYPH_ADVANCE));
  if (maxChars <= 1) return chars.slice(0, maxChars).join('');
  return chars.slice(0, maxChars - 1).join('').trimEnd() + '…';
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  line: string,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  if (needsExtended(line)) {
    drawExtLine(ctx, line, x, y, scale, color);
    return;
  }
  const advance = GLYPH_ADVANCE * scale;
  let cx = x;
  for (const ch of line) {
    const index = glyphIndexOf(ch);
    if (index !== SPACE_INDEX) blitGlyph(ctx, 'latin', index, cx, y, scale, color);
    cx += advance;
  }
}

/**
 * Draw `text` (rendered uppercase) with the top of the glyphs at `y`.
 * `x` is the left edge, centre or right edge depending on `align`. Returns the drawn width.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: TextOptions = {},
): number {
  const scale = normScale(opts.scale);
  const color = opts.color ?? PALETTE.ink;
  const align = opts.align ?? 'left';
  const lines = text.toUpperCase().split('\n');
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  let widest = 0;
  let ly = Math.round(y);
  for (const line of lines) {
    const w = lineWidth(line, scale);
    widest = Math.max(widest, w);
    let lx = Math.round(x);
    if (align === 'center') lx = Math.round(x - w / 2);
    else if (align === 'right') lx = Math.round(x - w);
    if (opts.shadow) {
      const off = Math.max(1, Math.round(opts.shadowOffset ?? 1));
      drawLine(ctx, line, lx + off, ly + off, scale, opts.shadow);
    }
    drawLine(ctx, line, lx, ly, scale, color);
    ly += LINE_HEIGHT * scale;
  }
  ctx.imageSmoothingEnabled = smoothing;
  return widest;
}

/** Width in px of a Hangul string made of the six designed syllables (and spaces). */
export function measureHangul(text: string, scale: number): number {
  const s = normScale(scale);
  let w = 0;
  let prevGlyph = false;
  for (const ch of text) {
    if (ch === ' ') {
      w += HANGUL_SPACE;
      prevGlyph = false;
      continue;
    }
    if (prevGlyph) w += HANGUL_GAP;
    w += HANGUL_W;
    prevGlyph = true;
  }
  return w * s;
}

/**
 * Draw a Hangul string built from the designed syllables (등 고 선 탐 사 대). Characters
 * without a design fall back to the Latin box glyph, vertically centred in the cell.
 */
export function drawHangulText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: string,
  align: 'left' | 'center' | 'right' = 'left',
  shadow?: string,
): number {
  const s = normScale(scale);
  const w = measureHangul(text, s);
  let left = Math.round(x);
  if (align === 'center') left = Math.round(x - w / 2);
  else if (align === 'right') left = Math.round(x - w);
  const top = Math.round(y);
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  const pass = (ox: number, oy: number, col: string): void => {
    let cx = left + ox;
    let prevGlyph = false;
    for (const ch of text) {
      if (ch === ' ') {
        cx += HANGUL_SPACE * s;
        prevGlyph = false;
        continue;
      }
      if (prevGlyph) cx += HANGUL_GAP * s;
      const hi = HANGUL_INDEX.get(ch);
      if (hi !== undefined) {
        blitGlyph(ctx, 'hangul', hi, cx, top + oy, s, col);
      } else {
        const bx = cx + Math.floor(((HANGUL_W - GLYPH_W) * s) / 2);
        const by = top + oy + Math.floor(((HANGUL_H - GLYPH_H) * s) / 2);
        blitGlyph(ctx, 'latin', BOX_INDEX, bx, by, s, col);
      }
      cx += HANGUL_W * s;
      prevGlyph = true;
    }
  };
  if (shadow) pass(1, 1, shadow);
  pass(0, 0, color);
  ctx.imageSmoothingEnabled = smoothing;
  return w;
}

/** Draw the subtitle "등고선 탐사대" with its top-left (or top-centre) at (x, y). Returns its width. */
export function drawHangulTitle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
  align: 'left' | 'center' | 'right' = 'left',
  shadow?: string,
): number {
  return drawHangulText(ctx, HANGUL_TITLE, x, y, scale, color, align, shadow);
}
