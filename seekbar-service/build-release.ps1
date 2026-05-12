#Requires -Version 5.1
<#
.SYNOPSIS
    Cross-compile seekbar-service for every supported platform and produce
    zip archives under dist/.

.DESCRIPTION
    Builds server + CLI binaries for Windows, Linux, macOS, and Synology
    DSM, then packages each platform pair into a zip file.

    Usage:
        .\build-release.ps1                  # build all platforms
        .\build-release.ps1 -Targets linux-x64,mac-arm64  # selective

.PARAMETER Targets
    Comma-separated list of target names to build. Omit to build all.
    Valid names: win-x64, win-arm64, linux-x64, linux-arm64, linux-x86,
                 mac-x64, mac-arm64, dsm-x64, dsm-arm64

.PARAMETER Version
    Override the version string injected into the binary. Defaults to
    git describe output or "dev".
#>
param(
    [string[]]$Targets = @(),
    [string]$Version   = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Module  = "github.com/botnick/telegram-media-downloader/seekbar-service"
$Server  = "./cmd/server"
$Cli     = "./cmd/cli"
$BinDir  = "bin"
$DistDir = "dist"

if ($Version -eq "") {
    try {
        $Version = (git describe --tags --always --dirty 2>$null).Trim()
    } catch {}
    if ($Version -eq "") { $Version = "dev" }
}

$LdFlags = "-s -w -X ${Module}/internal/api.ServiceVersion=${Version}"

$null = New-Item -ItemType Directory -Force -Path $BinDir, $DistDir

# Target definitions: name -> (GOOS, GOARCH, exe extension)
$AllTargets = [ordered]@{
    "win-x64"    = @{ OS = "windows"; Arch = "amd64"; Ext = ".exe" }
    "win-arm64"  = @{ OS = "windows"; Arch = "arm64"; Ext = ".exe" }
    "linux-x64"  = @{ OS = "linux";   Arch = "amd64"; Ext = ""     }
    "linux-arm64"= @{ OS = "linux";   Arch = "arm64"; Ext = ""     }
    "linux-x86"  = @{ OS = "linux";   Arch = "386";   Ext = ""     }
    "mac-x64"    = @{ OS = "darwin";  Arch = "amd64"; Ext = ""     }
    "mac-arm64"  = @{ OS = "darwin";  Arch = "arm64"; Ext = ""     }
    "dsm-x64"    = @{ OS = "linux";   Arch = "amd64"; Ext = ""     }
    "dsm-arm64"  = @{ OS = "linux";   Arch = "arm64"; Ext = ""     }
}

if ($Targets.Count -eq 0) {
    $Selected = $AllTargets.Keys
} else {
    foreach ($t in $Targets) {
        if (-not $AllTargets.Contains($t)) {
            Write-Error "Unknown target '$t'. Valid: $($AllTargets.Keys -join ', ')"
            exit 1
        }
    }
    $Selected = $Targets
}

Write-Host "seekbar-service release build -- version: $Version"
Write-Host "Targets: $($Selected -join ', ')"
Write-Host ""

function Build-Target {
    param($Name, $Goos, $Goarch, $Ext)

    $ServerBin = "$BinDir/tgdl-seekbar-${Name}${Ext}"
    $CliBin    = "$BinDir/tgdl-seekbar-cli-${Name}${Ext}"

    Write-Host "  Building ${Name}..."

    $env:CGO_ENABLED = "0"
    $env:GOOS        = $Goos
    $env:GOARCH      = $Goarch

    & go build -trimpath -ldflags $LdFlags -o $ServerBin $Server
    if ($LASTEXITCODE -ne 0) { throw "go build failed for server ($Name)" }

    & go build -trimpath -ldflags $LdFlags -o $CliBin $Cli
    if ($LASTEXITCODE -ne 0) { throw "go build failed for cli ($Name)" }

    # Remove env overrides so subsequent builds are clean.
    Remove-Item Env:\GOOS, Env:\GOARCH -ErrorAction SilentlyContinue

    $ZipPath = "$DistDir/tgdl-seekbar-${Name}.zip"
    Compress-Archive -Force -Path $ServerBin, $CliBin -DestinationPath $ZipPath
    Write-Host "  => $ZipPath"
}

foreach ($name in $Selected) {
    $t = $AllTargets[$name]
    Build-Target -Name $name -Goos $t.OS -Goarch $t.Arch -Ext $t.Ext
}

Write-Host ""
Write-Host "Done. Archives written to ${DistDir}/:"
Get-ChildItem "$DistDir/tgdl-seekbar-*.zip" -ErrorAction SilentlyContinue |
    Select-Object Name, @{N="Size";E={"{0:N0} KB" -f ($_.Length / 1KB)}} |
    Format-Table -AutoSize
