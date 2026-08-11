@echo off
chcp 65001 >nul
title Agent-Reach Setup [4/4] Verify

echo ============================================================
echo  Step 4/4: Verify everything works
echo ============================================================

set "PATH=%USERPROFILE%\.local\bin;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts;C:\Python312;C:\Python312\Scripts;%PATH%"

echo.
echo  --- Versions ---
for /f "delims=" %%v in ('node --version 2^>nul') do echo   Node     : %%v
for /f "delims=" %%v in ('npm --version 2^>nul') do echo   npm      : %%v
for /f "delims=" %%v in ('py -3 --version 2^>nul') do echo   Python   : %%v
for /f "delims=" %%v in ('mcporter --version 2^>nul') do echo   mcporter : %%v
for /f "delims=" %%v in ('agent-reach --version 2^>nul') do echo   agent-reach : %%v
for /f "delims=" %%v in ('yt-dlp --version 2^>nul') do echo   yt-dlp   : %%v

echo.
echo  --- Exa semantic search live test ---
mcporter call exa.web_search_exa query="agent reach github" numResults=2 --output json
if %errorlevel%==0 (
  echo   [OK] Exa search works
) else (
  echo   [FAIL] Exa search failed - run: mcporter config add exa https://mcp.exa.ai/mcp --scope home
)

echo.
echo  --- Channel health (agent-reach doctor) ---
agent-reach doctor --json

echo.
echo ============================================================
echo   Verification done. Channels marked [ok] are ready.
echo   Twitter/Reddit/Instagram/Facebook/XHS need login cookies -
echo   tell the agent "help me configure Twitter" etc.
echo   Close this window and restart the app.
echo ============================================================
pause
exit /b 0
