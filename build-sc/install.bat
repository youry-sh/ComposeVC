@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ComposeVC - First-time setup

rem ============================================================================
rem  ComposeVC first-time setup for a FRESH Windows machine (run from source).
rem  Installs: aria2 (fast downloader) -> Node.js 22 LTS -> npm libraries -> UI.
rem  Go is OPTIONAL (only to rebuild the anti engine): run "install.bat go".
rem
rem  NOTHING here can hang forever:
rem   - every download aborts if it stalls (curl --speed-time / aria2 --timeout)
rem   - npm runs under a watchdog that kills it if it produces no output for a
rem     while, then retries with resume (postinstall binary downloads for
rem     electron / ripgrep are the usual culprits)
rem ============================================================================

rem --- project root = parent of this build-sc folder ---
cd /d "%~dp0.."
set "PROJ=%CD%"
set "ARIA2="
set "ARIA2_DIR=%LOCALAPPDATA%\ComposeVC\tools\aria2"

rem --- optional components (opt-in to keep the default path fast) ---
set "WANT_GO="
for %%A in (%*) do (
  if /I "%%~A"=="go"    set "WANT_GO=1"
  if /I "%%~A"=="nogo"  set "WANT_GO="
)

rem --- detect Node FIRST (no admin needed to check). The version test is kept    -
rem     OUTSIDE any (...) block so it uses plain %VAR% and never depends on        -
rem     delayed expansion, which is what silently broke the check before.          -
set "NODE_LEVEL="
where node >nul 2>&1
if not errorlevel 1 for /f %%V in ('node -p "const [a,b]=process.versions.node.split('.').map(Number); a*1000+b" 2^>nul') do set "NODE_LEVEL=%%V"
set "NODE_OK="
if defined NODE_LEVEL if %NODE_LEVEL% GEQ 22012 set "NODE_OK=1"

set "GO_OK=1"
if defined WANT_GO (
  where go >nul 2>&1
  if errorlevel 1 set "GO_OK="
)

rem --- admin is needed ONLY to run the Node/Go MSI installers -------------------
set "NEED_ADMIN="
if not defined NODE_OK set "NEED_ADMIN=1"
if defined WANT_GO if not defined GO_OK set "NEED_ADMIN=1"

if defined NEED_ADMIN (
  net session >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   Node.js must be installed, which needs administrator rights.
    echo   Opening an elevated window - please accept the UAC prompt...
    echo.
    if "%~1"=="" (
      powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs" 2>nul
    ) else (
      powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs" 2>nul
    )
    if errorlevel 1 (
      echo   [!] Automatic elevation did not work ^(UAC declined or PowerShell blocked^).
      echo       Close this window, then RIGHT-CLICK  build-sc\install.bat
      echo       and choose  "Run as administrator".
      echo.
      pause
      exit /b 1
    )
    echo   An administrator window is opening - continue there.
    echo   This window will close in a few seconds...
    timeout /t 6 /nobreak >nul
    exit /b 0
  )
)

echo ============================================================
echo   ComposeVC - first-time setup
echo   Project: %PROJ%
if defined WANT_GO echo   Go engine rebuild: ENABLED
echo ============================================================
echo.

call :ensure_aria2
if exist "%ARIA2_DIR%\aria2c.exe" set "PATH=%ARIA2_DIR%;%PATH%"
echo.

rem --- Node.js install (only when the check above said it is missing/old) -------
if defined NODE_OK (
  echo [setup] Compatible Node.js already present.
) else (
  echo [setup] Installing Node.js 22 LTS...
  call :fast_dl "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi" "%TEMP%\node-v22.14.0-x64.msi"
  if errorlevel 1 (
    echo [setup] Direct download failed - trying winget...
    where winget >nul 2>&1
    if errorlevel 1 (
      echo [ERROR] Could not download Node.js 22+. Check internet and retry.
      pause
      exit /b 1
    )
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --disable-interactivity
  ) else (
    echo [setup] Running the Node.js installer ^(silent^)...
    msiexec /i "%TEMP%\node-v22.14.0-x64.msi" /qn /norestart REBOOT=ReallySuppress
    if errorlevel 1 (
      echo [ERROR] Node.js MSI install failed.
      pause
      exit /b 1
    )
    del /q "%TEMP%\node-v22.14.0-x64.msi" >nul 2>&1
  )
)

