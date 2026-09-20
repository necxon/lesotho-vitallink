# Superset for the Lesotho sandbox.
# The upstream image ships without a Postgres driver, so both the metadata
# database and the FHIR analytics connection fail with ModuleNotFoundError:
# psycopg2. This adds the driver and nothing else.
FROM apache/superset:4.1.1

USER root
RUN pip install --no-cache-dir psycopg2-binary==2.9.9
USER superset
