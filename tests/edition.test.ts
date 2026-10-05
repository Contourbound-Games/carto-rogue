// Editions (src/edition.ts): the itch.io and Steam builds differ only by the build mode. The default build
// is itch, into dist/; `--mode steam` is Steam, into dist-steam/. Built bundles are checked in memory (nothing
// is written): only the Steam bundle wires Survey Contract progress. Only the application wiring reads the
// edition, and the desktop shell keeps packaging the default (itch) build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { CONTRACT_PROGRESS_STORAGE_KEY } from '../src/contract-progress';
import { EDITION } from '../src/edition';
import { contractTextTables } from '../src/i18n';
import { RECORDS_STORAGE_KEY } from '../src/records';

const root = fileURLToPath(new URL('..', import.meta.url));
const configFile = path.join(root, 'vite.config.ts');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

/** The JavaScript a production build in `mode` emits, built in memory. */
async function bundle(mode: string): Promise<string> {
  const result = await build({ root, configFile, mode, logLevel: 'silent', build: { write: false } });
  const outputs = [result].flat() as unknown as { output: { type: string; code?: string }[] }[];
  return outputs.flatMap((o) => o.output.filter((f) => f.type === 'chunk').map((f) => f.code ?? '')).join('\n');
}

describe('editions', () => {
  it('builds itch by default and Steam only in steam mode, each into its own folder', async () => {
    const editionOf = async (mode: string) => {
      const config = await resolveConfig({ root, configFile, mode }, 'build');
      return [config.define?.__EDITION__, path.relative(root, path.resolve(root, config.build.outDir))];
    };
    expect(await editionOf('production')).toEqual(['"itch"', 'dist']);
    expect(await editionOf('development')).toEqual(['"itch"', 'dist']);
    expect(await editionOf('steam')).toEqual(['"steam"', 'dist-steam']);
    // The tests themselves run as the default edition.
    expect(EDITION).toBe('itch');
  });

  it('wires Survey Contract progress, the Contract card and the report band into the Steam bundle only', async () => {
    const [itch, steam] = await Promise.all([bundle('production'), bundle('steam')]);
    for (const code of [itch, steam]) {
      expect(code).not.toContain('__EDITION__');
      // The Standard archives are wired in both editions.
      expect(code).toContain(RECORDS_STORAGE_KEY);
    }
    expect(itch).not.toContain(CONTRACT_PROGRESS_STORAGE_KEY);
    expect(steam).toContain(CONTRACT_PROGRESS_STORAGE_KEY);
    // The card's and the report band's words exist only in the Steam bundle (the Contract ids themselves
    // are in both, as data).
    const { en, ko } = contractTextTables();
    const card = [en.contractsTitle, en.contractHoldName, en.contractsSwitch, ko.contractsTitle, ko.contractMasterName];
    const report = [en.reportCompleted, en.reportNotCompleted, en.conditionSummit, en.reportNotReached, ko.reportNotCompleted, ko.conditionNoSteep];
    for (const text of [...card, ...report]) {
      expect(itch, text).not.toContain(text);
      expect(steam, text).toContain(text);
    }
  }, 60_000);

  it('is read by the application wiring and the title / card drawing only, never by the game, its rules, the Contracts or the records', () => {
    const readers = fs
      .readdirSync(path.join(root, 'src'))
      .filter((f) => f.endsWith('.ts') && f !== 'edition.ts')
      .filter((f) => /['"]\.\/edition(\.[jt]s)?['"]/.test(read(`src/${f}`)));
    expect(readers).toEqual(['hud.ts', 'main.ts']);
  });

  it('leaves the build commands and the desktop packaging on the default (itch) build in dist/', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.build).toBe('tsc --noEmit && vite build');
    expect(scripts['build:steam']).toBe('tsc --noEmit && vite build --mode steam');
    for (const name of ['desktop:start', 'desktop:pack', 'desktop:zip']) {
      expect(scripts[name], name).toMatch(/^npm run build && /);
    }
    const builder = read('desktop/electron-builder.yml');
    expect(builder).toMatch(/^\s+- dist\/\*\*\/\*$/m);
    expect(builder).not.toContain('dist-steam');
    expect(read('desktop/main.js')).toContain("path.join(app.getAppPath(), 'dist')");
  });
});
