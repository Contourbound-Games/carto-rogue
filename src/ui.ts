// Interface state that lives outside the game rules: clickable canvas buttons, the archives
// ledger, toasts, tap ripples and window modes. main.ts writes it from input events; hud.ts and
// renderer.ts read it while drawing (and hud.ts registers the button rectangles each frame).
import { judgeContract } from './contract-conditions';
import { ContractMenu } from './contract-menu';
import type { ContractId } from './contracts';
import { PauseMenu } from './pause';
import { emptyRecords } from './records';
import type { CareerRecords } from './records';
import type { GameState } from './types';

export type ButtonId =
  | 'lang'
  | 'mute'
  | 'fullscreen'
  | 'copySeed'
  | 'share'
  | 'archives'
  | 'closeArchives'
  | 'seedEntry'
  | 'mode'
  | 'pause'
  | 'pauseResume'
  | 'pauseToTitle'
  | 'pauseAbandon'
  | 'pauseCancel'
  | 'retrySheet'
  | 'newExpedition'
  | 'toggleCard'
  | 'reportCard'
  | 'contracts'
  | 'closeContracts'
  | `contract:${ContractId}`;

/** The two ways on from an end card: this sheet again, or a fresh one. */
export type EndChoice = 'retry' | 'new';

/** Expedition report (end-card) interface state, kept for one finished expedition. */
export interface ReportUi {
  /** The expedition this state belongs to; a new one resets it. */
  of: GameState | null;
  /** Keyboard selection between the two end-card actions. */
  choice: EndChoice;
  /** Card tucked away so the whole sheet can be studied. */
  cardHidden: boolean;
}

export interface UiButton {
  id: ButtonId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ToastTone = 'good' | 'bad';

export interface UiState {
  archivesOpen: boolean;
  /** performance.now() when the archives ledger was opened (drives its slide-in). */
  archivesSince: number;
  toast: { text: string; tone: ToastTone; start: number } | null;
  /** Recent map taps, in tile coordinates, for the ink-ripple feedback. */
  taps: { x: number; y: number; start: number }[];
  /** Buttons drawn in the current frame, in virtual canvas pixels (last one drawn wins a hit test). */
  buttons: UiButton[];
  hover: ButtonId | null;
  fullscreen: boolean;
  fullscreenAvailable: boolean;
  records: CareerRecords;
  /** The in-expedition pause menu (open while the game is paused). */
  pause: PauseMenu;
  /** The Survey Contract card on the title (Steam edition only; never opened in the itch edition). */
  contracts: ContractMenu;
  report: ReportUi;
}

export const TOAST_MS = 1800;
export const TAP_RIPPLE_MS = 450;

export const ui: UiState = {
  archivesOpen: false,
  archivesSince: 0,
  toast: null,
  taps: [],
  buttons: [],
  hover: null,
  fullscreen: false,
  fullscreenAvailable: false,
  records: emptyRecords(),
  pause: new PauseMenu(),
  contracts: new ContractMenu(),
  report: { of: null, choice: 'new', cardHidden: false },
};

/**
 * The report state for this finished expedition, fresh for each one: after a collapse the
 * selection starts on retrying the sheet (the learning loop), after a summit on a new expedition,
 * unless the summit left its Survey Contract not completed (judged from the expedition itself).
 */
export function reportFor(state: GameState): ReportUi {
  const r = ui.report;
  if (r.of !== state) {
    r.of = state;
    r.choice = state.phase === 'gameover' || judgeContract(state)?.status === 'broken' ? 'retry' : 'new';
    r.cardHidden = false;
  }
  return r;
}

export function clearButtons(): void {
  ui.buttons.length = 0;
}

export function addButton(id: ButtonId, x: number, y: number, w: number, h: number): void {
  ui.buttons.push({ id, x, y, w, h });
}

/** Topmost button under the virtual-pixel point, or null. */
export function buttonAt(x: number, y: number): ButtonId | null {
  for (let k = ui.buttons.length - 1; k >= 0; k--) {
    const b = ui.buttons[k];
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b.id;
  }
  return null;
}

export function showToast(text: string, tone: ToastTone, now: number): void {
  ui.toast = { text, tone, start: now };
}

export function addTap(x: number, y: number, now: number): void {
  ui.taps = ui.taps.filter((tp) => now - tp.start < TAP_RIPPLE_MS);
  ui.taps.push({ x, y, start: now });
}

export function openArchives(now: number): void {
  ui.archivesOpen = true;
  ui.archivesSince = now;
}

export function closeArchives(): void {
  ui.archivesOpen = false;
}
