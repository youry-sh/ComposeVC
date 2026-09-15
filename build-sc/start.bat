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
for /f %%V in ('node -p "const [a,b]=process.versions.node.split('.').map(Number); a*1000+b"') do set "NODE_LEVEL=%%V"
if not defined NODE_LEVEL (
  echo [ERROR] Could not determine the Node.js version.
  echo         Run build-sc\install.bat to repair the setup.
  pause
  exit /b 1
)
if %NODE_LEVEL% LSS 22012 (
  echo [ERROR] Node.js 22.12 or newer is required. Installed version:
  node --version
  echo         Run build-sc\install.bat to upgrade Node.js and reinstall libraries.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo [ERROR] Libraries missing. Run build-sc\install.bat first.
  pause
  exit /b 1
)
rem --- Electron ships a ~200 MB binary via a postinstall download that often does
rem     not finish on the first npm install. If it is missing, fetch it here instead
rem     of forcing a full reinstall. ---
if not exist "node_modules\electron\dist\electron.exe" call :ensure_electron
if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo [ERROR] The Electron binary could not be downloaded.
  echo         Check that github.com is reachable ^(disable VPN/firewall/proxy^),
  echo         then run start.bat again, or run build-sc\install.bat to reinstall.
  echo.
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
exit /b 0


rem ============================================================================
rem  :ensure_electron - download the Electron binary (node_modules\electron\dist)
rem  via Electron's own installer, with retries. Runs only when it is missing.
rem ============================================================================
:ensure_electron
echo [setup] The Electron binary is missing - downloading it once ^(~200 MB^)...
set "npm_config_fetch_retries=5"
if not defined electron_config_cache set "electron_config_cache=%LOCALAPPDATA%\electron\Cache"
set "ETRY=0"
:ensure_electron_try
set /a ETRY+=1
echo [setup] download attempt %ETRY%/3 ...
node "%PROJ%\node_modules\electron\install.js"
if exist "node_modules\electron\dist\electron.exe" (
  echo [setup] Electron is ready.
  exit /b 0
)
if %ETRY% LSS 3 (
  echo [setup] attempt %ETRY% did not finish - retrying in 3s...
  timeout /t 3 /nobreak >nul
  goto :ensure_electron_try
)
echo [setup] Electron download failed after %ETRY% attempts.
exit /b 1
