# scripts/adb-reverse.ps1
# Waits for a physical Android device then applies the correct ADB reverse
# port mappings for the BKM sandbox.
#
# fhir-proxy is published on host:8079 (docker-compose.yml). It intercepts
# /PractitionerDetail and proxies all other /fhir/* requests to hapi-fhir
# internally — phone:8079 must reverse to host:8079 (fhir-proxy), never
# straight to HAPI (which is internal-only on host:18079).
#
# Run standalone:  .\scripts\adb-reverse.ps1
# Auto-registered: .\scripts\register-adb-watcher.ps1

$adb = if (Test-Path "C:\var\android-sdk\platform-tools\adb.exe") {
    "C:\var\android-sdk\platform-tools\adb.exe"
} elseif (Test-Path "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe") {
    "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
} else {
    $wingetAdb = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Google.PlatformTools_*\platform-tools\adb.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wingetAdb) { $wingetAdb.FullName } else { exit 0 }
}

Write-Host "[adb-reverse] Waiting for device..." -ForegroundColor DarkCyan
& $adb wait-for-device

& $adb reverse tcp:8079 tcp:8079   # FHIR → fhir-proxy (host:8079)
& $adb reverse tcp:8083 tcp:8083   # Keycloak
& $adb reverse tcp:5001 tcp:5001   # OpenHIM channel

Write-Host "[adb-reverse] Done: phone:8079->host:8079  8083->8083  5001->5001" -ForegroundColor Green
