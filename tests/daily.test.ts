// Today's Expedition identity (src/daily.ts): which three sheets a UTC date names, frozen for Daily
// revision 1. The constants, the root seed, each locked date's seeds and one date's three map digests are
// golden: a change here is a new Daily revision, never a fixture update.
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareDaily,
  DAILY_BASE,
  DAILY_GENERATOR,
  DAILY_NAMESPACE,
  DAILY_REVISION,
  dailyDaySeed,
  dailyIdentity,
  dailySeedsFrom,
  epochDay,
  isDateKey,
  utcDateKey,
} from '../src/daily';
import { GENERATOR_VERSION, generateMap } from '../src/map';
import { hashSeed } from '../src/rng';
import { mapDigest } from './support/fingerprint';

const SEEDS: Record<string, [number, readonly [number, number, number]]> = {
  '1970-01-01': [0, [171257900, 1791979137, 1686892936]],
  '2026-10-06': [20732, [1523816040, 780564661, 3169043382]],
  '2026-10-07': [20733, [3041955622, 1092691019, 2037958572]],
  '2026-12-31': [20818, [1323392678, 3176803596, 3797442583]],
  '2027-01-01': [20819, [757024855, 2710153972, 998553466]],
  '2028-02-29': [21243, [596039468, 1985092436, 2315538791]],
  '2038-01-19': [24855, [832301424, 1892444711, 719971702]],
  '2038-01-20': [24856, [3564827025, 3839844603, 2479392167]],
};

/** generateMap digests of 2026-10-06's three sheets (tests/support/fingerprint.ts mapDigest). */
const DIGESTS_2026_10_06 = [
  '0b123db0f1928797f430c94cbe1f5f883d3ca7984c593d4af15f465baa25f507',
  '1b869dae6a3cca3ce5812cc334acc9771556a3e34f460c52c42fbe8381cb63ef',
  'b3d400d9ddc6366d550f7e1ac50d53883d0218761c213646de7af9b7a754730a',
];

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('Daily revision 1 identity (golden)', () => {
  it('fixes the revision, the generator and the namespace, and the root seed they give', () => {
    expect([DAILY_REVISION, DAILY_GENERATOR, DAILY_NAMESPACE]).toEqual([1, 1, 0x43524459]);
    expect(DAILY_BASE).toBe(133980374);
    expect(DAILY_BASE).toBe(hashSeed(0x43524459, 1));
    // Generator 1 is pinned: the Daily sheets do not follow a newer default generator.
    expect(GENERATOR_VERSION).toBe(1);
  });

  it('names the locked seeds for each locked date', () => {
    for (const [date, [day, seeds]] of Object.entries(SEEDS)) {
      expect(epochDay(date), date).toBe(day);
      expect(dailyIdentity(date), date).toEqual({ date, revision: 1, generator: 1, seeds });
    }
  });

  it('builds the same three mountains for a date, every time', () => {
    const { seeds, generator } = dailyIdentity('2026-10-06');
    const maps = seeds.map((s) => generateMap(s, generator));
    expect(maps.map((m) => [m.seed, m.generator])).toEqual(seeds.map((s) => [s, 1]));
    expect(maps.map(mapDigest)).toEqual(DIGESTS_2026_10_06);
    expect(dailyIdentity('2026-10-06').seeds.map((s) => mapDigest(generateMap(s, 1)))).toEqual(DIGESTS_2026_10_06);
  });

  it('gives the next date a different identity and different sheets', () => {
    const today = dailyIdentity('2026-10-06');
    const tomorrow = dailyIdentity('2026-10-07');
    expect(tomorrow.date).not.toBe(today.date);
    for (const s of tomorrow.seeds) expect(today.seeds).not.toContain(s);
  });

  it('skips a zero draw: the day seed whose first draw is 0 takes draws 1, 2 and 3', () => {
    const daySeed = 3238976083;
    expect(daySeed).toBe(Math.imul(0x9e3779b9, 0x85ebca6b) >>> 0);
    expect(hashSeed(daySeed, 0)).toBe(0);
    expect(dailySeedsFrom(daySeed)).toEqual([1281820195, 1709366179, 67979756]);
    expect(dailySeedsFrom(daySeed)).toEqual([1, 2, 3].map((c) => hashSeed(daySeed, c)));
  });

  it('draws three distinct, non-zero, full 32-bit seeds every day, deterministically', () => {
    let wide = 0;
    for (let day = 20000; day < 20000 + 3653; day++) {
      const date = utcDateKey(day * 86_400_000);
      const seeds = dailyIdentity(date).seeds;
      expect(dailyIdentity(date).seeds).toEqual(seeds);
      expect(new Set(seeds).size).toBe(3);
      for (const s of seeds) {
        expect(Number.isInteger(s) && s >= 1 && s <= 0xffffffff).toBe(true);
        if (s > 999999) wide++;
      }
      expect(dailyDaySeed(date)).toBe(hashSeed(DAILY_BASE, day));
    }
    // The 1..999999 range of random seeds does not apply: nearly every Daily seed is wider.
    expect(wide).toBeGreaterThan(3653 * 3 * 0.99);
  });
});

describe('UTC dates', () => {
  it('turns at UTC midnight', () => {
    const last = Date.UTC(2026, 9, 6, 23, 59, 59, 999);
    expect(utcDateKey(last)).toBe('2026-10-06');
    expect(utcDateKey(last + 1)).toBe('2026-10-07');
    expect(utcDateKey(Date.UTC(2026, 9, 6))).toBe('2026-10-06');
  });

  it('reads the UTC date, whatever the local time zone', () => {
    const instant = Date.parse('2026-10-06T15:30:00Z');
    for (const tz of ['Asia/Seoul', 'America/Los_Angeles', 'UTC', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      expect(utcDateKey(instant), tz).toBe('2026-10-06');
    }
    // In Seoul that instant is already 7 October: the local date is not what the Daily uses.
    process.env.TZ = 'Asia/Seoul';
    expect(new Date(instant).getDate()).toBe(7);
  });

  it('accepts only real dates written YYYY-MM-DD from 1970 on', () => {
    for (const ok of ['1970-01-01', '2028-02-29', '2026-10-06', '9999-12-31']) expect(isDateKey(ok), ok).toBe(true);
    for (const bad of ['2027-02-29', '2026-13-01', '2026-10-6', '1969-12-31', ' 2026-10-06', '2026/10/06', 20261006, null]) {
      expect(isDateKey(bad), String(bad)).toBe(false);
    }
    expect(() => epochDay('2027-02-29')).toThrow(RangeError);
  });
});

describe('ranking completed attempts', () => {
  const r = (p: number, t: number, s: number) => ({ totalPoints: p, totalTurns: t, totalStaminaLeft: s });

  it('ranks by total points, then fewer turns, then more stamina left', () => {
    const ranked = [r(200, 150, 10), r(210, 300, 0), r(200, 140, 0), r(200, 140, 5)].sort(compareDaily);
    expect(ranked).toEqual([r(210, 300, 0), r(200, 140, 5), r(200, 140, 0), r(200, 150, 10)]);
    expect(compareDaily(r(200, 140, 5), r(200, 140, 5))).toBe(0);
  });
});
