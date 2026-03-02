# VHW Registration & FHIR Data Model

## Overview

When a Village Health Worker (VHW) registers on the OpenSRP 2 Android app, a set of linked FHIR R4 resources are created in the HAPI FHIR backend (port 8079). These resources represent the VHW's identity, their role at a facility, their geographic catchment area, and the team they belong to.

Authentication (login credentials) is handled separately by Keycloak. The FHIR resources carry the clinical and operational identity; Keycloak carries the security identity. They are linked via the Keycloak user UUID stored as an identifier on the `Practitioner` resource.

## Identity Systems Side-by-Side

```
Keycloak (port 8083)              HAPI FHIR (port 8079)
────────────────────              ─────────────────────
User account (opensrp-admin)      Practitioner resource
Username / password               Name, phone, employee ID
JWT Bearer token                  Linked via identifier.value = Keycloak UUID
Realm roles: OPENMRS, ALL_EVENTS  PractitionerRole (role + facility + location)
```

The Keycloak UUID also appears in OpenSRP's PostgreSQL `team.practitioner` table (`user_id` column), which is required for the mediator's event routing to succeed.

## FHIR Resources Created on VHW Registration

### 1. Practitioner

The VHW's core identity record. Created once per person.

```json
{
  "resourceType": "Practitioner",
  "id": "vhw-uuid-generated-by-server",
  "identifier": [
    {
      "use": "official",
      "system": "http://lesotho.gov.ls/staff-id",
      "value": "VHW-00123"
    },
    {
      "use": "secondary",
      "system": "http://keycloak/user-id",
      "value": "969bd959-8fb9-41af-8676-94f650b2e24d"
    }
  ],
  "active": true,
  "name": [{ "family": "Mokoena", "given": ["Thabo"] }],
  "telecom": [
    { "system": "phone", "value": "+26650123456", "use": "mobile" }
  ],
  "address": [
    { "district": "Maseru", "country": "LS" }
  ]
}
```

### 2. PractitionerRole

Links the VHW to a specific facility, location, and role. A VHW may have multiple roles (e.g. VHW + supervisor) each represented as a separate `PractitionerRole`.

```json
{
  "resourceType": "PractitionerRole",
  "id": "role-uuid",
  "active": true,
  "practitioner": { "reference": "Practitioner/vhw-uuid" },
  "organization": { "reference": "Organization/maseru-clinic-a" },
  "location": [{ "reference": "Location/catchment-zone-1" }],
  "code": [{
    "coding": [{
      "system": "http://snomed.info/sct",
      "code":   "CHW",
      "display": "Community Health Worker"
    }]
  }],
  "period": { "start": "2024-01-01" }
}
```

### 3. Organization

The health facility the VHW reports to. Typically pre-seeded by a district health officer; VHWs reference it but do not create it.

```json
{
  "resourceType": "Organization",
  "id": "maseru-clinic-a",
  "name": "Maseru District Clinic A",
  "type": [{ "coding": [{ "code": "prov", "display": "Healthcare Provider" }] }],
  "address": [{ "district": "Maseru", "country": "LS" }]
}
```

### 4. Location

The geographic catchment area or village the VHW is responsible for. Used by the app to scope which households and patients are visible to this VHW.

```json
{
  "resourceType": "Location",
  "id": "catchment-zone-1",
  "name": "Ha Mokoena Village",
  "status": "active",
  "mode": "instance",
  "type": [{ "coding": [{ "code": "COMM", "display": "Community" }] }],
  "physicalType": { "coding": [{ "code": "area", "display": "Area" }] },
  "address": { "district": "Maseru", "country": "LS" },
  "position": { "longitude": 27.483, "latitude": -29.317 }
}
```

### 5. Group (Catchment Population)

Represents the set of households assigned to this VHW. The app uses this to determine which patients to sync to the device.

