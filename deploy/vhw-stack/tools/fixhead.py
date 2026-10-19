import base64, json, os, sys, urllib.request as u
F = "http://127.0.0.1:8080/fhir"
APPLY = "--apply" in sys.argv
SORTED = "service.sortResources(householdHeadRelatedPersons, 'RelatedPerson.meta.lastUpdated.toString()', 'STRING', 'DESCENDING')"
OLD = "data.put('familyHeadIdRelatedPerson', size(householdHeadRelatedPersons) > 0 ? householdHeadRelatedPersons.get(0) : null)"
NEW = "data.put('familyHeadIdRelatedPerson', size(householdHeadRelatedPersons) > 0 ? (" + SORTED + " != null ? " + SORTED + ".get(0) : householdHeadRelatedPersons.get(0)) : null)"
LABEL = "data.put('getFamilyHeadStatus', 'Patient/' + data.get('patientId') == data.get('familyHeadIdRelatedPersonId') ? 'Family Head' : '')"
def http(m, url, b=None):
    r = u.Request(url, data=json.dumps(b).encode() if b else None, method=m, headers={"Accept": "application/fhir+json", "Content-Type": "application/fhir+json", "Cache-Control": "no-cache"})
    return json.load(u.urlopen(r, timeout=60))
def secs(l):
    for s in l or []:
        yield s
        yield from secs(s.get("section"))
comp = http("GET", F + "/Composition?identifier=bkm")["entry"][0]["resource"]
for s in secs(comp.get("section")):
    ref = (s.get("focus") or {}).get("reference", "")
    if not ref.startswith("Binary/"): continue
    bn = http("GET", F + "/" + ref)
    try: cfg = json.loads(base64.b64decode(bn["data"]))
    except Exception: continue
    if cfg.get("id") == "householdProfile" and cfg.get("configType") == "profile": break
else: sys.exit("household profile not found")
n = []
def walk(x):
    if isinstance(x, dict):
        a = x.get("actions")
        if isinstance(a, list):
            if x.get("name") == "familyHeadIdRelatedPerson" and a == [OLD]: x["actions"] = [NEW]; n.append("pick newest head record")
            if x.get("name") == "getFamilyHeadStatus" and a != [LABEL]: x["actions"] = [LABEL]; n.append("restore label rule")
        for v in x.values(): walk(v)
    elif isinstance(x, list):
        for v in x: walk(v)
walk(cfg)
print(ref, "version", bn["meta"]["versionId"], "->", n or "nothing to change")
if n and APPLY:
    bak = os.path.expanduser("~/Binary-" + ref[7:] + ".before-fixhead.json")
    if not os.path.exists(bak): json.dump(bn, open(bak, "w"))
    bn["data"] = base64.b64encode(json.dumps(cfg, indent=2, ensure_ascii=False).encode()).decode()
    print("WRITTEN version", http("PUT", F + "/" + ref, bn)["meta"]["versionId"], "backup", bak)
elif n: print("dry run - add --apply")
