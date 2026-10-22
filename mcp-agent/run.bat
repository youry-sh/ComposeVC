@echo off
REM local-coding-agent: запуск MCP-сервера (+ опционально туннель наружу).
REM
REM   run.bat                    — только локально (http://127.0.0.1:8000)
REM   set CF_QUICK=1 ^& run.bat  — + бесплатный временный URL (без регистрации,
REM                                адрес меняется при каждом перезапуске)
REM   set CF_NAMED=1 ^& run.bat  — + постоянный именованный туннель (свой домен,
REM                                см. README раздел "Свой домен")
REM   set NGROK_DOMAIN=xxx ^& run.bat — + ngrok (нужен static-домен в аккаунте ngrok)
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM --- Python ---
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul
if errorlevel 1 (
  echo ОШИБКА: Python не найден. Установи Python 3.10+ с https://www.python.org/downloads/
  echo ВАЖНО: при установке поставь галочку "Add python.exe to PATH".
  pause
  exit /b 1
)

REM --- .env ---
if exist .env (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)

if not exist .venv (
  echo -^> создаю виртуальное окружение...
  %PY% -m venv .venv
)
.venv\Scripts\pip install -q -r requirements.txt

echo %MCP_TOKEN% | findstr /c:"CHANGE_ME" >nul 2>nul && set TOKEN_BAD=1
if "%MCP_TOKEN%"=="" set TOKEN_BAD=1
if defined TOKEN_BAD (
  findstr /c:"CHANGE_ME" config.yaml >nul 2>nul
  if not errorlevel 1 (
    echo ОШИБКА: задай токен.
    echo   1) %PY% -c "import secrets; print(secrets.token_urlsafe(32))"
    echo   2) copy .env.example .env  и вставь токен в MCP_TOKEN
    pause
    exit /b 1
  )
)

if defined CF_NAMED (
  if "%TUNNEL_NAME%"=="" set TUNNEL_NAME=mcp-pc
  echo -^> поднимаю именованный туннель '!TUNNEL_NAME!'...
  start /min "mcp-tunnel" cloudflared tunnel run !TUNNEL_NAME!
  timeout /t 5 /nobreak >nul
) else if defined NGROK_DOMAIN (
  echo -^> поднимаю ngrok: https://%NGROK_DOMAIN% --^> http://127.0.0.1:8000
  start /min "mcp-ngrok" ngrok http 8000 --url="%NGROK_DOMAIN%"
  timeout /t 3 /nobreak >nul
) else if defined CF_QUICK (
  if not exist bin\cloudflared.exe (
    echo -^> качаю cloudflared...
    mkdir bin 2>nul
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'bin\cloudflared.exe'"
  )
  echo -^> поднимаю временный туннель...
  del /q cloudflared.log 2>nul
  start /min "mcp-tunnel" bin\cloudflared.exe tunnel --url http://127.0.0.1:8000
  timeout /t 10 /nobreak >nul
  for /f "tokens=*" %%U in ('powershell -NoProfile -Command "$m = Select-String -Path cloudflared.log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches ^| Select-Object -Last 1; if ($m) { $m.Matches[0].Value }"') do (
    echo %%U> .public_url
    echo   Твой URL: %%U/mcp  ^(вставь в Notion, + /mcp в конце^)
  )
)

echo -^> старт MCP: http://127.0.0.1:8000/mcp
.venv\Scripts\python server.py
