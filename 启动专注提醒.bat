@echo off
set "PY=C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
set "PYW=C:\Users\HP\AppData\Local\Programs\Python\Python313\pythonw.exe"
if exist "%PYW%" (
  start "" "%PYW%" "%~dp0server.py"
  exit /b
)
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0server.py"
pause
