import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENTRY_URL, APP_ID, APP_ORIGIN, isAppUrl, resolveAppFile } from '../desktop/app-protocol.js';

const root = path.resolve('dist');

describe('desktop app identity', () => {
  it('keeps the saved-data identity fixed', () => {
    // localStorage is keyed by the origin and stored under the app ID: changing either orphans records.
    expect(APP_ID).toBe('games.contourbound.cartorogue');
    expect(APP_ORIGIN).toBe('app://cartorogue');
    expect(APP_ENTRY_URL).toBe('app://cartorogue/index.html');
  });
});

describe('isAppUrl', () => {
  it('accepts only the app origin', () => {
    expect(isAppUrl('app://cartorogue/index.html')).toBe(true);
    expect(isAppUrl('app://cartorogue/assets/index.js?x=1#y')).toBe(true);
    expect(isAppUrl('app://other/index.html')).toBe(false);
    expect(isAppUrl('https://carto-studio.itch.io/the-carto-rogue')).toBe(false);
    expect(isAppUrl('file:///C:/Windows/win.ini')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
  });
});

describe('resolveAppFile', () => {
  it('maps app URLs to files inside the web build', () => {
    expect(resolveAppFile(root, 'app://cartorogue/')).toBe(path.join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://cartorogue/index.html?debug')).toBe(path.join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://cartorogue/assets/Galmuri9-X.woff2')).toBe(path.join(root, 'assets', 'Galmuri9-X.woff2'));
    expect(resolveAppFile(root, 'app://cartorogue/THIRD_PARTY_NOTICES.md')).toBe(path.join(root, 'THIRD_PARTY_NOTICES.md'));
  });

  it('never resolves outside the web build', () => {
    const insideRoot = (file: string | null): boolean => {
      if (file === null) return true;
      const rel = path.relative(root, file);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    for (const url of [
      'app://cartorogue/../package.json',
      'app://cartorogue/%2e%2e/package.json',
      'app://cartorogue/assets/..%2f..%2fpackage.json',
      'app://cartorogue/..%5C..%5Cpackage.json',
      'app://cartorogue/C:%5CWindows%5Cwin.ini',
      'app://cartorogue/%5C%5Cserver%5Cshare%5Cfile',
      'app://cartorogue/index.html%00.js',
      'app://cartorogue/%E0%A4%A',
      'app://elsewhere/index.html',
      'https://cartorogue/index.html',
    ]) {
      expect(insideRoot(resolveAppFile(root, url)), url).toBe(true);
    }
    expect(resolveAppFile(root, 'app://cartorogue/..%5C..%5Cpackage.json')).toBeNull();
    expect(resolveAppFile(root, 'app://cartorogue/C:%5CWindows%5Cwin.ini')).toBeNull();
    expect(resolveAppFile(root, 'app://cartorogue/index.html%00.js')).toBeNull();
    expect(resolveAppFile(root, 'app://cartorogue/%E0%A4%A')).toBeNull();
    expect(resolveAppFile(root, 'app://elsewhere/index.html')).toBeNull();
  });
});
