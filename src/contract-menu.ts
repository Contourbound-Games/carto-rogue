// The Survey Contract card (Steam edition) as a tiny, DOM-free state machine like the pause menu: whether
// it is open, which Contract is highlighted, and which ones are completed (a read-only view that main.ts
// keeps in step with the saved progress). main.ts feeds it input and carries out what it returns;
// hud.ts draws it. A Contract always starts through Game.startContract.
import { SURVEY_CONTRACTS } from './contracts';
import type { ContractId } from './contracts';
import type { Game } from './game';
import type { UiKey } from './input';
import type { Action } from './types';

/** The approved Contracts, in card order (top to bottom). */
export const CONTRACT_ROWS: readonly ContractId[] = SURVEY_CONTRACTS.map((c) => c.id);

/**
 * What a key press asks of the caller: start the highlighted Contract, or nothing more ('handled': the
 * card took the key). 'pass' hands R (after closing the card) and M on to their usual handling.
 */
export type ContractCommand = { start: ContractId } | 'handled' | 'pass';

export class ContractMenu {
  private openSince: number | null = null;
  private index = 0;
  /** Completed Contracts, as shown on the card (never the saved progress itself). */
  completed: readonly ContractId[] = [];

  get isOpen(): boolean {
    return this.openSince !== null;
  }

  /** performance.now() when the card opened (drives its slide-in). */
  get since(): number {
    return this.openSince ?? 0;
  }

  /** The highlighted Contract. */
  get selected(): ContractId {
    return CONTRACT_ROWS[this.index];
  }

  open(now: number): void {
    if (this.isOpen) return;
    this.openSince = now;
    this.index = 0;
  }

  close(): void {
    this.openSince = null;
    this.index = 0;
  }

  /** Move the highlight one row (arrow keys / W S), wrapping round like the pause menu's toggle. */
  step(delta: 1 | -1): void {
    if (this.isOpen) this.index = (this.index + delta + CONTRACT_ROWS.length) % CONTRACT_ROWS.length;
  }

  /** Highlight a specific Contract (mouse hover or a direct tap). */
  focus(id: ContractId): void {
    const k = CONTRACT_ROWS.indexOf(id);
    if (k >= 0) this.index = k;
  }

  isCompleted(id: ContractId): boolean {
    return this.completed.includes(id);
  }

  /**
   * A key while the card is open: up / down move, Enter / Space start the highlighted Contract,
   * Esc or C close, R closes and goes on to start a fresh expedition, M still mutes; nothing else gets
   * through to the title card behind.
   */
  key(uiKey: UiKey | null, action: Action | null): ContractCommand {
    if (!this.isOpen) return 'pass';
    if (uiKey === 'close' || uiKey === 'contracts') {
      this.close();
      return 'handled';
    }
    if (action === 'up' || action === 'down') {
      this.step(action === 'up' ? -1 : 1);
      return 'handled';
    }
    if (action === 'confirm') return { start: this.selected };
    if (action === 'restart') {
      this.close();
      return 'pass';
    }
    return action === 'mute' ? 'pass' : 'handled';
  }

  /**
   * Start Contract `id` (the highlighted one by default) on `game`. The card closes when it starts;
   * when the game refuses (Explorer is selected) it stays open and nothing else changes.
   */
  begin(game: Pick<Game, 'startContract'>, now: number, id: ContractId = this.selected): boolean {
    this.focus(id);
    if (!game.startContract(now, id)) return false;
    this.close();
    return true;
  }
}
