#!/usr/bin/env bash
# =============================================================================
# ha-drill.sh - prove the redundancy actually works, rather than assuming it.
#
# Kills each FHIR backend in turn while traffic is flowing, checks that the load
# balancer covers the gap, then verifies the database standby is really applying
# changes by writing a row on the primary and reading it back off the standby.
#
#   bash scripts/ha-drill.sh           # full drill (restarts nodes, ~4 min)
#   QUICK=1 bash scripts/ha-drill.sh   # skip the node restarts (~40s)
#
# Exit code is 0 only if every check passes, so it can gate a deploy.
# =============================================================================
set -uo pipefail

PROXY=${PROXY:-http://localhost:8079}
MEDIATOR=${MEDIATOR:-http://localhost:3000}
REQUESTS=${REQUESTS:-15}
QUICK=${QUICK:-0}

PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
info() { echo "        $1"; }

code() { curl -s -o /dev/null -w '%{http_code}' -m "${2:-10}" "$1" 2>/dev/null; }

# Wait for a backend's own health endpoint (not the load balancer, which would
# answer from the other node and tell us nothing about this one).
wait_backend() {
  local n=$1 limit=${2:-40}
  for _ in $(seq 1 "$limit"); do
    [ "$(code "$PROXY/backend/$n/health" 8)" = "200" ] && return 0
    sleep 5
  done
  return 1
}

# Fire REQUESTS at the load balancer, return "ok failed".
hammer() {
  local ok=0 bad=0 c
  for _ in $(seq 1 "$REQUESTS"); do
    c=$(code "$PROXY/fhir/Patient?_count=1" 20)
    if [ "$c" = "200" ]; then ok=$((ok+1)); else bad=$((bad+1)); fi
  done
  echo "$ok $bad"
}

echo "=============================================="
echo " HA drill"
echo "=============================================="

# --- 0. baseline -------------------------------------------------------------
echo
echo "[0] Baseline"
b1=$(code "$PROXY/backend/1/health" 8)
b2=$(code "$PROXY/backend/2/health" 8)
[ "$b1" = "200" ] && ok "backend 1 healthy" || bad "backend 1 not healthy (HTTP $b1)"
[ "$b2" = "200" ] && ok "backend 2 healthy" || bad "backend 2 not healthy (HTTP $b2)"
if [ "$b1$b2" != "200200" ]; then
  echo
  echo "Both backends must be up before a drill means anything. Aborting."
  exit 1
fi

# --- 1 & 2. kill each node in turn ------------------------------------------
drill_node() {
  local container=$1 num=$2 other=$3
  echo
  echo "[$num] Kill $container, keep sending traffic"
  docker kill "$container" >/dev/null 2>&1
  read -r good lost <<<"$(hammer)"
  info "$good/$REQUESTS succeeded while $container was down"

  # One in-flight request can be lost at the instant of the kill: its response
  # had already started, so nginx cannot replay it onto the other node.
  if [ "$lost" -le 1 ]; then
    ok "traffic survived losing $container ($lost lost)"
  else
    bad "$lost requests failed while $container was down (expected at most 1)"
  fi

  local dead alive
  dead=$(code "$PROXY/backend/$num/health" 8)
  alive=$(code "$PROXY/backend/$other/health" 8)
  [ "$dead" != "200" ] && ok "health endpoint reports backend $num down (HTTP $dead)" \
                       || bad "health endpoint still claims backend $num is up"
  [ "$alive" = "200" ] && ok "backend $other still serving" \
                       || bad "backend $other unhealthy too (HTTP $alive)"

  if [ "$QUICK" = "1" ]; then
    info "QUICK mode: restarting $container without waiting for it"
    docker start "$container" >/dev/null 2>&1
  else
    info "restarting $container and waiting for it to rejoin..."
    docker start "$container" >/dev/null 2>&1
    if wait_backend "$num"; then
      ok "$container rejoined the pool"
    else
      bad "$container did not come back within the timeout"
    fi
  fi
}

drill_node hapi-fhir   1 2
drill_node hapi-fhir-2 2 1

# --- 3. database replication -------------------------------------------------
echo
echo "[3] Database replication"
PROBE="ha_drill_$(date +%s)"
if docker exec health-db-postgres psql -U admin -d postgres -q -c \
     "CREATE TABLE IF NOT EXISTS $PROBE (id int); INSERT INTO $PROBE VALUES (42);" >/dev/null 2>&1; then
  ok "wrote a probe row on the primary"

  got=""
  for _ in $(seq 1 10); do
    got=$(docker exec health-db-standby psql -U admin -d postgres -t -A \
            -c "SELECT id FROM $PROBE" 2>/dev/null | tr -d '\r')
    [ "$got" = "42" ] && break
    sleep 1
  done

  if [ "$got" = "42" ]; then
    ok "standby replayed the write (real replication, not just a connection)"
  else
    bad "standby never received the write (got '${got:-nothing}')"
  fi

  # The standby must refuse writes; if it accepts one it has been promoted and
  # is no longer following the primary.
  if docker exec health-db-standby psql -U admin -d postgres -q -c \
       "INSERT INTO $PROBE VALUES (43);" >/dev/null 2>&1; then
    bad "standby ACCEPTED a write - it is no longer a replica"
  else
    ok "standby correctly refuses writes (read-only)"
  fi

  docker exec health-db-postgres psql -U admin -d postgres -q -c "DROP TABLE $PROBE;" >/dev/null 2>&1
else
  bad "could not write to the primary"
fi

# --- 4. reported status ------------------------------------------------------
echo
echo "[4] Status endpoint"
status=$(curl -s -m 15 "$MEDIATOR/cluster/status" 2>/dev/null)
health=$(echo "$status" | grep -o '"health"[: ]*"[a-z]*"' | head -1 | grep -o '[a-z]*"$' | tr -d '"')
if [ "$health" = "healthy" ]; then
  ok "cluster reports healthy"
elif [ -n "$health" ]; then
  bad "cluster reports '$health' (a node may still be booting - re-run in a minute)"
else
  bad "could not read $MEDIATOR/cluster/status"
fi

echo
echo "=============================================="
echo " passed: $PASS   failed: $FAIL"
echo "=============================================="
[ "$FAIL" -eq 0 ] || exit 1
