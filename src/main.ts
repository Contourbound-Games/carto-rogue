// Entry point: wires the canvas, renderer, synth audio, map generator, input, interface buttons,
// career records and the frame loop.
import { SynthAudio } from './audio';
import { PALETTE, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from './config';
import { drawText, fitText, loadWebFont } from './font';
import { Game } from './game';
import { initLanguage, t, toggleLang } from './i18n';
import { clientToVirtual, keyToAction, keyToUiKey, parseSeed } from './input';
import { generateMap } from './map';
import { loadMode, saveMode } from './mode';
import { PointerInput, tileAt } from './pointer';
import type { PointerSample } from './pointer';
import { applyExpedition, countsTowardRecords, loadRecords, RecordKeeper, saveRecords } from './records';
import { Renderer } from './renderer';
import type { PauseCommand, PauseItem } from './pause';
import { SeedEntry } from './seed-entry';
import { copyText, seedText, shareText } from './share';
import { buttonAt, closeArchives, openArchives, reportFor, showToast, ui } from './ui';
import type { ButtonId, EndChoice } from './ui';

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

type PauseButtonId = 'pauseResume' | 'pauseToTitle' | 'pauseAbandon' | 'pauseCancel';
/** Pause-card buttons and the menu item each one stands for. */
const PAUSE_BUTTON_ITEMS: Readonly<Record<PauseButtonId, PauseItem>> = {
  pauseResume: 'resume',
  pauseToTitle: 'title',
  pauseAbandon: 'abandon',
  pauseCancel: 'cancel',
};
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
  const game = new Game(audio, generateMap, {
    seed: urlSeed,
    now: performance.now(),
    startPlaying: urlSeed !== undefined,
    mode: loadMode(),
  });
  const records = new RecordKeeper(game.state, (result) => {
    // Explorer expeditions are kept out of the Standard archives.
    if (!countsTowardRecords(result)) return;
    ui.records = applyExpedition(ui.records, result);
    saveRecords(ui.records);
  });
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
        if (stats) copyAndToast(shareText(game.state.seed, stats, undefined, game.state.mode), 'toastResult');
        return;
      }
      case 'mode': {
        const next = game.state.mode === 'standard' ? 'explorer' : 'standard';
        if (game.setMode(next)) saveMode(next);
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
      case 'pause':
        openPause(now);
        return;
      case 'pauseResume':
      case 'pauseToTitle':
      case 'pauseAbandon':
      case 'pauseCancel':
        ui.pause.focus(PAUSE_BUTTON_ITEMS[id]);
        runPause(ui.pause.activate(game.state.turns), now);
        return;
      case 'retrySheet':
        runEndChoice('retry', now);
        return;
      case 'newExpedition':
        runEndChoice('new', now);
        return;
      case 'toggleCard':
        toggleReportCard();
        return;
      case 'reportCard':
        // The card itself: a tap on its paper does nothing (only its buttons act).
        return;
    }
  };

  // ----- Expedition report (end cards) -----
  const runEndChoice = (choice: EndChoice, now: number): void => {
    if (!onEndCard()) return;
    if (choice === 'retry') game.retrySheet(now);
    else game.handleAction('restart', now);
    canvas.focus({ preventScroll: true });
  };
  const toggleReportCard = (): void => {
    if (!onEndCard()) return;
    const report = reportFor(game.state);
    report.cardHidden = !report.cardHidden;
  };

  const pointer = new PointerInput({
    game,
    runButton,
    toggleReportCard,
    now: () => performance.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
  });

  // ----- Pause menu -----
  // The menu is UI state; the game only learns that it is frozen (Game.pause / resume).
  const openPause = (now: number): void => {
    if (ui.pause.isOpen || !game.pause(now)) return;
    // Drop every in-flight input the instant the menu opens, so nothing steps on resume.
    pointer.cancel();
    ui.hover = null;
    ui.pause.open(now);
  };
  const runPause = (command: PauseCommand, now: number): void => {
    if (command === 'resume') {
      ui.pause.close();
      game.resume(now);
    } else if (command === 'exit') {
      ui.pause.close();
      game.returnToTitle(now);
      // Resolve the left-behind expedition now, not on the next frame (page teardown safety).
      records.sync(game.state);
    }
    canvas.focus({ preventScroll: true });
  };

  const onCardScreen = (): boolean => {
    const phase = game.state.phase;
    return phase === 'title' || phase === 'gameover' || phase === 'victory';
  };
  const onEndCard = (): boolean => game.state.phase === 'gameover' || game.state.phase === 'victory';

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
    if (ui.pause.isOpen) {
      // The pause menu is modal: arrows / WASD select, Enter / Space choose, Esc / P back out;
      // M still mutes and R still restarts at once. Nothing else reaches the game.
      e.preventDefault();
      if (action === 'mute') game.handleAction('mute', now, e.repeat);
      else if (action === 'restart') {
        if (!e.repeat) {
          ui.pause.close();
          game.handleAction('restart', now);
        }
      } else if (!e.repeat) {
        if (uiKey === 'close' || uiKey === 'pause') runPause(ui.pause.back(), now);
        else if (action === 'confirm') runPause(ui.pause.activate(game.state.turns), now);
        else if (action !== null) ui.pause.step();
      }
      return;
    }
    if ((uiKey === 'close' || uiKey === 'pause') && game.state.phase === 'playing') {
      e.preventDefault();
      if (!e.repeat) openPause(now);
      return;
    }
    if (uiKey === 'archives') {
      e.preventDefault();
      if (!e.repeat && onCardScreen()) openArchives(now);
      return;
    }
    if (onEndCard()) {
      // The report: H tucks the card away, arrows pick retry / new, Enter / Space run the pick.
      // R stays "new expedition" (handled by the game below), M still mutes.
      const report = reportFor(game.state);
      if (uiKey === 'card') {
        e.preventDefault();
        if (!e.repeat) toggleReportCard();
        return;
      }
      if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
        e.preventDefault();
        if (!e.repeat) {
          report.choice = report.choice === 'retry' ? 'new' : 'retry';
          report.cardHidden = false;
        }
        return;
      }
      if (action === 'confirm') {
        e.preventDefault();
        if (!e.repeat) runEndChoice(report.choice, now);
        return;
      }
    }
    if (action === null) return;
    e.preventDefault();
    game.handleAction(action, now, e.repeat);
  });

  // ----- Pointer: buttons, tap-to-step, press-and-hold walking, swipes (see pointer.ts) -----
  const sample = (e: PointerEvent): PointerSample => {
    const v = clientToVirtual(e.clientX, e.clientY, canvas.getBoundingClientRect(), VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    return { id: e.pointerId, mouse: e.pointerType === 'mouse', clientX: e.clientX, clientY: e.clientY, x: v.x, y: v.y };
  };

  canvas.addEventListener('pointerdown', (e) => {
    audio.unlock();
    canvas.focus({ preventScroll: true });
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    pointer.down(sample(e));
    canvas.setPointerCapture?.(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const s = sample(e);
    if (s.mouse) {
      ui.hover = buttonAt(s.x, s.y);
      // Hovering a pause-card button highlights it, as the arrow keys would.
      if (ui.hover && ui.hover in PAUSE_BUTTON_ITEMS) ui.pause.focus(PAUSE_BUTTON_ITEMS[ui.hover as PauseButtonId]);
      canvas.style.cursor = ui.hover ? 'pointer' : game.state.phase === 'playing' && tileAt(s) ? 'crosshair' : 'default';
    }
    pointer.move(s);
  });

  canvas.addEventListener('pointerleave', () => {
    ui.hover = null;
  });

  canvas.addEventListener('pointerup', (e) => {
    audio.unlock();
    pointer.up(sample(e));
  });

  canvas.addEventListener('pointercancel', (e) => pointer.cancel(e.pointerId));
  canvas.addEventListener('lostpointercapture', (e) => pointer.cancel(e.pointerId));
  // Interruptions that can swallow the release (switching apps, focus loss, rotation or another
  // resize) end the press without acting, so a held walk never runs on unattended.
  const endPress = (): void => pointer.cancel();
  window.addEventListener('blur', endPress);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endPress();
  });
  window.addEventListener('resize', endPress);
  window.visualViewport?.addEventListener('resize', endPress);
  window.addEventListener('orientationchange', endPress);
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
