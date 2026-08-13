@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ComposeVC - First-time setup

rem This script prepares a FRESH Windows machine to run ComposeVC from source:
rem   - installs a fast downloader (aria2), Node.js (and Go), then npm libraries
rem It needs admin rights to install Node/Go system-wide.
rem
rem Downloads NEVER use Invoke-WebRequest (it is single-stream and very slow).
rem Order: aria2 (16 connections) -> curl.exe -> BITS.

rem --- project root = parent of this build-sc folder ---
cd /d "%~dp0.."
set "PROJ=%CD%"
set "ARIA2="
set "ARIA2_DIR=%LOCALAPPDATA%\ComposeVC\tools\aria2"

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

call :ensure_aria2
if exist "%ARIA2_DIR%\aria2c.exe" set "PATH=%ARIA2_DIR%;%PATH%"
echo.

rem --- Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [setup] Installing Node.js LTS...
  call :fast_dl "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi" "%TEMP%\node-v20.18.0-x64.msi"
  if errorlevel 1 (
    echo [setup] Direct download failed - trying winget...
    where winget >nul 2>&1
    if errorlevel 1 (
      echo [ERROR] Could not download Node.js. Check internet and retry.
      pause
      exit /b 1
    )
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --disable-interactivity
  ) else (
    msiexec /i "%TEMP%\node-v20.18.0-x64.msi" /qn /norestart
    if errorlevel 1 (
      echo [ERROR] Node.js MSI install failed.
      pause
      exit /b 1
    )
    del /q "%TEMP%\node-v20.18.0-x64.msi" >nul 2>&1
  )
) else (
  echo [setup] Node.js already present.
)

rem --- Go (optional: only needed to rebuild the anti engine) ---
where go >nul 2>&1
if errorlevel 1 (
  echo [setup] Installing Go...
  call :fast_dl "https://dl.google.com/go/go1.23.4.windows-amd64.msi" "%TEMP%\go1.23.4.windows-amd64.msi"
  if errorlevel 1 (
    echo [setup] Direct download failed - trying winget...
    where winget >nul 2>&1
    if not errorlevel 1 (
      winget install -e --id GoLang.Go --accept-source-agreements --accept-package-agreements --disable-interactivity
    ) else (
      echo [WARN] Go not installed. Only needed to rebuild the anti engine.
    )
  ) else (
    msiexec /i "%TEMP%\go1.23.4.windows-amd64.msi" /qn /norestart
    if errorlevel 1 (
      echo [WARN] Go MSI install failed. Only needed to rebuild the anti engine.
    ) else (
      del /q "%TEMP%\go1.23.4.windows-amd64.msi" >nul 2>&1
    )
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

rem --- npm: more sockets, skip audit/fund (those are extra slow network round-trips) ---
set "npm_config_maxsockets=64"
set "npm_config_network_concurrency=32"
set "npm_config_fetch_retries=5"
set "npm_config_fetch_retry_mintimeout=20000"
set "npm_config_fetch_retry_maxtimeout=120000"
set "npm_config_audit=false"
set "npm_config_fund=false"
set "npm_config_progress=true"

echo.
echo [setup] Installing project libraries (npm^)...
cd /d "%PROJ%"
if exist "package-lock.json" (
  call npm ci --no-audit --no-fund --progress=true
) else (
  call npm install --no-audit --no-fund --progress=true
)
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your internet connection and retry.
  pause
  exit /b 1
)

rem --- optional Exa semantic search backend (best-effort, never fatal) ---
echo [setup] Installing optional web-search backend (mcporter)...
call npm install -g mcporter --no-audit --no-fund >nul 2>&1

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
exit /b 0

rem ============================================================
rem  aria2 portable: 16 parallel connections, range requests
rem ============================================================
:ensure_aria2
if exist "%ARIA2_DIR%\aria2c.exe" (
  set "ARIA2=%ARIA2_DIR%\aria2c.exe"
  echo [setup] aria2 ready: %ARIA2_DIR%\aria2c.exe
  exit /b 0
)

where aria2c >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%I in ('where aria2c') do (
    set "ARIA2=%%I"
    echo [setup] aria2 ready: %%I
    exit /b 0
  )
)

