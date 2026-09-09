@echo off
REM ---------------------------------------------------------------------------
REM Starts the CMMP agent on this MusicServer PC and opens its control panel.
REM
REM Put a shortcut to this file in
REM   shell:startup  (Win+R -> shell:startup)
REM so the agent comes back after a reboot, or wrap it with NSSM / Task
REM Scheduler ("Run whether user is logged on or not") to run it as a service.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH. Install Node 18 or newer.
  pause
  exit /b 1
)

start "" http://127.0.0.1:8899
node bridge.js
pause
