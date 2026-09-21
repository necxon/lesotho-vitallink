#!/usr/bin/env python3
"""
simplify_nav.py - remove side-menu items that duplicate the bottom-sheet switcher.

The Android side drawer renders TWO lists (AppDrawer.kt): the bottom-sheet
register switcher, and then staticMenu. Fourteen registers are in both, so every
health worker sees ANC, HIV, TB, Diabetes and eleven others twice, in two
different places. That duplication is most of why the menu feels complicated.

Removing them from staticMenu loses no access: they are still reachable through
the bottom sheet, which is what that control is for.

    python scripts/simplify_nav.py            # show what would change
    python scripts/simplify_nav.py --apply    # write it to HAPI

WHY THIS IS A SCRIPT AND NOT A curl ONE-LINER
This Binary has taken prod down before. `bottomSheetRegisters` is a single
OBJECT, not a list, and code that iterates it as a list silently rewrites it to
["display","visible",...], after which the app dies at startup with
`JsonDecodingException: Expected '{' but had '['`. So this script validates the
shape both before and after, and refuses to PUT anything that would repeat that.

RECOVERY
HAPI versions the Binary. If anything is wrong:
    curl http://localhost:8079/fhir/Binary/<id>/_history
    curl http://localhost:8079/fhir/Binary/<id>/_history/<n> > good.json
    curl -X PUT -H 'Content-Type: application/json' --data @good.json \
         http://localhost:8079/fhir/Binary/<id>
A device that already cached the bad config keeps crashing until its data is
cleared, so verify on the server before letting phones re-sync.
"""
import argparse
import json
import sys
import urllib.request

NAV_BINARY_ID = "d7ce0167-ee6a-4f8f-b644-50b0242513239e"
DEFAULT_FHIR = "http://127.0.0.1:8079/fhir"

# Items that must survive whatever else happens. If the de-duplication would
# remove one of these, something is wrong with the input and we stop.
PROTECTED = {"settings"}


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def put(url, doc):
    body = json.dumps(doc, indent=2).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="PUT",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.headers.get("ETag", "")


def validate_shape(doc, label):
    """The checks that would have prevented the 2026-06-23 outage."""
    problems = []
    if not isinstance(doc.get("staticMenu"), list):
        problems.append("staticMenu must be a LIST")
    if not isinstance(doc.get("clientRegisters"), list):
        problems.append("clientRegisters must be a LIST")

    bs = doc.get("bottomSheetRegisters")
    if not isinstance(bs, dict):
        problems.append(
            "bottomSheetRegisters must be an OBJECT - a list here crashes the app at startup"
        )
    else:
        if not isinstance(bs.get("registers"), list):
            problems.append("bottomSheetRegisters.registers must be a LIST")
        for key in ("display", "visible", "menuIconConfig"):
            if key not in bs:
                problems.append(f"bottomSheetRegisters is missing '{key}'")

    if not doc.get("appId"):
        problems.append("appId is missing")

    ids = {m.get("id") for m in doc.get("staticMenu", []) if isinstance(m, dict)}
    for pid in PROTECTED:
        if pid not in ids:
            problems.append(f"protected menu item '{pid}' is not in staticMenu")

    if problems:
        print(f"\nFAILED shape check ({label}):", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fhir", default=DEFAULT_FHIR, help="FHIR base URL")
    ap.add_argument("--id", default=NAV_BINARY_ID, help="nav Binary id")
    ap.add_argument("--apply", action="store_true", help="write the change (default: dry run)")
    ap.add_argument("--asset", default="config/fhir-bkm/bkm-configs/navigation_config.json",
                    help="also rewrite this bundled asset")
    args = ap.parse_args()

    url = f"{args.fhir}/Binary/{args.id}"
    print(f"Reading {url}")
    nav = fetch(url)

    if not validate_shape(nav, "before"):
        print("\nThe config on the server is already malformed. Not touching it.", file=sys.stderr)
        return 1

    static = nav["staticMenu"]
    sheet_ids = {r.get("id") for r in nav["bottomSheetRegisters"]["registers"]}

    keep, drop = [], []
    for item in static:
        if item.get("id") in sheet_ids and item.get("id") not in PROTECTED:
            drop.append(item)
        else:
            keep.append(item)

    print(f"\nstaticMenu: {len(static)} items")
    print(f"bottom sheet already offers: {len(sheet_ids)} registers\n")

    if not drop:
        print("Nothing duplicated. The menu is already de-duplicated.")
        return 0

    print(f"REMOVE from staticMenu ({len(drop)}) - each still reachable via the bottom sheet:")
    for m in drop:
        print(f"  - {m.get('id'):<24} {m.get('display', '')}")
    print(f"\nKEEP ({len(keep)}):")
    for m in keep:
        vis = m.get("visible")
        note = "" if vis is None else f"   (visible: {vis})"
        print(f"  - {m.get('id'):<24} {m.get('display', '')}{note}")

    # Rebuild by copying, touching staticMenu ONLY. Every other key, including
    # bottomSheetRegisters, is carried across untouched by reference.
    updated = dict(nav)
    updated["staticMenu"] = keep

    if not validate_shape(updated, "after"):
        print("\nRefusing to write a config that fails its own checks.", file=sys.stderr)
        return 1

    print(f"\nResult: {len(static)} menu items -> {len(keep)}")

    if not args.apply:
        print("\nDry run. Re-run with --apply to write it.")
        return 0

    status, etag = put(url, updated)
    print(f"\nPUT {url} -> HTTP {status}  version {etag}")

    verify = fetch(url)
    if not validate_shape(verify, "readback"):
        print("\nREAD-BACK FAILED. Restore from _history immediately.", file=sys.stderr)
        return 1
    print(f"Read back OK: staticMenu={len(verify['staticMenu'])}, "
          f"bottomSheetRegisters={type(verify['bottomSheetRegisters']).__name__}, "
          f"registers={len(verify['bottomSheetRegisters']['registers'])}")

    if args.asset:
        try:
            with open(args.asset, encoding="utf-8") as f:
                asset = json.load(f)
            asset["staticMenu"] = [
                m for m in asset.get("staticMenu", [])
                if m.get("id") not in sheet_ids or m.get("id") in PROTECTED
            ]
            with open(args.asset, "w", encoding="utf-8") as f:
                json.dump(asset, f, indent=2, ensure_ascii=False)
                f.write("\n")
            print(f"Updated bundled asset {args.asset} "
                  f"(matters only for fresh seeds and APK builds)")
        except FileNotFoundError:
            print(f"Bundled asset {args.asset} not found - skipped")

    print("\nPhones pick this up on their next config sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
