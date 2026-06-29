# Sending Binary Data to HAPI FHIR

The OpenSRP FHIR Core Android app downloads its configuration files (navigation, registers,
profiles, translations) as `Binary` resources from HAPI FHIR. Each file is base64-encoded
and stored in `Binary.data`.

## How it works

```
ImplementationGuide → Composition (sections) → Binary (base64-encoded JSON/properties)
```

The app's `ConfigurationRegistry` follows this chain at startup:
1. Fetches the `ImplementationGuide` (by identifier `ig-lesotho-vhw`)
2. Reads `definition.resource[0].reference` → `Composition/app-composition`
3. Iterates the Composition `section[]`; each section has a `focus.reference` → `Binary/<id>`
4. Decodes `Binary.data` (base64) and parses the JSON config

## FHIR resource structure

```json
{
  "resourceType": "Binary",
  "id": "<uuid>",
  "contentType": "application/json",
  "data": "<base64-encoded file contents>"
}
```

For `.properties` translation files use `"contentType": "text/x-java-properties"`.

## Uploading from seed.sh (Python inside heredoc)

This is the pattern used in `scripts/seed.sh`:

```python
import base64, json, urllib.request

HAPI = "http://localhost:8079/fhir"

def upload_binary(binary_id, file_path, content_type="application/json"):
    with open(file_path, "rb") as f:
        data = base64.b64encode(f.read()).decode()

    body = json.dumps({
        "resourceType": "Binary",
        "id":           binary_id,
        "contentType":  content_type,
        "data":         data,
    }).encode()

    req = urllib.request.Request(
        f"{HAPI}/Binary/{binary_id}",
        data=body, method="PUT",
        headers={"Content-Type": "application/fhir+json"}
    )
    with urllib.request.urlopen(req) as r:
        print(r.status)   # 200 = updated, 201 = created

upload_binary(
    "bbb3c2b0-51c9-44e9-9674-7d311ad5f859e",
    "config/fhir/profiles/household_profile_config.json"
)
```

`urllib.request` is used instead of `curl` because the base64 payload can exceed the
shell argument-list limit (`E2BIG`) for large config files.

## Uploading with an auth token

HAPI FHIR in this stack is configured to require a Keycloak bearer token.
Obtain one with the `opensrp-web` client (public, no secret needed):

```bash
TOKEN=$(curl -s -X POST \
  http://localhost:8083/realms/opensrp/protocol/openid-connect/token \
  -d "grant_type=password&client_id=opensrp-web&username=opensrp-admin&password=admin" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

Then pass it in Python:

```python
import base64, json, os, urllib.request

HAPI  = "http://localhost:8079/fhir"
TOKEN = os.environ["TOKEN"]

def upload_binary(binary_id, file_path, content_type="application/json"):
    with open(file_path, "rb") as f:
        data = base64.b64encode(f.read()).decode()

    body = json.dumps({
        "resourceType": "Binary",
        "id":           binary_id,
        "contentType":  content_type,
        "data":         data,
    }).encode()

    req = urllib.request.Request(
        f"{HAPI}/Binary/{binary_id}",
        data=body, method="PUT",
        headers={
            "Content-Type":  "application/fhir+json",
            "Authorization": f"Bearer {TOKEN}",
        }
    )
    with urllib.request.urlopen(req) as r:
        print(r.status)
```

## Why not curl?

The base64-encoded content of a typical config file (10–25 KB JSON) expands to ~33 KB.
Passing that as a `-d` argument to `curl` in Git Bash on Windows hits the OS argument-list
limit and fails with exit code 26 or `E2BIG`. Using `--data-binary @file` requires writing
the full FHIR envelope to a temp file first. The Python `urllib.request` approach avoids
both issues and has no external dependencies.

## After uploading — trigger an app sync

After updating a Binary, the app must re-download it. Either:

```bash
# Trigger an immediate sync (fires WorkManager job)
adb shell am broadcast -a org.smartregister.fhircore.engine.sync.SyncBroadcastReceiver

# Or clear app data to force a full config re-download on next launch
adb shell pm clear org.smartregister.opensrp
```

## Binary ID → config file mapping

| Binary ID | Config file |
|---|---|
| `4755546c-e61f-43bb-b599-5cad230a3d529e` | `application_config.json` |
| `a982504f-8d8b-4151-abc6-0063793500d4e` | `sync_config.json` |
| `d7ce0167-ee6a-4f8f-b644-50b0242513239e` | `navigation_config.json` |
| `7ebbbf4e-c783-42f2-998d-3c6bdde5c0c6e` | `registers/household_register_config.json` |
| `bbb3c2b0-51c9-44e9-9674-7d311ad5f859e` | `profiles/household_profile_config.json` |
| `34b709f3-e8a1-44e9-867a-714b68bb1367e` | `profiles/default_profile_config.json` |
| `c6757818-25c8-4e51-ba51-0c9dd882cbbbe` | `translations/strings_config.properties` |

See `scripts/seed.sh` (step 9, `upload_binary` loop) for the full list.
