/**
 * Окно Electron для мессенджера.
 * Разработка: ELECTRON_START_URL=http://127.0.0.1:5173 (Vite dev).
 * Прод: не file:// — у Chromium нет getDisplayMedia в небезопасном контексте; грузим app://root/ (privileged + secure).
 */
const { app, BrowserWindow, shell, protocol, ipcMain, session, Notification } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");

/** Windows: группировка тостов и иконка в центре уведомлений совпадают с ярлыком/установщиком */
if (process.platform === "win32") {
  app.setAppUserModelId("com.salesfactory.messenger");
}

const APP_HOST = "root";
const APP_ORIGIN = `app://${APP_HOST}`;

/** MIME для статики из dist */
function mimeForExt(ext) {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;

function distDir() {
  return path.join(__dirname, "..", "dist");
}

async function serveAppRequest(request) {
  let pathname = "";
  try {
    const u = new URL(request.url);
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  const base = path.resolve(distDir());
  const filePath = path.normalize(path.join(base, pathname));
  if (!filePath.startsWith(base + path.sep) && filePath !== base) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return new Response(data, {
      headers: {
        "Content-Type": mimeForExt(ext),
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

function windowIconPath() {
  const p = path.join(__dirname, "app-icon.png");
  return fsSync.existsSync(p) ? p : undefined;
}

function messengerChromeColors(theme) {
  if (theme === "light") {
    return { bg: "#d8dce8", border: "#8b6914" };
  }
  /** Как --tg-bg-app в тёмной теме (серо-коричневая палитра) */
  return { bg: "#0c0a09", border: "#3d3428" };
}

function applyWindowChrome(theme) {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  const { bg } = messengerChromeColors(theme);
  try {
    w.setBackgroundColor(bg);
  } catch {
    /* ignore */
  }
}

function createWindow() {
  const initialChrome = messengerChromeColors("dark");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 400,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: "Sales factory",
    icon: windowIconPath(),
    backgroundColor: initialChrome.bg,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  const sess = mainWindow.webContents.session;
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    if (
      permission === "media" ||
      permission === "display-capture" ||
      permission === "audioCapture" ||
      permission === "videoCapture" ||
      permission === "notifications"
    ) {
      callback(true);
      return;
    }
    callback(false);
  });

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (url.startsWith("file:") || url.startsWith("app:")) return { action: "deny" };
      void shell.openExternal(url);
    } catch (e) {
      console.error(e);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.on("electron:open-external", (_e, payload) => {
  const url = String(payload?.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return;
  try {
    void shell.openExternal(url);
  } catch (e) {
    console.error("electron:open-external", e);
  }
});

ipcMain.on("bring-to-front", () => {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});

ipcMain.on("electron:set-window-chrome", (_e, payload) => {
  const t = payload && typeof payload.theme === "string" ? payload.theme : "dark";
  applyWindowChrome(t === "light" ? "light" : "dark");
});

/** Тосты Windows: в рендерере new Notification() часто не показывается — шлём из main. */
ipcMain.on("electron:show-notification", (_e, payload) => {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  try {
    if (typeof Notification.isSupported === "function" && !Notification.isSupported()) return;
    const title = String(payload?.title ?? "Sales factory").slice(0, 200);
    const body = String(payload?.body ?? "").slice(0, 500);
    const icon = windowIconPath();
    const n = new Notification({
      title,
      body,
      ...(icon ? { icon } : {}),
    });
    n.on("click", () => {
      if (w.isDestroyed()) return;
      try {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      } catch {
        /* ignore */
      }
      try {
        w.webContents.send("electron:native-notification-action", {
          chatKey: typeof payload?.chatKey === "string" ? payload.chatKey : null,
          fromUserId: typeof payload?.fromUserId === "string" ? payload.fromUserId : null,
        });
      } catch {
        /* ignore */
      }
    });
    n.show();
  } catch (err) {
    console.error("electron:show-notification", err);
  }
});

app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      if (permission === "notifications") return true;
      return null;
    });
  } catch {
    /* ignore */
  }
  if (!process.env.ELECTRON_START_URL) {
    protocol.handle("app", serveAppRequest);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
