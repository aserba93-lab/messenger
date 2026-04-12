#!/usr/bin/env bash
# Пример: залить установщики на VPS (после локального node scripts/copy-android-apk-to-public.mjs).
# Настройте переменные и выполните на машине, где есть ssh и файлы.
set -euo pipefail

: "${DEPLOY_USER:?задайте DEPLOY_USER}"
: "${DEPLOY_HOST:?задайте DEPLOY_HOST}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/messenger/public/files}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/copy-android-apk-to-public.mjs

if [[ -f "$ROOT/web/public/files/app-release.apk" ]]; then
  scp "$ROOT/web/public/files/app-release.apk" "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE_DIR}/"
fi
if [[ -f "$ROOT/web/public/files/Messenger-Setup.exe" ]]; then
  scp "$ROOT/web/public/files/Messenger-Setup.exe" "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE_DIR}/"
fi

echo "Готово. На сервере: sudo systemctl restart messenger"
ssh "${DEPLOY_USER}@${DEPLOY_HOST}" "ls -la ${REMOTE_DIR}/app-release.apk ${REMOTE_DIR}/Messenger-Setup.exe 2>/dev/null || true"
