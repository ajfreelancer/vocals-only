@echo off
title Install Vocals Only
cd /d "%~dp0"
echo.
echo  Vocals Only - one-time setup (needs internet, takes a few minutes)
echo.
set PY=
where py >nul 2>nul && set PY=py -3
if "%PY%"=="" where python >nul 2>nul && set PY=python
if "%PY%"=="" (
  echo  Python was not found. Install Python 3.10 to 3.13 from https://www.python.org/downloads/
  echo  and tick "Add python.exe to PATH", then run this file again.
  pause
  exit /b 1
)
%PY% setup.py %*
if errorlevel 1 (
  echo.
  echo  Setup did not finish. Read the message above, fix it, and run this file again.
  pause
  exit /b 1
)
pause
