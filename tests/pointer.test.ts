// Canvas pointer input (src/pointer.ts) driven through the real Game with a fake clock: touch taps aim by
// quarter-planes around the surveyor, while every gesture still gives at most the one action it means
// and the mouse keeps its tile-by-tile behaviour.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUD_X, MAP_ORIGIN_X, MAP_ORIGIN_Y, TILE } from '../src/config';
import { Game } from '../src/game';
import { SWIPE_MIN_PX, TOUCH_SLOP_PX, touchStepDirection } from '../src/input';
import { generateMap } from '../src/map';
import { HOLD_DELAY_MS, HOLD_STEP_MS, PointerInput } from '../src/pointer';
import type { PointerHost, PointerSample } from '../src/pointer';
import type { AudioEngine, Dir } from '../src/types';
import { addButton, ui } from '../src/ui';
import type { ButtonId } from '../src/ui';

const silent: AudioEngine = {
  muted: false,
  unlock: () => undefined,
  toggleMute: () => false,
  footstep: () => undefined,
  bump: () => undefined,
  cacheCollected: () => undefined,
  discovery: () => undefined,
  lowStamina: () => undefined,
  victory: () => undefined,
  defeat: () => undefined,
  expeditionStart: () => undefined,
  stopAll: () => undefined,
};

/** CSS px per virtual px of a landscape phone (an 844 x 390 viewport fits the 1280 x 800 canvas at ~0.49). */
const PHONE = 0.4875;
const SEED = 205;

/** A pointer host on a fake clock: timers fire only when the test advances time. */
class Harness implements PointerHost {
  readonly game = new Game(silent, generateMap, { seed: SEED, now: 0, startPlaying: true });
  readonly input = new PointerInput(this);
  readonly buttons: ButtonId[] = [];
  cardToggles = 0;
  private t = 1000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  runButton(id: ButtonId): void {
    this.buttons.push(id);
  }
  toggleReportCard(): void {
    this.cardToggles++;
  }
  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimer(id: number): void {
    this.timers.delete(id);
  }
  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Run the clock forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }

  /** Virtual-pixel centre of the surveyor's tile. */
  centre(): { x: number; y: number } {
    const p = this.game.state.player;
    return { x: MAP_ORIGIN_X + (p.x + 0.5) * TILE, y: MAP_ORIGIN_Y + (p.y + 0.5) * TILE };
  }

  sample(x: number, y: number, mouse = false, id = 1): PointerSample {
    return { id, mouse, x, y, clientX: x * PHONE, clientY: y * PHONE };
  }

  /** A quick touch (or click) at a virtual point: down, then up 80 ms later without moving. */
  tap(x: number, y: number, mouse = false): void {
    this.input.down(this.sample(x, y, mouse));
    this.advance(80);
    this.input.up(this.sample(x, y, mouse));
  }

  /** A touch tap offset from the surveyor's centre by (dx, dy) tiles. */
  tapTiles(dx: number, dy: number, mouse = false): void {
    const c = this.centre();
    this.tap(c.x + dx * TILE, c.y + dy * TILE, mouse);
  }

  get turns(): number {
    return this.game.state.turns;
  }
  get pos(): { x: number; y: number } {
    return { x: this.game.state.player.x, y: this.game.state.player.y };
  }
}

const OFFSET: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Where the surveyor stands after stepping `dir` from `from` (the spawn has four open neighbours). */
const after = (from: { x: number; y: number }, dir: Dir): { x: number; y: number } => ({
  x: from.x + OFFSET[dir][0],
  y: from.y + OFFSET[dir][1],
});

function resetUi(): void {
  ui.buttons.length = 0;
  ui.archivesOpen = false;
  ui.taps = [];
  if (ui.pause.isOpen) ui.pause.close();
}

describe('touch aim', () => {
  it('reads the quarter-plane around the surveyor in pixels, with the own tile silent', () => {
    expect(touchStepDirection(100, 40, 100, 100, 6)).toBe('up');
    expect(touchStepDirection(140, 70, 100, 100, 6)).toBe('right');
    // A diagonal tile is decided by where the finger leans, not always sideways.
    expect(touchStepDirection(100 + 9, 100 - 15, 100, 100, 6)).toBe('up');
    expect(touchStepDirection(100 + 15, 100 - 9, 100, 100, 6)).toBe('right');
    expect(touchStepDirection(103, 97, 100, 100, 6)).toBeNull();
  });
});

