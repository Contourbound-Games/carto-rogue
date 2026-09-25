import { describe, expect, it } from 'vitest';
import { clientToVirtual, directionToward, keyToUiKey, swipeDirection, SWIPE_MIN_PX } from '../src/input';
import { GAME_TITLE, seedUrl, shareText } from '../src/share';
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
  ...over,
});

describe('seed links', () => {
  it('replaces the query and drops the hash', () => {
    expect(seedUrl('https://example.com/play/index.html?seed=1&debug=1#x', 721405)).toBe(
      'https://example.com/play/index.html?seed=721405',
    );
    expect(seedUrl('http://localhost:5173/', 42)).toBe('http://localhost:5173/?seed=42');
  });

  it('falls back for unparsable bases', () => {
    expect(seedUrl('not a url?x=1', 7)).toBe('not a url?seed=7');
  });
});

describe('share text', () => {
  it('matches the Wordle-style format', () => {
    expect(shareText(721405, stats(), 'https://x.io/?seed=721405', 'en')).toBe(
      `${GAME_TITLE} #721405 | Summit: Conquered | Turns: 67 | Explored: 15.5% | Grade: S | https://x.io/?seed=721405`,
    );
  });

  it('reports failures and localises the labels', () => {
    const text = shareText(9, stats({ outcome: 'defeat', grade: 'F', percentMapped: 3 }), 'u', 'ko');
    expect(text).toBe(`${GAME_TITLE} #9 | 정상: 실패 | 턴: 67 | 탐사: 3.0% | 등급: F | u`);
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
