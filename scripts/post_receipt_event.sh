#!/usr/bin/env bash
#
# NEC XON (c) Copyright 2025.
#
# post_receipt_event.sh — post a RECEIPT (accepted delivery) to the mediator.
#
# Records a real delivery for the performer's facility: the mediator posts a CREDIT
# stock event to OpenLMIS (reason "Receipts") and writes a facility_deliveries row,
# which unblocks the "require accepted delivery before allocation" gate for that
# facility. Seeded opening stock does NOT do this (it bypasses the mediator).
#
# Usage:
#   bash scripts/post_receipt_event.sh
#   PERFORMER=Practitioner/prac-fw-clinic-b MED=PARASYR QTY=30 bash scripts/post_receipt_event.sh
#
# Env overrides (defaults shown):
#   MEDIATOR_URL  http://localhost:3000
#   PERFORMER     Practitioner/prac-fw-clinic-a   (facility worker — sets the facility)
#   MED           AMOX250
#   QTY           50
#   PATIENT       Patient/patient-001

MEDIATOR_URL="${MEDIATOR_URL:-http://localhost:3000}"
PERFORMER="${PERFORMER:-Practitioner/prac-fw-clinic-a}"
MED="${MED:-AMOX250}"
QTY="${QTY:-50}"
PATIENT="${PATIENT:-Patient/patient-001}"
WHEN="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

curl -s -X POST "${MEDIATOR_URL}/fhir/MedicationDispense" \
  -H 'Content-Type: application/fhir+json' \
  -d "{\"resourceType\":\"MedicationDispense\",\"status\":\"completed\",
       \"type\":{\"coding\":[{\"code\":\"RECEIPT\"}]},
       \"subject\":{\"reference\":\"${PATIENT}\"},
       \"performer\":[{\"actor\":{\"reference\":\"${PERFORMER}\"}}],
       \"medicationCodeableConcept\":{\"coding\":[{\"code\":\"${MED}\"}]},
       \"whenHandedOver\":\"${WHEN}\",
       \"quantity\":{\"value\":${QTY},\"unit\":\"tablet\"}}"
echo ""
