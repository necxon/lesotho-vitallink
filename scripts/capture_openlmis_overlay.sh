#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# capture_openlmis_overlay.sh — snapshot THIS machine's working ../openlmis-ref-distro
# customisations into deploy/openlmis-overlay/, so a fresh clone can reproduce them.
#
# Run this once, on a machine where the sandbox already works. Commit the result.
# Everyone else runs scripts/bootstrap_openlmis.sh, which replays the snapshot on
# top of a pinned upstream clone.
#
#   bash scripts/capture_openlmis_overlay.sh
#   OPENLMIS_DIR=/path/to/openlmis-ref-distro bash scripts/capture_openlmis_overlay.sh
#
# What it captures:
#   overlay.patch   - diff of upstream-tracked files (compose, nginx helpers)
#   files/          - files we added that upstream does not have
#   UPSTREAM_PIN    - the upstream commit the patch applies to
#
# What it deliberately skips:
#   .env                              - may hold credentials; bootstrap sets the
#                                       only value that matters (OL_HTTP_PORT)
#   config/nginx/openlmis-default.conf - 1700 generated lines; bootstrap rebuilds
#                                       it with scripts/gen_openlmis_nginx.py
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

SIBLING="${OPENLMIS_DIR:-$REPO/../openlmis-ref-distro}"
OUT="$REPO/deploy/openlmis-overlay"

log() { printf '[capture] %s\n' "$*"; }
die() { printf '[capture] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$SIBLING/.git" ]] || die "no git checkout at $SIBLING (set OPENLMIS_DIR=)"

# The pin is the newest upstream commit our local work sits on top of.
PIN="$(git -C "$SIBLING" merge-base HEAD origin/master)" \
  || die "could not find a merge-base with origin/master"
log "upstream pin: $PIN ($(git -C "$SIBLING" log --format=%s -1 "$PIN"))"

mkdir -p "$OUT/files"

# ── 1. Tracked-file changes (committed AND working-tree), minus the skips ────
git -C "$SIBLING" diff "$PIN" -- \
  ':(exclude).env' \
  ':(exclude)config/nginx/openlmis-default.conf' \
  > "$OUT/overlay.patch"

[[ -s "$OUT/overlay.patch" ]] || log "WARNING: overlay.patch is empty"

# ── 2. Files upstream does not have at all ───────────────────────────────────
# Untracked, excluding the generated nginx config, anything ignored, and .env.
while IFS= read -r f; do
  case "$f" in
    .env|*/.env|config/nginx/openlmis-default.conf) continue ;;
  esac
  mkdir -p "$OUT/files/$(dirname "$f")"
  cp "$SIBLING/$f" "$OUT/files/$f"
  log "captured new file: $f"
done < <(git -C "$SIBLING" ls-files --others --exclude-standard)

# ── 3. Refuse to ship anything that looks like a credential ──────────────────
if grep -rniE '(password|passwd|secret|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*[^[:space:]<>"'"'"']{6,}' \
     "$OUT/overlay.patch" "$OUT/files" 2>/dev/null | grep -vE '^\S+:[0-9]*:\s*[#/-]' ; then
  die "possible credential above — review and remove before committing"
fi

printf '%s\n' "$PIN" > "$OUT/UPSTREAM_PIN"

log "wrote $OUT (patch $(wc -l < "$OUT/overlay.patch") lines, $(find "$OUT/files" -type f | wc -l) new files)"
log "review it, then commit deploy/openlmis-overlay/"
