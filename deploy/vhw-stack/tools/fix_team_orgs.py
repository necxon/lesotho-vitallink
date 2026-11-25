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


MARKED = re.compile(r"(delete[sd]?|deleted|remove[sd]?|not|old|test|duplicate)", re.I)


def repair_all(fhir, a):
    """Every team with VHWs and an EMPTY managingOrganization gets the one participant organization
    that has a village link. Nothing else is touched; no name guessing."""
    say = (lambda *x: None) if a.quiet else print
    linked = set()
    for x in all_of(fhir, "OrganizationAffiliation?_count=500&_elements=organization,location,active"):
        oid = ref_id(x.get("organization"), "Organization")
        if oid and x.get("active", True) and any(ref_id(l, "Location") for l in x.get("location", [])):
            linked.add(oid)
    plan, unclear, marked = [], [], []
    for t in all_of(fhir, "CareTeam?_count=500&_elements=name,status,managingOrganization,participant"):
        if t.get("managingOrganization") or t.get("status", "active") != "active":
            continue
        if MARKED.search(t.get("name", "")):
            marked.append(t.get("name", ""))  # someone marked it in the name ("... delete", "NOT"): leave it to a person
            continue
        members = [p.get("member") for p in t.get("participant", [])]
        if not any(ref_id(m, "Practitioner") for m in members):
            continue  # no VHW in it: nobody is blocked
        orgs = sorted({ref_id(m, "Organization") for m in members} - {None})
        good = [o for o in orgs if o in linked]
        display = next((m.get("display", "") for m in members if ref_id(m, "Organization") == (good or [None])[0]), "")
        (plan if len(good) == 1 else unclear).append((t["id"], t.get("name", ""), good[0] if len(good) == 1 else None, display))
    stamp = f"{datetime.datetime.now():%Y-%m-%d %H:%M}"
    if marked:
        say(f"{stamp} {len(marked)} team(s) marked in their name (delete / not / old / test), left alone: " + "; ".join(marked))
    if unclear:
        say(f"{stamp} {len(unclear)} team(s) with VHWs but no organization, and not 1 clear candidate (left alone): "
            + "; ".join(n for _, n, _, _ in unclear))
    if not plan:
        say(f"{stamp} all teams with VHWs have an organization - nothing to do")
        return 0
    for tid, name, oid, disp in plan:
        print(f"{stamp} {'REPAIR' if a.apply else 'would repair'}: '{name}' [{tid}] -> Organization/{oid} {disp}")
    if not a.apply:
        return 0
    bdir = os.path.join(a.backup_dir, f"careteam-backup-{datetime.datetime.now():%Y%m%d-%H%M}")
    os.makedirs(bdir, exist_ok=True)
    for tid, name, oid, disp in plan:
        team = call("GET", f"{fhir}/CareTeam/{tid}")
        if team.get("managingOrganization"):
            continue  # someone fixed it meanwhile
        json.dump(team, open(os.path.join(bdir, f"CareTeam-{tid}.json"), "w", encoding="utf-8"), indent=1)
        team["managingOrganization"] = [{"reference": f"Organization/{oid}", **({"display": disp} if disp else {})}]
        team.pop("meta", None)
        out = call("PUT", f"{fhir}/CareTeam/{tid}", team)
        print(f"{stamp}   OK '{name}' version {out['meta']['versionId']} (backup {bdir})")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", nargs="?", help="problem CSV from check_vhw_sync_setup.py (omit with --all)")
    ap.add_argument("--all", action="store_true",
                    help="safety net for the fhir-web 3.3.2 bug (a team edit drops managingOrganization): "
                         "check EVERY care team; only fill an EMPTY managingOrganization from the one "
                         "organization the team lists as participant and that has a village. For cron.")
    ap.add_argument("--quiet", action="store_true", help="print only when something changes (for cron)")
    ap.add_argument("--backup-dir", default=".", help="where careteam-backup-<date>/ is created")
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    fhir = a.fhir.rstrip("/")
    if not a.all and not a.csv:
        ap.error("give the problem CSV, or --all")
    if a.all:
        return repair_all(fhir, a)

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
    teams = [t for t in all_of(fhir, "CareTeam?_count=500&_elements=name,managingOrganization,participant")
             if t.get("name", "").strip() in wanted]

    plan, skipped = [], []
    for t in sorted(teams, key=lambda t: t.get("name", "")):
        name = t.get("name", "").strip()
        current = [ref_id(m, "Organization") for m in t.get("managingOrganization", [])]
        if any(o in linked for o in current):
            continue  # this copy of the team is fine already
        org_name = re.sub(r"\s+care\s*team(\s*\d+)?\s*$", " Org Team", name, flags=re.I)
        # the portal lists the team organization as a participant too; trust that over the name
        member_orgs = {ref_id(p.get("member"), "Organization") for p in t.get("participant", [])} - {None}
        cands = sorted(o for o in member_orgs if o in linked)
        if not cands:
            cands = [o for o in orgs_by_name.get(org_name.lower(), []) if o in linked]
        now = ", ".join(f"'{orgs.get(o, o)}'" for o in current) or "none"
        who = ", ".join(sorted(users_by_team.get(name, [])))
        if len(cands) == 1:
            plan.append((t["id"], name, cands[0], now, who))
        else:
            skipped.append((name, now, f"{len(cands)} candidate organizations with a village (member or named {org_name!r})", who))

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
