// Canvas pointer input: interface buttons, tap-to-step, press-and-hold walking and swipes. main.ts turns
// DOM pointer events into PointerSamples and owns the rest of the page (focus, audio unlock, pointer
// capture, hover cursor); this class owns the press itself, so the whole gesture flow runs headless.
//
// A mouse press acts on the exact pointer: it steps toward the clicked tile, swipes when released far
// enough from where it went down, and a held press follows the pointer tile by tile.
//
// A touch (or pen) press is read through a TouchGesture, so a trembling or rolling fingertip still
// gives the one step it meant. It aims by quarter-planes around the surveyor instead of by tiles: a
// finger anywhere on the sheet side of the canvas (everything left of the HUD panel, sheet margins
// included) that is clearly above, below, left or right of the surveyor asks for that step, so a phone
// player never has to hit the few-pixel tiles right beside the sprite. Only the aim changes; what a
// press can do (one tap step, one swipe step, or held steps) is the same as for the mouse.
import { HUD_X, MAP_H, MAP_ORIGIN_X, MAP_ORIGIN_Y, MAP_W, MOVE_REPEAT_MS, TILE } from './config';
import type { Game } from './game';
import { directionToward, swipeDirection, touchStepDirection, TouchGesture } from './input';
import type { Dir, GameState, Point } from './types';
import { addTap, buttonAt, closeArchives, ui } from './ui';
import type { ButtonId } from './ui';

/** Holding a finger / button on the map keeps walking toward it, one step per this interval (a little
 * slower than a held key, so it stays controllable)... */
export const HOLD_STEP_MS = Math.round(MOVE_REPEAT_MS * 1.3);
/** ...from this long after the press: the first held step, which a quick tap never reaches. */
export const HOLD_DELAY_MS = 3 * HOLD_STEP_MS;
/** End cards ignore a stray tap this soon after they appear. */
export const END_CARD_TAP_GUARD_MS = 500;

/** One pointer event: client (CSS) coordinates for gesture distances, virtual canvas pixels for aiming. */
export interface PointerSample {
  id: number;
  /** A mouse press; anything else (touch, pen) is read as a gesture. */
  mouse: boolean;
  clientX: number;
  clientY: number;
  x: number;
  y: number;
}

/** What the pointer input needs from the page. */
export interface PointerHost {
  readonly game: Game;
  runButton(id: ButtonId, now: number): void;
  toggleReportCard(): void;
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
}

interface Press {
  id: number;
  clientX: number;
  clientY: number;
  /** Where the press went down, in virtual pixels (a touch taps here, not where it lifts). */
  at: Point;
  /** Gesture reading for a touch / pen press; null for the mouse. */
  touch: TouchGesture | null;
  button: ButtonId | null;
  /** Mouse: the target tile while the press is on the map during play. */
  tile: Point | null;
  /** Touch: the aim point (virtual px) while the press is on the sheet side during play. */
  aim: Point | null;
  /** The expedition the press began on; a held walk never carries over to another one. */
  state: GameState;
  /** Steps already taken by holding (the release then takes no extra tap step). */
  held: number;
  timer: number;
}

/** The map tile under a virtual-pixel point, or null off the map. */
export function tileAt(v: Point): Point | null {
  const tx = Math.floor((v.x - MAP_ORIGIN_X) / TILE);
  const ty = Math.floor((v.y - MAP_ORIGIN_Y) / TILE);
  return tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H ? { x: tx, y: ty } : null;
}

/** Touch aims from anywhere left of the HUD panel: the map, the sheet margins, a fullscreen letterbox. */
export function onTouchSurface(v: Point): boolean {
  return v.x < HUD_X;
}

/** A point pulled onto the map's pixel rectangle (a held walk ends at the sheet edge, not against it). */
function clampToMap(v: Point): Point {
  const x = Math.min(Math.max(v.x, MAP_ORIGIN_X), MAP_ORIGIN_X + MAP_W * TILE - 1);
  const y = Math.min(Math.max(v.y, MAP_ORIGIN_Y), MAP_ORIGIN_Y + MAP_H * TILE - 1);
  return { x, y };
}

export class PointerInput {
  private press: Press | null = null;

  constructor(private readonly host: PointerHost) {}

  private get game(): Game {
    return this.host.game;
  }

  /** True while a press is being tracked. */
  get pressing(): boolean {
    return this.press !== null;
  }

  /** The cardinal step a touch aimed at `v` asks for, from where the surveyor stands now. */
  private touchDir(v: Point): Dir | null {
    const p = this.game.state.player;
    return touchStepDirection(v.x, v.y, MAP_ORIGIN_X + (p.x + 0.5) * TILE, MAP_ORIGIN_Y + (p.y + 0.5) * TILE, TILE / 2);
  }

  private stepToward(tile: Point, now: number, repeat: boolean): void {
    const dir = directionToward(tile.x - this.game.state.player.x, tile.y - this.game.state.player.y);
    if (dir) this.game.handleAction(dir, now, repeat);
  }

  private swipeStep(dir: Dir, now: number): void {
    if (ui.archivesOpen || ui.contracts.isOpen || ui.pause.isOpen) return;
    const phase = this.game.state.phase;
    if (phase === 'playing' || phase === 'title') this.game.handleAction(dir, now);
  }

  private onEndCard(): boolean {
    const phase = this.game.state.phase;
    return phase === 'gameover' || phase === 'victory';
  }

  /** Drop the press without acting (release lost, pause opened, focus lost, viewport changed). */
  cancel(id?: number): void {
    if (!this.press || (id !== undefined && this.press.id !== id)) return;
    this.host.clearTimer(this.press.timer);
    this.press = null;
  }

