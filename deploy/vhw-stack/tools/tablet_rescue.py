#!/usr/bin/env python3
"""Recover the records a tablet never synced, from the app's "Export DB" file. Runs on a PC; touches no server
unless you pass --check (read-only GETs).

How the file is made: switch on DATABASE_EXPORT (tools/set_settings_menu.py), log in again on the tablet, open the
profile menu and tap "Export DB". The app writes a decrypted copy of its database, zipped with AES, to Downloads:
    _<username>_<practitioner-id>_<yyyyMMdd-HHmmss>.db.zip      (zip password: <username>_<first block of the id>)
Copy it off with:  adb pull /sdcard/Download/<file> .

What it does:
  1. unzips the file with 7-Zip (password worked out from the file name, or asked for),
  2. reads LocalChangeEntity (every change not yet accepted by the server) and, per record, the latest local copy
     from ResourceEntity,
  3. writes into rescue-<username>-<stamp>/:
       unsynced_bundle.json   FHIR transaction: PUT of every unsynced record as it is now on the tablet
       deleted.txt            records deleted on the tablet but not on the server (NOT in the bundle)
       unsynced.csv           one line per record: type, id, change types, when, summary, server state (--check)
       records/<Type>/<id>.json
  4. with --check <fhir base>: asks the server for each record and marks it new / older on server / same / newer
     on server (newer on server = someone changed it after the tablet: look before overwriting).

Upload (after checking the list) on the server, e.g. on .146:
    curl -s -X POST -H 'Content-Type: application/fhir+json' --data-binary @unsynced_bundle.json \\
         http://localhost:8080/fhir | python3 -m json.tool | head -50

  python tablet_rescue.py _neels.lotter_8d7e..._20261111-160000.db.zip
  python tablet_rescue.py export.db.zip --password-prompt
  python tablet_rescue.py resources.db                       # an already-unzipped database
  python tablet_rescue.py export.db.zip --check http://localhost:18080/fhir   # e.g. through a tunnel

The output holds REAL PERSONAL DATA: keep it on an encrypted disk and delete it (and the zip) when done.
"""
import argparse, csv, datetime, getpass, glob, json, os, re, shutil, sqlite3, subprocess, sys, tempfile
import urllib.error, urllib.request

NAME_RE = re.compile(r"^(?P<app>[^_]*)_(?P<user>.+)_(?P<prac>[0-9a-fA-F]{8}-[0-9a-fA-F-]{27})_(?P<ts>\d{8}-\d{6})\.db\.zip$")
SEVEN_ZIP = [shutil.which("7z"), shutil.which("7za"), r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe"]

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("file", help="the .db.zip from the tablet, or an unzipped .db")
ap.add_argument("--password-prompt", action="store_true", help="ask for the zip password instead of deriving it")
ap.add_argument("--check", metavar="FHIR_BASE", help="compare each record with this server (read-only)")
ap.add_argument("--out", help="output folder")
a = ap.parse_args()


def unzip(path):
    exe = next((p for p in SEVEN_ZIP if p and os.path.exists(p)), None)
    if not exe:
        sys.exit("7-Zip not found (needed for the AES zip). Install it or unzip by hand and pass the .db file.")
    m = NAME_RE.match(os.path.basename(path))
    if m and not a.password_prompt:
        pw = f"{m['user']}_{m['prac'].split('-')[0]}"
    else:
        pw = getpass.getpass("Zip password: ")
    tmp = tempfile.mkdtemp(prefix="rescue-")
    r = subprocess.run([exe, "x", "-y", f"-p{pw}", f"-o{tmp}", path], capture_output=True, text=True)
    dbs = glob.glob(os.path.join(tmp, "**", "*.db"), recursive=True)
    if r.returncode != 0 or not dbs:
        shutil.rmtree(tmp, ignore_errors=True)
        sys.exit("Could not unzip (wrong password?). Try --password-prompt.\n" + (r.stderr or r.stdout)[-400:])
    return dbs[0], tmp, (m["user"] if m else None)


tmpdir = None
user = None
if a.file.lower().endswith(".zip"):
    db_path, tmpdir, user = unzip(a.file)
else:
    db_path = a.file
    m = NAME_RE.match(os.path.basename(a.file) + ".zip")
    user = m["user"] if m else None

try:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"LocalChangeEntity", "ResourceEntity"} <= tables:
        sys.exit(f"Not a FHIR engine database (tables: {', '.join(sorted(tables))[:300]})")
    changes = con.execute("SELECT resourceType, resourceId, timestamp, type, payload FROM LocalChangeEntity "
                          "ORDER BY timestamp, id").fetchall()
    total_resources = con.execute("SELECT COUNT(*) FROM ResourceEntity").fetchone()[0]

    # one entry per record: all its change types, first/last change time
    recs = {}
    for c in changes:
        k = (c["resourceType"], c["resourceId"])
        payload = (c["payload"] or "").strip()
        kind = ("DELETE" if not payload else "UPDATE" if payload.startswith("[") else "INSERT")
        r = recs.setdefault(k, {"kinds": [], "first": c["timestamp"], "last": c["timestamp"]})
        r["kinds"].append(kind)
        r["last"] = c["timestamp"]

    current = {}
    for (rt, rid) in recs:
        row = con.execute("SELECT serializedResource FROM ResourceEntity WHERE resourceType=? AND resourceId=?",
                          (rt, rid)).fetchone()
        if row:
            current[(rt, rid)] = json.loads(row[0])
    con.close()
