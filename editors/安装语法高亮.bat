@echo off
rem Install Csay syntax highlighting into VS Code.
setlocal
chcp 65001 >nul
node "%~dp0install.mjs"
pause
