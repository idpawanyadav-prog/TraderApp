@echo off
title TraderApp Server
color 0A

echo ============================================
echo   TraderApp - Starting Server...
echo ============================================
echo.

:: Change to the project directory
cd /d "%~dp0"

:: Prefer a bundled Python 3.6 inside this folder; then fall back to the original install path.
set "PYTHON_DIR=%~dp0python36"
set "PYTHON_EXE=%PYTHON_DIR%\python.exe"
set "FALLBACK_PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python36\python.exe"

if exist "%PYTHON_EXE%" (
    set "PYTHON=%PYTHON_EXE%"
) else if exist "%FALLBACK_PYTHON_EXE%" (
    set "PYTHON=%FALLBACK_PYTHON_EXE%"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] No Python interpreter found.
        echo Please install Python 3.6 or keep the bundled python36 folder with python.exe.
        pause
        exit /b 1
    )
    for /f "tokens=1* delims=" %%A in ('where python 2^>nul') do (
        set "PYTHON=%%A"
        goto :found_python
    )
)

:found_python
if not exist "%PYTHON%" (
    echo [ERROR] Python interpreter not found.
    echo Expected bundled runtime at %PYTHON_EXE% or a Python 3.6 installation on PATH.
    pause
    exit /b 1
)

:: Kill any existing python instance to free port 5000
echo [INFO] Stopping any existing Python server...
taskkill /IM python.exe /F >nul 2>&1

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
