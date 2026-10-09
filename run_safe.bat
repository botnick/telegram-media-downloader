@echo off
setlocal
if not defined TGDL_SERVER_BIN set "TGDL_SERVER_BIN=%~dp0core-service\tgdl-server.exe"
if not exist "%TGDL_SERVER_BIN%" (
    >&2 echo tgdl-server is missing. Build with go -C core-service build -o tgdl-server.exe ./cmd/tgdl-server
    exit /b 127
)
if not defined TGDL_DATA_DIR set "TGDL_DATA_DIR=%~dp0data"
"%TGDL_SERVER_BIN%" %*
exit /b %ERRORLEVEL%
