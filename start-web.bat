@echo off
chcp 65001 >nul
title Loam (web)
cd /d "%~dp0"
echo.
echo  ============================================
echo   Loam - web UI
echo  ============================================
echo   Open: http://127.0.0.1:3939
echo   Close this window (or Ctrl+C) to stop.
echo.
start "" http://127.0.0.1:3939
call npm start
pause
