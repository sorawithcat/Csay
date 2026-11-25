@echo off
rem Csay editor: opens a local web editor for .csay files.
rem   editor.bat              open editor (no file is created automatically)
rem   editor.bat MyProgram.csay    edit another file
rem Close this window to quit the editor.
setlocal
chcp 65001 >nul
set "CSAY_HOME=%~dp0"

if "%~1"=="" (
    node "%CSAY_HOME%tools\editor.mjs"
) else (
    node "%CSAY_HOME%tools\editor.mjs" %*
)

echo.
echo Editor closed.
pause
