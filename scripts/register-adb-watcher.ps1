# scripts/register-adb-watcher.ps1
# Registers a Windows Task Scheduler task that runs adb-reverse.ps1 at every
# logon. The script calls "adb wait-for-device" so it blocks until the phone
# is connected, then applies the correct port mappings automatically.
#
# Run once (as admin not required):
#   .\scripts\register-adb-watcher.ps1
#
# To remove:
#   Unregister-ScheduledTask -TaskName "BKM-ADB-Reverse" -Confirm:$false

$TASK   = "BKM-ADB-Reverse"
$SCRIPT = "$PSScriptRoot\adb-reverse.ps1"

if (-not (Test-Path $SCRIPT)) {
    Write-Error "adb-reverse.ps1 not found at $SCRIPT"; exit 1
}

$action   = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$SCRIPT`""

$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit  (New-TimeSpan -Minutes 10) `
    -MultipleInstances   IgnoreNew `
    -StartWhenAvailable  $true

Register-ScheduledTask `
    -TaskName $TASK `
    -Action   $action `
    -Trigger  $trigger `
    -Settings $settings `
    -Force | Out-Null

Write-Host "Task '$TASK' registered — runs adb-reverse.ps1 at every logon." -ForegroundColor Green
Write-Host "To remove: Unregister-ScheduledTask -TaskName BKM-ADB-Reverse -Confirm:0" -ForegroundColor DarkCyan
