// Today's Expedition records (Steam edition): the best completed attempt of each UTC date, kept in
// localStorage apart from the Standard archives and the Survey Contract progress. Only completed attempts
// are kept (no attempts, failures or times), one per date and Daily revision, and none is ever dropped.
import { compareDaily, dailyCompletedBy, isDateKey } from './daily';
import type { DailyResult } from './daily';
import type { DailySheetSummary, GameState } from './types';

export const DAILY_RECORDS_STORAGE_KEY = 'carto_rogue_daily_v1';

/** A date's best completed attempt. */
export type DailyBest = DailyResult;

export interface DailyRecords {
  version: 1;
  /** One best per (date, revision), in the order the dates were first completed. */
  days: DailyBest[];
}

export function emptyDailyRecords(): DailyRecords {
  return { version: 1, days: [] };
}

const GRADES: readonly string[] = ['S', 'A', 'B', 'C'];

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function parseSheet(value: unknown): DailySheetSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.grade !== 'string' || !GRADES.includes(s.grade)) return null;
  if (!intIn(s.points, 0, 100) || !intIn(s.turns, 1, 1_000_000) || !intIn(s.staminaLeft, 0, 100)) return null;
  return { grade: s.grade, points: s.points, turns: s.turns, staminaLeft: s.staminaLeft };
}

/** One stored best, or null when anything about it is malformed or its totals disagree with its sheets. */
function parseBest(value: unknown): DailyBest | null {
  if (typeof value !== 'object' || value === null) return null;
  const d = value as Record<string, unknown>;
  if (!isDateKey(d.date) || !intIn(d.revision, 1, 1_000_000) || !intIn(d.generator, 1, 1_000_000)) return null;
  const seeds = d.seeds;
  if (!Array.isArray(seeds) || seeds.length !== 3 || !seeds.every((s) => intIn(s, 0, 0xffffffff))) return null;
  if (!Array.isArray(d.sheets) || d.sheets.length !== 3) return null;
  const sheets = d.sheets.map(parseSheet);
  if (sheets.some((s) => s === null)) return null;
  const ok = sheets as DailySheetSummary[];
  const totalPoints = ok.reduce((sum, s) => sum + s.points, 0);
  const totalTurns = ok.reduce((sum, s) => sum + s.turns, 0);
  const totalStaminaLeft = ok.reduce((sum, s) => sum + s.staminaLeft, 0);
  if (d.totalPoints !== totalPoints || d.totalTurns !== totalTurns || d.totalStaminaLeft !== totalStaminaLeft) return null;
  return {
    date: d.date,
    revision: d.revision,
    generator: d.generator,
    seeds: [seeds[0] as number, seeds[1] as number, seeds[2] as number],
    totalPoints,
    totalTurns,
    totalStaminaLeft,
    sheets: ok,
  };
}

/**
 * Parse stored JSON defensively: malformed entries are dropped one by one, and of two entries for the
 * same date and revision the better (the earlier on a tie) is kept.
 */
export function parseDailyRecords(raw: string | null): DailyRecords {
  if (!raw) return emptyDailyRecords();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyDailyRecords();
  }
  if (typeof data !== 'object' || data === null) return emptyDailyRecords();
  const days = (data as Record<string, unknown>).days;
  if (!Array.isArray(days)) return emptyDailyRecords();
  let records = emptyDailyRecords();
  for (const entry of days) {
    const best = parseBest(entry);
    if (best) records = applyDailyResult(records, best);
  }
  return records;
}

export function loadDailyRecords(): DailyRecords {
  try {
    return parseDailyRecords(localStorage.getItem(DAILY_RECORDS_STORAGE_KEY));
  } catch {
    return emptyDailyRecords();
  }
}

export function saveDailyRecords(records: DailyRecords): void {
  try {
    localStorage.setItem(DAILY_RECORDS_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Blocked storage: the records simply last for this session.
  }
}

/** The best completed attempt kept for `date` (and `revision`), or null. */
export function dailyBestFor(days: readonly DailyBest[], date: string, revision: number): DailyBest | null {
  return days.find((d) => d.date === date && d.revision === revision) ?? null;
}

/**
 * The records once `expedition` was resolved (RecordKeeper: on its summit or collapse step, or when it is
 * left behind): with its attempt kept if this was a Sheet 3 summit that ranks above its date's best.
 * The same object when there is nothing new to keep.
 */
export function recordDailyExpedition(records: DailyRecords, expedition: Pick<GameState, 'daily' | 'finalStats'>): DailyRecords {
  const completed = dailyCompletedBy(expedition);
  return completed ? applyDailyResult(records, completed) : records;
}

/**
 * The records with `result` kept as its date's best if it ranks above the one there (or there is none).
 * The same object when it does not (a tie keeps the earlier result), so there is nothing to save.
 */
export function applyDailyResult(records: DailyRecords, result: DailyResult): DailyRecords {
  const k = records.days.findIndex((d) => d.date === result.date && d.revision === result.revision);
  if (k >= 0 && compareDaily(result, records.days[k]) >= 0) return records;
  const best: DailyBest = { ...result, seeds: [...result.seeds], sheets: result.sheets.map((s) => ({ ...s })) };
  const days = k >= 0 ? records.days.map((d, j) => (j === k ? best : d)) : [...records.days, best];
  return { version: 1, days };
}
