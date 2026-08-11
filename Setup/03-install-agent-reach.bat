@echo off
chcp 65001 >nul
title Agent-Reach Setup [3/4] Tools (mcporter, agent-reach, CLIs)

echo ============================================================
echo  Step 3/4: mcporter + Exa MCP + agent-reach + channel CLIs
echo ============================================================

rem ---------------------------------------------------------------
rem 1) mcporter (search backend) + Exa MCP server (free, no key)
rem ---------------------------------------------------------------
echo.
echo  [1/6] Installing mcporter (npm global)...
call npm install -g mcporter
if %errorlevel%==0 (
  echo  [OK] mcporter installed
) else (
  echo  [ERROR] mcporter install failed. Check npm / network.
  pause
  exit /b 1
)

echo  [..] Registering Exa MCP server...
call mcporter config add exa https://mcp.exa.ai/mcp --scope home
if %errorlevel%==0 (
  echo  [OK] Exa MCP registered
) else (
  echo  [ERROR] Exa MCP registration failed.
  pause
  exit /b 1
)

rem ---------------------------------------------------------------
rem 2) agent-reach (router/health-check; NOT on PyPI - from GitHub)
rem ---------------------------------------------------------------
echo.
echo  [2/6] Installing agent-reach (from GitHub archive, not PyPI)...
call py -3 -m pip install "https://github.com/Panniantong/agent-reach/archive/main.zip"
if %errorlevel%==0 (
  echo  [OK] agent-reach installed
) else (
  echo  [ERROR] agent-reach install failed.
  pause
  exit /b 1
)

rem ---------------------------------------------------------------
rem 3) pipx + platform CLIs (bili-cli, twitter-cli)
rem ---------------------------------------------------------------
echo.
echo  [3/6] Installing pipx...
call py -3 -m pip install pipx
call py -3 -m pipx ensurepath
if not exist "%USERPROFILE%\.local\bin" (
  echo  [WARN] pipx .local\bin missing - creating...
  mkdir "%USERPROFILE%\.local\bin" >nul 2>&1
)
set "PATH=%USERPROFILE%\.local\bin;%PATH%"

echo  [..] Installing bili-cli (Bilibili channel)...
call py -3 -m pipx install bilibili-cli
if %errorlevel%==0 (echo  [OK] bili-cli installed) else (echo  [WARN] bili-cli failed - Bilibili basic search still works)

echo  [..] Installing twitter-cli (Twitter channel)...
call py -3 -m pipx install twitter-cli
if %errorlevel%==0 (echo  [OK] twitter-cli installed) else (echo  [WARN] twitter-cli failed - needs manual install later)

rem ---------------------------------------------------------------
rem 4) opencli (desktop browser-session backend)
rem ---------------------------------------------------------------
echo.
echo  [4/6] Installing opencli (npm global)...
call npm install -g @jackwener/opencli
if %errorlevel%==0 (echo  [OK] opencli installed) else (echo  [WARN] opencli failed - desktop channels need it)

rem ---------------------------------------------------------------
rem 5) yt-dlp (YouTube) + gh CLI (GitHub)
rem ---------------------------------------------------------------
echo.
echo  [5/6] Installing yt-dlp...
call py -3 -m pip install -U yt-dlp
if %errorlevel%==0 (echo  [OK] yt-dlp installed) else (echo  [WARN] yt-dlp failed)

echo  [..] Checking gh CLI (GitHub)...
where gh >nul 2>&1
if %errorlevel%==0 (
  echo  [OK] gh already installed
) else (
  echo  [..] Installing gh CLI via winget...
  call winget install -e --id GitHub.cli --accept-source-agreements --accept-package-agreements >nul 2>&1
  if %errorlevel%==0 (
    echo  [OK] gh installed
  ) else (
    echo  [WARN] gh failed - install manually from https://cli.github.com
  )
)

rem ---------------------------------------------------------------
rem 6) agent-reach final bootstrap (channels config + skill)
rem ---------------------------------------------------------------
echo.
echo  [6/6] Running agent-reach install (channel bootstrap)...
call agent-reach install --env=auto
if %errorlevel%==0 (
  echo  [OK] agent-reach bootstrap done
) else (
  echo  [WARN] bootstrap reported issues - run verify step to see state
)

echo.
echo  Step 3 done.
exit /b 0