echo [setup] Installing aria2 ^(multi-connection downloader^)...
mkdir "%ARIA2_DIR%" >nul 2>&1
set "ARIA_ZIP=%TEMP%\aria2-1.37.0-win64.zip"
set "ARIA_UNPACK=%TEMP%\aria2-unpack-%RANDOM%"
mkdir "%ARIA_UNPACK%" >nul 2>&1

rem Small zip: curl.exe is enough (built into Windows 10+). Never IWR.
curl.exe -L --fail --retry 5 --retry-delay 2 --connect-timeout 20 --progress-bar -o "%ARIA_ZIP%" "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip"
if errorlevel 1 (
  echo [setup] GitHub failed - trying winget for aria2...
  where winget >nul 2>&1
  if not errorlevel 1 (
    winget install -e --id aria2.aria2 --accept-source-agreements --accept-package-agreements --disable-interactivity
    where aria2c >nul 2>&1
    if not errorlevel 1 (
      for /f "delims=" %%I in ('where aria2c') do set "ARIA2=%%I"
      echo [setup] aria2 installed via winget.
      rd /s /q "%ARIA_UNPACK%" >nul 2>&1
      exit /b 0
    )
  )
  echo [WARN] aria2 not installed. Downloads will use curl.exe ^(still faster than WebRequest^).
  rd /s /q "%ARIA_UNPACK%" >nul 2>&1
  exit /b 0
)

tar -xf "%ARIA_ZIP%" -C "%ARIA_UNPACK%"
if errorlevel 1 (
  echo [WARN] Could not unpack aria2. Downloads will use curl.exe.
  rd /s /q "%ARIA_UNPACK%" >nul 2>&1
  del /q "%ARIA_ZIP%" >nul 2>&1
  exit /b 0
)

for /r "%ARIA_UNPACK%" %%F in (aria2c.exe) do (
  copy /y "%%F" "%ARIA2_DIR%\aria2c.exe" >nul
)

rd /s /q "%ARIA_UNPACK%" >nul 2>&1
del /q "%ARIA_ZIP%" >nul 2>&1

if exist "%ARIA2_DIR%\aria2c.exe" (
  set "ARIA2=%ARIA2_DIR%\aria2c.exe"
  echo [setup] aria2 installed: %ARIA2_DIR%\aria2c.exe
) else (
  echo [WARN] aria2c.exe missing after unpack. Downloads will use curl.exe.
)
exit /b 0

rem ============================================================
rem  :fast_dl  URL  OUTFILE
rem  aria2 -x16 -s16  ->  curl.exe  ->  BITS  (never Invoke-WebRequest)
rem ============================================================
:fast_dl
set "_url=%~1"
set "_out=%~2"
set "_dir=%~dp2"
set "_name=%~nx2"
echo [dl] %_name%
echo      %_url%

if exist "%_out%" del /q "%_out%" >nul 2>&1

if defined ARIA2 if exist "%ARIA2%" (
  "%ARIA2%" --max-connection-per-server=16 --split=16 --min-split-size=1M --file-allocation=none --allow-overwrite=true --auto-file-renaming=false --continue=true --max-tries=8 --retry-wait=2 --timeout=60 --connect-timeout=20 --console-log-level=warn --summary-interval=1 -d "%_dir%" -o "%_name%" "%_url%"
  if not errorlevel 1 goto :fast_dl_ok
  echo [dl] aria2 failed, falling back to curl.exe...
)

where curl.exe >nul 2>&1
if not errorlevel 1 (
  curl.exe -L --fail --retry 5 --retry-delay 2 --connect-timeout 20 --progress-bar -o "%_out%" "%_url%"
  if not errorlevel 1 goto :fast_dl_ok
  echo [dl] curl failed, falling back to BITS...
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Start-BitsTransfer -Source '%_url%' -Destination '%_out%' -Priority Foreground"
if errorlevel 1 (
  echo [ERROR] Download failed: %_name%
  exit /b 1
)

:fast_dl_ok
if not exist "%_out%" (
  echo [ERROR] Download produced no file: %_out%
  exit /b 1
)
for %%A in ("%_out%") do (
  if %%~zA LSS 1000000 (
    echo [ERROR] Download too small ^(%%~zA bytes^) - likely an error page: %_name%
    exit /b 1
  )
  echo [dl] OK  %_name%  ^(%%~zA bytes^)
)
exit /b 0
