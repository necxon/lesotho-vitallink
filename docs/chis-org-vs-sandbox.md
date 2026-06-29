# chis-organization vs Sandbox — Full Comparison

---

## 1. chis-organization GitHub Repos

The organisation at https://github.com/chis-organization has **2 public repositories**:

| Repo | Status | Description |
|------|--------|-------------|
| `fhircore` | Active fork, last updated Apr 2025 | Android app — forked from `opensrp/fhircore` |
| `bkm-chis` | **Archived** Feb 2025, 2 commits | Empty shell, never used. Ignore. |

There is **no public opensrp-app-configs repo**. The FHIR questionnaires, registers,
profiles, StructureMaps, and Composition are managed as private configuration and
deployed directly to their HAPI FHIR server — not stored in any public git repo.

---

## 2. What chis-organization Changed in fhircore

Their fork is `chis-organization/fhircore`, forked from `opensrp/fhircore` on
**Feb 13 2025**. It has **8–10 custom commits** and is otherwise kept in sync with
upstream via regular merge commits.

### Custom commits

| Commit | Author | Date | What it does |
|--------|--------|------|-------------|
| `1108afb7` | Elly Kitoto | 2025-02-14 | Update image assets |
| `32699f6b` | Benjamin Mwalimu | 2025-02-21 | Add `bkmChis` flavor |
| `316ccf2c` | Francis Odhiambo | 2025-02-26 | **`SKIP_AUTHENTICATION` feature** |
| `a683dfbe` | Elly Kitoto | 2025-02-26 | Hot fix / initial commit |
| `bc73398a` | Martin Ndegwa | 2025-03-04 | Knowledge Manager + Workflow library upgrades |
| `3cc0a90e` | Rkareko | 2025-03-05 | Restrict editing QuestionnaireResponse when saving draft |
| `7bb29dbf` | Fikri Milano | 2025-03-17 | Add `mcct` flavor (unrelated to Lesotho) |
| `cd5d1e28` | Rkareko | 2025-03-21 | Fix periodic sync scheduling; version 2.1.2 → 2.1.3 |
| `9b7d376c` | Rkareko | 2025-03-28 | Update IG URL in docs |
| `2c42f45a` | Benjamin Mwalimu | 2025-04-11 | Merge upstream `opensrp:main` |

### File changes (only 5 files touched vs upstream)

**`android/quest/build.gradle.kts`** — two new flavor blocks added:
```kotlin
create("bkmChis") {
  dimension = "apps"
  applicationIdSuffix = ".bkmchis"
  versionNameSuffix = "-bkmChis"
  manifestPlaceholders["appLabel"] = "BKM CHIS"
}

create("mcct") {
  dimension = "apps"
  applicationIdSuffix = ".mcct"
  versionNameSuffix = "-mcct"
  manifestPlaceholders["appLabel"] = "MCCT+"
}
```

**`android/quest/src/bkmChis/res/drawable/`** — two new image files:
- `ic_app_logo.png` — BKM CHIS app logo (128 KB, Adobe Photoshop)
- `ic_launcher.png` — launcher icon (5.95 KB)

**`android/buildSrc/src/main/kotlin/project-properties.gradle.kts`** — one line added:
```kotlin
SKIP_AUTHENTICATION = "false"   // new property, defaults to false
```

### The only real code change: SKIP_AUTHENTICATION (commit 316ccf2c)

This is their most significant custom contribution — 8 files, 147 line changes:

| File | Change |
|------|--------|
| `AppSettingViewModel.kt` | When flag is true, navigate directly to `AppMainActivity`, skip `LoginActivity` |
| `AppMainViewModel.kt` | Wrap `schedulePeriodicSync()` in `if (!BuildConfig.SKIP_AUTHENTICATION)` |
| `AppDrawer.kt` | Hide sync drawer section when auth is skipped |
| `RegisterScreen.kt` | Hide first-time sync dialog when auth is skipped |
| `UserSettingFragment.kt` | Disable manual sync option when auth is skipped |
| `LoginActivity.kt` | Remove deprecated `@OptIn(ExperimentalMaterialApi::class)` |
| `AppSettingActivity.kt` | Remove `AccountAuthenticator` injection |
| `build.gradle.kts` | Wire `SKIP_AUTHENTICATION` buildConfigField from property |

**Your sandbox already uses this.** `SKIP_AUTHENTICATION=true` in your
`android/local.properties` activates the exact same logic.

### Version bump + sync fix (commit cd5d1e28)

```kotlin
// BuildConfigs.kt
versionCode = 16        // was 15
versionName = "2.1.3"  // was 2.1.2

// AppMainViewModel.kt
viewModelScope.launch {
  schedulePeriodicSync()   // was called outside a coroutine scope — caused scheduling failure
}
```

