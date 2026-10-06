// Today's Expedition (Steam edition): three generated Standard sheets a UTC day, the same for everyone.
// This module names a day's sheets and judges a finished attempt; it adds no rule. Each sheet is played
// exactly like any Standard expedition (Game.startDaily / nextDailySheet), from full stamina.
//
// The day's sheets (revision 1, frozen once shipped: changing any of this is a new Daily revision):
//   epochDay = floor(Date.UTC(y, m - 1, d) / 86 400 000)      UTC days since 1970-01-01
//   base     = hashSeed(DAILY_NAMESPACE, DAILY_REVISION)
//   daySeed  = hashSeed(base, epochDay)
//   seeds    = hashSeed(daySeed, c) for c = 0, 1, 2, ..., skipping 0 and repeats, until there are three
// hashSeed(daySeed, .) is a bijection of the 32-bit integers, so one day's draws never repeat; the skip
// only guards the rule. Every seed is a full 32-bit sheet seed on generator DAILY_GENERATOR.
//
// Only a completed attempt (all three sheets summited) is a result. Results compare by total gradePoints
// (higher first), then total turns (fewer), then total stamina left at the pillars (more); elapsed time
// never counts.
//
// Nothing here reads a clock: the caller passes the time (main.ts, at the Daily card only).
import { dailySheetSummary } from './game';
import { hashSeed } from './rng';
import type { DailyShare } from './share';
import type { DailyIdentity, DailyRun, DailySheetSummary, GameState } from './types';

export const DAILY_REVISION = 1;
export const DAILY_GENERATOR = 1;
/** 'CRDY'. */
export const DAILY_NAMESPACE = 0x43524459;
export const DAILY_SHEETS = 3;
/** The best total a completed attempt can score: three sheets of 100 points. */
export const DAILY_MAX_POINTS = 300;

const DAY_MS = 86_400_000;

/** The revision's root seed, mixed with each day. */
export const DAILY_BASE = hashSeed(DAILY_NAMESPACE, DAILY_REVISION);

/** A completed attempt: its identity and how each sheet finished, with the totals they add up to. */
export interface DailyResult {
  date: string;
  revision: number;
  generator: number;
  seeds: [number, number, number];
  totalPoints: number;
  totalTurns: number;
  totalStaminaLeft: number;
  sheets: DailySheetSummary[];
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** The UTC calendar date of an instant (milliseconds since the epoch), as 'YYYY-MM-DD'. */
export function utcDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/** Whether `value` is a real calendar date written 'YYYY-MM-DD', from 1970-01-01 on. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  return y >= 1970 && utcDateKey(ms) === value;
}

/** UTC days from 1970-01-01 to the date 'YYYY-MM-DD'. Throws for anything else. */
export function epochDay(dateKey: string): number {
  if (!isDateKey(dateKey)) throw new RangeError(`Not a UTC date key: ${dateKey}`);
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** The three sheet seeds a day seed names: draws 0, 1, 2, ... with 0 and repeats skipped. */
export function dailySeedsFrom(daySeed: number): [number, number, number] {
  const seeds: number[] = [];
  for (let c = 0; seeds.length < DAILY_SHEETS; c++) {
    const seed = hashSeed(daySeed, c);
    if (seed !== 0 && !seeds.includes(seed)) seeds.push(seed);
  }
  return [seeds[0], seeds[1], seeds[2]];
}

/** The day seed of a UTC date. */
export function dailyDaySeed(dateKey: string): number {
  return hashSeed(DAILY_BASE, epochDay(dateKey));
}

/** Today's Expedition for the UTC date 'YYYY-MM-DD': revision, generator and its three sheets. */
export function dailyIdentity(dateKey: string): DailyIdentity {
  return { date: dateKey, revision: DAILY_REVISION, generator: DAILY_GENERATOR, seeds: dailySeedsFrom(dailyDaySeed(dateKey)) };
}

/** The result of an attempt whose third sheet just summited with `last`; null for anything else. */
export function dailyResult(run: DailyRun, last: DailySheetSummary): DailyResult | null {
  if (run.sheet !== 2 || run.done.length !== 2) return null;
  const sheets = [...run.done, last].map((s) => ({ ...s }));
  return {
    date: run.date,
    revision: run.revision,
    generator: run.generator,
    seeds: [run.seeds[0], run.seeds[1], run.seeds[2]],
    totalPoints: sheets.reduce((sum, s) => sum + s.points, 0),
    totalTurns: sheets.reduce((sum, s) => sum + s.turns, 0),
    totalStaminaLeft: sheets.reduce((sum, s) => sum + s.staminaLeft, 0),
    sheets,
  };
}

/** The completed result a finished expedition made: its attempt's, if this was a summit on Sheet 3; else null. */
export function dailyCompletedBy(expedition: Pick<GameState, 'daily' | 'finalStats'>): DailyResult | null {
  const { daily, finalStats } = expedition;
  const last = finalStats ? dailySheetSummary(finalStats) : null;
  return daily !== null && last !== null ? dailyResult(daily, last) : null;
}

/**
 * What a finished Daily sheet's report shares: the completed attempt after the third summit, or the
 * sheet it ended on after a collapse. Null between sheets (nothing is shared there) and for any other expedition.
 */
export function dailyShareOf(expedition: Pick<GameState, 'daily' | 'finalStats'>): DailyShare | null {
  const { daily, finalStats } = expedition;
  if (daily === null || finalStats === null) return null;
  if (finalStats.outcome === 'defeat') return { date: daily.date, completed: false, endedOnSheet: daily.sheet + 1 };
  const result = dailyCompletedBy(expedition);
  if (!result) return null;
  return {
    date: result.date,
    completed: true,
    totalPoints: result.totalPoints,
    totalTurns: result.totalTurns,
    totalStaminaLeft: result.totalStaminaLeft,
    grades: result.sheets.map((s) => s.grade),
  };
}

type Totals = Pick<DailyResult, 'totalPoints' | 'totalTurns' | 'totalStaminaLeft'>;

/** Negative when `a` ranks above `b`, positive when below, 0 when they tie on all three keys. */
export function compareDaily(a: Totals, b: Totals): number {
  return b.totalPoints - a.totalPoints || a.totalTurns - b.totalTurns || b.totalStaminaLeft - a.totalStaminaLeft;
}
