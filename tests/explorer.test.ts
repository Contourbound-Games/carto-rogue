// Explorer mode (C2): the same sheet and exactly the same rules as Standard; only the presentation
// adds the Step Echo (see echo.test.ts). Its gameplay must fingerprint exactly as the Standard
// golden, and its results must stay out of the Standard archives.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Game } from '../src/game';
import { generateMap } from '../src/map';
import { MODE_STORAGE_KEY, isMode, loadMode, saveMode } from '../src/mode';
import { countsTowardRecords, RecordKeeper } from '../src/records';
import type { ExpeditionResult } from '../src/records';
import { shareText } from '../src/share';
import type { AudioEngine, ExpeditionStats, GameState } from '../src/types';
import { GOLDEN_SEEDS, SCRIPTS, mapDigest, runDigest } from './support/fingerprint';
import type { RunDigest, ScriptName } from './support/fingerprint';

const silent: AudioEngine = {
  unlock: () => {},
  muted: false,
  toggleMute: () => false,
  footstep: () => {},
  bump: () => {},
  cacheCollected: () => {},
  discovery: () => {},
  lowStamina: () => {},
  victory: () => {},
  defeat: () => {},
  expeditionStart: () => {},
  stopAll: () => {},
};

const start = (seed: number, mode: 'standard' | 'explorer'): Game =>
  new Game(silent, generateMap, { seed, now: 0, startPlaying: true, mode });

interface GoldenEntry {
  seed: number;
  map: string;
  runs: Record<ScriptName, RunDigest>;
}
const golden = (): GoldenEntry[] =>
  (JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/standard-golden.json', import.meta.url)), 'utf8')) as {
    entries: GoldenEntry[];
  }).entries;

describe('Explorer gameplay equals Standard', () => {
  it('fingerprints every golden seed and script exactly as the Standard golden', () => {
    // The fingerprint covers the map, movement, stamina, survey and LOS, sightings, panoramas, camps,
    // the log and sounds, finalStats and grade, the record result and retry (tests/support/fingerprint.ts).
    const entries = golden();
    expect(entries.map((e) => e.seed)).toEqual([...GOLDEN_SEEDS]);
    for (const entry of entries) {
      for (const script of SCRIPTS) {
        expect(runDigest(entry.seed, script, { mode: 'explorer' }), `seed ${entry.seed} ${script}`).toEqual(entry.runs[script]);
      }
    }
  }, 600_000);

  it('plays those expeditions in Explorer, on the same sheet', () => {
    for (const seed of GOLDEN_SEEDS.slice(0, 40)) {
      const s = start(seed, 'standard').state;
      const e = start(seed, 'explorer').state;
      expect(e.mode).toBe('explorer');
      expect(mapDigest(e.map)).toBe(mapDigest(s.map));
      expect([e.map.spawn, e.map.summit, e.map.caches]).toEqual([s.map.spawn, s.map.summit, s.map.caches]);
    }
  });
});

/** Every gameplay field of a fresh expedition (the mode left out). */
function freshState(s: GameState): unknown {
  return {
    phase: s.phase,
    seed: s.seed,
    map: mapDigest(s.map),
    player: [s.player.x, s.player.y, s.player.facing],
    stamina: s.stamina,
    turns: s.turns,
    revealed: Array.from(s.revealed),
    visible: Array.from(s.visible),
    visionRadius: s.visionRadius,
    sighted: [s.cacheSighted, s.summitSighted, s.peakSighted],
    neighborCosts: s.neighborCosts,
    trail: s.trail,
  };
}

describe('choosing the mode', () => {
  it('defaults to Standard', () => {
    expect(new Game(silent, generateMap, { seed: 205, now: 0 }).state.mode).toBe('standard');
  });

  it('switches on the title card without touching anything else', () => {
    const game = new Game(silent, generateMap, { seed: 205, now: 0 });
    const before = game.state;
    const snapshot = freshState(before);
    expect(game.setMode('explorer')).toBe(true);
    expect(game.state).toBe(before);
    expect(game.state.mode).toBe('explorer');
    expect(freshState(game.state)).toEqual(snapshot);
  });

  it('is fixed once the expedition begins', () => {
    const game = start(205, 'standard');
    expect(game.setMode('explorer')).toBe(false);
    expect(game.state.mode).toBe('standard');
  });

  it('carries over to retries, new sheets, typed seeds and the title card, each a normal fresh start', () => {
    const game = start(205, 'explorer');
    game.handleAction('right', 200);
    game.retrySheet(400);
    expect(game.state.mode).toBe('explorer');
    expect(freshState(game.state)).toEqual(freshState(start(205, 'standard').state));
    game.handleAction('restart', 600);
    expect(game.state.mode).toBe('explorer');
    expect(game.state.seed).not.toBe(205);
    expect(freshState(game.state)).toEqual(freshState(start(game.state.seed, 'standard').state));
    game.startSeed(800, 555);
    expect(game.state.mode).toBe('explorer');
    expect(freshState(game.state)).toEqual(freshState(start(555, 'standard').state));
    game.returnToTitle(1000);
    expect(game.state.mode).toBe('explorer');
    expect(game.state.phase).toBe('title');
    expect(game.setMode('standard')).toBe(true);
    game.handleAction('confirm', 1200);
    game.retrySheet(1400);
    expect(game.state.mode).toBe('standard');
  });

  it('remembers the choice, falling back to Standard', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const previous = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    try {
      expect(loadMode()).toBe('standard');
      saveMode('explorer');
      expect(store.get(MODE_STORAGE_KEY)).toBe('explorer');
      expect(loadMode()).toBe('explorer');
      store.set(MODE_STORAGE_KEY, 'expert');
      expect(loadMode()).toBe('standard');
    } finally {
      g.localStorage = previous;
    }
    expect(isMode('standard') && isMode('explorer') && !isMode('')).toBe(true);
  });
});

describe('Explorer results', () => {
  it('are resolved with their mode and kept out of the Standard records', () => {
    for (const mode of ['standard', 'explorer'] as const) {
      const game = start(555, mode);
      const results: ExpeditionResult[] = [];
      const keeper = new RecordKeeper(game.state, (r) => results.push(r));
      game.handleAction('right', 200);
      game.handleAction('left', 400);
      keeper.abandon();
      expect(results.map((r) => r.mode)).toEqual([mode]);
      expect(countsTowardRecords(results[0])).toBe(mode === 'standard');
    }
  });

  it('say Explorer when shared; Standard shares read exactly as before', () => {
    const stats: ExpeditionStats = {
      outcome: 'victory',
      turns: 67,
      staminaSpent: 90,
      staminaLeft: 50,
      cachesCollected: 1,
      cachesTotal: 5,
      maxElevation: 0.9,
      percentMapped: 15.5,
      elapsedMs: 0,
      grade: 'S',
      breakdown: null,
    };
    expect(shareText(721405, stats, 'en', 'standard')).toBe(shareText(721405, stats, 'en'));
    expect(shareText(721405, stats, 'en')).not.toContain('Mode');
    expect(shareText(721405, stats, 'en', 'explorer')).toContain('Explored: 15.5% | Mode: EXPLORER | Grade: S');
    expect(shareText(721405, stats, 'ko', 'explorer')).toContain('모드: 탐험가');
  });
});
