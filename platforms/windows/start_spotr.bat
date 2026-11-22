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

set "CORE_DIR=..\..\core"
if not exist "%CORE_DIR%\index.html" set "CORE_DIR=."

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" cmd /c "timeout /t 2 /nobreak >nul & start \"\" \"http://localhost:8080\""
    if exist "server.py" (
        python server.py 8080 %*
    ) else (
        python -m http.server 8080 --bind 127.0.0.1 --directory "%CORE_DIR%"
    )
    goto :eof
)

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" cmd /c "timeout /t 2 /nobreak >nul & start \"\" \"http://localhost:8080\""
    if exist "server.py" (
        py server.py 8080 %*
    ) else (
        py -m http.server 8080 --bind 127.0.0.1 --directory "%CORE_DIR%"
    )
    goto :eof
)

where npx >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" cmd /c "timeout /t 2 /nobreak >nul & start \"\" \"http://localhost:8080\""
    npx serve -l 8080 "%CORE_DIR%"
    goto :eof
)

echo [ERROR] Neither Python nor Node.js was found on this system.
echo Install Python (https://python.org) or use the Chrome PWA install.
pause
