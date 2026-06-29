#!/usr/bin/env python3
"""One-off cleanup: strip references to deleted Questionnaires from BKM configs.

Recursively walks each JSON config and removes:
  1. composition entries: objects whose focus.reference is "Questionnaire/<deleted-id>"
  2. profile actions: parent objects containing a LAUNCH_QUESTIONNAIRE action whose
     questionnaire.id is a deleted id

Run with no args; rewrites the configured files in place.
"""

import json
import sys
from pathlib import Path

DELETED_IDS = {
    "a4f4462b-7407-4b53-a814-2618efe46c84",  # eCBIS Death Record
    "f642fe17-1d75-45a2-b813-3cfb69706cb0",  # Pregnancy Visit
    "6e946250-bc6b-42c9-b89a-57b643fd5923",  # Counselling
    "91c51999-0e04-495a-8d70-58c3aabefcab",  # Over 1Y Child Visit
    "843764a4-f507-4259-9ec0-1cd53308a04d",  # Screening
    "3276f55c-b25e-455b-ae4e-8846fb8fd039",  # Sick Child Over 2 Months
    "58fbddae-c5a0-4b86-832e-f516c96f3b85",  # Sick Child Under 2 Months
    "5a60a629-bcf4-4101-96ac-a5e07b35f30e",  # Under 1Y Child Visit
    "e14b5743-0a06-4ab5-aaee-ac158d4cb64f",  # Disease Follow Up
    "f7004382-ba3d-4f62-a687-6e9d18c09d3a",  # Disease Registration
    "9b1aa23b-577c-4fb2-84e3-591e6facaf82",  # Child Immunization
    "73382b6c-5d0b-4171-afb5-0d1d70f6abd3",  # Child Recurring Service
    "96639cda-9273-48bc-ac94-a7d39817caac",  # COVID Immunization (unnamed)
    "f0a04fc4-4179-4df4-b2dc-8b2eac444d0b",  # eCBIS Patient Creation Confirm
    "4acc8776-32b0-4440-a1b1-a11a12d79acb",  # FP Registration
    "9b22f3ed-e7e1-4222-bf72-1ced42696189",  # New Pregnancy Registration
    "405619ff-cde8-4379-b674-0a4735098b33",  # Pregnancy Outcome
    "c309abfa-7536-4c60-baea-cf631201f79e",  # Counter Referral
    "f2b5676b-83a9-4ea6-9bbc-e10f0f5b6f3f",  # Urgent Referral
}

DELETED_REFS = {f"Questionnaire/{i}" for i in DELETED_IDS}

TARGETS = [
    Path("config/fhir-bkm/bkm-configs/composition_config.json"),
    Path("config/fhir-bkm/bkm-configs/profiles/default_profile_config.json"),
    Path("config/fhir-bkm/bkm-configs/profiles/other_registers_profile_config.json"),
]


def should_drop(obj):
    """Return True if obj is a list entry that should be removed."""
    if not isinstance(obj, dict):
        return False
    # Composition shape: { "title": ..., "focus": { "reference": "Questionnaire/<id>" } }
    focus = obj.get("focus")
    if isinstance(focus, dict):
        ref = focus.get("reference")
        if ref in DELETED_REFS:
            return True
    # Profile shape: { "title": ..., "actions": [ {"workflow": "LAUNCH_QUESTIONNAIRE", "questionnaire": {"id": "<id>"}} ] }
    actions = obj.get("actions")
    if isinstance(actions, list):
        for a in actions:
            if not isinstance(a, dict):
                continue
            if a.get("workflow") == "LAUNCH_QUESTIONNAIRE":
                q = a.get("questionnaire", {})
                if isinstance(q, dict) and q.get("id") in DELETED_IDS:
                    return True
    return False


def walk(node):
    """Recursively walk node; mutate lists in place to drop matching entries."""
    if isinstance(node, list):
        kept = []
        for item in node:
            if should_drop(item):
                continue
            walk(item)
            kept.append(item)
        node[:] = kept
    elif isinstance(node, dict):
        for v in node.values():
            walk(v)


def process(path: Path) -> int:
    with path.open() as f:
        data = json.load(f)

    def count_refs(s: str) -> int:
        return sum(s.count(i) for i in DELETED_IDS)

    before = count_refs(json.dumps(data))
    walk(data)
    after = count_refs(json.dumps(data))

    with path.open("w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print(f"  {path}: refs {before} -> {after}")
    return before - after


def main():
    total = 0
    for p in TARGETS:
        if not p.exists():
            print(f"  {p}: missing — skipping")
            continue
        total += process(p)
    print(f"\nDone. Removed {total} reference(s) total.")


if __name__ == "__main__":
    main()
