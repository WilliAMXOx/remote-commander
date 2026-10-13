@echo off
chcp 65001 >nul
title Remote Commander
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install from https://nodejs.org/ first.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [Setup] First run detected, installing dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] npm install failed. Please check your network and try again.
        pause
        exit /b 1
    )
)

echo [Start] Remote Commander is starting...
echo [Info]  Browser will open automatically. Close this window to stop the server.
echo =================================================
node server.js
echo.
echo [Stopped] Server has exited.
pause
