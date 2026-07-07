# deploy.ps1 — run ON THE SERVER (the always-on PC) to pull your latest
# changes and restart the scraper under PM2.
#
# Usage (from the wfm-live-scraper folder on the server):
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
#
# Workflow: edit on your PC -> git commit -> git push
#           then on the server: run this script.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "==> Pulling latest changes..." -ForegroundColor Cyan
git pull

Write-Host "==> Installing dependencies (in case package.json changed)..." -ForegroundColor Cyan
npm install

Write-Host "==> Restarting scraper under PM2..." -ForegroundColor Cyan
pm2 restart wfm-live-scraper --update-env
pm2 save

Write-Host "==> Done. Tailing logs (Ctrl+C to stop watching — scraper keeps running)." -ForegroundColor Green
pm2 logs wfm-live-scraper --lines 30
