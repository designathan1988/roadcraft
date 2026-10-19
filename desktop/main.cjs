/** ROADCRAFT ON THE DESKTOP: the production build */
const { app, BrowserWindow, MessageChannelMain, ipcMain, protocol, net, shell, utilityProcess } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout, clearTimeout } = require('node:timers');
const ISOLATED = require('./isolation.cjs');

// The player's folder named here, not by the package's name: the saves' place is what Steam Auto-Cloud is told (`scripts/package-desktop.mjs`).
app.setPath('userData', path.join(app.getPath('appData'), 'Roadcraft'));
/** XDG data home (XDG Base Directory spec: ignored unless absolute), the Linux root Steam Auto-Cloud offers (`LinuxXdgDataHome`). */
const xdgDataHome = () => (path.isAbsolute(process.env.XDG_DATA_HOME ?? '') ? process.env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share'));
/** The map's files, synced by Steam Auto-Cloud: `%APPDATA%/Roadcraft/saves` (root `WinAppDataRoaming`), `$XDG_DATA_HOME/Roadcraft/saves` on Linux (Electron's userData there is the config home, which Auto-Cloud has no root for). */
const SAVES = process.platform === 'linux' ? path.join(xdgDataHome(), 'Roadcraft', 'saves') : path.join(app.getPath('userData'), 'saves');

app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// The compiled programs kept on disk between runs (Chromium `--gpu-disk-cache-size-kb`, default 6 MB on desktop, `gpu_preferences.cc`): the game's set must fit or the next start compiles again.
app.commandLine.appendSwitch('gpu-disk-cache-size-kb', String(256 * 1024));
// The old space grown by its own size at each step rather than V8's guess (`--heap-growing-percent`, V8 flags; the best of the conf116-120 runs): fewer collections for the same peak.
app.commandLine.appendSwitch('js-flags', '--heap-growing-percent=100');

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

/** Steam, when the game was started by it (steamworks.js, optional, in this process only): achievements and overlay; the saves reach Steam Cloud by Auto-Cloud (`SAVES`). Without it the game runs as it is. */
const steam = (() => {
  if (process.env.ROADCRAFT_NO_STEAM === '1') return null;
  let steamworks;
  try {
    steamworks = require('steamworks.js');
  } catch {
    return null;
  }
  try {
    // `steam_appid.txt` beside the executable outside Steam (the packer writes it, the depots leave it out); under Steam, the id Steam starts the game with (steamworks.js README).
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
  // `codeCache`: V8 keeps the compiled scripts between runs (Electron `CustomScheme`, needs `standard`).
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true } },
]);

/** The built game: beside the executable when packaged, `dist/` when run from the project. */
const GAME = app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://roadcraft/';

/** A run of `scripts/look.mjs --electron`: the window never shown, the game drawn at 1920x1080 all the same (`paintWhenInitiallyHidden`). */
const LOOK = process.env.ROADCRAFT_LOOK === '1';

