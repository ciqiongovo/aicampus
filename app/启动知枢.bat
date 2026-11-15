@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 清掉开发工具注入的变量，否则 Electron 会以 Node 模式静默退出（表现为"双击没反应"）
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
    echo [ERROR] 没找到 Electron 运行时，请先执行：npm install
    pause
    exit /b 1
)

echo.
echo  知枢  ZhiShu
echo  ------------------------------------------------
echo   1 = 开发模式（热更新）
echo   2 = 启动构建版（默认，5 秒后自动执行）
echo   3 = 重新构建并启动
echo  ------------------------------------------------
choice /C 123 /N /T 5 /D 2 /M "请选择 [1,2,3]: "

if errorlevel 3 goto rebuild
if errorlevel 2 goto launch
if errorlevel 1 goto dev

:dev
call "%~dp0node_modules\.bin\electron-vite.CMD" dev
goto end

:rebuild
call "%~dp0node_modules\.bin\electron-vite.CMD" build
if errorlevel 1 (
    echo [ERROR] 构建失败，请看上面的输出。
    pause
    exit /b 1
)
goto launch

:launch
if not exist "%~dp0out\main\index.js" (
    echo 没有构建产物，先构建一次……
    call "%~dp0node_modules\.bin\electron-vite.CMD" build
    if errorlevel 1 (
        echo [ERROR] 构建失败。
        pause
        exit /b 1
    )
)
start "知枢" "%ELECTRON_EXE%" "%~dp0."
echo 已启动。关闭窗口会缩到托盘。
goto end

:end
endlocal
