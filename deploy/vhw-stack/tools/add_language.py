#!/usr/bin/env python3
"""
add_language.py - add an app language to the "bkm" config on a FHIR server.

    python3 add_language.py <code> <strings_<code>_config.properties>            # dry run
    python3 add_language.py <code> <file> --apply                                  # performs it
    python3 add_language.py <code> <file> --apply http://host:8080/fhir

<code> is the language code the app will offer, e.g. "zu" or "xh".
The .properties file holds the translations, one key=value per line, with the
same keys as the English strings Binary. Missing keys fall back to English.

Three steps, in this order, each skipped if already done (safe to re-run):
  1. create a Binary holding the translations                    (add-only)
  2. add a "strings_<code>" section to the bkm Composition       (If-Match)
  3. add <code> to "languages" in the application config Binary  (If-Match)
The language is switched on last, so the app never offers it without text.

Before any write it saves the Composition and application Binary to
add_language_<code>_backup/, so both can be PUT back to undo. It then
reports how many Questionnaire texts already have a <code> translation;
forms are translated inside each Questionnaire and this script does not touch them.

Note: this only reaches apps built with app id "bkm". The current tablet app
("bkm/debug") reads its config from the APK and will not see the new language.
"""
import base64, copy, json, os, re, sys, urllib.request, urllib.error

args = [a for a in sys.argv[1:] if not a.startswith("--")]
APPLY = "--apply" in sys.argv
if len(args) < 2:
    sys.exit(__doc__)
CODE, PROPS = args[0], args[1]
BASE = (args[2] if len(args) > 2 else "http://192.0.2.146:8080/fhir").rstrip("/")
SECTION_ID = f"strings_{CODE}"
BACKUP_DIR = f"add_language_{CODE}_backup"
TRANSLATION_EXT = "http://hl7.org/fhir/StructureDefinition/translation"


def call(method, path, body=None, headers=None):
    h = {"Accept": "application/fhir+json", "Content-Type": "application/fhir+json"}
    h.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    url = path if path.startswith("http") else f"{BASE}/{path}"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def sections(secs):
    for s in secs or []:
        yield s
        yield from sections(s.get("section"))


def section_by_id(comp, ident):
    for s in sections(comp.get("section")):
        if ((s.get("focus") or {}).get("identifier") or {}).get("value") == ident:
            return s
    return None


def parent_of(comp, ident):
    for s in sections(comp.get("section")):
        for child in s.get("section") or []:
            if ((child.get("focus") or {}).get("identifier") or {}).get("value") == ident:
                return s
    return None


def keys_of(text):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "!")) and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def binary_text(ref):
    return base64.b64decode(call("GET", ref).get("data", "")).decode("utf-8")


# ── checks ────────────────────────────────────────────────────────────────────
if not re.fullmatch(r"[a-z]{2,3}", CODE):
    sys.exit(f"language code must be 2-3 lowercase letters (ISO 639), got {CODE!r}")
if CODE == "en":
    sys.exit("en is the default language (the plain 'strings' Binary) - nothing to add")
with open(PROPS, "rb") as f:
    raw_props = f.read()
try:
    props_text = raw_props.decode("utf-8")
except UnicodeDecodeError:
    sys.exit(f"{PROPS} is not UTF-8 - save it as UTF-8 (the app reads translations as UTF-8)")
new_keys = keys_of(props_text)
if not new_keys:
    sys.exit(f"{PROPS} has no key=value lines")

print(f"server {BASE}   mode {'APPLY' if APPLY else 'DRY RUN'}   language {CODE}")

entries = call("GET", "Composition?identifier=bkm&_count=5").get("entry") or []
if len(entries) != 1:
    sys.exit(f"expected exactly one Composition identifier=bkm, found {len(entries)} - stopping")
comp = entries[0]["resource"]
comp_ver = comp["meta"]["versionId"]

en_sec, app_sec = section_by_id(comp, "strings"), section_by_id(comp, "application")
if not en_sec or not app_sec:
    sys.exit("Composition has no 'strings' or 'application' section - stopping")
en_keys = keys_of(binary_text(en_sec["focus"]["reference"]))
missing = sorted(set(en_keys) - set(new_keys))
extra = sorted(set(new_keys) - set(en_keys))
print(f"translations: {len(new_keys)} keys; English has {len(en_keys)}")
if missing:
    print(f"  {len(missing)} not translated (will show in English): {', '.join(missing[:8])}{' ...' if len(missing) > 8 else ''}")
if extra:
    print(f"  {len(extra)} not in English, likely typos: {', '.join(extra[:8])}")

app_ref = app_sec["focus"]["reference"]
app_bin = call("GET", app_ref)
app_cfg = json.loads(base64.b64decode(app_bin["data"]))
languages = app_cfg.get("languages") or []

existing_sec = section_by_id(comp, SECTION_ID)
need_binary = existing_sec is None
need_section = existing_sec is None
need_language = CODE not in languages

