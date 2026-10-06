// Today's Expedition records (src/daily-records.ts): the best completed attempt of each UTC date, kept
// under their own key apart from the Standard archives and the Contract progress, never pruned, and read
// back defensively.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACT_PROGRESS_STORAGE_KEY } from '../src/contract-progress';
import { dailyIdentity } from '../src/daily';
import type { DailyResult } from '../src/daily';
import {
  applyDailyResult,
  DAILY_RECORDS_STORAGE_KEY,
  dailyBestFor,
  emptyDailyRecords,
  loadDailyRecords,
  parseDailyRecords,
  saveDailyRecords,
} from '../src/daily-records';
import { RECORDS_STORAGE_KEY } from '../src/records';

/** A completed attempt on `date` with these totals, split over three sheets. */
function result(date: string, points: number, turns: number, stamina: number): DailyResult {
  const p = [Math.floor(points / 3), Math.floor(points / 3), points - 2 * Math.floor(points / 3)];
  const t = [Math.floor(turns / 3), Math.floor(turns / 3), turns - 2 * Math.floor(turns / 3)];
  const s = [Math.floor(stamina / 3), Math.floor(stamina / 3), stamina - 2 * Math.floor(stamina / 3)];
  return {
    ...dailyIdentity(date),
    seeds: [...dailyIdentity(date).seeds],
    totalPoints: points,
    totalTurns: turns,
    totalStaminaLeft: stamina,
    sheets: [0, 1, 2].map((k) => ({ grade: 'A', points: p[k], turns: t[k], staminaLeft: s[k] })),
  };
}

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe('keeping the best of each date', () => {
  it('keeps a date\'s first completed attempt, then only one that ranks above it', () => {
    let rec = applyDailyResult(emptyDailyRecords(), result('2026-10-06', 200, 150, 30));
    expect(rec.days).toHaveLength(1);
    const keep = (r: DailyResult) => {
      const next = applyDailyResult(rec, r);
      const changed = next !== rec;
      rec = next;
      return changed;
    };
    expect(keep(result('2026-10-06', 190, 100, 90))).toBe(false); // fewer points
    expect(keep(result('2026-10-06', 200, 160, 99))).toBe(false); // more turns
    expect(keep(result('2026-10-06', 200, 150, 29))).toBe(false); // less stamina left
    expect(keep(result('2026-10-06', 200, 150, 30))).toBe(false); // a tie keeps the earlier one
    expect(keep(result('2026-10-06', 200, 150, 31))).toBe(true);
    expect(keep(result('2026-10-06', 200, 149, 0))).toBe(true);
    expect(keep(result('2026-10-06', 201, 300, 0))).toBe(true);
    expect(rec.days).toHaveLength(1);
    expect(dailyBestFor(rec.days, '2026-10-06', 1)).toMatchObject({ totalPoints: 201, totalTurns: 300, totalStaminaLeft: 0 });
  });

  it('keeps each date apart and never drops an old date', () => {
    let rec = emptyDailyRecords();
    const first = Date.UTC(2026, 9, 1) / 86_400_000;
    for (let k = 0; k < 1000; k++) {
      const date = new Date((first + k) * 86_400_000).toISOString().slice(0, 10);
      rec = applyDailyResult(rec, result(date, 150 + (k % 50), 120, 40));
    }
    expect(rec.days).toHaveLength(1000);
    saveDailyRecords(rec);
    const back = loadDailyRecords();
    expect(back.days).toHaveLength(1000);
    expect(dailyBestFor(back.days, '2026-10-01', 1)?.totalPoints).toBe(150);
    expect(back).toEqual(rec);
  });

  it('does not change the result it was given', () => {
    const r = result('2026-10-06', 200, 150, 30);
    const copy = structuredClone(r);
    const rec = applyDailyResult(emptyDailyRecords(), r);
    rec.days[0].sheets[0].points = 0;
    expect(r).toEqual(copy);
  });
});

describe('reading stored records', () => {
  it('round-trips through its own key, apart from the archives and the Contract progress', () => {
    const rec = applyDailyResult(emptyDailyRecords(), result('2026-10-06', 211, 140, 75));
    saveDailyRecords(rec);
    expect([...store.keys()]).toEqual([DAILY_RECORDS_STORAGE_KEY]);
    expect(DAILY_RECORDS_STORAGE_KEY).toBe('carto_rogue_daily_v1');
    expect(new Set([DAILY_RECORDS_STORAGE_KEY, RECORDS_STORAGE_KEY, CONTRACT_PROGRESS_STORAGE_KEY]).size).toBe(3);
    expect(JSON.parse(store.get(DAILY_RECORDS_STORAGE_KEY) ?? '')).toEqual({
      version: 1,
      days: [
        {
          date: '2026-10-06',
          revision: 1,
          generator: 1,
          seeds: [1523816040, 780564661, 3169043382],
          totalPoints: 211,
          totalTurns: 140,
          totalStaminaLeft: 75,
          sheets: rec.days[0].sheets,
        },
      ],
    });
    expect(loadDailyRecords()).toEqual(rec);
  });

  it('survives anything malformed, dropping only the bad entries', () => {
    const good = result('2026-10-06', 211, 140, 75);
    const bad: unknown[] = [
      null,
      42,
      'x',
      { ...good, date: '2026-02-30' },
      { ...good, date: 20261006 },
      { ...good, revision: 0 },
      { ...good, seeds: [1, 2] },
      { ...good, seeds: [1, 2, -1] },
      { ...good, seeds: [1, 2, 2 ** 32] },
      { ...good, totalPoints: 999 },
      { ...good, sheets: good.sheets.slice(0, 2) },
      { ...good, sheets: [{ ...good.sheets[0], grade: 'F' }, good.sheets[1], good.sheets[2]] },
      { ...good, sheets: [{ ...good.sheets[0], points: 101 }, good.sheets[1], good.sheets[2]] },
      { ...good, sheets: [{ ...good.sheets[0], turns: 1.5 }, good.sheets[1], good.sheets[2]] },
      { ...good, sheets: [{ ...good.sheets[0], staminaLeft: -1 }, good.sheets[1], good.sheets[2]] },
    ];
    for (const raw of [null, '', 'not json', '[]', '{}', '{"days":7}', 'null', '"x"']) {
      expect(parseDailyRecords(raw), String(raw)).toEqual(emptyDailyRecords());
    }
    const parsed = parseDailyRecords(JSON.stringify({ version: 1, days: [...bad, good] }));
    expect(parsed.days).toEqual([good]);
    // Two entries for one date: the better one stays (the earlier on a tie).
    const worse = result('2026-10-06', 100, 100, 0);
    expect(parseDailyRecords(JSON.stringify({ days: [worse, good] })).days).toEqual([good]);
    // Blocked storage: empty records, and saving never throws.
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDailyRecords()).toEqual(emptyDailyRecords());
    expect(() => saveDailyRecords(parsed)).not.toThrow();
  });
});
