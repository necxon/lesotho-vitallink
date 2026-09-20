-- Create all service databases.
-- Flyway (used by OpenLMIS) only creates schemas/tables; the databases must pre-exist.
CREATE DATABASE dhis2;
CREATE DATABASE keycloak;
CREATE DATABASE opensrp;
CREATE DATABASE openlmis_auth;
CREATE DATABASE openlmis_referencedata;
CREATE DATABASE openlmis_requisition;
CREATE DATABASE openlmis_stockmanagement;
CREATE DATABASE openlmis_notification;
CREATE DATABASE hapi_fhir;
CREATE DATABASE mediator;
CREATE DATABASE superset;

-- Enable extensions in referencedata DB:
--   postgis   → geometry column on the facilities table
--   uuid-ossp → uuid_generate_v4() used in Flyway migration scripts
\c openlmis_referencedata
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
