// Player input: keyboard -> game action mapping, pointer / touch geometry, and the ?seed URL
// parameter. KeyboardEvent.code (the physical key) is checked first so WASD works on every layout,
// including the Korean 2-set layout where e.key yields Hangul jamo and IMEs report 'Process'.
import type { Action, Dir } from './types';

/** Interface keys handled outside the game rules. */
export type UiKey = 'archives' | 'fullscreen' | 'close' | 'pause' | 'card';

const UI_BY_CODE: ReadonlyMap<string, UiKey> = new Map<string, UiKey>([
  ['KeyL', 'archives'],
  ['KeyF', 'fullscreen'],
  ['KeyP', 'pause'],
  ['KeyH', 'card'],
  ['Escape', 'close'],
]);

const UI_BY_KEY: ReadonlyMap<string, UiKey> = new Map<string, UiKey>([
  ['l', 'archives'],
  ['ㅣ', 'archives'],
  ['f', 'fullscreen'],
  ['ㄹ', 'fullscreen'],
  ['p', 'pause'],
  ['ㅔ', 'pause'],
  ['h', 'card'],
  ['ㅗ', 'card'],
  ['Escape', 'close'],
  ['Esc', 'close'],
]);

/** Map a keydown to an interface key (archives ledger, fullscreen, pause, report card, close), or null. */
export function keyToUiKey(code: string, key: string): UiKey | null {
  const byCode = UI_BY_CODE.get(code);
  if (byCode !== undefined) return byCode;
  const normalised = key.length === 1 ? key.toLowerCase() : key;
  return UI_BY_KEY.get(normalised) ?? null;
}

/**
 * The cardinal step toward a target offset (dx, dy in tiles): the dominant axis wins, a tie goes to
 * the horizontal axis. Null when the offset is zero.
 */
export function directionToward(dx: number, dy: number): Dir | null {
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/** Minimum travel (CSS px) for a pointer drag to count as a swipe rather than a tap. */
export const SWIPE_MIN_PX = 28;

/** Cardinal swipe direction for a drag of (dx, dy) CSS px, or null if it is too short to be one. */
export function swipeDirection(dx: number, dy: number, minPx = SWIPE_MIN_PX): Dir | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < minPx) return null;
  return directionToward(dx, dy);
}

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Client (CSS) coordinates -> virtual canvas pixels. The drawn image is fitted inside the element
 * box with its aspect ratio kept (fullscreen letterboxes the canvas via object-fit: contain), so the
 * content rectangle is computed rather than assumed to fill the box.
 */
export function clientToVirtual(
  clientX: number,
  clientY: number,
  rect: ClientRect,
  virtualW: number,
  virtualH: number,
): { x: number; y: number } {
  const scale = Math.min(rect.width / virtualW, rect.height / virtualH) || 1;
  const offX = (rect.width - virtualW * scale) / 2;
  const offY = (rect.height - virtualH * scale) / 2;
  return { x: (clientX - rect.left - offX) / scale, y: (clientY - rect.top - offY) / scale };
}

const BY_CODE: ReadonlyMap<string, Action> = new Map<string, Action>([
  ['KeyW', 'up'],
  ['KeyA', 'left'],
  ['KeyS', 'down'],
  ['KeyD', 'right'],
  ['ArrowUp', 'up'],
  ['ArrowRight', 'right'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['KeyR', 'restart'],
  ['KeyM', 'mute'],
  ['Enter', 'confirm'],
  ['NumpadEnter', 'confirm'],
  ['Space', 'confirm'],
]);

/** Fallback by produced character / key name, for environments that leave `code` empty. */
const BY_KEY: ReadonlyMap<string, Action> = new Map<string, Action>([
  ['w', 'up'],
  ['a', 'left'],
  ['s', 'down'],
  ['d', 'right'],
  ['r', 'restart'],
  ['m', 'mute'],
  // Korean 2-set (Dubeolsik) jamo on the same physical keys: W A S D R M (+ shifted W / R).
  ['ㅈ', 'up'],
  ['ㅉ', 'up'],
  ['ㅁ', 'left'],
  ['ㄴ', 'down'],
  ['ㅇ', 'right'],
  ['ㄱ', 'restart'],
  ['ㄲ', 'restart'],
  ['ㅡ', 'mute'],
  ['ArrowUp', 'up'],
  ['ArrowRight', 'right'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  // Legacy key names still emitted by some older engines.
  ['Up', 'up'],
  ['Right', 'right'],
  ['Down', 'down'],
  ['Left', 'left'],
  ['Enter', 'confirm'],
  [' ', 'confirm'],
  ['Spacebar', 'confirm'],
]);

/** Map a keydown to a game action, or null if the key is not a game control. */
export function keyToAction(code: string, key: string): Action | null {
  const byCode = BY_CODE.get(code);
  if (byCode !== undefined) return byCode;
  const normalised = key.length === 1 ? key.toLowerCase() : key;
  return BY_KEY.get(normalised) ?? null;
}

/**
 * Parse the ?seed=<n> URL parameter. Returns the seed, `undefined` when the parameter is absent or
 * blank, or `null` when it is present but not a 32-bit unsigned integer (the caller warns and ignores
 * it). Anything Number() reads as such an integer is accepted, e.g. '0x10' = 16 and '1e3' = 1000.
 */
export function parseSeed(raw: string | null): number | null | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null;
  // '-0' passes the checks above; fold it into a plain 0.
  return seed === 0 ? 0 : seed;
}
