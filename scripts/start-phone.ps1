# scripts/start-phone.ps1
# Full startup: both Docker stacks + nginx fix + ADB reverse on physical phone + install + launch.
#
# Usage:
#   .\scripts\start-phone.ps1                  -- start stacks, reverse ports, launch app
#   .\scripts\start-phone.ps1 -Fresh           -- also clears app data (forces re-login + re-sync)
#   .\scripts\start-phone.ps1 -SkipDocker      -- skip docker start (stacks already running)
#   .\scripts\start-phone.ps1 -SkipInstall     -- skip APK reinstall (app already on phone)
#   .\scripts\start-phone.ps1 -NoLogcat        -- don't tail logcat after launch
#
# Default APK: bkm-phone.apk (project root). Rebuild with:
#   cd android\fhircore\android && .\gradlew :quest:assembleOpensrpDebug --no-daemon
#   copy quest\build\outputs\apk\opensrp\debug\quest-opensrp-debug.apk ..\..\..\bkm-phone.apk

param(
    [string]$Apk        = "$PSScriptRoot\..\bkm-phone.apk",
    [switch]$Fresh,       # clear app data before launch (forces login + full re-sync)
    [switch]$SkipDocker,  # skip docker compose start
    [switch]$SkipInstall, # skip APK install
    [switch]$NoLogcat     # don't tail logcat
)

$ROOT    = Split-Path $PSScriptRoot -Parent
$LMIS    = Resolve-Path "$ROOT\..\openlmis-ref-distro" -ErrorAction SilentlyContinue
$ADB     = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$PACKAGE = "org.smartregister.opensrp"

function log  { param($m) Write-Host "[start] $m" -ForegroundColor Cyan }
function ok   { param($m) Write-Host "[start] $m" -ForegroundColor Green }
function warn { param($m) Write-Host "[start] WARNING: $m" -ForegroundColor Yellow }

# ── 1. Docker stacks ──────────────────────────────────────────────────────────
if (-not $SkipDocker) {
    if (-not $LMIS) { warn "openlmis-ref-distro not found at $ROOT\..\openlmis-ref-distro"; exit 1 }

    log "Starting OpenLMIS stack..."
    Push-Location $LMIS
    docker compose start
    Pop-Location

    log "Starting main sandbox stack..."
    Push-Location $ROOT
    docker compose start
    Pop-Location

    # ── 2. Fix nginx (consul-template renders broken config on restart) ────────
    log "Waiting for nginx container..."
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        $state = docker inspect openlmis-ref-distro-nginx-1 --format "{{.State.Running}}" 2>$null
        if ($state -eq "true") { break }
        Start-Sleep 2
    }
    Start-Sleep 4   # let consul-template finish its (broken) initial render

    log "Applying static nginx config (bypasses consul-template DNS failure)..."
    python3 "$ROOT\scripts\gen_openlmis_nginx.py" > "$LMIS\config\nginx\openlmis-default.conf"
    docker exec openlmis-ref-distro-nginx-1 nginx -s reload
    ok "nginx reloaded."

    # ── 3. Wait for OpenLMIS auth ─────────────────────────────────────────────
    log "Waiting for OpenLMIS auth (up to 5 min)..."
    $deadline = (Get-Date).AddSeconds(300)
    $authOk   = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest "http://localhost:8082/api/oauth/token" -Method POST `
                -Body "grant_type=password&username=admin&password=password" `
                -Headers @{ Authorization = "Basic dXNlci1jbGllbnQ6Y2hhbmdlbWU=" } `
                -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $authOk = $true; break }
        } catch {}
        Start-Sleep 5
    }
    if ($authOk) { ok "OpenLMIS auth ready." } else { warn "OpenLMIS auth timed out — continuing anyway." }

    # ── 4. Wait for HAPI FHIR ────────────────────────────────────────────────
    log "Waiting for HAPI FHIR (up to 2 min)..."
    $deadline = (Get-Date).AddSeconds(120)
    $fhirOk   = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest "http://localhost:8079/fhir/metadata" `
                -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $fhirOk = $true; break }
        } catch {}
        Start-Sleep 3
    }
    if ($fhirOk) { ok "HAPI FHIR ready." } else { warn "HAPI FHIR timed out — continuing anyway." }

    ok "Stack ready."
    Write-Host ""
    Write-Host "  OpenHIM:   http://localhost:9000" -ForegroundColor DarkCyan
    Write-Host "  OpenLMIS:  http://localhost:8082" -ForegroundColor DarkCyan
    Write-Host "  DHIS2:     http://localhost:8081" -ForegroundColor DarkCyan
    Write-Host ""
}

