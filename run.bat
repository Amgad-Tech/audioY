@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>&1 && (set PY=py -3) || (set PY=python)

%PY% -c "import aiohttp, numpy, pyaudiowpatch, pystray, qrcode" >nul 2>&1 || (
  echo Installing dependencies, this only happens once.
  %PY% -m pip install -r requirements.txt || goto :failed
)

start "" %PY%w audioY.pyw
goto :eof

:failed
echo.
echo Could not install the dependencies. Is Python 3.9 or newer on PATH?
pause
