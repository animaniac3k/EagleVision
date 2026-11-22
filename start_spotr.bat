@echo off
setlocal
title SPOTR Portable Launcher
cd /d "%~dp0"
echo ============================================================
echo   SPOTR - TACTICAL RECON ^& OVERLAY SYSTEM
echo ============================================================
echo.
echo Starting local server at http://localhost:8080 ...
echo Keep this window open while using SPOTR.
echo Tip: Pass --lan to allow iOS/iPad devices on the same Wi-Fi to connect.
echo.

set "SCRIPT_DIR=%~dp0"
set "SERVER_SCRIPT=%SCRIPT_DIR%platforms\windows\server.py"
if not exist "%SERVER_SCRIPT%" set "SERVER_SCRIPT=%SCRIPT_DIR%server.py"

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" cmd /c "timeout /t 2 /nobreak >nul & start \"\" \"http://localhost:8080\""
    if exist "%SERVER_SCRIPT%" (
        python "%SERVER_SCRIPT%" 8080 %*
    ) else (
        python -m http.server 8080 --bind 127.0.0.1 --directory core
    )
    goto :eof
)

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" cmd /c "timeout /t 2 /nobreak >nul & start \"\" \"http://localhost:8080\""
    if exist "%SERVER_SCRIPT%" (
        py "%SERVER_SCRIPT%" 8080 %*
    ) else (
        py -m http.server 8080 --bind 127.0.0.1 --directory core
    )
    goto :eof
)

where npx >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" cmd /c "timeout /t 2 /nobreak >nul & start \"\" \"http://localhost:8080\""
    npx serve -l 8080 core
    goto :eof
)

echo [ERROR] Neither Python nor Node.js was found on this system.
echo Install Python (https://python.org) or use the Chrome PWA install.
pause
