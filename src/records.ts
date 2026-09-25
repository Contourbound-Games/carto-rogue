// Career records ("Expedition Archives"), kept in localStorage across sessions.
// The pure update function is separate from storage so it can be unit tested.

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
}

export function emptyRecords(): CareerRecords {
  return { version: 1, expeditions: 0, summits: 0, bestSurveyed: 0, bestGrade: null, tilesMapped: 0, fewestTurns: null };
}

export function gradeRank(grade: string | null): number {
  return grade === null ? -1 : GRADE_ORDER.indexOf(grade);
}

/** The records after one more expedition (pure; the input is not modified). */
export function applyExpedition(rec: CareerRecords, result: ExpeditionResult): CareerRecords {
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
