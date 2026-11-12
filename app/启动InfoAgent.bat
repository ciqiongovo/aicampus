@echo off
setlocal
cd /d "%~dp0"

rem Clear env var injected by dev tools so Electron runs as GUI
set "ELECTRON_RUN_AS_NODE="

rem Prefer DSH bundled Node on PATH for dev/build commands
set "DSH_NODE=C:\Users\15800\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node"
if exist "%DSH_NODE%\node.exe" set "PATH=%DSH_NODE%;%PATH%"

rem Pick Electron runtime: prefer the known-good external copy, fallback to project copy
set "ELECTRON_EXE="
if exist "D:\Projects\InfoAgent\electron-dist\electron.exe" set "ELECTRON_EXE=D:\Projects\InfoAgent\electron-dist\electron.exe"
if not defined ELECTRON_EXE if exist "%~dp0node_modules\electron\dist\electron.exe" set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not defined ELECTRON_EXE (
    echo [ERROR] Electron runtime not found. Run: pnpm install
    pause
    exit /b 1
)

echo.
echo  InfoAgent Launcher
echo  ------------------------------------------------
echo   1 = Dev mode with hot reload
echo   2 = Launch built version (default, auto after 5s)
echo   3 = Rebuild and launch
echo  ------------------------------------------------
choice /C 123 /N /T 5 /D 2 /M "Choose [1,2,3]: "

if errorlevel 3 goto rebuild
if errorlevel 2 goto launch
if errorlevel 1 goto dev

:dev
echo Starting dev mode (first run may take a while)...
call "%~dp0node_modules\.bin\electron-vite.CMD" dev
goto end

:rebuild
echo Building...
call "%~dp0node_modules\.bin\electron-vite.CMD" build
if errorlevel 1 (
    echo [ERROR] Build failed, check output above.
    pause
    exit /b 1
)
echo Build done.
goto launch

:launch
if not exist "%~dp0out\main\index.js" (
    echo No build output found, building first...
    call "%~dp0node_modules\.bin\electron-vite.CMD" build
    if errorlevel 1 (
        echo [ERROR] Build failed.
        pause
        exit /b 1
    )
)
echo Starting InfoAgent ...
start "InfoAgent" "%ELECTRON_EXE%" "%~dp0."
echo Started. Window will appear shortly; closing the window hides to tray.
goto end

:end
endlocal
