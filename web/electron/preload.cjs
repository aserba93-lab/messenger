const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronShell", {
  isElectron: true,
  platform: process.platform,
  /** Поднять окно поверх других (уведомления OS / клик по тосту). */
  focusAppWindow: () => {
    ipcRenderer.send("bring-to-front");
  },
  /** Синхронизировать цвет рамки окна Windows с темой приложения. */
  setWindowChrome: (theme) => {
    ipcRenderer.send("electron:set-window-chrome", { theme });
  },
});
