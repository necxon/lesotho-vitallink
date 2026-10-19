#!/usr/bin/env python3
"""Create VHW, supervisor and portal users from a CSV file, completely: the Keycloak
account with the right groups, and for app users also the FHIR records and the care
team. Shows what it would do; changes nothing without --apply.

  KC_ADMIN_PASSWORD=... python3 tools/import_users_csv.py --csv users.csv            # check
  KC_ADMIN_PASSWORD=... python3 tools/import_users_csv.py --csv users.csv --apply    # create

Run on the server (Keycloak 127.0.0.1:8082/auth, HAPI 127.0.0.1:8080/fhir) or pass
--kc/--fhir. Without KC_ADMIN_PASSWORD the admin password is asked for.

CSV columns (header names are not case-sensitive; comma separated):
  username   required; lower case letters, digits, . _ - (3-50 characters)
  profile    vhw (default) | supervisor | data-manager | admin
             (an old "role" column is understood: bkm-user = vhw, bkm-supervisor = supervisor)
  firstName, lastName   recommended (the Practitioner's name in the app and portal)
  email      optional; VHWs usually have none
  careTeam   required for vhw and supervisor: the CareTeam id or its exact name
  password   optional; empty = a random one, written to the passwords file (not shown)

What each profile gets:
  vhw           groups ANDROID_PRACTITIONER + PROVIDER, attribute fhir_core_app_id=bkm,
                Practitioner + PractitionerRole + practitioner Group, member of careTeam
  supervisor    groups ANDROID_PRACTITIONER + SUPERVISOR, the same FHIR records and team
  data-manager  groups WEB_PRACTITIONER + Portal Data Manager (portal, no user management)
  admin         groups WEB_PRACTITIONER + Super Admin (portal + user management)
App users get a permanent password (the app cannot ask for a new one); portal users get
a temporary one and choose their own at first login.

Rows are checked first (in the file and against the server). A row whose username
already exists is skipped unless --update-existing. Rejected rows go to
<csv>-rejected.csv; generated passwords to new-passwords-<date>.csv (mode 600):
hand them out, then delete the file. Nothing is deleted on the server.
"""
import argparse
import csv
import datetime
import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from create_vhw_users import Api, fhir_records, add_to_care_teams, new_password  # noqa: E402

APP_ID = "bkm"
PROFILES = {
    "vhw": {"groups": ["ANDROID_PRACTITIONER", "PROVIDER"], "app": True},
    "supervisor": {"groups": ["ANDROID_PRACTITIONER", "SUPERVISOR"], "app": True},
    "data-manager": {"groups": ["WEB_PRACTITIONER", "Portal Data Manager"], "app": False},
    "admin": {"groups": ["WEB_PRACTITIONER", "Super Admin"], "app": False},
}
OLD_ROLES = {"bkm-user": "vhw", "bkm-supervisor": "supervisor"}
# the gateway needs exactly one of these: an app user must not be a portal user, and back
CONFLICT = {True: ["WEB_PRACTITIONER"], False: ["ANDROID_PRACTITIONER"]}
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,49}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        text = f.read()
    first = text.splitlines()[0] if text.strip() else ""
    if ";" in first and "," not in first:
        sys.exit(f"{path} uses ';' between columns (Excel with regional settings). Save it as "
                 "'CSV UTF-8 (comma delimited)', or replace ; with , and try again.")
    reader = csv.DictReader(text.splitlines())
    cols = {(c or "").strip().lower(): c for c in (reader.fieldnames or [])}
    if "username" not in cols:
        sys.exit(f"{path}: no 'username' column. Found: {', '.join(reader.fieldnames or []) or 'nothing'}")

    def cell(row, *keys):
        for k in keys:
            if k in cols and (row.get(cols[k]) or "").strip():
                return row[cols[k]].strip()
        return ""

    for n, row in enumerate(reader, start=2):
        if not any((v or "").strip() for v in row.values() if isinstance(v, str)):
            continue  # empty line
        profile = cell(row, "profile", "role").lower() or "vhw"
        yield n, {
            "username": cell(row, "username").lower(),
            "profile": OLD_ROLES.get(profile, profile),
            "first": cell(row, "firstname", "first name", "first_name"),
            "last": cell(row, "lastname", "last name", "last_name"),
            "email": cell(row, "email"),
            "team": cell(row, "careteam", "care team", "care_team"),
            "password": cell(row, "password"),
        }


