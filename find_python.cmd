@echo off
REM Locate a Python 3.10+ interpreter and set PYTHON.
set "PYTHON="

if exist "%~dp0python314\python.exe" (
    set "PYTHON=%~dp0python314\python.exe"
    goto :check
)

where py >nul 2>nul
if not errorlevel 1 (
    for /f "delims=" %%A in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do (
        set "PYTHON=%%A"
        goto :check
    )
)

where python >nul 2>nul
if not errorlevel 1 (
    for /f "delims=" %%A in ('where python 2^>nul') do (
        set "PYTHON=%%A"
        goto :check
    )
)

echo [ERROR] No Python interpreter found.
echo Install Python 3.10 or newer from https://www.python.org/downloads/
echo or run install_python.bat to bundle Python 3.14 in this folder.
exit /b 1

:check
"%PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" 2>nul
if errorlevel 1 (
    echo [ERROR] Python 3.10 or newer is required.
    "%PYTHON%" -V
    echo Run install_python.bat, or install a current Python from python.org.
    set "PYTHON="
    exit /b 1
)
exit /b 0
