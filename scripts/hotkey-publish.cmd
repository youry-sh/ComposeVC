@echo off
rem Start the ComposeVC publish hotkey agent (Ctrl+Shift+O) without a console window.
rem Usage: scripts\hotkey-publish.cmd [-InstallStartup] [-Force] [-Keys "Alt+Shift+O"]
setlocal
cd /d "%~dp0.."
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0hotkey-publish.ps1" %*
endlocal
