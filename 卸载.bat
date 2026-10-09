@echo off
setlocal enabledelayedexpansion
rem ===================================================================
rem  dsh-api-probe uninstaller
rem
rem  This file is intentionally ASCII-only. Batch files are decoded with
rem  the console code page, so non-ASCII text here breaks on any machine
rem  whose locale is not the one it was written under. Chinese users:
rem  see README.md for what each step means.
rem ===================================================================
title Uninstall dsh-api-probe

rem Same lookup order as the installer.
if not defined DSH_CLI call :detect_cli

if not defined DSH_CLI (
	echo [x] Could not find dsh.cmd, the DeepSeek Harness CLI.
	echo.
	echo     Point at it manually and run this file again, for example:
	echo         set DSH_CLI=D:\path\to\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
	echo.
	pause
	exit /b 1
)

echo ==========================================
echo   dsh-api-probe - uninstall
echo ==========================================
echo.
echo This removes the plugin only. Your saved API addresses and keys
echo are left alone.
echo.

call "%DSH_CLI%" plugin --profile desktop remove dsh-api-probe
if errorlevel 1 (
	echo.
	echo [x] Uninstall failed. Please paste the error above into a GitHub issue.
	echo.
	pause
	exit /b 1
)

echo.
echo Uninstalled. Quit DeepSeek Harness completely and start it again.
echo.
pause
exit /b 0


:detect_cli
for /f "delims=" %%i in ('where dsh.cmd 2^>nul') do (
	if not defined DSH_CLI set "DSH_CLI=%%i"
	goto :cli_from_harness
)

:cli_from_harness
if defined DSH_CLI exit /b 0

for %%p in (
	"%DSH_HOME%"
	"%ProgramFiles%\DeepSeek Harness"
	"%ProgramFiles(x86)%\DeepSeek Harness"
	"%LOCALAPPDATA%\Programs\DeepSeek Harness"
	"%LOCALAPPDATA%\DeepSeek Harness"
	"%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness"
) do (
	if exist "%%~p\resources\runtime\cli\bin\dsh.cmd" (
		set "DSH_CLI=%%~p\resources\runtime\cli\bin\dsh.cmd"
		goto :eof
	)
)
exit /b 0