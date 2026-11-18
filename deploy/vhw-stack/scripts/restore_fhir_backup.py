#!/usr/bin/env python3
"""Restore a backup made by fhir_backup.py into a FHIR server. DRY RUN unless --apply.

  python3 restore_fhir_backup.py fhir-backups/20261111-1440/prod --target http://localhost:8080/fhir
  python3 restore_fhir_backup.py fhir-backups/20261111-1440/prod --target http://localhost:8080/fhir --apply
  python3 restore_fhir_backup.py <folder> --target <url> --types Patient Group --apply     # only some types

What it does:
  1. checks every file against the manifest (sha256 and line count) and stops if anything is wrong,
  2. shows what is in the backup and what the target already holds (dry run stops here),
  3. with --apply: sends every resource as PUT <Type>/<id> in batch bundles, keeping the original ids,
     reference data first (forms, maps, locations, organisations, practitioners) then patient data,
     Locations parents-before-children; entries that fail (e.g. a reference not loaded yet) are retried in
     later rounds, the rest is reported in restore-errors-<stamp>.json,
  4. counts each type on the target afterwards and compares with the backup.

PUT overwrites: a resource that exists on the target with the same id is replaced by the backup copy (the old one
stays in the target's _history). Restoring into a server that already holds data therefore needs
--target-has-data, and the target name typed in when asked. Safest is to restore into an EMPTY server (a new HAPI),
check it, and only then point anything at it.

Only the current version of each resource is in the backup (no history). Keycloak users are not in it.
"""
import argparse, datetime, gzip, hashlib, json, os, sys, time, urllib.error, urllib.request

ORDER = ["SearchParameter", "StructureMap", "Questionnaire", "PlanDefinition", "Library", "Measure",
         "ActivityDefinition", "Binary", "Composition", "Organization", "Location", "Practitioner",
         "OrganizationAffiliation", "PractitionerRole", "CareTeam", "Patient", "RelatedPerson", "Group",
         "CarePlan", "Encounter", "Condition", "Observation", "Immunization", "QuestionnaireResponse", "Task",
         "Flag", "List"]

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("folder", help="one server's backup folder, e.g. fhir-backups/20261111-1440/prod")
ap.add_argument("--target", required=True, help="FHIR base url to restore into")
ap.add_argument("--types", nargs="*", help="only these resource types")
ap.add_argument("--apply", action="store_true", help="really write (default: dry run)")
ap.add_argument("--target-has-data", action="store_true", help="allow restoring into a server that is not empty")
ap.add_argument("--batch-size", type=int, default=200)
ap.add_argument("--rounds", type=int, default=3, help="retry rounds for failed entries")
ap.add_argument("--log-dir", default=os.path.expanduser("~/log"),
                help="events are appended to <log-dir>/fhir_restore.log (default ~/log)")
a = ap.parse_args()
BASE = a.target.rstrip("/")

os.umask(0o077)  # logs, backups and error files: owner only (personal data)
os.makedirs(a.log_dir, mode=0o700, exist_ok=True)
LOGFILE = os.path.join(a.log_dir, "fhir_restore.log")