---

## 3. opensrp-app-configs: Theirs vs Yours

chis-organization has no public configs repo. The table below compares what can be
inferred from the `bkm-chis/sample_composition_config.json` (their reference
Composition structure) against what is seeded in your sandbox.

### Composition structure

| Section type | chis-organization (production BKM) | Your sandbox |
|---|---|---|
| Application config | 1 Binary | 1 Binary |
| Sync config | 1 Binary | 1 Binary |
| Navigation config | 1 Binary | 1 Binary |
| **Registers** | **12** (household, ANC, child, task, CMNTD, FP, HIV, mental health, PNC, sick child, TB + 1 more) | **13** (same 11 + inventory + stock acceptance) |
| **Profiles** | **3** (household, default, other registers) | **4** (same 3 + inventory profile) |
| **Translations** | **3** (English, Swahili, French) | **4** (English, Swahili, French + Sesotho stub) |
| **Questionnaires** | **26** (full clinical suite) | **5** (household reg, stock dispense, stock order, stock accept, stock adjustment) |
| **StructureMaps** | **21** (full extraction logic) | **0** (none seeded — sandbox Questionnaires have no linked StructureMaps) |
| PlanDefinitions | Present (care planning) | 0 |

### application_config.json

| Property | chis-organization (demo reference) | Your sandbox |
|---|---|---|
| `appTitle` | `"Quest"` | `"Quest"` |
| `syncStrategy` | `["Location","Organization","CareTeam","Practitioner"]` | `["RelatedEntityLocation"]` |
| `syncInterval` | 30 min | 30 min |
| `languages` | `["en","sw","fr"]` | `["en","sw","fr","ss"]` |
| `enablePin` | `true` | `false` |
| `logGpsLocation` | `["QUESTIONNAIRE"]` | `[]` |

### navigation_config.json — menu structure

| Menu item | chis-organization | Your sandbox |
|---|---|---|
| Main FAB action | "Add Household" | "Add Household" |
| Top-level registers | Households, Children, Sick child | Households, Children, Sick child |
| Bottom sheet registers | ANC, PNC, FP, HIV, Mental Health, TB, CMNTD, Tasks | ANC, PNC, FP, HIV, Mental Health, TB, CMNTD, Tasks, **Inventory, Stock Acceptance** |
| Static menu (drawer) | Settings, Insights | Settings, Insights, **Stock Order**, **Stock Dispense** |

### sync_config.json — key differences

