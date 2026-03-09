# DHIS2 Visualizations & Dashboard

How to create and manage DHIS2 visualizations and dashboards via the REST API in this sandbox.

---

## Key Rules

- **UIDs must be exactly 11 characters**: `[A-Za-z][A-Za-z0-9]{10}`. DHIS2 rejects shorter or longer UIDs silently.
- **Never use `POST /api/metadata` for visualizations**: It strips all dimension data (`columns`/`rows`/`filters`) — the viz is created but shows "At least one dimension must be specified" in the UI.
- **Dashboards and data elements** can safely use the metadata endpoint.
- **Analytics tables must be regenerated** after writing data values before charts show data.

---

## Seeded Objects

| Object | UID | Description |
|--------|-----|-------------|
| Org Unit | `dwx1Yz4BwNX` | Maseru District Clinic A |
| Data Element | `ujPSJuS9pph` | Stock Dispensed — AL 20/120mg |
| Data Element | `StckRcvdAL1` | Stock Received — AL 20/120mg |
| Data Element | `StockOnHnd1` | Stock on Hand — AL 20/120mg (`aggregationType=LAST`) |
| Visualization | `BKMBarChrt1` | Dispensing bar chart (last 12 months) |
| Visualization | `BKMSohLine1` | Stock on Hand line chart (last 12 months) |
| Visualization | `BKMPivotTb1` | Monthly dispensing pivot table |
| Dashboard | `BKMDashbrd1` | BKM Stock Dispensing — Lesotho |

Dashboard URL: http://localhost:8081/dhis-web-dashboard/index.html#/BKMDashbrd1

---

## Create a Visualization

Use `POST /api/visualizations`. To make this idempotent, delete first if it already exists.

```bash
# Delete existing (safe to run even if it doesn't exist)
curl -s -u admin:district -X DELETE \
  "http://localhost:8081/api/visualizations/BKMBarChrt1"

# Create bar chart — dispensing over last 12 months
curl -u admin:district -X POST "http://localhost:8081/api/visualizations" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "BKMBarChrt1",
    "name": "AL 20/120mg Dispensing - Bar Chart",
    "type": "COLUMN",
    "columns": [{"dimension": "dx", "items": [{"id": "ujPSJuS9pph"}]}],
    "rows":    [{"dimension": "pe", "items": [{"id": "LAST_12_MONTHS"}]}],
    "filters": [{"dimension": "ou", "items": [{"id": "dwx1Yz4BwNX"}]}],
    "aggregationType": "SUM",
    "domainAxisLabel": "Month",
    "rangeAxisLabel": "Tablets Dispensed"
  }'
```

```bash
# Create SOH line chart — stock on hand over last 12 months
curl -s -u admin:district -X DELETE \
  "http://localhost:8081/api/visualizations/BKMSohLine1"

curl -u admin:district -X POST "http://localhost:8081/api/visualizations" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "BKMSohLine1",
    "name": "AL 20/120mg Stock on Hand - Line Chart",
    "type": "LINE",
    "columns": [{"dimension": "dx", "items": [{"id": "StockOnHnd1"}]}],
    "rows":    [{"dimension": "pe", "items": [{"id": "LAST_12_MONTHS"}]}],
    "filters": [{"dimension": "ou", "items": [{"id": "dwx1Yz4BwNX"}]}],
    "aggregationType": "LAST",
    "domainAxisLabel": "Month",
    "rangeAxisLabel": "Tablets on Hand"
  }'
```

```bash
# Create pivot table — dispensing by facility x month
curl -s -u admin:district -X DELETE \
  "http://localhost:8081/api/visualizations/BKMPivotTb1"

curl -u admin:district -X POST "http://localhost:8081/api/visualizations" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "BKMPivotTb1",
    "name": "AL 20/120mg Dispensing - Monthly Pivot",
    "type": "PIVOT_TABLE",
    "columns": [{"dimension": "pe", "items": [{"id": "LAST_12_MONTHS"}]}],
    "rows":    [{"dimension": "ou", "items": [{"id": "dwx1Yz4BwNX"}]}],
    "filters": [{"dimension": "dx", "items": [{"id": "ujPSJuS9pph"}]}],
    "aggregationType": "SUM",
    "showData": true
  }'
```

### Check the response

A successful create returns `"status": "OK"` with the assigned UID:

```json
{"status": "OK", "response": {"uid": "BKMBarChrt1", ...}}
```

---

## Create or Update the Dashboard

The metadata endpoint also silently drops `dashboardItems`. Use DELETE + POST to create the shell, then PUT to set the items:

