@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed or not on PATH.
  echo   Install the LTS version from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)
echo Starting Stremio Watch History Importer...  (a browser tab will open)
start "" "http://127.0.0.1:8787"
node server.mjs
pause
