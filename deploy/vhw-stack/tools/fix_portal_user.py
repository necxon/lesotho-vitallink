#!/usr/bin/env python3
"""Check, and with --apply fix, a Keycloak user so the web portal (fhir-web) can save
through the gateway. Shows what it would do; changes nothing without --apply.

  KC_ADMIN_PASSWORD=... python3 tools/fix_portal_user.py <username>            # check
  KC_ADMIN_PASSWORD=... python3 tools/fix_portal_user.py <username> --apply    # fix
  KC_ADMIN_PASSWORD=... python3 tools/fix_portal_user.py --scan                # list refused users
  KC_ADMIN_PASSWORD=... python3 tools/fix_portal_user.py firstname.lastname --create       --email admin@example.org --first Firstname --last Lastname [--apply]     # new portal user

The gateway refuses every request from a user that holds neither or both of the
realm roles WEB_CLIENT and ANDROID_CLIENT ("User must have at least one and at most one
of these client roles"). A portal user must hold WEB_CLIENT only:
  - joins group WEB_PRACTITIONER (gives WEB_CLIENT)
  - leaves group ANDROID_PRACTITIONER and drops a direct ANDROID_CLIENT role, if any
    (an account used in the phone app must keep ANDROID_CLIENT: use a separate portal
    account for it; the script refuses unless --force)
It also sets the attribute fhir_core_app_id=bkm (the gateway answers 401 "token has no fhir_core_app_id
claim" without it) and lists the permission roles the gateway checks for the portal's organization,
location and team screens, and with --apply adds the missing ones directly to the user.
Run on the server: Keycloak at http://127.0.0.1:8082/auth (preprod: --kc .../18182/auth).
"""
import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PORTAL_GROUP = "WEB_PRACTITIONER"
APP_ID = "bkm"  # attribute fhir_core_app_id: the gateway refuses a token without it (401)
APP_GROUP = "ANDROID_PRACTITIONER"
# what the portal's Organizations / Locations / Teams / Users screens read and write
NEEDED = [f"{verb}_{res}" for res in ("ORGANIZATION", "ORGANIZATIONAFFILIATION", "LOCATION",
                                      "CARETEAM", "PRACTITIONER", "PRACTITIONERROLE", "GROUP")
          for verb in ("GET", "POST", "PUT")]


class Kc:
    def __init__(self, base, realm):
        self.base, self.realm, self.token = base.rstrip("/"), realm, None

    def login(self, user, password):
        self.creds = (user, password)
        form = urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli",
                                       "username": user, "password": password}).encode()
        try:
            r = urllib.request.urlopen(f"{self.base}/realms/master/protocol/openid-connect/token",
                                       form, timeout=30)
        except urllib.error.HTTPError as e:
            sys.exit(f"Keycloak admin login failed: HTTP {e.code}")
        self.token = json.load(r)["access_token"]

    def call(self, method, path, body=None, retry=True):
        url = f"{self.base}/admin/realms/{self.realm}/{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry:  # admin-cli tokens expire after about a minute
                self.login(*self.creds)
                return self.call(method, path, body, retry=False)
            sys.exit(f"{method} {url} failed: HTTP {e.code} {e.read()[:200]!r}")


def effective_roles(kc, uid):
    return {r["name"] for r in kc.call("GET", f"users/{uid}/role-mappings/realm/composite")}


def scan(kc, summary=False):
    users, first = [], 0
    while True:
        page = kc.call("GET", f"users?first={first}&max=200&briefRepresentation=true")
        users += page
        if len(page) < 200:
            break
        first += 200
    bad, portal, app, disabled = [], [], 0, 0
    for u in users:
        if not u.get("enabled"):
            disabled += 1
            continue
        held = sorted(effective_roles(kc, u["id"]) & {"WEB_CLIENT", "ANDROID_CLIENT"})
        if held == ["WEB_CLIENT"]:
            portal.append((u["username"], u.get("email", "-")))
        elif held == ["ANDROID_CLIENT"]:
            app += 1
        if len(held) != 1:
            groups = [g["name"] for g in kc.call("GET", f"users/{u['id']}/groups")]
            bad.append((u["username"], held, groups))
    if summary:
        print(f"users: {len(users)}  (disabled: {disabled})")
        print(f"  phone app only (ANDROID_CLIENT): {app}")
        print(f"  web portal only (WEB_CLIENT):    {len(portal)}")
        for name, email in sorted(portal):
            print(f"      {name:28} {email}")
        print(f"  refused by the gateway:          {len(bad)}")
    print(f"enabled users checked: {sum(1 for u in users if u.get('enabled'))}; refused by the gateway: {len(bad)}")
    for name, held, groups in sorted(bad):
        print(f"  {name:28} client roles={held or 'none'}  groups={groups}")


