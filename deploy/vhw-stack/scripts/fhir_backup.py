#!/usr/bin/env python3
"""Daily logical backup of every FHIR server listed in a config file. READ-ONLY on the servers (GET only).

For each server it asks which resource types exist, counts each type, then pages through every resource and
writes it as gzipped NDJSON:

    <backup-dir>/<yyyymmdd-HHMM>/<server>/<Type>.ndjson.gz
    <backup-dir>/<yyyymmdd-HHMM>/<server>/manifest.json     counts, expected counts, sha256 per file, timings
    <backup-dir>/<yyyymmdd-HHMM>/SUMMARY.txt

Old dated folders are deleted after --keep-days (default 14). A lock file stops two runs overlapping.
One server failing does not stop the others; the exit code is 1 if any server failed (so cron mail / monitoring
can notice).

What it is and is not:
  - It saves the CURRENT version of every resource (no _history). It is portable: any FHIR server can load it.
  - It is not a replacement for a database dump (scripts/backup.sh, pg_dump) on the host itself, which keeps
    history, search indexes and Keycloak. Keep both.
  - Files contain REAL PERSONAL DATA: the backup folder is created 700, files 600.

Config file (default: fhir_servers.conf next to this script), one server per line, '#' for comments:
    # name     base url
    test       http://<test-host>:8080/fhir
    prod       http://<prod-host>:8080/fhir

  python3 fhir_backup.py --check              # test that each server answers, show counts, write nothing
  python3 fhir_backup.py                      # back up all servers
  python3 fhir_backup.py --only prod          # one server
  python3 fhir_backup.py --dir /data/fhir-backups --keep-days 30

Every event (start, per-type counts, failures, prune, final result) is also appended to ~/log/fhir_backup.log
(change with --log-dir).

Cron (daily 01:30, as the backup user; the redirect only catches crashes, events go to ~/log/fhir_backup.log):
  30 1 * * * /usr/bin/python3 $HOME/backup/fhir_backup.py >> $HOME/log/fhir_backup.cron.log 2>&1
"""
import argparse, datetime, fcntl, gzip, hashlib, json, os, shutil, sys, time
import urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--config", default=os.path.join(HERE, "fhir_servers.conf"))
ap.add_argument("--dir", default=os.path.join(HERE, "fhir-backups"), help="where dated backup folders go")
ap.add_argument("--keep-days", type=int, default=14)
ap.add_argument("--only", nargs="*", help="server names to back up (default all)")
ap.add_argument("--check", action="store_true", help="connectivity and counts only, write nothing")
ap.add_argument("--page-size", type=int, default=500)
ap.add_argument("--timeout", type=int, default=300)
ap.add_argument("--log-dir", default=os.path.expanduser("~/log"),
                help="events are appended to <log-dir>/fhir_backup.log (default ~/log)")
a = ap.parse_args()

os.umask(0o077)  # logs, backups and error files: owner only (personal data)
os.makedirs(a.log_dir, mode=0o700, exist_ok=True)
LOGFILE = os.path.join(a.log_dir, "fhir_backup.log")


