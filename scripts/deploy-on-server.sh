#!/usr/bin/env bash
# Запуск на VPS из каталога репозитория (после git pull).
# Путь по умолчанию — /var/www/messenger; переопределить: DEPLOY_ROOT=/path/to/messenger ./deploy-on-server.sh
set -euo pipefail

ROOT="${DEPLOY_ROOT:-/var/www/messenger}"
cd "$ROOT"

echo "==> Deploy root: $ROOT"
echo "==> Git: $(git rev-parse --short HEAD) -> pull"
git fetch origin
git pull --ff-only origin main

echo "==> Backend deps (postinstall runs prisma generate)"
npm ci

echo "==> Prisma migrate"
npx prisma migrate deploy

echo "==> Backend build"
npm run build

echo "==> Web"
cd "$ROOT/web"
npm ci
npm run build

echo "==> Установщики для /files/*.apk (если лежат в web/public/files — скопировать в корень public/files для Node)"
if [[ -f "$ROOT/web/public/files/app-release.apk" && ! -f "$ROOT/public/files/app-release.apk" ]]; then
  mkdir -p "$ROOT/public/files"
  cp -f "$ROOT/web/public/files/app-release.apk" "$ROOT/public/files/" || true
fi
if [[ -f "$ROOT/web/public/files/Messenger-Setup.exe" && ! -f "$ROOT/public/files/Messenger-Setup.exe" ]]; then
  mkdir -p "$ROOT/public/files"
  cp -f "$ROOT/web/public/files/Messenger-Setup.exe" "$ROOT/public/files/" || true
fi

echo "==> Restart services (need sudo without password or run script as root)"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart messenger || true
  sudo systemctl reload nginx || true
fi

echo "==> Done"
