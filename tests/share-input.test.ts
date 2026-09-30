import { describe, expect, it } from 'vitest';
import { clientToVirtual, directionToward, keyToUiKey, swipeDirection, SWIPE_MIN_PX, TOUCH_SLOP_PX, TouchGesture } from '../src/input';
import { GAME_TITLE, PUBLIC_GAME_URL, seedText, shareText } from '../src/share';
import type { ExpeditionStats } from '../src/types';

const stats = (over: Partial<ExpeditionStats> = {}): ExpeditionStats => ({
  outcome: 'victory',
  turns: 67,
  staminaSpent: 120,
  staminaLeft: 50,
  cachesCollected: 3,
  cachesTotal: 4,
  maxElevation: 0.91,
  percentMapped: 15.456,
  elapsedMs: 12000,
  grade: 'S',
  breakdown: null,
  ...over,
});

describe('sharing', () => {
  it('always points at the public itch.io page, never the embedded iframe host', () => {
    expect(PUBLIC_GAME_URL).toBe('https://carto-studio.itch.io/the-carto-rogue');
    expect(seedText(721405)).toBe(`${GAME_TITLE} #721405 | https://carto-studio.itch.io/the-carto-rogue`);
    expect(shareText(1, stats())).not.toMatch(/itch\.zone|localhost/);
  });

  it('matches the Wordle-style result format', () => {
    expect(shareText(721405, stats(), 'en')).toBe(
      `${GAME_TITLE} #721405 | Summit: Conquered | Turns: 67 | Explored: 15.5% | Grade: S | ${PUBLIC_GAME_URL}`,
    );
  });

  it('reports failures and localises the labels', () => {
    const text = shareText(9, stats({ outcome: 'defeat', grade: 'F', percentMapped: 3 }), 'ko');
    expect(text).toBe(`${GAME_TITLE} #9 | 정상: 실패 | 턴: 67 | 탐사: 3.0% | 등급: F | ${PUBLIC_GAME_URL}`);
  });
});

describe('pointer input', () => {
  it('steps along the dominant axis toward a tapped tile (ties go horizontal)', () => {
    expect(directionToward(1, 0)).toBe('right');
    expect(directionToward(0, -1)).toBe('up');
    expect(directionToward(-5, 2)).toBe('left');
    expect(directionToward(2, 7)).toBe('down');
    expect(directionToward(-3, 3)).toBe('left');
    expect(directionToward(0, 0)).toBeNull();
  });

  it('recognises swipes past the threshold only', () => {
    expect(swipeDirection(SWIPE_MIN_PX - 1, 0)).toBeNull();
    expect(swipeDirection(SWIPE_MIN_PX, 4)).toBe('right');
    expect(swipeDirection(-3, -40)).toBe('up');
  });

  describe('touch gestures', () => {
    it('keeps a trembling or rolling fingertip a tap, and lets a still one become a hold', () => {
      const tap = new TouchGesture(100, 100);
      for (const [x, y] of [[103, 98], [96, 104], [100, 109]]) expect(tap.move(x, y)).toBeNull();
      expect(tap.reading).toBe('pending');
      const held = new TouchGesture(100, 100);
      held.move(100 + TOUCH_SLOP_PX - 1, 100);
      expect(held.hold()).toBe(true);
      expect(held.reading).toBe('hold');
    });

    it('never turns a finger that has started moving into a hold', () => {
      const g = new TouchGesture(100, 100);
      g.move(100 + TOUCH_SLOP_PX, 100);
      g.move(100, 100); // back where it landed
      expect(g.hold()).toBe(false);
      expect(g.reading).toBe('pending'); // still lifts as a tap
    });

    it('swipes once, on the move that crosses the threshold, in the direction travelled so far', () => {
      const g = new TouchGesture(100, 100);
      expect(g.move(100 + SWIPE_MIN_PX - 1, 103)).toBeNull();
      expect(g.move(100 + SWIPE_MIN_PX, 104)).toBe('right');
      expect(g.reading).toBe('swipe');
      // A hook or a return at the end of the stroke fires nothing more, and it can no longer hold.
      expect(g.move(100, 160)).toBeNull();
      expect(g.move(100, 100)).toBeNull();
      expect(g.hold()).toBe(false);
      expect(new TouchGesture(0, 0).move(-6, -SWIPE_MIN_PX)).toBe('up');
    });

    it('does not swipe once it is a hold', () => {
      const g = new TouchGesture(100, 100);
      expect(g.hold()).toBe(true);
      expect(g.move(200, 100)).toBeNull();
      expect(g.reading).toBe('hold');
    });

    it('retargets a held walk only when the finger slides on, not when it trembles', () => {
      const g = new TouchGesture(100, 100);
      expect(g.retarget(130, 100)).toBe(false); // not held yet
      g.hold();
      expect(g.retarget(100 + TOUCH_SLOP_PX - 1, 100 - 3)).toBe(false);
      expect(g.retarget(100, 100 + TOUCH_SLOP_PX)).toBe(true);
      // The slop now runs from the new target point.
      expect(g.retarget(100 + 4, 100 + TOUCH_SLOP_PX + 4)).toBe(false);
      expect(g.retarget(100, 100 + 2 * TOUCH_SLOP_PX)).toBe(true);
    });
  });

  it('maps client coordinates into the letterboxed virtual canvas', () => {
    // A 1280x800 image fitted at 2x inside a 3000x1600 fullscreen box: 220 px bars left and right.
    const rect = { left: 0, top: 0, width: 3000, height: 1600 };
    expect(clientToVirtual(220, 0, rect, 1280, 800)).toEqual({ x: 0, y: 0 });
    expect(clientToVirtual(1500, 800, rect, 1280, 800)).toEqual({ x: 640, y: 400 });
    // A plainly scaled canvas at an offset.
    expect(clientToVirtual(110, 60, { left: 10, top: 10, width: 640, height: 400 }, 1280, 800)).toEqual({ x: 200, y: 100 });
  });

  it('maps interface keys on any layout', () => {
    expect(keyToUiKey('KeyL', 'l')).toBe('archives');
    expect(keyToUiKey('', 'ㅣ')).toBe('archives');
    expect(keyToUiKey('KeyF', 'ㄹ')).toBe('fullscreen');
    expect(keyToUiKey('Escape', 'Escape')).toBe('close');
    expect(keyToUiKey('KeyQ', 'q')).toBeNull();
  });
});
