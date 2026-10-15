/** ROADCRAFT ON THE DESKTOP: the production build */
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
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
