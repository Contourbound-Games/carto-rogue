import { describe, expect, it } from 'vitest';
import { applyExpedition, emptyRecords, gradeRank, parseRecords, RECORDS_STORAGE_KEY } from '../src/records';

describe('career records', () => {
  it('uses the versioned storage key', () => {
    expect(RECORDS_STORAGE_KEY).toBe('carto_rogue_records_v1');
  });

  it('accumulates expeditions, summits, tiles, best survey, best grade and fewest turns', () => {
    let rec = emptyRecords();
    rec = applyExpedition(rec, { outcome: 'defeat', percentMapped: 12.34, tilesMapped: 592, turns: 80, grade: 'F' });
    rec = applyExpedition(rec, { outcome: 'victory', percentMapped: 9.5, tilesMapped: 456, turns: 66, grade: 'A' });
    rec = applyExpedition(rec, { outcome: 'victory', percentMapped: 20.02, tilesMapped: 961, turns: 71, grade: 'B' });
    rec = applyExpedition(rec, { outcome: 'abandoned', percentMapped: 3, tilesMapped: 144, turns: 9, grade: null });
    expect(rec).toEqual({
      version: 1,
      expeditions: 4,
      summits: 2,
      bestSurveyed: 20,
      bestGrade: 'A',
      tilesMapped: 592 + 456 + 961 + 144,
      fewestTurns: 66,
    });
  });

  it('ranks grades F < C < B < A < S', () => {
    expect(['F', 'C', 'B', 'A', 'S'].map(gradeRank)).toEqual([0, 1, 2, 3, 4]);
    expect(gradeRank(null)).toBe(-1);
  });

  it('does not mutate its input', () => {
    const rec = emptyRecords();
    applyExpedition(rec, { outcome: 'victory', percentMapped: 5, tilesMapped: 10, turns: 3, grade: 'S' });
    expect(rec).toEqual(emptyRecords());
  });

  it('parses stored JSON defensively', () => {
    expect(parseRecords(null)).toEqual(emptyRecords());
    expect(parseRecords('not json')).toEqual(emptyRecords());
    expect(parseRecords('[1,2]').expeditions).toBe(0);
    const round = applyExpedition(emptyRecords(), {
      outcome: 'victory',
      percentMapped: 14.2,
      tilesMapped: 680,
      turns: 58,
      grade: 'S',
    });
    expect(parseRecords(JSON.stringify(round))).toEqual(round);
    const bad = parseRecords(
      JSON.stringify({ expeditions: -3, summits: 'x', bestSurveyed: 500, bestGrade: 'Z', tilesMapped: Infinity, fewestTurns: 0 }),
    );
    expect(bad).toEqual({ ...emptyRecords(), bestSurveyed: 100 });
  });
});
