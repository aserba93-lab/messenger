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
  /** Тост Windows из main process (в рендерере часто не показывается). */
  showNativeNotification: (payload) => {
    ipcRenderer.send("electron:show-notification", payload);
  },
  onNativeNotificationAction: (handler) => {
    const ch = "electron:native-notification-action";
    const fn = (_e, data) => handler(data);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
});
