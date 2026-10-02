@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%ComSpec%' -ArgumentList '/c ""%~f0""' -Verb RunAs"
  exit /b
)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found in PATH.
  pause
  exit /b 1
)
echo Starting Zapret Web UI...
echo Open: http://127.0.0.1:40210
node "%~dp0webuiserver.js"
pause
