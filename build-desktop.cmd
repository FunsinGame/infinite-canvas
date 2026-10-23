@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title 无限画布 - Windows 桌面版构建

set "ROOT=%~dp0"
set "TARGET=dist"
if /i "%~1"=="--dir" set "TARGET=dist:dir"
if /i "%~1"=="dir" set "TARGET=dist:dir"
if /i "%~1"=="--check" goto :check
if /i "%~1"=="mirror" (
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
    set "BUN_CONFIG_REGISTRY=https://registry.npmmirror.com"
    set "NPM_CONFIG_REGISTRY=https://registry.npmmirror.com"
)

echo ============================================================
echo   无限画布 - Windows 桌面版构建
echo ============================================================
echo.

call :require bun "Bun"
if errorlevel 1 goto :fail
call :require node "Node.js"
if errorlevel 1 goto :fail
call :require npm "npm（随 Node.js 安装）"
if errorlevel 1 goto :fail

for /f "delims=" %%v in ('bun --version') do echo   Bun 版本: %%v
for /f "delims=" %%v in ('node --version') do echo   Node 版本: %%v
echo.

echo [1/4] 检查前端依赖...
call :ensure_deps "web\node_modules\vite\package.json" "web" "前端"
if errorlevel 1 goto :fail

echo [2/4] 检查桌面端依赖...
call :ensure_desktop_deps
if errorlevel 1 goto :fail

echo [3/4] 构建前端并生成安装包...
echo.
pushd "desktop"
call bun run %TARGET%
set "BUILD_EXIT=%ERRORLEVEL%"
popd
if not "%BUILD_EXIT%"=="0" (
    echo.
    echo [错误] 构建失败，请查看上面的输出。
    goto :fail
)

set "APP_VERSION="
for /f "usebackq delims=" %%v in ("%ROOT%VERSION") do if not defined APP_VERSION set "APP_VERSION=%%v"
if /i "%APP_VERSION:~0,1%"=="v" set "APP_VERSION=%APP_VERSION:~1%"

echo.
echo [4/4] 构建完成
echo ============================================================
if /i "%TARGET%"=="dist:dir" (
    echo   输出目录: "%ROOT%desktop\release\win-unpacked"
) else (
    echo   安装包:   "%ROOT%desktop\release\infinite-canvas-%APP_VERSION%-setup.exe"
)
echo ============================================================
echo.

echo 构建完成；按任意键关闭窗口。
pause >nul
exit /b 0

:require
where %~1 >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 %~2，请先安装并确保它已加入 PATH。
    exit /b 1
)
exit /b 0

:ensure_deps
if exist "%~1" exit /b 0
echo   未安装 %~3 依赖，正在执行 bun install（首次可能需要几分钟）...
pushd "%~2"
call bun install
set "INSTALL_EXIT=%ERRORLEVEL%"
popd
if not "%INSTALL_EXIT%"=="0" (
    echo [错误] %~3 依赖安装失败。
    exit /b 1
)
if not exist "%~1" (
    echo [错误] %~3 依赖安装后仍未找到 %~1。
    exit /b 1
)
exit /b 0

:ensure_desktop_deps
if exist "desktop\node_modules\.bin\electron.bunx" goto :desktop_install
if not exist "desktop\node_modules\electron\package.json" goto :desktop_install
if not exist "desktop\node_modules\electron-builder\cli.js" goto :desktop_install
if not exist "desktop\node_modules\postject\package.json" goto :desktop_install
exit /b 0

:desktop_install
echo   桌面端依赖不完整，正在使用 npm 重新安装...
pushd "desktop"
call npm ci --no-audit --no-fund
if errorlevel 1 (
    echo   安装失败，清理后改用 npmmirror 镜像执行 npm install 重试...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
    set "BUN_CONFIG_REGISTRY=https://registry.npmmirror.com"
    set "NPM_CONFIG_REGISTRY=https://registry.npmmirror.com"
    if exist "node_modules" rmdir /s /q "node_modules"
    call npm install --no-audit --no-fund
)
set "INSTALL_EXIT=%ERRORLEVEL%"
popd
if not "%INSTALL_EXIT%"=="0" (
    echo [错误] 桌面端依赖安装失败。
    exit /b 1
)
if not exist "desktop\node_modules\electron\package.json" (
    echo [错误] Electron 包没有安装成功。
    exit /b 1
)
if not exist "desktop\node_modules\electron-builder\cli.js" (
    echo [错误] electron-builder 没有安装成功。
    exit /b 1
)
if not exist "desktop\node_modules\postject\package.json" (
    echo [错误] postject 没有安装成功。
    exit /b 1
)
exit /b 0

:check
echo 正在检查构建环境...
call :require bun "Bun"
if errorlevel 1 goto :check_failed
call :require node "Node.js"
if errorlevel 1 goto :check_failed
call :require npm "npm（随 Node.js 安装）"
if errorlevel 1 goto :check_failed
for /f "delims=" %%v in ('bun --version') do echo   Bun 版本: %%v
for /f "delims=" %%v in ('node --version') do echo   Node 版本: %%v
for /f "delims=" %%v in ('npm --version') do echo   npm 版本: %%v
echo 环境检查通过。
exit /b 0

:check_failed
echo 环境检查失败。
exit /b 1

:fail
echo.
echo ============================================================
echo   构建失败
echo ============================================================
echo   请检查：
echo   - 是否已安装 Bun 和 Node.js 22 或更高版本；
echo   - 网络能否下载 Electron，国内网络可以在命令行里设置镜像后重试：
echo       set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo       set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
echo   - 桌面端依赖使用 npm 安装；如果 npm 安装失败，删除 desktop\node_modules 后重试；
echo   - 若打包阶段仍报文件占用或 EPERM，请关闭正在运行的应用和打开的 release 目录后重试；
echo   - 依赖损坏时可以删除 web\node_modules 和 desktop\node_modules 后重试；
echo   - 也可以双击 build-desktop-mirror.cmd 使用国内镜像构建。
echo.
pause
exit /b 1
