@echo off
rem ---------------------------------------------------------------
rem  Launcher for ChatGPT Web Relay.
rem
rem  Two rules for this file:
rem   1. Keep it ASCII-only. A `set "VAR=<chinese>"` line still gets
rem      cut to pieces by cmd's parser even with CRLF line endings --
rem      `echo <chinese>` is fine, assigning it is not.
rem   2. Keep it CRLF. cmd reads batch files in 512-byte chunks; with
rem      LF-only line endings it loses sync with the start of each line
rem      and runs the fragments as commands. .gitattributes pins this.
rem  Your settings live in config.json (UTF-8, no such problems).
rem ---------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   ChatGPT Web Relay
echo   ----------------------------------------

if not exist "config.json" (
  echo.
  echo   config.json not found. First run:
  echo.
  echo       copy config.json.example config.json
  echo.
  echo   Then open config.json and set CHATGPT_PROJECT_URL.
  echo   See README.md, section "Configuration".
  echo.
  pause
  exit /b 1
)

findstr /C:"xxxxxxxx" config.json >nul && (
  echo.
  echo   config.json still holds the example URL.
  echo   Set CHATGPT_PROJECT_URL to your own project address.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul || (
  echo.
  echo   Node.js not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   First run: installing dependencies...
  echo.
  call npm install || (
    echo.
    echo   npm install failed. Check that Node.js is installed properly.
    echo.
    pause
    exit /b 1
  )
  echo.
)

node server.js

echo.
echo   Server stopped.
pause
