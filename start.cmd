@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title ClipForge - Local Web

rem Always resolve the checkout relative to this file, including on double-click.
if not exist "%~dp0scripts\start-local.ps1" goto missing_source
cd /d "%~dp0"
if errorlevel 1 goto invalid_directory

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
set "CLIPFORGE_EXIT_CODE=%ERRORLEVEL%"
if not "%CLIPFORGE_EXIT_CODE%"=="0" goto failed
exit /b 0

:missing_source
echo ClipForge source files are missing. Extract the complete ZIP before starting.
set "CLIPFORGE_EXIT_CODE=1"
goto failed

:invalid_directory
echo Cannot open the ClipForge project directory.
set "CLIPFORGE_EXIT_CODE=1"

:failed
echo.
echo ClipForge could not start. Check the error above, then run start.cmd again.
if exist "%~dp0.clipforge\logs\launcher.log" echo Log: "%~dp0.clipforge\logs\launcher.log"
rem Keep double-click failures visible; commands with arguments never pause.
if "%~1"=="" pause
exit /b %CLIPFORGE_EXIT_CODE%
