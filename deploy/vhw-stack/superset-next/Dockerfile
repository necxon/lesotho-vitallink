# Superset from the official release image, plus the drivers BKM needs:
#   - PyHive (+ pure-sasl) for BKM_Server (Spark Thrift server, hive://...:10001)
#   - psycopg2 for the metadata database and any PostgreSQL connection
# The release images are "lean" (no extra drivers); 5.x keeps its packages in /app/.venv.
ARG SUPERSET_VERSION=6.1.0
FROM apache/superset:${SUPERSET_VERSION}
USER root
RUN set -eux; \
    PKGS='pyhive[hive_pure_sasl]==0.7.0 thrift==0.16.0 psycopg2-binary'; \
    if [ -x /app/.venv/bin/python ]; then \
      if command -v uv >/dev/null; then uv pip install --python /app/.venv/bin/python --no-cache $PKGS; \
      else /app/.venv/bin/python -m ensurepip && /app/.venv/bin/python -m pip install --no-cache-dir $PKGS; fi; \
    else pip install --no-cache-dir $PKGS; fi
USER superset
