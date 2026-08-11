@echo off
setlocal EnableExtensions
title ComposeVC - Build EXE
cd /d "%~dp0"

echo ============================================================
echo   ComposeVC - hardened Windows installer build
echo   Repo: %CD%
echo ============================================================
echo.

rem --- Node present? ---
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH. Install Node 18+ and retry.
  pause
  exit /b 1
)

rem --- Dependencies ---
if not exist "node_modules" (
  echo [1/2] Installing dependencies ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

rem --- Package options ---
rem   Build.bat          heavy obfuscation, reuse existing anti.exe (default)
rem   Build.bat light    faster/lighter obfuscation pass
rem   Build.bat anti     also rebuild anti.exe from Go source
set "PKG_ARGS=--skip-anti-build"
if /I "%~1"=="light" set "PKG_ARGS=--skip-anti-build --light-harden"
if /I "%~1"=="anti"  set "PKG_ARGS="

echo [2/2] Packaging installer...
echo        node scripts\package-dist.mjs %PKG_ARGS%
echo.
call node scripts\package-dist.mjs %PKG_ARGS%
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo ============================================================
  echo   BUILD FAILED ^(exit %CODE%^)
  echo   Check the log above for the first [package-dist] ERROR line.
  echo ============================================================
  pause
  exit /b %CODE%
)

echo ============================================================
echo   BUILD OK
echo   Installer is in:  release\ComposeVC-Setup-*.exe
echo   Give that single .exe to any Windows user - it installs the
echo   app, and the proxy gateway starts itself on every launch.
echo ============================================================
if exist "release" start "" explorer "%CD%\release"
echo.
pause
endlocal
