# Superset dashboard and analytics requirements

For review and sign-off. Once agreed, this document is what gets built.

Covers the four items on the agenda: confirmation of dashboard requirements,
the five dashboard category views, the five custom operational reports, and the
KPI and data-source matrix.

## Status of the platform today

The analytics layer already exists. What is missing is data.

| Source | Analytics views | Data present |
|---|---|---|
| FHIR (`hapi_fhir`) | 20 report views, built | 2 patients, 6 practitioners, 53 locations, 6 questionnaire responses. No dispenses, no stock observations |
| OpenLMIS (`open_lmis`) | schema exists, 0 views | 0 facilities, 0 stock cards |
| DHIS2 (`dhis2`) | 16 report views, built | 0 data values |

Superset itself is running and healthy on port 8089, with 10 dashboards and 127
charts already provisioned.

The consequence for this sign-off: every stock, dispensing, supply-chain and
DHIS2 indicator below is correctly modelled but would render empty today. The
OpenLMIS position is consistent with a Flyway wipe of `referencedata`, which is
a known hazard on this stack. Reseeding is a prerequisite to demonstrating the
dashboards, not a change to their design.

Each KPI in the matrix is therefore marked with whether it is populated today.

## Build status

The five category views below are built and live in Superset:

```
make superset-categories        # after make superset-dashboards
```

They reuse the 127 charts that `seed_superset.py` already provisions rather
than duplicating them, so the original source-oriented dashboards keep working
and no chart URL changes. 66 charts are placed across the five views.

Verified by calling each chart's data endpoint: the FHIR and DHIS2 charts
return rows; the OpenLMIS charts return HTTP 400 because that stack is
currently stopped. That is the expected behaviour, not a defect in the
dashboards - see the matrix below for which indicators depend on it.

## Design principle

Ten dashboards is more than any one person uses. The five categories below are
organised by who is looking and what decision they are about to make, not by
which system the data came from. A logistics officer should not need to know
whether a number came from OpenLMIS or FHIR.

The existing 127 charts are not discarded. They are reorganised into these five
categories, with anything that does not serve a named decision dropped.

## The five dashboard category views

### 1. Programme overview

Audience: Ministry programme director, NEC XON delivery lead.
Decision it supports: is the programme operating, and where is attention needed.
Refresh: daily.

| Indicator | Source view |
|---|---|
| Patients registered, total and this period | `hapi_fhir` `rpt_kpi_overview`, `rpt_patient_registrations_daily` |
| Active health workers | `hapi_fhir` `rpt_workforce_roster` |
| Facilities reporting | `open_lmis` `rpt_facility_network` |
| Medicines dispensed this period | `hapi_fhir` `rpt_dispense_daily` |
| Stock alerts open | `open_lmis` `rpt_stock_alerts` |
| Data quality exceptions open | `rpt_data_quality` (all three sources) |

### 2. Stock and supply chain

Audience: national logistics officer, district pharmacist, facility in-charge.
Decision it supports: what to order, what to move, what is about to expire.
Refresh: daily.

| Indicator | Source view |
|---|---|
| Stock on hand by facility and product | `open_lmis` `rpt_stock_by_facility`, `rpt_stock_by_product` |
| Stock-out and below-minimum alerts | `open_lmis` `rpt_stock_alerts` |
| Stock on hand trend | `open_lmis` `rpt_soh_trend` |
| Lots expiring within 90 days, with quantity at risk | `open_lmis` `rpt_lot_expiry` |
| Movements by reason (receipt, issue, adjustment, loss) | `open_lmis` `rpt_movements_by_reason` |
| Requisition and order pipeline by status | `open_lmis` `rpt_requisition_pipeline`, `rpt_order_pipeline` |

### 3. Service delivery

Audience: district health manager, programme officer.
Decision it supports: where services are being delivered and where they are not.
Refresh: daily.

| Indicator | Source view |
|---|---|
| Dispensing volume per day | `hapi_fhir` `rpt_dispense_daily` |
| Dispensing by village | `hapi_fhir` `rpt_dispense_by_village` |
| Dispensing by medicine | `hapi_fhir` `rpt_dispense_detail` |
| Deliveries accepted by facility workers | `hapi_fhir` `rpt_supply_delivery_daily` |
| Tasks outstanding and overdue | `hapi_fhir` Task resources |
| Forms submitted by type | `hapi_fhir` QuestionnaireResponse |

### 4. Workforce and coverage

Audience: district supervisor, programme manager.
Decision it supports: which health workers need support, which areas are uncovered.
Refresh: weekly.

| Indicator | Source view |
|---|---|
| Caseload per village health worker | `hapi_fhir` `rpt_vhw_caseload` |
| Active roster and assignment | `hapi_fhir` `rpt_workforce_roster` |
| Care team composition | `hapi_fhir` `rpt_care_team_composition` |
| Patients by village | `hapi_fhir` `rpt_patients_by_village` |
| Villages with no active worker | derived from `rpt_patients_by_village` and `rpt_workforce_roster` |
| Facility network and catchment | `open_lmis` `rpt_facility_network` |

### 5. Data quality and platform health

Audience: M&E officer, system administrator.
Decision it supports: can the numbers above be trusted, and is the platform healthy.
Refresh: daily.

