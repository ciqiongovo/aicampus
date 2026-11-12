@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem 清掉开发工具注入的变量，否则 Electron 会当纯 Node 跑
set "ELECTRON_RUN_AS_NODE="
set "DSH_NODE=C:\Users\15800\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node"
if exist "%DSH_NODE%\node.exe" set "PATH=%DSH_NODE%;%PATH%"

for /f "tokens=2 delims=:," %%v in ('findstr /r /c:"\"version\":" package.json') do (
  set "VER=%%v"
  goto gotver
)
:gotver
set "VER=%VER: =%"
set "VER=%VER:"=%"
echo.
echo  构建 InfoAgent %VER% 便携版
echo  ------------------------------------------------
echo.

echo [1/2] electron-vite build ...
call "%~dp0node_modules\.bin\electron-vite.CMD" build
if errorlevel 1 goto fail

echo.
echo [2/2] electron-builder --win portable ...
call "%~dp0node_modules\.bin\electron-builder.CMD" --win portable
if errorlevel 1 goto fail

set "EXE=release\InfoAgent-%VER%-portable.exe"
if not exist "%EXE%" (
  echo [ERROR] 没找到产物 %EXE%
  goto fail
)

set "OUTDIR=release\2026-10-17-portable-v%VER%"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
copy /y "%EXE%" "%OUTDIR%\" >nul
if exist "release\builder-debug.yml" copy /y "release\builder-debug.yml" "%OUTDIR%\" >nul

set "HASH="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%OUTDIR%\InfoAgent-%VER%-portable.exe" SHA256') do if not defined HASH set "HASH=%%h"
set "HASH=%HASH: =%"
echo.
echo SHA-256：%HASH%
> "%OUTDIR%\SHA256SUMS.txt" echo %HASH%  InfoAgent-%VER%-portable.exe

echo.
echo  产物目录：%OUTDIR%
echo  完成。
pause
exit /b 0

:fail
echo.
echo  [ERROR] 构建失败，请看上面的输出。
pause
exit /b 1
