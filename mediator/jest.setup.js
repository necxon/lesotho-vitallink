// Jest setup file: set required environment variables before any test module is loaded.
// These mirror the docker-compose.yml values but point to mock-friendly hostnames.
process.env.OPENHIM_USER          = 'root@openhim.org';
process.env.OPENHIM_PASS          = 'openhim-password';
process.env.OPENHIM_URL           = 'https://openhim-core:8080';
process.env.OPENSRP_URL           = 'http://opensrp-server:8080';
process.env.OPENSRP_CLIENT_ID     = 'opensrp-client';
process.env.OPENSRP_CLIENT_SECRET = 'opensrp-secret';
process.env.KEYCLOAK_URL          = 'http://keycloak:8080';
process.env.DHIS2_URL             = 'http://dhis2-web:8080';
process.env.DHIS2_USER            = 'admin';
process.env.DHIS2_PASS            = 'district';
process.env.OPENLMIS_AUTH_URL     = 'http://openlmis-auth:8080';
process.env.OPENLMIS_MGMT_URL     = 'http://openlmis-stockmanagement:8080';
process.env.OPENLMIS_USER         = 'admin';
process.env.OPENLMIS_PASS         = 'password';
process.env.OPENLMIS_CLIENT_ID    = 'user-client';
process.env.OPENLMIS_CLIENT_SECRET= 'changeme';
process.env.OPENLMIS_PROGRAM_ID   = '31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c';
process.env.OPENLMIS_FACILITY_ID  = '28de536f-b826-4eeb-a3c4-d65221a1120d';
process.env.OPENLMIS_ORDERABLE_ID = '3be1d20f-6aa9-4e52-864f-4fa04aa02056';
