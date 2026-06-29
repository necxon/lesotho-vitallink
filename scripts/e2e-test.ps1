# e2e-test.ps1 — PowerShell launcher for the bash e2e test script.
# Finds Git Bash and runs scripts/e2e-test.sh through it.
#
# Usage (from repo root in PowerShell):
#   .\scripts\e2e-test.ps1
#   .\scripts\e2e-test.ps1 --verbose

param([switch]$Verbose)

$candidates = @(
    "$env:LOCALAPPDATA\Programs\Git\usr\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe",
    "C:\Program Files\Git\usr\bin\bash.exe",
    "C:\Program Files\Git\bin\bash.exe",
    "C:\Program Files (x86)\Git\usr\bin\bash.exe"
)

$bash = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $bash) {
    Write-Error "Git Bash not found. Install Git for Windows from https://git-scm.com"
    exit 1
}

$script = Join-Path $PSScriptRoot "e2e-test.sh"
$args = if ($Verbose) { @("--verbose") } else { @() }

& $bash $script @args
exit $LASTEXITCODE
