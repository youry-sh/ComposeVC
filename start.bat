@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "LOPSTER_COPY_ID=lopster1-4-copy"
set "LOPSTER_APP_NAME=ComposeVC"
set "ELECTRON_FORCE_NEW_INSTANCE=1"

set "LOG=%~dp0start-log.txt"
set "ERRLOG=%~dp0start-error.txt"
REM Unique temp files so parallel starts / leftover handles don't lock shared names.
set "OUT=%TEMP%\lopster-app-out-%RANDOM%%RANDOM%.txt"
set "ERR=%TEMP%\lopster-app-err-%RANDOM%%RANDOM%.txt"

echo.>> "%LOG%" 2>nul
echo ========== %DATE% %TIME% ==========>> "%LOG%" 2>nul
echo Starting ComposeVC...
echo userData id: %LOPSTER_COPY_ID%
echo Log file: %LOG%
echo.

REM Run npm, keep both console output AND a file log (so it is not lost if the window closes).
call npm run app 1> "%OUT%" 2> "%ERR%"
set "EXITCODE=%ERRORLEVEL%"

REM Add pause to see output before window closes
echo.
echo ============================================
echo Build and launch completed. Exit code: %EXITCODE%
echo ============================================
echo.
echo If app window is black, check the log files for errors.
echo Log file: %LOG%
echo.
pause

if exist "%OUT%" (
  type "%OUT%"
  type "%OUT%" >> "%LOG%" 2>nul
)
if exist "%ERR%" (
  type "%ERR%"
  type "%ERR%" >> "%LOG%" 2>nul
)
echo Exit code: %EXITCODE%>> "%LOG%" 2>nul

if not "%EXITCODE%"=="0" (
  echo.
  echo ============================================
  echo ERROR: app exited with code %EXITCODE%
  echo Full log saved to:
  echo   %LOG%
  echo ============================================
  if exist "%ERR%" copy /y "%ERR%" "%ERRLOG%" >nul 2>&1
  echo Last errors also in: %ERRLOG%
  echo.
  echo Press any key to close this window...
  pause >nul
  del /q "%OUT%" "%ERR%" >nul 2>&1
  exit /b %EXITCODE%
)

echo.
echo App finished. Exit code: %EXITCODE%
echo Log: %LOG%
echo.
echo Press any key to close this window...
pause >nul
del /q "%OUT%" "%ERR%" >nul 2>&1
endlocal