VERBS = {"GET": "read", "POST": "create", "PUT": "edit", "DELETE": "delete"}


def permissions(roles):
    """{resource: {read, create, edit, delete}} from roles like GET_PATIENT / MANAGE_TASK."""
    out = {}
    for r in roles:
        verb, _, res = r.partition("_")
        if not res or verb not in VERBS and verb != "MANAGE":
            continue
        out.setdefault(res.title(), set()).update(VERBS.values() if verb == "MANAGE" else {VERBS[verb]})
    return out


def describe_permissions(perms):
    order = list(VERBS.values())
    by_set = {}
    for res, verbs in perms.items():
        by_set.setdefault(" ".join(v for v in order if v in verbs), []).append(res)
    return "; ".join(f"{verbs}: {', '.join(sorted(res))}" for verbs, res in
                     sorted(by_set.items(), key=lambda x: -len(x[0]))) or "none"


def can_use(client):
    if client == ["ANDROID_CLIENT"]:
        return "phone app (syncs and records for their assigned area)"
    if client == ["WEB_CLIENT"]:
        return "web portal (what the permissions allow)"
    return "nothing: the gateway refuses this account (needs exactly one of WEB_CLIENT / ANDROID_CLIENT)"


def report(kc, out_path):
    """Every user: what they can use, groups, Keycloak admin rights and FHIR permissions.
    Prints one line per kind of account; writes one row per user to a CSV (mode 600)."""
    import csv
    import datetime
    users, first = [], 0
    while True:
        page = kc.call("GET", f"users?first={first}&max=200")
        users += page
        if len(page) < 200:
            break
        first += 200
    rm = kc.call("GET", "clients?clientId=realm-management")
    rm_id = rm[0]["id"] if rm else None
    rows, kinds = [], {}
    for i, u in enumerate(users, 1):
        roles = effective_roles(kc, u["id"])
        client = sorted(roles & {"WEB_CLIENT", "ANDROID_CLIENT"})
        groups = sorted(g["name"] for g in kc.call("GET", f"users/{u['id']}/groups"))
        admin = sorted(r["name"] for r in kc.call(
            "GET", f"users/{u['id']}/role-mappings/clients/{rm_id}/composite")) if rm_id else []
        admin_txt = ("full Keycloak admin of this realm" if "realm-admin" in admin else
                     ", ".join(a for a in admin if a.startswith("manage-")) or "none")
        perms = describe_permissions(permissions(roles))
        use = can_use(client) if u.get("enabled") else "nothing: account disabled"
        if not u.get("enabled") or len(client) != 1:
            section = "not working"
        elif admin_txt != "none" or "Super Admin" in groups:
            section = "admin"
        elif client == ["WEB_CLIENT"]:
            section = "portal"
        else:
            section = "phone app"
        rows.append([section, u["username"], u.get("firstName", ""), u.get("lastName", ""),
                     u.get("email", ""), u.get("enabled"), "/".join(client) or "none", use,
                     " | ".join(groups), admin_txt, perms])
        key = (section, use, " | ".join(groups), admin_txt, perms)
        kinds.setdefault(key, []).append(u["username"])
        if i % 100 == 0:
            print(f"  ... {i} of {len(users)} users read", file=sys.stderr)

    titles = {"admin": "ADMIN ACCOUNTS (Keycloak admin rights or group Super Admin)",
              "portal": "WEB PORTAL ACCOUNTS",
              "phone app": "PHONE APP ACCOUNTS (VHWs)",
              "not working": "NOT WORKING (refused by the gateway, or disabled)"}
    print(f"users: {len(users)}")
    for sec, title in titles.items():
        groups_in = {k: v for k, v in kinds.items() if k[0] == sec}
        total = sum(len(v) for v in groups_in.values())
        print(f"\n{'=' * 78}\n{title}: {total}\n{'=' * 78}")
        for (_, use, groups, admin_txt, perms), names in sorted(groups_in.items(), key=lambda x: -len(x[1])):
            # admin, portal and broken accounts are few: name them all; VHWs are many: show a sample
            limit = 8 if sec == "phone app" else len(names)
            shown = ", ".join(sorted(names)[:limit]) + (
                f", ... (+{len(names) - limit})" if len(names) > limit else "")
            print(f"\n-- {len(names)} account(s): {shown}")
            print(f"   can use:        {use}")
            print(f"   groups:         {groups or 'none'}")
            print(f"   Keycloak admin: {admin_txt}")
            print(f"   permissions:    {perms}")

    out_path = out_path or f"/root/kc-users-{datetime.date.today():%Y%m%d}.csv"
    with open(os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["section", "username", "first name", "last name", "email", "enabled", "client role",
                    "can use", "groups", "keycloak admin", "permissions"])
        order = list(titles)
        w.writerows(sorted(rows, key=lambda r: (order.index(r[0]), r[1])))
    print(f"one row per user: {out_path} (readable by root only: it holds names and emails)")


