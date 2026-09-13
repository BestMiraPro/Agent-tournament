@echo off
title Agent Tournament
cd /d "%~dp0"

if not exist "node_modules" (
  echo First run: installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 goto failed
)

call npm start
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Agent Tournament could not start. The message above says why.
pause
exit /b 1