```bash
# 1. Delete if exists, then create empty shell
curl -s -u admin:district -X DELETE "http://localhost:8081/api/dashboards/BKMDashbrd1"
curl -u admin:district -X POST "http://localhost:8081/api/dashboards" \
  -H "Content-Type: application/json" \
  -d '{"id": "BKMDashbrd1", "name": "BKM Stock Dispensing - Lesotho"}'

# 2. PUT the full object with items — this is what actually sets dashboardItems
curl -u admin:district -X PUT "http://localhost:8081/api/dashboards/BKMDashbrd1" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "BKMDashbrd1",
    "name": "BKM Stock Dispensing - Lesotho",
    "dashboardItems": [
      {"type": "VISUALIZATION", "visualization": {"id": "BKMBarChrt1"}},
      {"type": "VISUALIZATION", "visualization": {"id": "BKMSohLine1"}},
      {"type": "VISUALIZATION", "visualization": {"id": "BKMPivotTb1"}}
    ]
  }'
```

Verify items were saved:

```bash
curl -s -u admin:district "http://localhost:8081/api/dashboards/BKMDashbrd1" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);[print(i['type'],i.get('visualization',{}).get('id')) for i in d.get('dashboardItems',[])]"
```

---

## Verify a Visualization Has Dimensions

If a visualization was accidentally created via the metadata endpoint it will have empty dimensions. Check with:

```bash
curl -s -u admin:district \
  "http://localhost:8081/api/visualizations/BKMBarChrt1?fields=id,columns,rows,filters" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('cols:',len(d['columns']),'rows:',len(d['rows']),'filters:',len(d['filters']))"
# Expected: cols: 1 rows: 1 filters: 1
# If all zeros: delete and recreate via POST /api/visualizations
```

---

## Write a Data Value

The mediator posts data values automatically after each stock event. To write one manually:

```bash
# Stock dispensed — current month
curl -u admin:district -X POST "http://localhost:8081/api/dataValueSets" \
  -H "Content-Type: application/json" \
  -d '{
    "dataValues": [{
      "dataElement": "ujPSJuS9pph",
      "orgUnit": "dwx1Yz4BwNX",
      "period": "202603",
      "value": "42"
    }]
  }'

# Stock on hand — current month (aggregationType=LAST, so later writes win)
curl -u admin:district -X POST "http://localhost:8081/api/dataValueSets" \
  -H "Content-Type: application/json" \
  -d '{
    "dataValues": [{
      "dataElement": "StockOnHnd1",
      "orgUnit": "dwx1Yz4BwNX",
      "period": "202603",
      "value": "9958"
    }]
  }'
```

Period format: `YYYYMM` for monthly data.

---

## Regenerate Analytics Tables

Charts only reflect data values after analytics tables are rebuilt. This runs automatically at the end of `make seed`, but run it manually after writing data values outside the normal flow:

```bash
# Trigger rebuild
JOB_ID=$(curl -s -u admin:district -X POST \
  "http://localhost:8081/api/resourceTables/analytics" \
  -H "Content-Type: application/json" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('response',{}).get('id',''))")
echo "Job: $JOB_ID"

# Poll until done (usually 5–15 seconds)
curl -s -u admin:district \
  "http://localhost:8081/api/system/tasks/ANALYTICS_TABLE" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
tasks=list(d.values())[0] if isinstance(d,dict) else d
done=[t for t in tasks if isinstance(t,dict) and t.get('completed')]
print(done[-1].get('message','still running') if done else 'still running')
"
```

---

## Add a New Data Element and Visualization

Example: add a "Patients Served" metric.

```bash
# 1. Seed the data element (use metadata endpoint — safe for data elements)
curl -u admin:district -X POST \
  "http://localhost:8081/api/metadata?importStrategy=CREATE_AND_UPDATE" \
  -H "Content-Type: application/json" \
  -d '{
    "dataElements": [{
      "id": "PatientsServ1",
      "name": "Patients Served - AL 20/120mg",
      "shortName": "Patients Served",
      "aggregationType": "SUM",
      "domainType": "AGGREGATE",
      "valueType": "INTEGER_ZERO_OR_POSITIVE"
    }]
  }'

# 2. Create the visualization (must use /api/visualizations directly)
curl -u admin:district -X POST "http://localhost:8081/api/visualizations" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "BKMPatients1",
    "name": "Patients Served - Bar Chart",
    "type": "COLUMN",
    "columns": [{"dimension": "dx", "items": [{"id": "PatientsServ1"}]}],
    "rows":    [{"dimension": "pe", "items": [{"id": "LAST_12_MONTHS"}]}],
    "filters": [{"dimension": "ou", "items": [{"id": "dwx1Yz4BwNX"}]}],
    "aggregationType": "SUM"
  }'

# 3. Add to dashboard (replace dashboardItems with the full updated list)
# 4. Write data values via POST /api/dataValueSets
# 5. Regenerate analytics tables
```

> Also add the data element UID and its env var to `docker-compose.yml` and wire it into `mediator/index.js` so the mediator posts values automatically.
