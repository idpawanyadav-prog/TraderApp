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

:: Kill any existing python instance to free port 5000
echo [INFO] Stopping any existing Python server...
taskkill /IM python.exe /F >nul 2>&1

echo [INFO] Using %PYTHON%
"%PYTHON%" -V
echo [INFO] Starting TraderApp on http://127.0.0.1:5000/
echo [INFO] Press Ctrl+C to stop the server.
echo.

:: Run the app in a new window and open the browser automatically
start "TraderApp" cmd /c ""%PYTHON%" app.py"

:: Wait a moment for the server to initialize before opening the browser
ping 127.0.0.1 -n 4 >nul
start http://127.0.0.1:5000/

echo.
echo [INFO] Server started in a new terminal window.
echo [INFO] Opening http://127.0.0.1:5000/ in your browser.
echo [INFO] Press Ctrl+C in the server window to stop it.
exit /b 0
