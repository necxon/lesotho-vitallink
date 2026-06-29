"""
Upload BKM app configs to HAPI FHIR as Binary resources, then push the Composition.
The Composition identifier is changed from "bkm" -> "app" to match the installed APK
(OPENSRP_APP_ID=app in local.properties).
Uses only stdlib - no requests dependency.

Paths resolve relative to this script's location (../../config/fhir-bkm/) so the
script works from any working directory. Override via env vars BKM_CONFIGS_DIR and
BKM_FHIR_CONTENT_DIR.
"""

import base64
import json
import os
import glob
import sys
import urllib.request
import urllib.error

FHIR_BASE = "http://localhost:8079/fhir"

_HERE = os.path.dirname(os.path.abspath(__file__))
_BKM_ROOT = os.path.join(_HERE, "..", "config", "fhir-bkm")
CONFIGS_DIR      = os.environ.get("BKM_CONFIGS_DIR",      os.path.join(_BKM_ROOT, "bkm-configs"))
FHIR_CONTENT_DIR = os.environ.get("BKM_FHIR_CONTENT_DIR", os.path.join(_BKM_ROOT, "fhir_content"))

# (binary_id_from_composition, relative_file_path, content_type)
BINARY_MAP = [
    ("799fb481-e9fd-4378-af40-4b0ac62f95ba",    "application_config.json",                                     "application/json"),
    ("a982504f-8d8b-4151-abc6-0063793500d4e",    "sync_config.json",                                            "application/json"),
    ("d7ce0167-ee6a-4f8f-b644-50b0242513239e",   "navigation_config.json",                                      "application/json"),
    ("e64815e6-56c1-4200-b2a6-6ec13eedfec3e",    "registers/anc_register_config.json",                         "application/json"),
    ("9f4c7c0c-1f94-49b0-853c-bb0ce759ae7e",     "registers/asthma_register_config.json",                      "application/json"),
    ("7f6ac9f4-3089-433b-b223-eba6857fb952",     "registers/cancer_register_config.json",                      "application/json"),
    ("f7c33f97-1fc0-45f4-994f-ed46bb99096d",     "registers/cmntd_register_config.json",                       "application/json"),
    ("882b7cf5-75c4-4e9e-b388-9eeccbc1f3a6",     "registers/diabetes_register_config.json",                    "application/json"),
    ("4db39162-721b-403b-8507-363013ccd7c8",     "registers/epilepsy_register_config.json",                    "application/json"),
    ("7d0ce69f-22c2-4829-90b4-c0aadebdffbae",    "registers/fp_register_config.json",                          "application/json"),
    ("faa1688d-98fa-4954-9889-6c2bdf4d4e57e",    "registers/hiv_register_config.json",                         "application/json"),
    ("7ebbbf4e-c783-42f2-998d-3c6bdde5c0c6e",    "registers/household_register_config.json",                   "application/json"),
    ("f68a87fd-c986-4644-8c99-bd7b829b1d6a",     "registers/hypertension_register_config.json",                "application/json"),
    ("1a2e43e2-739a-42f7-b80d-82ea7933d402",     "registers/inventory_register_config.json",                   "application/json"),
    ("b1c2d3e4-f5a6-7b8c-9d0e-1f2a3b4c5d6e",    "registers/dispense_register_config.json",                    "application/json"),
    ("ba22490f-d24b-43d0-b6f4-f5af474bbf05e",    "registers/mental_health_register_config.json",               "application/json"),
    ("e6e69fce-75f6-40ba-8c85-f402d1a8fe1c",     "registers/paralysis_register_config.json",                   "application/json"),
    ("9aa6bbb6-df76-42a4-bdbe-72dc197378cae",    "registers/pnc_register_config.json",                         "application/json"),
    ("2d1c99a7-6c71-41ab-aa53-26c817b39d13",     "registers/stroke_register_config.json",                      "application/json"),
    ("2ac6ec4f-1a29-4d85-a015-06db9c1b82d9e",    "registers/tb_register_config.json",                          "application/json"),
    ("c1e2f3a4-b5d6-7e8f-9a0b-1c2d3e4f5a6b",    "registers/iys_register_config.json",                          "application/json"),
    ("taskRegister",                              "registers/task_register_config.json",                         "application/json"),
    ("stockOrderRegister",                        "registers/stock_order_register_config.json",                  "application/json"),
    ("34b709f3-e8a1-44e9-867a-714b68bb1367e",    "profiles/default_profile_config.json",                       "application/json"),
    ("bbb3c2b0-51c9-44e9-9674-7d311ad5f859e",    "profiles/household_profile_config.json",                     "application/json"),
    ("a432e367-f943-4884-8302-e5f6e4686dc7",     "profiles/individual_past_encounters_profile_config.json",    "application/json"),
    ("c074cbf7-0a4f-47ca-bb36-679e563dfb50",     "profiles/individual_upcoming_encounters_profile_config.json","application/json"),
    ("0e2943ab-4078-4e03-94c2-d0f3640b0ae9",     "profiles/inventory_profile_config.json",                     "application/json"),
    ("a6d69650-4806-4bb1-bd2b-a60fa18418a0e",    "profiles/other_registers_profile_config.json",               "application/json"),
    ("c6757818-25c8-4e51-ba51-0c9dd882cbbbe",    "translations/strings_config.properties",                     "text/plain"),
    ("860ffbce-bc92-458c-9598-4c1c373f9827",     "translations/strings_st_config.properties",                  "text/plain"),
    ("eee5f9c1-49f6-4b18-b088-8a52689a79d8e",    "translations/strings_sw_config.properties",                  "text/plain"),
]


