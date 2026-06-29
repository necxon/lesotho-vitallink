# OpenHIM Mappings Configuration

The mediator maintains two lookup tables that translate identifiers from the Android BKM app into the IDs used by OpenLMIS and DHIS2:

- **Performer Mappings** — maps a FHIR `Practitioner` reference to an OpenLMIS facility + program + contact details
- **Medication Mappings** — maps a medication code (e.g. `AL-20-120`) to an OpenLMIS orderable UUID

These mappings can be managed in two ways, with OpenHIM taking priority:

| Source | Priority | Hot-reload |
|---|---|---|
| OpenHIM Console (Mediator Config) | **Primary** | Yes — within 10 seconds |
| `mediator/mappings.csv` | Fallback (cold-start) | No — requires container restart |

---

## Managing Mappings in the OpenHIM Console

1. Open **http://localhost:9000** and log in (`root@openhim.org / openhim-password`)
2. Go to **Mediators → Vital-Link Lesotho → Config** tab
3. Fill in one or both fields and click **Save**

### Performer Mappings

JSON array of objects:

```json
[
  {
    "sourceId": "Practitioner/opensrp-admin",
    "facilityId": "28de536f-b826-4eeb-a3c4-d65221a1120d",
    "programId": "31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c",
    "phone": "+26658765432",
    "email": "admin@lesotho.health",
    "dhis2OrgUnit": "dwx1Yz4BwNX"
  },
  {
    "sourceId": "Practitioner/prac-thabo-mokoena",
    "facilityId": "28de536f-b826-4eeb-a3c4-d65221a1120d",
    "programId": "31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c",
    "phone": "+26657111111",
    "email": "thabo.mokoena@lesotho.health",
    "dhis2OrgUnit": "VilHaMokoe1"
  }
]
```

| Field | Required | Description |
|---|---|---|
| `sourceId` | Yes | FHIR Practitioner reference from the Android app |
| `facilityId` | Yes | OpenLMIS facility UUID (used for stock events) |
| `programId` | Yes | OpenLMIS program UUID |
| `phone` | No | VHW phone number for SMS notifications |
| `email` | No | VHW email for email notifications |
| `dhis2OrgUnit` | No | DHIS2 org unit UID where stock orders are written. Defaults to `DHIS2_ORG_UNIT` (facility). Set to a village UID (e.g. `VilHaMokoe1`) to route this VHW's orders to their village for the village map dashboard. |

> **Merge behaviour**: OpenHIM config is merged on top of CSV entries — it does not replace them. VHW entries not present in OpenHIM config retain their `dhis2OrgUnit` from `mappings.csv`. This means you can manage village routing via CSV without touching OpenHIM.

### Medication Mappings

JSON array of objects:

```json
[
  { "sourceId": "AL-20-120",         "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02056" },
  { "sourceId": "AMOX250",           "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02002" },
  { "sourceId": "amoxicillin-250mg", "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02002" },
  { "sourceId": "RDTKIT",            "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02003" },
  { "sourceId": "rdt-kit",           "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02003" },
  { "sourceId": "PARASYR",           "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02004" },
  { "sourceId": "paracetamol-syr",   "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02004" },
  { "sourceId": "CTX480",            "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02005" },
  { "sourceId": "ctx-480",           "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02005" },
  { "sourceId": "ORSACH",            "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02006" },
  { "sourceId": "ors-sachet",        "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02006" },
  { "sourceId": "ZINC20",            "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02007" },
  { "sourceId": "zinc-20mg",         "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02007" },
  { "sourceId": "IRNFOL",            "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02008" },
  { "sourceId": "iron-folic-acid",   "orderableId": "3be1d20f-6aa9-4e52-864f-4fa04aa02008" }
]
```

| Field | Required | Description |
|---|---|---|
| `sourceId` | Yes | Medication code from the Android app |
| `orderableId` | Yes | OpenLMIS orderable UUID |

> Multiple `sourceId` values can map to the same `orderableId` (e.g. short code and full name both resolve to the same orderable).

---

## How Hot-Reload Works

The mediator polls OpenHIM every 10 seconds via a heartbeat. When an admin saves new config in the console, the next heartbeat response delivers the updated JSON. The mediator overwrites its in-memory maps immediately — **no container restart required**.

Verify it worked by checking the logs:

```bash
docker logs bkm-mediator 2>&1 | grep -i "OpenHIM\|performer\|medication.*loaded"
```

Expected output after saving in the console:

```
OpenHIM config update received — reloading mappings
Performer mappings loaded from OpenHIM (2 entries)
Medication mappings loaded from OpenHIM (15 entries)
```

---

## CSV Fallback

`mediator/mappings.csv` is loaded on startup and acts as a safety net:

- If OpenHIM is **unreachable on startup**, the CSV mappings stay active and you'll see:
  `Could not fetch OpenHIM config on startup (using CSV)`
- If a field is **left empty** in the OpenHIM console, the CSV values for that map are preserved
- If **both** OpenHIM fields are filled, the CSV is fully overridden in memory (the file itself is not modified)

To add a new VHW or medicine during development without touching OpenHIM, edit `mappings.csv` and restart the container:

```bash
docker restart bkm-mediator
```

---

## CSV Column Reference

`mediator/mappings.csv` columns:

| Column | Rows | Description |
|--------|------|-------------|
| `type` | all | `performer` or `medication` |
| `source_id` | all | FHIR Practitioner ref or medication code |
| `target_facility_id` | performer | OpenLMIS facility UUID |
| `target_program_id` | performer | OpenLMIS program UUID |
| `target_orderable_id` | medication | OpenLMIS orderable UUID |
| `phone` | performer | VHW phone (SMS notifications) |
| `email` | performer | VHW email (email notifications) |
| `dhis2_org_unit` | performer | DHIS2 org unit for stock order writes (village UID or facility UID) |

---

## Re-registering configDefs

OpenHIM stores the mediator's config schema (configDefs) in its MongoDB on first registration. If you upgrade the mediator and add new config fields but the console Config tab doesn't show them, the old registration is stale. Fix it:

```bash
docker exec openhim-mongo mongo openhim --quiet --eval \
  "db.mediators.deleteOne({name: /vital/i}); print('deleted');"
docker restart bkm-mediator
```

The mediator will re-register with the current schema on startup.