function createWindow() {
  const window = new BrowserWindow({
    width: LOOK ? 1920 : 1600,
    height: LOOK ? 1080 : 900,
    useContentSize: LOOK,
    show: false,
    paintWhenInitiallyHidden: true,
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
  // DO NOT let the page draw minimized: with `backgroundThrottling: false` the page stays visible to the Page Visibility API (Electron, WebPreferences), its own guards never fire (AST-03). The page told when the window is out of sight and back (`src/desktopShown.ts`).
  const tellShown = (shown) => { if (!window.isDestroyed()) window.webContents.send('desktop:shown', shown); };
  window.on('minimize', () => tellShown(false));
  window.on('hide', () => tellShown(false));
  window.on('restore', () => tellShown(true));
  window.on('show', () => tellShown(true));
  window.once('ready-to-show', () => {
    if (LOOK) return;
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
  // A long job worker's own line to a thread of a job process (`jobs.cjs`, `src/desktopJobs.ts`), as the saves' is: the processes taken in turn.
  ipcMain.on('jobs:connect', (event) => {
    if (!fromGame(event) || !event.senderFrame) return;
    const at = nextJobs++ % JOB_PROCESSES;
    const { port1, port2 } = new MessageChannelMain();
    jobsProcess(at).postMessage(null, [port2]);
    event.senderFrame.postMessage('jobs:port', at, [port1]);
  });
  // The page's own line to the saves' writer (Electron, "MessagePorts": a `MessageChannelMain` between the page and a utility process; nothing of a save passes through here).
  ipcMain.on('saves:connect', (event) => {
    if (!fromGame(event) || !event.senderFrame) return;
    const { port1, port2 } = new MessageChannelMain();
    savesWriter().postMessage(null, [port2]);
    event.senderFrame.postMessage('saves:port', null, [port1]);
  });
}

/** THE JOB PROCESSES (`jobs.cjs`): the page's long job workers (the tiles' maker, the growth) as threads of utility processes, each process a V8 cage of its own (Electron `utilityProcess`; V8 pointer compression, one cage a process): a 20 km map's tile workers no longer fill the page's. Two, the long workers shared between them. */
const JOB_PROCESSES = 2;
/** The job threads' code, built for Node beside the game (`scripts/vite/desktop-jobs.config.ts`). */
const JOB_HOST = path.join(GAME, 'desktop-jobs', 'jobHost.mjs');
const jobs = [];
let nextJobs = 0;
function jobsProcess(at) {
  if (jobs[at]) return jobs[at];
  const child = utilityProcess.fork(path.join(__dirname, 'jobs.cjs'), [JOB_HOST], { serviceName: `Roadcraft jobs ${at + 1}` });
  // Gone (a crash, a cage full): each page's workers in it fail as workers do, and the pool makes others (`src/desktopJobs.ts`).
  child.once('exit', (code) => {
    console.error(`job process ${at + 1} stopped`, code);
    if (jobs[at] === child) jobs[at] = null;
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('jobs:lost', at);
  });
  jobs[at] = child;
  return child;
}

/** The saves' writer (`saves.cjs`): a Node utility process, so a big map's encoding and disk writes stop neither this process nor the page. */
let saves = null;
function savesWriter() {
  if (saves) return saves;
  const child = utilityProcess.fork(path.join(__dirname, 'saves.cjs'), [SAVES], { serviceName: 'Roadcraft saves' });
  // Gone (a crash): each page drops its waiting requests and connects again (`src/desktopSaves.ts`).
  child.once('exit', (code) => {
    console.error('the saves writer stopped', code);
    if (saves === child) saves = null;
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('saves:lost');
  });
  saves = child;
  return child;
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
    const file = path.resolve(GAME, decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html');
    // Nothing outside the game's folder (Electron `protocol.handle` example: the path relative to the bundle, never `..` nor absolute).
    const inside = path.relative(GAME, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return new Response('forbidden', { status: 403 });
    let response;
    try {
      response = await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('not found', { status: 404, headers: ISOLATED });
    }
    // Cross-origin isolated with the Vite server's own headers (`isolation.cjs`): SharedArrayBuffer for the simulation's worker.
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(ISOLATED)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  serveIpc();
  createWindow();
  // A run of `look.mjs --electron`: every process's memory each 5 s, the job processes by name (Electron `app.getAppMetrics`: working set and private bytes, KB).
  if (LOOK) setInterval(() => {
    const rows = app.getAppMetrics().map((m) => `${m.serviceName || m.name || m.type}=${Math.round(m.memory.workingSetSize / 1024)}/${Math.round((m.memory.privateBytes ?? 0) / 1024)}`);
    console.log(`[metrics] ${rows.join(' ')}`);
  }, 5000).unref();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
/** How long the exit waits for the saves' writer to finish what it was asked (the page waits as long for its own writes, `main.ts` saveOnClose). */
const QUIT_WAIT_MS = 8000;
let savesDrained = false;
// DO NOT exit with writes still queued in the saves' writer: asked to finish them once every window is closed (Electron `will-quit`, after the pages' own last writes; `before-quit` comes before a page's `beforeunload` and its writes), then the exit goes on.
app.on('will-quit', (event) => {
  if (savesDrained || !saves) return;
  event.preventDefault();
  const child = saves;
  let timer = null;
  const onMessage = (message) => { if (message?.drained) done(); };
  const done = () => {
    if (savesDrained) return;
    savesDrained = true;
    child.off('message', onMessage);
    child.off('exit', done);
    clearTimeout(timer);
    app.quit();
  };
  child.on('message', onMessage);
  child.once('exit', done);
  timer = setTimeout(done, QUIT_WAIT_MS);
  child.postMessage({ op: 'drain' });
});
