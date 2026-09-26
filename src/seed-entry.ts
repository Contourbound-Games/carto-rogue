// "ENTER SEED" modal: a temporary HTML overlay above the canvas (the one place the game uses DOM
// elements, because only a real <input> brings up the mobile numeric keypad). A full-screen
// backdrop swallows every click and touch while it is open; keystrokes stay inside the input.
import { t } from './i18n';
import { parseSeed } from './input';

/** Longest valid seed: 4294967295. */
const SEED_MAX_DIGITS = 10;

/**
 * Validate typed seed text: decimal digits only (surrounding spaces trimmed), 0..4294967295.
 * The range check is parseSeed()'s, the one ?seed= links use, so a typed seed and a link with the
 * same number open the same sheet. Returns null for anything else (signs, decimals, letters, hex).
 */
export function parseSeedInput(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text) || text.length > SEED_MAX_DIGITS) return null;
  return parseSeed(text) ?? null;
}

export interface SeedEntryHandlers {
  /** A valid seed was confirmed; the modal has already closed. */
  onSubmit(seed: number): void;
  /** Dismissed without a seed (Escape, Cancel, backdrop); the modal has already closed. */
  onCancel(): void;
}

const INK = '#3a2e2b';
const PAPER = '#f4ecd8';
const PAPER_DARK = '#e8dcbf';
const RED_INK = '#9b2d20';
const FONT = 'Galmuri9, monospace';

function css(el: HTMLElement, rules: Record<string, string>): void {
  for (const [k, v] of Object.entries(rules)) el.style.setProperty(k, v);
}

function button(doc: Document, label: string, primary: boolean): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = label;
  css(b, {
    font: `20px ${FONT}`,
    color: primary ? PAPER : INK,
    background: primary ? INK : PAPER_DARK,
    border: `2px solid ${INK}`,
    'box-shadow': '2px 2px 0 #d9c9a3',
    padding: '6px 16px',
    cursor: 'pointer',
    'min-width': '110px',
    outline: 'none',
  });
  return b;
}

export class SeedEntry {
  private backdrop: HTMLDivElement | null = null;
  private input: HTMLInputElement | null = null;
  private error: HTMLDivElement | null = null;

  constructor(
    private readonly handlers: SeedEntryHandlers,
    private readonly doc: Document = document,
  ) {}

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  /** The <input>, while open (for tests and focus handling). */
  get field(): HTMLInputElement | null {
    return this.input;
  }

  open(): void {
    if (this.backdrop) return;
    const doc = this.doc;
    const backdrop = doc.createElement('div');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', t('seedTitle'));
    css(backdrop, {
      position: 'fixed',
      inset: '0',
      'z-index': '10',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      background: 'rgba(12, 8, 6, 0.72)',
      'pointer-events': 'auto',
      'touch-action': 'none',
    });

    const panel = doc.createElement('div');
    css(panel, {
      background: PAPER,
      color: INK,
      border: `3px double ${INK}`,
      'box-shadow': '6px 6px 0 rgba(0, 0, 0, 0.45)',
      padding: '22px 26px 20px',
      'text-align': 'center',
      font: `20px ${FONT}`,
      'max-width': 'calc(100vw - 48px)',
      'box-sizing': 'border-box',
      'user-select': 'none',
    });

    const title = doc.createElement('div');
    title.textContent = t('seedTitle');
    css(title, { font: `30px ${FONT}`, 'letter-spacing': '2px', 'margin-bottom': '4px' });
    const hint = doc.createElement('div');
    hint.textContent = t('seedHint');
    css(hint, { font: `10px ${FONT}`, color: '#8a7662', 'margin-bottom': '14px' });

    const input = doc.createElement('input');
    input.type = 'text';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('pattern', '[0-9]*');
    input.maxLength = SEED_MAX_DIGITS;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.setAttribute('aria-label', t('seedTitle'));
    css(input, {
      font: `30px ${FONT}`,
      color: INK,
      background: '#fbf6e9',
      border: `2px solid ${INK}`,
      'border-radius': '0',
      'box-shadow': 'inset 2px 2px 0 #d9c9a3',
      padding: '6px 10px',
      width: '12ch',
      'max-width': '100%',
      'text-align': 'center',
      outline: 'none',
      'caret-color': RED_INK,
      'box-sizing': 'border-box',
      'user-select': 'text',
    });

    const error = doc.createElement('div');
    error.setAttribute('role', 'alert');
    css(error, {
      font: `10px ${FONT}`,
      color: RED_INK,
      'min-height': '14px',
      margin: '10px 0 12px',
    });

    const row = doc.createElement('div');
    css(row, { display: 'flex', gap: '12px', 'justify-content': 'center', 'flex-wrap': 'wrap' });
    const cancel = button(doc, t('seedCancel'), false);
    const confirm = button(doc, t('seedConfirm'), true);
    row.append(cancel, confirm);

    panel.append(title, hint, input, error, row);
    backdrop.append(panel);

    // Keys stay inside the dialog: nothing reaches the game's window listener.
    backdrop.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      }
    });
    backdrop.addEventListener('keyup', (e) => e.stopPropagation());
    // Tapping the dark backdrop (not the panel) cancels; nothing passes through to the canvas.
    // A click only counts when its press began inside this dialog: on touch screens the tap that
    // opened the dialog delivers a trailing synthetic click at the same spot, which may now sit on
    // the backdrop or even on a dialog button. Keyboard activation (detail 0) always counts.
    let pressedOn: EventTarget | null = null;
    backdrop.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      pressedOn = e.target;
      if (e.target === backdrop) e.preventDefault();
    });
    const genuine = (e: MouseEvent, target: EventTarget): boolean => e.detail === 0 || pressedOn === target;
    backdrop.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === backdrop && genuine(e, backdrop)) this.cancel();
    });
    input.addEventListener('input', () => this.showError(''));
    cancel.addEventListener('click', (e) => {
      if (genuine(e, cancel)) this.cancel();
    });
    confirm.addEventListener('click', (e) => {
      if (genuine(e, confirm)) this.submit();
    });

    doc.body.append(backdrop);
    this.backdrop = backdrop;
    this.input = input;
    this.error = error;
    input.focus({ preventScroll: true });
  }

  /** Validate and submit the typed seed; an invalid entry shows the error and keeps the field focused. */
  submit(): void {
    const input = this.input;
    if (!input) return;
    const seed = parseSeedInput(input.value);
    if (seed === null) {
      this.showError(t('seedInvalid'));
      input.focus({ preventScroll: true });
      input.select();
      return;
    }
    this.close();
    this.handlers.onSubmit(seed);
  }

  cancel(): void {
    if (!this.isOpen) return;
    this.close();
    this.handlers.onCancel();
  }

  private showError(text: string): void {
    if (this.error) this.error.textContent = text;
  }

  private close(): void {
    this.input?.blur();
    this.backdrop?.remove();
    this.backdrop = null;
    this.input = null;
    this.error = null;
  }
}
