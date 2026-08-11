@echo off
chcp 65001 >nul
title Agent-Reach Setup [2/4] Python + pip

echo ============================================================
echo  Step 2/4: Python 3 + pip
echo ============================================================

where py >nul 2>&1
if %errorlevel%==0 (
  echo  [OK] Python launcher py already installed:
  for /f "delims=" %%v in ('py -3 --version') do echo       %%v
  goto :pip
)

where python >nul 2>&1
if %errorlevel%==0 (
  echo  [OK] python already on PATH:
  for /f "delims=" %%v in ('python --version') do echo       %%v
  goto :pip
)

echo  [..] Python not found. Installing 3.12 via winget...
winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements >nul 2>&1
if %errorlevel%==0 (
  echo  [OK] Python 3.12 installed via winget
) else (
  echo  [!!] winget failed. Trying direct installer...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' -OutFile \"$env:TEMP\python-setup.exe\"; Start-Process \"$env:TEMP\python-setup.exe\" -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=1','Include_pip=1' -Wait; Write-Output 'PY_OK' } catch { Write-Output ('PY_FAIL ' + $_.Exception.Message) }"
)

rem --- python may be installed but not on PATH of THIS window ---
if not exist "%LocalAppData%\Programs\Python\Python312\python.exe" (
  if not exist "C:\Python312\python.exe" (
    echo  [ERROR] python.exe not found in standard locations.
    echo          Install Python 3.12 manually: https://www.python.org/downloads/
    echo          IMPORTANT: tick "Add python.exe to PATH" during install.
    echo          Then run this script again.
    pause
    exit /b 1
  )
)
set "PATH=%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts;C:\Python312;C:\Python312\Scripts;%PATH%"

where py >nul 2>&1
if %errorlevel%==0 (
  for /f "delims=" %%v in ('py -3 --version') do echo  [OK] Python launcher %%v
) else (
  where python >nul 2>&1
  if %errorlevel%==0 (
    for /f "delims=" %%v in ('python --version') do echo  [OK] Python %%v
  ) else (
    echo  [ERROR] python still not on PATH.
    pause
    exit /b 1
  )
)

:pip
echo  [..] Upgrading pip...
py -3 -m pip install --upgrade pip --quiet
if %errorlevel%==0 (
  echo  [OK] pip upgraded
) else (
  python -m pip install --upgrade pip --quiet
)

echo.
echo  Step 2 done.
exit /b 0
