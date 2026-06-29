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

// Dispense responses: use the plain JSON reply in tests (supertest hits the app
// directly, i.e. the "direct caller" path). The OpenHIM mediator envelope is exercised
// by a dedicated test that flips this to 'true'.
process.env.MEDIATOR_ORCHESTRATIONS = 'false';

// Notifications — disabled by default so existing tests are unaffected.
// Individual notification tests override these per-test via process.env.
process.env.NOTIFY_SMS_ENABLED    = 'false';
process.env.NOTIFY_PUSH_ENABLED   = 'false';
process.env.NOTIFY_ON_DISPENSE    = 'true';
process.env.NOTIFY_ON_LOW_STOCK   = 'true';
process.env.NOTIFY_ON_RECEIPT     = 'true';
process.env.NOTIFY_LOW_STOCK_THRESHOLD = '20';
process.env.NOTIFY_SMS_URL        = 'http://notification-sink:3001/sms';
process.env.NOTIFY_PUSH_URL       = 'http://notification-sink:3001/push';
process.env.NOTIFY_PUSH_API_KEY   = 'test-key';
process.env.NOTIFY_EMAIL_ENABLED  = 'false';
process.env.NOTIFY_EMAIL_URL      = 'http://notification-sink:3001/email';
process.env.NOTIFY_EMAIL_FROM     = 'mediator@lesotho.health';
// Throttle — disabled in tests so each test fires immediately
process.env.NOTIFY_SMS_THROTTLE_MS   = '0';
process.env.NOTIFY_PUSH_THROTTLE_MS  = '0';
process.env.NOTIFY_EMAIL_THROTTLE_MS = '0';
