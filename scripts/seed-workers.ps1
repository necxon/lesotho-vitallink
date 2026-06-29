# scripts/seed-workers.ps1
# Bulk-creates 150 VHW field workers + 150 facility workers via the BKM mediator API.
# Each call creates: Keycloak user, FHIR Practitioner, PractitionerRole, performer mapping.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/seed-workers.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/seed-workers.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts/seed-workers.ps1 -MediatorUrl http://localhost:3000

param(
  [string]$MediatorUrl = "http://localhost:3000",
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"

$PASSWORD      = "Lesotho2025!"
$VHW_OU        = "VilHaMokoe1"
$FACILITY_ID   = "28de536f-b826-4eeb-a3c4-d65221a1120d"
$FACILITY_NAME = "Maseru District Clinic A"
$PROGRAM_ID    = "31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c"
$FACILITY_OU   = "dwx1Yz4BwNX"

$FIRST_NAMES = @(
  "Thabo",      "Lebohang",     "Motlatsi",      "Mpho",       "Teboho",
  "Lehlohonolo","Lefa",         "Ntai",           "Phela",      "Tsepo",
  "Lineo",      "Palesa",       "Refiloe",        "Mamello",    "Boitumelo",
  "Nthabiseng", "Puleng",       "Meisie",         "Mampitsi",   "Thandeka",
  "Moeketsi",   "Bokang",       "Naleli",         "Mokheseng",  "Nthati",
  "Lerato",     "Phomolo",      "Retselisitsoe",  "Katleho",    "Siphiwe"
)

$LAST_NAMES = @(
  "Mokoena",   "Nthabi",      "Lerotholi",   "Mokhethi",   "Thaba",
  "Sehloho",   "Ramaema",     "Masisi",      "Mohale",     "Nkosi",
  "Motlomelo", "Sefularo",    "Khali",       "Moleli",     "Tholoana",
  "Phafoli",   "Moeletsi",    "Ntlhakana",   "Maphike",    "Lefela",
  "Mafoso",    "Setho",       "Majoe",       "Makara",     "Mofokeng",
  "Molapo",    "Sekhonyana",  "Rampa",       "Pitso",      "Litabe"
)

$created = 0
$skipped = 0
$errors  = 0

function Get-WorkerName([int]$index, [int]$lastOffset) {
  $fi = $index % $FIRST_NAMES.Count
  $li = ([int]($index / $FIRST_NAMES.Count) + $lastOffset) % $LAST_NAMES.Count
  return @{ First = $FIRST_NAMES[$fi]; Last = $LAST_NAMES[$li] }
}

function Invoke-CreateWorker([string]$username, [string]$firstName, [string]$lastName,
                             [string]$role, [string]$facilityId, [string]$facilityName,
                             [string]$programId, [string]$dhis2OrgUnit,
                             [string]$phone, [string]$email) {
  $body = [ordered]@{
    username     = $username
    firstName    = $firstName
    lastName     = $lastName
    password     = $PASSWORD
    role         = $role
    phone        = $phone
    email        = $email
    facilityId   = $facilityId
    facilityName = $facilityName
    programId    = $programId
    dhis2OrgUnit = $dhis2OrgUnit
  } | ConvertTo-Json -Compress

  try {
    $null = Invoke-RestMethod -Uri "$MediatorUrl/aggregate/users/field-worker" `
      -Method POST -ContentType "application/json" -Body $body -ErrorAction Stop
    return "ok"
  } catch {
    $resp = $_.Exception.Response
    if ($resp -ne $null) {
      $code = [int]$resp.StatusCode
      if ($code -eq 409) { return "skip" }
      Write-Warning "    FAILED $username (HTTP $code): $($_.Exception.Message)"
    } else {
      Write-Warning "    FAILED $username (no response): $($_.Exception.Message)"
    }
    return "error"
  }
}

if ($DryRun) {
  Write-Host "[DRY RUN] Would create 150 VHW + 150 facility workers against $MediatorUrl"
  exit 0
}

Write-Host ""
Write-Host "=== BKM Bulk Worker Seed ==="
Write-Host "Target : $MediatorUrl"
Write-Host "Workers: 150 VHW + 150 Facility = 300 total"
Write-Host ""

# ---- VHW / field workers (vhw001 - vhw150) ----------------------------------
Write-Host "--- VHW / Field Workers ---"
for ($i = 1; $i -le 150; $i++) {
  $n     = "{0:D3}" -f $i
  $nm    = Get-WorkerName -index ($i - 1) -lastOffset 0
  $fname = $nm.First
  $lname = $nm.Last
  $un    = "vhw$n"
  $phone = "+266500{0:D5}" -f $i
  $email = "$un@lesotho.health"

  $result = Invoke-CreateWorker $un $fname $lname "vhw" "" "" "" $VHW_OU $phone $email

  if ($result -eq "ok")   { $created++; Write-Host "  [+] $un ($fname $lname)" }
  elseif ($result -eq "skip")  { $skipped++; Write-Host "  [=] $un - already exists" }
  else                         { $errors++ }

  if ($i % 25 -eq 0) { Write-Host "      ... $i / 150 VHW done" }
}

Write-Host ""

# ---- Facility workers (fw001 - fw150) ----------------------------------------
Write-Host "--- Facility Workers ---"
for ($i = 1; $i -le 150; $i++) {
  $n     = "{0:D3}" -f $i
  $nm    = Get-WorkerName -index ($i - 1) -lastOffset 15
  $fname = $nm.First
  $lname = $nm.Last
  $un    = "fw$n"
  $phone = "+266580{0:D5}" -f $i
  $email = "$un@lesotho.health"

  $result = Invoke-CreateWorker $un $fname $lname "facility_worker" `
              $FACILITY_ID $FACILITY_NAME $PROGRAM_ID $FACILITY_OU $phone $email

  if ($result -eq "ok")   { $created++; Write-Host "  [+] $un ($fname $lname)" }
  elseif ($result -eq "skip")  { $skipped++; Write-Host "  [=] $un - already exists" }
  else                         { $errors++ }

  if ($i % 25 -eq 0) { Write-Host "      ... $i / 150 FW done" }
}

Write-Host ""
Write-Host "=== Done ==="
Write-Host "  Created : $created"
Write-Host "  Skipped : $skipped (already existed)"
Write-Host "  Errors  : $errors"
Write-Host ""
if ($errors -gt 0) {
  Write-Warning "Some workers failed - check warnings above."
  exit 1
}
