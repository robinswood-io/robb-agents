@echo off
setlocal
set "BIN_DIR=%~dp0"
if defined CRAFT_SCRIPTS (set "SCRIPTS_DIR=%CRAFT_SCRIPTS%") else (set "SCRIPTS_DIR=%BIN_DIR%..\scripts")
if defined CRAFT_UV (
  set "UV_BIN=%CRAFT_UV%"
) else (
  if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (set "UV_ARCH=arm64") else (set "UV_ARCH=x64")
  set "UV_BIN=%BIN_DIR%win32-%UV_ARCH%\uv.exe"
  if not exist "%BIN_DIR%win32-%UV_ARCH%\uv.exe" set "UV_BIN=uv"
)
if not defined CRAFT_TOOL_SCRIPT (
  echo Missing bundled Python tool script name. 1>&2
  exit /b 127
)
"%UV_BIN%" run --python 3.12 "%SCRIPTS_DIR%\%CRAFT_TOOL_SCRIPT%" %*
