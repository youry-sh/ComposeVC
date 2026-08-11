@echo off
chcp 65001 >nul
title ComposeVC IDE Setup [5/5] Dependencies + Build Check

echo ============================================================
echo  Step 5/5: ComposeVC IDE dependencies + build check
echo ============================================================

set "PATH=%USERPROFILE%\.local\bin;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts;C:\Python312;C:\Python312\Scripts;%PATH%"

rem --- node/npm required ---
where node >nul 2>&1
if %errorlevel%==0 goto :npm
echo  [ERROR] Node.js not found. Run 01-install-node.bat first.
pause
exit /b 1

:npm
echo  [OK] Node: 
for /f "delims=" %%v in ('node --version') do echo       %%v
where npm >nul 2>&1
if %errorlevel%==0 goto :install
echo  [ERROR] npm not found.
pause
exit /b 1

:install
echo.
echo  [1/4] Installing npm dependencies (this takes several minutes)...
cd /d "%~dp0.."

set "NPM_FLAGS=--no-audit --no-fund --loglevel=error"
call npm install %NPM_FLAGS%
if %errorlevel%==0 (
  echo  [OK] npm install done
  goto :native
)

echo  [..] npm install failed - retrying once (network hiccup / cache)...
call npm install %NPM_FLAGS%
if %errorlevel%==0 (
  echo  [OK] npm install done - retry
  goto :native
)

echo  [..] Retry failed - trying npm ci (exact lockfile)...
call npm ci %NPM_FLAGS%
if %errorlevel%==0 (
  echo  [OK] npm ci done
  goto :native
)

echo  [ERROR] npm install/ci failed after retries.
echo          Check: internet connection, proxy, disk space.
echo          If native build errors appear (node-gyp/Visual Studio) -
echo          install VS Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo          and re-run this script.
pause
exit /b 1

:native
echo.
echo  [2/4] Checking native modules (sharp, impers, electron)...
node -e "try{require('sharp');console.log('  [OK] sharp');}catch(e){console.log('  [FAIL] sharp:',String(e.message).split(String.fromCharCode(10))[0]);process.exitCode=1;}"
set "SHARP=%ERRORLEVEL%"
node -e "import('impers').then(()=>console.log('  [OK] impers')).catch(e=>{console.log('  [FAIL] impers:',String(e.message).split(String.fromCharCode(10))[0]);process.exit(1);})"
set "IMPERS=%ERRORLEVEL%"
node -e "const p=require('path').join(process.cwd(),'node_modules','electron','dist','electron.exe');require('fs').existsSync(p)?console.log('  [OK] electron binary'):console.log('  [FAIL] electron binary missing');process.exitCode=require('fs').existsSync(p)?0:1;"
set "ELECTRON=%ERRORLEVEL%"

if not "%SHARP%"=="0" (
  echo  [WARN] sharp broken - run: npm rebuild sharp
)
if not "%IMPERS%"=="0" (
  echo  [WARN] impers broken - run: npm rebuild impers
)
if not "%ELECTRON%"=="0" (
  echo  [WARN] electron binary missing - run: npm rebuild electron
)

rem --- impers needs curl-impersonate native lib; warm it up ---
echo.
echo  [3/4] Warming up impers (downloads curl-impersonate on first use)...
node -e "import('impers').then(()=>console.log('  [OK] impers ready')).catch(e=>{console.log('  [FAIL] impers:',String(e.message).split(String.fromCharCode(10))[0]);process.exit(1);})"
if %errorlevel%==0 (
  echo  [OK] impers warmed up
) else (
  echo  [WARN] impers warm-up failed - web_search fallback engines only: DDG + Bing.
)

rem --- vite build check: proves `start.bat` will launch ---
echo.
echo  [4/4] Verifying vite build (same step start.bat runs)...
call npx vite build
if %errorlevel%==0 (
  echo  [OK] vite build passed - start.bat will work
) else (
  echo  [FAIL] vite build failed - check errors above.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   IDE setup complete. Launch the app: double-click start.bat
echo ============================================================
pause
exit /b 0
