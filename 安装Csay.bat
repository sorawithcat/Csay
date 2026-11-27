@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
    echo.
    echo Installation failed. See the error above.
) else (
    echo.
    echo Installed. Open a new terminal and run: csay your-program.csay
)
pause
