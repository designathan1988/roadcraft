/** The desktop shell's few calls, handed to the page (sandboxed preload: `contextBridge` and `ipcRenderer` only). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roadcraftDesktop', {
  state: () => ipcRenderer.invoke('desktop:state'),
  set: (patch) => ipcRenderer.invoke('desktop:set', patch),
  unlock: (id) => ipcRenderer.invoke('steam:unlock', id),
  // The saves' port arrives as a window message (`src/desktopSaves.ts`): a port cannot cross `contextBridge`.
  connectSaves: () => ipcRenderer.send('saves:connect'),
  // A long job worker's port in a job process (`src/desktopJobs.ts`), handed on as the saves' is.
  connectJobs: () => ipcRenderer.send('jobs:connect'),
});

// Electron, "MessagePorts", main world of a context-isolated page: the port handed on with `window.postMessage`, the page checks the source is its own window.
ipcRenderer.on('saves:port', (event) => window.postMessage('roadcraft:saves-port', '*', event.ports));
ipcRenderer.on('saves:lost', () => window.postMessage('roadcraft:saves-lost', '*'));
// The window minimized or hidden, and back (`desktop/main.cjs`): the page stops drawing and saves, as a hidden tab does (`src/desktopShown.ts`).
ipcRenderer.on('desktop:shown', (event, shown) => window.postMessage({ roadcraftShown: shown === true }, '*'));
ipcRenderer.on('jobs:port', (event, process) => window.postMessage({ roadcraftJobsPort: process }, '*', event.ports));
ipcRenderer.on('jobs:lost', (event, process) => window.postMessage({ roadcraftJobsLost: process }, '*'));
