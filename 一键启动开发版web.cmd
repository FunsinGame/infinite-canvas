@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title 无限画布 - Web 开发版

rem 画布数据存在浏览器 IndexedDB，按「协议+主机+端口」隔离：localhost 和 127.0.0.1 是两套数据。
rem 已有画布都在 localhost:3000 下，这里必须固定 localhost，不要改成 127.0.0.1。
set "PORT=3000"
set "URL=http://localhost:%PORT%"

echo ============================================================
echo   无限画布 - Web 开发版
echo ============================================================
echo.

where bun >nul 2>nul
if not errorlevel 1 goto :use_bun
where npm >nul 2>nul
if errorlevel 1 goto :no_runner
set "RUNNER=npm"
goto :runner_ready

:use_bun
set "RUNNER=bun"

:runner_ready
echo [1/2] 检查前端依赖...
if exist "web\node_modules\vite\package.json" goto :deps_ready
echo   未安装前端依赖，正在执行 %RUNNER% install（首次可能需要几分钟）...
pushd "web"
call %RUNNER% install
set "INSTALL_EXIT=%ERRORLEVEL%"
popd
if not "%INSTALL_EXIT%"=="0" (
    echo [错误] 前端依赖安装失败，请检查网络后重试。
    goto :fail
)

:deps_ready
echo [2/2] 启动开发服务器...
echo   地址: %URL%
echo   浏览器会自动打开；按 Ctrl+C 停止服务器。
echo.

start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 120;$i++){ $c=New-Object Net.Sockets.TcpClient; try{ $c.Connect('127.0.0.1',%PORT%); $c.Close(); Start-Process '%URL%'; break }catch{ Start-Sleep -Milliseconds 500 } }"

pushd "web"
call %RUNNER% run dev
set "DEV_EXIT=%ERRORLEVEL%"
popd

echo.
if not "%DEV_EXIT%"=="0" (
    echo [错误] 开发服务器异常退出（代码 %DEV_EXIT%）。
    pause
)
exit /b %DEV_EXIT%

:no_runner
echo [错误] 未找到 Bun 或 npm，请先安装 Node.js 并确保已加入 PATH。
goto :fail

:fail
echo.
echo ============================================================
echo   启动失败
echo ============================================================
echo.
pause
exit /b 1
