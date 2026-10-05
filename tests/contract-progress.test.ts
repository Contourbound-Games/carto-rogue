// Survey Contract progress (src/contract-progress.ts): the completed Contract ids, stored apart from the
// Standard archives and parsed defensively. Completion through real expeditions is in contracts.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTRACT_PROGRESS_STORAGE_KEY,
  completeContract,
  emptyContractProgress,
  isContractCompleted,
  loadContractProgress,
  parseContractProgress,
  saveContractProgress,
} from '../src/contract-progress';
import { SURVEY_CONTRACTS } from '../src/contracts';
import { applyExpedition, emptyRecords, loadRecords, RECORDS_STORAGE_KEY, saveRecords } from '../src/records';

const g = globalThis as { localStorage?: unknown };
const original = g.localStorage;
afterEach(() => {
  g.localStorage = original;
});

/** A Map-backed localStorage, or one whose every access throws (blocked storage). */
function fakeStorage(blocked = false): Map<string, string> {
  const store = new Map<string, string>();
  const access = <T>(fn: () => T): T => {
    if (blocked) throw new Error('storage blocked');
    return fn();
  };
  g.localStorage = {
    getItem: (k: string) => access(() => store.get(k) ?? null),
    setItem: (k: string, v: string) => access(() => void store.set(k, v)),
  };
  return store;
}

describe('Survey Contract progress', () => {
  it('starts with nothing completed', () => {
    expect(emptyContractProgress()).toEqual({ version: 1, completed: [] });
    for (const c of SURVEY_CONTRACTS) expect(isContractCompleted(emptyContractProgress(), c.id)).toBe(false);
  });

  it('adds a completion once, keeping earlier ones, and hands back the same progress when already complete', () => {
    const empty = emptyContractProgress();
    const one = completeContract(empty, 'hold-the-high-ground');
    expect(empty).toEqual(emptyContractProgress());
    expect(one.completed).toEqual(['hold-the-high-ground']);
    expect(completeContract(one, 'hold-the-high-ground')).toBe(one);
    const two = completeContract(one, 'gentle-ascent');
    expect(two.completed).toEqual(['hold-the-high-ground', 'gentle-ascent']);
    expect([isContractCompleted(two, 'gentle-ascent'), isContractCompleted(two, 'master-surveyor')]).toEqual([true, false]);
  });

  it('parses stored JSON defensively: approved ids only, each once', () => {
    for (const raw of [null, '', 'not json', '"gentle-ascent"', '42', 'null', '[1,2]', '{}', '{"completed":"gentle-ascent"}']) {
      expect(parseContractProgress(raw), String(raw)).toEqual(emptyContractProgress());
    }
    const messy = '{"version":1,"completed":[1,null,"gentle-ascent","nope","GENTLE-ASCENT","gentle-ascent",{},"master-surveyor"]}';
    expect(parseContractProgress(messy)).toEqual({ version: 1, completed: ['gentle-ascent', 'master-surveyor'] });
    // There is only version 1: the completions are read whatever the stored version says, and written as 1.
    expect(parseContractProgress('{"version":7,"completed":["hold-the-high-ground"]}')).toEqual({
      version: 1,
      completed: ['hold-the-high-ground'],
    });
  });

  it('saves under its own key and loads back the same progress', () => {
    const store = fakeStorage();
    expect(loadContractProgress()).toEqual(emptyContractProgress());
    const progress = completeContract(completeContract(emptyContractProgress(), 'master-surveyor'), 'gentle-ascent');
    saveContractProgress(progress);
    expect(CONTRACT_PROGRESS_STORAGE_KEY).toBe('carto_rogue_contracts_v1');
    expect([...store.keys()]).toEqual([CONTRACT_PROGRESS_STORAGE_KEY]);
    expect(store.get(CONTRACT_PROGRESS_STORAGE_KEY)).toBe('{"version":1,"completed":["master-surveyor","gentle-ascent"]}');
    expect(loadContractProgress()).toEqual(progress);
  });

  it('and the Standard archives never touch each other', () => {
    const store = fakeStorage();
    const records = applyExpedition(emptyRecords(), { outcome: 'victory', percentMapped: 12, tilesMapped: 576, turns: 60, grade: 'A' });
    saveRecords(records);
    saveContractProgress(completeContract(emptyContractProgress(), 'gentle-ascent'));
    expect([...store.keys()].sort()).toEqual([CONTRACT_PROGRESS_STORAGE_KEY, RECORDS_STORAGE_KEY].sort());
    expect(loadRecords()).toEqual(records);
    expect(loadContractProgress().completed).toEqual(['gentle-ascent']);
    store.set(CONTRACT_PROGRESS_STORAGE_KEY, 'garbage');
    expect(loadRecords()).toEqual(records);
  });

  it('works without storage: missing or blocked storage loads nothing and saves quietly', () => {
    g.localStorage = undefined;
    expect(loadContractProgress()).toEqual(emptyContractProgress());
    expect(() => saveContractProgress(completeContract(emptyContractProgress(), 'gentle-ascent'))).not.toThrow();
    fakeStorage(true);
    expect(loadContractProgress()).toEqual(emptyContractProgress());
    expect(() => saveContractProgress(completeContract(emptyContractProgress(), 'gentle-ascent'))).not.toThrow();
  });
});
