@echo off
setlocal
title Transcriber setup
echo.
echo  Transcriber setup
echo  -----------------
echo.

if exist "%~dp0app\index.html" goto files_ok
echo  The app files are missing next to this installer.
echo  Extract the whole zip to a folder first, then run Install.bat from there.
echo.
pause
exit /b 1
:files_ok

set "DEST=%LOCALAPPDATA%\Programs\Transcriber"
set "HAVE_WINGET="
where winget >nul 2>nul && set "HAVE_WINGET=1"

rem ---- 1. Node.js (runs the app on this computer)
set "HAVE_NODE="
where node >nul 2>nul && set "HAVE_NODE=1"
if exist "%ProgramFiles%\nodejs\node.exe" set "HAVE_NODE=1"
if defined HAVE_NODE goto node_done
echo  [1/4] Node.js is not installed. Downloading it now...
if not defined HAVE_WINGET goto node_manual
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
if exist "%ProgramFiles%\nodejs\node.exe" goto node_done
:node_manual
echo.
echo  Node.js could not be installed automatically.
echo  Install it from https://nodejs.org and run Install.bat again.
echo.
pause
exit /b 1
:node_done
echo  [1/4] Node.js is ready.

rem ---- 2. Google Chrome (does the speech recognition)
set "HAVE_CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "HAVE_CHROME=1"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "HAVE_CHROME=1"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "HAVE_CHROME=1"
if defined HAVE_CHROME goto chrome_done
echo  [2/4] Google Chrome is not installed. Downloading it now...
if not defined HAVE_WINGET goto chrome_manual
winget install --id Google.Chrome -e --source winget --accept-source-agreements --accept-package-agreements
if not errorlevel 1 goto chrome_done
:chrome_manual
echo.
echo  Google Chrome could not be installed automatically.
echo  The app will try Microsoft Edge instead. For best results install Chrome
echo  from https://www.google.com/chrome and start the app again.
echo.
:chrome_done
echo  [2/4] Browser check finished.

rem ---- 3. Copy the app
if not exist "%DEST%" mkdir "%DEST%"
xcopy "%~dp0app" "%DEST%\app\" /E /I /Y /Q >nul
xcopy "%~dp0windows" "%DEST%\windows\" /E /I /Y /Q >nul
copy /Y "%~dp0Transcriber.bat" "%DEST%\" >nul
if exist "%~dp0README.md" copy /Y "%~dp0README.md" "%DEST%\" >nul
if exist "%DEST%\app\index.html" goto copy_done
echo  Could not copy the app to %DEST%
pause
exit /b 1
:copy_done
echo  [3/4] App installed to %DEST%

rem ---- 4. Desktop icon
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\windows\make-shortcut.ps1" >nul
echo  [4/4] Desktop icon created.

echo.
echo  Done. Starting Transcriber...
echo  From now on, open it with the Transcriber icon on your desktop.
echo.
start "" /min cmd /c "%DEST%\Transcriber.bat"
pause
