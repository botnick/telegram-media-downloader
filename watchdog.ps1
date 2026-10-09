# Native launcher (Windows). Use a Windows service or scheduled task for
# restart supervision; this script never prompts or retries.
#
# Upgrading from 2.x by `git pull`: there is no Node app any more. When
# core-service\tgdl-server.exe is missing or older than this checkout, the
# matching release archive is downloaded, checked against the release
# SHA256SUMS and installed. Set TGDL_SERVER_BIN to use your own build.
$ErrorActionPreference = 'Stop'
$Repo = if ($env:TGDL_RELEASE_REPO) { $env:TGDL_RELEASE_REPO } else { 'botnick/telegram-media-downloader' }
$ServerBinary = if ($env:TGDL_SERVER_BIN) { $env:TGDL_SERVER_BIN } else {
    Join-Path $PSScriptRoot 'core-service/tgdl-server.exe'
}

function Get-SourceVersion {
    $file = Join-Path $PSScriptRoot 'core-service/internal/version/app.go'
    $m = Select-String -LiteralPath $file -Pattern '^var AppVersion = "(.*)"$'
    if ($m) { return $m.Matches[0].Groups[1].Value }
    return ''
}

function Install-Release([string]$Version) {
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } default { 'amd64' } }
    $archive = "tgdl-server-v$Version-windows-$arch.tar.gz"
    $base = "https://github.com/$Repo/releases/download/v$Version"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Write-Host "Downloading tgdl-server $Version (windows/$arch)..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile (Join-Path $tmp $archive)
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')
        $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { ($_ -split '\s+')[1] -in @($archive, "*$archive") } | Select-Object -First 1
        $expected = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $tmp $archive)).Hash.ToLower()
        if (-not $expected -or $expected -ne $actual) { throw "Checksum mismatch for $archive; refusing to install." }
        tar -xzf (Join-Path $tmp $archive) -C $tmp tgdl-server.exe
        if ($LASTEXITCODE -ne 0) { throw "Could not extract $archive" }
        Move-Item -Force -LiteralPath (Join-Path $tmp 'tgdl-server.exe') -Destination $ServerBinary
    } finally {
        Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
}

if (-not $env:TGDL_SERVER_BIN) {
    $want = Get-SourceVersion
    $have = ''
    if (Test-Path -LiteralPath $ServerBinary -PathType Leaf) {
        try { $have = ((& $ServerBinary version) -split '\s+')[1] } catch { $have = '' }
    }
    if ($want -and $have -ne $want) {
        try {
            Install-Release $want
        } catch {
            if (Test-Path -LiteralPath $ServerBinary -PathType Leaf) {
                Write-Warning "$($_.Exception.Message) Keeping the existing tgdl-server $have."
            } else {
                Write-Error "tgdl-server is missing and could not be downloaded: $($_.Exception.Message) Build with: go -C core-service build -o tgdl-server.exe ./cmd/tgdl-server"
                exit 127
            }
        }
    }
}
if (-not (Test-Path -LiteralPath $ServerBinary -PathType Leaf)) {
    Write-Error "tgdl-server is missing: $ServerBinary"
    exit 127
}
if (-not $env:TGDL_DATA_DIR) {
    $env:TGDL_DATA_DIR = Join-Path $PSScriptRoot 'data'
}
& $ServerBinary @args
exit $LASTEXITCODE
