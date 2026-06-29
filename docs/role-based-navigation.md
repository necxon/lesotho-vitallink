# Role-Based App Navigation

## Overview

The BKM Android app (OpenSRP FHIR Core) shows a side-drawer menu to every logged-in user.
Currently all users see the same menu regardless of role. This document describes how to
restrict menu items by role (e.g. show "Accept Stock" only to facility workers, hide it from VHWs).

---

## How the Menu Works Today

The side drawer is driven by a single **FHIR Binary** resource stored in HAPI FHIR:

| Field | Value |
|---|---|
| Resource type | `Binary` |
| ID | `d7ce0167-ee6a-4f8f-b644-50b0242513239e` |
| HAPI FHIR URL | `GET http://localhost:8079/fhir/Binary/d7ce0167-ee6a-4f8f-b644-50b0242513239e` |

The Binary contains a JSON document with a `staticMenu` array — one object per menu item.
The portal's **App Navigation** page (`#/navigation`) reads and writes this document via HTTP PUT.

Example current menu item:

```json
{
  "id": "patient_registrationMenu",
  "visible": true,
  "display": "Patient Registration",
  "menuIconConfig": { "type": "local", "reference": "ic_households" },
  "actions": [{
    "trigger": "ON_CLICK",
    "workflow": "LAUNCH_QUESTIONNAIRE",
    "questionnaire": {
      "id": "patient-registration-form",
      "title": "Patient Registration",
      "saveButtonText": "Submit",
      "setPractitionerDetails": true,
      "setOrganizationDetails": false
    }
  }]
}
```

---

## User Roles in Keycloak

Roles are defined in the **opensrp** Keycloak realm (`http://localhost:8083`).

| Role | Who has it | What they do |
|---|---|---|
| `vhw` | Village Health Workers | Dispense medicine to patients in the field |
| `facility_worker` | Clinic / facility staff | Receive stock from warehouse, place orders |
| `supervisor` | District supervisors | View reports, manage VHW teams |

Roles are assigned per user in **Keycloak Admin → opensrp realm → Users → Role Mappings**.

The app reads the user's Keycloak token on login. The token contains the user's realm roles
in the `realm_access.roles` claim.

---

## Adding Role Conditions to Menu Items

> **⚠️ Action required from app dev:** Confirm the exact JSON field name and format the
> patched APK uses for role-based visibility. The standard OpenSRP FHIR Core field is
> documented below — verify this matches the build in use.

### Standard OpenSRP FHIR Core format

Add a `showWidget` or `visibility` condition to a menu item to restrict who sees it:

```json
{
  "id": "accept_stockMenu",
  "visible": true,
  "display": "Accept Stock",
  "menuIconConfig": { "type": "local", "reference": "ic_inventory" },
  "showWidget": {
    "rules": [{
      "name": "userRole",
      "condition": "IN",
      "value": ["facility_worker", "supervisor"]
    }]
  },
  "actions": [{
    "trigger": "ON_CLICK",
    "workflow": "LAUNCH_QUESTIONNAIRE",
    "questionnaire": {
      "id": "stock-receipt-form",
      "title": "Accept Stock",
      "saveButtonText": "Confirm Receipt",
      "setPractitionerDetails": true,
      "setOrganizationDetails": false
    }
  }]
}
```

A VHW-only dispense item:

```json
{
  "id": "dispense_medicineMenu",
  "visible": true,
  "display": "Dispense Medicine",
  "menuIconConfig": { "type": "local", "reference": "ic_needle" },
  "showWidget": {
    "rules": [{
      "name": "userRole",
      "condition": "IN",
      "value": ["vhw"]
    }]
  },
  "actions": [...]
}
```

Items with no `showWidget` field are visible to all roles (current behaviour).

---

## Proposed Menu Matrix

| Menu item | VHW | Facility Worker | Supervisor |
|---|:---:|:---:|:---:|
| Dispense Medicine | ✅ | | ✅ |
| Patient Registration | ✅ | ✅ | ✅ |
| Accept Stock | | ✅ | ✅ |
| Place Order | | ✅ | ✅ |
| Reports / Dashboard | | | ✅ |
| Household Visit | ✅ | | |

> Adjust to match actual business requirements.

---

## What Needs to Change

### 1. Confirm role-condition format with app dev (required first)
Verify that `showWidget.rules` with `name: "userRole"` is the correct field for the
version of the APK in use. The app team should be able to confirm or provide the correct schema.

### 2. Assign Keycloak roles to users
In Keycloak Admin (`http://localhost:8083` → opensrp realm):
- Each VHW user → assign realm role `vhw`
- Each facility worker user → assign realm role `facility_worker`
- Supervisors → assign realm role `supervisor`

No code changes needed — roles already exist in the realm.

### 3. Update the Binary resource
Edit the `staticMenu` JSON to add `showWidget` conditions to each item.
This can be done via:
- The **App Navigation** portal page (`http://localhost:9902/#/navigation`) once the
  portal's Edit form is extended to include a "Visible to roles" field (see section below), or
- A direct HTTP PUT to HAPI FHIR (no code change, just a data update)

### 4. Extend the App Navigation portal (optional, recommended)
Add a "Visible to roles" multi-select to the Add/Edit menu item form in
`bkm-web/js/pages/navigation.js`. This lets admins control role visibility without
editing raw JSON. Only frontend change — no backend or mediator changes needed.

---

## Server-Side Role Enforcement (Mediator)

Independently of what the app shows, the mediator also enforces roles server-side:

- A submission from a user mapped as `facility_worker` in the Mappings page triggers the
  **facility-receipt** code path (skips OpenLMIS/DHIS2 fan-out for receipts).
- A submission from a `vhw` triggers the normal dispense/receipt fan-out.

This is set in the **Mappings** page (`#/mappings`) → Performers tab → Role column.
It is separate from Keycloak roles and must be kept in sync manually for now.

---

## Quick Reference

| System | Where roles live | What they control |
|---|---|---|
| Keycloak | opensrp realm → Users → Role Mappings | Token claims → app menu visibility |
| FHIR Binary | `staticMenu[].showWidget` | Which menu items render in the app |
| Mediator Mappings | `/data/mappings-store.json` | Fan-out routing server-side |
