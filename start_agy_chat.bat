@echo off
title Aakalan Agy
cd /d "%~dp0"
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Starting Aakalan Agy desktop...
  call npm start
  goto :eof
)
echo Electron is not installed yet. Starting the web preview instead.
echo For the full app: npm install  then  npm start
echo For the installer EXE: npm run dist:win
echo.
python "%~dp0agy_chat_server.py"
pause
