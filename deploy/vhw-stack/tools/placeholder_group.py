#!/usr/bin/env python3
"""Unblock a phone whose upload is rejected with "HAPI-1094: Resource Group/<id> not found"
(or Patient/<id> ... RelatedPerson.patient).

HAPI refuses a whole upload when one resource points at something that does not exist. The usual cause is a
household (or member) that was created and then removed on the phone before it ever synced: it never reached
the server, but another record (e.g. an Encounter) still points at it, so that phone's sync fails forever.

This creates an INACTIVE placeholder Group or Patient at the missing id. Nothing existing is changed or deleted.

  python3 placeholder_group.py <id> [Group/<id>] [Patient/<id>] ...          # dry run: checks only
  python3 placeholder_group.py <id> ... --apply                              # create the placeholder(s)

A bare id means Group. Task/<id> (or any other type) is only CHECKED: the dry run tells whether it never
existed on the server (404) or was deleted there (410) - useful for "HAPI-1997: Task/<id>" (an update of a
record the server does not have), which a placeholder does not fix.

Finding the id(s):
  sudo docker logs --since 3h <hapi container> 2>&1 | grep -oE "HAPI-1094: Resource [A-Za-z]+/[0-9a-f-]+ not found"
Refuses to touch an id that already exists. Default HAPI http://127.0.0.1:8080/fhir.
After applying, wait a few minutes and run the grep again: a phone can have more than one missing reference.
Undo: ask before deleting - the placeholder is harmless (inactive, no members, not linked to anyone).
"""
import argparse
import datetime
import json
import re
import sys
import urllib.error
import urllib.request

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PLACEHOLDER_TYPES = ("Group", "Patient")


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


def placeholder(rtype, rid, today):
    tag = {"system": "https://vhw.gov.ls/placeholder", "code": "dangling-reference",
           "display": f"created {today} to unblock a phone upload (HAPI-1094)"}
    if rtype == "Group":
        return {"resourceType": "Group", "id": rid, "active": False, "type": "person", "actual": True,
                "name": f"PLACEHOLDER (household never uploaded) {today}", "meta": {"tag": [tag]}}
    return {"resourceType": "Patient", "id": rid, "active": False,
            "name": [{"use": "official", "family": "PLACEHOLDER", "given": ["never uploaded"],
                      "text": f"PLACEHOLDER (member never uploaded) {today}"}], "meta": {"tag": [tag]}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="+", help="missing id(s): <id> (= Group), Group/<id>, Patient/<id>, Task/<id> (check only)")
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    refs = [(i.split("/", 1) if "/" in i else ["Group", i]) for i in a.ids]
    bad = [f"{t}/{i}" for t, i in refs if not UUID.match(i) or not re.match(r"^[A-Z][A-Za-z]+$", t)]
    if bad:
        print("not a valid id (expected a UUID like 54dd0975-057e-4ef8-93b9-9cae01f96d79, optionally Type/<uuid>):", bad)
        return 1
    today = datetime.date.today().isoformat()
    todo = []
    for rtype, rid in dict.fromkeys(map(tuple, refs)):
        code, _ = call("GET", f"{a.fhir}/{rtype}/{rid}")
        if code == 200:
            print(f"{rtype}/{rid}: already exists - not touching it")
        elif code in (404, 410):
            how = "never existed on the server" if code == 404 else "was DELETED on the server"
            if rtype in PLACEHOLDER_TYPES:
                print(f"{rtype}/{rid}: missing (HTTP {code}, {how}) - placeholder needed")
                todo.append((rtype, rid))
            else:
                print(f"{rtype}/{rid}: missing (HTTP {code}, {how}) - check only, no placeholder for {rtype}")
        else:
            print(f"{rtype}/{rid}: unexpected HTTP {code} - stopping, nothing done")
            return 1
    if not todo:
        print("nothing to create")
        return 0
    if not a.apply:
        print(f"\nDry run - add --apply to create {len(todo)} inactive placeholder(s).")
        return 0
    for rtype, rid in todo:
        code, out = call("PUT", f"{a.fhir}/{rtype}/{rid}", placeholder(rtype, rid, today))
        print(f"{rtype}/{rid}: HTTP {code}" + (f" version {out['meta']['versionId']}" if out else " - FAILED"))
        if code not in (200, 201):
            return 1
    print("\nDone. In a few minutes, re-run the HAPI-1094 grep: if a new id shows up, repeat with that id.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
