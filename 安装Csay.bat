@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
    echo.
    echo 安装失败，请查看上面的错误。
) else (
    echo.
    echo 安装完成。请新开一个终端，运行 csay 你的程序.csay
)
pause
