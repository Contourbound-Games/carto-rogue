// Editions (src/edition.ts): the itch.io and Steam builds differ only by the build mode. The default build
// is itch, into dist/; `--mode steam` is Steam, into dist-steam/. Built bundles are checked in memory (nothing
// is written): only the Steam bundle wires Survey Contract progress. Only the application wiring reads the
// edition. The desktop shell is packaged once per edition: desktop:pack / desktop:zip from dist/,
// desktop:pack:steam / desktop:zip:steam from dist-steam/ (each package holds exactly one web build).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { STEAM_RENDERER_DIR, requireSteamRenderer } from '../desktop/steam-renderer.js';
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

  it('wires Survey Contract progress, the Contract card, the report band and the Contract share into the Steam bundle only', async () => {
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
    // The Contract share's own words (sentence case: the card and the report band are upper case, and
    // the Korean share words are all also report words).
    const share = [en.shareSurveyContract, en.shareNotCompleted];
    for (const text of [...card, ...report, ...share]) {
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

  it('leaves the build commands and the itch desktop packaging on the default (itch) build in dist/', () => {
    const scripts = packageScripts();
    expect(scripts.build).toBe('tsc --noEmit && vite build');
    expect(scripts['build:steam']).toBe('tsc --noEmit && vite build --mode steam');
    for (const name of ['desktop:start', 'desktop:pack', 'desktop:zip']) {
      expect(scripts[name], name).toMatch(/^npm run build && /);
    }
    expect(scripts['desktop:pack']).toBe('npm run build && electron-builder --config desktop/electron-builder.yml --dir');
    expect(scripts['desktop:zip']).toBe('npm run build && electron-builder --config desktop/electron-builder.yml');
    const itch = builderSettings('desktop/electron-builder.yml');
    expect(itch).toContain('  - dist/**/*');
    expect(itch.join('\n')).not.toContain('dist-steam');
    // The shell serves whatever the package holds as dist/; it never chooses an edition itself.
    expect(read('desktop/main.js')).toContain("path.join(app.getAppPath(), 'dist')");
    expect(read('desktop/main.js')).not.toContain('dist-steam');
  });

  it('packages the Steam desktop build from the Steam build only, in the same shell', () => {
    const scripts = packageScripts();
    expect(scripts['desktop:pack:steam']).toBe('npm run build:steam && electron-builder --config desktop/electron-builder.steam.yml --dir');
    expect(scripts['desktop:zip:steam']).toBe('npm run build:steam && electron-builder --config desktop/electron-builder.steam.yml');
    // Every packaging command builds its own edition first, and only with its own config.
    for (const [name, command] of Object.entries(scripts)) {
      if (command.includes('electron-builder.steam.yml')) expect(command, name).toMatch(/^npm run build:steam && electron-builder /);
      else if (command.includes('electron-builder')) expect(command, name).toMatch(/^npm run build && electron-builder --config desktop\/electron-builder\.yml\b/);
    }
    // The Steam config is the itch one, setting for setting, except for what it packages as dist/ (the
    // Steam build, guarded by the hook), where it writes and what its zip is called.
    const steam = builderSettings('desktop/electron-builder.steam.yml');
    const expected = builderSettings('desktop/electron-builder.yml').flatMap((line) => {
      if (line === '  output: release') return ['  output: release/steam'];
      if (line === '  - dist/**/*') return ['  - from: dist-steam', '    to: dist'];
      if (line === 'asar: true') return ['beforePack: ./desktop/steam-renderer.js', line];
      if (line.startsWith('  artifactName: ')) return [line.replace('.${ext}', '-steam.${ext}')];
      return [line];
    });
    expect(steam).toEqual(expected);
    expect(steam).not.toContain('  - dist/**/*');
  });

  it('refuses to package the Steam desktop build without the Steam build, never taking the itch one instead', async () => {
    const steamOutDir = (await resolveConfig({ root, configFile, mode: 'steam' }, 'build')).build.outDir;
    expect(STEAM_RENDERER_DIR).toBe(path.relative(root, path.resolve(root, steamOutDir)));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-steam-renderer-'));
    try {
      expect(() => requireSteamRenderer(scratch)).toThrow(/npm run build:steam/);
      fs.mkdirSync(path.join(scratch, 'dist'));
      fs.writeFileSync(path.join(scratch, 'dist', 'index.html'), '');
      expect(() => requireSteamRenderer(scratch)).toThrow(/dist-steam/);
      fs.mkdirSync(path.join(scratch, STEAM_RENDERER_DIR));
      fs.writeFileSync(path.join(scratch, STEAM_RENDERER_DIR, 'index.html'), '');
      expect(() => requireSteamRenderer(scratch)).not.toThrow();
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

function packageScripts(): Record<string, string> {
  return (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
}

/** An electron-builder YAML config's setting lines, comments and blank lines left out. */
function builderSettings(relative: string): string[] {
  return read(relative)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}
