// The in-expedition pause menu as a tiny, DOM-free state machine: which card is up (the two-item
// menu or the abandon confirmation) and which button is selected. main.ts feeds it input and
// carries out the commands it returns; hud.ts draws it. The game itself is frozen through
// Game.pause() / Game.resume() while it is open.

export type PauseView = 'menu' | 'confirm';

/** What the caller must do after an input: resume play, or leave for the title card. */
export type PauseCommand = 'resume' | 'exit' | null;

/** Menu items, top to bottom. */
export const MENU_ITEMS = ['resume', 'title'] as const;
/** Confirmation buttons, left to right. */
export const CONFIRM_ITEMS = ['abandon', 'cancel'] as const;

export type PauseItem = (typeof MENU_ITEMS)[number] | (typeof CONFIRM_ITEMS)[number];

export class PauseMenu {
  private openSince: number | null = null;
  private currentView: PauseView = 'menu';
  private index = 0;

  get isOpen(): boolean {
    return this.openSince !== null;
  }

  /** performance.now() when the menu opened (drives the card's fade-in). */
  get since(): number {
    return this.openSince ?? 0;
  }

  get view(): PauseView {
    return this.currentView;
  }

  /** The highlighted item of the current card. */
  get selected(): PauseItem {
    return this.currentView === 'menu' ? MENU_ITEMS[this.index] : CONFIRM_ITEMS[this.index];
  }

  open(now: number): void {
    if (this.isOpen) return;
    this.openSince = now;
    this.currentView = 'menu';
    this.index = 0;
  }

  close(): void {
    this.openSince = null;
    this.currentView = 'menu';
    this.index = 0;
  }

  /** Move the highlight (arrow keys / WASD); both cards have two items, so any step toggles. */
  step(): void {
    if (this.isOpen) this.index = 1 - this.index;
  }

  /** Highlight a specific item (mouse hover or a direct click). */
  focus(item: PauseItem): void {
    const list: readonly PauseItem[] = this.currentView === 'menu' ? MENU_ITEMS : CONFIRM_ITEMS;
    const k = list.indexOf(item);
    if (k >= 0) this.index = k;
  }

  /**
   * Activate the highlighted item (Enter / Space / click). RETURN TO TITLE leaves at once when no
   * step was taken (`turns` is 0), and asks for confirmation otherwise; the confirmation defaults
   * to CANCEL so a double press cannot abandon by accident.
   */
  activate(turns: number): PauseCommand {
    if (!this.isOpen) return null;
    switch (this.selected) {
      case 'resume':
        return 'resume';
      case 'title':
        if (turns <= 0) return 'exit';
        this.currentView = 'confirm';
        this.index = CONFIRM_ITEMS.indexOf('cancel');
        return null;
      case 'abandon':
        return 'exit';
      case 'cancel':
        this.back();
        return null;
    }
  }

  /** Escape: the confirmation falls back to the menu (with RETURN TO TITLE highlighted); the menu resumes. */
  back(): PauseCommand {
    if (!this.isOpen) return null;
    if (this.currentView === 'confirm') {
      this.currentView = 'menu';
      this.index = MENU_ITEMS.indexOf('title');
      return null;
    }
    return 'resume';
  }
}
