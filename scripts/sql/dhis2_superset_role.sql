-- Read-only database role for Superset in the DHIS2 database.
-- Run against dhis2 on health-db-postgres.
--
--   docker exec -i health-db-postgres psql -U admin -d dhis2 \
--     < scripts/sql/dhis2_superset_role.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'superset_ro') THEN
    CREATE ROLE superset_ro LOGIN PASSWORD 'superset_ro';
  END IF;
END
$$;

ALTER ROLE superset_ro WITH LOGIN PASSWORD 'superset_ro';

GRANT CONNECT ON DATABASE dhis2 TO superset_ro;

-- The analytics views read the DHIS2 tables in public directly, and a view runs
-- with the privileges of the querying role, so public is granted as well.
GRANT USAGE ON SCHEMA analytics, public TO superset_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics, public TO superset_ro;

ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO superset_ro;
