# scripts/sync-app.ps1 -- Trigger a pull-to-refresh sync on the running OpenSRP app
$adb    = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$device = (& $adb devices | Select-String "emulator-\d+\s+device" | Select-Object -First 1) -replace '\s+device.*', ''
if (-not $device) { Write-Error "No emulator running"; exit 1 }

Write-Host "Triggering sync on $device..." -ForegroundColor Cyan
# Swipe down from top of screen to pull-to-refresh
& $adb -s $device shell input swipe 540 300 540 900 600
Start-Sleep 2
& $adb -s $device shell input swipe 540 300 540 900 600
Write-Host "Done." -ForegroundColor Green
