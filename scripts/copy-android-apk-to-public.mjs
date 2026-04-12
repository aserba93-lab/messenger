#!/usr/bin/env node
/**
 * Копирует собранный APK в web/public/files/app-release.apk для выкладки на сервер
 * (Vite копирует public/ → dist при сборке; бэкенд отдаёт из public/files или PUBLIC_INSTALLERS_DIR).
 *
 * Источник (первый существующим):
 *   1) web/android/app/build/outputs/apk/debug/app-debug.apk
 *   2) web/dist/files/app-debug.apk
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const candidates = [
  path.join(root, "web", "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
  path.join(root, "web", "dist", "files", "app-debug.apk"),
];
/** Фронт (Vite): web/public → dist/files. Бэкенд по умолчанию: корень репозитория public/files (см. dist/server.js). */
const destDirs = [
  path.join(root, "web", "public", "files"),
  path.join(root, "public", "files"),
];
const fileName = "app-release.apk";

let src = null;
for (const p of candidates) {
  if (existsSync(p) && statSync(p).isFile()) {
    src = p;
    break;
  }
}
if (!src) {
  console.error(
    "Не найден APK. Соберите: cd web && npm run android:apk:debug\nили положите app-debug.apk в web/dist/files/",
  );
  process.exit(1);
}
let lastDest = null;
for (const destDir of destDirs) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, fileName);
  copyFileSync(src, dest);
  lastDest = dest;
}
const mb = (statSync(lastDest).size / (1024 * 1024)).toFixed(1);
console.log(`OK: ${path.relative(root, src)} → web/public/files и public/files (${mb} MB)`);
