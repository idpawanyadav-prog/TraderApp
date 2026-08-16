@echo off
echo Installing TraderApp dependencies into App\libs ...
set "APP_DIR=%~dp0..\App"
cd /d "%APP_DIR%"

call "%~dp0find_python.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

echo [INFO] Using %PYTHON%
"%PYTHON%" -V

echo [INFO] Clearing old vendored packages in App\libs\
if exist "%APP_DIR%\libs" (
    rmdir /s /q "%APP_DIR%\libs"
)
mkdir "%APP_DIR%\libs"

"%PYTHON%" -m pip install -r requirements.txt --target=libs --upgrade --force-reinstall --ignore-installed
if errorlevel 1 (
    echo [ERROR] pip install failed.
    pause
    exit /b 1
)

echo [INFO] Finishing pywin32 so Excel COM works from App\libs\
"%PYTHON%" -c "import vendor_libs; vendor_libs.finish_install()"
if errorlevel 1 (
    echo [WARN] pywin32 post-setup failed. Excel may not attach until you copy a working libs folder.
)

echo.
echo Done! All libraries installed in App\libs\
pause
