@echo off
REM ---------------------------------------------------------------------------
REM Silent installer wrapper for the Purchasing Signing Agent.
REM
REM Usage:
REM   SigningAgent-Setup.bat            (interactive)
REM   SigningAgent-Setup.bat /S         (silent — no prompts)
REM
REM Requirements (must already be installed on the host):
REM   - Node.js LTS    (https://nodejs.org)
REM   - NSSM           (https://nssm.cc/)
REM ---------------------------------------------------------------------------
setlocal
set SILENT=0
if /I "%~1"=="/S" set SILENT=1

set SCRIPT_DIR=%~dp0
set PS1=%SCRIPT_DIR%install-service.ps1

if not exist "%PS1%" (
  echo [ERROR] %PS1% not found. >&2
  exit /b 1
)

if "%SILENT%"=="1" (
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PS1%"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
)
exit /b %ERRORLEVEL%
