<#
    .SYNOPSIS
    Smart Watchdog for Telegram Auto-Downloader
    
    .DESCRIPTION
    Runs the Node.js application in a loop.
    - Logs crashes to protection_log.txt
    - Beeps on crash
    - Prevents infinite boot loops (Exponential Backoff)
#>

$Program = "src/index.js"
$Command = "history"
$LogFile = "data/logs/protection_log.txt"
$RetryCount = 0
$MaxRetries = 10
$ResetWindow = 60 # Seconds to reset counter if stable

# Ensure log dir exists
New-Item -ItemType Directory -Force -Path "data/logs" | Out-Null

Write-Host "🛡️  Starting Smart Watchdog..." -ForegroundColor Cyan
write-host "   Target: $Program $Command" -ForegroundColor Gray

function Log-Crash {
    param($code)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $msg = "[$timestamp] Crashed with exit code $code"
    Add-Content -Path $LogFile -Value $msg
    Write-Host "❌ $msg" -ForegroundColor Red
    [console]::Beep(500, 300) # Sound Alert
}

while ($true) {
    $startTime = Get-Date
    
    Write-Host "`n🚀 Launching Process (Attempt #$($RetryCount + 1))..." -ForegroundColor Green
    
    # --- RUN THE APP ---
    node $Program $Command
    # -------------------

    $exitCode = $LASTEXITCODE
    $runningTime = (Get-Date) - $startTime

    if ($exitCode -eq 0) {
        Write-Host "✅ Process finished successfully." -ForegroundColor Green
        break
    }

    # Crash Handling
    Log-Crash $exitCode

    # Intelligent Backoff
    if ($runningTime.TotalSeconds -gt $ResetWindow) {
        $RetryCount = 0 # Reset if it ran stable for a while
    } else {
        $RetryCount++
    }

    if ($RetryCount -ge $MaxRetries) {
        Write-Host "⛔ Too many crashes in short time. Stopping to protect system." -ForegroundColor Red
        Read-Host "Press Enter to exit..."
        break
    }

    $delay = 5 * ($RetryCount + 1)
    if ($delay -gt 60) { $delay = 60 }
    
    Write-Host "⏳ Restarting in $delay seconds..." -ForegroundColor Yellow
    Start-Sleep -Seconds $delay
}
