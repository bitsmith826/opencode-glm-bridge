@echo off
title OpenCode Dual Frontier Bridge
echo ============================================================
echo     OpenCode Dual Frontier Bridge (OpenAI-Compatible)
echo ============================================================
echo.
echo Model Aktif:
echo   1. glm-5.3-flash-free       [Z.ai Multimodal Reasoning, 200k]
echo   2. deepseek-v4.1-flash-free  [DeepSeek Coding Specialist, 1M]
echo.
echo Konfigurasi untuk Cursor / Cline / Python:
echo   - Base URL : http://127.0.0.1:8318/v1
echo   - API Key  : dummy
echo.
echo Menjalankan server bridge...
echo Tekan Ctrl+C untuk berhenti.
echo.
node server.js
pause
