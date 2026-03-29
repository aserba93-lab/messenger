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

echo "==> Restart services (need sudo without password or run script as root)"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart messenger || true
  sudo systemctl reload nginx || true
fi

echo "==> Done"
