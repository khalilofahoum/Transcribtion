@echo off
rem Starts the Transcriber app in its own window. Requires Node.js and Google Chrome (or Edge).
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
if /i "%NODE%"=="node" goto run
if exist "%NODE%" goto run
echo Node.js was not found. Run Install.bat, or install Node.js from https://nodejs.org
pause
exit /b 1
:run
start "Transcriber" /min "%NODE%" "%~dp0windows\server.js"
