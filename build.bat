@echo off
REM Builds dist\audioY.exe, a single file that needs no Python installed.
setlocal
cd /d "%~dp0"

where py >nul 2>&1 && (set PY=py -3) || (set PY=python)

%PY% -m pip install -r requirements.txt pyinstaller || goto :failed
%PY% scripts\make_icons.py || goto :failed

%PY% -m PyInstaller --noconfirm --clean --onefile --windowed ^
  --name audioY ^
  --icon assets\audioY.ico ^
  --add-data "audioy/web;web" ^
  --hidden-import pystray._win32 ^
  --hidden-import comtypes ^
  --hidden-import comtypes.stream ^
  --collect-binaries pyaudiowpatch ^
  audioY.pyw || goto :failed

echo.
echo Built dist\audioY.exe
goto :eof

:failed
echo.
echo Build failed.
exit /b 1
