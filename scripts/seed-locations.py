"""Seed FHIR Location hierarchy for Lesotho health facilities."""
import urllib.request, json, time, sys

BASE = "http://localhost:8079/fhir"

def put_location(loc_id, name, parent_id=None, loc_type="area", physical_type="jdn"):
    type_map = {
        "area":    ("AREA",  "Area",          "http://terminology.hl7.org/CodeSystem/v3-RoleCode"),
        "hosp":    ("HOSP",  "Hospital",      "http://terminology.hl7.org/CodeSystem/v3-RoleCode"),
        "hc":      ("HC",    "Health Centre", "http://terminology.hl7.org/CodeSystem/v3-RoleCode"),
        "village": ("COMM",  "Community",     "http://terminology.hl7.org/CodeSystem/v3-RoleCode"),
    }
    phys_map = {
        "jdn":  ("jdn",  "Jurisdiction"),
        "bu":   ("bu",   "Building"),
        "area": ("area", "Area"),
    }
    tc, td, ts = type_map.get(loc_type, type_map["area"])
    pc, pd     = phys_map.get(physical_type, phys_map["jdn"])

    body = {
        "resourceType": "Location",
        "id": loc_id,
        "status": "active",
        "mode": "instance",
        "name": name,
        "type": [{"coding": [{"system": ts, "code": tc, "display": td}]}],
        "physicalType": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/location-physical-type", "code": pc, "display": pd}]},
    }
    if parent_id:
        body["partOf"] = {"reference": "Location/" + parent_id}

    data = json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + "/Location/" + loc_id, data=data, method="PUT",
        headers={"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code

LOCATIONS = [
    # id, name, parent, type, physicalType

    # 9 new districts (parent: loc-lesotho)
    ("loc-berea-district",        "Berea District",                       "loc-lesotho",              "area",    "jdn"),
    ("loc-butha-buthe-district",  "Butha-Buthe District",                 "loc-lesotho",              "area",    "jdn"),
    ("loc-leribe-district",       "Leribe District",                      "loc-lesotho",              "area",    "jdn"),
    ("loc-mafeteng-district",     "Mafeteng District",                    "loc-lesotho",              "area",    "jdn"),
    ("loc-mohales-hoek-district", "Mohale's Hoek District",               "loc-lesotho",              "area",    "jdn"),
    ("loc-mokhotlong-district",   "Mokhotlong District",                  "loc-lesotho",              "area",    "jdn"),
    ("loc-qachas-nek-district",   "Qacha's Nek District",                 "loc-lesotho",              "area",    "jdn"),
    ("loc-quthing-district",      "Quthing District",                     "loc-lesotho",              "area",    "jdn"),
    ("loc-thaba-tseka-district",  "Thaba-Tseka District",                 "loc-lesotho",              "area",    "jdn"),

    # Maseru - additional facilities + missing villages
    ("loc-maseru-hosp",           "Maseru District Hospital",             "loc-maseru-district",      "hosp",    "bu"),
    ("loc-queen-mamohato",        "Queen Mamohato Memorial Hospital",     "loc-maseru-district",      "hosp",    "bu"),
    ("loc-scott-hospital",        "Scott Hospital (Morija)",              "loc-maseru-district",      "hosp",    "bu"),
    ("loc-roma-clinic",           "Roma Clinic",                          "loc-maseru-district",      "hc",      "bu"),
    ("loc-semonkong-hc",          "Semonkong Health Centre",              "loc-maseru-district",      "hc",      "bu"),
    ("loc-thetsane-hc",           "Thetsane Health Centre",               "loc-maseru-district",      "hc",      "bu"),
    ("loc-ha-sehlabane",          "Ha Sehlabane",                         "loc-maseru-clinic-a",      "village", "area"),
    ("loc-matsieng",              "Matsieng",                             "loc-maseru-clinic-a",      "village", "area"),

    # Berea
    ("loc-berea-hospital",        "Berea Hospital (Teyateyaneng)",        "loc-berea-district",       "hosp",    "bu"),
    ("loc-maluti-hospital",       "Maluti Adventist Hospital (Mapoteng)", "loc-berea-district",       "hosp",    "bu"),
    ("loc-maqhaka-hc",            "Maqhaka Health Centre",                "loc-berea-district",       "hc",      "bu"),
    ("loc-khubetsoana-hc",        "Khubetsoana Health Centre",            "loc-berea-district",       "hc",      "bu"),
    ("loc-mapheleng-hc",          "Mapheleng Health Centre",              "loc-berea-district",       "hc",      "bu"),

    # Butha-Buthe
    ("loc-butha-buthe-hosp",      "Butha-Buthe Hospital",                 "loc-butha-buthe-district", "hosp",    "bu"),
    ("loc-seboche-hospital",      "Seboche Hospital",                     "loc-butha-buthe-district", "hosp",    "bu"),
    ("loc-fobane-hc",             "Fobane Health Centre",                 "loc-butha-buthe-district", "hc",      "bu"),
    ("loc-motete-hc",             "Motete Health Centre",                 "loc-butha-buthe-district", "hc",      "bu"),

    # Leribe
    ("loc-motebang-hospital",     "Motebang Hospital (Hlotse)",           "loc-leribe-district",      "hosp",    "bu"),
    ("loc-mamohau-hospital",      "Mamohau Hospital",                     "loc-leribe-district",      "hosp",    "bu"),
    ("loc-hlotse-hc",             "Hlotse Health Centre",                 "loc-leribe-district",      "hc",      "bu"),
    ("loc-maputsoe-hc",           "Maputsoe Health Centre",               "loc-leribe-district",      "hc",      "bu"),
    ("loc-tsikoane-hc",           "Tsikoane Health Centre",               "loc-leribe-district",      "hc",      "bu"),

    # Mafeteng
    ("loc-mafeteng-hospital",     "Mafeteng Hospital",                    "loc-mafeteng-district",    "hosp",    "bu"),
    ("loc-mohalalitoe-hc",        "Mohalalitoe Health Centre",            "loc-mafeteng-district",    "hc",      "bu"),
    ("loc-ramabanta-hc",          "Ramabanta Health Centre",              "loc-mafeteng-district",    "hc",      "bu"),
    ("loc-mafeteng-clinic",       "Mafeteng Urban Clinic",                "loc-mafeteng-district",    "hc",      "bu"),

    # Mohale's Hoek
    ("loc-mohales-hoek-hosp",     "Mohale's Hoek Hospital",               "loc-mohales-hoek-district","hosp",    "bu"),
    ("loc-moyeni-hc",             "Moyeni Health Centre",                 "loc-mohales-hoek-district","hc",      "bu"),
    ("loc-sekake-hc",             "Sekake Health Centre",                 "loc-mohales-hoek-district","hc",      "bu"),

    # Mokhotlong
    ("loc-mokhotlong-hospital",   "Mokhotlong Hospital",                  "loc-mokhotlong-district",  "hosp",    "bu"),
    ("loc-mapholaneng-hc",        "Mapholaneng Health Centre",            "loc-mokhotlong-district",  "hc",      "bu"),
    ("loc-sani-hp",               "Sani Health Post",                     "loc-mokhotlong-district",  "hc",      "bu"),

    # Qacha's Nek
    ("loc-qachas-nek-hosp",       "Qacha's Nek Hospital",                 "loc-qachas-nek-district",  "hosp",    "bu"),
    ("loc-qachas-nek-hc",         "Qacha's Nek Health Centre",            "loc-qachas-nek-district",  "hc",      "bu"),
    ("loc-marakabei-hc",          "Marakabei Health Centre",              "loc-qachas-nek-district",  "hc",      "bu"),

    # Quthing
    ("loc-quthing-hospital",      "Quthing Hospital",                     "loc-quthing-district",     "hosp",    "bu"),
    ("loc-mount-moorosi-hc",      "Mount Moorosi Health Centre",          "loc-quthing-district",     "hc",      "bu"),
    ("loc-mphaki-hc",             "Mphaki Health Centre",                 "loc-quthing-district",     "hc",      "bu"),

    # Thaba-Tseka
    ("loc-thaba-tseka-hosp",      "Thaba-Tseka Hospital",                 "loc-thaba-tseka-district", "hosp",    "bu"),
    ("loc-katse-hc",              "Katse Health Centre",                  "loc-thaba-tseka-district", "hc",      "bu"),
    ("loc-thaba-tseka-hc",        "Thaba-Tseka Rural Health Centre",      "loc-thaba-tseka-district", "hc",      "bu"),
]

ok = 0; err = 0
for args in LOCATIONS:
    s = put_location(*args)
    if s in (200, 201):
        ok += 1
    else:
        print(f"  ERR {s} {args[0]}")
        err += 1
    time.sleep(0.1)

print(f"Created/updated: {ok}  Errors: {err}")

req = urllib.request.Request(BASE + "/Location?_summary=count", headers={"Accept":"application/fhir+json"})
with urllib.request.urlopen(req, timeout=15) as r:
    d = json.loads(r.read())
    print(f"Total FHIR Locations: {d.get('total','?')}")