APP_GROUPS = [APP_GROUP, "PROVIDER"]


def realm_management_id(kc):
    rm = kc.call("GET", "clients?clientId=realm-management")
    return rm[0]["id"] if rm else None


def find_group(kc, name):
    found = [g for g in kc.call("GET", "groups?max=500") if g["name"] == name]
    return found[0] if found else None


def change_groups(kc, user, join, leave, mode, apply):
    """Join first, then leave, so a user moved between groups is never left without access."""
    uid = user["id"]
    groups = {g["name"]: g["id"] for g in kc.call("GET", f"users/{uid}/groups")}
    print(f"user {user['username']} ({uid}) groups={sorted(groups) or 'none'}")
    steps = []
    for n in join:
        g = find_group(kc, n)
        if not g:
            sys.exit(f"no group '{n}' (create it first)")
        if n in groups:
            print(f"  already in group {n}")
        else:
            steps.append((f"join group {n}", "PUT", f"users/{uid}/groups/{g['id']}"))
    for n in leave:
        if n in groups:
            steps.append((f"leave group {n}", "DELETE", f"users/{uid}/groups/{groups[n]}"))
        else:
            print(f"  not in group {n}: nothing to do")
    print(f"changes{mode}:" if steps else "nothing to change")
    for text, method, path in steps:
        print(f"  - {text}")
        if apply:
            kc.call(method, path)
    if apply and steps:
        rm_id = realm_management_id(kc)
        admin = sorted(r["name"] for r in kc.call(
            "GET", f"users/{uid}/role-mappings/clients/{rm_id}/composite")) if rm_id else []
        held = sorted(effective_roles(kc, uid) & {"WEB_CLIENT", "ANDROID_CLIENT"})
        print(f"after: groups={sorted(g['name'] for g in kc.call('GET', f'users/{uid}/groups'))}  "
              f"client roles={held}  keycloak admin={[a for a in admin if a.startswith('manage-') or a == 'realm-admin'] or 'none'}")
    elif steps:
        print("\nnothing changed. Run again with --apply to do the above.")


def group_members(kc, gid):
    members, first = [], 0
    while True:
        page = kc.call("GET", f"groups/{gid}/members?first={first}&max=500&briefRepresentation=true")
        members += page
        if len(page) < 500:
            return members
        first += 500


def group_drop_roles(kc, name, roles_csv, mode, apply):
    """Remove realm roles from a group (affects every member)."""
    g = find_group(kc, name)
    if not g:
        sys.exit(f"no group '{name}'")
    wanted = [r.strip() for r in roles_csv.split(",") if r.strip()]
    have = {r["name"]: r for r in kc.call("GET", f"groups/{g['id']}/role-mappings/realm")}
    drop = [have[r] for r in wanted if r in have]
    for r in wanted:
        if r not in have:
            print(f"  group {name} does not have {r}: nothing to do")
    n = len(group_members(kc, g["id"]))
    print(f"group {name}: {n} members")
    print(f"remove from the group{mode}: {[r['name'] for r in drop] or 'nothing'}")
    if drop and apply:
        kc.call("DELETE", f"groups/{g['id']}/role-mappings/realm",
                [{"id": r["id"], "name": r["name"]} for r in drop])
        rm_id = realm_management_id(kc)
        eff = sorted(r["name"] for r in kc.call(
            "GET", f"groups/{g['id']}/role-mappings/clients/{rm_id}/composite")) if rm_id else []
        print(f"done. Keycloak admin roles the group now gives: {eff or 'none'}")
        print("members get the change at their next login or token refresh (within minutes)")
    elif drop:
        print("\nnothing changed. Run again with --apply to do the above.")
        print(f"undo later: add the role(s) back to group {name} in the admin console (Groups > {name} > Role mapping)")