describe('pointer input', () => {
  let h: Harness;
  beforeEach(() => {
    resetUi();
    h = new Harness();
  });
  afterEach(resetUi);

  describe('touch taps', () => {
    it('a tap gives exactly one step, toward where it landed', () => {
      for (const dir of ['up', 'right', 'down', 'left'] as const) {
        const g = new Harness();
        const start = g.pos;
        g.tapTiles(OFFSET[dir][0], OFFSET[dir][1]);
        expect(g.turns, dir).toBe(1);
        expect(g.pos, dir).toEqual(after(start, dir));
        g.advance(5000);
        expect(g.turns, `${dir}: nothing more after the tap`).toBe(1);
      }
    });

    it('takes imprecise but clearly directional taps: diagonal tiles, far away, off the map edge', () => {
      const start = h.pos;
      // On the tile up-and-right, leaning up: a tap there used to step sideways.
      h.tapTiles(0.8, -1.2);
      expect(h.pos).toEqual(after(start, 'up'));
      // Far away and well off the axis, but clearly below.
      const g = new Harness();
      g.tapTiles(-6, 14);
      expect(g.pos).toEqual(after(start, 'down'));
      // On the sheet margin above the map (the title band) and left of it: no tile there at all.
      const top = new Harness();
      top.tap(top.centre().x + 4, 20);
      expect(top.pos).toEqual(after(start, 'up'));
      const left = new Harness();
      left.tap(8, left.centre().y - 5);
      expect(left.pos).toEqual(after(start, 'left'));
      expect([h.turns, g.turns, top.turns, left.turns]).toEqual([1, 1, 1, 1]);
    });

    it('does nothing for a tap on the surveyor itself or on the HUD panel', () => {
      const c = h.centre();
      h.tap(c.x + 3, c.y - 4);
      h.tap(HUD_X + 40, c.y);
      h.tap(HUD_X + 120, 20);
      expect(h.turns).toBe(0);
      h.advance(5000);
      expect(h.turns).toBe(0);
    });

    it('keeps a trembling fingertip a single tap step', () => {
      const start = h.pos;
      const c = h.centre();
      const x = c.x;
      const y = c.y - 3 * TILE;
      h.input.down(h.sample(x, y));
      const jitter = (TOUCH_SLOP_PX - 1) / PHONE;
      for (const [dx, dy] of [[jitter, 0], [0, -jitter], [-jitter, jitter / 2], [0, 0]]) {
        h.advance(40);
        h.input.move(h.sample(x + dx, y + dy));
      }
      h.input.up(h.sample(x + jitter, y));
      expect(h.turns).toBe(1);
      expect(h.pos).toEqual(after(start, 'up'));
    });

    it('never adds phantom turns under rapid input', () => {
      for (let k = 0; k < 6; k++) {
        h.tapTiles(0, k % 2 === 0 ? -2 : 2);
        h.advance(10);
      }
      expect(h.turns).toBe(6);
      // A swipe followed at once by a tap: two gestures, two turns.
      const c = h.centre();
      h.input.down(h.sample(c.x, c.y));
      h.input.move(h.sample(c.x + (SWIPE_MIN_PX + 2) / PHONE, c.y));
      h.input.up(h.sample(c.x + (SWIPE_MIN_PX + 2) / PHONE, c.y));
      h.tapTiles(0, 3);
      expect(h.turns).toBe(8);
    });

    it('lets a second press replace the first without either acting twice', () => {
      const c = h.centre();
      h.input.down(h.sample(c.x, c.y - 3 * TILE, false, 1));
      h.input.down(h.sample(c.x + 3 * TILE, c.y, false, 2));
      h.input.up(h.sample(c.x, c.y - 3 * TILE, false, 1)); // the replaced press: ignored
      expect(h.turns).toBe(0);
      h.input.up(h.sample(c.x + 3 * TILE, c.y, false, 2));
      expect(h.turns).toBe(1);
    });
  });

  describe('touch swipes', () => {
    it('steps exactly once, as it crosses the threshold, wherever it starts', () => {
      const start = h.pos;
      // Starting far from the surveyor makes no difference to a swipe.
      const x = HUD_X - 200;
      const y = 600;
      h.input.down(h.sample(x, y));
      h.input.move(h.sample(x, y - (SWIPE_MIN_PX - 2) / PHONE));
      expect(h.turns).toBe(0);
      h.input.move(h.sample(x, y - (SWIPE_MIN_PX + 1) / PHONE));
      expect(h.turns).toBe(1);
      h.input.move(h.sample(x + 200, y - 300));
      h.input.move(h.sample(x, y));
      h.advance(HOLD_DELAY_MS * 3);
      h.input.up(h.sample(x, y));
      expect(h.turns).toBe(1);
      expect(h.pos).toEqual(after(start, 'up'));
    });
  });

  describe('touch holds', () => {
    it('walks like a held key toward the finger, from the hold delay, and stops there', () => {
      const ref = new Game(silent, generateMap, { seed: SEED, now: 0, startPlaying: true });
      const c = h.centre();
      h.input.down(h.sample(c.x + 4, c.y - 3 * TILE));
      h.advance(HOLD_DELAY_MS - 1);
      expect(h.turns).toBe(0);
      h.advance(1);
      ref.handleAction('up', h.now());
      expect(h.turns).toBe(1);
      for (let k = 0; k < 2; k++) {
        h.advance(HOLD_STEP_MS);
        ref.handleAction('up', h.now(), true);
      }
      // Three tiles up the finger is under the surveyor: the walk has arrived and waits there.
      h.advance(HOLD_STEP_MS * 4);
      expect(h.pos).toEqual({ x: ref.state.player.x, y: ref.state.player.y });
      expect(h.turns).toBe(ref.state.turns);
      expect(h.turns).toBeLessThanOrEqual(3);
      h.input.up(h.sample(c.x + 4, c.y - 3 * TILE));
      expect(h.turns).toBe(ref.state.turns);
      expect(h.pendingTimers).toBe(0);
    });

    it('ignores a tremble while held but follows a deliberate slide', () => {
      const c = h.centre();
      const y = c.y - 6 * TILE;
      h.input.down(h.sample(c.x, y));
      h.advance(HOLD_DELAY_MS);
      expect(h.turns).toBe(1);
      const startX = h.pos.x;
      // A tremble sideways keeps the walk heading up.
      h.input.move(h.sample(c.x + (TOUCH_SLOP_PX - 2) / PHONE, y));
      h.advance(HOLD_STEP_MS);
      expect(h.pos.x).toBe(startX);
      // Sliding well to the right retargets: the next held steps turn right.
      h.input.move(h.sample(c.x + 20 * TILE, h.centre().y));
      h.advance(HOLD_STEP_MS);
      expect(h.pos.x).toBe(startX + 1);
      h.input.up(h.sample(c.x + 20 * TILE, h.centre().y));
    });
  });

  describe('interruptions', () => {
    it('a cancelled press never acts: not while held, not on a late release', () => {
      const c = h.centre();
      h.input.down(h.sample(c.x, c.y - 3 * TILE));
      h.input.cancel(); // blur, hidden tab, resize, rotation, pause menu
      h.advance(HOLD_DELAY_MS * 4);
      h.input.up(h.sample(c.x, c.y - 3 * TILE));
      expect(h.turns).toBe(0);
      expect(h.pendingTimers).toBe(0);
    });

    it('stops a held walk the moment the press is cancelled', () => {
      const c = h.centre();
      h.input.down(h.sample(c.x, c.y - 8 * TILE));
      h.advance(HOLD_DELAY_MS + HOLD_STEP_MS);
      const walked = h.turns;
      expect(walked).toBeGreaterThan(0);
      h.input.cancel(1); // pointercancel / lostpointercapture for this pointer
      h.advance(HOLD_STEP_MS * 5);
      expect(h.turns).toBe(walked);
    });

    it('ignores a cancel for another pointer', () => {
      h.input.down(h.sample(h.centre().x, h.centre().y - 2 * TILE));
      h.input.cancel(7);
      expect(h.input.pressing).toBe(true);
      h.advance(60);
      h.input.up(h.sample(h.centre().x, h.centre().y - 2 * TILE));
      expect(h.turns).toBe(1);
    });

    it('ends a held walk when the expedition is replaced under it', () => {
      const c = h.centre();
      h.input.down(h.sample(c.x, c.y - 8 * TILE));
      h.advance(HOLD_DELAY_MS);
      expect(h.turns).toBe(1);
      h.game.retrySheet(h.now());
      h.advance(HOLD_STEP_MS * 4);
      h.input.up(h.sample(c.x, c.y - 8 * TILE));
      expect(h.game.state.turns).toBe(0);
    });
  });

  describe('interface', () => {
    it('a touch on a button runs the button and never moves the surveyor', () => {
      const c = h.centre();
      // A button drawn over the map (end-card buttons and the like sit on the sheet).
      addButton('copySeed', c.x - 30, c.y - 40, 60, 20);
      h.tap(c.x, c.y - 30);
      expect(h.buttons).toEqual(['copySeed']);
      // Held on the button: no walk; swiped off it: no swipe step either.
      h.input.down(h.sample(c.x, c.y - 30));
      h.advance(HOLD_DELAY_MS * 3);
      h.input.move(h.sample(c.x + 200, c.y - 30));
      h.input.up(h.sample(c.x + 200, c.y - 30));
      expect(h.turns).toBe(0);
      expect(h.buttons).toEqual(['copySeed']);
    });

    it('does not move while the pause menu or the archives are open', () => {
      h.game.pause(h.now());
      ui.pause.open(h.now());
      h.tapTiles(0, -3);
      const c = h.centre();
      h.input.down(h.sample(c.x, c.y));
      h.input.move(h.sample(c.x, c.y - 100));
      h.input.up(h.sample(c.x, c.y - 100));
      h.input.down(h.sample(c.x, c.y - 3 * TILE));
      h.advance(HOLD_DELAY_MS * 3);
      h.input.up(h.sample(c.x, c.y - 3 * TILE));
      expect(h.turns).toBe(0);
      ui.pause.close();
      h.game.resume(h.now());
      ui.archivesOpen = true;
      h.tapTiles(0, -3);
      expect(ui.archivesOpen).toBe(false); // a tap beside the ledger closes it...
      expect(h.turns).toBe(0); // ...and does not step
    });
  });

  describe('mouse (unchanged)', () => {
    it('steps toward the clicked tile, ties going sideways, and ignores the margins', () => {
      const start = h.pos;
      // The same diagonal point a touch reads as up: the mouse keeps the tile rule.
      h.tapTiles(0.8, -1.2, true);
      expect(h.pos).toEqual(after(start, 'right'));
      const g = new Harness();
      g.tap(g.centre().x, 20, true); // title band: no tile, no step
      g.tap(8, g.centre().y, true);
      expect(g.turns).toBe(0);
    });

    it('swipes on release, and a held button walks toward its tile', () => {
      const start = h.pos;
      const c = h.centre();
      h.input.down(h.sample(c.x, c.y, true));
      h.input.move(h.sample(c.x - 80, c.y, true));
      expect(h.turns).toBe(0);
      h.input.up(h.sample(c.x - 80, c.y, true));
      expect(h.pos).toEqual(after(start, 'left'));
      const g = new Harness();
      const gc = g.centre();
      g.input.down(g.sample(gc.x, gc.y + 2 * TILE, true));
      g.advance(HOLD_DELAY_MS + HOLD_STEP_MS * 3);
      g.input.up(g.sample(gc.x, gc.y + 2 * TILE, true));
      expect(g.turns).toBeLessThanOrEqual(2);
      expect(g.pos.y).toBeGreaterThan(start.y);
      expect(g.pos.x).toBe(start.x);
    });
  });
});
