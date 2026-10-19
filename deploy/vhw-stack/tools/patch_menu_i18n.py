#!/usr/bin/env python3
"""Put the remaining plain-English menu labels into the translation files, with a DRAFT Sesotho text.

Adds new keys to the English and Sesotho translation Binaries (only keys that are missing; existing
lines are never changed) and replaces these plain-English labels with {{keys}}:
  - the "Other patients" register names in the navigation menu (ANC, PNC, FP, Mental health ...)
  - the profile menu entries of the "other registers" profile (Registration info, Record as Sick ...)
The Sesotho wording below is a DRAFT for the MoH language reviewers to correct (see the sheet
"Sesotho-translation-sheet.xlsx"). Corrections later = edit the Sesotho Binary, no app update.

  python3 patch_menu_i18n.py              # dry run: backup + show what would change
  python3 patch_menu_i18n.py --apply      # write the Binaries back (new versions)

Run patch_translation_keys.py first (it makes the Sesotho file load at all).
Default HAPI http://127.0.0.1:8080/fhir; preprod --fhir http://127.0.0.1:18180/fhir.
Safe to run twice. Devices pick it up after a full username/password login.
Undo: PUT the backup files back (paths printed).
"""
import argparse
import base64
import datetime
import json
import os
import sys
import urllib.request

# key -> (English, Sesotho DRAFT)
NEW = {
    "register.anc": ("ANC", "ANC"),
    "register.pnc": ("PNC", "PNC"),
    "register.fp": ("FP", "Thero ea malapa (FP)"),
    "register.mental.health": ("Mental health", "Bophelo ba kelello"),
    "register.hiv": ("HIV", "HIV"),
    "register.tb": ("TB", "Lefuba (TB)"),
    "register.hypertension": ("Hypertension", "Khatello e phahameng ea madi"),
    "register.diabetes": ("Diabetes", "Lefu la tsoekere"),
    "register.cancer": ("Cancer", "Kankere"),
    "register.asthma": ("Asthma", "Asma"),
    "register.paralysis": ("Paralysis", "Ho holofala"),
    "register.stroke": ("Stroke", "Stroke"),
    "register.epilepsy": ("Epilepsy", "Lefu la ho wa (epilepsy)"),
    "record.as.sick": ("Record as Sick", "Ngolisa e le ea kulang"),
    "record.anc.visit": ("Record ANC Visit", "Ngolisa ketelo ea ANC"),
    "register.service": ("Register Service", "Ngolisa tsebeletso"),
    "child.health.card": ("Child health card", "Karete ea bophelo ba ngoana"),
    "remove.this.person": ("Remove this person", "Hlakola motho enoa"),
}
# plain English label -> key (existing keys reused where the text already exists)
LABEL_KEY = {
    "ANC": "register.anc", "PNC": "register.pnc", "FP": "register.fp",
    "Mental health": "register.mental.health", "HIV": "register.hiv", "TB": "register.tb",
    "Hypertension": "register.hypertension", "Diabetes": "register.diabetes", "Cancer": "register.cancer",
    "Asthma": "register.asthma", "Paralysis": "register.paralysis", "Stroke": "register.stroke",
    "Epilepsy": "register.epilepsy",
    "Registration info": "registration.information", "Record as Sick": "record.as.sick",
    "Record Covid Vaccination": "record.covid.vaccination", "Register Pregnancy": "register.pregnancy",
    "Record ANC Visit": "record.anc.visit", "Pregnancy Outcome": "pregnancy.outcome",
    "Enroll to FP": "enroll.to.fp", "Register Service": "register.service",
    "Register with Disease": "register.disease", "Record Disease FollowUp": "record.disease.followUp",
    "Child health card": "child.health.card", "Past encounters": "past.encounters",
    "Upcoming encounters": "upcoming.encounters", "Remove this person": "remove.this.person",
}


