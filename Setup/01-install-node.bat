@echo off
chcp 65001 >nul
title Agent-Reach Setup [1/4] Node.js + npm

echo ============================================================
echo  Step 1/4: Node.js + npm
echo ============================================================

where node >nul 2>&1
if %errorlevel%==0 (
  echo  [OK] Node.js already installed:
  for /f "delims=" %%v in ('node --version') do echo       %%v
  goto :npm
)

echo  [..] Node.js not found. Installing LTS via winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements >nul 2>&1
if %errorlevel%==0 (
  echo  [OK] Node.js installed via winget
) else (
  echo  [!!] winget failed. Trying direct MSI download...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.17.0/node-v22.17.0-x64.msi' -OutFile \"$env:TEMP\node-setup.msi\"; Start-Process msiexec -ArgumentList '/i',\"$env:TEMP\node-setup.msi\",'/qn' -Wait; Write-Output 'MSI_OK' } catch { Write-Output ('MSI_FAIL ' + $_.Exception.Message) }"
)

rem --- node may be installed but not on PATH of THIS window ---
if not exist "%ProgramFiles%\nodejs\node.exe" (
  if not exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    echo  [ERROR] node.exe not found in standard locations.
    echo          Install Node.js LTS manually: https://nodejs.org
    echo          Then run this script again.
    pause
    exit /b 1
  )
)
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%PATH%"

where node >nul 2>&1
if %errorlevel%==0 (
  for /f "delims=" %%v in ('node --version') do echo  [OK] Node.js %%v
) else (
  echo  [ERROR] node still not on PATH.
  pause
  exit /b 1
)

:npm
where npm >nul 2>&1
if %errorlevel%==0 (
  for /f "delims=" %%v in ('npm --version') do echo  [OK] npm %%v
) else (
  echo  [ERROR] npm not found.
  pause
  exit /b 1
)

echo.
echo  Step 1 done.
exit /b 0
