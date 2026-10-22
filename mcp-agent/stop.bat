@echo off
REM Kill-switch: гасит сервер и все туннели.
REM (Если включал автозапуск через Task Scheduler — сначала удали задачу:
REM  schtasks /delete /tn "LocalCodingAgent" /f)
cd /d "%~dp0"

echo Останавливаю сервер и туннели...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*%~dp0*server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; echo 'сервер остановлен' }"
taskkill /f /im cloudflared.exe >nul 2>nul && echo туннель cloudflared остановлен
taskkill /f /im ngrok.exe >nul 2>nul && echo ngrok остановлен
del /q .server_pid .ngrok_pid .cf_pid .cf_named_pid 2>nul
echo Готово. Проверка: открой http://127.0.0.1:8000/health в браузере — должен не открыться.
pause
