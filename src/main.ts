// Entry point: wires the canvas, renderer, synth audio, map generator, input, interface buttons,
// career records and the frame loop.
import { SynthAudio } from './audio';
import { MAP_H, MAP_ORIGIN_X, MAP_ORIGIN_Y, MAP_W, MOVE_REPEAT_MS, PALETTE, TILE, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from './config';
import { drawText, fitText, loadWebFont } from './font';
import { Game } from './game';
import { initLanguage, t, toggleLang } from './i18n';
import { clientToVirtual, directionToward, keyToAction, keyToUiKey, parseSeed, swipeDirection } from './input';
import { generateMap } from './map';
import { applyExpedition, loadRecords, saveRecords } from './records';
import type { ExpeditionOutcome } from './records';
import { Renderer } from './renderer';
import { SeedEntry } from './seed-entry';
import { copyText, seedText, shareText } from './share';
import type { GameState } from './types';
import { addTap, buttonAt, closeArchives, openArchives, showToast, ui } from './ui';
import type { ButtonId } from './ui';

/** Handles exposed as window.__carto when the page is opened with ?debug (automated testing). */
export interface CartoDebugHandles {
  game: Game;
  renderer: Renderer;
  audio: SynthAudio;
  ui: typeof ui;
}

declare global {
  interface Window {
    __carto?: CartoDebugHandles;
  }
}

const LOG_PREFIX = '[carto-rogue]';
/** Holding a finger / button on the map keeps walking toward it after this delay... */
const HOLD_DELAY_MS = 320;
/** ...one step per this interval (a little slower than a held key, so it stays controllable). */
const HOLD_STEP_MS = Math.round(MOVE_REPEAT_MS * 1.3);
/** End cards ignore a stray tap this soon after they appear. */
const END_CARD_TAP_GUARD_MS = 500;

/** ?seed=<n> selects the first map; anything that is not a 32-bit unsigned integer is ignored. */
function seedFromUrl(params: URLSearchParams): number | undefined {
  const seed = parseSeed(params.get('seed'));
  if (seed === null) {
    console.warn(`${LOG_PREFIX} ignoring invalid seed parameter "${params.get('seed')}"`);
    return undefined;
  }
  return seed;
}

/**
 * Scale the fixed 1280x800 canvas to fit the visible viewport while keeping its aspect ratio.
 *
 * The size is chosen in DEVICE pixels so HiDPI screens stay crisp: from 2 device px per virtual px
 * up the scale snaps down to a whole number (every canvas pixel the same size); between 1 and 2 the
 * fractional fit is kept. Any upscale stays 'pixelated'; only a true downscale filters smoothly,
 * which keeps 1 px contour lines from dropping out entirely.
 *
 * Placement is plain CSS centring (fixed at 50% / 50%, translated back by half its own size), so
 * the canvas is centred in CSS pixels on every device-pixel ratio, including DPR 2.5-3 phones where
 * device-pixel offset arithmetic went wrong. In fullscreen the browser's own :fullscreen rules take
 * over (inset 0, no transform) and letterbox the image with object-fit: contain.
 */
function fitCanvas(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const vv = window.visualViewport;
  const viewW = vv && vv.width > 0 ? vv.width : window.innerWidth;
  const viewH = vv && vv.height > 0 ? vv.height : window.innerHeight;
  const fit = Math.min(viewW / VIRTUAL_WIDTH, viewH / VIRTUAL_HEIGHT);
  let scale = (Number.isFinite(fit) && fit > 0 ? fit : 1) * dpr; // device px per virtual px
  if (scale >= 2) scale = Math.floor(scale + 1e-9);
  // Whole device pixels, rounded down (the epsilon absorbs float error) so it never overhangs.
  const width = Math.max(1, Math.floor(VIRTUAL_WIDTH * scale + 1e-6)) / dpr;
  const height = Math.max(1, Math.floor(VIRTUAL_HEIGHT * scale + 1e-6)) / dpr;
  const style = canvas.style;
  style.position = 'fixed';
  style.left = '50%';
  style.top = '50%';
  style.transform = 'translate(-50%, -50%)';
  style.width = `${width}px`;
  style.height = `${height}px`;
  style.imageRendering = scale >= 1 ? 'pixelated' : 'auto';
}

/**
 * Call `onChange` whenever devicePixelRatio changes (moving the window to another monitor, OS
 * scaling). A resolution query only matches one value, so it is re-registered after each change.
 */
function watchPixelRatio(onChange: () => void): void {
  if (typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener(
    'change',
    () => {
      onChange();
      watchPixelRatio(onChange);
    },
    { once: true },
  );
}

function findCanvas(): HTMLCanvasElement {
  const el = document.getElementById('game');
  if (!(el instanceof HTMLCanvasElement)) throw new Error('canvas#game not found in the page');
  return el;
}

/** Last-resort message drawn on the canvas itself when the game cannot start. */
function drawFatal(error: unknown): void {
  const el = document.getElementById('game');
  if (!(el instanceof HTMLCanvasElement)) return;
  const ctx = el.getContext('2d');
  if (!ctx) return;
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  const cx = Math.round(el.width / 2);
  const cy = Math.round(el.height / 2);
  ctx.fillStyle = PALETTE.desk;
  ctx.fillRect(0, 0, el.width, el.height);
  drawText(ctx, 'THE SURVEY COULD NOT BEGIN', cx, cy - 40, { scale: 3, color: PALETTE.parchment, align: 'center' });
  drawText(ctx, fitText(message, el.width - 64, 2), cx, cy + 4, { scale: 2, color: PALETTE.inkPale, align: 'center' });
  drawText(ctx, 'See the browser console for details.', cx, cy + 32, {
    scale: 2,
    color: PALETTE.inkPale,
    align: 'center',
  });
}

/**
 * Keeps the career archives in step with the game: an expedition is recorded once when it ends
 * (victory or collapse), or as abandoned when it is replaced (R) or the page closes after at
 * least one step.
 */
class RecordKeeper {
  private tracked: GameState;
  private recorded = false;

  constructor(state: GameState) {
    this.tracked = state;
  }

  sync(state: GameState): void {
    if (state !== this.tracked) {
      this.abandon();
      this.tracked = state;
      this.recorded = false;
    }
    const final = state.finalStats;
    if (!this.recorded && final) this.record(state, final.outcome, final.grade);
  }

  /**
   * The tracked expedition is being left behind: record its result if it ended (R can land before
   * the next frame saw the ending), else record it as abandoned once it took a step.
   */
  abandon(): void {
    if (this.recorded) return;
    const final = this.tracked.finalStats;
    if (final) this.record(this.tracked, final.outcome, final.grade);
    else if (this.tracked.turns > 0) this.record(this.tracked, 'abandoned', null);
  }

  private record(state: GameState, outcome: ExpeditionOutcome, grade: string | null): void {
    this.recorded = true;
    ui.records = applyExpedition(ui.records, {
      outcome,
      percentMapped: (state.revealedCount / (MAP_W * MAP_H)) * 100,
      tilesMapped: state.revealedCount,
      turns: state.turns,
      grade,
    });
    saveRecords(ui.records);
  }
}

function start(): void {
  const canvas = findCanvas();
  canvas.width = VIRTUAL_WIDTH;
  canvas.height = VIRTUAL_HEIGHT;
  let seedEntry: SeedEntry | null = null;
  // While the seed dialog is open the mobile keyboard resizes the viewport; the canvas is left
  // exactly where it is (no jump) and refitted once the dialog closes.
  const refit = (): void => {
    if (!seedEntry?.isOpen) fitCanvas(canvas);
  };
  refit();
  window.addEventListener('resize', refit);
  // Mobile browsers resize the visual viewport (URL bar, rotation) without always firing window resize.
  window.visualViewport?.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  watchPixelRatio(refit);

  initLanguage();
  ui.records = loadRecords();
  void loadWebFont();

  const params = new URLSearchParams(window.location.search);
  const urlSeed = seedFromUrl(params);
  const audio = new SynthAudio();
  const renderer = new Renderer(canvas);
  // A shared ?seed= link drops the player straight onto that sheet.
  const game = new Game(audio, generateMap, { seed: urlSeed, now: performance.now(), startPlaying: urlSeed !== undefined });
  const records = new RecordKeeper(game.state);
  window.addEventListener('pagehide', () => records.abandon());

  if (params.has('debug')) {
    window.__carto = { game, renderer, audio, ui };
    console.info(`${LOG_PREFIX} debug handles exposed on window.__carto (seed ${game.state.seed})`);
  }

  // ----- Seed entry dialog -----
  const afterSeedDialog = (): void => {
    refit();
    canvas.focus({ preventScroll: true });
  };
  seedEntry = new SeedEntry({
    onSubmit: (seed) => {
      audio.unlock();
      game.startSeed(performance.now(), seed);
      afterSeedDialog();
    },
    onCancel: afterSeedDialog,
  });
  const dialog = seedEntry;

  // ----- Fullscreen -----
  ui.fullscreenAvailable = document.fullscreenEnabled === true && typeof canvas.requestFullscreen === 'function';
  const toggleFullscreen = (): void => {
    if (!ui.fullscreenAvailable) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void canvas.requestFullscreen().catch(() => undefined);
  };
  document.addEventListener('fullscreenchange', () => {
    ui.fullscreen = document.fullscreenElement !== null;
    refit();
    canvas.focus({ preventScroll: true });
  });

  // ----- Clipboard -----
  const copyAndToast = (text: string, okKey: 'toastLink' | 'toastResult'): void => {
    void copyText(text).then((ok) => showToast(ok ? t(okKey) : t('toastFailed'), ok ? 'good' : 'bad', performance.now()));
  };

  const runButton = (id: ButtonId, now: number): void => {
    switch (id) {
      case 'lang':
        toggleLang();
        return;
      case 'mute':
        game.handleAction('mute', now);
        return;
      case 'fullscreen':
        toggleFullscreen();
        return;
      case 'copySeed':
        copyAndToast(seedText(game.state.seed), 'toastLink');
        return;
      case 'share': {
        const stats = game.state.finalStats;
        if (stats) copyAndToast(shareText(game.state.seed, stats), 'toastResult');
        return;
      }
      case 'archives':
        openArchives(now);
        return;
      case 'closeArchives':
        closeArchives();
        return;
      case 'seedEntry':
        ui.hover = null;
        if (game.state.phase === 'title') dialog.open();
        return;
    }
  };

  const onCardScreen = (): boolean => {
    const phase = game.state.phase;
    return phase === 'title' || phase === 'gameover' || phase === 'victory';
  };

  // ----- Keyboard -----
  window.addEventListener('keydown', (e) => {
    // The seed dialog owns the keyboard: every key types into its input, none reaches the game.
    if (dialog.isOpen) return;
    audio.unlock();
    // Leave browser / OS shortcuts (Ctrl+R reload, Cmd+W, Alt+Tab...) alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const now = performance.now();
    const uiKey = keyToUiKey(e.code, e.key);
    const action = keyToAction(e.code, e.key);
    if (ui.archivesOpen) {
      // The ledger is modal: L / Esc / Enter / Space close it; R and M still work; moves are swallowed.
      if (uiKey === 'archives' || uiKey === 'close' || action === 'confirm') {
        e.preventDefault();
        if (!e.repeat) closeArchives();
        return;
      }
      if (action === 'restart') closeArchives();
      else if (action !== 'mute' && action !== null) {
        e.preventDefault();
        return;
      }
    }
    if (uiKey === 'fullscreen') {
      e.preventDefault();
      if (!e.repeat) toggleFullscreen();
      return;
    }
    if (uiKey === 'archives') {
      e.preventDefault();
      if (!e.repeat && onCardScreen()) openArchives(now);
      return;
    }
    if (action === null) return;
    e.preventDefault();
    game.handleAction(action, now, e.repeat);
  });

  // ----- Pointer: buttons, tap-to-step, press-and-hold walking, swipes -----
  interface Press {
    id: number;
    clientX: number;
    clientY: number;
    button: ButtonId | null;
    /** Target tile while the press is on the map during play. */
    tile: { x: number; y: number } | null;
    /** Steps already taken by holding (the release then takes no extra tap step). */
    held: number;
    timer: number;
  }
  let press: Press | null = null;

  const toVirtual = (e: PointerEvent): { x: number; y: number } =>
    clientToVirtual(e.clientX, e.clientY, canvas.getBoundingClientRect(), VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
  const tileAt = (v: { x: number; y: number }): { x: number; y: number } | null => {
    const tx = Math.floor((v.x - MAP_ORIGIN_X) / TILE);
    const ty = Math.floor((v.y - MAP_ORIGIN_Y) / TILE);
    return tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H ? { x: tx, y: ty } : null;
  };
  const stepToward = (tile: { x: number; y: number }, now: number, repeat: boolean): void => {
    const dir = directionToward(tile.x - game.state.player.x, tile.y - game.state.player.y);
    if (dir) game.handleAction(dir, now, repeat);
  };
  const endPress = (): void => {
    if (press) window.clearInterval(press.timer);
    press = null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    audio.unlock();
    canvas.focus({ preventScroll: true });
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    endPress();
    const v = toVirtual(e);
    const button = buttonAt(v.x, v.y);
    const tile = !button && !ui.archivesOpen && game.state.phase === 'playing' ? tileAt(v) : null;
    const current: Press = { id: e.pointerId, clientX: e.clientX, clientY: e.clientY, button, tile, held: 0, timer: 0 };
    press = current;
    if (tile) {
      const started = performance.now();
      current.timer = window.setInterval(() => {
        const now = performance.now();
        if (press !== current || now - started < HOLD_DELAY_MS || game.state.phase !== 'playing') return;
        current.held++;
        addTap(current.tile?.x ?? tile.x, current.tile?.y ?? tile.y, now);
        // Held steps behave like a held key: they stop at fatal steps and fresh discoveries.
        stepToward(current.tile ?? tile, now, current.held > 1);
      }, HOLD_STEP_MS);
    }
    canvas.setPointerCapture?.(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const v = toVirtual(e);
    if (e.pointerType === 'mouse') {
      ui.hover = buttonAt(v.x, v.y);
      canvas.style.cursor = ui.hover ? 'pointer' : game.state.phase === 'playing' && tileAt(v) ? 'crosshair' : 'default';
    }
    // Sliding a held finger retargets the walk.
    if (press && press.id === e.pointerId && press.tile) press.tile = tileAt(v) ?? press.tile;
  });

  canvas.addEventListener('pointerleave', () => {
    ui.hover = null;
  });

  canvas.addEventListener('pointerup', (e) => {
    audio.unlock();
    const p = press;
    if (!p || p.id !== e.pointerId) return;
    endPress();
    const now = performance.now();
    const v = toVirtual(e);
    const swipe = p.held === 0 ? swipeDirection(e.clientX - p.clientX, e.clientY - p.clientY) : null;
    if (swipe && !p.button) {
      if (ui.archivesOpen) return;
      const phase = game.state.phase;
      if (phase === 'playing' || phase === 'title') game.handleAction(swipe, now);
      return;
    }
    const hit = buttonAt(v.x, v.y);
    if (p.button) {
      if (hit === p.button) runButton(hit, now);
      return;
    }
    if (ui.archivesOpen) {
      closeArchives();
      return;
    }
    const phase = game.state.phase;
    if (phase === 'title') {
      game.handleAction('confirm', now);
    } else if (phase === 'gameover' || phase === 'victory') {
      if (now - game.state.phaseStart > END_CARD_TAP_GUARD_MS) game.handleAction('confirm', now);
    } else if (phase === 'playing' && p.held === 0) {
      const tile = tileAt(v);
      if (tile) {
        addTap(tile.x, tile.y, now);
        stepToward(tile, now, false);
      }
    }
  });

  canvas.addEventListener('pointercancel', endPress);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Browsers only count pointerup / touchend of a touch as the gesture that may start audio (a
  // touch pointerdown is not one), so unlock on those as well.
  canvas.addEventListener('touchend', () => audio.unlock(), { passive: true });
  // Keep touch gestures on the canvas from scrolling or zooming the host page (itch.io iframe).
  canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  canvas.focus({ preventScroll: true });

  // Frame loop. A failing frame is reported once and the loop keeps running so that a
  // transient drawing problem never freezes input handling.
  let frameErrorReported = false;
  const frame = (now: number): void => {
    try {
      game.update(now);
      records.sync(game.state);
      renderer.render(game.state, now);
    } catch (err) {
      if (!frameErrorReported) {
        frameErrorReported = true;
        console.error(`${LOG_PREFIX} frame update failed:`, err);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

try {
  start();
} catch (err) {
  console.error(`${LOG_PREFIX} startup failed:`, err);
  drawFatal(err);
}
