"""
Seed inventory Observations, Flags and MeasureReports for each commodity Group,
per facility. Each facility gets its own Observation (keyed obs-{gid}-{fac_key}).
MeasureReports (AMC) are shared across facilities — one per commodity Group.
"""
import json, uuid, urllib.request, urllib.error
from datetime import datetime, timezone

FHIR  = "http://localhost:8079/fhir"
NOW   = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")

# Commodity groups: group_id -> (name, amc)
# AMC = Average Monthly Consumption; used to compute Months of Stock in the app.
# Balances represent facility stock available for VHW distribution.
COMMODITIES = {
    "c2063a18-219b-49d9-89d7-b47a8e3da1a9": ("Oxytocin 10 IU",       50),
    "f1ae20d7-a14e-57b2-94e6-58d1257c181b": ("Amoxicillin 250mg",     50),
    "eeaca64a-0141-5a29-94e7-a7c374bb6801": ("RDT Kit",               150),
    "9d0995e3-6b2f-54d1-91cd-a212d39d027e": ("Paracetamol Syrup",     50),
    "cb553359-5447-58d4-9c79-f83e751252ed": ("Cotrimoxazole 480mg",   120),
    "645deb1f-7e33-581f-be47-b1120ffba690": ("ORS Sachet",            200),
    "cbe581e8-7286-553f-b0d1-43f518a6dec6": ("Zinc 20mg",             180),
    "12e24153-eb75-530f-b1d7-c6272ffc64e7": ("Iron + Folic Acid",     300),
    "ee4b1339-9051-5401-8578-36304faf104e": ("Roller Bandages",        60),
    "60230d85-1fa5-5e33-93ec-6eb72769deac": ("Male Condoms",          150),
}

# Facilities: each has an org_id, display name, obs_key (for unique Obs IDs),
# and per-commodity balance overrides keyed by group_id.
FACILITIES = [
    {
        "org_id":   "maseru-clinic-a",
        "org_name": "Maseru District Clinic A",
        "obs_key":  "",          # blank -> obs-{gid} (backward-compat with synced device)
        "balances": {
            "c2063a18-219b-49d9-89d7-b47a8e3da1a9": 800,   # Oxytocin 10 IU       Overstock (16 MOS)
            "f1ae20d7-a14e-57b2-94e6-58d1257c181b": 500,   # Amoxicillin 250mg     Satisfactory (1.7 MOS)
            "eeaca64a-0141-5a29-94e7-a7c374bb6801": 200,   # RDT Kit               Satisfactory (1.3 MOS)
            "9d0995e3-6b2f-54d1-91cd-a212d39d027e": 300,   # Paracetamol Syrup     Satisfactory (1.2 MOS)
            "cb553359-5447-58d4-9c79-f83e751252ed": 500,   # Cotrimoxazole 480mg   Overstock (4.2 MOS)
            "645deb1f-7e33-581f-be47-b1120ffba690": 200,   # ORS Sachet            Satisfactory (1.0 MOS)
            "cbe581e8-7286-553f-b0d1-43f518a6dec6": 800,   # Zinc 20mg             Overstock (4.4 MOS)
            "12e24153-eb75-530f-b1d7-c6272ffc64e7": 1000,  # Iron + Folic Acid     Overstock (3.3 MOS)
            "ee4b1339-9051-5401-8578-36304faf104e": 100,   # Roller Bandages       Satisfactory (1.7 MOS)
            "60230d85-1fa5-5e33-93ec-6eb72769deac": 200,   # Male Condoms          Satisfactory (1.3 MOS)
        },
    },
]


def put(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{FHIR}{path}", data=data, method="PUT",
        headers={"Content-Type": "application/fhir+json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        print(f"  ERROR {path}: {e.code} {e.read().decode()[:150]}")
        return e.code


def seed_organization(org_id, org_name):
    return put(f"/Organization/{org_id}", {
        "resourceType": "Organization",
        "id": org_id,
        "active": True,
        "name": org_name,
        "type": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/organization-type",
                               "code": "prov", "display": "Healthcare Provider"}]}],
    })