# ── 5. ADB: find physical device ─────────────────────────────────────────────
if (-not (Test-Path $ADB)) {
    warn "ADB not found at $ADB"
    exit 0
}

$deviceLine = (& $ADB devices | Select-String "(\S+)\s+device$" | Select-Object -First 1)
$serial     = if ($deviceLine) { ($deviceLine.ToString().Trim() -replace '\s+device.*', '') } else { $null }

if (-not $serial) {
    warn "No Android device connected."
    warn "Connect phone via USB with USB debugging enabled, then re-run."
    exit 0
}

ok "Device: $serial"
$s = @("-s", $serial)

# ── 6. ADB reverse port forwarding ───────────────────────────────────────────
log "Setting up ADB reverse port forwarding..."
# IMPORTANT: phone:8079 → host:8088 (fhir-proxy), NOT 8079 (HAPI FHIR direct).
# The app's FHIR_BASE_URL uses :8079 but fhir-proxy on :8088 intercepts
# PractitionerDetail, QR mirrors, and bundle-sync before proxying to HAPI FHIR.
& $ADB @s reverse tcp:8079 tcp:8088 | Out-Null   # FHIR → fhir-proxy
& $ADB @s reverse tcp:8088 tcp:8088 | Out-Null   # pagination Bundle links
& $ADB @s reverse tcp:8083 tcp:8083 | Out-Null   # Keycloak
& $ADB @s reverse tcp:5001 tcp:5001 | Out-Null   # OpenHIM channel
ok "Forwarded: phone:8079→host:8088 (fhir-proxy)  8083 (Keycloak)  5001 (OpenHIM)"

# ── 7. Install APK ────────────────────────────────────────────────────────────
if (-not $SkipInstall) {
    if (-not (Test-Path $Apk)) {
        warn "APK not found: $Apk"
        warn "Build it with:"
        warn "  cd android\fhircore\android"
        warn "  .\gradlew :quest:assembleOpensrpDebug --no-daemon"
        warn "  copy quest\build\outputs\apk\opensrp\debug\quest-opensrp-debug.apk ..\..\..\bkm-phone.apk"
    } else {
        if ($Fresh) {
            log "Clearing app data..."
            & $ADB @s shell pm clear $PACKAGE | Out-Null
        }
        log "Installing $([System.IO.Path]::GetFileName($Apk))..."
        & $ADB @s install --no-incremental -r $Apk
        if ($LASTEXITCODE -ne 0) { Write-Error "Install failed"; exit 1 }
        ok "APK installed."
    }
}

# ── 8. Launch ─────────────────────────────────────────────────────────────────
log "Launching $PACKAGE..."
& $ADB @s shell monkey -p $PACKAGE -c android.intent.category.LAUNCHER 1 | Out-Null
ok "App launched."

# ── 9. Logcat ─────────────────────────────────────────────────────────────────
if (-not $NoLogcat) {
    & $ADB @s logcat -c | Out-Null
    $appPid = $null
    for ($i = 0; $i -lt 15; $i++) {
        $raw    = (& $ADB @s shell pidof $PACKAGE 2>$null)
        $appPid = "$raw".Trim() -replace '\s.*', ''
        if ($appPid -match '^\d+$') { break }
        Start-Sleep 1
    }
    if ($appPid -match '^\d+$') {
        Write-Host "[start] Logcat (PID $appPid) — Ctrl+C to stop" -ForegroundColor Cyan
        & $ADB @s logcat --pid=$appPid
    } else {
        Write-Host "[start] Logcat — Ctrl+C to stop" -ForegroundColor Cyan
        & $ADB @s logcat | Select-String -Pattern "opensrp|FhirSync|SyncWorker|FhirEngine|OkHttp|ERROR"
    }
}
