/**
 * ROADCRAFT ON THE DESKTOP: the production build (`npm run build`, `dist/`)
 * in a window of its own, with Electron's bundled Chromium.
 *
 * A wrapper adds no speed to WebGL by itself - Electron runs the same
 * Chromium and ANGLE as Chrome - so what this buys is what the browser tab
 * could not have: the built game (not the dev server), a window of its own
 * (not a pane shared with other tabs), the high-performance GPU forced on a
 * machine with two (Electron's `force_high_performance_gpu`), and no
 * throttling when the window is behind another.
 *
 * The files are served on a privileged custom scheme, `app://roadcraft/`, as
 * Electron's protocol docs recommend over `file://`: absolute asset paths
 * resolve, fetch and wasm work, and the saves (localStorage) keep one origin.
 */
const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

/** The built game: beside the executable when packaged, `dist/` when run from the project. */
const GAME = app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..', 'dist');

function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    backgroundColor: '#10161c',
    title: 'Roadcraft',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  window.once('ready-to-show', () => { window.maximize(); window.show(); });
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
  void window.loadURL('app://roadcraft/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(GAME, relative));
    // Nothing outside the game's folder.
    if (!file.startsWith(GAME)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
