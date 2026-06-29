# Release Notes

## v1.1.0 - 2026-06-22

### Web Portal (bkm-web)
- Facility isolation, consistent everywhere. Admin sees all sites; store managers, coordinators and VHWs see only their own facility - now applied on Orders ("Pending Orders by Village / VHW") as well as Staff Management. Previously village-to-facility lookups failed and could leak other facilities' data; each org-unit now carries its OpenLMIS facility ID for reliable scoping.
- Refresh button on Staff Management - reload staff + stock allocations on demand (e.g. after an allocate or dispense) without reloading the whole portal.
- New Field Worker form - the facility's DHIS2 org unit auto-fills when creating a VHW (it had defaulted to a stale value and stayed blank for the first VHW at a facility).
- Staff Management - Facility ID column hidden (still readable as a hover tooltip on the facility name and in the Edit form).

### Android App
- BKM branding - login, settings and PIN screens, plus the launcher icon and splash, now show the BKM ("Bophelo Ka Mosebeletsi") logo instead of OpenSRP.
- Blocking error dialog - invalid / over-limit form submissions now show a dialog you must dismiss (with a clearer message) instead of a toast that flashed by.
- "Available (allocated to you)" on the Dispense Medicine form - shows the village health worker's remaining allocation for the selected medicine, and blocks over-dispensing it.
- Faster sync - background sync interval reduced (30 to 1 min) so the available balance stays current.

### Stock & Data
- Mafeteng deployment - the system can be reseeded from the Maseru demo to the 18 real Mafeteng facilities (17 health centres + Mafeteng Hospital) with per-facility store-manager and coordinator accounts. Driven by a single source of truth (config/facilities/mafeteng-facilities.json) and an idempotent, endpoint-auto-detecting reseed script.
- Batch/lot-tracked stock - facility stock-on-hand is recorded per lot (batch number + expiry), enabling FEFO dispensing, expiry tracking and recall by batch.
- Per-VHW allocation enforcement - dispenses are capped server-side at the worker's allocation and available facility stock, with automatic reconciliation so the app's count self-corrects on rejection.
