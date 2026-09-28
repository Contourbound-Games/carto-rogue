// Electron desktop shell for the Windows build. It serves the unchanged web build (dist/) from the
// fixed app://cartorogue origin and adds only what a desktop window needs: a stable identity for
// saved data, one window, no browser chrome, and no network access. The game code never learns it
// is running here.
import { app, BrowserWindow, Menu, protocol, screen, session } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_ENTRY_URL, APP_ID, APP_SCHEME, CONTENT_SECURITY_POLICY, isAppUrl, resolveAppFile } from './app-protocol.js';

const LOG_PREFIX = '[carto-rogue desktop]';

/** The game's own canvas size; the window opens at this content size when the screen allows. */
const GAME_WIDTH = 1280;
const GAME_HEIGHT = 800;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 400;
const BACKGROUND = '#1c1512';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** Permissions the page may use: its fullscreen button and the copy-seed / share buttons. */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

// Saved data (localStorage) lives in %APPDATA%\games.contourbound.cartorogue whatever the product
// name or install folder, so replacing the game folder with a newer build keeps every record.
// Must run before 'ready'.
app.setPath('userData', path.join(app.getPath('appData'), APP_ID));
app.setAppUserModelId(APP_ID);

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// Two copies would share one localStorage database; focus the running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start, (err) => {
    console.error(`${LOG_PREFIX} startup failed:`, err);
    app.exit(1);
  });
}

function start() {
  const distDir = path.join(app.getAppPath(), 'dist');
  const ses = session.defaultSession;

  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppFile(distDir, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(file);
      const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(body, {
        headers: { 'Content-Type': type, 'Content-Security-Policy': CONTENT_SECURITY_POLICY },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // The game is fully offline. Chromium's spellchecker would otherwise download a Hunspell dictionary
  // (e.g. ko-3-0.bdic) from Google on first run, outside the page's requests; the game has no text to check.
  ses.setSpellCheckerEnabled(false);
  ses.setSpellCheckerLanguages([]);
  // Refuse (and report) any page request that would leave the machine.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    console.warn(`${LOG_PREFIX} blocked network request: ${details.url}`);
    callback({ cancel: true });
  });
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  // No menu: this also removes the reload, zoom and developer-tools shortcuts.
  Menu.setApplicationMenu(null);
  createWindow();
}

/** Largest 16:10 content size up to the game's own size that fits the primary screen's work area. */
function initialContentSize() {
  const { width: areaW, height: areaH } = screen.getPrimaryDisplay().workAreaSize;
  // Leave room for the title bar and window frame.
  const fit = Math.min(1, (areaW - 32) / GAME_WIDTH, (areaH - 64) / GAME_HEIGHT);
  return {
    width: Math.max(MIN_WIDTH, Math.round(GAME_WIDTH * fit)),
    height: Math.max(MIN_HEIGHT, Math.round(GAME_HEIGHT * fit)),
  };
}

function createWindow() {
  const { width, height } = initialContentSize();
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: BACKGROUND,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  const wc = win.webContents;
  wc.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('render-process-gone', (_event, details) => console.error(`${LOG_PREFIX} renderer exited: ${details.reason}`));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.loadURL(APP_ENTRY_URL).catch((err) => console.error(`${LOG_PREFIX} could not load the game:`, err));
}

/**
 * How long the app outlives its closed window. The page records a left-behind expedition on
 * 'pagehide' while it unloads, and that localStorage write can still be on its way from the closing
 * renderer when the window is gone; quitting at once lost it now and then.
 */
const STORAGE_SETTLE_MS = 400;

// Closing the window ends the app: wait for the page's last writes, flush DOM storage to disk, quit.
app.on('window-all-closed', () => {
  setTimeout(() => {
    session.defaultSession.flushStorageData();
    app.quit();
  }, STORAGE_SETTLE_MS);
});