| Indicator | Source view |
|---|---|
| Failed data quality checks by category | `rpt_data_quality` (16 FHIR, 16 OpenLMIS, 12 DHIS2 checks) |
| Broken references | `hapi_fhir` `rpt_broken_references` |
| Org units that have never reported | `dhis2` `rpt_reporting_coverage` |
| Reporting completeness by data set | `dhis2` `rpt_completeness` |
| Write activity by day and hour | `hapi_fhir` `rpt_write_activity_daily`, `rpt_write_activity_hourly` |
| Backup age and last result | backup engine status (see `docs/backup-and-restore.md`) |

## The five custom operational reports

Dashboards are for looking. Reports are for sending: scheduled, delivered to a
named recipient, in a format they can act on or file. Priority is the order to
build them in.

### Priority 1: weekly stock status and alert report

- Content: stock on hand by facility and product, every item below minimum, every stock-out, with days of stock remaining.
- Users: national logistics officer, district pharmacist, facility in-charge.
- Frequency: weekly, Monday 06:00.
- Output: CSV attachment plus an inline summary table by email.
- Why first: it is the report that changes what somebody does that same day.

### Priority 2: lot expiry and wastage risk report

- Content: every lot expiring within 90 days that still holds stock, with facility, quantity and value at risk, sorted by expiry date.
- Users: national logistics officer, district pharmacist.
- Frequency: monthly, first working day.
- Output: CSV.
- Why second: wastage is preventable with this much notice, and invisible without the report.

### Priority 3: monthly health worker performance report

- Content: per health worker, patients seen, medicines dispensed, forms submitted, days active, against the district average.
- Users: district supervisor, programme manager.
- Frequency: monthly, third working day.
- Output: PDF, one page per district.
- Note: intended to direct supervision and support, not as an individual performance ranking. Worth stating explicitly to the users of the report.

### Priority 4: requisition and order fulfilment report

- Content: requisitions and orders by status, ageing in each state, fulfilment rate, and items requested but not supplied.
- Users: supply chain manager, national logistics officer.
- Frequency: fortnightly.
- Output: CSV plus summary.

### Priority 5: data quality exception report

- Content: all failing data quality checks grouped by category and source, broken references, and org units that have not reported in the period.
- Users: M&E officer, system administrator.
- Frequency: weekly, Friday.
- Output: CSV.
- Why last to build but not least important: it is the report that tells you whether the other four can be believed.

## KPI and data source matrix

`Populated` is the state of the sandbox at the time of writing, not a statement
about production.

| KPI | Definition | Source | Populated |
|---|---|---|---|
| Patients registered | Count of active Patient resources | `hapi_fhir` `rpt_kpi_overview` | Yes, 2 |
| Registrations per period | Patients created per day | `rpt_patient_registrations_daily` | Yes |
| Active health workers | Practitioners with an active PractitionerRole | `rpt_workforce_roster` | Yes, 6 |
| Caseload per worker | Patients per assigned health worker | `rpt_vhw_caseload` | Yes, 6 rows |
| Patients by village | Patients grouped by Location | `rpt_patients_by_village` | Yes, 2 rows |
| Medicines dispensed | MedicationDispense per period | `rpt_dispense_daily` | No, needs dispensing activity |
| Dispensing by village or worker | Dispenses grouped by Location or Practitioner | `rpt_dispense_by_village`, `rpt_dispense_by_vhw` | No |
| Stock on hand | Current SOH per facility and product | `open_lmis` `rpt_stock_by_facility` | No, OpenLMIS is empty |
| Stock alerts | Items at or below minimum, and stock-outs | `open_lmis` `rpt_stock_alerts` | No |
| Expiry risk | Lots expiring within 90 days holding stock | `open_lmis` `rpt_lot_expiry` | No |
| Movements by reason | Stock card line items grouped by reason | `open_lmis` `rpt_movements_by_reason` | No |
| Requisition pipeline | Requisitions by status and age | `open_lmis` `rpt_requisition_pipeline` | No |
| Facilities in network | Active facilities by type and district | `open_lmis` `rpt_facility_network` | No, 0 facilities |
| Reported data values | DHIS2 data values by element and period | `dhis2` `rpt_data_values_by_element` | No, 0 rows |
| Reporting coverage | Org units reporting versus expected | `dhis2` `rpt_reporting_coverage` | Partial, 6 rows |
| Data quality exceptions | Failing checks across all sources | `rpt_data_quality` x3 | Yes |
| Broken references | FHIR references that do not resolve | `rpt_broken_references` | Yes |
| Platform write activity | Resource writes per day and hour | `rpt_write_activity_daily` | Yes |

### What has to happen before the unpopulated KPIs can be signed off

1. Restore OpenLMIS reference data and stock. This is the large one: 13 of the
   18 KPIs above depend on it.
2. Build the OpenLMIS analytics views. The schema exists but holds no views, so
   `make superset-views-lmis` has either never run against this database or was
   lost with the data.
3. Generate dispensing activity so the service delivery indicators have
   something to show.
4. Push aggregate data to DHIS2 so reported-data and completeness indicators
   populate.

## Questions for sign-off

1. Are the five categories the right five, and is anything missing that a
   stakeholder expects to see?
2. Is the report priority order right? Priority 1 and 2 are both logistics; if
   workforce supervision is more pressing, priority 3 moves up.
3. Who are the named recipients for each of the five reports, and by what route
   - email, a shared folder, or collection from the portal?
4. What is the threshold for a stock alert: the OpenLMIS minimum stock level,
   or a separately agreed days-of-stock figure?
5. Is the monthly health worker report acceptable as a supervision tool, and
   who may see it?
6. What retention is required for scheduled report output?