print(f"  1. translations Binary     {'create' if need_binary else 'exists ' + existing_sec['focus']['reference'] + ' - skip'}")
print(f"  2. Composition section     {'add ' + SECTION_ID if need_section else 'exists - skip'}")
print(f"  3. application languages   {languages} -> {languages + [CODE] if need_language else 'already listed - skip'}")
if existing_sec and binary_text(existing_sec["focus"]["reference"]) != props_text:
    print(f"  note: the existing {SECTION_ID} Binary differs from {PROPS}; this script does not overwrite it")

if not (need_binary or need_section or need_language):
    print("nothing to do")
elif not APPLY:
    print("\ndry run: nothing written. Re-run with --apply.")
else:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    for name, obj in (("composition.json", comp), ("application_binary.json", app_bin)):
        with open(os.path.join(BACKUP_DIR, name), "w") as f:
            json.dump(obj, f, indent=1)
    print(f"saved Composition and application Binary to {BACKUP_DIR}/")

    ref = existing_sec["focus"]["reference"] if existing_sec else None
    if need_binary:
        en_bin = call("GET", en_sec["focus"]["reference"])
        created = call("POST", "Binary", {
            "resourceType": "Binary",
            "contentType": en_bin.get("contentType", "text/plain"),
            "data": base64.b64encode(raw_props).decode(),
        })
        ref = f"Binary/{created['id']}"
        if binary_text(ref) != props_text:
            sys.exit(f"{ref} read-back does not match {PROPS} - stopping before touching the Composition")
        with open(os.path.join(BACKUP_DIR, "created.txt"), "a") as f:
            f.write(ref + "\n")
        print(f"  1. created {ref} - verified")

    if need_section:
        new_comp = copy.deepcopy(comp)
        parent = parent_of(new_comp, "strings")
        siblings = parent["section"] if parent else new_comp["section"]
        new_sec = copy.deepcopy(en_sec)
        new_sec["title"] = f"Translation {CODE}"
        new_sec["focus"]["reference"] = ref
        new_sec["focus"]["identifier"]["value"] = SECTION_ID
        siblings.append(new_sec)
        try:
            call("PUT", f"Composition/{comp['id']}", new_comp, {"If-Match": f'W/"{comp_ver}"'})
        except urllib.error.HTTPError as e:
            sys.exit(f"Composition PUT failed: HTTP {e.code} {e.read()[:300]!r}. "
                     f"{ref} was created but is not referenced - harmless, or DELETE it")
        got = call("GET", f"Composition/{comp['id']}")
        if (section_by_id(got, SECTION_ID) or {}).get("focus", {}).get("reference") != ref:
            sys.exit(f"Composition read-back is missing {SECTION_ID} - inspect, restore from {BACKUP_DIR}")
        print(f"  2. Composition/{comp['id']} -> version {got['meta']['versionId']} - verified")

    if need_language:
        new_cfg = dict(app_cfg, languages=languages + [CODE])
        new_bin = dict(app_bin, data=base64.b64encode(
            json.dumps(new_cfg, indent=2, ensure_ascii=False).encode("utf-8")).decode())
        new_bin.pop("meta", None)
        try:
            call("PUT", app_ref, new_bin, {"If-Match": f'W/"{app_bin["meta"]["versionId"]}"'})
        except urllib.error.HTTPError as e:
            sys.exit(f"application PUT failed: HTTP {e.code} {e.read()[:300]!r}. Translations are in "
                     f"place but {CODE} is not offered yet - re-run to retry this step")
        got_cfg = json.loads(base64.b64decode(call("GET", app_ref)["data"]))
        if got_cfg != new_cfg:
            sys.exit(f"application read-back does not match - restore from {BACKUP_DIR}")
        print(f"  3. {app_ref} languages -> {got_cfg['languages']} - verified")

# ── forms: read-only coverage report ──────────────────────────────────────────
def texts(items):
    for it in items or []:
        if it.get("text"):
            yield it.get("_text") or {}
        for ans in it.get("answerOption") or []:
            coding = ans.get("valueCoding") or {}
            if coding.get("display"):
                yield coding.get("_display") or {}
        yield from texts(it.get("item"))

def has_lang(elem):
    for ext in elem.get("extension") or []:
        if ext.get("url") == TRANSLATION_EXT:
            if any(e.get("url") == "lang" and e.get("valueCode") == CODE for e in ext.get("extension") or []):
                return True
    return False

total = done = forms = 0
url = "Questionnaire?_count=100&_elements=item,name,title"
while url:
    b = call("GET", url)
    for e in b.get("entry") or []:
        forms += 1
        for t in texts(e["resource"].get("item")):
            total += 1
            done += has_lang(t)
    nxt = next((l["url"] for l in b.get("link") or [] if l.get("relation") == "next"), None)
    # HAPI builds paging links from its public address; keep talking to BASE instead.
    url = nxt.split("/fhir/", 1)[1] if nxt and "/fhir/" in nxt else (nxt.split("/fhir", 1)[1].lstrip("/") if nxt else None)
print(f"\nforms: {done} of {total} question/answer texts across {forms} Questionnaires have a {CODE} translation")
