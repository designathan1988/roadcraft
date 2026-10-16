/** ROADCRAFT ON THE DESKTOP: the production build */
const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// The compiled programs kept on disk between runs (Chromium `--gpu-disk-cache-size-kb`, default 6 MB on desktop, `gpu_preferences.cc`): the game's set must fit or the next start compiles again.
app.commandLine.appendSwitch('gpu-disk-cache-size-kb', String(256 * 1024));

/** The player's desktop choices that must be known before the window exists (`desktop-settings.json` in userData). */
const SETTINGS_FILE = path.join(app.getPath('userData'), 'desktop-settings.json');
const DEFAULT_SETTINGS = { vsync: true, fullscreen: false };
function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { vsync: raw.vsync !== false, fullscreen: raw.fullscreen === true };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
const settings = readSettings();
function writeSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
  } catch (error) {
    console.error('desktop settings not written', error);
  }
}
// VSync off: frames as fast as the GPU draws them (Chromium `--disable-gpu-vsync`, `--disable-frame-rate-limit`); read at start, so a change waits for the next one.
if (!settings.vsync) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}

/** The App ID in `steam_appid.txt` beside the executable, or undefined (the working folder Steam's own lookup reads is not always that one). */
function appIdBesideExe() {
  try {
    const id = Number(fs.readFileSync(path.join(path.dirname(process.execPath), 'steam_appid.txt'), 'utf8').trim());
    return Number.isInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Steam, when the game was started by it (steamworks.js, optional): achievements, cloud, overlay. Without it the game runs as it is. */
const steam = (() => {
  if (process.env.ROADCRAFT_NO_STEAM === '1') return null;
  let steamworks;
  try {
    steamworks = require('steamworks.js');
  } catch {
    return null;
  }
  try {
    // `steam_appid.txt` beside the executable (the packer writes it); without it, the id Steam starts the game with (steamworks.js README).
    const client = steamworks.init(appIdBesideExe());
    // The overlay draws into the window: steamworks.js adds `in-process-gpu` and `disable-direct-composition` and repaints each frame.
    if (process.env.ROADCRAFT_NO_OVERLAY !== '1') steamworks.electronEnableSteamOverlay();
    return client;
  } catch (error) {
    console.warn('Steam not available, playing without it:', error instanceof Error ? error.message : error);
    return null;
  }
})();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

/** The built game: beside the executable when packaged, `dist/` when run from the project. */
const GAME = app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://roadcraft/';

function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    backgroundColor: '#10161c',
    title: 'Roadcraft',
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  window.once('ready-to-show', () => {
    window.maximize();
    if (settings.fullscreen) window.setFullScreen(true);
    window.show();
  });
  // Links out of the game open in the system browser, never in the game's window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('app://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // F11 full screen, F12 the developer tools (to read the console or profile).
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { window.setFullScreen(!window.isFullScreen()); event.preventDefault(); }
    if (input.key === 'F12') { window.webContents.toggleDevTools(); event.preventDefault(); }
  });
  // Full screen kept for the next start, however it was reached (F11, the options, the page's own request).
  const keepFullscreen = () => {
    if (settings.fullscreen === window.isFullScreen()) return;
    settings.fullscreen = window.isFullScreen();
    writeSettings();
  };
  window.on('enter-full-screen', keepFullscreen);
  window.on('leave-full-screen', keepFullscreen);
  void window.loadURL(`${ORIGIN}index.html`);
}

/** Only the game's own page may ask (Electron security checklist: validate the sender of every IPC message). */
const fromGame = (event) => typeof event.senderFrame?.url === 'string' && event.senderFrame.url.startsWith(ORIGIN);
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function serveIpc() {
  ipcMain.handle('desktop:state', (event) => {
    if (!fromGame(event)) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    return {
      vsync: settings.vsync,
      fullscreen: window ? window.isFullScreen() : settings.fullscreen,
      steam: steam !== null,
      steamDeck: steam ? safe(() => steam.utils.isSteamRunningOnSteamDeck(), false) : false,
    };
  });
  ipcMain.handle('desktop:set', (event, patch) => {
    if (!fromGame(event) || !patch || typeof patch !== 'object') return false;
    if (typeof patch.vsync === 'boolean') settings.vsync = patch.vsync;
    if (typeof patch.fullscreen === 'boolean') {
      settings.fullscreen = patch.fullscreen;
      BrowserWindow.fromWebContents(event.sender)?.setFullScreen(patch.fullscreen);
    }
    writeSettings();
    return true;
  });
  ipcMain.handle('steam:unlock', (event, id) => {
    if (!fromGame(event) || !steam || typeof id !== 'string' || !NAME.test(id)) return false;
    return safe(() => steam.achievement.isActivated(id) || steam.achievement.activate(id), false);
  });
  ipcMain.handle('steam:cloud-write', (event, name, text) => {
    if (!fromGame(event) || !steam || typeof name !== 'string' || !NAME.test(name) || typeof text !== 'string') return false;
    return safe(() => steam.cloud.isEnabledForApp() && steam.cloud.writeFile(name, text), false);
  });
  ipcMain.handle('steam:cloud-read', (event, name) => {
    if (!fromGame(event) || !steam || typeof name !== 'string' || !NAME.test(name)) return null;
    return safe(() => (steam.cloud.isEnabledForApp() && steam.cloud.fileExists(name) ? steam.cloud.readFile(name) : null), null);
  });
}

function safe(run, fallback) {
  try {
    return run();
  } catch (error) {
    console.warn('Steam call failed', error);
    return fallback;
  }
}

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(GAME, relative));
    // Nothing outside the game's folder.
    if (!file.startsWith(GAME)) return new Response('forbidden', { status: 403 });
    const response = await net.fetch(pathToFileURL(file).toString());
    // Cross-origin isolated, as the Vite server serves it: SharedArrayBuffer for the simulation's worker.
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  serveIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
