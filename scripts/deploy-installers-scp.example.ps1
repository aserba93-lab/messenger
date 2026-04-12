# Пример: выгрузка app-release.apk на VPS (нужен OpenSSH Client: scp).
# Перед запуском: npm run installers:copy-apk
param(
  [string]$DeployUser = $env:DEPLOY_USER,
  [string]$DeployHost = $env:DEPLOY_HOST,
  [string]$RemoteDir = "/var/www/messenger/public/files"
)
$ErrorActionPreference = "Stop"
if (-not $DeployUser -or -not $DeployHost) {
  Write-Error "Задайте DEPLOY_USER и DEPLOY_HOST или параметры -DeployUser -DeployHost"
}
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not (Test-Path "$root\public\files\app-release.apk")) {
  Set-Location $root
  node scripts/copy-android-apk-to-public.mjs
}
$src = Join-Path $root "public\files\app-release.apk"
if (-not (Test-Path $src)) { Write-Error "Нет файла: $src" }
Write-Host "scp -> ${DeployUser}@${DeployHost}:${RemoteDir}/"
scp $src "${DeployUser}@${DeployHost}:${RemoteDir}/"
Write-Host "На сервере: sudo systemctl restart messenger"
