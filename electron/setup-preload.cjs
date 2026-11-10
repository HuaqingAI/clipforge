const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipforgeSetup", Object.freeze({
  ready: () => ipcRenderer.send("clipforge:setup-ready"),
  retry: () => ipcRenderer.send("clipforge:setup-retry"),
  cancel: () => ipcRenderer.send("clipforge:setup-cancel"),
  reportError: (message) => ipcRenderer.send("clipforge:setup-error", String(message).slice(0, 2000)),
  onProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("clipforge:setup-progress", listener);
    return () => ipcRenderer.removeListener("clipforge:setup-progress", listener);
  },
}));
