#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap_openlmis.sh — make sure ../openlmis-ref-distro exists and is set up
# the way this sandbox needs it.
#
# The Makefile's OpenLMIS targets drive a SIBLING checkout of the public OpenLMIS
# reference distribution. This script creates that checkout on a fresh machine:
# clone at a pinned commit, replay our overlay, generate the nginx config.
#
#   bash scripts/bootstrap_openlmis.sh          # clone + set up if missing
#   OPENLMIS_DIR=/elsewhere bash scripts/bootstrap_openlmis.sh
#
# Idempotent: if the sibling is already set up it prints one line and exits 0,
# so `make up-lmis` can call it every time. It never modifies a checkout it did
# not create — if you already have one, it leaves it alone.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

UPSTREAM="${OPENLMIS_UPSTREAM:-https://github.com/OpenLMIS/openlmis-ref-distro.git}"
SIBLING="${OPENLMIS_DIR:-$REPO/../openlmis-ref-distro}"
OVERLAY="$REPO/deploy/openlmis-overlay"
MARKER=".lesotho-overlay-applied"
HTTP_PORT="${OL_HTTP_PORT:-8082}"

log() { printf '[bootstrap] %s\n' "$*"; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Already done? ────────────────────────────────────────────────────────────
if [[ -f "$SIBLING/$MARKER" ]]; then
  log "OpenLMIS sibling ready at $SIBLING"
  exit 0
fi

# ── Someone else's checkout — don't touch it ─────────────────────────────────
# Three cases: an empty directory (a half-finished attempt) we can safely take
# over, a real checkout we leave alone, and a directory with something else in
# it, where failing loudly beats letting `docker compose` fail cryptically.
if [[ -d "$SIBLING" ]]; then
  if [[ -z "$(ls -A "$SIBLING" 2>/dev/null)" ]]; then
    log "$SIBLING is empty — setting it up"
    rmdir "$SIBLING"
  elif [[ -f "$SIBLING/docker-compose.yml" ]]; then
    log "$SIBLING exists but was not set up by this script."
    log "Leaving it as-is. If it works, carry on; if not, capture your overlay with"
    log "  bash scripts/capture_openlmis_overlay.sh"
    exit 0
  else
    die "$SIBLING exists but has no docker-compose.yml. Remove it and re-run, or point OPENLMIS_DIR= at a real checkout."
  fi
fi

command -v git >/dev/null || die "git is required"
command -v docker >/dev/null || die "docker is required"
[[ -d "$OVERLAY" ]] || die "missing $OVERLAY — run scripts/capture_openlmis_overlay.sh on a working machine first"

PIN="$(cat "$OVERLAY/UPSTREAM_PIN" 2>/dev/null || true)"
[[ -n "$PIN" ]] || die "missing $OVERLAY/UPSTREAM_PIN"

# ── 1. Clone upstream at the pinned commit ───────────────────────────────────
log "cloning $UPSTREAM -> $SIBLING"
git clone --quiet "$UPSTREAM" "$SIBLING"
git -C "$SIBLING" checkout --quiet "$PIN" \
  || die "pinned commit $PIN not found upstream"
log "checked out $PIN"

# ── 2. Replay our changes to upstream-tracked files ──────────────────────────
if [[ -s "$OVERLAY/overlay.patch" ]]; then
  git -C "$SIBLING" apply "$OVERLAY/overlay.patch" \
    || die "overlay.patch did not apply cleanly against $PIN"
  log "applied overlay.patch"
fi

# ── 3. Drop in files upstream does not have ──────────────────────────────────
if [[ -d "$OVERLAY/files" ]] && [[ -n "$(ls -A "$OVERLAY/files" 2>/dev/null)" ]]; then
  cp -R "$OVERLAY/files/." "$SIBLING/"
  log "copied overlay files"
fi

# ── 4. Serve OpenLMIS on 8082 (80 collides with the sandbox's own nginx) ─────
if grep -q '^OL_HTTP_PORT=' "$SIBLING/.env" 2>/dev/null; then
  sed -i.bak "s/^OL_HTTP_PORT=.*/OL_HTTP_PORT=$HTTP_PORT/" "$SIBLING/.env" && rm -f "$SIBLING/.env.bak"
else
  printf '\nOL_HTTP_PORT=%s\n' "$HTTP_PORT" >> "$SIBLING/.env"
fi
log "OL_HTTP_PORT=$HTTP_PORT"

# ── 5. Generate the static nginx config ──────────────────────────────────────
# consul-template renders a broken upstream block when Docker DNS isn't ready
# yet (see `make fix-nginx`), so the sandbox bind-mounts a static config instead.
if command -v python3 >/dev/null; then
  mkdir -p "$SIBLING/config/nginx"
  python3 scripts/gen_openlmis_nginx.py > "$SIBLING/config/nginx/openlmis-default.conf"
  log "generated config/nginx/openlmis-default.conf"
else
  log "WARNING: python3 not found — run 'make fix-nginx' after the stack starts"
fi

printf 'pin=%s applied=%s\n' "$PIN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SIBLING/$MARKER"
log "done — $SIBLING is ready"
