#!/usr/bin/env python3
"""Point broken care teams at the right team organization, so their VHWs can sync again.

A CareTeam called "<village> <HC> Care Team [N]" belongs to the Organization "<village> <HC> Org Team",
which is linked to the village (OrganizationAffiliation). Teams from older imports point at an
organization without a village (e.g. one named ".") or at none at all; the FHIR gateway then refuses
their VHWs ("User assignment or sync strategy not configured correctly").

Input: the CSV written by check_vhw_sync_setup.py (column "care teams" = the user's active teams).

    python3 fix_team_orgs.py sync-setup-problems.csv            # dry run: shows the plan
    python3 fix_team_orgs.py sync-setup-problems.csv --apply    # change the teams

Only CareTeam.managingOrganization changes. Each team is saved to careteam-backup-<date>/ first.
A team is left alone (and listed) when no organization of the expected name with a village exists,
or when several do.
"""
import argparse, csv, datetime, json, os, re, sys, urllib.error, urllib.request
from collections import defaultdict


def call(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Accept": "application/fhir+json", "Content-Type": "application/fhir+json", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} failed: HTTP {e.code} {e.read()[:300]!r}")


def all_of(fhir, query):
    out, url = [], f"{fhir}/{query}"
    while url:
        b = call("GET", url)
        out += [e["resource"] for e in b.get("entry", []) if "resource" in e]
        nxt = next((l["url"] for l in b.get("link", []) if l.get("relation") == "next"), None)
        url = (fhir + nxt[nxt.find("/fhir") + 5:]) if nxt and "/fhir" in nxt else nxt
    return out


def ref_id(ref, kind):
    r = (ref or {}).get("reference", "")
    return r.split("/", 1)[1].split("/_history")[0] if r.startswith(kind + "/") else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    fhir = a.fhir.rstrip("/")

    rows = list(csv.DictReader(open(a.csv, encoding="utf-8")))
    wanted = {t.strip() for r in rows for t in (r.get("care teams") or "").split(",") if t.strip()}
    users_by_team = defaultdict(set)
    for r in rows:
        for t in (r.get("care teams") or "").split(","):
            if t.strip():
                users_by_team[t.strip()].add(r["username"])
    no_team = [r["username"] for r in rows if not (r.get("care teams") or "").strip()]

    print("Reading organizations, village links and care teams ...", flush=True)
    orgs = {o["id"]: o.get("name", "") for o in all_of(fhir, "Organization?_count=500&_elements=name")}
    linked = defaultdict(set)
    for x in all_of(fhir, "OrganizationAffiliation?_count=500&_elements=organization,location,active"):
        oid = ref_id(x.get("organization"), "Organization")
        if oid and x.get("active", True) and any(ref_id(l, "Location") for l in x.get("location", [])):
            linked[oid] |= {ref_id(l, "Location") for l in x.get("location", [])}
    orgs_by_name = defaultdict(list)
    for oid, n in orgs.items():
        orgs_by_name[n.strip().lower()].append(oid)
    teams = [t for t in all_of(fhir, "CareTeam?_count=500&_elements=name,managingOrganization")
             if t.get("name", "").strip() in wanted]

    plan, skipped = [], []
    for t in sorted(teams, key=lambda t: t.get("name", "")):
        name = t.get("name", "").strip()
        current = [ref_id(m, "Organization") for m in t.get("managingOrganization", [])]
        if any(o in linked for o in current):
            continue  # this copy of the team is fine already
        org_name = re.sub(r"\s+care team(\s+\d+)?\s*$", " Org Team", name, flags=re.I)
        cands = [o for o in orgs_by_name.get(org_name.lower(), []) if o in linked]
        now = ", ".join(f"'{orgs.get(o, o)}'" for o in current) or "none"
        who = ", ".join(sorted(users_by_team.get(name, [])))
        if len(cands) == 1:
            plan.append((t["id"], name, cands[0], now, who))
        else:
            skipped.append((name, now, f"{len(cands)} organizations named '{org_name}' with a village", who))

    print(f"\n{len(plan)} team(s) to repoint:")
    for tid, name, oid, now, who in plan:
        print(f"  {name}  [{tid}]\n      organization {now} -> '{orgs[oid]}' [{oid}]   VHWs: {who}")
    if skipped:
        print(f"\n{len(skipped)} team(s) NOT changed (need a decision):")
        for name, now, why, who in skipped:
            print(f"  {name}: organization {now}; {why}   VHWs: {who}")
    if no_team:
        print(f"\n{len(no_team)} user(s) in the CSV have no care team at all (not handled here): {', '.join(no_team)}")
    if not plan or not a.apply:
        print("\nDry run - add --apply to change the teams above." if plan else "\nNothing to change.")
        return 0

    bdir = f"careteam-backup-{datetime.datetime.now():%Y%m%d-%H%M}"
    os.makedirs(bdir, exist_ok=True)
    for tid, name, oid, now, who in plan:
        team = call("GET", f"{fhir}/CareTeam/{tid}")
        json.dump(team, open(os.path.join(bdir, f"CareTeam-{tid}.json"), "w", encoding="utf-8"), indent=1)
        team["managingOrganization"] = [{"reference": f"Organization/{oid}", "display": orgs[oid]}]
        team.pop("meta", None)
        out = call("PUT", f"{fhir}/CareTeam/{tid}", team)
        print(f"  OK  {name} -> {orgs[oid]} (version {out['meta']['versionId']})")
    print(f"\nDone. Backups in {bdir}/. The VHWs need to sync (or log in again) to pick it up;")
    print("re-run check_setup.py --district <name> to confirm they are no longer listed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
