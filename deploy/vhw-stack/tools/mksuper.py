#!/usr/bin/env python3
"""Create the Keycloak user 'superadmin' in realm opensrp: web-portal account with realm-admin.

  python3 mksuper.py <master-realm admin>            # dry run: prints the plan, changes nothing
  python3 mksuper.py <master-realm admin> --apply    # create it (asks for a temporary password)

Run on the server (Keycloak at http://127.0.0.1:8082/auth). Asks for the admin's password, or reads
KC_ADMIN_PASSWORD. The new account joins groups WEB_PRACTITIONER and "Super Admin", gets
fhir_core_app_id=bkm, realm-admin and the portal permission roles; it must change its password at
the first sign-in. Sign in at https://<host>/auth/admin/opensrp/console/ (not /auth/admin/).
"""
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request as u

KC, REALM = "http://127.0.0.1:8082/auth", "opensrp"
ADMIN = sys.argv[1]
NAME = "superadmin"
APPLY = "--apply" in sys.argv
NEEDED = [f"{v}_{r}" for r in ("ORGANIZATION", "ORGANIZATIONAFFILIATION", "LOCATION", "CARETEAM",
                               "PRACTITIONER", "PRACTITIONERROLE", "GROUP") for v in ("GET", "POST", "PUT")]


def call(m, url, tok=None, body=None, form=None):
    h = {"Authorization": "Bearer " + tok} if tok else {}
    d = None
    if body is not None:
        d = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if form:
        d = urllib.parse.urlencode(form).encode()
    try:
        r = u.urlopen(u.Request(url, data=d, method=m, headers=h), timeout=60)
        raw = r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} on {m} {url.split('/admin/')[-1]}: {e.read()[:200]}")
    return json.loads(raw) if raw else None


pw = os.environ.get("KC_ADMIN_PASSWORD") or getpass.getpass(f"Keycloak admin password for {ADMIN}: ")
tok = call("POST", KC + "/realms/master/protocol/openid-connect/token",
           form={"grant_type": "password", "client_id": "admin-cli", "username": ADMIN, "password": pw})["access_token"]
adm = KC + "/admin/realms/" + REALM
found = call("GET", f"{adm}/users?username={NAME}&exact=true", tok)
plan = []
uid = found[0]["id"] if found else None
plan.append("user exists" if uid else "create user (must set a new password at first sign-in)")
groups = {}
for g in ("WEB_PRACTITIONER", "Super Admin"):
    r = [x for x in call("GET", f"{adm}/groups?search={urllib.parse.quote(g)}&exact=true", tok) if x["name"] == g]
    groups[g] = r[0]["id"] if r else None
    plan.append(f"join group {g}" if r else f"group {g} not found - skipped")
rm = call("GET", f"{adm}/clients?clientId=realm-management", tok)[0]["id"]
admin_role = call("GET", f"{adm}/clients/{rm}/roles/realm-admin", tok)
plan += ["set attribute fhir_core_app_id=bkm", "grant realm-admin (Keycloak console, this realm)"]
realm_roles = {r["name"]: r for r in call("GET", f"{adm}/roles?max=1000", tok)}
extra = [realm_roles[n] for n in NEEDED if n in realm_roles]
plan.append(f"add {len(extra)} portal permission roles directly (those that exist)")
print("Plan for", NAME, "on", KC)
for p in plan:
    print("  -", p)
if not APPLY:
    print("Dry run - add --apply.")
    sys.exit(0)
if not uid:
    newpw = getpass.getpass("New temporary password for superadmin (hidden, not stored): ")
    call("POST", f"{adm}/users", tok, body={
        "username": NAME, "enabled": True, "emailVerified": True,
        "attributes": {"fhir_core_app_id": ["bkm"]},
        "credentials": [{"type": "password", "value": newpw, "temporary": True}]})
    uid = call("GET", f"{adm}/users?username={NAME}&exact=true", tok)[0]["id"]
else:
    usr = call("GET", f"{adm}/users/{uid}", tok)
    usr.setdefault("attributes", {})["fhir_core_app_id"] = ["bkm"]
    call("PUT", f"{adm}/users/{uid}", tok, body=usr)
for g, gid in groups.items():
    if gid:
        call("PUT", f"{adm}/users/{uid}/groups/{gid}", tok)
call("POST", f"{adm}/users/{uid}/role-mappings/clients/{rm}", tok, body=[admin_role])
if extra:
    call("POST", f"{adm}/users/{uid}/role-mappings/realm", tok, body=extra)
print("Done. Sign in at /auth/admin/opensrp/console/ or the web portal; change the password when asked.")
