@echo off
setlocal enabledelayedexpansion
title Vocals Only server
cd /d "%~dp0"
set "PYEXE="
if exist "%~dp0venv_path.txt" (
  set /p VENV=<"%~dp0venv_path.txt"
  if exist "!VENV!\Scripts\python.exe" set "PYEXE=!VENV!\Scripts\python.exe"
)
if not defined PYEXE if exist "%~dp0venv\Scripts\python.exe" set "PYEXE=%~dp0venv\Scripts\python.exe"
if not defined PYEXE if exist "D:\vocal-live\venv\Scripts\python.exe" set "PYEXE=D:\vocal-live\venv\Scripts\python.exe"
if not defined PYEXE (
  echo.
  echo  Not installed yet. Double-click "Install.bat" first.
  pause
  exit /b 1
)
"!PYEXE!" server.py %*
pause
