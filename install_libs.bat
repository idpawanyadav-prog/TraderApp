@echo off
echo Installing TraderApp dependencies into local libs folder...
cd /d "%~dp0"

call "%~dp0find_python.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

echo [INFO] Using %PYTHON%
"%PYTHON%" -V

echo [INFO] Clearing old vendored packages in .\libs\
if exist "%~dp0libs" (
    rmdir /s /q "%~dp0libs"
)
mkdir "%~dp0libs"

"%PYTHON%" -m pip install -r requirements.txt --target=libs --upgrade --force-reinstall --ignore-installed
if errorlevel 1 (
    echo [ERROR] pip install failed.
    pause
    exit /b 1
)

echo.
echo Done! All libraries installed in .\libs\
pause
