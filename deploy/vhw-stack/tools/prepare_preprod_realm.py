#!/usr/bin/env python3
"""Turn a full opensrp realm export from test into the preprod realm import file.

  python3 tools/prepare_preprod_realm.py ~/realm-test-full.json keycloak/import/opensrp-realm.json

- removes the realm's signing keys (preprod generates its own, so test and preprod
  tokens never validate on each other)
- replaces the test hostnames with the preprod ones in client URLs and attributes
  (app.vhw.gov.ls -> preprod-app.vhw.gov.ls, web.vhw.gov.ls -> preprod-web.vhw.gov.ls)
- adds the public client "bkm-web" used by the VitalLink web portal (builder) on
  https://preprod-builder.vhw.gov.ls
Users, groups, roles and the other clients are kept as they are. The output is
written with mode 644: Keycloak in the container (uid 1000) must be able to read it.
"""
import json
import os
import re
import sys

# app.vhw.gov.ls / web.vhw.gov.ls, but not names that already have a prefix
TEST_HOST = re.compile(r"(?<![\w.-])(app|web)\.vhw\.gov\.ls")
BUILDER = "https://preprod-builder.vhw.gov.ls"


def swap(value):
    if isinstance(value, str):
        return TEST_HOST.sub(lambda m: "preprod-" + m.group(1) + ".vhw.gov.ls", value)
    if isinstance(value, list):
        return [swap(v) for v in value]
    if isinstance(value, dict):
        return {k: swap(v) for k, v in value.items()}
    return value


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    realm = json.load(open(src, encoding="utf-8"))
    if isinstance(realm, list):  # some exports wrap the realm in a list
        realm = next(r for r in realm if r.get("realm") == "opensrp")
    if realm.get("realm") != "opensrp":
        sys.exit(f"{src} is not the opensrp realm")

    comps = realm.get("components", {})
    keys = comps.pop("org.keycloak.keys.KeyProvider", [])
    print(f"signing key providers removed: {len(keys)}")

    for client in realm.get("clients", []):
        for field in ("rootUrl", "baseUrl", "adminUrl", "redirectUris", "webOrigins",
                      "attributes"):
            if field in client:
                client[field] = swap(client[field])
    realm["attributes"] = swap(realm.get("attributes", {}))
    realm.pop("frontendUrl", None)
    realm.get("attributes", {}).pop("frontendUrl", None)

    clients = realm.setdefault("clients", [])
    if not any(c.get("clientId") == "bkm-web" for c in clients):
        clients.append({
            "clientId": "bkm-web", "name": "VitalLink web (builder)", "enabled": True,
            "publicClient": True, "protocol": "openid-connect",
            "standardFlowEnabled": True, "directAccessGrantsEnabled": False,
            "implicitFlowEnabled": False, "serviceAccountsEnabled": False,
            "rootUrl": BUILDER, "baseUrl": "/", "redirectUris": [BUILDER + "/*"],
            "webOrigins": [BUILDER],
            "attributes": {"pkce.code.challenge.method": "S256",
                           "post.logout.redirect.uris": BUILDER + "/*"},
        })
        print("client bkm-web added")

    users = len(realm.get("users", []))
    old_left = json.dumps(realm).count("https://app.vhw.gov.ls") + \
        json.dumps(realm).count("https://web.vhw.gov.ls")
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(realm, f)
    os.chmod(dst, 0o644)
    print(f"users kept: {users}; clients: {len(clients)}; test URLs left: {old_left}")
    print(f"wrote {dst}")


if __name__ == "__main__":
    main()
