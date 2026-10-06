// Career records ("Expedition Archives"), kept in localStorage across sessions.
// The pure update function is separate from storage so it can be unit tested.

import { MAP_H, MAP_W } from './config';
import type { ContractId } from './contracts';
import type { ExpeditionMode, GameState } from './types';

export const RECORDS_STORAGE_KEY = 'carto_rogue_records_v1';

/** Grades from worst to best (victories are S/A/B/C, a collapse is always F). */
const GRADE_ORDER: readonly string[] = ['F', 'C', 'B', 'A', 'S'];

export interface CareerRecords {
  version: 1;
  /** Expeditions that ended in victory or collapse, plus abandoned ones that took at least one step. */
  expeditions: number;
  summits: number;
  /** Best share of a sheet surveyed in one expedition, 0..100. */
  bestSurveyed: number;
  /** Best grade earned, or null before the first finished expedition. */
  bestGrade: string | null;
  /** Surveyed tiles summed over every recorded expedition. */
  tilesMapped: number;
  /** Fewest turns taken to reach a summit, or null before the first summit. */
  fewestTurns: number | null;
}

export type ExpeditionOutcome = 'victory' | 'defeat' | 'abandoned';

export interface ExpeditionResult {
  outcome: ExpeditionOutcome;
  percentMapped: number;
  tilesMapped: number;
  turns: number;
  /** Null for abandoned expeditions (they are never graded). */
  grade: string | null;
  mode: ExpeditionMode;
  /** The Survey Contract the expedition was started as, else null (never stored in the archives). */
  contract: ContractId | null;
  /** The UTC date of the Today's Expedition attempt this sheet belonged to, else null (never stored in the archives). */
  daily: string | null;
}

/**
 * Whether a result belongs in these (Standard) archives. Explorer plays by the same rules but adds
 * a learning aid (the Step Echo), a Survey Contract is Standard play on a set sheet with its own goal,
 * and a Today's Expedition sheet is one of a day's three set sheets with its own result, so all three
 * are resolved like any other expedition but kept out of the Standard records, whatever their outcome.
 */
export function countsTowardRecords(result: ExpeditionResult): boolean {
  return result.mode === 'standard' && result.contract === null && result.daily === null;
}

export function emptyRecords(): CareerRecords {
  return { version: 1, expeditions: 0, summits: 0, bestSurveyed: 0, bestGrade: null, tilesMapped: 0, fewestTurns: null };
}

export function gradeRank(grade: string | null): number {
  return grade === null ? -1 : GRADE_ORDER.indexOf(grade);
}

/** The records after one more expedition (pure; the input is not modified). */
export function applyExpedition(rec: CareerRecords, result: Omit<ExpeditionResult, 'mode' | 'contract' | 'daily'>): CareerRecords {
  const won = result.outcome === 'victory';
  const bestGrade = gradeRank(result.grade) > gradeRank(rec.bestGrade) ? result.grade : rec.bestGrade;
  return {
    version: 1,
    expeditions: rec.expeditions + 1,
    summits: rec.summits + (won ? 1 : 0),
    bestSurveyed: Math.max(rec.bestSurveyed, Math.round(result.percentMapped * 10) / 10),
    bestGrade,
    tilesMapped: rec.tilesMapped + Math.max(0, Math.round(result.tilesMapped)),
    fewestTurns: won ? Math.min(rec.fewestTurns ?? Infinity, result.turns) : rec.fewestTurns,
  };
}

function finiteAtLeast(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : null;
}

/** Parse stored JSON defensively: anything malformed falls back field by field to empty records. */
export function parseRecords(raw: string | null): CareerRecords {
  const base = emptyRecords();
  if (!raw) return base;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof data !== 'object' || data === null) return base;
  const d = data as Record<string, unknown>;
  const grade = typeof d.bestGrade === 'string' && GRADE_ORDER.includes(d.bestGrade) ? d.bestGrade : null;
  return {
    version: 1,
    expeditions: Math.floor(finiteAtLeast(d.expeditions, 0) ?? 0),
    summits: Math.floor(finiteAtLeast(d.summits, 0) ?? 0),
    bestSurveyed: Math.min(100, finiteAtLeast(d.bestSurveyed, 0) ?? 0),
    bestGrade: grade,
    tilesMapped: Math.floor(finiteAtLeast(d.tilesMapped, 0) ?? 0),
    fewestTurns: finiteAtLeast(d.fewestTurns, 1),
  };
}

export function loadRecords(): CareerRecords {
  try {
    return parseRecords(localStorage.getItem(RECORDS_STORAGE_KEY));
  } catch {
    return emptyRecords();
  }
}

export function saveRecords(rec: CareerRecords): void {
  try {
    localStorage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(rec));
  } catch {
    // Blocked storage: the archives simply last for this session.
  }
}

/**
 * Keeps the career archives in step with the game: every expedition is resolved exactly once.
 * It is recorded when it ends (victory or collapse), or as abandoned when it is left behind after
 * at least one step: replaced by R or a new sheet, abandoned from the pause menu, or the page
 * closing. Zero-turn expeditions are never recorded. `sync` and `abandon` are idempotent, so
 * repeated clicks, fast inputs and page teardown cannot record an expedition twice. `onRecord` also
 * receives the expedition's own state, never the one that replaced it.
 */
export class RecordKeeper {
  private tracked: GameState;
  private recorded = false;

  constructor(
    state: GameState,
    private readonly onRecord: (result: ExpeditionResult, expedition: GameState) => void,
  ) {
    this.tracked = state;
  }

  /**
   * Call whenever the game state may have changed (every frame, right after a swap, and from the game's
   * onEnd on the step that ends an expedition).
   */
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
    this.onRecord(
      {
        outcome,
        percentMapped: (state.revealedCount / (MAP_W * MAP_H)) * 100,
        tilesMapped: state.revealedCount,
        turns: state.turns,
        grade,
        mode: state.mode,
        contract: state.contract,
        daily: state.daily?.date ?? null,
      },
      state,
    );
  }
}
