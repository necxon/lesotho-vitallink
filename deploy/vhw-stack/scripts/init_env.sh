#!/usr/bin/env bash
# init_env.sh - create .env from a template with freshly generated secrets.
#   cd /opt/vhw-stack && sudo bash scripts/init_env.sh                          # .env.example
#   cd /opt/vhw-preprod && bash scripts/init_env.sh .env.preprod.example       # preprod
# Refuses to touch an existing .env. WEB_KC_CLIENT_SECRET stays empty: it comes
# from Keycloak after the realm is imported (README, first deployment step 6).
set -euo pipefail
cd "$(dirname "$0")/.."
TEMPLATE=${1:-.env.example}
[[ -f $TEMPLATE ]] || { echo "template $TEMPLATE not found" >&2; exit 1; }
[[ -e .env ]] && { echo ".env already exists - not overwriting it" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

gen() { openssl rand -hex 24; }
umask 077
sed -e "s/^HAPI_DB_PASSWORD=$/HAPI_DB_PASSWORD=$(gen)/" \
    -e "s/^KC_DB_PASSWORD=$/KC_DB_PASSWORD=$(gen)/" \
    -e "s/^KC_ADMIN_PASSWORD=$/KC_ADMIN_PASSWORD=$(gen)/" \
    -e "s/^WEB_SESSION_SECRET=$/WEB_SESSION_SECRET=$(openssl rand -hex 32)/" \
    "$TEMPLATE" > .env
chmod 600 .env
echo "wrote .env (mode 600). Keycloak admin login: admin / the KC_ADMIN_PASSWORD value in .env"
echo "still to fill in later: WEB_KC_CLIENT_SECRET"
