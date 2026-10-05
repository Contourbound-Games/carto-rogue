// The Steam desktop package's renderer: the Steam web build (dist-steam/, from `npm run build:steam`),
// packaged as the app's dist/ so desktop/main.js serves it unchanged. electron-builder.steam.yml runs
// this before packaging: without the Steam build there is nothing to package, and electron-builder
// would otherwise produce a window with no game in it.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Steam web build, relative to the repository root (vite.config.ts, `--mode steam`). */
export const STEAM_RENDERER_DIR = 'dist-steam';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Throw unless `rootDir` holds a Steam web build to package. */
export function requireSteamRenderer(rootDir) {
  const entry = path.join(rootDir, STEAM_RENDERER_DIR, 'index.html');
  if (!existsSync(entry)) {
    throw new Error(`The Steam desktop package needs the Steam web build, but ${entry} is missing. Run npm run build:steam first.`);
  }
}

/** electron-builder beforePack hook. */
export function beforePack() {
  requireSteamRenderer(repoRoot);
}
