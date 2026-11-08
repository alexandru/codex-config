@echo off
setlocal
git -C "%~dp0.." pull
if errorlevel 1 exit /b %ERRORLEVEL%
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0utils\install.ps1" %*
exit /b %ERRORLEVEL%
