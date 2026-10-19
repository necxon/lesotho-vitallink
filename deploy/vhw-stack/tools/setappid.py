#!/usr/bin/env python3
"""Give Keycloak users the attribute fhir_core_app_id=bkm. The gateway answers 401 "The provided token
has no fhir_core_app_id claim" for a user without it (seen on the web portal's location page).

  python3 setappid.py <username> [<username> ...]    # dry run: shows the current value
  python3 setappid.py <username> --apply             # set it (the user must sign in again)
  python3 setappid.py --missing                      # list enabled users without it

Edit ADMIN below if the master admin is not kc-admin-test. Run on the server; asks for the admin's password.
"""
import getpass
import json
import os
import sys
import urllib.parse
import urllib.request as u

KC, REALM, ADMIN = "http://127.0.0.1:8082/auth", "opensrp", "kc-admin-test"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
apply, missing = "--apply" in sys.argv, "--missing" in sys.argv
pw = os.environ.get("KC_ADMIN_PASSWORD") or getpass.getpass("Keycloak admin password: ")


def call(m, url, tok=None, body=None, form=None):
    h = {"Authorization": "Bearer " + tok} if tok else {}
    d = None
    if body is not None:
        d = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if form:
        d = urllib.parse.urlencode(form).encode()
    r = u.urlopen(u.Request(url, data=d, method=m, headers=h), timeout=60)
    raw = r.read()
    return json.loads(raw) if raw else None


tok = call("POST", KC + "/realms/master/protocol/openid-connect/token",
           form={"grant_type": "password", "client_id": "admin-cli", "username": ADMIN, "password": pw})["access_token"]
adm = KC + "/admin/realms/" + REALM
if missing:
    first, out = 0, []
    while True:
        page = call("GET", f"{adm}/users?first={first}&max=200", tok)
        out += [x for x in page if x.get("enabled") and "fhir_core_app_id" not in (x.get("attributes") or {})]
        if len(page) < 200:
            break
        first += 200
    print(len(out), "enabled users without fhir_core_app_id:", ", ".join(x["username"] for x in out))
for name in args:
    found = call("GET", f"{adm}/users?username={urllib.parse.quote(name)}&exact=true", tok)
    if not found:
        print(name, ": not found")
        continue
    usr = found[0]
    attrs = usr.get("attributes") or {}
    print(name, ": fhir_core_app_id =", attrs.get("fhir_core_app_id", "MISSING"))
    if attrs.get("fhir_core_app_id") == ["bkm"]:
        continue
    if apply:
        attrs["fhir_core_app_id"] = ["bkm"]
        usr["attributes"] = attrs
        call("PUT", f"{adm}/users/{usr['id']}", tok, body=usr)
        print("   set to bkm")
    else:
        print("   dry run: would set to bkm (add --apply)")
