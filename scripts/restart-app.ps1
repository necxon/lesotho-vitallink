# scripts/restart-app.ps1 -- Force-stop and relaunch the OpenSRP app on the running emulator
$adb     = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$PACKAGE = "org.smartregister.opensrp"

$device = (& $adb devices | Select-String "^\S+\s+device$" | Select-Object -First 1) -replace '\s+device.*', ''
if (-not $device) { Write-Error "No device/emulator connected"; exit 1 }

Write-Host "Stopping $PACKAGE on $device..." -ForegroundColor Yellow
& $adb -s $device shell am force-stop $PACKAGE
Start-Sleep 2

Write-Host "Launching $PACKAGE..." -ForegroundColor Cyan
& $adb -s $device shell monkey -p $PACKAGE -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host "Done." -ForegroundColor Green
