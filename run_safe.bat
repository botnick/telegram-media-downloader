@echo off
title Telegram Auto-Downloader (Safe Mode)
color 0A

:start
cls
echo ========================================================
echo   Telegram Auto-Downloader - Auto Restart Mode
echo   Protecting against crashes and network failures...
echo ========================================================
echo.

:: Run the downloader
node src/index.js history

:: Check exit code
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Process crashed with code %ERRORLEVEL%
    echo [!] Restarting in 5 seconds...
    timeout /t 5 >nul
    goto start
)

echo.
echo [!] Process finished normally.
pause
