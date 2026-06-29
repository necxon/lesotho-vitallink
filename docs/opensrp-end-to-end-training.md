# OpenSRP End-to-End Training Guide

A basic, plain-language walkthrough of the system **from setup to daily use** — for the people
who will run and use it, not just developers. It follows one story in order:

> An **administrator** creates the facility, locations, a team, and a user →
> a **Village Health Worker (VHW)** logs into the Android app and does their daily work →
> a **supervisor** sees the results on dashboards.

If you only want to *use* the app and not set anything up, jump straight to
[Part 3 — Using the App (End User)](#part-3--using-the-app-end-user).

---

## Who does what

| Role | Tool they use | What they do |
|---|---|---|
| **Administrator** | OpenSRP Web (browser) + Keycloak (browser) | Create facilities, locations, teams, and user accounts |
| **VHW / CHW** (end user) | Android app (BKM / OpenSRP) | Register patients, dispense medicine, accept stock, place orders |
| **Supervisor** | OpenSRP Web + DHIS2 dashboards (browser) | Review patient registers, team activity, and stock reports |

---

## The building blocks (read this first)

Everything in OpenSRP is built from a few linked pieces. Create them in this order — each one
depends on the one above it.

```
Location        (where care happens — country ▸ district ▸ clinic ▸ village)
   │
Organization    (the facility / clinic as an entity)
   │
Practitioner    (a person — the VHW's identity: name, phone, staff ID)
   │
PractitionerRole(links the person to a facility + location + job role)
   │
Team / CareTeam (a group of practitioners working an area)
   │
Keycloak user   (the login account the person types their password into)
```

The **Keycloak user** (login) and the **Practitioner** (FHIR identity) are two separate records
that must be linked — but you normally **don't link them by hand**. OpenSRP Web's *User Management*
creates the login and the linked Practitioner together when you tick **"Mark as Practitioner"**
(see [Step 5](#step-5--create-the-login-mostly-automatic)). Knowing they are two records still
matters, because a broken link is the usual cause of a 403 at login.

---

# Part 1 — Administrator Setup

What you need before starting:

| Thing | Where | Login |
|---|---|---|
| OpenSRP Web dashboard | http://localhost:9901 | `opensrp-admin` / `admin` |
| Keycloak admin console | http://localhost:8083 | `admin` / `admin` |

> **Note for this sandbox:** A complete example facility (Maseru District Clinic A), 4 locations,
> 4 practitioners, and a team are **already seeded** by `make start`. You can follow the steps
> below to add *new* ones, or just inspect the existing ones to learn the structure.

---

## Step 1 — Create Locations

Locations form a tree: the country contains districts, a district contains clinics, and a clinic
serves several villages.

**In the sandbox the tree already looks like this:**

```
Lesotho                         (loc-lesotho)
└── Maseru District             (loc-maseru-district)
    └── Maseru District Clinic A(loc-maseru-clinic-a)
        ├── Ha Mokoena          (loc-ha-mokoena)
        ├── Ha Sehlabane        (loc-ha-sehlabane)
        └── Matsieng            (loc-matsieng)
```

**To add a new village in the OpenSRP Web UI:**

1. Open http://localhost:9901 and log in.
2. Go to **Location Management ▸ Location Unit**.
3. Click **Add Location Unit**.
4. Fill in:
   - **Name** — e.g. `Ha Sello`
   - **Parent** — choose `Maseru District Clinic A`
   - **Status** — Active
   - **Type** — Village / catchment area
5. Click **Save**.

> The location must be **Active** or it will not appear when you later assign a VHW to it.

---

## Step 2 — Create the Organization (facility)

An Organization is the clinic itself, as a record that practitioners can belong to.

1. In OpenSRP Web go to **Team Management ▸ Organizations** (sometimes labelled *Teams*).
2. Click **Add Organization**.
3. Fill in:
   - **Name** — e.g. `Maseru District Clinic A`
   - **Active** — Yes
   - **Type** — Healthcare Provider / Team
4. Click **Save**.

In the sandbox this already exists as `maseru-clinic-a` (Maseru District Clinic A).

---

## Step 3 — Create the Practitioner (the person)

A Practitioner is the field worker's identity — separate from their login.

1. Go to **Team Management ▸ Practitioners**.
2. Click **Add Practitioner**.
3. Fill in:
   - **First name / Last name** — e.g. `Lineo Sello`
   - **Phone** — e.g. `+266 5099 8877`
   - **Identifier / Staff ID** — e.g. `VHW-00130`
   - **Active** — Yes
4. Click **Save**.

The sandbox already has these practitioners:

| Name | ID | Role |
|---|---|---|
| OpenSRP Admin | `opensrp-admin` | Supervisor |
| Thabo Mokoena | `prac-thabo-mokoena` | VHW — Ha Mokoena |
| Lineo Nthabi | `prac-lineo-nthabi` | VHW — Ha Sehlabane |
| Mpho Lerotholi | `prac-mpho-lerotholi` | VHW — Matsieng |

---

## Step 4 — Assign the Practitioner to a place and role (PractitionerRole)

This connects the person to **where** they work and **what** they do.

1. Go to **Team Management ▸ Team Assignment** (or the **Practitioner** ▸ *Assign* action).
2. Choose:
   - **Practitioner** — the person from Step 3
   - **Organization** — `Maseru District Clinic A`
   - **Location** — the village from Step 1
3. Click **Save**.

After this, the VHW is officially attached to a clinic and a catchment village. The app uses this
link to decide which patients and tasks the VHW sees.

---

## Step 5 — Create the login (mostly automatic)

The VHW needs a **Keycloak account** to type a password into, and that account must be tied to the
**Practitioner** record. **In this sandbox you do not do this by hand in Keycloak** — OpenSRP Web's
**User Management** module does both for you.

This is wired up in [docker-compose.yml](../docker-compose.yml): the web app points at the Keycloak
Admin API (`REACT_APP_KEYCLOAK_API_BASE_URL`) and the `opensrp-admin` account is allowed to manage
users, so creating a user in OpenSRP Web reaches into Keycloak automatically.

### The normal way — OpenSRP Web User Management (recommended)

1. In OpenSRP Web (http://localhost:9901) go to **Admin ▸ User Management ▸ Users**.
2. Click **Add User** and fill in:
   - **Username** — e.g. `lineo.sello`
   - **First / Last name**, **Email**
   - **Enabled** — Yes
   - **Mark as Practitioner** — turn this **On**. This is what links the login to a Practitioner
     record automatically (it creates one, or links the one from Step 3). *This is the step you'd
     otherwise forget — the toggle does it for you.*
3. Click **Save**. The Keycloak login **and** the linked Practitioner are now created together.
4. Back on the user's row, use **Credentials** (or *Set password*) to give them a password — turn
   **Temporary** *Off* so they aren't forced to reset it on first login.
5. Assign their role / group so the app knows what they can do (`vhw`, `facility_worker`, or
   `supervisor`). Depending on the build this is a **User Group** on the user, or a role mapping.

> Field labels vary slightly between OpenSRP Web versions, but the shape is always the same:
> one "Add User" form that creates the login + Practitioner, then set a password, then assign role.

### The manual fallback — Keycloak console (only if the above fails)

If User Management is unavailable in your build, you can do the same thing by hand:

1. Open Keycloak http://localhost:8083 → `admin` / `admin` → switch realm **master → opensrp**.
2. **Users ▸ Add user** → username, email, **Email verified** On → **Create**.
3. **Credentials** tab → **Set password** → **Temporary** *Off* → **Save**.
4. **Role mapping** tab → **Assign role** → `vhw` / `facility_worker` / `supervisor` (plus the
   `MANAGE_*` / `GET_*` FHIR roles the app needs — already present on `opensrp-admin`).
5. Then in OpenSRP Web, edit the Practitioner and set its **User** field to this Keycloak user,
   which stores the Keycloak **UUID** against the Practitioner.

> **If login later fails with a 403 or a missing-practitioner error**, it is almost always this
> link being broken. The Keycloak user UUID changes if the Keycloak container is recreated, so the
> Practitioner must be re-linked. (Developers: see the troubleshooting section of
> [training-manual.md](training-manual.md).)

---

## Step 6 — (Optional) Put practitioners into a Team

A Team / CareTeam groups several VHWs and a supervisor over an area, so a supervisor can see all
their work in one place.

In the sandbox this is seeded as **Maseru North VHW Team** (`team-maseru-north`): 1 supervisor +
3 VHWs. To create your own, go to **Team Management ▸ Teams**, add a team, and add practitioners
as members.

✅ **Setup is now complete.** The VHW has a place to work, an identity, a login, and a role.

---

# Part 2 — What the VHW Sees After Login

When the VHW opens the Android app and logs in with their Keycloak username and password, the app
**syncs** and pulls down:

- The **patients / households** in their assigned village (from Step 4)
- Any **stock tasks** waiting for them (e.g. "accept this delivery")
- The **forms (questionnaires)** they are allowed to use
- The **side menu**, which may be tailored to their role (a VHW sees *Dispense Medicine*; a
  facility worker sees *Accept Stock*) — see [role-based-navigation.md](role-based-navigation.md).

If the menu or patients look wrong, the usual cause is that Step 4 (location assignment) or Step 5
(role mapping) was missed.

---

# Part 3 — Using the App (End User)

This is the day-to-day workflow for a Village Health Worker. Each action in the app quietly sends
data through the system to the national stock and reporting systems — the VHW does not need to know
that; they just fill in forms.

## 3.1 Log in and sync

1. Open the app.
2. Enter your **username** and **password** (your Keycloak login).
3. Wait for the **sync** to finish (a spinner / progress bar). When it completes you will see your
   patient register.

> Sync needs a connection. The app also works offline and syncs later when back online.

## 3.2 Register a patient / household

1. Tap **Patient Registration** (or **Register Household**).
2. Fill in name, age/date of birth, sex, village, phone.
3. Tap **Submit**.

The new patient now appears in your register and is available for dispensing.

## 3.3 Dispense medicine to a patient

This is the core daily task.

1. Open the patient from your register.
2. Tap **Dispense Medicine**.
3. Choose the **medicine** (e.g. *AL 20/120mg*) and enter the **quantity** (e.g. 6 tablets).
4. Tap **Submit**.

**What happens behind the scenes** (automatic — the VHW does nothing more):

```
App  ──MedicationDispense──▶  OpenHIM  ──▶  Mediator
                                              ├─▶ OpenLMIS : stock goes DOWN (Consumed)
                                              └─▶ DHIS2    : "Stock Dispensed" recorded
```

The clinic's stock-on-hand drops, and the dispense shows up on the national dashboards.

## 3.4 Accept a stock delivery

When the clinic sends stock to the VHW, a **task** appears in the app.

1. Tap **Accept Stock** (or open the task in your task list).
2. Confirm the **medicine**, **quantity received**, and **lot number**.
3. Tap **Confirm Receipt**.

**Behind the scenes:** stock goes **UP** in OpenLMIS (Receipts), the task is marked **completed**,
and the new stock-on-hand is reported to DHIS2.

## 3.5 Place a stock order

When stock runs low:

1. Tap **Place Order** (or **Request Stock**).
2. Choose the **medicine** and the **quantity needed**.
3. Tap **Submit**.

The order is saved and bundled with other VHWs' orders into a single weekly dispatch to the
warehouse. The VHW gets a confirmation that the order was queued.

---

# Part 4 — What the Supervisor Sees

A supervisor does not use the Android app for daily data entry. They use a browser:

### OpenSRP Web — people and registers

- http://localhost:9901 (`opensrp-admin` / `admin`)
- Patient lists, household registers, team membership, and location structure.

### DHIS2 — stock and reporting dashboards

- http://localhost:8081 (`admin` / `district`)
- Go to the **BKM Dashboard**:
  http://localhost:8081/dhis-web-dashboard/index.html#/BKMDashbrd1
- Charts show, per medicine and per month:
  - **Stock Dispensed** — how much was given to patients
  - **Stock Received** — how much arrived at the clinic
  - **Stock on Hand** — what is left

> Charts read from pre-aggregated tables. After a fresh round of test data, a supervisor (or the
> nightly job at 02:30) refreshes them. To refresh on demand, a developer runs the analytics
> rebuild — see [training-manual.md §4.2](training-manual.md).

---

# Quick reference

### Logins

| System | URL | Username | Password |
|---|---|---|---|
| OpenSRP Web (admin/supervisor) | http://localhost:9901 | `opensrp-admin` | `admin` |
| Keycloak (manage users) | http://localhost:8083 | `admin` | `admin` |
| DHIS2 (dashboards) | http://localhost:8081 | `admin` | `district` |
| Android app | (on device) | each VHW's Keycloak login | their own password |

### Setup order (cheat sheet)

1. **Location** — where they work
2. **Organization** — the facility
3. **Practitioner** — the person
4. **PractitionerRole** — link person ▸ facility ▸ location ▸ job
5. **Keycloak user + role** — the login, and link it to the Practitioner
6. **Team** *(optional)* — group VHWs under a supervisor

### End-user daily actions

| Action | App button | Effect on stock |
|---|---|---|
| Dispense medicine | Dispense Medicine | ⬇ down (Consumed) |
| Accept a delivery | Accept Stock | ⬆ up (Receipts) |
| Place an order | Place Order | queued for weekly dispatch |
| Register a patient | Patient Registration | — |

---

## See also

- [training-manual.md](training-manual.md) — full developer manual (services, APIs, fan-out, troubleshooting)
- [role-based-navigation.md](role-based-navigation.md) — restricting menu items by role
- [vhw-fhir-data-model.md](vhw-fhir-data-model.md) — the FHIR resources behind VHW registration
- [architecture.md](architecture.md) — how all the systems fit together
