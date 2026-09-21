#!/usr/bin/env python3
"""
import_lhc_forms.py - import real, standard clinical forms from the NLM LHC Forms
library into this sandbox as FHIR Questionnaires.

    python scripts/import_lhc_forms.py            # fetch + convert, write files only
    python scripts/import_lhc_forms.py --apply    # also upload to HAPI

WHY
The clinical forms this deployment's config expects are not publicly available,
so scripts/seed_clinical_questionnaires.py fills those slots with placeholders.
These are the opposite: complete, standard, validated instruments from the US
National Library of Medicine at https://lhcforms.nlm.nih.gov/lhcforms - real
content to demonstrate and test against.

HOW IT WORKS
NLM serves these in LForms' own format, not FHIR:

    https://clinicaltables.nlm.nih.gov/loinc_form_definitions?loinc_num=<code>

The conversion to a FHIR R4 Questionnaire is done by LHC-Forms itself
(LForms.Util.getFormFHIRData), which is the reference implementation and already
vendored in this repo for the portal's form preview. That needs a browser, so
this drives headless Chrome over a temporary local server.

The browser is needed only to AUTHOR these files. The result is plain FHIR JSON
written to config/fhir-bkm/fhir_content/questionnaire/lhc/, which is what gets
committed and uploaded. Nothing at runtime depends on Chrome.

IDS AND STATUS
Each form is given the stable id `lhc-<loinc>`, so re-running updates in place
rather than creating duplicates. They are marked `active`, unlike the seeded
placeholders which are `draft` - so the portal's Status column separates real
content from filler at a glance.
"""
import argparse
import functools
import glob
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR_REL = "bkm-web/vendor/lforms"
OUT_DIR = os.path.join(REPO_ROOT, "config", "fhir-bkm", "fhir_content", "questionnaire", "lhc")
DEFAULT_FHIR = "http://127.0.0.1:8079/fhir"
NLM = "https://clinicaltables.nlm.nih.gov/loinc_form_definitions?loinc_num={code}"

# Curated for a community-health deployment: screening instruments a CHW or
# clinic nurse would plausibly use, plus the measurement panels. Every one is a
# published, standard instrument rather than something invented here.
LHC_FORMS = [
    ("55418-8", "Weight and Height tracking panel"),
    ("34566-0", "Vital signs with method details panel"),
    ("44249-1", "PHQ-9 depression assessment"),
    ("69724-3", "PHQ-4 (brief depression and anxiety)"),
    ("69723-5", "Patient Health Questionnaire (full PHQ)"),
    ("69737-5", "GAD-7 anxiety"),
    ("72109-2", "AUDIT-C alcohol use"),
]

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]


def find_browser():
    for path in CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    found = shutil.which("google-chrome") or shutil.which("chromium")
    return found


def fetch_definition(code):
    with urllib.request.urlopen(NLM.format(code=code), timeout=40) as r:
        body = json.loads(r.read().decode("utf-8"))
    # A LOINC code with no published form definition comes back without items
    # rather than as an error, so check the shape instead of the status.
    if not body or not body.get("items"):
        raise ValueError("NLM has no form definition for this code")
    return body


