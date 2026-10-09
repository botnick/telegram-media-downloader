# Compatibility filename for the native launcher. Use a Windows service or
# scheduled task for restart supervision; this script never prompts or retries.
$ErrorActionPreference = 'Stop'
$ServerBinary = if ($env:TGDL_SERVER_BIN) { $env:TGDL_SERVER_BIN } else {
    Join-Path $PSScriptRoot 'core-service/tgdl-server.exe'
}
if (-not (Test-Path -LiteralPath $ServerBinary -PathType Leaf)) {
    Write-Error "tgdl-server is missing: $ServerBinary. Build with go -C core-service build -o tgdl-server.exe ./cmd/tgdl-server"
    exit 127
}
if (-not $env:TGDL_DATA_DIR) {
    $env:TGDL_DATA_DIR = Join-Path $PSScriptRoot 'data'
}
& $ServerBinary @args
exit $LASTEXITCODE
