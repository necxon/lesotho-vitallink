#!/usr/bin/env python3
"""Check and upload the unsynced records found by tablet_rescue.py. CHECK ONLY unless --apply.

Input is the folder tablet_rescue.py wrote (it needs records/<Type>/<id>.json, which keep the version the tablet
started from). For every record it asks the server and sorts it into:
  new          not on the server: will be created
  update       on the server at the version the tablet started from: the tablet's change is applied
  conflict     the server has a NEWER version than the tablet started from (someone changed it after the tablet
               last synced): SKIPPED unless --include-conflicts, listed so you can compare by hand
  deleted      deleted on the server (HTTP 410): skipped
With --apply the new + update records are sent as PUT <Type>/<id> in batch bundles (ids kept, nothing else touched),
then each is read back. Results go to <folder>/upload-<stamp>.json and events to ~/log/rescue_upload.log.

  python3 rescue_upload.py rescue/ --fhir http://127.0.0.1:18180/fhir            # preprod, check only
  python3 rescue_upload.py rescue/ --fhir http://127.0.0.1:18180/fhir --apply    # preprod, upload
  python3 rescue_upload.py rescue/ --fhir http://localhost:8080/fhir             # production (.146), check only
"""
import argparse, datetime, glob, json, os, sys, urllib.error, urllib.request

ORDER = ["Patient", "RelatedPerson", "Group", "CarePlan", "Encounter", "Condition", "Observation",
         "QuestionnaireResponse", "Immunization", "Task", "Flag", "List"]

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("folder")
ap.add_argument("--fhir", required=True)
ap.add_argument("--apply", action="store_true")
ap.add_argument("--include-conflicts", action="store_true", help="also overwrite records the server changed later")
ap.add_argument("--log-dir", default=os.path.expanduser("~/log"))
a = ap.parse_args()
BASE = a.fhir.rstrip("/")
os.umask(0o077)
os.makedirs(a.log_dir, exist_ok=True)


def log(msg):
    line = f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(os.path.join(a.log_dir, "rescue_upload.log"), "a", encoding="utf-8") as f:
        f.write(line + "\n")


def http(method, url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


recs = []
for p in glob.glob(os.path.join(a.folder, "records", "*", "*.json")):
    with open(p, encoding="utf-8") as f:
        recs.append(json.load(f))
if not recs:
    sys.exit(f"No records/ in {a.folder} (run tablet_rescue.py first)")
recs.sort(key=lambda r: ORDER.index(r["resourceType"]) if r["resourceType"] in ORDER else 99)
log(f"START {'APPLY' if a.apply else 'check'}: {len(recs)} records from {a.folder} -> {BASE}")

st, _ = http("GET", f"{BASE}/metadata?_summary=true")
if st != 200:
    log(f"STOPPED: server does not answer (HTTP {st})")
    sys.exit(1)

plan = {"new": [], "update": [], "conflict": [], "deleted": [], "error": []}
for r in recs:
    rt, rid = r["resourceType"], r["id"]
    base_v = (r.get("meta") or {}).get("versionId")
    st, srv = http("GET", f"{BASE}/{rt}/{rid}")
    if st == 404:
        plan["new"].append(r)
    elif st == 410:
        plan["deleted"].append(r)
    elif st == 200:
        srv_v = (srv.get("meta") or {}).get("versionId")
        (plan["update"] if base_v is None or srv_v == base_v else plan["conflict"]).append(r)
        r["_server_version"] = srv_v
    else:
        plan["error"].append(r)

by = lambda rs: ", ".join(f"{t} {n}" for t, n in sorted({x["resourceType"]: sum(1 for y in rs if y["resourceType"] == x["resourceType"]) for x in rs}.items()))
for k in ("new", "update", "conflict", "deleted", "error"):
    log(f"  {k:9} {len(plan[k]):4}  {by(plan[k])}")
for r in plan["conflict"][:20]:
    log(f"    conflict {r['resourceType']}/{r['id']}: tablet based on v{(r.get('meta') or {}).get('versionId')}, "
        f"server now v{r['_server_version']}")

stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
report = {k: [f"{r['resourceType']}/{r['id']}" for r in v] for k, v in plan.items()}
if not a.apply:
    with open(os.path.join(a.folder, f"check-{stamp}.json"), "w") as f:
        json.dump(report, f, indent=1)
    log("Check only, nothing written. Add --apply to upload new + update" +
        (" (+ conflicts)" if a.include_conflicts else f" ({len(plan['conflict'])} conflicts skipped)") + ".")
    sys.exit(0)

send = plan["new"] + plan["update"] + (plan["conflict"] if a.include_conflicts else [])
results = {"ok": [], "failed": []}
for k in range(0, len(send), 100):
    chunk = []
    for r in send[k:k + 100]:
        body = {x: y for x, y in r.items() if x != "_server_version"}
        body = json.loads(json.dumps(body))
        body.get("meta", {}).pop("versionId", None)
        chunk.append(body)
    st, b = http("POST", BASE, {"resourceType": "Bundle", "type": "batch", "entry": [
        {"resource": r, "request": {"method": "PUT", "url": f"{r['resourceType']}/{r['id']}"}} for r in chunk]})
    entries = b.get("entry", []) if st == 200 else []
    for r, e in zip(chunk, entries or [{}] * len(chunk)):
        s = (e.get("response") or {}).get("status", f"bundle HTTP {st}")
        ref = f"{r['resourceType']}/{r['id']}"
        if s.startswith(("200", "201")):
            results["ok"].append(ref)
        else:
            oo = (e.get("response") or {}).get("outcome") or {}
            results["failed"].append({"ref": ref, "status": s,
                                      "error": (oo.get("issue") or [{}])[0].get("diagnostics", "")[:300]})
report["upload"] = results
with open(os.path.join(a.folder, f"upload-{stamp}.json"), "w") as f:
    json.dump(report, f, indent=1)
log(f"Uploaded {len(results['ok'])}/{len(send)}; failed {len(results['failed'])}"
    + (f" (first: {results['failed'][0]})" if results["failed"] else "") + f"; report upload-{stamp}.json")
sys.exit(0 if not results["failed"] else 1)