def fhir_put(path, body_dict):
    url = f"{FHIR_BASE}{path}"
    data = json.dumps(body_dict).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="PUT",
        headers={"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def upload_binary(binary_id, file_path, content_type):
    full_path = os.path.join(CONFIGS_DIR, file_path)
    with open(full_path, "rb") as f:
        raw = f.read()
    encoded = base64.b64encode(raw).decode("utf-8")
    resource = {
        "resourceType": "Binary",
        "id": binary_id,
        "contentType": content_type,
        "data": encoded,
    }
    status, body = fhir_put(f"/Binary/{binary_id}", resource)
    ok = status in (200, 201)
    label = "OK" if ok else f"FAIL {status}"
    print(f"  Binary/{binary_id[:8]}... ({os.path.basename(file_path)}): {label}")
    if not ok:
        print(f"    {body[:200]}")
    return ok


def upload_composition():
    comp_path = os.path.join(CONFIGS_DIR, "composition_config.json")
    with open(comp_path) as f:
        comp = json.load(f)
    comp["identifier"]["value"] = "app"
    comp.get("meta", {}).pop("versionId", None)
    comp.get("meta", {}).pop("lastUpdated", None)
    comp.get("meta", {}).pop("source", None)
    status, body = fhir_put(f"/Composition/{comp['id']}", comp)
    ok = status in (200, 201)
    label = "OK" if ok else f"FAIL {status}"
    print(f"  Composition/{comp['id'][:8]}... (identifier=app): {label}")
    if not ok:
        print(f"    {body[:300]}")
    return ok


def upload_fhir_content():
    ok = fail = 0
    patterns = [
        "questionnaire/**/*.json",
        "structure_map/**/*.json",
        "plan_definition/**/*.json",
        "group/**/*.json",
        "List/**/*.json",
    ]
    for pattern in patterns:
        for fpath in glob.glob(os.path.join(FHIR_CONTENT_DIR, pattern), recursive=True):
            try:
                with open(fpath) as f:
                    res = json.load(f)
                rtype = res.get("resourceType")
                rid = res.get("id")
                if not rtype or not rid:
                    print(f"  SKIP {os.path.basename(fpath)} (no resourceType/id)")
                    continue
                status, body = fhir_put(f"/{rtype}/{rid}", res)
                if status in (200, 201):
                    ok += 1
                    print(f"  {rtype}/{rid}: OK")
                else:
                    fail += 1
                    print(f"  {rtype}/{rid}: FAIL {status} - {body[:150]}")
            except Exception as e:
                fail += 1
                print(f"  ERROR {os.path.basename(fpath)}: {e}")
    return ok, fail


def upload_fml_structure_maps():
    """Upload FML (.map) StructureMap files via PUT with text/fhir-mapping content-type."""
    import re
    ok = fail = 0
    pattern = os.path.join(FHIR_CONTENT_DIR, "structure_map", "map", "**", "*.map")
    for fpath in glob.glob(pattern, recursive=True):
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                text = f.read()
            # Extract ID from canonical URL on first line: map "...StructureMap/{id}" = "..."
            m = re.search(r'StructureMap/([^\s"]+)', text)
            if not m:
                print(f"  SKIP {os.path.basename(fpath)} (no StructureMap ID in first line)")
                fail += 1
                continue
            sm_id = m.group(1)
            url = f"{FHIR_BASE}/StructureMap/{sm_id}"
            data = text.encode("utf-8")
            req = urllib.request.Request(
                url, data=data, method="PUT",
                headers={"Content-Type": "text/fhir-mapping", "Accept": "application/fhir+json"},
            )
            try:
                with urllib.request.urlopen(req) as resp:
                    status = resp.status
            except urllib.error.HTTPError as e:
                status = e.code
                body = e.read().decode("utf-8")
                print(f"  StructureMap/{sm_id} ({os.path.basename(fpath)}): FAIL {status} - {body[:150]}")
                fail += 1
                continue
            if status in (200, 201):
                ok += 1
                print(f"  StructureMap/{sm_id} ({os.path.basename(fpath)}): OK")
            else:
                fail += 1
                print(f"  StructureMap/{sm_id} ({os.path.basename(fpath)}): FAIL {status}")
        except Exception as e:
            fail += 1
            print(f"  ERROR {os.path.basename(fpath)}: {e}")
    return ok, fail


def patch_sync_config():
    """
    The sync_config.json from the BKM repo uses _id for all resources.
    Observation/Flag/MeasureReport don't get synced that way (device never
    knows their IDs before syncing). Patch to _lastUpdated for those three
    so the app pulls all of them on every sync.
    """
    sync_binary_id = "a982504f-8d8b-4151-abc6-0063793500d4e"
    url = f"{FHIR_BASE}/Binary/{sync_binary_id}"
    with urllib.request.urlopen(url) as r:
        data = json.load(r)

    # Questionnaire + StructureMap: use _lastUpdated so newly uploaded configs are
    # picked up on the next sync without needing to pre-register their IDs.
    NEEDS_LAST_UPDATED = {"Observation", "MeasureReport", "Flag", "Questionnaire", "StructureMap"}

    # Remove those types from _id and _count bases
    for p in data.get("parameter", []):
        res = p.get("resource", {})
        if res.get("name") in ("_id", "count"):
            res["base"] = [b for b in res.get("base", []) if b not in NEEDS_LAST_UPDATED]

    # Add _lastUpdated param if not already present
    has_last_updated = any(
        p.get("resource", {}).get("name") == "_lastUpdated"
        for p in data.get("parameter", [])
    )
    if not has_last_updated:
        data["parameter"].append({
            "resource": {
                "resourceType": "SearchParameter",
                "name": "_lastUpdated",
                "code": "_lastUpdated",
                "base": sorted(NEEDS_LAST_UPDATED),
            }
        })

    raw = json.dumps(data).encode("utf-8")
    binary = {
        "resourceType": "Binary",
        "id": sync_binary_id,
        "contentType": "application/json",
        "data": base64.b64encode(raw).decode("utf-8"),
    }
    status, body = fhir_put(f"/Binary/{sync_binary_id}", binary)
    ok = status in (200, 201)
    print(f"  sync_config patch (_lastUpdated for Obs/Flag/MR): {'OK' if ok else f'FAIL {status}'}")
    if not ok:
        print(f"    {body[:200]}")
    return ok


if __name__ == "__main__":
    print("=== Uploading BKM Binary configs to HAPI FHIR ===")
    errors = 0
    for (bid, fpath, ctype) in BINARY_MAP:
        if not upload_binary(bid, fpath, ctype):
            errors += 1

    print("\n=== Uploading Composition (identifier: bkm -> app) ===")
    if not upload_composition():
        errors += 1

    print("\n=== Patching sync_config (_lastUpdated for Observation/Flag/MeasureReport) ===")
    if not patch_sync_config():
        errors += 1

    print("\n=== Uploading FML StructureMaps (.map files) ===")
    fml_ok, fml_fail = upload_fml_structure_maps()

    print("\n=== Uploading FHIR content (Questionnaires, StructureMaps, etc.) ===")
    ok, fail = upload_fhir_content()
    errors += fail

    print(f"\nDone. Binary+Composition errors: {errors}, FML map failures: {fml_fail} (expected — HAPI rejects FML syntax), FHIR content: {ok} OK / {fail} FAIL")
    sys.exit(0 if errors == 0 else 1)
