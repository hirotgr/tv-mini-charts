const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("appApi", {
  getDefaults: () => ipcRenderer.invoke("defaults:get"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (config) => ipcRenderer.invoke("config:set", config),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("window:setAlwaysOnTop", value),
});
