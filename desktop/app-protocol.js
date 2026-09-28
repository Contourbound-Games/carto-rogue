// The fixed app:// origin the desktop shell serves the web build from, and the request -> file
// mapping behind it. Kept free of Electron imports so the tests can exercise it under plain Node.
//
// The origin (scheme + host) is part of the app's identity: localStorage (records, language, mute)
// is keyed by it, so changing APP_SCHEME or APP_HOST in an update would orphan every saved record.
import path from 'node:path';

/** Reverse-DNS application ID: Windows AppUserModelID, userData folder name, electron-builder appId. */
export const APP_ID = 'games.contourbound.cartorogue';
export const APP_SCHEME = 'app';
export const APP_HOST = 'cartorogue';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/**
 * Content-Security-Policy sent with every page: the game only ever loads its own files. Inline styles
 * stay allowed for the <style> block in index.html and the seed dialog; data: images for the inline
 * favicon.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** True when `url` belongs to the app origin (navigation inside the game is allowed, nothing else). */
export function isAppUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the file under `rootDir` that an app:// request asks for, or null when the URL is
 * not on the app origin or points outside `rootDir` (traversal, other drives, NUL bytes).
 * The query string and fragment are ignored; "/" serves index.html.
 */
export function resolveAppFile(rootDir, requestUrl) {
  if (!isAppUrl(requestUrl)) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const relative = pathname.replace(/^[/\\]+/, '') || 'index.html';
  const root = path.resolve(rootDir);
  const file = path.resolve(root, relative);
  const rel = path.relative(root, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}
