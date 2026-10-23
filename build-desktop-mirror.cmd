@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "BUN_CONFIG_REGISTRY=https://registry.npmmirror.com"
set "NPM_CONFIG_REGISTRY=https://registry.npmmirror.com"

echo 使用 npmmirror 国内镜像：Electron / electron-builder / npm / Bun。
echo.

call "%~dp0build-desktop.cmd" %*
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%
