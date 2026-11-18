#!/usr/bin/env python3
"""Show or change the app's settings-screen menu (settingsScreenMenuOptions) in the server application config.

The BKM apps read their application config from a Binary listed in Composition identifier=<app>. This script finds
that Binary, shows the current menu options and, with --apply, writes the new list. A backup of the Binary is saved
first. Tablets pick the change up at their next password login (config download).

Use it to switch on DATABASE_EXPORT ("Export DB" under the profile menu), which saves a decrypted, password-zipped
copy of the tablet database to Downloads; tools/tablet_rescue.py reads that file to recover unsynced records.

  python3 set_settings_menu.py                                    # show the current options (read-only)
  python3 set_settings_menu.py --add DATABASE_EXPORT              # dry run: show what would change
  python3 set_settings_menu.py --add DATABASE_EXPORT --apply      # write it (backup saved first)
  python3 set_settings_menu.py --remove DATABASE_EXPORT --apply   # switch it off again
  python3 set_settings_menu.py --fhir http://127.0.0.1:18180/fhir # another HAPI (e.g. preprod)

Options known to the app: MANUAL_SYNC OFFLINE_MAPS SWITCH_LANGUAGES RESET_DATA INSIGHTS CONTACT_HELP DATABASE_EXPORT
"""
import argparse, base64, datetime, json, sys, urllib.error, urllib.parse, urllib.request

KNOWN = ["MANUAL_SYNC", "OFFLINE_MAPS", "SWITCH_LANGUAGES", "RESET_DATA", "INSIGHTS", "CONTACT_HELP", "DATABASE_EXPORT"]
APP_DEFAULT = ["MANUAL_SYNC", "SWITCH_LANGUAGES", "RESET_DATA", "INSIGHTS"]  # ApplicationConfiguration.kt default

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--fhir", default="http://localhost:8080/fhir")
ap.add_argument("--app", default="bkm")
ap.add_argument("--add", nargs="*", default=[], choices=KNOWN)
ap.add_argument("--remove", nargs="*", default=[], choices=KNOWN)
ap.add_argument("--apply", action="store_true", help="write the change (default is a dry run)")
a = ap.parse_args()
BASE = a.fhir.rstrip("/")


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{BASE}/{path}", data=data, method=method,
                               headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json",
                                        "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


st, b = req("GET", "Composition?" + urllib.parse.urlencode({"identifier": a.app, "_count": 5}))
comps = [e["resource"] for e in (b or {}).get("entry", [])]
if len(comps) != 1:
    sys.exit(f"Expected 1 Composition for app '{a.app}', found {len(comps)} (HTTP {st})")

refs = []
def walk(secs):
    for s in secs or []:
        f = (s.get("focus") or {}).get("reference", "")
        if f.startswith("Binary/"):
            refs.append(f)
        walk(s.get("section"))
walk(comps[0].get("section"))

found = None
for ref in refs:
    st, binr = req("GET", ref)
    if st != 200 or "data" not in binr:
        continue
    try:
        cfg = json.loads(base64.b64decode(binr["data"]))
    except ValueError:
        continue
    if cfg.get("configType") == "application":
        found = (ref, binr, cfg)
        break
if not found:
    sys.exit(f"No application config Binary in Composition {comps[0]['id']} ({len(refs)} Binaries checked)")

ref, binr, cfg = found
explicit = "settingsScreenMenuOptions" in cfg
current = cfg.get("settingsScreenMenuOptions", APP_DEFAULT)
print(f"Application config: {ref} (version {binr.get('meta', {}).get('versionId')})")
print(f"Current menu options{'' if explicit else ' (not set, app default)'}: {', '.join(current)}")

new = [o for o in current if o not in a.remove] + [o for o in a.add if o not in current]
if not a.add and not a.remove:
    sys.exit(0)
if new == current and explicit:
    print("No change needed.")
    sys.exit(0)
print(f"New menu options: {', '.join(new)}")
if not a.apply:
    print("Dry run. Add --apply to write it.")
    sys.exit(0)

stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
backup = f"app-config-{ref.split('/')[1]}-{stamp}.json"
with open(backup, "w") as f:
    json.dump(binr, f)
print(f"Backup of the Binary: {backup}")

cfg["settingsScreenMenuOptions"] = new
binr["data"] = base64.b64encode(json.dumps(cfg, ensure_ascii=False, indent=2).encode()).decode()
binr.pop("meta", None)
st, res = req("PUT", ref, binr)
if st not in (200, 201):
    sys.exit(f"PUT failed: HTTP {st} {json.dumps(res)[:400]}")
print(f"Written: {ref} now version {res.get('meta', {}).get('versionId')}. "
      "Tablets get it at their next password login.")
print(f"Undo: curl -X PUT -H 'Content-Type: application/fhir+json' --data-binary @{backup} {BASE}/{ref}")