def group_add_roles(kc, name, roles_csv, mode, apply):
    """Add realm roles to a group (affects every member)."""
    g = find_group(kc, name)
    if not g:
        sys.exit(f"no group '{name}'")
    wanted = [r.strip() for r in roles_csv.split(",") if r.strip()]
    have = {r["name"] for r in kc.call("GET", f"groups/{g['id']}/role-mappings/realm")}
    realm = {r["name"]: r for r in kc.call("GET", "roles?max=1000")}
    unknown = [r for r in wanted if r not in realm]
    if unknown:
        sys.exit(f"roles not in this realm: {unknown}")
    add = [realm[r] for r in wanted if r not in have]
    for r in wanted:
        if r in have:
            print(f"  group {name} already has {r}")
    print(f"group {name}: {len(group_members(kc, g['id']))} members")
    print(f"add to the group{mode}: {[r['name'] for r in add] or 'nothing'}")
    if add and apply:
        kc.call("POST", f"groups/{g['id']}/role-mappings/realm", [{"id": r["id"], "name": r["name"]} for r in add])
        rm_id = realm_management_id(kc)
        eff = sorted(r["name"] for r in kc.call(
            "GET", f"groups/{g['id']}/role-mappings/clients/{rm_id}/composite")) if rm_id else []
        print(f"done. Keycloak admin roles the group now gives: {eff or 'none'}")
    elif add:
        print("\nnothing changed. Run again with --apply to do the above.")


def copy_group(kc, src, new, without_csv, mode, apply):
    """Create a new group with the realm roles of an existing one, minus some roles."""
    s = find_group(kc, src)
    if not s:
        sys.exit(f"no group '{src}'")
    if find_group(kc, new):
        sys.exit(f"group '{new}' already exists")
    without = {r.strip() for r in without_csv.split(",") if r.strip()}
    roles = [r for r in kc.call("GET", f"groups/{s['id']}/role-mappings/realm") if r["name"] not in without]
    print(f"create group {new}{mode}: {len(roles)} realm roles from {src}, "
          f"without {sorted(without) or 'nothing'}")
    if not apply:
        print("\nnothing changed. Run again with --apply to create it.")
        return
    kc.call("POST", "groups", {"name": new})
    g = find_group(kc, new)
    kc.call("POST", f"groups/{g['id']}/role-mappings/realm",
            [{"id": r["id"], "name": r["name"]} for r in roles])
    rm_id = realm_management_id(kc)
    eff = sorted(r["name"] for r in kc.call(
        "GET", f"groups/{g['id']}/role-mappings/clients/{rm_id}/composite")) if rm_id else []
    print(f"created group {new} ({g['id']}); Keycloak admin roles it gives: {eff or 'none'}")


def group_info(kc, name):
    """Read-only: what a group grants, directly and through Keycloak's admin client."""
    found = [g for g in kc.call("GET", "groups?max=500") if g["name"] == name]
    if not found:
        sys.exit(f"no group '{name}'")
    gid = found[0]["id"]
    realm = sorted(r["name"] for r in kc.call("GET", f"groups/{gid}/role-mappings/realm"))
    rm_id = realm_management_id(kc)
    direct_rm = sorted(r["name"] for r in kc.call("GET", f"groups/{gid}/role-mappings/clients/{rm_id}")) if rm_id else []
    eff_rm = sorted(r["name"] for r in kc.call("GET", f"groups/{gid}/role-mappings/clients/{rm_id}/composite")) if rm_id else []
    members, first = 0, 0
    while True:
        page = kc.call("GET", f"groups/{gid}/members?first={first}&max=500&briefRepresentation=true")
        members += len(page)
        if len(page) < 500:
            break
        first += 500
    print(f"group {name} ({gid}): {members} members")
    print(f"  realm roles (direct): {len(realm)}")
    print(f"    {', '.join(realm) or 'none'}")
    print(f"  Keycloak admin roles given directly by the group: {direct_rm or 'none'}")
    print(f"  Keycloak admin roles in effect (incl. composites): {eff_rm or 'none'}")


