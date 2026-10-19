#!/usr/bin/env python3
"""Create (or update) full-access BKM users on a VHW server.

Run ON the server (test 192.0.2.114 or production 192.0.2.146), where
Keycloak listens on 127.0.0.1:8082/auth and HAPI on 127.0.0.1:8080/fhir.

For every user it does what the portal's "Add user" + team assignment does:
  Keycloak (realm opensrp): user, attribute fhir_core_app_id=bkm, groups
    Super Admin / PROVIDER / ANDROID_PRACTITIONER / SUPERVISOR (never WEB_PRACTITIONER),
    a permanent password (no "change password" step - the app cannot do one)
  Keycloak (realm master, unless --no-console): same username with the admin
    role, for the admin console
  HAPI: Practitioner (with the Keycloak id), PractitionerRole and practitioner
    Group ("Assigned practitioner"), and membership of the care team
    (default: Holy Family Care Team 2, i.e. Holy Family Org Team / Holy Family;
    --all-teams: every active care team, so the app syncs every area)

Existing users and records are updated, never duplicated, so it is safe to run
again. Nothing is deleted. Passwords are asked for interactively (leave empty
to generate one); they are shown once on screen and never written to disk.

  python3 create_vhw_users.py --dry-run     # show what would change
  python3 create_vhw_users.py               # do it
  python3 create_vhw_users.py --all-teams   # ... and join every care team
  python3 create_vhw_users.py --same-password   # one password for all users
  python3 create_vhw_users.py --portal-admin    # ... and give realm role "admin" (VitalLink web)

Preprod (jump host, no sudo):
  python3 tools/create_vhw_users.py --kc http://192.0.2.132:18182/auth       --fhir http://127.0.0.1:18180/fhir --only-default-team --portal-admin
"""
import argparse
import getpass
import json
import os
import secrets
import string
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

USERS = [
    # username, first name, last name, email
    # no email: the older test account "neels" already uses admin@example.org
    ("admin.user1", "Admin", "One", ""),
    ("admin.user2", "Admin", "Two", "admin@example.org"),
    ("admin.user3", "Admin", "Three", "admin@example.org"),
]
# Leave empty in git. A local copy may set it to skip the password prompt.
DEFAULT_PASSWORD = ""
GROUPS = ["Super Admin", "PROVIDER", "ANDROID_PRACTITIONER", "SUPERVISOR"]
# The gateway accepts exactly one of the WEB_CLIENT / ANDROID_CLIENT roles, so an app user must
# not also be in the portal group (WEB_PRACTITIONER gives WEB_CLIENT); it is removed if present
NOT_GROUPS = ["WEB_PRACTITIONER"]
APP_ID = "bkm"
CARE_TEAM = "5ab83232-a7aa-4c97-8d31-d1d16536dfc6"  # Holy Family Care Team 2
KUID = {"coding": [{"system": "http://hl7.org/fhir/identifier-type", "code": "KUID",
                    "display": "Keycloak user ID"}], "text": "Keycloak user ID"}
ASSIGNED = {"coding": [{"system": "http://snomed.info/sct", "code": "405623001",
                        "display": "Assigned practitioner"}]}


class Api:
    def __init__(self, dry_run):
        self.dry_run = dry_run
        self.token = None

    def call(self, method, url, body=None, write=False):
        if write and self.dry_run:
            return None
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token and "/auth/" in url:
            headers["Authorization"] = "Bearer " + self.token
        if "/fhir" in url:
            headers["Content-Type"] = "application/fhir+json"
            # HAPI reuses identical searches for 60 s; a cached "not found" would create duplicates
            headers["Cache-Control"] = "no-cache"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {url} failed: HTTP {e.code} {e.read()[:300]!r}")


def new_password():
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(14)) + "#7"


def ask_password(username):
    while True:
        p1 = getpass.getpass(f"Password for {username} (empty = generate): ")
        if not p1:
            return new_password(), True
        if len(p1) < 8:
            print("  at least 8 characters, try again")
            continue
        if p1 == getpass.getpass("  repeat: "):
            return p1, False
        print("  passwords differ, try again")


