@echo off
setlocal
set "RZCODEX_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%RZCODEX_PWSH%" (
  echo RzCodex requires PowerShell 7 at "%RZCODEX_PWSH%". 1>&2
  exit /b 2
)
if "%~1"=="" (
  "%RZCODEX_PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0rzcodex-launch.ps1"
) else (
  "%RZCODEX_PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0rzcodex-launch.ps1" -CommandArguments %*
)
exit /b %ERRORLEVEL%
