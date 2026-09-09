@echo off
REM ===========================================================================
REM  ONE-CLICK START for the on-site Music Server PC.
REM
REM  Starts the music player, starts the cloud link, and opens the control
REM  panel. Written for a non-technical operator: every branch either fixes
REM  itself or prints a plain-English instruction and waits.
REM
REM  Deliberately refuses to start a second cloud link if one is already
REM  running -- two agents on one machine fight over the same zone queues.
REM ===========================================================================
title Music Server - Connect to Cloud
cd /d "%~dp0"
color 0B

echo.
echo  ==========================================================
echo    MUSIC SERVER  -  connecting to the cloud
echo  ==========================================================
echo.

REM --- Is the cloud link already running? -----------------------------------
netstat -ano | findstr /R /C:":8899 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo  Already connected. Opening the control panel...
  start "" http://127.0.0.1:8899
  echo.
  echo  You can close this window.
  timeout /t 5 /nobreak >nul
  exit /b 0
)

REM --- Step 1: Node.js ------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js is missing.
  echo.
  echo      Install it from https://nodejs.org  ^(pick the LTS button^),
  echo      then run this file again.
  echo.
  pause
  exit /b 1
)
echo  [1/4] Node.js found.

REM --- Step 2: the music player --------------------------------------------
tasklist /FI "IMAGENAME eq MusicServer.PlaybackHost.exe" 2>nul | find /I "MusicServer.PlaybackHost.exe" >nul
if errorlevel 1 (
  if exist "%ProgramFiles%\Music Server\PlaybackHost\MusicServer.PlaybackHost.exe" (
    echo  [2/4] Starting the music player...
    start "" "%ProgramFiles%\Music Server\PlaybackHost\MusicServer.PlaybackHost.exe"
    timeout /t 8 /nobreak >nul
  ) else (
    echo  [!] Music Server is not installed on this PC.
    echo      Run MusicServer.Installer.msi first, then run this file again.
    echo.
    pause
    exit /b 1
  )
) else (
  echo  [2/4] Music player already running.
)

REM --- Step 3: confirm the player answers ----------------------------------
echo  [3/4] Checking the music player...
powershell -NoProfile -Command "try{$r=Invoke-RestMethod 'http://127.0.0.1:8765/api/health' -TimeoutSec 10; if($r.playbackHostOnline){exit 0}else{exit 2}}catch{exit 1}"
if errorlevel 2 (
  echo.
  echo  [!] The music player did not come online.
  echo      Usual cause: a speaker or monitor that a zone uses is unplugged.
  echo      Plug it back in, or open the panel and point that zone at a
  echo      different speaker.
  echo.
)

REM --- Step 4: the cloud link ----------------------------------------------
echo  [4/4] Starting the cloud link...
echo.
echo  ----------------------------------------------------------
echo    Control panel:  http://127.0.0.1:8899
echo.
echo    KEEP THIS WINDOW OPEN. Closing it disconnects the cloud.
echo  ----------------------------------------------------------
echo.
start "" http://127.0.0.1:8899
node bridge.js

echo.
echo  The cloud link stopped. Press any key to close.
pause >nul