def check_row(r, seen_users, seen_emails):
    if not USERNAME_RE.match(r["username"]):
        return f"username '{r['username']}' is not allowed (lower case letters, digits, . _ -; 3-50)"
    if r["profile"] not in PROFILES:
        return f"profile '{r['profile']}' is not allowed (allowed: {', '.join(PROFILES)})"
    if r["email"] and not EMAIL_RE.match(r["email"]):
        return f"'{r['email']}' is not a valid e-mail address"
    if PROFILES[r["profile"]]["app"] and not r["team"]:
        return f"careTeam is required for profile {r['profile']}"
    if r["password"] and len(r["password"]) < 8:
        return "password shorter than 8 characters"
    if r["username"] in seen_users:
        return "username appears twice in the file"
    if r["email"] and r["email"].lower() in seen_emails:
        return "e-mail appears twice in the file"
    return None


class Server:
    def __init__(self, kc, fhir, admin_user, admin_pw, dry_run):
        self.kc, self.fhir = kc.rstrip("/"), fhir.rstrip("/")
        self.base = f"{self.kc}/admin/realms/opensrp"
        self.admin_user, self.admin_pw = admin_user, admin_pw
        self.api = Api(dry_run)
        self.teams = {}

    def login(self):
        form = urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli",
                                       "username": self.admin_user, "password": self.admin_pw}).encode()
        try:
            tok = json.load(urllib.request.urlopen(
                f"{self.kc}/realms/master/protocol/openid-connect/token", form, timeout=30))
        except urllib.error.HTTPError as e:
            sys.exit(f"Keycloak admin login failed: HTTP {e.code}")
        except urllib.error.URLError as e:
            sys.exit(f"Keycloak not reachable at {self.kc}: {e.reason}")
        self.api.token = tok["access_token"]

    def get(self, url):
        return self.api.call("GET", url)

    def user(self, username):
        found = self.get(f"{self.base}/users?username={urllib.parse.quote(username)}&exact=true")
        return found[0] if found else None

    def email_owner(self, email):
        found = self.get(f"{self.base}/users?email={urllib.parse.quote(email)}&exact=true")
        return found[0]["username"] if found else None

    def team(self, ref):
        """CareTeam id or exact (case-insensitive) name -> (id, name), or an error string."""
        if ref in self.teams:
            return self.teams[ref]
        result = None
        try:
            t = self.api.call("GET", f"{self.fhir}/CareTeam/{urllib.parse.quote(ref)}")
            result = (t["id"], t.get("name", ""))
        except SystemExit:  # Api.call exits on HTTP errors (404 = not an id)
            hits = [e["resource"] for e in self.get(
                f"{self.fhir}/CareTeam?name={urllib.parse.quote(ref)}&_count=50").get("entry", [])
                if e["resource"].get("name", "").strip().lower() == ref.strip().lower()]
            if len(hits) == 1:
                result = (hits[0]["id"], hits[0].get("name", ""))
            else:
                result = f"care team '{ref}' " + ("not found" if not hits else f"matches {len(hits)} teams: use its id")
        self.teams[ref] = result
        return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--kc", default="http://127.0.0.1:8082/auth")
    ap.add_argument("--fhir", default="http://127.0.0.1:8080/fhir")
    ap.add_argument("--admin-user", default="admin", help="Keycloak master-realm admin")
    ap.add_argument("--apply", action="store_true", help="create the users (default: check only)")
    ap.add_argument("--update-existing", action="store_true",
                    help="also update users that already exist (groups, names, team); default: skip them")
    ap.add_argument("--passwords-out", default=f"new-passwords-{datetime.date.today():%Y%m%d}.csv")
    args = ap.parse_args()
    mode = "" if args.apply else "  (dry run)"
    if args.apply and os.path.exists(args.passwords_out):
        sys.exit(f"{args.passwords_out} already exists: hand out and delete it first, or pass --passwords-out")

    rows, rejected = [], []
    seen_users, seen_emails = set(), set()
    for n, r in read_csv(args.csv):
        reason = check_row(r, seen_users, seen_emails)
        if reason:
            rejected.append((n, r["username"], reason))
            continue
        seen_users.add(r["username"])
        if r["email"]:
            seen_emails.add(r["email"].lower())
        rows.append((n, r))
    print(f"{args.csv}: {len(rows) + len(rejected)} rows, {len(rejected)} rejected in the file")

    srv = Server(args.kc, args.fhir, args.admin_user,
                 os.environ.get("KC_ADMIN_PASSWORD") or getpass.getpass(f"Keycloak admin password ({args.admin_user}): "),
                 dry_run=not args.apply)
    srv.login()
    groups = {g["name"]: g["id"] for g in srv.get(f"{srv.base}/groups?max=500")}
    needed = sorted({g for r in rows for g in PROFILES[r[1]["profile"]]["groups"]})
    missing = [g for g in needed if g not in groups]

    # checks against the server, for every row, before anything is changed
    todo = []
    for n, r in rows:
        prof = PROFILES[r["profile"]]
        reason = None
        absent = [g for g in prof["groups"] if g not in groups]
        if absent:
            reason = f"group(s) {absent} do not exist on this server"
        existing = srv.user(r["username"])
        if not reason and existing and not args.update_existing:
            reason = "user already exists (skipped; use --update-existing to update it)"
        if not reason and r["email"]:
            owner = srv.email_owner(r["email"])
            if owner and owner != r["username"]:
                reason = f"e-mail already used by user '{owner}'"
        team = None
        if not reason and prof["app"]:
            team = srv.team(r["team"])
            if isinstance(team, str):
                reason = team
        if reason:
            rejected.append((n, r["username"], reason))
        else:
            todo.append((n, r, existing, team))

    print(f"to {'create or update' if args.update_existing else 'create'}: {len(todo)}   rejected: {len(rejected)}"
          + (f"   (groups missing on this server: {missing})" if missing else ""))
    rejected.sort()
    for n, user, reason in rejected:
        print(f"  row {n:<4} {user or '(no username)':28} REJECTED: {reason}")

    generated, done, failed = [], 0, 0
    for n, r, existing, team in todo:
        prof = PROFILES[r["profile"]]
        what = "update" if existing else "create"
        team_txt = f", care team '{team[1]}'" if team else ""
        print(f"  row {n:<4} {r['username']:28} {what} {r['profile']}: groups {prof['groups']}{team_txt}{mode}")
        if not args.apply:
            continue
        try:
            srv.login()  # admin tokens are short-lived
            api, base = srv.api, srv.base
            rep = {"username": r["username"], "firstName": r["first"], "lastName": r["last"], "enabled": True}
            if r["email"]:
                rep.update(email=r["email"], emailVerified=False)
            if prof["app"]:
                rep["attributes"] = {**(existing or {}).get("attributes", {}), "fhir_core_app_id": [APP_ID]}
            if existing:
                uid = existing["id"]
                api.call("PUT", f"{base}/users/{uid}", rep, write=True)
            else:
                api.call("POST", f"{base}/users", rep, write=True)
                uid = srv.user(r["username"])["id"]
            password = r["password"]
            if not existing and not password:
                password = new_password()
                generated.append((r["username"], r["profile"], password))
            if password:
                # app users: permanent (the app cannot change it); portal users: change at first login
                api.call("PUT", f"{base}/users/{uid}/reset-password",
                         {"type": "password", "value": password, "temporary": not prof["app"]}, write=True)
            current = {g["name"]: g["id"] for g in srv.get(f"{base}/users/{uid}/groups")}
            for g in prof["groups"]:
                if g not in current:
                    api.call("PUT", f"{base}/users/{uid}/groups/{groups[g]}", write=True)
            for g in CONFLICT[prof["app"]]:
                if g in current:
                    api.call("DELETE", f"{base}/users/{uid}/groups/{current[g]}", write=True)
            if prof["app"]:
                pref, display = fhir_records(api, srv.fhir, uid, r["first"] or r["username"], r["last"], lambda m: None)
                add_to_care_teams(api, srv.fhir, [team[0]], {pref: display})
            done += 1
        except SystemExit as e:  # Api.call exits on an HTTP error: record it, go on with the next row
            failed += 1
            rejected.append((n, r["username"], f"failed while {what}ing: {e}"))
            print(f"           FAILED: {e}")

    if rejected:
        out = os.path.splitext(args.csv)[0] + "-rejected.csv"
        with open(out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["row", "username", "reason"])
            w.writerows(rejected)
        print(f"rejected rows: {out}")
    if generated:
        fd = os.open(args.passwords_out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["username", "profile", "password", "must change at first login"])
            w.writerows((u, p, pw, "no" if PROFILES[p]["app"] else "yes") for u, p, pw in generated)
        print(f"generated passwords: {args.passwords_out} (readable by you only). Hand them out, then delete it.")
    if args.apply:
        print(f"\ndone: {done}   failed: {failed}   rejected before start: {len(rejected) - failed}")
    else:
        print("\nnothing changed. Run again with --apply to create the users above.")
    sys.exit(1 if rejected else 0)


if __name__ == "__main__":
    main()
