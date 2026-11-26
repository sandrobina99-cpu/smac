@echo off
chcp 65001 >nul
setlocal
if "%~1"=="" (
  echo Drag files or folders onto this icon to send them to your Mac.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0smac.ps1" send %*
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" (
  echo Transfer failed. See the message above.
) else (
  echo Transfer finished.
)
pause
exit /b %RESULT%
