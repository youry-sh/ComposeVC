@echo off
setlocal EnableExtensions
title ComposeVC

rem Launcher: starts the proxy gateway in its own window, then the app.
rem Run build-sc\install.bat once before the first launch.

cd /d "%~dp0.."
set "PROJ=%CD%"

rem stable identity so the app and the proxy share the same userData
set "LOPSTER_COPY_ID=composevc"
set "LOPSTER_APP_NAME=ComposeVC"
set "ELECTRON_FORCE_NEW_INSTANCE=1"

rem make node visible even right after setup (before a relogin)
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\Go\bin;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Run build-sc\install.bat first.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo [ERROR] Libraries missing. Run build-sc\install.bat first.
  pause
  exit /b 1
)

rem --- 1) proxy gateway in its OWN window (inherits env above; no re-set) ---
echo [1/2] Starting proxy gateway in a separate window...
start "ComposeVC Proxy" cmd /k "cd /d "%PROJ%" && node electron/proxy/standalone.cjs"

rem tell the app the proxy is managed externally - do not spawn a second one
set "LOPSTER_PROXY_EXTERNAL=1"

rem give the proxy a moment to bind its port before the app probes it
timeout /t 3 /nobreak >nul

rem --- 2) launch the app ---
echo [2/2] Launching ComposeVC...
echo      ^(close the "ComposeVC Proxy" window with Ctrl+C to stop the gateway^)
echo.
if exist "dist\index.html" (
  call node scripts\run-electron.cjs .
) else (
  call npm run app
)

echo.
echo App exited. The proxy window stays open - close it with Ctrl+C.
pause
endlocal
