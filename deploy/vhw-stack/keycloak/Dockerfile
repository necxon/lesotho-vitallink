# syntax=docker/dockerfile:1

# ============================================================================
# Stage 1 — Build an OPTIMIZED Keycloak image.
#
# Running with `start --optimized` skips the augmentation step on every boot by
# baking build-time options (db vendor, health, metrics, cache) in here once.
# ============================================================================
ARG KEYCLOAK_VERSION=22.0.5
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS builder

# --- Build-time options (immutable once built) ---
ENV KC_DB=postgres
ENV KC_HEALTH_ENABLED=true
ENV KC_METRICS_ENABLED=true
ENV KC_CACHE=ispn
# Serve Keycloak under /auth. This is a BUILD-TIME option, so it must be set
# here (and baked in). With `start --optimized` it cannot be changed at runtime.
ENV KC_HTTP_RELATIVE_PATH=/auth

RUN /opt/keycloak/bin/kc.sh build

# ============================================================================
# Stage 2 — Runtime image containing the pre-built server.
# ============================================================================
ARG KEYCLOAK_VERSION=22.0.5
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}

COPY --from=builder /opt/keycloak/ /opt/keycloak/

# Runtime options (db URL, credentials, hostname, proxy) come from the
# environment defined in docker-compose.yml.
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
