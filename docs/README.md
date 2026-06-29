# Docs

Reference documentation for the Lesotho Health System Sandbox.

| Document | Description |
|---|---|
| [RELEASE-NOTES.md](RELEASE-NOTES.md) | Release notes per version - what changed in the web portal, Android app, and stock/data |
| [training-manual.md](training-manual.md) | Start here - end-to-end guide covering all services, core workflows, testing, and troubleshooting |
| [architecture.md](architecture.md) | System overview - services, data flow, port layout, and integration points |
| [vhw-fhir-data-model.md](vhw-fhir-data-model.md) | FHIR resource model for VHW registration (Patient, Group, RelatedPerson, CareTeam) |
| [openlmis-stock-management.md](openlmis-stock-management.md) | How to view, create, and verify stock cards in OpenLMIS |
| [openlmis-api-compat.md](openlmis-api-compat.md) | 2018 backend vs 2025 reference-ui SPA - missing endpoints, wrong response formats, wrong param names, and how all fixes are applied via nginx |
| [fhir-binary-upload.md](fhir-binary-upload.md) | How to upload Binary config resources to HAPI FHIR (used by the OpenSRP Android app) |
| [dhis2-visualizations.md](dhis2-visualizations.md) | How to create DHIS2 visualizations and dashboards via curl - UIDs, gotchas, analytics regeneration |
| [srs-coverage.md](srs-coverage.md) | SRS coverage table - all 52 URs, NFRs, and BRs mapped to sandbox status with Must/Should priority |
| [aggregation.md](aggregation.md) | SOH sync + scheduled facility aggregation - per-medicine DE routing, DHIS2 analytics architecture (transactional vs analytics tables), dashboard reports, env vars, and gaps |
| [fhir-tasks.md](fhir-tasks.md) | FHIR Task lifecycle - creation, sync, stock acceptance workflow, and Task status values with code references |
| [notifications.md](notifications.md) | Notification system - OpenLMIS in-app bell integration, VHW SMS/push/email via notification-sink, MailHog email preview, event triggers (dispense/low-stock/dispatch), config env vars, API reference, troubleshooting |
| [monitoring.md](monitoring.md) | Prometheus + Grafana + Loki stack - all 6 dashboards (mediator, OpenLMIS, FHIR, OpenHIM, Keycloak, DHIS2, infrastructure), datasource setup, Loki/PromQL cheat sheet, troubleshooting |
| [two-stage-dispense.md](two-stage-dispense.md) | Planned - two-stage stock flow: facility worker pre-dispenses to VHW, VHW accepts on Android, VHW dispenses to patient. Tracks per-VHW on-hand balance. Full FHIR resource model, Postgres schema, and implementation steps |
| [per-vhw-stock-allocation.md](per-vhw-stock-allocation.md) | Planned (superseded by two-stage) - simpler budget-based allocation model. Retained as reference; two-stage-dispense.md is the preferred approach |
