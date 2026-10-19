#!/usr/bin/env python3
"""Hide app buttons that open a Questionnaire which does not exist on the server.

Symptom: tapping e.g. "Register EBS Signal" shows "Questionnaire not found. Sync all
questionnaires to fix" because the form is listed in the app configuration but was never loaded on
the server. Until the real forms are supplied, this removes those menu entries from the profile
configuration Binaries so VHWs do not hit the error.

For every profile Binary named in the Composition it looks at menu entries (overFlowMenuItems,
fabActions) whose actions all launch a Questionnaire, checks each Questionnaire with a GET, and
removes the entry only if it answers 404. Entries whose form exists are never touched.

  python3 hide_missing_form_buttons.py              # dry run: backup + list what would be hidden
  python3 hide_missing_form_buttons.py --apply      # write the Binaries back (new versions)

Default HAPI http://127.0.0.1:8080/fhir; preprod --fhir http://127.0.0.1:18180/fhir.
Safe to run twice. Devices pick it up after a full username/password login.
Undo: PUT the backup file back (paths printed). To restore a button later, load its form on the server
and PUT the backup of the profile Binary back.
"""
import argparse
import base64
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

MENU_KEYS = ("overFlowMenuItems", "fabActions")


def http(method, url, body=None, accept="application/fhir+json"):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": accept, "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def launches_only_questionnaires(item):
    actions = item.get("actions") or []
    return bool(actions) and all(
        a.get("workflow") == "LAUNCH_QUESTIONNAIRE" and (a.get("questionnaire") or {}).get("id") for a in actions)


def patch(cfg, exists):
    """Remove menu entries whose questionnaires are all missing. exists(id) -> bool. Returns changes."""
    changes = []

    def walk(o, path):
        if isinstance(o, dict):
            for k in MENU_KEYS:
                items = o.get(k)
                if not isinstance(items, list):
                    continue
                keep = []
                for i, it in enumerate(items):
                    if isinstance(it, dict) and launches_only_questionnaires(it):
                        ids = [a["questionnaire"]["id"] for a in it["actions"]]
                        gone = [q for q in ids if not exists(q)]
                        if gone and len(gone) == len(ids):
                            changes.append(f"hide {path}/{k}[{i}] \"{it.get('title')}\" (missing form {gone[0]})")
                            continue
                    keep.append(it)
                if len(keep) != len(items):
                    o[k] = keep
            for k, v in list(o.items()):
                walk(v, f"{path}/{k}")
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, f"{path}[{i}]")
    walk(cfg, "")
    return changes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-dir", default=os.path.expanduser(
        "~/config-backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    b = http("GET", f"{a.fhir}/Composition?identifier=bkm")
    if b.get("total") != 1:
        print(f"expected exactly one Composition with identifier bkm, found {b.get('total')} - nothing done")
        return 1
    comp = b["entry"][0]["resource"]
    cache = {}

    def exists(qid):
        if qid not in cache:
            try:
                urllib.request.urlopen(f"{a.fhir}/Questionnaire/{qid}", timeout=20)
                cache[qid] = True
            except urllib.error.HTTPError as e:
                cache[qid] = e.code != 404
            except Exception:
                cache[qid] = True  # unknown (network) -> do not hide
        return cache[qid]

    refs = []

    def collect(secs):
        for s in secs or []:
            r = (s.get("focus") or {}).get("reference", "")
            if r.startswith("Binary/") and "profile" in (s.get("title", "") + r).lower():
                refs.append((s.get("title", ""), r.split("/", 1)[1]))
            collect(s.get("section"))
    collect(comp.get("section"))
    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    total = 0
    for title, bid in refs:
        try:
            bn = http("GET", f"{a.fhir}/Binary/{bid}")
            cfg = json.loads(base64.b64decode(bn["data"]).decode("utf-8"))
        except Exception:
            continue
        if not isinstance(cfg, dict) or "overFlowMenuItems" not in json.dumps(cfg)[:200000] and "fabActions" not in json.dumps(cfg)[:200000]:
            continue
        bak = os.path.join(a.backup_dir, f"Binary-{bid}.json")
        if not os.path.exists(bak):
            json.dump(bn, open(bak, "w"))
        changes = patch(cfg, exists)
        print(f"== {title}  Binary/{bid}  version={bn.get('meta', {}).get('versionId')}")
        for c in changes or ["nothing to hide"]:
            print("   " + c)
        if changes:
            total += len(changes)
            if a.apply:
                bn["data"] = base64.b64encode(json.dumps(cfg, indent=2, ensure_ascii=False).encode("utf-8")).decode()
                r = http("PUT", f"{a.fhir}/Binary/{bid}", bn)
                print(f"   WRITTEN - now version {r.get('meta', {}).get('versionId')}   backup={bak}")
    print(f"\n{total} button(s) {'hidden' if a.apply else 'would be hidden'}."
          + ("" if a.apply else " Dry run - add --apply to write."))
    print(f"Undo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{a.backup_dir}/Binary-<id>.json "
          f"{a.fhir}/Binary/<id>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
