#!/usr/bin/env python3
"""Rename the "Location Holder" level of the location tree to "Lesotho" and retire its
unused placeholder children. Shows what it would do; changes nothing without --apply.

  python3 tools/fix_location_root.py            # dry run
  python3 tools/fix_location_root.py --apply    # do it (test first, production after)

Tree today: Root FHIR Location > Location Holder > districts (+ placeholders
"Location Holder Sub", "Location Holder Two", "... Sub-Sub", "... Sub-Sub Two").
- "Location Holder" keeps its id, so the districts, villages and every reference to it
  stay as they are; only its name changes (the old name is kept as an alias).
- A placeholder is set to status=inactive only when nothing uses it: no child locations
  other than other placeholders, and no organization assignment, task
  or encounter pointing at it. Nothing is deleted.
Writes go straight to HAPI on this server (default http://127.0.0.1:8080/fhir).
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

HOLDER = "353ff6db-8167-4c8e-8a4c-ecf11aa19924"
NEW_NAME = "Lesotho"


def call(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base}/{path}", data=data, method=method,
                                 headers={"Content-Type": "application/fhir+json",
                                          "Accept": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def resolve_holder(base, given):
    """Use --holder if given; else the known id if it exists here; else the one location named exactly
    'Location Holder'. Stops if that is not exactly one location."""
    if given:
        return given
    try:
        call(base, "GET", f"Location/{HOLDER}?_elements=id")
        return HOLDER
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    found = call(base, "GET", "Location?name:exact=Location%20Holder&_elements=id,name&_count=10").get("entry", [])
    if len(found) != 1:
        sys.exit(f"cannot find the holder: the default id is not on this server and {len(found)} location(s) are "
                 "named exactly 'Location Holder'. Give --holder <id>. NOTHING done.")
    print(f"(holder id {found[0]['resource']['id']} found by name)")
    return found[0]["resource"]["id"]


SKIPPED = set()


def count(base, path):
    """Number of matches; 0 if this server does not support that search (reported once at the end)."""
    sep = "&" if "?" in path else "?"
    try:
        return call(base, "GET", f"{path}{sep}_summary=count").get("total", 0)
    except urllib.error.HTTPError as e:
        if e.code == 400:
            SKIPPED.add(path.split("?")[0] + "?" + path.split("?")[1].split("=")[0])
            return 0
        raise


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--holder", help="id of the 'Location Holder' location (default: the test server id, or "
                                     "found by exact name if that id does not exist on this server)")
    args = ap.parse_args()
    base = args.fhir.rstrip("/")
    mode = "" if args.apply else "  (dry run)"
    global HOLDER
    HOLDER = resolve_holder(base, args.holder)

    holder = call(base, "GET", f"Location/{HOLDER}")
    print(f"Location/{HOLDER}: \"{holder.get('name')}\"{mode}")
    if holder.get("name") == NEW_NAME:
        print(f"  already called {NEW_NAME}")
    else:
        aliases = holder.get("alias", [])
        if holder.get("name") and holder["name"] not in aliases:
            aliases.append(holder["name"])
        holder["alias"] = aliases
        holder["name"] = NEW_NAME
        holder.pop("meta", None)
        print(f"  rename to \"{NEW_NAME}\" (old name kept as alias)")
        if args.apply:
            call(base, "PUT", f"Location/{HOLDER}", holder)
            print("  done")

    # placeholders: every location whose name starts with "Location Holder", except the holder itself
    found = call(base, "GET", "Location?name=Location%20Holder&_count=50").get("entry", [])
    holders = [e["resource"] for e in found
               if e["resource"]["id"] != HOLDER and e["resource"].get("name", "").startswith("Location Holder")]
    holder_ids = {h["id"] for h in holders} | {HOLDER}
    print(f"\nplaceholders: {len(holders)}")
    usage = {}
    for loc in holders:
        lid = loc["id"]
        kids = call(base, "GET", f"Location?partof=Location/{lid}&_count=200&_elements=id,name").get("entry", [])
        real_kids = [k["resource"] for k in kids if k["resource"]["id"] not in holder_ids]
        uses = {
            "child locations": len(real_kids),
            "organization assignments": count(base, f"OrganizationAffiliation?location=Location/{lid}"),
            "tasks": count(base, f"Task?location=Location/{lid}"),
            "encounters": count(base, f"Encounter?location=Location/{lid}"),
        }
        usage[lid] = {k: v for k, v in uses.items() if v}
    # a placeholder that is in use keeps its placeholder parents active too
    parent = {h["id"]: h.get("partOf", {}).get("reference", "").split("/")[-1] for h in holders}
    keep = set()
    for lid, used in usage.items():
        node = lid if used else None
        while node in parent:
            keep.add(node)
            node = parent[node]
    for loc in holders:
        lid = loc["id"]
        used = usage[lid]
        state = loc.get("status")
        print(f"  {lid}  \"{loc.get('name')}\"  status={state}  in use: {used or 'no'}")
        if lid in keep:
            print("    kept: " + ("something uses it" if used else "a placeholder below it is in use"))
            continue
        if state == "inactive":
            print("    already inactive")
            continue
        print(f"    set status=inactive{mode}")
        if args.apply:
            loc["status"] = "inactive"
            loc.pop("meta", None)
            call(base, "PUT", f"Location/{lid}", loc)
            print("    done")

    if SKIPPED:
        print("\nnote: this server does not support these searches, so they were not checked: "
              + ", ".join(sorted(SKIPPED)) + " (tasks point at people, not locations)")
    print("\nnote: Butha-Buthe District does not exist in this tree; not created here "
          "(it needs the DHIS2 org unit id used for the other districts).")
    if not args.apply:
        print("\nnothing changed. Run again with --apply to do the above.")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read()[:300]!r}")
