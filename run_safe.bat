@echo off
rem Native launcher (Windows). Downloads the matching tgdl-server release on
rem first run after upgrading from 2.x; see watchdog.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0watchdog.ps1" %*
exit /b %ERRORLEVEL%