def kc_user(api, kc, realm, username, first, last, email, attributes, password, log):
    base = f"{kc}/admin/realms/{realm}"
    found = api.call("GET", f"{base}/users?username={urllib.parse.quote(username)}&exact=true")
    rep = {"username": username, "firstName": first, "lastName": last, "enabled": True,
           "emailVerified": bool(email), "requiredActions": []}
    if email:
        rep["email"] = email
    if attributes:
        rep["attributes"] = attributes
    if found:
        uid = found[0]["id"]
        log(f"{realm}: update existing user {username}")
        api.call("PUT", f"{base}/users/{uid}", rep, write=True)
    else:
        log(f"{realm}: create user {username}")
        api.call("POST", f"{base}/users", rep, write=True)
        found = api.call("GET", f"{base}/users?username={urllib.parse.quote(username)}&exact=true")
        uid = found[0]["id"] if found else "(new)"
    if password and uid != "(new)":
        api.call("PUT", f"{base}/users/{uid}/reset-password",
                 {"type": "password", "value": password, "temporary": False}, write=True)
        log(f"{realm}: permanent password set for {username}")
    return uid


def fhir_records(api, fhir, uid, first, last, log):
    display = f"{first} {last}"
    found = api.call("GET", f"{fhir}/Practitioner?identifier={uid}").get("entry", [])
    if found:
        pid = found[0]["resource"]["id"]
        log(f"FHIR: Practitioner {pid} already linked")
    else:
        pid = str(uuid.uuid4())
        log(f"FHIR: create Practitioner {pid}")
        api.call("PUT", f"{fhir}/Practitioner/{pid}", {
            "resourceType": "Practitioner", "id": pid,
            "identifier": [{"use": "official", "value": pid},
                           {"use": "secondary", "type": KUID, "value": uid}],
            "active": True,
            "name": [{"use": "official", "family": last, "given": [first]}]}, write=True)
    pref = f"Practitioner/{pid}"

    if api.dry_run and not found:
        log("FHIR: create PractitionerRole and practitioner Group")
    else:
        if not api.call("GET", f"{fhir}/PractitionerRole?practitioner={pref}").get("entry"):
            rid = str(uuid.uuid4())
            log(f"FHIR: create PractitionerRole {rid}")
            api.call("PUT", f"{fhir}/PractitionerRole/{rid}", {
                "resourceType": "PractitionerRole", "id": rid,
                "identifier": [{"use": "official", "value": rid},
                               {"use": "secondary", "type": KUID, "value": uid}],
                "active": True, "practitioner": {"reference": pref, "display": display},
                "code": [ASSIGNED]}, write=True)
        if not api.call("GET", f"{fhir}/Group?member={pref}&code=405623001").get("entry"):
            gid = str(uuid.uuid4())
            log(f"FHIR: create practitioner Group {gid}")
            api.call("PUT", f"{fhir}/Group/{gid}", {
                "resourceType": "Group", "id": gid,
                "identifier": [{"use": "official", "value": gid},
                               {"use": "secondary", "type": KUID, "value": uid}],
                "active": True, "type": "practitioner", "actual": True, "code": ASSIGNED,
                "name": display, "member": [{"entity": {"reference": pref}}]}, write=True)

    return pref, display


def next_page(page, fhir):
    """The bundle's next link, on our own base URL: HAPI writes its public address into
    paging links (https://<API_HOST>/fhir), which may not resolve from the server itself."""
    link = next((l["url"] for l in page.get("link", []) if l["relation"] == "next"), None)
    if not link:
        return None
    i = link.find("/fhir")
    return fhir + link[i + len("/fhir"):] if i >= 0 else link


def care_team_ids(api, fhir, all_teams):
    """The default care team, or every active care team that belongs to a team."""
    if not all_teams:
        return [CARE_TEAM]
    ids, url = [], f"{fhir}/CareTeam?status=active&_elements=id,managingOrganization&_count=200"
    while url:
        page = api.call("GET", url)
        ids += [e["resource"]["id"] for e in page.get("entry", [])
                if e["resource"].get("managingOrganization")]
        url = next_page(page, fhir)
    return ids


