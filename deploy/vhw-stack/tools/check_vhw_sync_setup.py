#!/usr/bin/env python3
"""Check, for every app user, the chain the FHIR gateway needs before it lets a tablet sync.
Read only: it changes nothing.

    Keycloak user -> Practitioner (identifier = Keycloak user id)
                  -> CareTeam with that Practitioner as participant (active)
                  -> Organization (CareTeam.managingOrganization or PractitionerRole.organization)
                  -> OrganizationAffiliation (primary organization = that Organization)
                  -> Location (the village) that exists

A missing link makes the gateway answer every sync request with
"User un-authorized to GET /Patient. User assignment or sync strategy not configured correctly".

    python3 check_vhw_sync_setup.py                                  # on the server: 127.0.0.1 ports
    python3 check_vhw_sync_setup.py --kc http://<server>:8082/auth --fhir http://<server>:8080/fhir
    python3 check_vhw_sync_setup.py --district Mafeteng              # only users of one district
    python3 check_vhw_sync_setup.py --find notfound.txt              # also look up usernames Keycloak did not find

--find takes a file (one username per line) or a comma-separated list: each is matched to the
real usernames (ignoring case, quotes and - vs _) and the closest ones are shown.
The Keycloak admin password is read from KC_ADMIN_PASSWORD or asked for.
"""
import argparse, collections, csv, difflib, getpass, json, os, re, sys, urllib.error, urllib.parse, urllib.request
from collections import defaultdict


class Client:
    def __init__(self, kc, fhir):
        self.kc, self.fhir, self.token = kc.rstrip("/"), fhir.rstrip("/"), None

    def call(self, url):
        headers = {"Accept": "application/json", "Cache-Control": "no-cache"}
        if self.token and "/auth/" in url:
            headers["Authorization"] = "Bearer " + self.token
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            sys.exit(f"GET {url} failed: HTTP {e.code} {e.read()[:300]!r}")
        except urllib.error.URLError as e:
            sys.exit(f"GET {url} failed: {e.reason}")

    def login(self, user, pw):
        form = urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli",
                                       "username": user, "password": pw}).encode()
        try:
            self.token = json.load(urllib.request.urlopen(
                f"{self.kc}/realms/master/protocol/openid-connect/token", form, timeout=30))["access_token"]
        except urllib.error.HTTPError as e:
            sys.exit(f"Keycloak admin login failed: HTTP {e.code}")

    def users(self):
        out, first = [], 0
        while True:
            page = self.call(f"{self.kc}/admin/realms/opensrp/users?first={first}&max=500&briefRepresentation=false")
            out += page
            if len(page) < 500:
                return out
            first += 500

    def fhir_all(self, query):
        """Every resource of a search, following next links on our own base URL."""
        out, url = [], f"{self.fhir}/{query}"
        while url:
            b = self.call(url)
            out += [e["resource"] for e in b.get("entry", []) if "resource" in e]
            nxt = next((l["url"] for l in b.get("link", []) if l.get("relation") == "next"), None)
            if nxt:
                i = nxt.find("/fhir")
                nxt = self.fhir + nxt[i + len("/fhir"):] if i >= 0 else nxt
            url = nxt
        return out


def sync_strategy(c, app_id):
    """syncStrategy of the app's application config: Composition (identifier = app id) -> Binary
    with configType 'application'. Returns a list (e.g. ['Location']), or an error string."""
    import base64
    comps = c.fhir_all(f"Composition?identifier={urllib.parse.quote(app_id)}")
    if not comps:
        return f"no Composition for app id '{app_id}'"
    refs, todo = [], list(comps[0].get("section", []))
    while todo:
        s = todo.pop(0)
        todo += s.get("section", [])
        r = ref_id(s.get("focus"), "Binary")
        if r:
            refs.append(r)
    for r in refs:
        b = c.call(f"{c.fhir}/Binary/{r}")
        try:
            cfg = json.loads(base64.b64decode(b["data"])) if b.get("resourceType") == "Binary" else b
        except Exception:
            continue
        if isinstance(cfg, dict) and cfg.get("configType") == "application":
            return cfg.get("syncStrategy") or []
    return f"no application config in Composition for '{app_id}'"


