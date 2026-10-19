#!/usr/bin/env python3
"""Unblock a phone whose upload is rejected with "HAPI-1094: Resource Group/<id> not found".

HAPI refuses a whole upload when one resource points at something that does not exist. The usual cause is a
household that was created and then removed on the phone before it ever synced: its Group never reached the
server, but another record (e.g. an Encounter) still points at it, so that phone's sync fails forever.

This creates an INACTIVE placeholder Group at the missing id. Nothing existing is changed or deleted.

  python3 placeholder_group.py <group-id> [<group-id> ...]            # dry run: checks only
  python3 placeholder_group.py <group-id> [<group-id> ...] --apply    # create the placeholder(s)

Finding the id(s):
  sudo docker logs --since 3h <hapi container> 2>&1 | grep -o "HAPI-1094: Resource Group/[0-9a-f-]* not found"
Refuses to touch an id that already exists. Default HAPI http://127.0.0.1:8080/fhir.
After applying, wait a few minutes and run the grep again: a phone can have more than one missing reference.
Undo: ask before deleting - the placeholder is harmless (inactive, no members).
"""
import argparse
import datetime
import json
import re
import sys
import urllib.error
import urllib.request

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def call(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # noqa: BLE001
        sys.exit(f"cannot reach {url.split('/fhir')[0]} ({e.__class__.__name__}) - wrong server or port? NOTHING done.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="+", help="the missing Group id(s) from the HAPI-1094 log line")
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    bad = [i for i in a.ids if not UUID.match(i)]
    if bad:
        print("not a valid id (expected a UUID like 54dd0975-057e-4ef8-93b9-9cae01f96d79):", bad)
        return 1
    today = datetime.date.today().isoformat()
    todo = []
    for gid in a.ids:
        code, _ = call("GET", f"{a.fhir}/Group/{gid}")
        if code == 200:
            print(f"Group/{gid}: already exists - not touching it")
        elif code in (404, 410):
            print(f"Group/{gid}: missing (HTTP {code}) - placeholder needed")
            todo.append(gid)
        else:
            print(f"Group/{gid}: unexpected HTTP {code} - stopping, nothing done")
            return 1
    if not todo:
        print("nothing to do")
        return 0
    if not a.apply:
        print(f"\nDry run - add --apply to create {len(todo)} inactive placeholder Group(s).")
        return 0
    for gid in todo:
        res = {"resourceType": "Group", "id": gid, "active": False, "type": "person", "actual": True,
               "name": f"PLACEHOLDER (household never uploaded) {today}",
               "meta": {"tag": [{"system": "https://vhw.gov.ls/placeholder", "code": "dangling-reference",
                                 "display": f"created {today} to unblock a phone upload (HAPI-1094)"}]}}
        code, out = call("PUT", f"{a.fhir}/Group/{gid}", res)
        print(f"Group/{gid}: HTTP {code}" + (f" version {out['meta']['versionId']}" if out else " - FAILED"))
        if code not in (200, 201):
            return 1
    print("\nDone. In a few minutes, re-run the HAPI-1094 grep: if a new id shows up, repeat with that id.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
