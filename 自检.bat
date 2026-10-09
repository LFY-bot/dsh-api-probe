@echo off
setlocal enabledelayedexpansion
rem ===================================================================
rem  dsh-api-probe self-check
rem
rem  This file is intentionally ASCII-only. Batch files are decoded with
rem  the console code page, so non-ASCII text here breaks on any machine
rem  whose locale is not the one it was written under. Chinese users:
rem  see README.md for what each stage means.
rem ===================================================================
title dsh-api-probe self-check

echo ==========================================
echo   dsh-api-probe - self check
echo ==========================================
echo.

rem ---------------------------------------------------------------
rem Locate node: PATH first, then the runtime bundled with Harness.
rem ---------------------------------------------------------------
if not defined NODE call :detect_node

if not defined NODE (
	echo [x] Node.js not found.
	echo.
	echo     Tried: node on PATH, and the runtime bundled with Harness.
	echo     Install Node.js 20 or newer. The plugin itself does not need
	echo     Node at runtime - this is only for running the test suites.
	echo.
	pause
	exit /b 1
)

echo [0/4] Syntax check...
"%NODE%" --check "%~dp0lib\index.js"
if errorlevel 1 goto fail
"%NODE%" --check "%~dp0lib\client.js"
if errorlevel 1 goto fail

echo.
echo [1/4] Probe logic and metric definitions...
"%NODE%" "%~dp0tests\run_tests.js"
if errorlevel 1 goto fail

echo.
echo [2/4] Routes and security guard...
"%NODE%" "%~dp0tests\run_route_tests.js"
if errorlevel 1 goto fail

echo.
echo [3/4] Client data and copy contract...
"%NODE%" "%~dp0tests\run_client_tests.mjs"
if errorlevel 1 goto fail

echo.
echo [4/4] Provider preset structure...
"%NODE%" "%~dp0tests\check_providers.mjs"
if errorlevel 1 goto fail

echo.
echo ==========================================
echo   All checks passed
echo ==========================================
echo.
echo The plugin is ready to install.
echo.
pause
exit /b 0

:fail
echo.
echo [x] A check failed. The lines above are the reason.
pause
exit /b 1


rem -------------------------------------------------------------------
rem :detect_node - sets NODE if found, leaves it undefined otherwise
rem -------------------------------------------------------------------
:detect_node
for /f "delims=" %%i in ('where node 2^>nul') do (
	if not defined NODE set "NODE=%%i"
	goto :node_from_harness
)

:node_from_harness
if defined NODE exit /b 0

for %%p in (
	"%DSH_HOME%"
	"%ProgramFiles%\DeepSeek Harness"
	"%ProgramFiles(x86)%\DeepSeek Harness"
	"%LOCALAPPDATA%\Programs\DeepSeek Harness"
	"%LOCALAPPDATA%\DeepSeek Harness"
	"%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness"
) do (
	if exist "%%~p\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
		set "NODE=%%~p\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
		goto :eof
	)
)
exit /b 0