@echo off
setlocal DisableDelayedExpansion
set "installer=%~dp0installer\install.ps1"
if not exist "%installer%" (
    echo Missing installer\install.ps1. Extract the complete plugin ZIP and try again.
    pause
    exit /b 1
)

set "validate="
if "%~1"=="--validate-only" set "validate=-ValidateOnly"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%installer%" %validate%
set "result=%errorlevel%"
if not "%result%"=="0" if not defined validate (
    echo The installer failed to start or exited with an error.
    pause
)
exit /b %result%
