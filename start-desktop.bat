@echo off
chcp 65001 >nul
title Loam (desktop)
cd /d "%~dp0"
echo.
echo  ============================================
echo   Loam - desktop app (Electron)
echo  ============================================
echo   Server: http://127.0.0.1:3939
echo   Close this window (or Ctrl+C) to stop.
echo.
call npm run desktop
pause
