/** The desktop shell's few calls, handed to the page (sandboxed preload: `contextBridge` and `ipcRenderer` only). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roadcraftDesktop', {
  state: () => ipcRenderer.invoke('desktop:state'),
  set: (patch) => ipcRenderer.invoke('desktop:set', patch),
  unlock: (id) => ipcRenderer.invoke('steam:unlock', id),
  // The saves' port arrives as a window message (`src/desktopSaves.ts`): a port cannot cross `contextBridge`.
  connectSaves: () => ipcRenderer.send('saves:connect'),
});

// Electron, "MessagePorts", main world of a context-isolated page: the port handed on with `window.postMessage`, the page checks the source is its own window.
ipcRenderer.on('saves:port', (event) => window.postMessage('roadcraft:saves-port', '*', event.ports));
ipcRenderer.on('saves:lost', () => window.postMessage('roadcraft:saves-lost', '*'));
