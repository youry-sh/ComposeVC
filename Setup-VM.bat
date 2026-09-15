@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ComposeVC - Full Setup (QEMU 11.1.0 + IDE)
cd /d "%~dp0"

echo ============================================================
echo   ComposeVC - full setup
echo   - Node dependencies
echo   - QEMU 11.1.0 ^(pinned, sha512-verified, resumable^)
echo   - Debian 12 base image ^(resumable^)
echo   Repo: %CD%
echo ============================================================
echo.

rem ----- arguments -------------------------------------------------------
rem   Setup-VM.bat            install deps + QEMU 11.1.0 + debian-12
rem   Setup-VM.bat noimage    install deps + QEMU only
rem   Setup-VM.bat run        do everything, then launch the IDE
rem   Setup-VM.bat ubuntu     use ubuntu-24.04 as the base image
set "SETUP_ARGS="
set "LAUNCH=0"
:parse
if "%~1"=="" goto afterparse
if /I "%~1"=="noimage" set "SETUP_ARGS=%SETUP_ARGS% --no-image"
if /I "%~1"=="run"     set "LAUNCH=1"
if /I "%~1"=="ubuntu"  set "SETUP_ARGS=%SETUP_ARGS% --image=ubuntu-24.04"
if /I "%~1"=="debian"  set "SETUP_ARGS=%SETUP_ARGS% --image=debian-12"
shift
goto parse
:afterparse

rem ----- Node present? ---------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH. Install Node 18+ from https://nodejs.org and retry.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo [env] Node %NODE_VER%
echo.

rem ----- Dependencies (retry up to 3x, resume with the cache) ------------
if exist "node_modules\electron" (
  echo [deps] node_modules present - skipping npm install.
) else (
  set "TRY=0"
  :npmretry
  set /a TRY+=1
  echo [deps] npm install ^(attempt !TRY!/3^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    if !TRY! LSS 3 (
      echo [deps] npm install failed - retrying in 5s...
      timeout /t 5 /nobreak >nul
      goto npmretry
    )
    echo [ERROR] npm install failed after 3 attempts. Check your network and retry.
    echo.
    pause
    exit /b 1
  )
)
echo.

rem ----- QEMU 11.1.0 + base image (verified, resumable, never hangs) -----
echo [vm] Running the VM setup...
echo.
call node scripts\vm-setup.cjs%SETUP_ARGS%
set "CODE=%ERRORLEVEL%"
echo.

if "%CODE%"=="0" goto ok
if "%CODE%"=="2" goto partial

echo ============================================================
echo   SETUP FAILED ^(exit %CODE%^)
echo   QEMU did not install. The IDE still runs, but VMs are off.
echo   You can retry just this step with:
echo       node scripts\vm-setup.cjs
echo ============================================================
echo.
pause
exit /b %CODE%

:partial
echo ============================================================
echo   SETUP PARTIAL
echo   QEMU is installed, but the base image did not finish.
echo   Retry the image download any time with:
echo       node scripts\vm-setup.cjs
echo ============================================================
echo.
goto maybelaunch

:ok
echo ============================================================
echo   SETUP OK
echo   QEMU 11.1.0 and the base image are ready.
echo   Create a machine:
echo       node scripts\vm-cli.cjs create name=dev image=debian-12
echo       node scripts\vm-cli.cjs wait_ready name=dev
echo       node scripts\vm-cli.cjs exec name=dev command="uname -a"
echo ============================================================
echo.

:maybelaunch
if "%LAUNCH%"=="1" (
  echo [ide] Launching ComposeVC...
  echo.
  call npm run app
  set "CODE=%ERRORLEVEL%"
  echo.
  echo IDE exited with code !CODE!.
) else (
  echo To start the IDE now, run:  start.bat
  echo.
)
pause
endlocal
exit /b 0
