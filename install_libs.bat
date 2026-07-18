@echo off
echo Installing TraderApp dependencies into local libs folder...
cd /d "%~dp0"
set "PYTHON_DIR=%~dp0python36"
set "PYTHON_EXE=%PYTHON_DIR%\python.exe"

if exist "%PYTHON_EXE%" (
    set "PYTHON=%PYTHON_EXE%"
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

"%PYTHON%" -m pip install -r requirements.txt --target=libs --upgrade
echo.
echo Done! All libraries installed in .\libs\
pause
