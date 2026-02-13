const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("appApi", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (config) => ipcRenderer.invoke("config:set", config),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("window:setAlwaysOnTop", value),
});
