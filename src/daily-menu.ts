// The Today's Expedition card (Steam edition) as a tiny, DOM-free state machine like the Contract card:
// whether it is open and which UTC date it shows. It also holds what the drawing needs and never reads
// itself: the completed bests (a read-only copy main.ts keeps in step with the saved records), the
// finished expedition that set a new best, and the latest UTC date read for an end report's new-day
// notice. main.ts feeds it input and the time; hud.ts draws it. An attempt always starts through
// Game.startDaily, with the date of the moment BEGIN was chosen.
import { dailyIdentity, utcDateKey } from './daily';
import type { DailyBest } from './daily-records';
import type { Game } from './game';
import type { UiKey } from './input';
import type { Action, GameState } from './types';

/** What a key press asks of the caller: begin the attempt, or nothing more ('handled': the card took the key). */
export type DailyCommand = 'begin' | 'handled' | 'pass';

/** How BEGIN went: whether the attempt started, its UTC date, and whether that differs from the date the card showed. */
export interface DailyBegin {
  started: boolean;
  date: string;
  dateChanged: boolean;
}

export class DailyMenu {
  private openSince: number | null = null;
  /** The UTC date on the card, read when it opened (and refreshed by a refused BEGIN). */
  date: string | null = null;
  /** Completed bests, as shown (never the saved records themselves). */
  days: readonly DailyBest[] = [];
  /** The finished expedition whose completed attempt became its date's new best. */
  newBestOf: GameState | null = null;
  /** The UTC date main.ts last read while a Daily end report was up (its new-day notice only); null before. */
  today: string | null = null;

  get isOpen(): boolean {
    return this.openSince !== null;
  }

  /** performance.now() when the card opened (drives its slide-in). */
  get since(): number {
    return this.openSince ?? 0;
  }

  /** Open the card on the UTC date of `epochMs`. */
  open(now: number, epochMs: number): void {
    if (this.isOpen) return;
    this.openSince = now;
    this.date = utcDateKey(epochMs);
  }

  close(): void {
    this.openSince = null;
  }

  /**
   * A key while the card is open: Enter / Space begin, Esc or T close, R closes and goes on to start a
   * fresh expedition, M still mutes; nothing else gets through to the title card behind.
   */
  key(uiKey: UiKey | null, action: Action | null): DailyCommand {
    if (!this.isOpen) return 'pass';
    if (uiKey === 'close' || uiKey === 'daily') {
      this.close();
      return 'handled';
    }
    if (action === 'confirm') return 'begin';
    if (action === 'restart') {
      this.close();
      return 'pass';
    }
    return action === 'mute' ? 'pass' : 'handled';
  }

  /**
   * BEGIN: start the attempt for the UTC date of `epochMs` (the moment BEGIN was chosen, which may be
   * past the midnight after the card opened). The card closes when it starts; when the game refuses
   * (Explorer is selected) it stays open, now showing that date.
   */
  begin(game: Pick<Game, 'startDaily'>, now: number, epochMs: number): DailyBegin {
    const date = utcDateKey(epochMs);
    const dateChanged = this.date !== null && this.date !== date;
    const started = game.startDaily(now, dailyIdentity(date));
    if (started) this.close();
    else this.date = date;
    return { started, date, dateChanged };
  }
}