rem --- Go (optional: only to rebuild the anti engine) ---------------------------
if defined WANT_GO (
  if defined GO_OK (
    echo [setup] Go already present.
  ) else (
    echo [setup] Installing Go...
    call :fast_dl "https://dl.google.com/go/go1.23.4.windows-amd64.msi" "%TEMP%\go1.23.4.windows-amd64.msi"
    if errorlevel 1 (
      where winget >nul 2>&1
      if not errorlevel 1 winget install -e --id GoLang.Go --accept-source-agreements --accept-package-agreements --disable-interactivity
    ) else (
      msiexec /i "%TEMP%\go1.23.4.windows-amd64.msi" /qn /norestart REBOOT=ReallySuppress
      if not errorlevel 1 del /q "%TEMP%\go1.23.4.windows-amd64.msi" >nul 2>&1
    )
  )
) else (
  echo [setup] Skipping Go ^(not needed to run the app; use "install.bat go" to include it^).
)

rem --- make freshly-installed tools visible in THIS window ----------------------
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\Go\bin;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node still not found. Close this window, open a NEW one, and run install.bat again.
  pause
  exit /b 1
)

rem --- npm tuning: more sockets, generous retries, no slow audit/fund calls -----
set "npm_config_maxsockets=64"
set "npm_config_network_concurrency=32"
set "npm_config_fetch_retries=5"
set "npm_config_fetch_retry_mintimeout=20000"
set "npm_config_fetch_retry_maxtimeout=120000"
set "npm_config_fetch_timeout=300000"
set "npm_config_audit=false"
set "npm_config_fund=false"
set "npm_config_progress=true"

echo.
echo [setup] Installing project libraries (npm^)...
cd /d "%PROJ%"
if exist "package-lock.json" (
  set "CVC_CMD=npm ci --no-audit --no-fund --foreground-scripts"
) else (
  set "CVC_CMD=npm install --no-audit --no-fund --foreground-scripts"
)
set "CVC_IDLE=300"
call :guard 3
if errorlevel 1 (
  echo.
  echo [ERROR] npm install did not complete ^(kept stalling or failing^).
  echo         Fixes: check your internet, disable VPN/firewall for GitHub, then
  echo         double-click install.bat again - it resumes from the npm cache.
  pause
  exit /b 1
)

rem --- Electron ships a ~200 MB binary via a postinstall download that often does
rem     not finish on the first npm install; make sure it is actually here --------
set "electron_config_cache=%LOCALAPPDATA%\electron\Cache"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [setup] Finishing the Electron binary download ^(~200 MB, one time^)...
  set "CVC_CMD=node node_modules\electron\install.js"
  set "CVC_IDLE=300"
  call :guard 3
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo [ERROR] The Electron binary could not be downloaded.
  echo         Check that github.com is reachable ^(disable VPN/firewall^), then
  echo         run install.bat again.
  pause
  exit /b 1
)

rem --- optional Exa semantic search backend (best-effort, guarded, never fatal)--
echo [setup] Installing optional web-search backend ^(mcporter^)...
set "CVC_CMD=npm install -g mcporter --no-audit --no-fund"
set "CVC_IDLE=120"
call :guard 2
if errorlevel 1 echo [WARN] mcporter not installed ^(optional^) - continuing.

rem --- build the UI once so the first launch is fast ---------------------------
echo [setup] Building the app UI...
set "CVC_CMD=npm run build:web:dist"
set "CVC_IDLE=300"
call :guard 2
if errorlevel 1 echo [WARN] UI build failed now - start.bat will build it on first launch.

echo.
echo ============================================================
echo   SETUP COMPLETE
echo   Next: double-click  build-sc\start.bat  to run ComposeVC.
echo ============================================================
echo.
pause
endlocal
exit /b 0