def disable(kc, user, mode, apply):
    print(f"user {user['username']} ({user['id']}) enabled={user.get('enabled')}")
    if not user.get("enabled"):
        print("  already disabled")
        return
    print(f"  disable the account (it can no longer log in; nothing is deleted){mode}")
    if apply:
        rep = kc.call("GET", f"users/{user['id']}")
        rep["enabled"] = False
        kc.call("PUT", f"users/{user['id']}", rep)
        print("  done; re-enable in the admin console (Users > the user > Enabled) if needed")
    else:
        print("\nnothing changed. Run again with --apply to do the above.")


def make_app(kc, user, mode, apply):
    """Give an account the same groups as the other VHW accounts. The phone app also needs a
    Practitioner (with this Keycloak id) in a care team: check that before using this."""
    uid = user["id"]
    groups = {g["name"]: g["id"] for g in kc.call("GET", f"users/{uid}/groups")}
    all_groups = {g["name"]: g["id"] for g in kc.call("GET", "groups?max=500")}
    missing = [g for g in APP_GROUPS if g not in all_groups]
    if missing:
        sys.exit(f"groups not in this realm: {missing}")
    steps = [(f"join group {g}", "PUT", f"users/{uid}/groups/{all_groups[g]}")
             for g in APP_GROUPS if g not in groups]
    if PORTAL_GROUP in groups:
        steps.append((f"leave group {PORTAL_GROUP}", "DELETE", f"users/{uid}/groups/{groups[PORTAL_GROUP]}"))
    print(f"user {user['username']} ({uid}) groups={sorted(groups) or 'none'}")
    print(f"changes{mode}:" if steps else "nothing to change")
    for text, method, path in steps:
        print(f"  - {text}")
        if apply:
            kc.call(method, path)
    if apply and steps:
        held = sorted(effective_roles(kc, uid) & {"WEB_CLIENT", "ANDROID_CLIENT"})
        print(f"after: client roles {held}")
    elif steps:
        print("\nnothing changed. Run again with --apply to do the above.")


CREATE_GROUPS = ["Super Admin", PORTAL_GROUP]


