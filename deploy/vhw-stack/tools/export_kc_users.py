#!/usr/bin/env python3
"""
export_kc_users.py - list every user of the opensrp realm to a CSV file.

    python export_kc_users.py prod     # https://vhw.gov.ls/auth      (admin: kc-admin-prod)
    python export_kc_users.py test     # https://app.vhw.gov.ls/auth  (admin: kc-admin-test)

Asks for the master-realm admin login (typed, not echoed). Writes
users-<env>-<date>.csv next to this script with: username, first/last name,
email, enabled, created, groups, fhir_core_app_id. Never exports passwords
(Keycloak does not hand them out). Read-only: only GET requests after login.
The CSV contains staff names and emails - keep it off shared drives and out of git.
"""
import csv, datetime, getpass, json, os, sys, urllib.parse, urllib.request

ENVS = {"prod": "https://vhw.gov.ls/auth", "test": "https://app.vhw.gov.ls/auth"}
if len(sys.argv) != 2 or sys.argv[1] not in ENVS:
    sys.exit(__doc__)
ENV = sys.argv[1]
BASE = ENVS[ENV]
REALM = "opensrp"

admin = input(f"{ENV} admin username (kc-admin-prod / kc-admin-test): ").strip()
password = getpass.getpass("password: ")


def token():
    data = urllib.parse.urlencode({"client_id": "admin-cli", "grant_type": "password",
                                   "username": admin, "password": password}).encode()
    with urllib.request.urlopen(f"{BASE}/realms/master/protocol/openid-connect/token", data, timeout=30) as r:
        return json.load(r)["access_token"]


TOKEN = token()


def get(path):
    # Admin tokens live 60 s; fetch a fresh one when the old one is refused.
    global TOKEN
    for attempt in (1, 2):
        req = urllib.request.Request(f"{BASE}/admin/realms/{REALM}/{path}",
                                     headers={"Authorization": f"Bearer {TOKEN}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt == 1:
                TOKEN = token()
                continue
            raise


total = get("users/count")
print(f"{total} users in realm {REALM} on {ENV}")

# Group membership via each group's member list: a few requests instead of one per user.
member_of = {}
def walk(groups):
    for g in groups:
        first_m = 0
        while True:
            members = get(f"groups/{g['id']}/members?first={first_m}&max=500&briefRepresentation=true")
            for m in members:
                member_of.setdefault(m["id"], []).append(g["path"].lstrip("/"))
            if len(members) < 500:
                break
            first_m += 500
        walk(g.get("subGroups") or [])
walk(get("groups?briefRepresentation=false"))

rows, first = [], 0
while True:
    page = get(f"users?first={first}&max=500&briefRepresentation=false")
    if not page:
        break
    for u in page:
        groups = member_of.get(u["id"], [])
        created = datetime.datetime.fromtimestamp(u.get("createdTimestamp", 0) / 1000).strftime("%Y-%m-%d")
        rows.append({
            "username": u.get("username", ""),
            "first_name": u.get("firstName", ""),
            "last_name": u.get("lastName", ""),
            "email": u.get("email", ""),
            "enabled": u.get("enabled"),
            "created": created,
            "groups": "; ".join(groups),
            "fhir_core_app_id": ";".join((u.get("attributes") or {}).get("fhir_core_app_id", [])),
            "keycloak_id": u["id"],
        })
    first += len(page)
    print(f"  {first}/{total}", end="\r")
password = None

out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   f"users-{ENV}-{datetime.date.today().isoformat()}.csv")
with open(out, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["username"])
    w.writeheader()
    w.writerows(rows)
print(f"\nwrote {len(rows)} users to {out}")
by_group = {}
for r in rows:
    for g in (r["groups"] or "(none)").split("; "):
        by_group[g] = by_group.get(g, 0) + 1
print("users per group:", ", ".join(f"{g} {n}" for g, n in sorted(by_group.items(), key=lambda x: -x[1])))
print("disabled:", sum(1 for r in rows if not r["enabled"]))
