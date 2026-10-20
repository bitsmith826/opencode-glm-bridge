@echo off
title OpenCode Frontier Bridge (Port 8318)
cd /d "%~dp0"
echo ============================================================
echo   Starting OpenCode Frontier Bridge on http://127.0.0.1:8318
echo ============================================================
node server.js
pause