def district_filter(c, district, problems, clues):
    """Split problems into (in the district, district unknown). A user is in the district when one of
    their villages lies under it, or their team/organization name mentions one of its health centres."""
    locs = c.fhir_all("Location?_count=1000&_elements=name,partOf")
    parent = {l["id"]: ref_id(l.get("partOf"), "Location") for l in locs}
    name = {l["id"]: l.get("name", "") for l in locs}
    roots = {i for i, n in name.items() if district.lower() in n.lower()}
    under = set()
    for i in parent:
        j, seen = i, set()
        while j and j not in seen:
            if j in roots:
                under.add(i)
                break
            seen.add(j)
            j = parent.get(j)
    has_children = {p for p in parent.values() if p}
    core = lambda n: re.sub(r"\b(hc|health cent(re|er)|clinic)\b", "", n.lower()).strip(" -")
    hcs = {core(name[i]) for i in under if i in has_children} - {""}
    hcs = {h for h in hcs if len(h) >= 4}
    inside, unknown = [], []
    for p in problems:
        text, user_locs = clues.get(p[0], ("", set()))
        low = text.lower()
        if user_locs & under or any(re.search(r"\b" + re.escape(h) + r"\b", low) for h in hcs):
            inside.append(p)
        elif not user_locs and not re.search(r"[a-z]{4}", low.replace("org team", "").replace("care team", "")):
            unknown.append(p)
    return inside, unknown


def ref_id(ref, kind):
    ref = (ref or {}).get("reference", "")
    return ref.split("/", 1)[1].split("/_history")[0] if ref.startswith(kind + "/") else None


