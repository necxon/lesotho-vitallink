#!/usr/bin/env python3
"""
test_menus.py - walk the phone's menus and forms end to end and report what is broken.

    python scripts/test_menus.py          (or: make test-menus)
    python scripts/test_menus.py -v       show every check, not just failures

WHAT IT FOLLOWS
Exactly the chain a phone walks at startup:

    Composition (identifier "app")
      -> Navigation Binary          the side menu and bottom sheet
        -> menu item actions        LAUNCH_REGISTER / LAUNCH_QUESTIONNAIRE
          -> register configs       must be published in the Composition
          -> Questionnaires         must exist on the server
            -> items                enableWhen targets, answer options, required fields

WHY THIS EXISTS
A menu item whose questionnaire was never uploaded looks completely normal in
the portal and in the config. It fails on the phone, in a village, as a button
that does nothing when tapped. Nothing else in the stack checks that the ids in
the navigation config resolve to resources that are actually published - so this
is the check that turns "the menu looks right" into "the menu works".

It needs no browser and no device, so it can run on every change.

EXIT CODES
    0  everything resolves
    1  at least one FAIL - something on the phone is broken
    2  could not reach the server
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_FHIR = "http://127.0.0.1:8079/fhir"

# Workflows that point at another configured resource, and which field carries
# the id. Anything else is a self-contained action and needs no target check.
LAUNCH_REGISTER = "LAUNCH_REGISTER"
LAUNCH_QUESTIONNAIRE = "LAUNCH_QUESTIONNAIRE"

PASS, FAIL, WARN = "PASS", "FAIL", "WARN"


class Report:
    def __init__(self, verbose):
        self.verbose = verbose
        self.rows = []

    def add(self, level, area, msg):
        self.rows.append((level, area, msg))
        if level != PASS or self.verbose:
            colour = {PASS: "  ok ", FAIL: "FAIL ", WARN: "warn "}[level]
            print(f"  {colour} [{area}] {msg}")

    def count(self, level):
        return sum(1 for r in self.rows if r[0] == level)


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def exists(fhir, ref):
    """Is this Type/id actually on the server?

    Deliberately checks only the HTTP status and never parses the body. Config
    Binaries are served as their raw content - the translation files are Java
    .properties, not JSON - so decoding here would report a perfectly healthy
    resource as missing. An earlier version of this script did exactly that and
    reported six false failures.
    """
    req = urllib.request.Request(f"{fhir}/{ref}", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        # 404 never existed; 410 Gone means it was deleted. Both mean the phone
        # cannot fetch it, which is all this check cares about. An earlier
        # version raised on 410 and took the whole run down the moment somebody
        # deleted a resource - exactly when the report is most needed.
        if e.code in (404, 410):
            return False
        # Anything else (500, auth) is not a clean "missing", so say so rather
        # than silently calling it absent.
        raise RuntimeError(f"{ref} returned HTTP {e.code}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"{ref} unreachable: {e.reason}")


def walk_items(items, fn, parent=None):
    for it in items or []:
        fn(it, parent)
        walk_items(it.get("item"), fn, it)


def collect_link_ids(q):
    ids = []
    walk_items(q.get("item"), lambda it, _p: ids.append(it.get("linkId")))
    return ids


def check_questionnaire(rep, q, label):
    """The item-level mistakes that produce a form nobody can complete."""
    link_ids = collect_link_ids(q)
    seen, dupes = set(), set()
    for lid in link_ids:
        if lid in seen:
            dupes.add(lid)
        seen.add(lid)

    if dupes:
        rep.add(FAIL, label, f"duplicate linkId(s): {', '.join(sorted(dupes))} - answers collide")
    else:
        rep.add(PASS, label, f"{len(link_ids)} items, linkIds unique")

    problems = []

    def inspect(it, _parent):
        lid = it.get("linkId")
        itype = it.get("type")

        # enableWhen pointing at a linkId that does not exist means the
        # condition can never be evaluated, so the item never appears.
        for ew in it.get("enableWhen", []) or []:
            target = ew.get("question")
            if target and target not in seen:
                problems.append(
                    f"'{lid}' is shown only when '{target}' is answered, "
                    f"but no item has that linkId - it can never appear"
                )

        # A choice with nothing to choose from renders as an empty dropdown.
        if itype in ("choice", "open-choice"):
            has_options = bool(it.get("answerOption")) or bool(it.get("answerValueSet"))
            if not has_options:
                problems.append(f"'{lid}' is type {itype} but has no answerOption or answerValueSet")

        # A required question hidden behind a condition blocks submission with
        # no visible way to satisfy it.
        if it.get("required") and it.get("enableWhen"):
            behaviour = it.get("enableBehavior", "any")
            problems.append(
                f"'{lid}' is required AND conditional (enableBehavior={behaviour}) - "
                f"confirm it can be reached, or the form cannot be submitted"
            )

    walk_items(q.get("item"), inspect)

    for p in problems:
        # Required-and-conditional is legitimate design, so it warns; the others
        # are always defects.
        level = WARN if "required AND conditional" in p else FAIL
        rep.add(level, label, p)

    if not problems:
        rep.add(PASS, label, "no item-level problems")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fhir", default=DEFAULT_FHIR)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    fhir = args.fhir.rstrip("/")
    rep = Report(args.verbose)

    print(f"Walking the phone's config chain on {fhir}\n")

    # -- Composition ---------------------------------------------------------
    print("Composition")
    try:
        bundle = fetch(f"{fhir}/Composition?_count=10")
    except Exception as e:
        print(f"\nCannot reach {fhir}: {e}", file=sys.stderr)
        return 2

    comps = [e["resource"] for e in bundle.get("entry", [])]
    app = next((c for c in comps if (c.get("identifier") or {}).get("value") == "app"), None)
    if not app:
        rep.add(FAIL, "composition", "no Composition with identifier 'app' - the phone has no config to fetch")
        print("\nNothing further can be checked without it.")
        return 1
    rep.add(PASS, "composition", f"found {app['id']} with {len(app.get('section', []))} sections")

    # Index what the Composition publishes, and confirm each target resolves.
    published = {}
    nav_ref = None
    for sec in app.get("section", []):
        entries = sec.get("section") or [sec]
        for sub in entries:
            focus = sub.get("focus") or {}
            ident = (focus.get("identifier") or {}).get("value")
            ref = focus.get("reference")
            if not ref:
                continue
            if ident:
                published[ident] = ref
            if ident == "navigation":
                nav_ref = ref
            if not exists(fhir, ref):
                rep.add(FAIL, "composition",
                        f"section '{ident or sub.get('title')}' points at {ref}, which is not on the server")

    rep.add(PASS, "composition", f"{len(published)} configured ids published")

    # -- Navigation ----------------------------------------------------------
    print("\nNavigation config")
    if not nav_ref:
        rep.add(FAIL, "navigation", "the Composition has no 'navigation' section")
        return 1

    nav = fetch(f"{fhir}/{nav_ref}")

    # Shape first. A list where an object belongs kills the app at startup.
    if not isinstance(nav.get("staticMenu"), list):
        rep.add(FAIL, "navigation", "staticMenu must be a list")
    if not isinstance(nav.get("clientRegisters"), list):
        rep.add(FAIL, "navigation", "clientRegisters must be a list")
    bs = nav.get("bottomSheetRegisters")
    if not isinstance(bs, dict):
        rep.add(FAIL, "navigation",
                "bottomSheetRegisters must be an OBJECT - a list here crashes the app on launch")
        bs = {"registers": []}
    else:
        rep.add(PASS, "navigation", "shape is valid (staticMenu list, bottomSheetRegisters object)")

    static = nav.get("staticMenu", [])
    sheet = bs.get("registers", []) or []
    client = nav.get("clientRegisters", []) or []

    # Regression guard for the de-duplication. Showing the same register in the
    # side menu and the bottom sheet is what made the menu feel complicated.
    dup = {m.get("id") for m in static} & {r.get("id") for r in sheet}
    if dup:
        rep.add(WARN, "navigation",
                f"{len(dup)} register(s) appear in BOTH the side menu and the bottom sheet: "
                f"{', '.join(sorted(dup))}")
    else:
        rep.add(PASS, "navigation", "no register is duplicated between the side menu and the bottom sheet")

    visible = [m for m in static if m.get("visible", True)]
    rep.add(PASS, "navigation",
            f"side menu shows {len(visible)} of {len(static)} items; "
            f"bottom sheet offers {len(sheet)}")
    if len(visible) > 8:
        rep.add(WARN, "navigation",
                f"{len(visible)} items in the side menu - long menus are what users complain about")

    # -- Menu targets --------------------------------------------------------
    print("\nMenu targets")
    questionnaire_ids = set()

    def check_menu(item, source):
        mid = item.get("id", "?")
        label = f"{source}:{mid}"
        if not item.get("id") or not item.get("display"):
            rep.add(FAIL, label, "menu items need both id and display")
        for action in item.get("actions") or []:
            wf = action.get("workflow")
            if wf == LAUNCH_REGISTER:
                target = action.get("id") or mid
                if target in published:
                    rep.add(PASS, label, f"opens register '{target}'")
                else:
                    rep.add(FAIL, label,
                            f"opens register '{target}', which the Composition does not publish - "
                            f"tapping it does nothing")
            elif wf == LAUNCH_QUESTIONNAIRE:
                q = action.get("questionnaire") or {}
                qid = q.get("id")
                if not qid:
                    rep.add(FAIL, label, "LAUNCH_QUESTIONNAIRE with no questionnaire id")
                elif exists(fhir, f"Questionnaire/{qid}"):
                    questionnaire_ids.add(qid)
                    rep.add(PASS, label, f"opens questionnaire '{qid}'")
                else:
                    rep.add(FAIL, label,
                            f"opens questionnaire '{qid}', which is not on the server - "
                            f"tapping it does nothing")

    for m in static:
        check_menu(m, "menu")
    for r in sheet:
        check_menu(r, "sheet")
    for c in client:
        check_menu(c, "client")

    # -- Questionnaires ------------------------------------------------------
    print("\nQuestionnaires")
    all_q = fetch(f"{fhir}/Questionnaire?_count=200")
    resources = [e["resource"] for e in all_q.get("entry", [])]
    rep.add(PASS, "questionnaires", f"{len(resources)} on the server")

    for q in resources:
        label = q.get("title") or q.get("id")
        check_questionnaire(rep, q, label[:38])

    # -- Summary -------------------------------------------------------------
    fails, warns = rep.count(FAIL), rep.count(WARN)
    print("\n" + "=" * 62)
    print(f"{len(rep.rows)} checks: {rep.count(PASS)} passed, {warns} warnings, {fails} failures")
    if fails:
        print("\nFailures mean something is broken on the phone:")
        for level, area, msg in rep.rows:
            if level == FAIL:
                print(f"  [{area}] {msg}")
    print("=" * 62)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
