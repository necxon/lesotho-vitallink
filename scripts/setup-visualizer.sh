#!/usr/bin/env bash
#
# NEC XON (c) Copyright 2025. All rights reserved.
#
# setup-visualizer.sh — install the "BKM End-to-End Flow" OpenHIM Console visualizer.
#
# The OpenHIM Console (#!/visualizer) animates a component only when a transaction
# emits an event whose eventType+eventName match. For this stack the live-animating
# events are:
#   - channel    → "BKM MedicationDispense" / "BKM SupplyDelivery" / "BKM QuestionnaireResponse"
#   - mediator   → "urn:mediator:lesotho-vital-link"
# The downstream components (OpenSRP/HAPI, OpenLMIS, DHIS2) only animate once the
# mediator reports OpenHIM "orchestrations" with the matching eventName (a separate
# mediator code change); they are included here so the diagram is complete and ready.
#
# Idempotent: deletes any existing visualizer of the same name, then re-inserts.
# Auto-detects the OpenHIM Mongo container + the mongo|mongosh binary.
#
# Usage:  bash scripts/setup-visualizer.sh
#
set -euo pipefail

VIS_NAME="${VIS_NAME:-BKM End-to-End Flow}"
MEDIATOR_URN="${MEDIATOR_URN:-urn:mediator:lesotho-vital-link}"

log() { echo "[visualizer] $*"; }

# Locate the OpenHIM Mongo container (compose default: openhim-mongo).
MONGO_C="${OPENHIM_MONGO_CONTAINER:-}"
if [ -z "$MONGO_C" ]; then
  MONGO_C=$(docker ps --format '{{.Names}}' | grep -i openhim | grep -i mongo | head -1 || true)
  [ -z "$MONGO_C" ] && MONGO_C=$(docker ps --format '{{.Names}}' | grep -i mongo | head -1 || true)
fi
if [ -z "$MONGO_C" ]; then
  log "ERROR: could not find an OpenHIM Mongo container. Set OPENHIM_MONGO_CONTAINER=<name> and retry."
  exit 1
fi

# mongo (legacy) vs mongosh (newer images).
MONGO_BIN=$(docker exec "$MONGO_C" sh -c 'command -v mongosh || command -v mongo' 2>/dev/null || true)
if [ -z "$MONGO_BIN" ]; then
  log "ERROR: neither mongosh nor mongo found inside $MONGO_C."
  exit 1
fi

log "Installing visualizer \"$VIS_NAME\" via $MONGO_C ($MONGO_BIN) ..."

docker exec -i "$MONGO_C" "$MONGO_BIN" --quiet openhim --eval "
db.visualizers.deleteOne({ name: '${VIS_NAME}' });
db.visualizers.insertOne({
  name: '${VIS_NAME}',
  mediators: [
    { mediator: '${MEDIATOR_URN}', name: 'Vital-Link Lesotho Mediator', display: 'Vital-Link Mediator' }
  ],
  channels: [
    { eventType: 'channel', eventName: 'BKM MedicationDispense',    display: 'MedicationDispense' },
    { eventType: 'channel', eventName: 'BKM SupplyDelivery',        display: 'SupplyDelivery' },
    { eventType: 'channel', eventName: 'BKM QuestionnaireResponse', display: 'QuestionnaireResponse' }
  ],
  components: [
    { eventType: 'orchestration', eventName: 'HAPI FHIR (OpenSRP)', display: 'OpenSRP / HAPI FHIR' },
    { eventType: 'orchestration', eventName: 'OpenLMIS',            display: 'OpenLMIS (eLMIS)' },
    { eventType: 'orchestration', eventName: 'DHIS2',               display: 'DHIS2' }
  ],
  time:  { minDisplayPeriod: 100, maxSpeed: 5, maxTimeout: 5000 },
  size:  { responsive: true, width: 1000, height: 440, padding: 20 },
  color: { inactive: '#cbd5e1', active: '#1db954', error: '#d64541', text: '#0f172a' }
});
print('  visualizer \"${VIS_NAME}\" installed');
"

log "Done. Reload the OpenHIM Console (#!/visualizer) and pick \"${VIS_NAME}\"."
