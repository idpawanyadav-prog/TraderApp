@echo off
echo Installing Python 3.14 embeddable into local python314 folder...
cd /d "%~dp0"

set "PY_DIR=%~dp0python314"
if exist "%PY_DIR%\python.exe" (
	echo Python already installed at %PY_DIR%
	"%PY_DIR%\python.exe" -V
	exit /b 0
)

set "PY_VERSION=3.14.7"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
	set "ZIPNAME=python-%PY_VERSION%-embed-arm64.zip"
) else if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
	set "ZIPNAME=python-%PY_VERSION%-embed-amd64.zip"
) else (
	set "ZIPNAME=python-%PY_VERSION%-embed-win32.zip"
)

set "URL=https://www.python.org/ftp/python/%PY_VERSION%/%ZIPNAME%"
set "ZIPPATH=%~dp0%ZIPNAME%"

echo Downloading %URL% ...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIPPATH%' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (
	echo Failed to download %URL%.
	echo Edit this script to change PY_VERSION or download manually from python.org.
	pause
	exit /b 1
)

echo Extracting...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIPPATH%' -DestinationPath '%PY_DIR%' -Force"
if errorlevel 1 (
	echo Extraction failed.
	pause
	exit /b 1
)

del "%ZIPPATH%"

if exist "%PY_DIR%\python.exe" (
	set "PY_EXE=%PY_DIR%\python.exe"
) else (
	echo python.exe not found after extraction.
	dir "%PY_DIR%"
	pause
	exit /b 1
)

REM Embeddable builds isolate site-packages until import site is enabled.
powershell -NoProfile -Command ^
	"$pth = Get-ChildItem -Path '%PY_DIR%' -Filter 'python*._pth' | Select-Object -First 1; ^
	 if ($null -eq $pth) { exit 1 }; ^
	 $text = Get-Content -Raw $pth.FullName; ^
	 $text = $text -replace '(?m)^#import site','import site'; ^
	 if ($text -notmatch '(?m)^import site') { $text = $text.TrimEnd() + \"`r`nimport site`r`n\" }; ^
	 Set-Content -Path $pth.FullName -Value $text -NoNewline"

echo Bootstrapping pip using get-pip.py...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile '%~dp0get-pip.py' -UseBasicParsing"
"%PY_EXE%" "%~dp0get-pip.py"
del "%~dp0get-pip.py"

echo Installed Python at %PY_DIR%.
"%PY_EXE%" -V
echo You can now install libraries with install_libs.bat.
pause
