@echo off
setlocal
pipx run "%~dp0codex-switch.py" %*
exit /b %ERRORLEVEL%
