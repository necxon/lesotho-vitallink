#!/usr/bin/env bash
#
# NEC XON (c) Copyright 2025.
#
# setup_dhis2_dashboard.sh — (re)build the BKM DHIS2 demo dashboard.
#
# The seed's DHIS2 setup talks to localhost:8081 and can silently fail if DHIS2 is still
# booting (leaving BKMDashbrd1 an empty shell, no visualizations, no dataset). This script
# rebuilds it idempotently against any DHIS2 URL. It:
#   1. discovers which BKM data elements / org units actually exist (uses only those)
#   2. creates a "BKM Stock" dataSet (enables Data Entry + dataValueSets export)
#   3. creates Dispensed (bar), Stock-on-Hand (line) + Summary (pivot) visualizations
#   4. repopulates the BKMDashbrd1 dashboard with them
#   5. queues an analytics run so the charts render
#
# Usage (on the prod host):
#   DHIS2_URL=https://dhis2.lesotho-bkm.xyz bash scripts/setup_dhis2_dashboard.sh
# Defaults: DHIS2_URL=https://dhis2.lesotho-bkm.xyz  DHIS2_USER=admin  DHIS2_PASS=district

set -euo pipefail

export DHIS2_URL="${DHIS2_URL:-https://dhis2.lesotho-bkm.xyz}"
export DHIS2_USER="${DHIS2_USER:-admin}"
export DHIS2_PASS="${DHIS2_PASS:-district}"

echo "[dhis2-dash] Target: $DHIS2_URL (user $DHIS2_USER)"

python3 <<'PYEOF'
import urllib.request, urllib.error, json, base64, os, sys

BASE = os.environ["DHIS2_URL"].rstrip("/") + "/api"
AUTH = "Basic " + base64.b64encode(f'{os.environ["DHIS2_USER"]}:{os.environ["DHIS2_PASS"]}'.encode()).decode()

def api(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(BASE + path, data=body, method=method,
          headers={"Content-Type": "application/json", "Authorization": AUTH})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read()
            return (json.loads(t) if t else {}), r.status
    except urllib.error.HTTPError as e:
        try:   return json.loads(e.read()), e.code
        except Exception: return {}, e.code
    except Exception as e:
        print(f"  ERROR calling {method} {path}: {e}")
        return {}, 0

DASH = "BKMDashbrd1"
# (uid, label) — dispensed + stock-on-hand data elements for the 3 ATP medicines
DISP = [("ujPSJuS9pph", "Oxytocin 10 IU"), ("DEAmox25001", "Amoxicillin 250mg"), ("DEParSyr001", "Paracetamol Syrup")]
SOH  = [("StockOnHnd1", "Oxytocin 10 IU"), ("DEAmoxSOH01", "Amoxicillin 250mg"), ("DEParSOH001", "Paracetamol Syrup")]
OUS  = ["dwx1Yz4BwNX", "MasClinicB1"]

def exists(kind, uid):
    _, s = api("GET", f"/{kind}/{uid}.json?fields=id")
    return s == 200

disp = [d for d in DISP if exists("dataElements", d[0])]
soh  = [d for d in SOH  if exists("dataElements", d[0])]
ous  = [o for o in OUS if exists("organisationUnits", o)]
print(f"  dispensed DEs present: {[d[0] for d in disp]}")
print(f"  SOH DEs present:       {[d[0] for d in soh]}")
print(f"  org units present:     {ous}")
if not disp and not soh:
    print("  No known BKM data elements exist in DHIS2 — nothing to visualize. Aborting.")
    sys.exit(1)
if not ous:
    ous = ["dwx1Yz4BwNX"]

PERIOD  = [{"id": "LAST_12_MONTHS"}, {"id": "THIS_MONTH"}]
OUITEMS = [{"id": o} for o in ous]

def make_viz(uid, name, vtype, de_ids):
    api("DELETE", f"/visualizations/{uid}")
    _, s = api("POST", "/visualizations", {
        "id": uid, "name": name, "type": vtype,
        "columns": [{"dimension": "dx", "items": [{"id": d} for d in de_ids]}],
        "rows":    [{"dimension": "pe", "items": PERIOD}],
        "filters": [{"dimension": "ou", "items": OUITEMS}],
        "showData": True, "hideEmptyRows": True,
    })
    print(f"  visualization {uid} ({name}): HTTP {s}")
    return s in (200, 201)

items = []
if disp and make_viz("BKMVizDisp1", "BKM — Dispensed by Medicine (Monthly)", "COLUMN", [d[0] for d in disp]):
    items.append("BKMVizDisp1")
if soh and make_viz("BKMVizSoh01", "BKM — Stock on Hand (Monthly)", "LINE", [d[0] for d in soh]):
    items.append("BKMVizSoh01")
all_de = [d[0] for d in disp] + [d[0] for d in soh]
if make_viz("BKMVizPvt01", "BKM — Stock Summary", "PIVOT_TABLE", all_de):
    items.append("BKMVizPvt01")

# ── DataSet (enables Data Entry + dataValueSets export = the live "watch it arrive" view)
cc, _   = api("GET", "/categoryCombos.json?fields=id&filter=name:eq:default")
ccid    = (cc.get("categoryCombos") or [{}])[0].get("id")
dataset = {
    "id": "BKMStokDs01", "name": "BKM Stock", "shortName": "BKM Stock", "periodType": "Monthly",
    "dataSetElements": [{"dataElement": {"id": d[0]}} for d in (disp + soh)],
    "organisationUnits": [{"id": o} for o in ous],
    "openFuturePeriods": 3,
}
if ccid:
    dataset["categoryCombo"] = {"id": ccid}
_, s = api("PUT", "/dataSets/BKMStokDs01", dataset)
if s not in (200, 201, 204):
    _, s = api("POST", "/dataSets", dataset)
print(f"  dataSet BKMStokDs01 (BKM Stock): HTTP {s}")

# ── Repopulate the dashboard (POST /metadata strips dashboardItems, so PUT directly)
dash, ds_status = api("GET", f"/dashboards/{DASH}.json?fields=id,name")
name = dash.get("name") if ds_status == 200 else "BKM Stock Dispensing - Lesotho"
api("DELETE", f"/dashboards/{DASH}")
api("POST", "/dashboards", {"id": DASH, "name": name, "dashboardItems": []})
_, s = api("PUT", f"/dashboards/{DASH}", {
    "id": DASH, "name": name,
    "dashboardItems": [{"type": "VISUALIZATION", "visualization": {"id": i}} for i in items],
})
print(f"  dashboard {DASH}: HTTP {s} ({len(items)} item(s))")

# ── Queue analytics so the visualizations render with the pushed data
_, s = api("POST", "/resourceTables/analytics?lastYears=1")
print(f"  analytics run queued: HTTP {s} (allow ~1-2 min, then refresh the dashboard)")
PYEOF

echo "[dhis2-dash] Done. Dashboard: ${DHIS2_URL}/dhis-web-dashboard/index.html#/BKMDashbrd1"
