# Superset analytics

Apache Superset runs as part of the sandbox stack and reports directly on three
databases: the HAPI FHIR store, OpenLMIS and DHIS2. There is no ETL job and no
warehouse. Each source gets its own `analytics` schema of SQL views, and Superset
reads those views through a read-only role.

- URL: http://localhost:8089
- Login: admin / admin (override with SUPERSET_ADMIN_PASSWORD before first start)
- Metadata database: `superset` on health-db-postgres

| Connection | Database | Host | Views |
|---|---|---|---|
| FHIR (hapi_fhir) | hapi_fhir | db-postgres | 47 |
| OpenLMIS (open_lmis) | open_lmis | db (openlmis-ref-distro) | 44 |
| DHIS2 (dhis2) | dhis2 | db-postgres | 25 |

All three use the read-only login `superset_ro` / `superset_ro`.

OpenLMIS and DHIS2 both expose REST APIs, and the mediator uses them. Superset
only speaks SQL, so the dashboards read the databases directly. The OpenLMIS
database lives in its own container on the `openlmis-ref-distro_default` network,
which is why the Superset service joins `lmis-net` as well as `health-net`.

## Bringing it up

```
make superset
```

That target is idempotent and does three things:

1. `superset-up` - builds and starts the container, then waits for `/health`.
   The image is `apache/superset:4.1.1` plus `psycopg2-binary`, because the
   upstream image ships without a Postgres driver and cannot reach its own
   metadata database without it.
2. `superset-views` - applies all three view layers. Run them individually with
   `superset-views-fhir`, `superset-views-lmis` or `superset-views-dhis2`.
3. `superset-dashboards` - runs `scripts/seed_superset.py` inside the container
   to create the database connection, datasets, charts and dashboards.

Re-run `make superset-views` after changing a view, and `make superset-dashboards`
after changing a chart definition. Charts are matched by name, so existing chart
and dashboard URLs survive a re-run.

## The view layer

Every `*_analytics.sql` script builds its `analytics` schema from scratch on each
run (it drops and recreates), so all of them are safe to re-apply at any time.
The OpenLMIS script only ever creates its own schema and never touches a Flyway
schema, so it does not put OpenLMIS reference data at risk.

### FHIR (hapi_fhir)

HAPI v7 stores each resource body inline as plain JSON in
`hfj_res_ver.res_text_vc`, so this layer is SQL that parses that column as
`jsonb`.

Base views:

- `fhir_resource` - current version of every live resource, body as `jsonb`
- `fhir_resource_history` - every version ever written, classified as create,
  update or delete. This is the only place a time series survives for resources
  that are upserted in place.
- `fhir_tag` - `meta.tag` values, which the mediator uses to tag by facility

Dimensions: `dim_patient`, `dim_practitioner`, `dim_organization`, `dim_location`,
`dim_medicine` (commodity Groups with `type=device`), `dim_household` (person
Groups), `dim_practitioner_role`, `dim_care_team_member`, plus the
`bridge_household_member` membership bridge.

Facts: `fact_stock_on_hand`, `fact_dispense`, `fact_supply_delivery`, `fact_task`,
`fact_questionnaire_response`, `fact_questionnaire_answer`, `fact_measure_report`.

`scripts/sql/fhir_reports.sql` then builds the `rpt_*` views that the Superset
datasets point at. Each one is already shaped for its charts, so no chart needs
custom SQL.

### OpenLMIS (open_lmis)

Two modelling quirks drive the joins. Orderables and facility type approved
products are versioned on `(id, versionnumber)`, so every join picks the latest
version. Stock on hand is not a column on the stock card: it is a row per
(stock card, occurred date) in `stockmanagement.calculated_stocks_on_hand`, so
"current" means the newest row for that card, and the same table gives the
balance history for free.

### DHIS2 (dhis2)

The views read the raw aggregate tables (`datavalue` and its metadata), not the
generated `analytics_*` tables. Those only exist after an analytics run and DHIS2
drops and rebuilds them on the next run, so reading the raw tables keeps the
dashboards live rather than as-of the last export.

## Dashboards

10 dashboards, 127 charts.

| Dashboard | Source | Covers |
|---|---|---|
| Vital-Link Overview | FHIR | headline counts, resource mix, write activity per day |
| Stock and Supply | FHIR | stock on hand by medicine and facility, alerts, balance history |
| Service Delivery | FHIR | dispensing by day, worker, village and medicine; tasks; forms |
| People and Workforce | FHIR | demographics, village coverage, caseload and roster |
| Data Quality and Platform | FHIR | completeness checks, broken references, write activity |
| OpenLMIS Stock Control | OpenLMIS | stock by facility, product and lot; alerts; expiry risk |
| OpenLMIS Supply Chain | OpenLMIS | movements by reason; requisition, order and shipment pipelines |
| OpenLMIS Network and Catalogue | OpenLMIS | facility register, programme coverage, product catalogue |
| DHIS2 Reported Data | DHIS2 | data values by element, org unit and period; capture activity |
| DHIS2 Metadata and Coverage | DHIS2 | metadata inventory, org unit hierarchy, reporting gaps |

Each source has its own `rpt_data_quality` view: a union of named checks
(16 for FHIR, 16 for OpenLMIS, 12 for DHIS2) covering missing fields, orphaned
records, expired lots still holding stock, org units that have never reported
and so on. FHIR adds `rpt_broken_references`, which walks the common reference
paths and reports any that do not resolve to a live resource.

Chart names for the OpenLMIS and DHIS2 sources are prefixed (`OpenLMIS: ...`,
`DHIS2: ...`). Superset matches charts by name on re-provisioning, and several
view names are shared across sources, so without the prefix one source would
overwrite another's charts.

## Stock history

The stock ledger Observation is upserted in place by the mediator
(`mediator/src/sync/fhirLedger.js`), so the current row only ever holds the
latest balance. `rpt_stock_trend` reads `hfj_res_ver` directly to recover the
full balance time series from the version history.

## Notes and gotchas

- Superset authenticates the provisioning script with a form login, not the
  `/api/v1/security/login` JWT. The JWT authorises writes, but Superset's
  row-level filters resolve a bearer identity as anonymous, so every list
  endpoint returns zero rows and the script would duplicate objects it cannot
  see.
- Every chart is saved with an explicit `query_context`. Without it Superset
  renders the chart in a dashboard but fails the data API with "Chart has no
  query context saved", which breaks CSV export and thumbnails.
- The container is named `bkm-superset`, not `superset`, so it does not collide
  with an unrelated Superset container on the same host.
- `TALISMAN_ENABLED` is off so the sandbox works over plain HTTP. Turn it back
  on for any internet-facing deployment.
- Datasets are matched on (database, table name), not table name alone: all
  three sources have a view called `rpt_kpi_overview`.
- The stock and dispensing views are empty until that activity exists in FHIR.
  If they stay empty while the sandbox is in use, check that
  `mediator/mappings.json` matches the seeded profile: a Mafeteng mappings file
  against an ATP-seeded OpenLMIS makes every SOH fetch fail with 403 and no
  ledger Observation is ever written.