  /** One held step, then the next one HOLD_STEP_MS later, for as long as the press lasts. */
  private holdStep(current: Press): void {
    if (this.press !== current) return;
    // The walk was aimed at the sheet it began on; a new expedition (R on a keyboard) ends it.
    if (this.game.state !== current.state) {
      this.cancel();
      return;
    }
    // A touch that has already moved is becoming a swipe or a tap, never a hold.
    if (current.touch && !current.touch.hold()) return;
    current.timer = this.host.setTimer(() => this.holdStep(current), HOLD_STEP_MS);
    if (this.game.state.phase !== 'playing' || ui.pause.isOpen) return;
    const now = this.host.now();
    // Held steps behave like a held key: they stop at fatal steps and fresh discoveries.
    if (current.aim) {
      const target = clampToMap(current.aim);
      const tile = tileAt(target);
      current.held++;
      if (tile) addTap(tile.x, tile.y, now);
      const dir = this.touchDir(target);
      if (dir) this.game.handleAction(dir, now, current.held > 1);
    } else if (current.tile) {
      current.held++;
      addTap(current.tile.x, current.tile.y, now);
      this.stepToward(current.tile, now, current.held > 1);
    }
  }

  down(e: PointerSample): void {
    this.cancel();
    const v = { x: e.x, y: e.y };
    const button = buttonAt(v.x, v.y);
    const live = !button && !ui.archivesOpen && !ui.contracts.isOpen && !ui.pause.isOpen && this.game.state.phase === 'playing';
    const current: Press = {
      id: e.id,
      clientX: e.clientX,
      clientY: e.clientY,
      at: v,
      touch: e.mouse ? null : new TouchGesture(e.clientX, e.clientY),
      button,
      tile: live && e.mouse ? tileAt(v) : null,
      aim: live && !e.mouse && onTouchSurface(v) ? v : null,
      state: this.game.state,
      held: 0,
      timer: 0,
    };
    this.press = current;
    if (current.tile || current.aim) current.timer = this.host.setTimer(() => this.holdStep(current), HOLD_DELAY_MS);
  }

  move(e: PointerSample): void {
    const p = this.press;
    if (!p || p.id !== e.id || p.button) return;
    const v = { x: e.x, y: e.y };
    if (p.touch) {
      // A touch swipes the moment it travels far enough, wherever it began on the canvas.
      const swipe = p.touch.move(e.clientX, e.clientY);
      if (swipe) this.swipeStep(swipe, this.host.now());
      // Sliding a held finger retargets the walk; a trembling one keeps its target.
      else if (p.aim && p.touch.retarget(e.clientX, e.clientY)) p.aim = onTouchSurface(v) ? v : p.aim;
    } else if (p.tile) {
      // Dragging a held mouse button retargets the walk.
      p.tile = tileAt(v) ?? p.tile;
    }
  }

  up(e: PointerSample): void {
    const p = this.press;
    if (!p || p.id !== e.id) return;
    this.cancel();
    const game = this.game;
    const now = this.host.now();
    const v = { x: e.x, y: e.y };
    if (p.touch) {
      // The touch already acted: a swipe stepped as it crossed the threshold, a hold while held.
      if (p.touch.reading !== 'pending') return;
    } else {
      const swipe = p.held === 0 ? swipeDirection(e.clientX - p.clientX, e.clientY - p.clientY) : null;
      if (swipe && !p.button) {
        this.swipeStep(swipe, now);
        return;
      }
    }
    const hit = buttonAt(v.x, v.y);
    if (p.button) {
      // A tap still aimed at the sheet as the end card slides in never lands on its buttons.
      const guarded = this.onEndCard() && now - game.state.phaseStart <= END_CARD_TAP_GUARD_MS;
      if (hit === p.button && !guarded) this.host.runButton(hit, now);
      return;
    }
    // A press on the map whose expedition ended under it (a held walk reaching the summit) or was
    // replaced does nothing when it lifts.
    if ((p.tile || p.aim) && (game.state !== p.state || game.state.phase !== 'playing')) return;
    if (ui.archivesOpen) {
      closeArchives();
      return;
    }
    // Likewise a tap beside the Survey Contract card only closes it.
    if (ui.contracts.isOpen) {
      ui.contracts.close();
      return;
    }
    // Taps beside the pause card do nothing (the card's own buttons were handled above).
    if (ui.pause.isOpen) return;
    // A fingertip rolls as it lifts, so a touch taps where it landed; the mouse where it is released.
    const tapAt = p.touch ? p.at : v;
    const phase = game.state.phase;
    if (phase === 'title') {
      game.handleAction('confirm', now);
    } else if (phase === 'gameover' || phase === 'victory') {
      // Tapping the sheet beside the report tucks the card away (or brings it back); only the
      // card's buttons start another expedition, so studying the map never starts one by accident.
      if (now - game.state.phaseStart > END_CARD_TAP_GUARD_MS && tileAt(tapAt)) this.host.toggleReportCard();
    } else if (phase === 'playing' && p.held === 0) {
      if (p.touch) {
        const dir = p.aim ? this.touchDir(p.aim) : null;
        if (!dir) return;
        const tile = tileAt(tapAt);
        if (tile) addTap(tile.x, tile.y, now);
        game.handleAction(dir, now);
        return;
      }
      const tile = tileAt(tapAt);
      if (tile) {
        addTap(tile.x, tile.y, now);
        this.stepToward(tile, now, false);
      }
    }
  }
}
