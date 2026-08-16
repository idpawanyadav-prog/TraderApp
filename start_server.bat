@echo off
title TraderApp Server
color 0A

echo ============================================
echo   TraderApp - Starting Server...
echo ============================================
echo.

:: Change to the project directory
cd /d "%~dp0"

call "%~dp0find_python.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

:: Free port 5000 only — do not kill every Python process on the PC
echo [INFO] Stopping any TraderApp server on port 5000...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5000" ^| findstr "LISTENING"') do (
    taskkill /PID %%P /F >nul 2>&1
)

echo [INFO] Using %PYTHON%
"%PYTHON%" -V
echo [INFO] Starting TraderApp on http://127.0.0.1:5000/
echo [INFO] Press Ctrl+C in the TraderApp window to stop the server.
echo.

:: cmd /k keeps the window open if app.py crashes, so the error is visible
start "TraderApp" cmd /k ""%PYTHON%" app.py"

:: Wait for the server to bind before opening the browser
ping 127.0.0.1 -n 6 >nul
start http://127.0.0.1:5000/

echo.
echo [INFO] Server is starting in a separate "TraderApp" window.
echo [INFO] If the browser is blank, read that window for the error.
echo [INFO] Missing packages: run install_libs.bat, then this file again.
exit /b 0