def log(msg):
    line = f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(LOGFILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def stop(msg):
    log(f"STOPPED: {msg}")
    sys.exit(1)


log(f"START restore {'APPLY' if a.apply else 'dry run'}: {a.folder} -> {BASE}"
    + (f" types {' '.join(a.types)}" if a.types else ""))


def http(method, url, body=None, timeout=600):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 3:
                try:
                    return e.code, json.loads(e.read() or b"{}")
                except ValueError:
                    return e.code, {}
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == 3:
                raise
        time.sleep(5 * (attempt + 1))


def count(rtype):
    st, b = http("GET", f"{BASE}/{rtype}?_summary=count")
    return b.get("total", 0) if st == 200 else None


# ---- 1. check the backup ---------------------------------------------------------------------------------------
mpath = os.path.join(a.folder, "manifest.json")
if not os.path.exists(mpath):
    stop(f"No manifest.json in {a.folder} (point at one server's folder, e.g. .../20261111-1440/prod)")
manifest = json.load(open(mpath))
types = [t for t in manifest["types"] if not a.types or t in a.types]
if a.types and set(a.types) - set(types):
    stop(f"Not in this backup: {', '.join(sorted(set(a.types) - set(types)))}")

log(f"Backup of '{manifest['server']}' ({manifest['base']}) taken {manifest['started'][:16]}, "
    f"{manifest['total']} resources")
bad = []
for t in types:
    info = manifest["types"][t]
    p = os.path.join(a.folder, f"{t}.ndjson.gz")
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    with gzip.open(p, "rt", encoding="utf-8") as f:
        lines = sum(1 for _ in f)
    if h.hexdigest() != info["sha256"] or lines != info["count"]:
        bad.append(f"{t} (sha256 {'ok' if h.hexdigest() == info['sha256'] else 'WRONG'}, "
                   f"{lines} lines vs {info['count']})")
if bad:
    stop("Backup files do not match the manifest: " + "; ".join(bad))
log(f"Files OK: {len(types)} types, checksums and counts match the manifest")

# ---- 2. compare with the target --------------------------------------------------------------------------------
st, cap = http("GET", f"{BASE}/metadata?_summary=true", timeout=60)
if st != 200:
    stop(f"Target {BASE} does not answer (HTTP {st})")
before = {t: count(t) for t in types}
print(f"\n  {'type':28} {'backup':>8} {'target now':>11}")
for t in sorted(types, key=lambda x: ORDER.index(x) if x in ORDER else 99):
    print(f"  {t:28} {manifest['types'][t]['count']:>8} {str(before[t]):>11}")
has_data = sum(n or 0 for n in before.values())
print()
if not a.apply:
    log("Dry run: nothing written. Add --apply to restore." +
        (f" Target already holds {has_data} of these resources: --target-has-data is needed." if has_data else ""))
    sys.exit(0)

if has_data:
    if not a.target_has_data:
        stop(f"Target already holds {has_data} resources of these types. Restoring overwrites any with the same "
                 "id. Re-run with --target-has-data if that is really intended.")
    answer = input(f"Target {BASE} is NOT empty. Type its address to continue: ").strip().rstrip("/")
    if answer != BASE:
        stop("Not confirmed, nothing written.")


# ---- 3. restore ------------------------------------------------------------------------------------------------
def load(t):
    with gzip.open(os.path.join(a.folder, f"{t}.ndjson.gz"), "rt", encoding="utf-8") as f:
        rs = [json.loads(line) for line in f]
    if t == "Location":  # parents before children
        by_id = {r["id"]: r for r in rs}
        depth = {}
        def d(i, seen=()):
            if i in depth:
                return depth[i]
            parent = ((by_id.get(i) or {}).get("partOf") or {}).get("reference", "").split("/")[-1]
            depth[i] = 0 if not parent or parent not in by_id or parent in seen else d(parent, seen + (i,)) + 1
            return depth[i]
        rs.sort(key=lambda r: d(r["id"]))
    for r in rs:
        r.get("meta", {}).pop("versionId", None)
    return rs


def send(entries):
    """PUT a list of resources in one batch; returns the resources that failed with their error."""
    bundle = {"resourceType": "Bundle", "type": "batch",
              "entry": [{"resource": r, "request": {"method": "PUT", "url": f"{r['resourceType']}/{r['id']}"}}
                        for r in entries]}
    st, b = http("POST", BASE, bundle)
    if st != 200 or "entry" not in b:
        diag = ((b.get("issue") or [{}])[0].get("diagnostics", "") if isinstance(b, dict) else "")[:300]
        return [(r, f"bundle HTTP {st} {diag}") for r in entries]
    failed = []
    for r, e in zip(entries, b["entry"]):
        status = (e.get("response") or {}).get("status", "")
        if not status.startswith(("200", "201")):
            oo = (e.get("response") or {}).get("outcome") or {}
            failed.append((r, f"{status} {(oo.get('issue') or [{}])[0].get('diagnostics', '')[:300]}"))
    return failed


t0 = time.time()
pending = []
for t in sorted(types, key=lambda x: ORDER.index(x) if x in ORDER else 99):
    rs = load(t)
    failed = []
    for k in range(0, len(rs), a.batch_size):
        failed += send(rs[k:k + a.batch_size])
    log(f"  {t:28} {len(rs) - len(failed)}/{len(rs)}" + (f"  ({len(failed)} to retry)" if failed else ""))
    pending += failed

for rnd in range(1, a.rounds + 1):
    if not pending:
        break
    log(f"Retry round {rnd}: {len(pending)} resources")
    retry, pending = [r for r, _ in pending], []
    for k in range(0, len(retry), a.batch_size):
        pending += send(retry[k:k + a.batch_size])

stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
if pending:
    errfile = f"restore-errors-{stamp}.json"
    with open(errfile, "w", encoding="utf-8") as f:
        json.dump([{"resource": f"{r['resourceType']}/{r['id']}", "error": err} for r, err in pending], f, indent=1)
    log(f"{len(pending)} resources could not be restored: see {errfile}")

# ---- 4. verify -------------------------------------------------------------------------------------------------
log(f"Restore took {round(time.time() - t0)} s. Counts on the target now:")
problems = 0
for t in sorted(types, key=lambda x: ORDER.index(x) if x in ORDER else 99):
    n, want = count(t), manifest["types"][t]["count"]
    ok = n is not None and n >= want
    problems += not ok
    print(f"  {t:28} {str(n):>8} / {want:<8} {'OK' if ok else 'MISSING'}")
log("RESTORE OK" if not problems and not pending else f"RESTORE INCOMPLETE: {problems} types short, "
                                                       f"{len(pending)} resources failed")
sys.exit(0 if not problems and not pending else 1)