def camel(s):
    parts = s.split("_")
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:] if p)


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                          "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def sections(secs):
    for s in secs or []:
        yield s
        yield from sections(s.get("section"))


def add_keys(text, lang_idx):
    """Append missing keys to a .properties text. Returns (new_text, [added keys])."""
    have = set()
    for line in text.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            have.add(line.split("=", 1)[0].strip())
    added = [k for k in NEW if k not in have]
    if not added:
        return text, []
    out = text if text.endswith("\n") or not text else text + "\n"
    out += "".join(f"{k}={NEW[k][lang_idx]}\n" for k in added)
    return out, added


def relabel(items, changes, where):
    for i, it in enumerate(items or []):
        if not isinstance(it, dict):
            continue
        for fld in ("display", "title"):
            v = it.get(fld)
            if isinstance(v, str) and v in LABEL_KEY:
                it[fld] = "{{" + LABEL_KEY[v] + "}}"
                changes.append(f"{where}[{i}].{fld}: \"{v}\" -> {it[fld]}")


def patch_nav(cfg):
    changes = []
    b = cfg.get("bottomSheetRegisters")
    if isinstance(b, dict):
        relabel(b.get("registers"), changes, "bottomSheetRegisters.registers")
    return changes


def patch_profile(cfg):
    changes = []
    relabel(cfg.get("overFlowMenuItems"), changes, "overFlowMenuItems")
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
    targets = {}  # kind -> (title, binary id)
    for s in sections(comp.get("section")):
        t = s.get("title", "")
        ref = (s.get("focus") or {}).get("reference", "")
        if not ref.startswith("Binary/"):
            continue
        bid = ref.split("/", 1)[1]
        low = t.lower()
        if low == "translation english":
            targets["en"] = (t, bid)
        elif low == "translation sesotho":
            targets["st"] = (t, bid)
        elif "navigation" in low:
            targets["nav"] = (t, bid)
        elif low.startswith("other registers profile"):
            targets["other"] = (t, bid)
    missing = [k for k in ("en", "st", "nav", "other") if k not in targets]
    if missing:
        print(f"could not find in the Composition: {missing} - nothing done")
        return 1
    os.makedirs(a.backup_dir, mode=0o700, exist_ok=True)
    plan = []
    for kind, (title, bid) in targets.items():
        bn = http("GET", f"{a.fhir}/Binary/{bid}")
        raw = base64.b64decode(bn["data"]).decode("utf-8")
        if kind in ("en", "st"):
            new, added = add_keys(raw, 0 if kind == "en" else 1)
            changes = [f"add key {k}" for k in added]
            newraw = new
        else:
            cfg = json.loads(raw)
            changes = patch_nav(cfg) if kind == "nav" else patch_profile(cfg)
            newraw = json.dumps(cfg, indent=2, ensure_ascii=False)
        print(f"== {title}  Binary/{bid}  version={bn.get('meta', {}).get('versionId')}")
        for c in changes or ["nothing to change"]:
            print("   " + c)
        if changes:
            plan.append((title, bid, bn, newraw))
    for title, bid, bn, newraw in plan:
        bak = os.path.join(a.backup_dir, f"Binary-{bid}.json")
        if not os.path.exists(bak):
            json.dump(bn, open(bak, "w"))
        if a.apply:
            bn["data"] = base64.b64encode(newraw.encode("utf-8")).decode()
            r = http("PUT", f"{a.fhir}/Binary/{bid}", bn)
            print(f"   WRITTEN {title}: now version {r.get('meta', {}).get('versionId')}   backup={bak}")
    if not plan:
        print("\nnothing to do - already up to date")
        return 0
    print("\n" + ("Done." if a.apply else "Dry run - add --apply to write.") +
          f"\nUndo: curl -X PUT -H 'Content-Type: application/fhir+json' --data @{a.backup_dir}/Binary-<id>.json "
          f"{a.fhir}/Binary/<id>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
