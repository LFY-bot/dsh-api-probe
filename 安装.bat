@echo off
setlocal enabledelayedexpansion
rem ===================================================================
rem  dsh-api-probe installer
rem
rem  This file is intentionally ASCII-only. Batch files are decoded with
rem  the console code page, so non-ASCII text here breaks on any machine
rem  whose locale is not the one it was written under. Chinese users:
rem  see README.md for what each step means.
rem ===================================================================
title Install dsh-api-probe

set "PLUGIN_DIR=%~dp0"

echo ==========================================
echo   dsh-api-probe - install
echo ==========================================
echo.

rem ---------------------------------------------------------------
rem Locate dsh.cmd. Never hard-code a path: it only works on the one
rem machine it was written on. Order: DSH_CLI env var, PATH, then the
rem usual install locations.
rem ---------------------------------------------------------------
if not defined DSH_CLI call :detect_cli

if not defined DSH_CLI (
	echo [x] Could not find dsh.cmd, the DeepSeek Harness CLI.
	echo.
	echo     None of the usual install locations matched. Point at it
	echo     manually and run this file again, for example:
	echo.
	echo         set DSH_CLI=D:\path\to\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
	echo.
	pause
	exit /b 1
)

echo   Using CLI: %DSH_CLI%
echo.

echo Installing, please wait...
echo.

call "%DSH_CLI%" plugin --profile desktop add link:"%PLUGIN_DIR:~0,-1%"
if errorlevel 1 (
	echo.
	echo [x] Install failed. Please paste the error above into a GitHub issue.
	echo.
	pause
	exit /b 1
)

echo.
echo ==========================================
echo   Installed.
echo ==========================================
echo.
echo Next: quit DeepSeek Harness completely, then start it again.
echo "API Probe" will then appear in the sidebar.
echo.
pause
exit /b 0


rem -------------------------------------------------------------------
rem :detect_cli - sets DSH_CLI if found, leaves it undefined otherwise
rem -------------------------------------------------------------------
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