rem ============================================================================
rem  :guard  RETRIES
rem  Runs %CVC_CMD% under a watchdog. Streams its output live; if the command
rem  produces no output for %CVC_IDLE% seconds it is killed (tree) and retried.
rem  A non-zero exit is also retried. Returns the last exit code (0 = success).
rem  Self-contained: the watchdog is an inline PowerShell one-liner, no temp file.
rem ============================================================================
:guard
set "GRETRIES=%~1"
if not defined GRETRIES set "GRETRIES=3"
set "GN=0"
:guard_try
set /a GN+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$psi=New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName='cmd.exe'; $psi.Arguments='/d /c '+$env:CVC_CMD; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $global:L=Get-Date; $p=[System.Diagnostics.Process]::Start($psi); $a={ if($EventArgs.Data -ne $null){ [Console]::WriteLine($EventArgs.Data); $global:L=Get-Date } }; $so=Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -Action $a; $se=Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -Action $a; $p.BeginOutputReadLine(); $p.BeginErrorReadLine(); $idle=[int]$env:CVC_IDLE; if($idle -lt 30){$idle=30}; while(-not $p.HasExited){ Start-Sleep -Seconds 2; if(((Get-Date)-$global:L).TotalSeconds -gt $idle){ Write-Host ('[watchdog] no output for '+$idle+'s - killing and retrying'); & taskkill /f /t /pid $p.Id 2>$null | Out-Null; exit 124 } }; Start-Sleep -Milliseconds 300; exit $p.ExitCode"
set "GC=%ERRORLEVEL%"
if "%GC%"=="0" exit /b 0
if %GN% GEQ %GRETRIES% (
  echo [guard] gave up after %GN% attempts (last exit %GC%^).
  exit /b %GC%
)
if "%GC%"=="124" (
  echo [guard] stalled - attempt %GN%/%GRETRIES% failed, retrying...
) else (
  echo [guard] exit %GC% - attempt %GN%/%GRETRIES% failed, retrying...
)
timeout /t 4 /nobreak >nul
goto guard_try


rem ============================================================================
rem  aria2 portable: 16 parallel connections, resumable range requests
rem ============================================================================
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

rem Small zip: curl.exe is enough (built into Windows 10+). Stall-aborts, never IWR.
curl.exe -L --fail --retry 5 --retry-delay 2 --connect-timeout 20 --speed-limit 2048 --speed-time 30 --max-time 300 --progress-bar -o "%ARIA_ZIP%" "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip"
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
  echo [WARN] aria2 not installed. Downloads will use curl.exe ^(still resumable^).
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

for /r "%ARIA_UNPACK%" %%F in (aria2c.exe) do copy /y "%%F" "%ARIA2_DIR%\aria2c.exe" >nul

rd /s /q "%ARIA_UNPACK%" >nul 2>&1
del /q "%ARIA_ZIP%" >nul 2>&1

if exist "%ARIA2_DIR%\aria2c.exe" (
  set "ARIA2=%ARIA2_DIR%\aria2c.exe"
  echo [setup] aria2 installed: %ARIA2_DIR%\aria2c.exe
) else (
  echo [WARN] aria2c.exe missing after unpack. Downloads will use curl.exe.
)
exit /b 0


rem ============================================================================
rem  :fast_dl  URL  OUTFILE
rem  aria2 -x16 -s16  ->  curl.exe  ->  BITS.  Each aborts on a stall; none hang.
rem ============================================================================
:fast_dl
set "_url=%~1"
set "_out=%~2"
set "_dir=%~dp2"
set "_name=%~nx2"
echo [dl] %_name%
echo      %_url%

if exist "%_out%" del /q "%_out%" >nul 2>&1

if defined ARIA2 if exist "%ARIA2%" (
  "%ARIA2%" --max-connection-per-server=16 --split=16 --min-split-size=1M --file-allocation=none --allow-overwrite=true --auto-file-renaming=false --continue=true --max-tries=8 --retry-wait=2 --timeout=60 --connect-timeout=20 --lowest-speed-limit=2048 --console-log-level=warn --summary-interval=1 -d "%_dir%" -o "%_name%" "%_url%"
  if not errorlevel 1 goto :fast_dl_ok
  echo [dl] aria2 failed/stalled, falling back to curl.exe...
)

where curl.exe >nul 2>&1
if not errorlevel 1 (
  curl.exe -L --fail --retry 5 --retry-delay 2 --connect-timeout 20 --speed-limit 3072 --speed-time 30 --max-time 3600 --progress-bar -o "%_out%" "%_url%"
  if not errorlevel 1 goto :fast_dl_ok
  echo [dl] curl failed/stalled, falling back to BITS...
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
