# VHW Dispense: Available Balance and Sync

How the "Available (allocated to you)" number gets onto a VHW's phone, what the
backend must be doing, and how to sync/clear cache so it shows up. Written for
demos and field testing.

## The short version

1. A coordinator allocates stock to a VHW for a medicine on the web app.
2. The mediator writes a balance Observation to FHIR (allocated, dispensed, remaining).
3. The VHW's phone syncs that Observation down.
4. On the Dispense Medicine form, picking the medicine shows the remaining balance.
5. When the number looks stale, sync the phone (there is now a Manual sync button
   on the form). You sometimes need to sync more than once - see below.

## What has to be true on the backend

For a balance to appear on a phone, all of these must hold:

- The VHW has an allocation for that medicine in the current month. Allocations are
  per calendar month (period = YYYYMM). A new month starts a fresh allocation; last
  month's remaining does not carry over.
- The mediator is running and FHIR ledger publishing is on
  (FHIR_LEDGER_ENABLED is not "false"). Each allocate or dispense upserts an
  Observation at Observation/alloc-<YYYYMM>-<practitioner>-<medicine>.
- The Observation is tagged with the VHW's practitioner-tag-id and location-tag-id.
  The phone matches on the practitioner tag, so the id must be the VHW's real FHIR
  Practitioner id (not the Keycloak user id).
- The medicine display text on the allocation matches the medicine option in the
  form exactly (for example "Amoxicillin 250mg"). The form matches on that text.
- HAPI FHIR and the login/config path (Keycloak, mediator PractitionerDetail) are up.

Quick backend check (replace the id with the VHW's Practitioner id):

    curl -s "https://fhir.lesotho-bkm.xyz/fhir/Observation?status=preliminary&code:text=Amoxicillin%20250mg"

Look for an entry alloc-<thisMonth>-<vhwId>-... with a Remaining component and a
practitioner-tag-id tag equal to the VHW's id. If it is missing, the allocation did
not publish - check the mediator, not the phone.

## What the VHW does on the phone

1. Open the app and log in.
2. Open a patient, tap Dispense Medicine.
3. Pick the medicine. "Available (allocated to you)" shows the remaining balance.
4. Enter the quantity and submit.

The Available number is computed on the phone from the balance Observations already
synced to the device. It is not fetched live. So if an allocation was just made on
the web, the phone must sync before it can show it.

## Syncing

- Manual sync button: on the Dispense Medicine form there is a Manual sync button at
  the bottom. Tap it to pull the latest data. You will see a "Syncing" toast.
- After syncing, the already-displayed Available value does not recalculate on its
  own. Re-select the medicine (or leave and reopen the form) so the number refreshes.
- The old way still works: app menu / Settings has a sync option too.

### Why you sometimes have to sync more than once

- Sync runs in the background and pulls resources in pages. A single tap may finish
  before the balance Observation page arrives. Tapping again a few seconds later
  picks up the rest.
- The phone only downloads data tagged for the VHW's location. If an allocation was
  made seconds ago, give the mediator a moment to publish before syncing.
- If the number still will not appear after two syncs, clear the cache (below).

## Clearing the cache (fresh login)

Use this when configs changed (new app version, new form logic) or when the data on
the phone looks wrong and syncing does not fix it.

1. App menu (or Settings) -> Clear local data.
2. Log in again as the VHW.
3. Wait for the first sync to complete before opening a form.

Clearing local data forces the phone to re-download the configuration (including the
Dispense Medicine form) and all data for that VHW. This is the reliable reset. A
normal sync keeps the cached configuration, so form or config changes need a clear +
re-login, not just a sync.

## Common problem: Available shows 0

Work down this list:

- Wrong month. There is no allocation for the current month yet. Allocate again this
  month.
- Not synced yet. Tap Manual sync, wait, re-select the medicine.
- Cached old form. Clear local data and re-login.
- Backend has no matching Observation. Run the curl check above. If missing, the
  allocation did not publish - fix the mediator / allocation, not the phone.
- Wrong VHW identity. The balance Observation's practitioner-tag-id must equal the
  VHW's FHIR Practitioner id. A mismatch shows 0 even though data exists.

## Notes for maintainers

- The form (Questionnaire/patient-dispense-medicine) pre-populates a hidden
  practitioner-id item from config, then filters balances by medicine and by that
  practitioner id. This is why one phone only sees its own VHW's balance even when
  two VHWs share a location.
- The Manual sync button is config-gated (showSyncButton on the dispense action) so
  it only appears on this form.
- Month rollover leaves last month's balance Observation in FHIR. It can show as a
  duplicate on the phone until cleaned up. See per-vhw-stock-allocation.md.
