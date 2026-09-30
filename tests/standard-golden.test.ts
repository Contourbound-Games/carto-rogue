// Standard gameplay regression: every golden seed, under every input script, must fingerprint exactly
// as it did on the commit the golden was captured on (see tests/support/fingerprint.ts for what a
// fingerprint covers). Regenerate only with a stated reason, never in the same change as a gameplay
// feature:  CARTO_WRITE_GOLDEN=<commit> npx vitest run tests/standard-golden.test.ts
import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GOLDEN_SEEDS, SCRIPTS, mapDigest, runDigest } from './support/fingerprint';
import type { RunDigest, ScriptName } from './support/fingerprint';
import { generateMap } from '../src/map';

interface GoldenEntry {
  seed: number;
  map: string;
  runs: Record<ScriptName, RunDigest>;
}

interface Golden {
  commit: string;
  seeds: number;
  entries: GoldenEntry[];
}

const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/standard-golden.json', import.meta.url));

function capture(seed: number, extra: Record<string, unknown> = {}): GoldenEntry {
  const runs = {} as Record<ScriptName, RunDigest>;
  for (const script of SCRIPTS) runs[script] = runDigest(seed, script, extra);
  return { seed, map: mapDigest(generateMap(seed)), runs };
}

const writeCommit = process.env.CARTO_WRITE_GOLDEN;

describe.runIf(writeCommit)('Standard golden capture', () => {
  it('writes the golden fingerprints', () => {
    const golden: Golden = { commit: writeCommit ?? '', seeds: GOLDEN_SEEDS.length, entries: GOLDEN_SEEDS.map((s) => capture(s)) };
    fs.mkdirSync(fileURLToPath(new URL('./fixtures/', import.meta.url)), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 1) + '\n');
  }, 600_000);
});

describe.skipIf(writeCommit)('Standard golden fingerprint', () => {
  const load = (): Golden => JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as Golden;

  it('covers every golden seed', () => {
    expect(load().entries.map((e) => e.seed)).toEqual([...GOLDEN_SEEDS]);
  });

  it('reproduces every Standard map and run exactly', () => {
    for (const entry of load().entries) expect(capture(entry.seed), `seed ${entry.seed}`).toEqual(entry);
  }, 600_000);
});
