@echo off
chcp 65001 >nul
title Remote Commander (Desktop)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install from https://nodejs.org/ first.
    pause
    exit /b 1
)

if not exist node_modules\electron (
    echo [Setup] First run, installing Electron and dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [Start] Launching Remote Commander desktop window...
call npx electron .
echo.
echo [Stopped] Desktop app has exited.
pause
