@echo off
chcp 65001 >nul
title Agent-Reach + IDE Full Setup [0/5]

echo ============================================================
echo   Agent-Reach + ComposeVC IDE Full Setup
echo   Installs everything, then start.bat will launch the app
echo ============================================================
echo.

call "%~dp001-install-node.bat"
if errorlevel 1 goto :fail

call "%~dp002-install-python.bat"
if errorlevel 1 goto :fail

call "%~dp003-install-agent-reach.bat"
if errorlevel 1 goto :fail

call "%~dp004-verify.bat"

call "%~dp005-install-ide.bat"
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo   Setup finished. Double-click start.bat to launch ComposeVC.
echo ============================================================
pause
exit /b 0

:fail
echo.
echo  [ERROR] A step failed. Scroll up to see what happened.
pause
exit /b 1
