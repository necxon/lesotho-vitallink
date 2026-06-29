#!/usr/bin/env python3
"""Generate the derived reseed configs from the single-source facilities file.

Reads  config/facilities/mafeteng-facilities.json
Writes (all under config/facilities/):
  - mafeteng-realm-users.json   Keycloak realm `users` entries (one coordinator each)
  - mafeteng-ou-labels.js       bkm-web OU_LABELS block (one entry per facility OU)
  - mafeteng-mappings.json      mediator performer mappings (KC sub -> facility, for /whoami scoping)
  - mafeteng-seed-data.env      bash-sourceable facility list for the seed provisioning loops

Idempotent: re-run any time the source file changes. seed.sh applies these atomically
(replacing the Maseru demo). Stock keeps the existing demo orderables (seeded per facility
by seed.sh). VHWs/villages are deferred.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAC_DIR = os.path.join(ROOT, "config", "facilities")
# Seed password for generated KC users. Real value comes from the environment
# (set SEED_USER_PASSWORD in .env); the default is a placeholder for the public repo.
PASSWORD = os.environ.get("SEED_USER_PASSWORD", "changeme")

src = json.load(open(os.path.join(FAC_DIR, "mafeteng-facilities.json")))
district = src["district"]
facilities = src["facilities"]

# App role set every facility user carries (the resource roles FHIR-Core needs to sync).
APP_ROLES = [
    "OPENMRS", "ALL_EVENTS", "MANAGE_Patient", "MANAGE_Practitioner", "MANAGE_PractitionerRole",
    "MANAGE_Group", "MANAGE_Organization", "MANAGE_OrganizationAffiliation", "MANAGE_HealthcareService",
    "MANAGE_Location", "MANAGE_Observation", "MANAGE_QuestionnaireResponse", "MANAGE_CareTeam",
    "MANAGE_PlanDefinition", "MANAGE_Questionnaire", "MANAGE_PractitionerDetail", "MANAGE_List",
    "MANAGE_Binary", "MANAGE_Condition", "MANAGE_Task", "MANAGE_Immunization", "MANAGE_Encounter",
    "MANAGE_Flag",
]

def role_title(role):
    return {"coordinator": "Coordinator", "vhw": "VHW"}[role]

# ---- 1. realm users -------------------------------------------------------
users = []
for f in facilities:
    for u in f["users"]:
        first = role_title(u["role"]).split()[0]
        users.append({
            "id": u["kcId"],
            "username": u["username"],
            "enabled": True,
            "emailVerified": True,
            "firstName": f["name"],
            "lastName": role_title(u["role"]),
            "attributes": {"facility": [f["name"]], "facilityId": [f["lmisFacilityId"]]},
            "credentials": [{"type": "password", "value": PASSWORD, "temporary": False}],
            "realmRoles": [u["role"]] + APP_ROLES,
        })
json.dump(users, open(os.path.join(FAC_DIR, "mafeteng-realm-users.json"), "w"), indent=2)

# ---- 2. bkm-web OU_LABELS -------------------------------------------------
lines = ["// AUTO-GENERATED from mafeteng-facilities.json by scripts/gen_mafeteng_configs.py",
         "var OU_LABELS = {"]
for f in facilities:
    lines.append(
        f"  '{f['dhis2Ou']}': {{ village: '{f['name']}', region: '{district['name']}', "
        f"facility: '{f['name']}', lmisFacility: '{f['lmisFacilityId']}', "
        f"fhirLocation: '{f['fhirLocationId']}' }},")
lines.append("};")
open(os.path.join(FAC_DIR, "mafeteng-ou-labels.js"), "w").write("\n".join(lines) + "\n")

# ---- 3. mediator performer mappings (whoami facility lookup) ---------------
performers = []
for f in facilities:
    for u in f["users"]:
        performers.append({
            "sourceId": u["kcId"],            # JWT sub -> facility (whoami)
            "facilityId": f["lmisFacilityId"],
            "facilityName": f["name"],
            "programId": "",
            "dhis2OrgUnit": f["dhis2Ou"],
            "name": f"{f['name']} {role_title(u['role'])}",
            "role": u["role"],
            "aliases": [u["username"]],
            "locationId": f["fhirLocationId"],
            "locationName": f["name"],
        })
json.dump({"performers": performers, "medications": []},
          open(os.path.join(FAC_DIR, "mafeteng-mappings.json"), "w"), indent=2)

# ---- 4. bash-sourceable facility list for seed loops ----------------------
env = ["# AUTO-GENERATED from mafeteng-facilities.json - (sourced by seed.sh)",
       f"MFT_DISTRICT_NAME='{district['name']}'",
       f"MFT_DISTRICT_GEOZONE='{district['lmisGeoZoneId']}'",
       f"MFT_DISTRICT_FHIRLOC='{district['fhirLocationId']}'",
       f"MFT_DISTRICT_DHIS2OU='{district['dhis2Ou']}'",
       "# fields: name|code|type|lmisId|fhirOrg|fhirLoc|dhis2Ou",
       "MFT_FACILITIES=("]
for f in facilities:
    env.append(f"  \"{f['name']}|{f['code']}|{f['type']}|{f['lmisFacilityId']}|"
               f"{f['fhirOrgId']}|{f['fhirLocationId']}|{f['dhis2Ou']}\"")
env.append(")")
# fields: username|kcId|role|lmisId|dhis2Ou
env.append("MFT_USERS=(")
for f in facilities:
    for u in f["users"]:
        env.append(f"  \"{u['username']}|{u['kcId']}|{u['role']}|{f['lmisFacilityId']}|{f['dhis2Ou']}\"")
env.append(")")
open(os.path.join(FAC_DIR, "mafeteng-seed-data.env"), "w").write("\n".join(env) + "\n")

print(f"Generated for {len(facilities)} facilities / {len(users)} users:")
for n in ("mafeteng-realm-users.json", "mafeteng-ou-labels.js", "mafeteng-mappings.json", "mafeteng-seed-data.env"):
    print("  config/facilities/" + n)
