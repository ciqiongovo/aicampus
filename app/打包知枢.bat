@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

rem 版本号直接从 package.json 取，避免两处写死不一致
for /f "tokens=2 delims=:," %%v in ('findstr /r /c:"\"version\":" package.json') do (
  set "VER=%%v"
  goto gotver
)
:gotver
set "VER=%VER: =%"
set "VER=%VER:"=%"

echo.
echo  构建 知枢 %VER% 便携版
echo  ------------------------------------------------
echo.

echo [1/2] electron-vite build ...
call "%~dp0node_modules\.bin\electron-vite.CMD" build
if errorlevel 1 goto fail

echo.
echo [2/2] electron-builder --win portable ...
call "%~dp0node_modules\.bin\electron-builder.CMD" --win portable
if errorlevel 1 goto fail

set "EXE=release\ZhiShu-%VER%-portable.exe"
if not exist "%EXE%" (
  echo [ERROR] 没找到产物 %EXE%
  goto fail
)

set "HASH="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%EXE%" SHA256') do if not defined HASH set "HASH=%%h"
set "HASH=%HASH: =%"

echo.
echo  产物：%~dp0%EXE%
echo  SHA-256：%HASH%
echo.
echo  把这个 exe 拷到任何一台 Windows 电脑双击即可运行，不需要安装，
echo  不需要装 Node。用户数据存在 %%APPDATA%%\ZhiShu\，换新版本不会丢。
echo.
pause
exit /b 0

:fail
echo.
echo  [ERROR] 构建失败，请看上面的输出。
pause
exit /b 1