def build_harness(defs):
    """One page that converts every definition in a single browser run."""
    return """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="result">PENDING</div>
<script src="/%s/zone.min.js"></script>
<script src="/%s/lhc-forms.js"></script>
<script src="/%s/lformsFHIR.min.js"></script>
<script>
var DEFS = %s;
var tries = 0;
(function wait() {
  if (typeof LForms !== 'undefined' && LForms.Util && LForms.Util.getFormFHIRData) {
    var out = {};
    DEFS.forEach(function(d) {
      try { out[d.code] = { ok: true, q: LForms.Util.getFormFHIRData('Questionnaire', 'R4', d.def) }; }
      catch (e) { out[d.code] = { ok: false, error: String(e && e.message || e) }; }
    });
    document.getElementById('result').textContent = 'RESULT:' + JSON.stringify(out);
    return;
  }
  if (++tries > 150) {
    document.getElementById('result').textContent = 'RESULT:{"__error":"lforms never loaded"}';
    return;
  }
  setTimeout(wait, 100);
})();
</script></body></html>""" % (VENDOR_REL, VENDOR_REL, VENDOR_REL, json.dumps(defs))


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves the repo (for the vendored library) plus the harness from memory.

    Keeping the harness out of the working tree means an interrupted run cannot
    leave a stray HTML file behind in the repo.
    """

    harness = b""

    def do_GET(self):
        if self.path == "/__harness.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(self.harness)))
            self.end_headers()
            self.wfile.write(self.harness)
            return
        super().do_GET()

    def log_message(self, *args):
        pass


def convert(defs, browser):
    Handler.harness = build_harness(defs).encode("utf-8")
    handler = functools.partial(Handler, directory=REPO_ROOT)

    with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            profile = tempfile.mkdtemp(prefix="lhc-chrome-")
            try:
                proc = subprocess.run(
                    [
                        browser, "--headless", "--disable-gpu", "--no-sandbox",
                        f"--user-data-dir={profile}",
                        "--virtual-time-budget=60000", "--dump-dom",
                        f"http://127.0.0.1:{port}/__harness.html",
                    ],
                    capture_output=True, text=True, timeout=180,
                )
            finally:
                shutil.rmtree(profile, ignore_errors=True)
        finally:
            httpd.shutdown()

    match = re.search(r"RESULT:(.*?)</div>", proc.stdout, re.S)
    if not match:
        raise RuntimeError("the browser produced no result - is this build of Chrome headless-capable?")
    return json.loads(match.group(1))


def put(fhir, rid, body):
    req = urllib.request.Request(
        f"{fhir}/Questionnaire/{rid}",
        data=json.dumps(body).encode("utf-8"),
        method="PUT",
        headers={"Content-Type": "application/fhir+json"},
    )
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.status


def upload_committed(fhir):
    """Upload the FHIR JSON already in the repo.

    Seeding takes this path. The files were authored once by the fetch-and-
    convert path below and committed, so a fresh install reproduces the same
    forms without reaching the internet or needing a browser - and without
    depending on NLM being up the day someone rebuilds a server.
    """
    paths = sorted(glob.glob(os.path.join(OUT_DIR, "lhc-*.json")))
    if not paths:
        print(f"No committed forms in {os.path.relpath(OUT_DIR, REPO_ROOT)} - "
              f"run without --from-files to author them.", file=sys.stderr)
        return 1

    print(f"Uploading {len(paths)} committed LHC form(s) to {fhir}")
    print()
    uploaded = errors = 0
    for path in paths:
        try:
            with open(path, encoding="utf-8") as f:
                q = json.load(f)
            status = put(fhir, q["id"], q)
            uploaded += 1
            print(f"  HTTP {status}  {q['id']:<16} {q.get('title','')[:44]}")
        except Exception as e:
            errors += 1
            print(f"  FAILED    {os.path.basename(path)}: {e}", file=sys.stderr)

    print()
    print(f"{uploaded} uploaded, {errors} failed")
    return 1 if errors else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fhir", default=DEFAULT_FHIR)
    ap.add_argument("--apply", action="store_true", help="upload to HAPI as well as writing files")
    ap.add_argument("--code", action="append", help="import only this LOINC code (repeatable)")
    ap.add_argument("--from-files", action="store_true",
                    help="skip NLM and the browser; upload the committed JSON in "
                         "config/fhir-bkm/fhir_content/questionnaire/lhc/. This is what "
                         "seeding uses - a fresh install needs no internet and no Chrome.")
    args = ap.parse_args()
    fhir = args.fhir.rstrip("/")

    wanted = LHC_FORMS
    if args.code:
        wanted = [(c, n) for c, n in LHC_FORMS if c in args.code]
        for c in args.code:
            if not any(c == code for code, _ in LHC_FORMS):
                wanted.append((c, "(ad hoc)"))

    if args.from_files:
        return upload_committed(fhir)

    browser = find_browser()
    if not browser:
        print("No Chrome or Edge found. This script needs one to run the LHC-Forms "
              "converter; the forms it produces do not.", file=sys.stderr)
        return 2

    print(f"Fetching {len(wanted)} form definition(s) from NLM\n")
    defs, failed = [], []
    for code, label in wanted:
        try:
            defs.append({"code": code, "def": fetch_definition(code)})
            print(f"  ok       {code:<9} {label}")
        except Exception as e:
            failed.append((code, label, str(e)))
            print(f"  FAILED   {code:<9} {label}: {e}")

    if not defs:
        print("\nNothing fetched.", file=sys.stderr)
        return 1

    print(f"\nConverting to FHIR R4 with LHC-Forms ({os.path.basename(browser)}, headless)")
    results = convert(defs, browser)
    if "__error" in results:
        print(f"\nConversion failed: {results['__error']}", file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    written, uploaded, errors = [], 0, 0

    print()
    for code, label in wanted:
        res = results.get(code)
        if not res:
            continue
        if not res.get("ok"):
            print(f"  FAILED   {code}: {res.get('error')}")
            errors += 1
            continue

        q = res["q"]
        q["id"] = f"lhc-{code}"
        # Converted output is 'draft'. These are complete published instruments,
        # so mark them active - that is also what separates them from the
        # placeholder stubs in the portal's Status column.
        q["status"] = "active"
        q.setdefault("title", label)
        q["publisher"] = "U.S. National Library of Medicine (LHC Forms)"

        path = os.path.join(OUT_DIR, f"lhc-{code}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(q, f, indent=2, ensure_ascii=False)
            f.write("\n")
        written.append(path)

        items = len(q.get("item", []))
        if args.apply:
            try:
                status = put(fhir, q["id"], q)
                uploaded += 1
                print(f"  HTTP {status}  {q['id']:<16} {q.get('title','')[:38]:<38} {items} items")
            except Exception as e:
                errors += 1
                print(f"  FAILED    {q['id']}: {e}")
        else:
            print(f"  wrote     {q['id']:<16} {q.get('title','')[:38]:<38} {items} items")

    print(f"\n{len(written)} file(s) in {os.path.relpath(OUT_DIR, REPO_ROOT)}")
    if args.apply:
        print(f"{uploaded} uploaded, {errors} failed")
    else:
        print("Files only. Re-run with --apply to upload to HAPI.")
    if failed:
        print(f"\n{len(failed)} code(s) had no NLM form definition:")
        for code, label, err in failed:
            print(f"  {code}  {label}: {err}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
