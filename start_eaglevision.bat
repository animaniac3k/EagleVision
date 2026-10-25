@echo off
title EagleVision Portable Launcher
cd /d "%~dp0"
echo ============================================================
echo   EAGLEVISION - PORTABLE USB CAMERA ^& OVERLAY SYSTEM
echo ============================================================
echo.
echo Starting local server at http://localhost:8080 ...
echo Keep this window open while using EagleVision.
echo.

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" "http://localhost:8080"
    python -m http.server 8080
    goto :eof
)

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" "http://localhost:8080"
    py -m http.server 8080
    goto :eof
)

where npx >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" "http://localhost:8080"
    npx serve -l 8080 .
    goto :eof
)

echo [ERROR] Neither Python nor Node.js was found on this system.
echo Install Python (https://python.org) or use the Chrome PWA install.
pause
