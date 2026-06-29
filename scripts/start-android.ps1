# scripts/start-android.ps1 -- Start Android emulator and install/launch OpenSRP app
# Usage: .\scripts\start-android.ps1 [-Apk <path>] [-Avd <name>] [-Fresh] [-NoLogcat]
#
# Two supported APKs:
#   fhir-lesotho-auth-debug.apk    -- source build patched to SKIP_AUTHENTICATION=false; uses Keycloak login (-Fresh auto-fills it)
#   fhir-lesotho-source-debug.apk  -- source build (SKIP_AUTHENTICATION=true); no login needed
param(
    [string]$Apk      = "$PSScriptRoot\..\fhir-lesotho-auth-debug.apk",
    [string]$Avd      = "OpenSRP_Emulator",
    [switch]$Fresh,     # clears app data before launch; auto-fills Keycloak login if needed
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

# --- 2b. Resolve emulator serial (handles multiple devices/emulators) ---
$deviceSerial = (& $adb devices | Select-String "emulator-\d+\s+device" | Select-Object -First 1) -replace '\s+device.*', ''
if (-not $deviceSerial) { Write-Error "Could not find a running emulator"; exit 1 }
Write-Host "Using device: $deviceSerial" -ForegroundColor DarkCyan
$s = @("-s", $deviceSerial)   # splat arg for all adb calls

# --- 3. Set 3-button navigation (prevents left-edge back gesture conflicting with nav drawer) ---
& $adb @s shell settings put secure navigation_mode 0 | Out-Null
& $adb @s shell settings put global enable_predictive_back 0 | Out-Null

# --- 3b. Forward host ports to emulator ---
Write-Host "Forwarding ports (emulator -> host)..." -ForegroundColor Cyan
foreach ($port in @(8079, 8083, 8088, 5001, 9000)) {
    & $adb @s reverse tcp:$port tcp:$port | Out-Null
}
Write-Host "  Ports forwarded: 8088 (fhir-proxy), 8083 (Keycloak), 8079 (HAPI FHIR), 5001 (OpenHIM)" -ForegroundColor DarkCyan

# --- 3c. Optionally clear app data ---
if ($Fresh) {
    Write-Host "Clearing app data..." -ForegroundColor Yellow
    & $adb @s shell pm clear $PACKAGE | Out-Null
}

# --- 4. Install APK ---
# Debug APKs need zipalign + re-sign before install (resources.arsc must be uncompressed/aligned)
Write-Host "Installing $Apk ..." -ForegroundColor Cyan
$apkToInstall = $Apk
if ($Apk -match "debug") {
    $zipalign  = "$ANDROID_HOME\build-tools\34.0.0\zipalign.exe"
    $apksigner = "$ANDROID_HOME\build-tools\34.0.0\lib\apksigner.jar"
    $keystore  = "$env:USERPROFILE\.android\debug.keystore"
    $aligned   = "$env:TEMP\opensrp-aligned.apk"
    $signed    = "$env:TEMP\opensrp-install.apk"
    Write-Host "  Aligning and re-signing debug APK..." -ForegroundColor DarkCyan
    & $zipalign -f -p 4 $Apk $aligned
    java -jar $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out $signed $aligned
    $apkToInstall = $signed
}
& $adb @s install --no-incremental -r $apkToInstall
if ($LASTEXITCODE -ne 0) { Write-Error "Install failed"; exit 1 }

# --- 5. Launch app ---
Write-Host "Launching app..." -ForegroundColor Cyan
& $adb @s shell monkey -p $PACKAGE -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host "Done. App is running." -ForegroundColor Green

# --- 6. Wait for app PID ---
$appPid = $null
for ($i = 0; $i -lt 20; $i++) {
    $raw = & $adb @s shell pidof $PACKAGE 2>$null
    $appPid = "$raw".Trim() -replace '\s.*', ''
    if ($appPid -match '^\d+$') { break }
    Start-Sleep 1
}
Write-Host "App PID: $appPid" -ForegroundColor Green

# --- 7. Wait / auto-login ---
if ($Fresh) {
    # Fresh start: AppSettingActivity downloads config, then Keycloak login screen appears.
    # Poll uiautomator for two EditText fields (username + password), fill and submit.
    Write-Host "Fresh start -- waiting for Keycloak login screen (up to 120 s)..." -ForegroundColor Cyan
    $KC_USER   = "opensrp-admin"
    $KC_PASS   = "admin"
    $loginDone = $false
    $editPat   = 'class="android\.widget\.EditText"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
    $btnPat    = 'text="(?:Sign In|Log In|Login|SIGN IN)"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'

    for ($i = 0; $i -lt 60; $i++) {
        # If AppMainActivity is already visible (SKIP_AUTHENTICATION build), skip login entirely
        $top = (& $adb @s shell dumpsys activity activities 2>$null | Select-String "topResumedActivity") -join ""
        if ($top -match "AppMainActivity") {
            Write-Host "Main screen already visible (SKIP_AUTHENTICATION build) -- skipping login." -ForegroundColor Green
            $loginDone = $true
            break
        }

        & $adb @s shell uiautomator dump /sdcard/ui_login.xml 2>$null | Out-Null
        $xml = (& $adb @s shell cat /sdcard/ui_login.xml 2>$null) -join ""

        $fields = [regex]::Matches($xml, $editPat)
        if ($fields.Count -ge 2) {
            Write-Host "Login form detected. Filling credentials..." -ForegroundColor Green

            # Username field (first EditText)
            $ux = [int](([int]$fields[0].Groups[1].Value + [int]$fields[0].Groups[3].Value) / 2)
            $uy = [int](([int]$fields[0].Groups[2].Value + [int]$fields[0].Groups[4].Value) / 2)
            & $adb @s shell input tap $ux $uy | Out-Null
            Start-Sleep 1
            & $adb @s shell input keyevent 277 | Out-Null   # KEYCODE_CTRL_A -- select all
            & $adb @s shell input text $KC_USER | Out-Null
            Start-Sleep 1

            # Password field (second EditText)
            $px = [int](([int]$fields[1].Groups[1].Value + [int]$fields[1].Groups[3].Value) / 2)
            $py = [int](([int]$fields[1].Groups[2].Value + [int]$fields[1].Groups[4].Value) / 2)
            & $adb @s shell input tap $px $py | Out-Null
            Start-Sleep 1
            & $adb @s shell input text $KC_PASS | Out-Null
            Start-Sleep 1

            # Submit -- look for Sign In button, fall back to Enter key
            $btnM = [regex]::Match($xml, $btnPat)
            if ($btnM.Success) {
                $bx = [int](([int]$btnM.Groups[1].Value + [int]$btnM.Groups[3].Value) / 2)
                $by = [int](([int]$btnM.Groups[2].Value + [int]$btnM.Groups[4].Value) / 2)
                & $adb @s shell input tap $bx $by | Out-Null
            } else {
                & $adb @s shell input keyevent 66 | Out-Null   # KEYCODE_ENTER
            }

            Write-Host "Credentials submitted. Waiting for main screen..." -ForegroundColor Cyan
            $loginDone = $true
            break
        }
        Start-Sleep 2
    }

    if (-not $loginDone) {
        Write-Warning "Login screen not detected within 120 s -- continuing anyway."
    }

    # Wait for AppMainActivity (sync worker registers on login completion)
    Write-Host "Waiting up to 60 s for main screen..." -ForegroundColor Cyan
    for ($i = 0; $i -lt 30; $i++) {
        $top = (& $adb @s shell dumpsys activity activities 2>$null | Select-String "topResumedActivity") -join ""
        if ($top -match "AppMainActivity") {
            Write-Host "Main screen ready." -ForegroundColor Green
            break
        }
        Start-Sleep 2
    }

    # Re-resolve PID (process may have restarted after login)
    $appPid = $null
    for ($i = 0; $i -lt 10; $i++) {
        $raw = & $adb @s shell pidof $PACKAGE 2>$null
        $appPid = "$raw".Trim() -replace '\s.*', ''
        if ($appPid -match '^\d+$') { break }
        Start-Sleep 1
    }
    Write-Host "App PID after login: $appPid" -ForegroundColor Green
    Write-Host "Waiting 10 s for initial sync to start..." -ForegroundColor Cyan
    Start-Sleep 10
} else {
    Write-Host "Waiting 15 s for app to load configs and sync data..." -ForegroundColor Cyan
    Start-Sleep 15
}

# --- 8. Tail logcat filtered to this app ---
if (-not $NoLogcat) {
    & $adb @s logcat -c

    if ($appPid -match '^\d+$') {
        Write-Host "Logcat (PID $appPid) -- Ctrl+C to stop" -ForegroundColor Cyan
        & $adb @s logcat --pid=$appPid
    } else {
        Write-Host "Warning: could not resolve PID -- showing full logcat" -ForegroundColor Yellow
        & $adb @s logcat | Select-String -Pattern "opensrp|FhirSync|SyncWorker|FhirEngine|OkHttp"
    }
}