def norm(name):
    return re.sub(r"[-_.\s]+", "_", re.sub(r"[\"'`’]", "", name.strip().lower()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kc", default="http://127.0.0.1:8082/auth")
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--admin-user", default="admin", help="Keycloak master-realm admin")
    ap.add_argument("--find", help="file or comma list of usernames Keycloak did not find")
    ap.add_argument("--csv", default="sync-setup-problems.csv", help="problems written here")
    ap.add_argument("--district", help="only report problems of users in this district (e.g. Mafeteng); "
                                       "users whose district cannot be told are listed separately")
    args = ap.parse_args()

    c = Client(args.kc, args.fhir)
    c.login(args.admin_user, os.environ.get("KC_ADMIN_PASSWORD")
            or getpass.getpass(f"Keycloak admin password ({args.admin_user}): "))

    print("Reading Keycloak users and FHIR records ...", flush=True)
    users = c.users()
    pract_by_kc = defaultdict(list)
    for p in c.fhir_all("Practitioner?_count=500&_elements=identifier,active"):
        for i in p.get("identifier", []):
            if i.get("use") == "secondary" and i.get("value"):
                pract_by_kc[i["value"]].append(p)
    teams_by_pract = defaultdict(list)
    for t in c.fhir_all("CareTeam?_count=500&_elements=name,status,participant,managingOrganization"):
        for part in t.get("participant", []):
            pid = ref_id(part.get("member"), "Practitioner")
            if pid:
                teams_by_pract[pid].append(t)
    orgs_by_pract = defaultdict(set)
    for r in c.fhir_all("PractitionerRole?_count=500&_elements=practitioner,organization"):
        pid, oid = ref_id(r.get("practitioner"), "Practitioner"), ref_id(r.get("organization"), "Organization")
        if pid and oid:
            orgs_by_pract[pid].add(oid)
    orgs = {o["id"]: o for o in c.fhir_all("Organization?_count=500&_elements=name,active")}
    locs_by_org = defaultdict(set)
    for a in c.fhir_all("OrganizationAffiliation?_count=500&_elements=organization,location,active"):
        oid = ref_id(a.get("organization"), "Organization")
        if oid and a.get("active", True):
            locs_by_org[oid] |= {ref_id(l, "Location") for l in a.get("location", [])} - {None}
    wanted = sorted({l for s in locs_by_org.values() for l in s})
    existing = set()
    for i in range(0, len(wanted), 100):
        existing |= {l["id"] for l in c.fhir_all(f"Location?_id={','.join(wanted[i:i + 100])}&_elements=id&_count=100")}

    app_of = {u["id"]: ((u.get("attributes") or {}).get("fhir_core_app_id") or [""])[0] for u in users}
    strategies = {a: sync_strategy(c, a) for a in sorted(set(app_of.values())) if a}
    print("\nApp ids (fhir_core_app_id) and their sync strategy:")
    for a, n in collections.Counter(app_of.values()).most_common():
        print(f"  {a or '(none)':24} {n:5} users   syncStrategy: {strategies.get(a, 'no app id: the gateway refuses the user')}")

    ok, problems, no_pract, clues = 0, [], [], {}
    by_strategy = collections.Counter()
    for u in sorted(users, key=lambda u: u["username"]):
        name, enabled = u["username"], u.get("enabled", True)
        strat = strategies.get(app_of[u["id"]])
        needs = (" ".join(strat) if isinstance(strat, list) else "").lower()
        ps = pract_by_kc.get(u["id"], [])
        if not ps:
            no_pract.append(name)  # portal/admin accounts have no Practitioner: listed separately
            continue
        p = ps[0]
        teams = teams_by_pract.get(p["id"], [])
        active = [t for t in teams if t.get("status", "active") == "active"]
        org_ids = {ref_id(o, "Organization") for t in active for o in t.get("managingOrganization", [])}
        org_ids = (org_ids | orgs_by_pract.get(p["id"], set())) - {None}
        locs = {l for o in org_ids for l in locs_by_org.get(o, set())}
        good_locs = locs & existing
        # what the gateway needs depends on the app's sync strategy
        loc_needed = "location" in needs or not needs
        if not isinstance(strat, list):
            why = f"app id '{app_of[u['id']]}': {strat}" if app_of[u["id"]] else "no fhir_core_app_id attribute"
        elif len(ps) > 1:
            why = f"{len(ps)} Practitioners carry this Keycloak id"
        elif "practitioner" in needs:
            ok += 1; by_strategy[needs] += 1
            continue
        elif "careteam" in needs and active:
            ok += 1; by_strategy[needs] += 1
            continue
        elif not org_ids or "careteam" in needs:
            # an organization can also come from PractitionerRole.organization, so only fail without one
            why = ("not a participant of any CareTeam" if not teams else
                   "only in inactive CareTeams: " + ", ".join(t.get("name", t["id"]) for t in teams) if not active else
                   "CareTeam has no managingOrganization: " + ", ".join(t.get("name", t["id"]) for t in active))
        elif not (org_ids & set(orgs)):
            why = "organization missing: " + ", ".join(sorted(org_ids))
        elif not loc_needed:  # Organization strategy: an existing organization is enough
            ok += 1; by_strategy[needs] += 1
            continue
        elif not locs:
            why = "organization has no OrganizationAffiliation with a village: " + ", ".join(
                orgs.get(o, {}).get("name", o) for o in sorted(org_ids))
        elif not good_locs:
            why = "affiliated village(s) do not exist: " + ", ".join(sorted(locs))
        else:
            ok += 1; by_strategy[needs] += 1
            continue
        if not enabled:
            why += " (user disabled)"
        problems.append((name, app_of[u["id"]], ", ".join(t.get("name", "") for t in active), why))
        clues[name] = (" ".join([t.get("name", "") for t in teams] + [orgs.get(o, {}).get("name", "") for o in org_ids]), locs)

    if args.district:
        problems, unknown = district_filter(c, args.district, problems, clues)
        print(f"\nDistrict filter '{args.district}': {len(problems)} problem user(s) in the district; "
              f"{len(unknown)} with no team, village or recognisable name (district unknown):")
        for name, app, teams, why in unknown:
            print(f"  ?  {name:32} {why}")

    print(f"\n{len(users)} Keycloak users: {ok} OK ({dict(by_strategy)}), {len(problems)} with a broken sync chain, "
          f"{len(no_pract)} without a Practitioner (portal/admin, or app users never set up)\n")
    print("Broken, by app id:", dict(collections.Counter(p[1] or "(none)" for p in problems)), "\n")
    if problems:
        print("Broken sync chain (the gateway refuses these users):")
        for name, app, teams, why in problems:
            print(f"  {name:32} {app or '(no app id)':14} {why}")
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["username", "app id", "care teams", "problem"])
            w.writerows(problems)
        print(f"\n  written to {args.csv}")
    if no_pract:
        print("\nNo Practitioner (fine for portal/admin users; an app user here cannot sync):")
        print("  " + ", ".join(no_pract))

    if args.find:
        text = open(args.find, encoding="utf-8").read() if os.path.isfile(args.find) else args.find
        src = re.split(r"[,\n]", text)  # names may contain spaces: split on commas and new lines only
        real = {norm(u["username"]): u["username"] for u in users}
        print("\nUsernames Keycloak did not find:")
        for raw in sorted({s.strip() for s in src if s.strip()}, key=str.lower):
            n = norm(raw)
            if n in real:
                print(f"  {raw:30} -> exists as {real[n]} (typed differently: quote, case or - vs _)")
                continue
            close = difflib.get_close_matches(n, list(real), n=3, cutoff=0.6)
            close += [k for k in real if n and (k.startswith(n + "_") or k.endswith("_" + n)) and k not in close][:3]
            print(f"  {raw:30} -> " + (", ".join(real[k] for k in close) if close else "no similar username"))


if __name__ == "__main__":
    main()
