// Generator versioning: a mountain is { generator, seed }. Version 1 is the golden output; Retry keeps the
// exact pair; every other start uses the default generator; unknown versions are refused; records and the
// noise dependency stay as they were.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Game } from '../src/game';
import { GENERATOR_VERSION, SUPPORTED_GENERATORS, generateMap } from '../src/map';
import { emptyRecords, parseRecords } from '../src/records';
import type { AudioEngine, MapData } from '../src/types';
import { mapDigest } from './support/fingerprint';

const silent: AudioEngine = {
  muted: false,
  unlock: () => undefined,
  toggleMute: () => false,
  footstep: () => undefined,
  bump: () => undefined,
  cacheCollected: () => undefined,
  discovery: () => undefined,
  lowStamina: () => undefined,
  victory: () => undefined,
  defeat: () => undefined,
  expeditionStart: () => undefined,
  stopAll: () => undefined,
};

const golden = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/standard-golden.json', import.meta.url)), 'utf8')) as {
  entries: { seed: number; map: string }[];
};

describe('generator identity', () => {
  it('is version 1, the only one this build produces', () => {
    expect(GENERATOR_VERSION).toBe(1);
    expect(SUPPORTED_GENERATORS).toEqual([1]);
  });

  it('gives the golden mountain for a seed with or without the explicit version, stamped as generator 1', () => {
    for (const entry of golden.entries.slice(0, 6)) {
      const byDefault = generateMap(entry.seed);
      const pinned = generateMap(entry.seed, 1);
      expect(byDefault.generator).toBe(1);
      expect(pinned.generator).toBe(1);
      expect(mapDigest(byDefault), `seed ${entry.seed}`).toBe(entry.map);
      expect(mapDigest(pinned), `seed ${entry.seed}`).toBe(entry.map);
    }
  });

  it('refuses a generator version it cannot produce', () => {
    for (const v of [0, 2, 99, -1, 1.5, Number.NaN]) {
      expect(() => generateMap(205, v), `version ${v}`).toThrow(RangeError);
    }
  });
});

describe('expedition starts', () => {
  /** A factory that records every request and stamps the map with the generator it was asked for. */
  function recordingFactory(defaultGenerator: number): { calls: [number, number | undefined][]; make: (seed: number, generator?: number) => MapData } {
    const calls: [number, number | undefined][] = [];
    const base = generateMap(205);
    return {
      calls,
      make: (seed, generator) => {
        calls.push([seed, generator]);
        return { ...base, seed, generator: generator ?? defaultGenerator };
      },
    };
  }

  it('Retry asks for the same seed and the same generator as the sheet just played', () => {
    // A hypothetical default of 7 shows the version travels with the map, not with today's default.
    const f = recordingFactory(7);
    const game = new Game(silent, f.make, { seed: 4242, now: 0, startPlaying: true });
    expect(game.state.map.generator).toBe(7);
    game.retrySheet(100);
    expect(f.calls.at(-1)).toEqual([4242, 7]);
    expect(game.state.map).toMatchObject({ seed: 4242, generator: 7 });
  });

  it('new, random, typed and linked seeds use the default generator', () => {
    const f = recordingFactory(7);
    const game = new Game(silent, f.make, { seed: 4242, now: 0 }); // a ?seed= link / first sheet
    game.handleAction('restart', 100); // R: a fresh random seed
    game.startSeed(200, 999); // a typed seed
    game.newExpedition(300); // a new expedition
    game.returnToTitle(400);
    for (const [, generator] of f.calls) expect(generator).toBeUndefined();
    expect(f.calls[0][0]).toBe(4242);
    expect(f.calls[2][0]).toBe(999);
  });

  it('Retry on the real generator regenerates the identical mountain', () => {
    const game = new Game(silent, generateMap, { seed: 205, now: 0, startPlaying: true });
    const before = mapDigest(game.state.map);
    game.handleAction('right', 100);
    game.retrySheet(200);
    expect(game.state.turns).toBe(0);
    expect(game.state.map.generator).toBe(GENERATOR_VERSION);
    expect(mapDigest(game.state.map)).toBe(before);
  });
});

describe('saved data and dependencies', () => {
  it('loads existing itch records, which carry no generator, unchanged', () => {
    const itch = '{"version":1,"expeditions":12,"summits":5,"bestSurveyed":18.4,"bestGrade":"A","tilesMapped":6123,"fewestTurns":58}';
    expect(parseRecords(itch)).toEqual(JSON.parse(itch));
    expect(Object.keys(emptyRecords())).not.toContain('generator');
  });

  it('pins the noise library that generator 1 depends on', () => {
    const read = (p: string): unknown => JSON.parse(fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
    const pkg = read('../package.json') as { dependencies: Record<string, string> };
    const lock = read('../package-lock.json') as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
    const installed = read('../node_modules/simplex-noise/package.json') as { version: string };
    expect(pkg.dependencies['simplex-noise']).toBe('4.0.3');
    expect(lock.packages[''].dependencies?.['simplex-noise']).toBe('4.0.3');
    expect(lock.packages['node_modules/simplex-noise'].version).toBe('4.0.3');
    expect(installed.version).toBe('4.0.3');
  });
});