def add_to_care_teams(api, fhir, team_ids, practitioners):
    """Add the practitioners (reference -> display) to each care team, in batches."""
    changed, entries = 0, []
    for i, tid in enumerate(team_ids, 1):
        team = api.call("GET", f"{fhir}/CareTeam/{tid}")
        members = {p.get("member", {}).get("reference") for p in team.get("participant", [])}
        new = [ref for ref in practitioners if ref not in members]
        if new:
            team.setdefault("participant", []).extend(
                {"member": {"reference": ref, "display": practitioners[ref]}} for ref in new)
            team.pop("meta", None)
            entries.append({"resource": team, "request": {"method": "PUT", "url": f"CareTeam/{tid}"}})
            changed += 1
        if entries and (len(entries) == 50 or i == len(team_ids)):
            api.call("POST", fhir, {"resourceType": "Bundle", "type": "transaction", "entry": entries},
                     write=True)
            entries = []
    return changed


def leave_other_care_teams(api, fhir, keep, practitioners):
    """Remove the practitioners from every care team except `keep`, in batches."""
    changed, entries = 0, []
    url = f"{fhir}/CareTeam?_count=200"
    while url:
        page = api.call("GET", url)
        for e in page.get("entry", []):
            team = e["resource"]
            if team["id"] == keep:
                continue
            kept = [p for p in team.get("participant", [])
                    if p.get("member", {}).get("reference") not in practitioners]
            if len(kept) != len(team.get("participant", [])):
                team["participant"] = kept
                team.pop("meta", None)
                entries.append({"resource": team,
                                "request": {"method": "PUT", "url": f"CareTeam/{team['id']}"}})
                changed += 1
            if len(entries) == 50:
                api.call("POST", fhir, {"resourceType": "Bundle", "type": "transaction",
                                        "entry": entries}, write=True)
                entries = []
        url = next_page(page, fhir)
    if entries:
        api.call("POST", fhir, {"resourceType": "Bundle", "type": "transaction", "entry": entries},
                 write=True)
    return changed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kc", default="http://127.0.0.1:8082/auth")
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--admin-user", default="admin", help="Keycloak master-realm admin")
    ap.add_argument("--no-console", action="store_true", help="skip master-realm admin accounts")
    ap.add_argument("--only", help="comma-separated usernames to process")
    ap.add_argument("--same-password", action="store_true",
                    help="ask one password and use it for all users")
    ap.add_argument("--all-teams", action="store_true",
                    help="add the users to every active care team (the app then syncs all areas)")
    ap.add_argument("--only-default-team", action="store_true",
                    help="keep the users only in the default care team (undoes --all-teams)")
    ap.add_argument("--portal-admin", action="store_true",
                    help='give the opensrp realm role "admin" (created if missing): full access in '
                         'VitalLink web (bkm-web), which otherwise treats app users as VHWs')
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    users = [u for u in USERS if not args.only or u[0] in args.only.split(",")]

    api = Api(args.dry_run)
    # KC_ADMIN_PASSWORD lets the caller pass the server's own admin password without showing it
    admin_pw = os.environ.get("KC_ADMIN_PASSWORD") or getpass.getpass(
        f"Keycloak admin password ({args.admin_user}): ")

    def login():
        # admin-cli tokens are short-lived, so log in again before each user
        form = urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli",
                                       "username": args.admin_user, "password": admin_pw}).encode()
        try:
            tok = json.load(urllib.request.urlopen(
                f"{args.kc}/realms/master/protocol/openid-connect/token", form, timeout=30))
        except urllib.error.HTTPError as e:
            sys.exit(f"Keycloak admin login failed: HTTP {e.code}")
        api.token = tok["access_token"]

    login()

    groups = {g["name"]: g["id"] for g in api.call("GET", f"{args.kc}/admin/realms/opensrp/groups?max=200")}
    missing = [g for g in GROUPS if g not in groups]
    if missing:
        print(f"note: groups not in this realm, skipped: {missing}")
    admin_role = api.call("GET", f"{args.kc}/admin/realms/master/roles/admin")
    portal_role = None
    if args.portal_admin:
        roles = {r["name"]: r for r in api.call("GET", f"{args.kc}/admin/realms/opensrp/roles?max=500")}
        if "admin" not in roles:
            print('opensrp: create realm role "admin"' + (" (dry run)" if args.dry_run else ""))
            api.call("POST", f"{args.kc}/admin/realms/opensrp/roles",
                     {"name": "admin", "description": "VitalLink web (bkm-web): full access"}, write=True)
        portal_role = roles.get("admin") or (None if args.dry_run else
                                             api.call("GET", f"{args.kc}/admin/realms/opensrp/roles/admin"))
    team_ids = care_team_ids(api, args.fhir, args.all_teams)  # also fails early if HAPI is down
    print(f"care teams to join: {len(team_ids)}" + ("" if args.all_teams else " (Holy Family Care Team 2)"))
    practitioners = {}

    shown = []
    shared = None
    if (args.same_password or DEFAULT_PASSWORD) and not args.dry_run:
        shared = (DEFAULT_PASSWORD, False) if DEFAULT_PASSWORD else ask_password("all users")
    for username, first, last, email in users:
        print(f"\n== {username}{'  (dry run)' if args.dry_run else ''}")
        log = lambda m: print("  " + m)
        if args.dry_run:
            password, generated = None, False
        elif shared:
            password, generated = shared[0], False
        else:
            password, generated = ask_password(username)
        login()
        uid = kc_user(api, args.kc, "opensrp", username, first, last, email,
                      {"fhir_core_app_id": [APP_ID]}, password, log)
        for name in GROUPS:
            if name in groups and uid != "(new)":
                api.call("PUT", f"{args.kc}/admin/realms/opensrp/users/{uid}/groups/{groups[name]}", write=True)
        for name in NOT_GROUPS:
            if name in groups and uid != "(new)":
                api.call("DELETE", f"{args.kc}/admin/realms/opensrp/users/{uid}/groups/{groups[name]}",
                         write=True)
        log(f"opensrp: groups {[g for g in GROUPS if g in groups]} (not in {NOT_GROUPS})")
        if args.portal_admin:
            if portal_role and uid != "(new)":
                api.call("POST", f"{args.kc}/admin/realms/opensrp/users/{uid}/role-mappings/realm",
                         [{"id": portal_role["id"], "name": "admin"}], write=True)
            log('opensrp: realm role "admin" (VitalLink web)')
        if uid != "(new)":
            pref, display = fhir_records(api, args.fhir, uid, first, last, log)
            practitioners[pref] = display
        else:
            log("FHIR: Practitioner, PractitionerRole and practitioner Group")
        if not args.no_console:
            mid = kc_user(api, args.kc, "master", username, first, last, email, None, password, log)
            if mid != "(new)":
                api.call("POST", f"{args.kc}/admin/realms/master/users/{mid}/role-mappings/realm",
                         [admin_role], write=True)
            log("master: admin role (admin console)")
        if generated:
            shown.append((username, password))

    if practitioners and args.only_default_team:
        left = leave_other_care_teams(api, args.fhir, CARE_TEAM, practitioners)
        print(f"\nother care teams {'to leave' if args.dry_run else 'left'}: {left}")
    if practitioners:
        changed = add_to_care_teams(api, args.fhir, team_ids, practitioners)
        print(f"\ncare teams {'to update' if args.dry_run else 'updated'}: {changed} of {len(team_ids)}")
    elif args.dry_run:
        print(f"\ncare teams to update: {len(team_ids)} (users not created yet)")

    if shared and shared[1]:
        shown.append(("all users", shared[0]))
    if shown:
        print("\nGenerated passwords (shown once - store them in a password manager now):")
        for username, password in shown:
            print(f"  {username:20} {password}")
    print("\nDone." if not args.dry_run else "\nDry run only - nothing was changed.")


if __name__ == "__main__":
    main()
