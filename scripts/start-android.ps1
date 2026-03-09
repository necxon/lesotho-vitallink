# scripts/start-android.ps1 — Start Android emulator and install/launch OpenSRP app
# Usage: .\scripts\start-android.ps1 [-Apk <path>] [-Avd <name>] [-Fresh] [-NoLogcat]
param(
    [string]$Apk      = "$PSScriptRoot\..\opensrp-fhir-lesotho.apk",
    [string]$Avd      = "OpenSRP_Emulator",
    [switch]$Fresh,     # clears app data before launch
    [switch]$NoLogcat   # skip opening logcat window
)

$ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$emulator     = "$ANDROID_HOME\emulator\emulator.exe"
$adb          = "$ANDROID_HOME\platform-tools\adb.exe"
$PACKAGE      = "org.smartregister.opensrp"

# --- 1. Validate tools ---
foreach ($tool in $emulator, $adb) {
    if (-not (Test-Path $tool)) { Write-Error "Not found: $tool"; exit 1 }
}
if (-not (Test-Path $Apk)) { Write-Error "APK not found: $Apk"; exit 1 }

# --- 2. Start emulator if not already running ---
$running = & $adb devices | Select-String "emulator-\d+\s+device"
if (-not $running) {
    Write-Host "Starting AVD '$Avd'..." -ForegroundColor Cyan
    Start-Process $emulator -ArgumentList "-avd $Avd -no-snapshot-save"
    Write-Host "Waiting for emulator boot (this can take ~60 s)..."
    & $adb wait-for-device
    $booted = $false
    for ($i = 0; $i -lt 60; $i++) {
        $val = & $adb shell getprop sys.boot_completed 2>$null
        if ($val.Trim() -eq "1") { $booted = $true; break }
        Start-Sleep 2
    }
    if (-not $booted) { Write-Error "Emulator did not boot in time"; exit 1 }
    Write-Host "Emulator ready." -ForegroundColor Green
} else {
    Write-Host "Emulator already running." -ForegroundColor Green
}

# --- 3. Set 3-button navigation (prevents left-edge back gesture conflicting with nav drawer) ---
& $adb shell settings put secure navigation_mode 0 | Out-Null
& $adb shell settings put global enable_predictive_back 0 | Out-Null

# --- 3b. Optionally clear app data ---
if ($Fresh) {
    Write-Host "Clearing app data..." -ForegroundColor Yellow
    & $adb shell pm clear $PACKAGE | Out-Null
}

# --- 4. Install APK ---
Write-Host "Installing $Apk ..." -ForegroundColor Cyan
& $adb install --no-incremental -r $Apk
if ($LASTEXITCODE -ne 0) { Write-Error "Install failed"; exit 1 }

# --- 5. Launch app ---
Write-Host "Launching app..." -ForegroundColor Cyan
& $adb shell monkey -p $PACKAGE -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host "Done. App is running." -ForegroundColor Green

# --- 6. Wait for app PID ---
$appPid = $null
for ($i = 0; $i -lt 20; $i++) {
    $raw = & $adb shell pidof $PACKAGE 2>$null
    $appPid = "$raw".Trim() -replace '\s.*', ''
    if ($appPid -match '^\d+$') { break }
    Start-Sleep 1
}
Write-Host "App PID: $appPid" -ForegroundColor Green

# --- 7. Force sync via WorkManager job scheduler (fires immediately) ---
Write-Host "Waiting 18 s for app to finish loading configs..." -ForegroundColor Cyan
Start-Sleep 18
Write-Host "Triggering immediate sync via WorkManager..." -ForegroundColor Cyan
# Get WorkManager job IDs for this package and force-run them
$jobs = & $adb shell cmd jobscheduler get-job-state $PACKAGE 2>$null
$jobs | Where-Object { $_ -match 'JOB #(\d+)' } | ForEach-Object {
    $jobId = $Matches[1]
    Write-Host "  Force-running job $jobId" -ForegroundColor DarkCyan
    & $adb shell cmd jobscheduler run -f $PACKAGE $jobId 2>$null
}
# Also try the WorkManager background job service directly
& $adb shell cmd jobscheduler run -f $PACKAGE 0 2>$null
& $adb shell cmd jobscheduler run -f $PACKAGE 1 2>$null

# --- 8. Tail logcat filtered to this app ---
if (-not $NoLogcat) {
    & $adb logcat -c

    if ($appPid -match '^\d+$') {
        Write-Host "Logcat (PID $appPid) — Ctrl+C to stop" -ForegroundColor Cyan
        & $adb logcat --pid=$appPid
    } else {
        Write-Host "Warning: could not resolve PID — showing full logcat" -ForegroundColor Yellow
        & $adb logcat | Select-String -Pattern "$PACKAGE|FhirSync|SyncWorker|FhirEngine|OkHttp"
    }
}
