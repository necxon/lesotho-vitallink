-- Read-only database role for Superset in the OpenLMIS database.
-- Run against open_lmis in the openlmis-ref-distro-db-1 container.
--
--   docker exec -i openlmis-ref-distro-db-1 psql -U postgres -d open_lmis \
--     < scripts/sql/openlmis_superset_role.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'superset_ro') THEN
    CREATE ROLE superset_ro LOGIN PASSWORD 'superset_ro';
  END IF;
END
$$;

ALTER ROLE superset_ro WITH LOGIN PASSWORD 'superset_ro';

GRANT CONNECT ON DATABASE open_lmis TO superset_ro;

-- The analytics views read the OpenLMIS schemas directly, and a view runs with
-- the privileges of the querying role, so the source schemas are granted too.
GRANT USAGE ON SCHEMA analytics, referencedata, stockmanagement, requisition, fulfillment TO superset_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics, referencedata, stockmanagement, requisition, fulfillment TO superset_ro;

ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO superset_ro;
