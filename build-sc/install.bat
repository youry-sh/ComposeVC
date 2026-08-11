@echo off
setlocal EnableExtensions
title ComposeVC - First-time setup

rem This script prepares a FRESH Windows machine to run ComposeVC from source:
rem   - installs Node.js (and Go), then all npm libraries (web search, etc.)
rem It needs admin rights to install Node/Go system-wide.

rem --- project root = parent of this build-sc folder ---
cd /d "%~dp0.."
set "PROJ=%CD%"

rem --- elevate to admin (silent MSI installs need it) ---
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================================
echo   ComposeVC - first-time setup
echo   Project: %PROJ%
echo ============================================================
echo.

rem --- Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [setup] Installing Node.js LTS...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo [setup] winget missing - downloading Node MSI...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi' -OutFile '%TEMP%\node.msi'"
    msiexec /i "%TEMP%\node.msi" /qn /norestart
  ) else (
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  )
) else (
  echo [setup] Node.js already present.
)

rem --- Go (optional: only needed to rebuild the anti engine) ---
where go >nul 2>&1
if errorlevel 1 (
  echo [setup] Installing Go...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo [setup] winget missing - downloading Go MSI...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://go.dev/dl/go1.23.4.windows-amd64.msi' -OutFile '%TEMP%\go.msi'"
    msiexec /i "%TEMP%\go.msi" /qn /norestart
  ) else (
    winget install -e --id GoLang.Go --accept-source-agreements --accept-package-agreements
  )
) else (
  echo [setup] Go already present.
)

rem --- make freshly-installed tools visible in THIS window ---
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\Go\bin;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node still not found. Close this window, open a NEW one, and run install.bat again.
  pause
  exit /b 1
)

rem --- project libraries: web search (impers/koffi/cheerio), ripgrep, electron, everything ---
echo.
echo [setup] Installing project libraries (npm install)...
cd /d "%PROJ%"
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your internet connection and retry.
  pause
  exit /b 1
)

rem --- optional Exa semantic search backend (best-effort, never fatal) ---
echo [setup] Installing optional web-search backend (mcporter)...
call npm install -g mcporter >nul 2>&1

rem --- build the UI once so the first launch is fast ---
echo [setup] Building the app UI...
call npm run build:web:dist
if errorlevel 1 (
  echo [WARN] UI build failed now - start.bat will build it on first launch.
)

echo.
echo ============================================================
echo   SETUP COMPLETE
echo   Next: double-click  build-sc\start.bat  to run ComposeVC.
echo ============================================================
echo.
pause
endlocal
