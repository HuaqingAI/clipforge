const { contextBridge, ipcRenderer } = require("electron");

function storage(operation, ...arguments_) {
  const result = ipcRenderer.sendSync("clipforge:storage", operation, ...arguments_);
  if (!result?.ok) throw new Error(result?.error || "客户端配置不可用。");
  return result.value;
}

contextBridge.exposeInMainWorld("clipforge", Object.freeze({
  storage: Object.freeze({
    getItem: (key) => storage("getItem", key),
    setItem: (key, value) => storage("setItem", key, value),
    removeItem: (key) => storage("removeItem", key),
    keys: () => storage("keys"),
  }),
}));