def log(msg):
    line = f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(LOGFILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def read_config(path):
    servers = []
    with open(path) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if line:
                name, url = line.split(None, 1)
                servers.append((name, url.strip().rstrip("/")))
    return servers


def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/fhir+json", "Cache-Control": "no-cache"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=a.timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 405):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            last = e
        time.sleep(5 * (attempt + 1))
    raise last


def resource_types(base):
    cap = get(f"{base}/metadata?_summary=true")
    types = set()
    for rest in cap.get("rest", []):
        for r in rest.get("resource", []):
            types.add(r["type"])
    return sorted(types)


def count(base, rtype):
    try:
        return get(f"{base}/{rtype}?_summary=count").get("total", 0)
    except urllib.error.HTTPError:
        return None


def pages(base, rtype):
    """Every resource of a type. 'next' links carry the server's public address; only the query is kept."""
    url = f"{base}/{rtype}?{urllib.parse.urlencode({'_count': a.page_size})}"
    while url:
        b = get(url)
        for e in b.get("entry", []):
            if "resource" in e and e.get("search", {}).get("mode", "match") == "match":
                yield e["resource"]
        nxt = [l["url"] for l in b.get("link", []) if l.get("relation") == "next"]
        url = f"{base}?{urllib.parse.urlsplit(nxt[0]).query}" if nxt else None


def backup_server(name, base, root):
    t0 = time.time()
    types = resource_types(base)
    counts = {t: count(base, t) for t in types}
    present = {t: n for t, n in counts.items() if n}
    log(f"[{name}] {base}: {sum(present.values())} resources in {len(present)} types")
    if a.check:
        for t, n in sorted(present.items(), key=lambda x: -x[1]):
            print(f"    {t:28} {n}")
        return {"ok": True}

    out = os.path.join(root, name)
    os.makedirs(out, mode=0o700, exist_ok=True)
    files = {}
    for t, expected in sorted(present.items()):
        path = os.path.join(out, f"{t}.ndjson.gz")
        n, seen = 0, set()
        with gzip.open(path, "wt", encoding="utf-8") as f:
            for r in pages(base, t):
                if r.get("id") in seen:  # paging over changing data can repeat a resource
                    continue
                seen.add(r.get("id"))
                f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
                n += 1
        os.chmod(path, 0o600)
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        files[t] = {"count": n, "expected": expected, "bytes": os.path.getsize(path), "sha256": h.hexdigest()}
        flag = "" if n >= expected else f"  (expected {expected})"
        log(f"[{name}]   {t:28} {n}{flag}")

    short = {t: v for t, v in files.items() if v["count"] < v["expected"]}
    manifest = {"server": name, "base": base, "started": datetime.datetime.fromtimestamp(t0).isoformat(),
                "seconds": round(time.time() - t0), "types": files,
                "total": sum(v["count"] for v in files.values()), "short_types": sorted(short)}
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    os.chmod(os.path.join(out, "manifest.json"), 0o600)
    log(f"[{name}] done: {manifest['total']} resources, {sum(v['bytes'] for v in files.values()) // 1024} KB, "
        f"{manifest['seconds']} s" + (f", SHORT: {', '.join(sorted(short))}" if short else ""))
    return {"ok": not short, "total": manifest["total"], "short": sorted(short)}


def prune(root_dir, keep_days):
    cutoff = time.time() - keep_days * 86400
    for d in sorted(os.listdir(root_dir)):
        p = os.path.join(root_dir, d)
        if os.path.isdir(p) and len(d) == 13 and d[8] == "-" and os.path.getmtime(p) < cutoff:
            shutil.rmtree(p)
            log(f"pruned {d}")


servers = read_config(a.config)
if a.only:
    servers = [s for s in servers if s[0] in a.only]
if not servers:
    log(f"ERROR no servers to back up (config {a.config})")
    sys.exit(1)

os.makedirs(a.dir, mode=0o700, exist_ok=True)
lock = open(os.path.join(a.dir, ".lock"), "w")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    log("ERROR another backup is still running, this run skipped")
    sys.exit(1)
log(f"START {'check' if a.check else 'backup'}: {', '.join(n for n, _ in servers)} -> {a.dir}")

root = os.path.join(a.dir, datetime.datetime.now().strftime("%Y%m%d-%H%M"))
if not a.check:
    os.makedirs(root, mode=0o700, exist_ok=True)

results = {}
for name, base in servers:
    try:
        results[name] = backup_server(name, base, root)
    except Exception as e:  # keep going with the other servers
        log(f"[{name}] FAILED: {type(e).__name__}: {e}")
        results[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"}

if not a.check:
    with open(os.path.join(root, "SUMMARY.txt"), "w") as f:
        for name, r in results.items():
            f.write(f"{name}: {'OK' if r['ok'] else 'PROBLEM'} {r.get('total', '')} {r.get('short') or r.get('error') or ''}\n")
    prune(a.dir, a.keep_days)

bad = [n for n, r in results.items() if not r["ok"]]
log(("ALL OK" if not bad else f"PROBLEMS: {', '.join(bad)}") + ("" if a.check else f"  -> {root}"))
sys.exit(1 if bad else 0)
