@echo off
setlocal
title SPOTR - Rebuild Android APK

set "ROOT_DIR=%~dp0"
set "ANDROID_DIR=%ROOT_DIR%platforms\android"
set "APK_PATH=%ANDROID_DIR%\app\build\outputs\apk\debug\app-debug.apk"

echo ============================================================
echo   SPOTR - REBUILD ANDROID APK
echo ============================================================
echo.

if not exist "%ANDROID_DIR%\gradlew.bat" (
    echo [ERROR] Android project not found at:
    echo         %ANDROID_DIR%
    goto :done_fail
)

:: Ensure JAVA_HOME or java.exe is available (fall back to Android Studio JBR)
if defined JAVA_HOME (
    if exist "%JAVA_HOME%\bin\java.exe" goto :java_ready
)

where java >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :java_ready

if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" (
    set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
    goto :java_ready
)

if exist "%LOCALAPPDATA%\Programs\Android Studio\jbr\bin\java.exe" (
    set "JAVA_HOME=%LOCALAPPDATA%\Programs\Android Studio\jbr"
    goto :java_ready
)

echo [ERROR] Java JDK not found. Set JAVA_HOME or install Android Studio.
goto :done_fail

:java_ready
echo Syncing /core assets and building debug APK...
echo.

pushd "%ANDROID_DIR%"
call gradlew.bat assembleDebug
set "BUILD_EXIT=%ERRORLEVEL%"
popd

echo.
if %BUILD_EXIT% NEQ 0 (
    echo [ERROR] APK build failed with exit code %BUILD_EXIT%.
    goto :done_fail
)

if not exist "%APK_PATH%" (
    echo [ERROR] Build completed, but APK was not found at:
    echo         %APK_PATH%
    goto :done_fail
)

echo [OK] Android APK rebuilt successfully:
echo      %APK_PATH%
echo.
if /i not "%~1"=="--no-pause" pause
exit /b 0

:done_fail
echo.
if /i not "%~1"=="--no-pause" pause
exit /b 1