finally:
    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)


def when(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M") if ms else ""


def summary(r):
    rt = r.get("resourceType")
    if rt == "Patient":
        n = (r.get("name") or [{}])[0]
        return f"{' '.join(n.get('given', []))} {n.get('family', '')} {r.get('birthDate', '')}".strip()
    if rt == "Group":
        return f"{r.get('name', '')} ({len(r.get('member', []))} members)"
    if rt == "Task":
        return f"{(r.get('description') or '').strip()} [{r.get('status')}] for {(r.get('for') or {}).get('reference', '')}"
    if rt == "Encounter":
        t = (r.get("type") or [{}])[0]
        return f"{t.get('text') or (t.get('coding') or [{}])[0].get('display', '')} {(r.get('period') or {}).get('start', '')}"
    if rt == "QuestionnaireResponse":
        return f"{r.get('questionnaire', '')} {r.get('authored', '')}"
    if "code" in r:
        c = r["code"]
        return c.get("text") or (c.get("coding") or [{}])[0].get("display", "")
    return ""


def server_state(base, rt, rid, local):
    url = f"{base.rstrip('/')}/{rt}/{rid}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/fhir+json"}),
                                    timeout=30) as resp:
            srv = json.load(resp)
    except urllib.error.HTTPError as e:
        return "new (not on server)" if e.code == 404 else "deleted on server" if e.code == 410 else f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return f"error {e.reason}"
    s_ts = srv.get("meta", {}).get("lastUpdated", "")
    l_ts = (local or {}).get("meta", {}).get("lastUpdated", "")
    s_v = srv.get("meta", {}).get("versionId")
    l_v = (local or {}).get("meta", {}).get("versionId")
    if l_v and s_v and s_v != l_v:
        return f"newer on server (v{s_v}, tablet based on v{l_v}): check before upload"
    return f"on server v{s_v} {s_ts[:16]}; tablet changes not uploaded"


stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
out = a.out or f"rescue-{user or 'tablet'}-{stamp}"
os.makedirs(out, exist_ok=True)
try:
    os.chmod(out, 0o700)
except OSError:
    pass

entries, deleted, rows = [], [], []
for (rt, rid), info in sorted(recs.items(), key=lambda kv: kv[1]["first"]):
    res = current.get((rt, rid))
    state = server_state(a.check, rt, rid, res) if a.check else ""
    if res is None:
        deleted.append(f"{rt}/{rid}")
        rows.append([rt, rid, "+".join(info["kinds"]), when(info["first"]), when(info["last"]), "(deleted on tablet)", state])
        continue
    os.makedirs(os.path.join(out, "records", rt), exist_ok=True)
    with open(os.path.join(out, "records", rt, f"{rid}.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    body = json.loads(json.dumps(res))
    body.get("meta", {}).pop("versionId", None)  # let the server assign the next version
    entries.append({"fullUrl": f"{rt}/{rid}", "resource": body, "request": {"method": "PUT", "url": f"{rt}/{rid}"}})
    rows.append([rt, rid, "+".join(info["kinds"]), when(info["first"]), when(info["last"]), summary(res), state])

with open(os.path.join(out, "unsynced_bundle.json"), "w", encoding="utf-8") as f:
    json.dump({"resourceType": "Bundle", "type": "transaction", "entry": entries}, f, ensure_ascii=False, indent=1)
with open(os.path.join(out, "deleted.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(deleted) + ("\n" if deleted else ""))
with open(os.path.join(out, "unsynced.csv"), "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow(["type", "id", "changes", "first_change", "last_change", "summary", "server"])
    w.writerows(rows)

by_type = {}
for (rt, _), _info in recs.items():
    by_type[rt] = by_type.get(rt, 0) + 1
print(f"Database: {total_resources} records on the tablet, {len(changes)} unsynced changes on {len(recs)} records")
for rt, n in sorted(by_type.items(), key=lambda x: -x[1]):
    print(f"  {rt:24} {n}")
if a.check:
    flagged = [r for r in rows if r[6].startswith("newer on server")]
    print(f"Server check: {sum(1 for r in rows if r[6].startswith('new ('))} new, {len(flagged)} newer on server")
print(f"\nWritten to {out}/: unsynced_bundle.json ({len(entries)} PUTs), unsynced.csv, deleted.txt ({len(deleted)}), records/")
if not recs:
    print("Nothing to recover: every change on this tablet reached the server.")