| Parameter | chis-organization | Your sandbox |
|---|---|---|
| Questionnaire IDs synced | 26 production IDs | 7 sandbox IDs (`f210a832-...`, `qn-stock-*`) |
| Library IDs | 14 production IDs (CQL libraries) | Same 14 IDs (hardcoded — these won't resolve in sandbox) |
| Measure IDs | 12 production IDs | Same 12 IDs (hardcoded — these won't resolve) |
| MeasureReport sync | `https://fhir.labs.smartregister.org/...` | Same URL (points to external server — not sandbox HAPI FHIR) |
| syncStrategy | Location-based | `RelatedEntityLocation` |

> **Note:** The sandbox `sync_config.json` still has hardcoded production Library/Measure
> IDs pointing to `fhir.labs.smartregister.org`. These do not exist on the sandbox HAPI
> FHIR server and the sync will skip them silently — not a breaking error but worth
> replacing with sandbox-seeded IDs if you seed those resources.

### Questionnaires — complete list (26 total, from sample_composition_config.json)

The exact Questionnaire IDs and config keys from their production Composition (ID: 214560).
These are the IDs the Android app uses to fetch forms from HAPI FHIR.

| # | Title | Questionnaire ID | Config key (identifier.value) | In sandbox? |
|---|-------|-----------------|-------------------------------|-------------|
| 1 | Add Family | `f210a832-857f-49e6-93f5-399eec4f4edb` | `family-registration` | ✓ (simplified) |
| 2 | Add Family Member | `e5155788-8831-4916-a3f5-486915ce34b2` | `family-member-registration` | ✓ (simplified) |
| 3 | Add Family Member Confirmation | `f0a04fc4-4179-4df4-b2dc-8b2eac444d0b` | `family-member-registration-confirmation` | ✗ |
| 4 | Remove Family | `0259e181-581e-4b4c-8409-e3be3a166ef5` | `remove-family` | ✗ |
| 5 | Remove Family Member | `7f1960ac-81b5-42a2-8813-97222de5745a` | `remove-family-member` | ✗ |
| 6 | New Pregnancy Registration | `9b22f3ed-e7e1-4222-bf72-1ced42696189` | `anc-patient-registration` | ✗ |
| 7 | Pregnancy Visit | `f642fe17-1d75-45a2-b813-3cfb69706cb0` | `anc-visit` | ✗ |
| 8 | Pregnancy Outcome | `405619ff-cde8-4379-b674-0a4735098b33` | `pregnancy-outcome` | ✗ |
| 9 | Sick Child Under 2 Months | `58fbddae-c5a0-4b86-832e-f516c96f3b85` | `sick-child-under-2m` | ✗ |
| 10 | Child Immunization Completion | `9b1aa23b-577c-4fb2-84e3-591e6facaf82` | `child-immunization-completion` | ✗ |
| 11 | Sick Child Above 2 Months | `3276f55c-b25e-455b-ae4e-8846fb8fd039` | `sick-child-above-2m` | ✗ |
| 12 | Sick Child Follow Up | `1bdf21ef-d31a-446e-aaa6-cec516eceab1` | `sick-child-followup` | ✗ |
| 13 | Counter Referral | `c309abfa-7536-4c60-baea-cf631201f79e` | `referral` | ✗ |
| 14 | New FP Registration | `4acc8776-32b0-4440-a1b1-a11a12d79acb` | `family-planning` | ✗ |
| 15 | FP Visit | `450cb100-0c5b-47c6-9f33-2830a79be726` | `fp-visit` | ✗ |
| 16 | PNC Visit | `8a1f9578-5b88-45ea-8120-8f8557e01d8c` | `pnc-follow-up-visit` | ✗ |
| 17 | Under 1 Year Child Visit Form | `5a60a629-bcf4-4101-96ac-a5e07b35f30e` | `under-1-year-child-visit-form` | ✗ |
| 18 | Over 1 Year Child Visit Form | `91c51999-0e04-495a-8d70-58c3aabefcab` | `over-1-year-child-visit-form` | ✗ |
| 19 | Diseases Registration Form | `f7004382-ba3d-4f62-a687-6e9d18c09d3a` | `disease-registration-form` | ✗ |
| 20 | Diseases Followup Form | `e14b5743-0a06-4ab5-aaee-ac158d4cb64f` | `disease-followup-form` | ✗ |
| 21 | Household Visit Form | `5458ecb6-835a-4f11-873f-2abfdfeec93c` | `household-visit-form` | ✗ |
| 22 | Death Record Confirmation | `5a4f4462b-7407-4b53-a814-2618efe46c84` | `death-record-confirmation` | ✗ |
| 23 | New FP Enrollment Confirmation | `8bb7a98f-8f73-40f2-b484-ecace14be187` | `fp-enrollment-confirmation` | ✗ |
| 24 | New ANC Enrollment Confirmation | `d2e39622-82fe-4263-b823-bb50a5370d33` | `anc-enrollment-confirmation` | ✗ |
| 25 | Physical Inventory Count & Stock Supply | `a3b8260b-d474-42ef-9ab2-a7794a0a27bc` | `anc-enrollment-confirmation`* | ✗ |
| 26 | Stock Level Adjustment by CHA | `cfdba05b-fb46-4673-a1bd-e300ab1afe94` | `anc-enrollment-confirmation`* | ✗ |

> \* Items 24–26 share the same `identifier.value` in the production config — likely a
> copy-paste issue in the sample. The actual keys differ in the live server config.

**Your sandbox-only questionnaires** (not in their production config):

| Title | ID | Config key |
|-------|----|------------|
| Stock Dispense | `qn-stock-mgmt-dispense` | `stock-dispense` |
| Stock Order | `qn-stock-order` | `stock-order` |
| Stock Accept | `qn-stock-accept` | `stock-accept` |
| Stock Adjustment | `qn-stock-adjust` | `stock-adjust` |

---

### StructureMaps — complete list (21 total)

All 21 StructureMaps from their production Composition. Each transforms a
QuestionnaireResponse into structured FHIR resources (Patient, CarePlan,
Observation, Condition, Encounter, etc.).

| # | Title | StructureMap ID | identifier.value |
|---|-------|----------------|-----------------|
| 1 | Children Immunization | `97cf9bfb-90be-4661-8810-1c60be88f593` | — |
| 2 | Sick Child Registration | `737a86d6-ad63-4345-8753-1e605438d1ee` | — |
| 3 | Sick Child Follow Up Visit | `737a86d6-ad63-4345-8753-1e605438d1ee` | — |
| 4 | Child Counter Referral | `528a8603-2e43-4a2e-a33d-1ec2563ffd3e` | — |
| 5 | Child Monthly Routine Visit | `0b7f0c7a-9b52-42bf-ab45-749918128a66` | `ChildRoutineCarePlan` |
| 6 | Family Registration | `5667cfbd-13c4-4111-b952-7cee58bdb9d5` | `eCBISFamilyRegistration` |
| 7 | Add Family Member Registration | `febf0030-262f-443d-95b4-e002d437cfd0` | `eCBISAddFamilyMemberRegistration` |
| 8 | New Pregnancy Registration | `ff7b22df-7645-43fe-9731-d90c3a21130b` | — |
| 9 | Pregnancy Visit | `74149320-97ce-463a-9cf3-206fad6e380f` | — |
| 10 | Pregnancy Referral | `ab62f8e8-e6d8-4ffb-b460-64b23e89b370` | — |
| 11 | Pregnancy Outcome Registration | `42d6d826-d6b2-41e9-9787-7424b4deca85` | `PNCRegistration` |
| 12 | Normal Weight PNC Routine Visit | `e71e7a6-194f-11ed-861d-0242ac120002` | `eCBISNormalWeightPNCRoutineVisit` |
| 13 | Under Weight PNC Routine Visit | `9fcb7a6a-4809-4f26-a379-c92bb783e5e0` | `eCBISUnderWeightPNCRoutineVisit` |
| 14 | PNC Referral | `2dc36363-a627-4fe6-b3c4-490f34389629` | `eCBISPNCReferral` |
| 15 | FP Registration | `650943ec-3c61-42a7-86ef-12a4c9955d5d` | `eCBISNormalWeightPNCRoutineVisit`* |
| 16 | FP Visit | `ce46c251-b44e-4cb9-89aa-213c8ea47eb2` | `eCBISUnderWeightPNCRoutineVisit`* |
| 17 | FP Referral | `6256caaa-8781-4b34-985d-b20dcb41a2b3` | `eCBISPNCReferral`* |
| 18 | Diseases Registration | `ef19b62e-6cbf-43d6-beb5-4c0d9d2c20b8` | `eCBISPNCReferral`* |
| 19 | Diseases Followup | `63752b18-9f0e-48a7-9a21-d3714be6309a` | `eCBISPNCReferral`* |
| 20 | Diseases Referral | `befbdbcf-9013-4597-8f94-1a15e9f7f549` | `eCBISDiseasesReferral` |
| 21 | Supply Chain — Physical Count & Restock | `8f7828f5-3910-4bfc-94a9-a0da749fb37c` | `eCBISSupplyChainPhysicallyCountAndRestock` |

> \* Several StructureMaps share `identifier.value` with others — likely copy-paste
> issues in the sample config; actual production identifiers will differ.

**Your sandbox has zero StructureMaps seeded.** The stock questionnaires bypass
StructureMap extraction — the mediator reads `MedicationDispense` directly instead.

---

## 3b. Binary config IDs — complete list from their Composition

These are the exact Binary resource IDs the app resolves when it downloads configs.
Your sandbox already uses **the same IDs** — copied from their `sample_composition_config.json`.

### Core configs

| Config key | Binary ID | Your sandbox file |
|------------|-----------|-------------------|
| `application` | `4755546c-e61f-43bb-b599-5cad230a3d529e` | `config/fhir/application_config.json` |
| `sync` | `a982504f-8d8b-4151-abc6-0063793500d4e` | `config/fhir/sync_config.json` |
| `navigation` | `d7ce0167-ee6a-4f8f-b644-50b0242513239e` | `config/fhir/navigation_config.json` |

### Register Binaries

| Config key | Binary ID | Your sandbox file |
|------------|-----------|-------------------|
| `householdRegister` | `7ebbbf4e-c783-42f2-998d-3c6bdde5c0c6e` | `registers/household_register_config.json` |
| `ancRegister` | `e64815e6-56c1-4200-b2a6-6ec13eedfec3e` | `registers/anc_register_config.json` |
| `childRegister` | `7a68f458-9402-4c07-be62-feb85d341c17e` | `registers/child_register_config.json` |
| `taskRegister` | `bbf28ade-5bc5-11ed-9b6a-0242ac120090e` | `registers/task_register_config.json` |
| `cmntdRegister` | `d90ae75b-b180-45c0-ab57-24dc6c885cc1e` | `registers/cmntd_register_config.json` |
| `fpRegister` | `7d0ce69f-22c2-4829-90b4-c0aadebdffbae` | `registers/fp_register_config.json` |
| `hivRegister` | `faa1688d-98fa-4954-9889-6c2bdf4d4e57e` | `registers/hiv_register_config.json` |
| `mentalHealthRegister` | `ba22490f-d24b-43d0-b6f4-f5af474bbf05e` | `registers/mental_health_register_config.json` |
| `pncRegister` | `9aa6bbb6-df76-42a4-bdbe-72dc197378cae` | `registers/pnc_register_config.json` |
| `sickChildRegister` | `079a2120-e802-4445-95ac-59511751a4c0e` | `registers/sick_child_register_config.json` |
| `tbRegister` | `2ac6ec4f-1a29-4d85-a015-06db9c1b82d9e` | `registers/tb_register_config.json` |

### Profile Binaries

| Config key | Binary ID | Your sandbox file |
|------------|-----------|-------------------|
| `householdProfile` | `bbb3c2b0-51c9-44e9-9674-7d311ad5f859e` | `profiles/household_profile_config.json` |
| `defaultProfile` | `34b709f3-e8a1-44e9-867a-714b68bb1367e` | `profiles/default_profile_config.json` |
| `otherRegistersProfile` | `a6d69650-4806-4bb1-bd2b-a60fa18418a0e` | `profiles/other_registers_profile_config.json` |

### Translation Binaries

| Config key | Binary ID | Your sandbox file |
|------------|-----------|-------------------|
| `strings` | `c6757818-25c8-4e51-ba51-0c9dd882cbbbe` | `translations/strings_config.properties` |
| `strings_sw` | `eee5f9c1-49f6-4b18-b088-8a52689a79d8e` | `translations/strings_sw_config.properties` |
| `strings_fr` | `43e6c036-bb83-481e-8ffd-f8fdb7ee54a0e` | `translations/strings_fr_config.properties` |

> Your sandbox adds 2 extra Binary sections not in their config:
> `inv-register-config-001` (inventoryRegister) and `stock-accept-reg-001`
> (stockAcceptanceRegister). These are sandbox-only stock management additions.

---

## 3c. Ready-to-use Composition to replicate their full clinical config

To load the production BKM clinical questionnaires into your sandbox HAPI FHIR,
upload Questionnaire resources with the exact IDs from section 3 above, then
push this Composition (replacing your current `app-composition`). Once their
questionnaire JSON files are obtained, seed them with:

```bash
# For each questionnaire JSON file obtained from the BKM team:
curl -X PUT http://localhost:8079/fhir/Questionnaire/<ID> \
  -H "Content-Type: application/fhir+json" \
  -d @questionnaire-<name>.json

# For each StructureMap:
curl -X PUT http://localhost:8079/fhir/StructureMap/<ID> \
  -H "Content-Type: application/fhir+json" \
  -d @structuremap-<name>.json
```

The full production Composition (verbatim from `bkm-chis/sample_composition_config.json`,
ID changed from `214560` to `app-composition` for HAPI FHIR compatibility):

```json
{
  "resourceType": "Composition",
  "id": "app-composition",
  "identifier": { "use": "official", "value": "app" },
  "status": "final",
  "type": {
    "coding": [{ "system": "http://snomed.info/sct", "code": "1156600005", "display": "Device setting parameter" }]
  },
  "date": "2022-09-16",
  "title": "Device configurations",
  "confidentiality": "L",
  "section": [
    {
      "title": "Application configuration",
      "focus": { "reference": "Binary/4755546c-e61f-43bb-b599-5cad230a3d529e", "identifier": { "value": "application" } },
      "mode": "working"
    },
    {
      "title": "Sync configuration",
      "focus": { "reference": "Binary/a982504f-8d8b-4151-abc6-0063793500d4e", "identifier": { "value": "sync" } },
      "mode": "working"
    },
    {
      "title": "Navigation configuration",
      "focus": { "reference": "Binary/d7ce0167-ee6a-4f8f-b644-50b0242513239e", "identifier": { "value": "navigation" } },
      "mode": "working"
    },
    {
      "title": "Register configurations",
      "mode": "working",
      "section": [
        { "title": "Household register configuration", "focus": { "reference": "Binary/7ebbbf4e-c783-42f2-998d-3c6bdde5c0c6e", "identifier": { "value": "householdRegister" } } },
        { "title": "ANC register configuration", "focus": { "reference": "Binary/e64815e6-56c1-4200-b2a6-6ec13eedfec3e", "identifier": { "value": "ancRegister" } } },
        { "title": "Child register configuration", "focus": { "reference": "Binary/7a68f458-9402-4c07-be62-feb85d341c17e", "identifier": { "value": "childRegister" } } },
        { "title": "Task register configuration", "focus": { "reference": "Binary/bbf28ade-5bc5-11ed-9b6a-0242ac120090e", "identifier": { "value": "taskRegister" } } },
        { "title": "CMNTD register configuration", "focus": { "reference": "Binary/d90ae75b-b180-45c0-ab57-24dc6c885cc1e", "identifier": { "value": "cmntdRegister" } } },
        { "title": "FP register configuration", "focus": { "reference": "Binary/7d0ce69f-22c2-4829-90b4-c0aadebdffbae", "identifier": { "value": "fpRegister" } } },
        { "title": "HIV register configuration", "focus": { "reference": "Binary/faa1688d-98fa-4954-9889-6c2bdf4d4e57e", "identifier": { "value": "hivRegister" } } },
        { "title": "Mental Health register configuration", "focus": { "reference": "Binary/ba22490f-d24b-43d0-b6f4-f5af474bbf05e", "identifier": { "value": "mentalHealthRegister" } } },
        { "title": "PNC register configuration", "focus": { "reference": "Binary/9aa6bbb6-df76-42a4-bdbe-72dc197378cae", "identifier": { "value": "pncRegister" } } },
        { "title": "Sick Child register configuration", "focus": { "reference": "Binary/079a2120-e802-4445-95ac-59511751a4c0e", "identifier": { "value": "sickChildRegister" } } },
        { "title": "TB register configuration", "focus": { "reference": "Binary/2ac6ec4f-1a29-4d85-a015-06db9c1b82d9e", "identifier": { "value": "tbRegister" } } }
      ]
    },
    {
      "title": "Profile configurations",
      "mode": "working",
      "section": [
        { "title": "Household profile configuration", "focus": { "reference": "Binary/bbb3c2b0-51c9-44e9-9674-7d311ad5f859e", "identifier": { "value": "householdProfile" } } },
        { "title": "Default profile configuration", "focus": { "reference": "Binary/34b709f3-e8a1-44e9-867a-714b68bb1367e", "identifier": { "value": "defaultProfile" } } },
        { "title": "Other Registers profile configuration", "focus": { "reference": "Binary/a6d69650-4806-4bb1-bd2b-a60fa18418a0e", "identifier": { "value": "otherRegistersProfile" } } }
      ]
    },
    {
      "title": "Translation configurations",
      "mode": "working",
      "section": [
        { "title": "Translation English", "focus": { "reference": "Binary/c6757818-25c8-4e51-ba51-0c9dd882cbbbe", "identifier": { "value": "strings" } } },
        { "title": "Translation Swahili", "focus": { "reference": "Binary/eee5f9c1-49f6-4b18-b088-8a52689a79d8e", "identifier": { "value": "strings_sw" } } },
        { "title": "Translation French", "focus": { "reference": "Binary/43e6c036-bb83-481e-8ffd-f8fdb7ee54a0e", "identifier": { "value": "strings_fr" } } }
      ]
    },
    {
      "title": "Questionnaires",
      "mode": "working",
      "section": [
        { "title": "Add Family", "focus": { "reference": "Questionnaire/f210a832-857f-49e6-93f5-399eec4f4edb", "identifier": { "value": "family-registration" } }, "mode": "working" },
        { "title": "Add Family Member", "focus": { "reference": "Questionnaire/e5155788-8831-4916-a3f5-486915ce34b2", "identifier": { "value": "family-member-registration" } }, "mode": "working" },
        { "title": "Add Family Member Confirmation", "focus": { "reference": "Questionnaire/f0a04fc4-4179-4df4-b2dc-8b2eac444d0b", "identifier": { "value": "family-member-registration-confirmation" } }, "mode": "working" },
        { "title": "Remove Family", "focus": { "reference": "Questionnaire/0259e181-581e-4b4c-8409-e3be3a166ef5", "identifier": { "value": "remove-family" } }, "mode": "working" },
        { "title": "Remove Family Member", "focus": { "reference": "Questionnaire/7f1960ac-81b5-42a2-8813-97222de5745a", "identifier": { "value": "remove-family-member" } }, "mode": "working" },
        { "title": "New Pregnancy Registration", "focus": { "reference": "Questionnaire/9b22f3ed-e7e1-4222-bf72-1ced42696189", "identifier": { "value": "anc-patient-registration" } }, "mode": "working" },
        { "title": "Pregnancy Visit", "focus": { "reference": "Questionnaire/f642fe17-1d75-45a2-b813-3cfb69706cb0", "identifier": { "value": "anc-visit" } }, "mode": "working" },
        { "title": "Pregnancy Outcome", "focus": { "reference": "Questionnaire/405619ff-cde8-4379-b674-0a4735098b33", "identifier": { "value": "pregnancy-outcome" } }, "mode": "working" },
        { "title": "Sick Child Under 2 Months", "focus": { "reference": "Questionnaire/58fbddae-c5a0-4b86-832e-f516c96f3b85", "identifier": { "value": "sick-child-under-2m" } }, "mode": "working" },
        { "title": "Child Immunization Completion", "focus": { "reference": "Questionnaire/9b1aa23b-577c-4fb2-84e3-591e6facaf82", "identifier": { "value": "child-immunization-completion" } }, "mode": "working" },
        { "title": "Sick Child Above 2 Months", "focus": { "reference": "Questionnaire/3276f55c-b25e-455b-ae4e-8846fb8fd039", "identifier": { "value": "sick-child-above-2m" } }, "mode": "working" },
        { "title": "Sick Child Follow Up", "focus": { "reference": "Questionnaire/1bdf21ef-d31a-446e-aaa6-cec516eceab1", "identifier": { "value": "sick-child-followup" } }, "mode": "working" },
        { "title": "Counter Referral", "focus": { "reference": "Questionnaire/c309abfa-7536-4c60-baea-cf631201f79e", "identifier": { "value": "referral" } }, "mode": "working" },
        { "title": "New FP Registration", "focus": { "reference": "Questionnaire/4acc8776-32b0-4440-a1b1-a11a12d79acb", "identifier": { "value": "family-planning" } }, "mode": "working" },
        { "title": "FP Visit", "focus": { "reference": "Questionnaire/450cb100-0c5b-47c6-9f33-2830a79be726", "identifier": { "value": "fp-visit" } }, "mode": "working" },
        { "title": "PNC Visit", "focus": { "reference": "Questionnaire/8a1f9578-5b88-45ea-8120-8f8557e01d8c", "identifier": { "value": "pnc-follow-up-visit" } }, "mode": "working" },
        { "title": "Under 1 Year Child Visit Form", "focus": { "reference": "Questionnaire/5a60a629-bcf4-4101-96ac-a5e07b35f30e", "identifier": { "value": "under-1-year-child-visit-form" } }, "mode": "working" },
        { "title": "Over 1 Year Child Visit Form", "focus": { "reference": "Questionnaire/91c51999-0e04-495a-8d70-58c3aabefcab", "identifier": { "value": "over-1-year-child-visit-form" } }, "mode": "working" },
        { "title": "Diseases Registration Form", "focus": { "reference": "Questionnaire/f7004382-ba3d-4f62-a687-6e9d18c09d3a", "identifier": { "value": "disease-registration-form" } }, "mode": "working" },
        { "title": "Diseases Followup Form", "focus": { "reference": "Questionnaire/e14b5743-0a06-4ab5-aaee-ac158d4cb64f", "identifier": { "value": "disease-followup-form" } }, "mode": "working" },
        { "title": "Household Visit Form", "focus": { "reference": "Questionnaire/5458ecb6-835a-4f11-873f-2abfdfeec93c", "identifier": { "value": "household-visit-form" } }, "mode": "working" },
        { "title": "Death Record Confirmation", "focus": { "reference": "Questionnaire/5a4f4462b-7407-4b53-a814-2618efe46c84", "identifier": { "value": "death-record-confirmation" } }, "mode": "working" },
        { "title": "New FP Enrollment Confirmation", "focus": { "reference": "Questionnaire/8bb7a98f-8f73-40f2-b484-ecace14be187", "identifier": { "value": "fp-enrollment-confirmation" } }, "mode": "working" },
        { "title": "New ANC Enrollment Confirmation", "focus": { "reference": "Questionnaire/d2e39622-82fe-4263-b823-bb50a5370d33", "identifier": { "value": "anc-enrollment-confirmation" } }, "mode": "working" },
        { "title": "Physical Inventory Count & Stock Supply", "focus": { "reference": "Questionnaire/a3b8260b-d474-42ef-9ab2-a7794a0a27bc", "identifier": { "value": "physical-inventory-count" } }, "mode": "working" },
        { "title": "Stock Level Adjustment by CHA", "focus": { "reference": "Questionnaire/cfdba05b-fb46-4673-a1bd-e300ab1afe94", "identifier": { "value": "stock-level-adjustment" } }, "mode": "working" }
      ]
    },
    {
      "title": "StructureMaps",
      "mode": "working",
      "section": [
        { "title": "Children Immunization", "focus": { "reference": "StructureMap/97cf9bfb-90be-4661-8810-1c60be88f593" }, "mode": "working" },
        { "title": "Sick Child Registration", "focus": { "reference": "StructureMap/737a86d6-ad63-4345-8753-1e605438d1ee" }, "mode": "working" },
        { "title": "Sick Child Follow Up Visit", "focus": { "reference": "StructureMap/737a86d6-ad63-4345-8753-1e605438d1ee" }, "mode": "working" },
        { "title": "Child Counter Referral", "focus": { "reference": "StructureMap/528a8603-2e43-4a2e-a33d-1ec2563ffd3e" }, "mode": "working" },
        { "title": "Child Monthly Routine Visit", "focus": { "reference": "StructureMap/0b7f0c7a-9b52-42bf-ab45-749918128a66", "identifier": { "value": "ChildRoutineCarePlan" } }, "mode": "working" },
        { "title": "Family Registration", "focus": { "reference": "StructureMap/5667cfbd-13c4-4111-b952-7cee58bdb9d5", "identifier": { "value": "eCBISFamilyRegistration" } }, "mode": "working" },
        { "title": "Add Family Member Registration", "focus": { "reference": "StructureMap/febf0030-262f-443d-95b4-e002d437cfd0", "identifier": { "value": "eCBISAddFamilyMemberRegistration" } }, "mode": "working" },
        { "title": "New Pregnancy Registration", "focus": { "reference": "StructureMap/ff7b22df-7645-43fe-9731-d90c3a21130b" }, "mode": "working" },
        { "title": "Pregnancy Visit", "focus": { "reference": "StructureMap/74149320-97ce-463a-9cf3-206fad6e380f" }, "mode": "working" },
        { "title": "Pregnancy Referral", "focus": { "reference": "StructureMap/ab62f8e8-e6d8-4ffb-b460-64b23e89b370" }, "mode": "working" },
        { "title": "Pregnancy Outcome Registration", "focus": { "reference": "StructureMap/42d6d826-d6b2-41e9-9787-7424b4deca85", "identifier": { "value": "PNCRegistration" } }, "mode": "working" },
        { "title": "Normal Weight PNC Routine Visit", "focus": { "reference": "StructureMap/e71e7a6-194f-11ed-861d-0242ac120002", "identifier": { "value": "eCBISNormalWeightPNCRoutineVisit" } }, "mode": "working" },
        { "title": "Under Weight PNC Routine Visit", "focus": { "reference": "StructureMap/9fcb7a6a-4809-4f26-a379-c92bb783e5e0", "identifier": { "value": "eCBISUnderWeightPNCRoutineVisit" } }, "mode": "working" },
        { "title": "PNC Referral", "focus": { "reference": "StructureMap/2dc36363-a627-4fe6-b3c4-490f34389629", "identifier": { "value": "eCBISPNCReferral" } }, "mode": "working" },
        { "title": "FP Registration", "focus": { "reference": "StructureMap/650943ec-3c61-42a7-86ef-12a4c9955d5d", "identifier": { "value": "eCBISFPRegistration" } }, "mode": "working" },
        { "title": "FP Visit", "focus": { "reference": "StructureMap/ce46c251-b44e-4cb9-89aa-213c8ea47eb2", "identifier": { "value": "eCBISFPVisit" } }, "mode": "working" },
        { "title": "FP Referral", "focus": { "reference": "StructureMap/6256caaa-8781-4b34-985d-b20dcb41a2b3", "identifier": { "value": "eCBISFPReferral" } }, "mode": "working" },
        { "title": "Diseases Registration", "focus": { "reference": "StructureMap/ef19b62e-6cbf-43d6-beb5-4c0d9d2c20b8", "identifier": { "value": "eCBISDiseasesRegistration" } }, "mode": "working" },
        { "title": "Diseases Followup", "focus": { "reference": "StructureMap/63752b18-9f0e-48a7-9a21-d3714be6309a", "identifier": { "value": "eCBISDiseasesFollowup" } }, "mode": "working" },
        { "title": "Diseases Referral", "focus": { "reference": "StructureMap/befbdbcf-9013-4597-8f94-1a15e9f7f549", "identifier": { "value": "eCBISDiseasesReferral" } }, "mode": "working" },
        { "title": "Supply Chain — Physical Count & Restock", "focus": { "reference": "StructureMap/8f7828f5-3910-4bfc-94a9-a0da749fb37c", "identifier": { "value": "eCBISSupplyChainPhysicallyCountAndRestock" } }, "mode": "working" }
      ]
    }
  ]
}
```

---

## 4. Summary

**What chis-organization actually changed in the Android app:** almost nothing.
Their 8 commits amount to a new flavor name, two PNG logo files, and the
`SKIP_AUTHENTICATION` bypass — all of which your local clone already has.

**Where the real BKM customisation lives:** in the FHIR server content
(Composition → 26 Questionnaires + 21 StructureMaps + PlanDefinitions).
This is private configuration, not in any public GitHub repo.

**What your sandbox has that they don't:** the stock management workflow
(inventory register, stock acceptance register, stock dispense/order/accept
questionnaires, mediator fan-out to OpenLMIS and DHIS2). This is entirely
sandbox-specific and not part of the standard BKM clinical config.

**What your sandbox is missing from their production setup:** the 26 clinical
questionnaires and 21 StructureMaps that drive the actual VHW data collection
(ANC, PNC, child health, family planning, HIV, TB, mental health).