```json
{
  "resourceType": "Group",
  "id": "group-vhw-catchment",
  "type": "person",
  "actual": true,
  "name": "Ha Mokoena — VHW Thabo Mokoena catchment",
  "managingEntity": { "reference": "Practitioner/vhw-uuid" },
  "member": [
    { "entity": { "reference": "Patient/patient-001" } },
    { "entity": { "reference": "Patient/patient-002" } }
  ]
}
```

### 6. CareTeam (optional)

Groups a supervisor and their VHWs together. Used by the app for supervisor dashboards and escalation workflows.

```json
{
  "resourceType": "CareTeam",
  "id": "care-team-maseru-north",
  "name": "Maseru North VHW Team",
  "status": "active",
  "participant": [
    {
      "role": [{ "coding": [{ "code": "supervisor" }] }],
      "member": { "reference": "Practitioner/supervisor-uuid" }
    },
    {
      "role": [{ "coding": [{ "code": "CHW" }] }],
      "member": { "reference": "Practitioner/vhw-uuid" }
    }
  ]
}
```

## What Happens at App Login

Once the VHW is registered, each login triggers this sequence:

```
1. App authenticates → Keycloak returns JWT
2. App fetches Practitioner + PractitionerRole from HAPI FHIR
3. App fetches ImplementationGuide → Composition → Binary resources
   (forms, questionnaires, app configuration)
4. App syncs assigned Group → downloads Patient records for catchment
5. App is ready for offline use
```

## Clinical Events Created During Field Work

Every action a VHW takes in the field creates further FHIR resources that eventually flow through OpenHIM into the Vital-Link Mediator:

| VHW Action | FHIR Resource | Mediator Route |
|---|---|---|
| Dispense malaria treatment | `MedicationDispense` | `POST /fhir/MedicationDispense` |
| Record stock receipt from facility | `MedicationDispense` (type=RECEIPT) | `POST /fhir/MedicationDispense` |
| Submit stock count form | `QuestionnaireResponse` | `POST /fhir/QuestionnaireResponse` |
| Register new patient | `Patient` | Not routed through mediator |
| Record household visit | `Encounter` + `Observation` | Not routed through mediator |

## MedicationDispense — Dispense vs Receipt

The mediator distinguishes dispense from receipt events by checking `MedicationDispense.type`:

```json
// Stock dispense (no type field, or any code other than RECEIPT)
{
  "resourceType": "MedicationDispense",
  "status": "completed",
  "subject": { "reference": "Patient/patient-001" },
  "performer": [{ "actor": { "reference": "Practitioner/opensrp-admin" } }],
  "quantity": { "value": 6, "unit": "tablet" }
}

// Stock receipt (supply staff receive stock at facility)
{
  "resourceType": "MedicationDispense",
  "status": "completed",
  "type": {
    "coding": [{ "code": "RECEIPT" }]
  },
  "performer": [{ "actor": { "reference": "Practitioner/opensrp-admin" } }],
  "quantity": { "value": 100, "unit": "tablet" }
}
```

| Field | Dispense | Receipt |
|---|---|---|
| `type.coding[].code` | absent or other | `RECEIPT` (configurable via `RECEIPT_TYPE_CODE` env) |
| OpenLMIS reason | Consumed / DEBIT (`b5c27da7-...`) | Receipts / CREDIT (`313f2f5f-...`) |
| DHIS2 data element | Stock Dispensed (`ujPSJuS9pph`) | Stock Received (`StckRcvdAL1`) |
| SOH effect | decreases | increases |

## Related Files

- [mediator/index.js](../mediator/index.js) — fan-out logic with full inline documentation
- [scripts/seed.sh](../scripts/seed.sh) — seeds DHIS2 data elements, OpenLMIS programs/facilities/reasons
- [scripts/e2e-test.sh](../scripts/e2e-test.sh) — end-to-end test suite (41 tests)
- [docs/architecture.md](./architecture.md) — system architecture and service map