def observation(gid, balance, org_ref, obs_key):
    oid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"obs-{gid}{obs_key}"))
    return f"/Observation/{oid}", {
        "resourceType": "Observation",
        "id": oid,
        "status": "preliminary",
        "code": {"coding": [{"system": "http://snomed.info/sct", "code": "386452003", "display": "Supply"}]},
        "subject": {"reference": f"Group/{gid}"},
        "performer": [{"reference": org_ref}],
        "effectiveDateTime": NOW,
        "component": [
            {
                "code": {"coding": [{"system": "http://snomed.info/sct", "code": "373784005", "display": "Stock balance"}]},
                "valueQuantity": {"value": balance, "unit": "units",
                                  "system": "http://unitsofmeasure.org", "code": "{units}"},
            }
        ],
    }


def flag(gid, org_ref, obs_key):
    fid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"flag-{gid}{obs_key}"))
    return f"/Flag/{fid}", {
        "resourceType": "Flag",
        "id": fid,
        "status": "active",
        "code": {"coding": [{"system": "http://snomed.info/sct", "code": "386452003", "display": "Stockout"}]},
        "subject": {"reference": f"Group/{gid}"},
        "author": {"reference": org_ref},
        "period": {"start": TODAY},
    }


def measure_report(gid, amc):
    # One shared MeasureReport per commodity (AMC is facility-independent)
    mid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"mr-{gid}"))
    return f"/MeasureReport/{mid}", {
        "resourceType": "MeasureReport",
        "id": mid,
        "status": "complete",
        "type": "summary",
        "measure": "https://fhir.labs.smartregister.org/fhir/Measure/STOCKIND02",
        "subject": {"reference": f"Group/{gid}"},
        "date": TODAY,
        "period": {"start": TODAY, "end": TODAY},
        "contained": [
            {
                "resourceType": "Medication",
                "id": "amc-value",
                "code": {"coding": [{"system": "http://snomed.info/sct",
                                     "code": str(amc), "display": str(amc)}]},
            }
        ],
    }


def mos_status(balance, amc):
    mos = balance / amc if amc else 0
    label = ("Stockout" if mos <= 0.5 else
             "Understock" if mos < 1 else
             "Satisfactory" if mos < 3 else "Overstock")
    return mos, label


obs_ok = flag_ok = mr_ok = org_ok = 0

# ── Organizations ────────────────────────────────────────────────────────────
print("=== Seeding Organizations ===")
for fac in FACILITIES:
    s = seed_organization(fac["org_id"], fac["org_name"])
    org_ok += s in (200, 201)
    print(f"  Organization/{fac['org_id']} ({fac['org_name']}): {'OK' if s in (200,201) else f'FAIL {s}'}")

# ── MeasureReports (shared, one per commodity) ───────────────────────────────
print("\n=== Seeding MeasureReports (AMC, shared across facilities) ===")
for gid, (name, amc) in COMMODITIES.items():
    path, body = measure_report(gid, amc)
    s = put(path, body)
    mr_ok += s in (200, 201)

# ── Flags per facility (Observation creation handled by the live ledger) ─────
# Stock-on-hand Observations are now written by mediator/src/sync/fhirLedger.js
# using deterministic IDs (stock-{groupId}-{orgRef}) so they stay in lockstep
# with OpenLMIS. Seeding random-UUID preliminary Observations here would create
# duplicates that the bkm-web Stock pages then pick up alongside the live ones.
for fac in FACILITIES:
    org_ref  = f"Organization/{fac['org_id']}"
    obs_key  = fac["obs_key"]
    print(f"\n=== Seeding stock for {fac['org_name']} (Observations: live ledger) ===\n")
    for gid, (name, amc) in COMMODITIES.items():
        balance = fac["balances"].get(gid, 0)
        mos, status = mos_status(balance, amc)

        if balance == 0:
            path, body = flag(gid, org_ref, obs_key)
            s = put(path, body)
            flag_ok += s in (200, 201)

        prefix = "[STOCKOUT] " if balance == 0 else ""
        print(f"  {prefix}{name}: balance={balance}, amc={amc}/mo, MOS={mos:.1f} -> {status}")

print(f"\nDone: {org_ok} Organizations, {obs_ok} Observations (skipped — live ledger), "
      f"{flag_ok} Flags, {mr_ok} MeasureReports")
