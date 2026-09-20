# Superset runtime config for the Lesotho sandbox.
# Mounted at /app/pythonpath/superset_config.py, which is already on the image PYTHONPATH.
#
# Metadata (dashboards, charts, users) lives in the `superset` database on
# health-db-postgres. The FHIR analytics views are a separate, read-only
# connection created by scripts/seed_superset.py.

import os

# --- Core ---------------------------------------------------------------------

SECRET_KEY = os.environ.get("SUPERSET_SECRET_KEY", "lesotho-sandbox-superset-key-change-me")

PG_PASSWORD = os.environ.get("PG_PASSWORD", "password123")
SQLALCHEMY_DATABASE_URI = (
    f"postgresql+psycopg2://admin:{PG_PASSWORD}@db-postgres:5432/superset"
)
SQLALCHEMY_TRACK_MODIFICATIONS = False

ROW_LIMIT = 50000
SUPERSET_WEBSERVER_TIMEOUT = 120
SUPERSET_WEBSERVER_PORT = 8088

# --- Behind plain HTTP in the sandbox ------------------------------------------
# Talisman forces HTTPS redirects and a strict CSP, which breaks the sandbox's
# http://localhost:8089. The stack is not internet-facing; re-enable for prod.

TALISMAN_ENABLED = False
ENABLE_PROXY_FIX = True
SESSION_COOKIE_SECURE = False
SESSION_COOKIE_SAMESITE = "Lax"
WTF_CSRF_ENABLED = True
# The provisioning script fetches a CSRF token, so only the login endpoint is exempt.
WTF_CSRF_EXEMPT_LIST = ["superset.views.core.log", "superset.security.api.login"]
WTF_CSRF_TIME_LIMIT = None

# --- Features -----------------------------------------------------------------

FEATURE_FLAGS = {
    # Jinja in SQL Lab and virtual datasets.
    "ENABLE_TEMPLATE_PROCESSING": True,
    # Cross-filtering inside a dashboard.
    "DASHBOARD_CROSS_FILTERS": True,
    # Drill to detail from a chart into the underlying rows.
    "DRILL_TO_DETAIL": True,
    "DRILL_BY": True,
    "ALERT_REPORTS": False,
    "EMBEDDED_SUPERSET": False,
}

# No Celery worker in this stack, so keep queries synchronous.
SQLLAB_ASYNC_TIME_LIMIT_SEC = 300
SQLLAB_TIMEOUT = 120

# Sandbox has no Redis for Superset; in-memory caching is enough at this scale.
CACHE_CONFIG = {"CACHE_TYPE": "SimpleCache", "CACHE_DEFAULT_TIMEOUT": 300}
DATA_CACHE_CONFIG = {"CACHE_TYPE": "SimpleCache", "CACHE_DEFAULT_TIMEOUT": 60}

# Let dashboards be viewed without a login (sandbox demo convenience).
# Set SUPERSET_PUBLIC_ROLE=  (empty) to require a login for everything.
PUBLIC_ROLE_LIKE = os.environ.get("SUPERSET_PUBLIC_ROLE", "Gamma") or None

APP_NAME = "Lesotho Vital-Link Analytics"
