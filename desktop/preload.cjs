/** The desktop shell's few calls, handed to the page (sandboxed preload: `contextBridge` and `ipcRenderer` only). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roadcraftDesktop', {
  state: () => ipcRenderer.invoke('desktop:state'),
  set: (patch) => ipcRenderer.invoke('desktop:set', patch),
  unlock: (id) => ipcRenderer.invoke('steam:unlock', id),
  cloudWrite: (name, text) => ipcRenderer.invoke('steam:cloud-write', name, text),
  cloudRead: (name) => ipcRenderer.invoke('steam:cloud-read', name),
});
