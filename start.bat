@echo off
rem Kamishibai launcher for running from the source code (Windows).
rem End users should use the packaged desktop app (npm run dist builds it with Tauri).
rem This starts the browser version: Node.js + the default browser (kamishibai serve).
rem Keep this file ASCII-only: cmd.exe reads .bat files in the console code page.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install the LTS version from https://nodejs.org/
  pause
  exit /b 1
)
echo Kamishibai is running in your browser. Close this window to stop it.
node bin\kamishibai.js serve %*
if errorlevel 1 pause
