-- Read-only database role for Superset.
-- Superset only ever needs SELECT on the analytics views, so it does not get the
-- admin login. Run against the hapi_fhir database.
--
--   docker exec -i health-db-postgres psql -U admin -d hapi_fhir < scripts/sql/superset_role.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'superset_ro') THEN
    CREATE ROLE superset_ro LOGIN PASSWORD 'superset_ro';
  END IF;
END
$$;

-- Keep the password in sync when the role already exists.
ALTER ROLE superset_ro WITH LOGIN PASSWORD 'superset_ro';

GRANT CONNECT ON DATABASE hapi_fhir TO superset_ro;
GRANT USAGE ON SCHEMA analytics TO superset_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO superset_ro;

-- The rpt_stock_trend view reads hfj_res_ver directly, so the role needs the
-- underlying tables too (views run with the privileges of the querying role).
GRANT USAGE ON SCHEMA public TO superset_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO superset_ro;

-- Anything added later is readable without re-running the grants above.
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO superset_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public    GRANT SELECT ON TABLES TO superset_ro;
