# Production settings for the new Superset (superset-next). Mounted at
# /app/pythonpath/superset_config.py. Every secret comes from the environment (.env),
# never from this file.
import os

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]  # a new random key, never the old one
# Only while taking over the copied database: the old server's key, so that
# "superset re-encrypt-secrets" can decrypt the stored connections and encrypt them
# again with SECRET_KEY. Remove it from .env afterwards.
PREVIOUS_SECRET_KEY = os.environ.get("SUPERSET_PREVIOUS_SECRET_KEY") or None
SQLALCHEMY_DATABASE_URI = (
    f"postgresql+psycopg2://{os.environ['DATABASE_USER']}:{os.environ['DATABASE_PASSWORD']}"
    f"@{os.environ.get('DATABASE_HOST', 'db')}:{os.environ.get('DATABASE_PORT', '5432')}"
    f"/{os.environ['DATABASE_DB']}"
)

_REDIS = f"redis://{os.environ.get('REDIS_HOST', 'redis')}:{os.environ.get('REDIS_PORT', '6379')}"
CACHE_CONFIG = {"CACHE_TYPE": "RedisCache", "CACHE_DEFAULT_TIMEOUT": 300,
                "CACHE_KEY_PREFIX": "superset_", "CACHE_REDIS_URL": f"{_REDIS}/1"}
DATA_CACHE_CONFIG = {**CACHE_CONFIG, "CACHE_KEY_PREFIX": "superset_data_"}
FILTER_STATE_CACHE_CONFIG = {**CACHE_CONFIG, "CACHE_KEY_PREFIX": "superset_filter_"}
EXPLORE_FORM_DATA_CACHE_CONFIG = {**CACHE_CONFIG, "CACHE_KEY_PREFIX": "superset_explore_"}
RATELIMIT_STORAGE_URI = f"{_REDIS}/2"

# Behind nginx (HTTPS) later; harmless without it.
ENABLE_PROXY_FIX = True
# Spark queries over the whole data set can take a while.
SQLLAB_TIMEOUT = 300
SUPERSET_WEBSERVER_TIMEOUT = 300
ROW_LIMIT = 50000

FEATURE_FLAGS = {"DASHBOARD_RBAC": True, "ENABLE_TEMPLATE_PROCESSING": True}
