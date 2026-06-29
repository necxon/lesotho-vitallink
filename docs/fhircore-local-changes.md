# fhircore Local Sandbox Modifications

## Source Repos

| Repo | URL | Role |
|------|-----|------|
| **Your local clone** | `C:\Users\Neels.Lotter\fhircore` | What you build and install |
| **Upstream (base)** | `https://github.com/opensrp/fhircore.git` | Where your clone comes from |
| **BKM production (reference only)** | `https://github.com/chis-organization/bkm-chis` | Archived Feb 2025 — older fork, not your base |

Your local clone is based on the **upstream opensrp/fhircore**, not on bkm-chis. The
two share the same codebase ancestry but have diverged — bkm-chis was frozen in 2023
while opensrp/fhircore has continued receiving updates.

- **Base commit:** `387787d67` — "Add Arabic translation for multi-select modal save button (#3800)"
- **Flavor used:** `opensrp` — `applicationId = org.smartregister.opensrp`, app label = "BKM"

---

## Changes Made for the Sandbox

### 1. `android/local.properties` — sandbox endpoints (git-ignored, never committed)

Must be created manually on any new machine. Wires the app to the local Docker stack.

```properties
sdk.dir=C\:\\Users\\Neels.Lotter\\AppData\\Local\\Android\\Sdk

SKIP_AUTHENTICATION=true
URL=http://10.0.2.2:5001/fhir/
FHIR_BASE_URL=http://10.0.2.2:8088/fhir/
OAUTH_BASE_URL=http://10.0.2.2:8083/realms/opensrp/
OAUTH_CLIENT_ID=opensrp-client
OAUTH_SCOPE=openid
OPENSRP_APP_ID="app"

MAPBOX_SDK_TOKEN=
SENTRY_DSN=
```

| Property | Value | Explanation |
|----------|-------|-------------|
| `FHIR_BASE_URL` | `:8088/fhir/` | `fhir-proxy` nginx → `hapi-fhir:8080`. `10.0.2.2` is the Android emulator's alias for the host machine's `localhost`. |
| `OAUTH_BASE_URL` | `:8083/realms/opensrp/` | Keycloak `opensrp` realm. |
| `OAUTH_CLIENT_ID` | `opensrp-client` | Matches the public client in `config/keycloak/opensrp-realm.json`. |
| `OPENSRP_APP_ID` | `"app"` | App fetches `ImplementationGuide?name=app` from HAPI FHIR — matches `ig-lesotho-vhw` seeded by `seed.sh` (`"name": "app"`). |
| `SKIP_AUTHENTICATION` | `true` | Bypasses the Keycloak OAuth flow entirely. Safe for sandbox testing; set to `false` for production. |
| `URL` | `:5001/fhir/` | OpenHIM HTTP channel — stock resources (MedicationDispense, SupplyDelivery) route here so the mediator can fan out to OpenLMIS and DHIS2. |

---

### 2. `android/quest/src/main/res/xml/network_security_config.xml` — new file

Android 9+ blocks cleartext HTTP by default. This permits it only for `10.0.2.2`.

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
</network-security-config>
```

---

### 3. `android/quest/src/main/AndroidManifest.xml`

```diff
  android:usesCleartextTraffic="false"
+ android:networkSecurityConfig="@xml/network_security_config"
```

Activates the network security config above.

---

### 4 & 5. `AppMainViewModel.kt` and `RegisterViewModel.kt` — lazy → computed property

```diff
- val navigationConfiguration: NavigationConfiguration by lazy {
-   configurationRegistry.retrieveConfiguration(ConfigType.Navigation)
- }
+ val navigationConfiguration: NavigationConfiguration
+   get() = configurationRegistry.retrieveConfiguration(ConfigType.Navigation)
```

Same change in `RegisterViewModel` for `applicationConfiguration`.

**Why:** `lazy` computes once and caches. After re-running `seed.sh` to update a
Binary config in HAPI FHIR, the app would still show the old cached value until fully
killed and restarted. The `get()` form re-fetches on every access, reflecting updated
configs immediately.

---

### 6. `android/quest/build.gradle.kts`

```diff
- id("dagger.hilt.android.plugin")
```

Removed to resolve a build conflict with this version of the upstream source. Hilt
dependency injection still works — only the plugin declaration was causing the failure.

---

### 7. `android/build.gradle.kts`

```diff
+ maven(url = "https://nexus.smartregister.org/repository/maven-snapshots")
+ maven(url = "https://nexus.smartregister.org/repository/maven-releases")
+ maven(url = "https://jitpack.io")
```

`org.smartregister:*` snapshot artifacts are published to the SmartRegister Nexus, not
Maven Central. Without these the build fails to resolve `data-capture`, `fhir-engine`,
etc.

---

### 8. `android/gradle.properties`

```diff
+ org.gradle.java.home=C\:\\Users\\Neels.Lotter\\jdk17\\jdk-17.0.13+11
```

Pins Gradle to the local JDK 17 install when `JAVA_HOME` is not set system-wide.

---

### 9. `android/gradle/libs.versions.toml`

```diff
- fhir-sdk-data-capture = "1.3.0-preview-SNAPSHOT"
+ fhir-sdk-data-capture = "1.3.0-preview1-SNAPSHOT"

- kujaku-library = "0.10.8-SNAPSHOT"
+ kujaku-library = "0.9.0"
```

- **data-capture:** `preview-SNAPSHOT` is a moving unstable tag; `preview1-SNAPSHOT`
  resolves consistently from Nexus.
- **kujaku-library:** The `0.10.8-SNAPSHOT` map widget was broken; downgraded to the
  last stable `0.9.0` release (geospatial features are not used in the BKM sandbox
  flow).

---

### 10. `android/quest/src/main/res/layout/questionnaire_activity.xml`

```diff
 <layout>
+    <data>
+    </data>
```

Empty `<data>` block required by the Android Data Binding compiler in this version —
without it the codegen step fails with a missing binding class error.

---

## Data Flow (with these changes applied)

```
Android Emulator  (opensrp flavor, appId = org.smartregister.opensrp)
│
├── App config bootstrap
│   GET :8088/fhir/ImplementationGuide?name=app
│   → fhir-proxy (nginx)  →  hapi-fhir (:8079)
│   → Composition/app-composition  →  23 Binary resources
│     (registers, profiles, translations, navigation, sync)
│
├── Clinical FHIR sync  (Patient, Encounter, Observation, CarePlan …)
│   POST/GET :8088/fhir/*
│   → fhir-proxy  →  hapi-fhir
│
├── Stock dispense / supply delivery
│   POST :5001/fhir/MedicationDispense  (URL property)
│   → OpenHIM channel  →  bkm-mediator
│   → OpenLMIS (DEBIT stock event)
│   → DHIS2 (data value + SOH update)
│
└── OAuth login  (skipped — SKIP_AUTHENTICATION=true)
    would hit :8083/realms/opensrp/  →  Keycloak, client: opensrp-client
```

---

## Building the APK

From `C:\Users\Neels.Lotter\fhircore\android`:

```bash
# Debug (reads local.properties automatically)
./gradlew assembleOpensrpDebug

# Install directly to running emulator
./gradlew installOpensrpDebug
```

For a release build: populate `keystore.properties` with signing credentials and set
`SKIP_AUTHENTICATION=false` with a valid Keycloak client configuration.
