@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found. Please install Node.js 22 or later.
    exit /b 1
)
rem Tell the generated exe not to wait for Enter when launched from a script.
rem NOTE: keep every comment in this file ASCII only. cmd.exe reads .bat as GBK
rem while the file is UTF-8, so a Chinese comment gets split mid-line and the
rem tail is executed as a command.
set "CSAY_NO_PAUSE=1"

node "%~dp0src\cli.ts" %*
exit /b %ERRORLEVEL%