def create(kc, args, mode):
    """New portal-only user: the same groups as the working portal account opensrp-admin.
    The password is temporary: Keycloak asks the person to choose their own at first login."""
    name = args.username
    if "@" in name:
        sys.exit("give a username (for example firstname.lastname); the email goes in --email")
    if kc.call("GET", f"users?username={urllib.parse.quote(name)}&exact=true"):
        sys.exit(f"user {name} already exists: run without --create to check it")
    if args.email and kc.call("GET", f"users?email={urllib.parse.quote(args.email)}&exact=true"):
        sys.exit(f"email {args.email} is already used by another user")
    all_groups = {g["name"]: g["id"] for g in kc.call("GET", "groups?max=500")}
    missing = [g for g in CREATE_GROUPS if g not in all_groups]
    if missing:
        sys.exit(f"groups not in this realm: {missing}")
    print(f"create portal user {name}  email={args.email or '-'}  name={args.first} {args.last}{mode}")
    print(f"  groups {CREATE_GROUPS} -> client role WEB_CLIENT only; attribute fhir_core_app_id={APP_ID}")
    print("  temporary password: the person chooses their own at first login")
    if not args.apply:
        print("\nnothing changed. Run again with --apply to create it.")
        return
    while True:
        pw = getpass.getpass(f"Temporary password for {name}: ")
        if len(pw) >= 8 and pw == getpass.getpass("  repeat: "):
            break
        print("  at least 8 characters and both the same, try again")
    rep = {"username": name, "enabled": True, "firstName": args.first, "lastName": args.last,
           "requiredActions": [], "attributes": {"fhir_core_app_id": [APP_ID]}}
    if args.email:
        rep.update(email=args.email, emailVerified=True)
    kc.call("POST", "users", rep)
    uid = kc.call("GET", f"users?username={urllib.parse.quote(name)}&exact=true")[0]["id"]
    kc.call("PUT", f"users/{uid}/reset-password", {"type": "password", "value": pw, "temporary": True})
    for g in CREATE_GROUPS:
        kc.call("PUT", f"users/{uid}/groups/{all_groups[g]}")
    held = sorted(effective_roles(kc, uid) & {"WEB_CLIENT", "ANDROID_CLIENT"})
    print(f"created {name} ({uid}); client roles {held}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("username", nargs="?", help="username or email address")
    ap.add_argument("--scan", action="store_true",
                    help="list every enabled user the gateway refuses (neither or both client roles)")
    ap.add_argument("--summary", action="store_true",
                    help="count users per role and list every portal (WEB_CLIENT) user")
    ap.add_argument("--report", action="store_true",
                    help="every user with what they can use, groups, admin rights and permissions (+ CSV)")
    ap.add_argument("--out", help="CSV path for --report (default /root/kc-users-<date>.csv)")
    ap.add_argument("--kc", default="http://127.0.0.1:8082/auth")
    ap.add_argument("--realm", default="opensrp")
    ap.add_argument("--admin-user", default="admin")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true", help="also take an app user out of the app group")
    ap.add_argument("--create", action="store_true",
                    help="create a new portal user (groups Super Admin + WEB_PRACTITIONER, like opensrp-admin)")
    ap.add_argument("--disable", action="store_true",
                    help="switch the account off (can no longer log in; nothing deleted, can be re-enabled)")
    ap.add_argument("--make-app", action="store_true",
                    help="make it a phone app (VHW) account: groups ANDROID_PRACTITIONER + PROVIDER, "
                         "not WEB_PRACTITIONER")
    ap.add_argument("--leave-group", action="append", default=[], metavar="GROUP",
                    help="take the user out of this group (repeatable), e.g. 'Super Admin'")
    ap.add_argument("--join-group", action="append", default=[], metavar="GROUP",
                    help="put the user in this group (repeatable)")
    ap.add_argument("--group-drop-roles", nargs=2, metavar=("GROUP", "ROLES"),
                    help="remove realm roles (comma-separated) from a group, for all its members, "
                         "e.g. PROVIDER EDIT_KEYCLOAK_USERS,VIEW_KEYCLOAK_USERS")
    ap.add_argument("--group-add-roles", nargs=2, metavar=("GROUP", "ROLES"),
                    help="add realm roles (comma-separated) to a group, e.g. 'Portal Data Manager' VIEW_KEYCLOAK_USERS")
    ap.add_argument("--copy-group", nargs=2, metavar=("FROM", "NEW"),
                    help="create group NEW with the realm roles of FROM, minus --without")
    ap.add_argument("--without", default="", metavar="ROLES",
                    help="comma-separated roles to leave out with --copy-group")
    ap.add_argument("--group-info", metavar="GROUP",
                    help="show what a group grants: realm roles and Keycloak admin (realm-management) "
                         "roles, and how many users are in it")
    ap.add_argument("--email", default="")
    ap.add_argument("--first", default="")
    ap.add_argument("--last", default="")
    args = ap.parse_args()
    mode = "" if args.apply else "  (dry run)"

    kc = Kc(args.kc, args.realm)
    kc.login(args.admin_user, os.environ.get("KC_ADMIN_PASSWORD") or
             getpass.getpass(f"Keycloak admin password ({args.admin_user}): "))

    if args.report:
        return report(kc, args.out)
    if args.scan or args.summary:
        return scan(kc, args.summary)
    if args.group_info:
        return group_info(kc, args.group_info)
    if args.group_drop_roles:
        return group_drop_roles(kc, *args.group_drop_roles, mode, args.apply)
    if args.group_add_roles:
        return group_add_roles(kc, *args.group_add_roles, mode, args.apply)
    if args.copy_group:
        return copy_group(kc, *args.copy_group, args.without, mode, args.apply)
    if not args.username:
        sys.exit("give a username, or --scan")
    if args.create:
        return create(kc, args, mode)
    found = kc.call("GET", f"users?username={urllib.parse.quote(args.username)}&exact=true")
    if not found and "@" in args.username:  # an email address was given
        found = kc.call("GET", f"users?email={urllib.parse.quote(args.username)}&exact=true")
    if not found:
        sys.exit(f"no user '{args.username}' in realm {args.realm}")
    uid = found[0]["id"]
    if args.disable:
        return disable(kc, found[0], mode, args.apply)
    if args.make_app:
        return make_app(kc, found[0], mode, args.apply)
    if args.leave_group or args.join_group:
        return change_groups(kc, found[0], args.join_group, args.leave_group, mode, args.apply)
    groups = {g["name"]: g["id"] for g in kc.call("GET", f"users/{uid}/groups")}
    direct = {r["name"]: r for r in kc.call("GET", f"users/{uid}/role-mappings/realm")}
    roles = effective_roles(kc, uid)
    client = sorted(roles & {"WEB_CLIENT", "ANDROID_CLIENT"})
    print(f"user {found[0]['username']} ({uid}) email={found[0].get('email', '-')} enabled={found[0].get('enabled')}")
    print(f"  groups: {sorted(groups) or 'none'}")
    print(f"  client roles held: {client or 'none'}  -> gateway "
          f"{'OK' if client == ['WEB_CLIENT'] else ('OK for the app only' if client == ['ANDROID_CLIENT'] else 'REFUSES every request')}")
    missing = [r for r in NEEDED if r not in roles and r.replace(r.split('_')[0], 'MANAGE', 1) not in roles]
    print(f"  portal permission roles missing: {missing or 'none'}")

    is_app_user = APP_GROUP in groups or "ANDROID_CLIENT" in direct
    if is_app_user and not args.force:
        print(f"\n{args.username} is set up for the phone app ({APP_GROUP}). Changing it would stop "
              f"the app working for this account. Use a separate portal account, or add --force.")
        return

    all_groups = {g["name"]: g["id"] for g in kc.call("GET", "groups?max=500")}
    steps = []
    if PORTAL_GROUP not in groups:
        if PORTAL_GROUP not in all_groups:
            sys.exit(f"group {PORTAL_GROUP} does not exist in realm {args.realm}")
        steps.append((f"join group {PORTAL_GROUP}", "PUT", f"users/{uid}/groups/{all_groups[PORTAL_GROUP]}", None))
    if APP_GROUP in groups:
        steps.append((f"leave group {APP_GROUP}", "DELETE", f"users/{uid}/groups/{groups[APP_GROUP]}", None))
    if "ANDROID_CLIENT" in direct:
        steps.append(("drop direct role ANDROID_CLIENT", "DELETE", f"users/{uid}/role-mappings/realm",
                      [direct["ANDROID_CLIENT"]]))
    full = kc.call("GET", f"users/{uid}")
    if (full.get("attributes") or {}).get("fhir_core_app_id") != [APP_ID]:
        # without this the gateway answers 401 "token has no fhir_core_app_id claim"
        full["attributes"] = {**(full.get("attributes") or {}), "fhir_core_app_id": [APP_ID]}
        steps.append((f"set attribute fhir_core_app_id={APP_ID}", "PUT", f"users/{uid}", full))
    realm_roles = {r["name"]: r for r in kc.call("GET", "roles?max=1000")}
    add = [realm_roles[r] for r in missing if r in realm_roles]
    if add:
        steps.append((f"add roles {[r['name'] for r in add]}", "POST", f"users/{uid}/role-mappings/realm",
                      [{"id": r["id"], "name": r["name"]} for r in add]))
    absent = [r for r in missing if r not in realm_roles]
    if absent:
        print(f"  note: not defined in this realm, cannot add: {absent}")

    print(f"\nchanges{mode}:" if steps else "\nnothing to change")
    for text, method, path, body in steps:
        print(f"  - {text}")
        if args.apply:
            kc.call(method, path, body)
    if args.apply and steps:
        roles = effective_roles(kc, uid)
        print(f"\nafter: client roles {sorted(roles & {'WEB_CLIENT', 'ANDROID_CLIENT'})}; "
              f"the user must log out of the portal and in again to get a new token")
    elif steps:
        print("\nnothing changed. Run again with --apply to do the above.")


if __name__ == "__main__":
    main()
