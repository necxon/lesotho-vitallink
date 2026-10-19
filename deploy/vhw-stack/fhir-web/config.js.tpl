// Production fhir-web template from 192.0.2.146 (bophelo's config.js.tpl), with every
// address taken from the container environment, so it serves test and production alike.
// config.js.tpl  — React front-end runtime config for fhir-web.
// confd renders this into config.js at container startup.
// Replace <...> placeholders to match your .env values.

window._env_ = {
  // ---- keycloak ----
  REACT_APP_KEYCLOAK_API_BASE_URL: '{{ getenv "KEYCLOAK_BASE_URL" }}/auth/admin/realms/{{ getenv "KEYCLOAK_REALM" }}',
  REACT_APP_KEYCLOAK_LOGOUT_URL:
    '{{ getenv "KEYCLOAK_BASE_URL" }}/auth/realms/{{ getenv "KEYCLOAK_REALM" }}/protocol/openid-connect/logout',
  REACT_APP_OPENSRP_ACCESS_TOKEN_URL:
    '{{ getenv "KEYCLOAK_BASE_URL" }}/auth/realms/{{ getenv "KEYCLOAK_REALM" }}/protocol/openid-connect/token',
  REACT_APP_OPENSRP_AUTHORIZATION_URL:
    '{{ getenv "KEYCLOAK_BASE_URL" }}/auth/realms/{{ getenv "KEYCLOAK_REALM" }}/protocol/openid-connect/auth',
  REACT_APP_OPENSRP_CLIENT_ID: '{{ getenv "WEB_KC_CLIENT_ID" }}',
  REACT_APP_OPENSRP_USER_URL:
    '{{ getenv "KEYCLOAK_BASE_URL" }}/auth/realms/{{ getenv "KEYCLOAK_REALM" }}/protocol/openid-connect/userinfo',

  // ---- fhir-web ----
  REACT_APP_WEBSITE_NAME: 'Bophelo Ka Mosebeletsi-BKM',
  REACT_APP_OPENSRP_WEB_VERSION: '{{ getenv "FHIR_WEB_VERSION" }}',
  REACT_APP_DOMAIN_NAME: '{{ getenv "FHIR_WEB_BASE_URL" }}',
  REACT_APP_EXPRESS_OAUTH_GET_STATE_URL: '{{ getenv "FHIR_WEB_BASE_URL" }}/oauth/state',
  REACT_APP_EXPRESS_OAUTH_LOGOUT_URL: '{{ getenv "FHIR_WEB_BASE_URL" }}/logout',

  // ---- fhir-server (point at the GATEWAY, not HAPI directly) ----
  REACT_APP_FHIR_API_BASE_URL: '{{ getenv "FHIR_API_BASE_URL" }}',

  // ---- resource identifiers (set to your deployment's values) ----
  REACT_APP_FHIR_ROOT_LOCATION_IDENTIFIER: '{{ getenv "ROOT_LOCATION" }}',
  REACT_APP_FHIR_ROOT_LOCATION_ID: '{{ getenv "ROOT_LOCATION" }}',
  REACT_APP_COMMODITIES_LIST_RESOURCE_ID: '{{ getenv "COMMODITY_LIST" }}',

  // ---- module toggles: turn on what you need ----
  REACT_APP_ENABLE_FHIR_CARE_TEAM: 'true',
  REACT_APP_ENABLE_FHIR_GROUP: 'true',
  REACT_APP_ENABLE_FHIR_HEALTHCARE_SERVICES: 'true',
  REACT_APP_ENABLE_FHIR_LOCATIONS: 'true',
  REACT_APP_ENABLE_FHIR_PATIENTS: 'true',
  REACT_APP_ENABLE_FHIR_TEAMS: 'true',
  REACT_APP_ENABLE_FHIR_USER_MANAGEMENT: 'true',
  REACT_APP_ENABLE_FHIR_COMMODITY: 'true',
  REACT_APP_ENABLE_QUEST: 'true',
  REACT_APP_ENABLE_TEAMS_ASSIGNMENT_MODULE: 'true',

  REACT_APP_ENABLE_USERS: 'true',
  REACT_APP_ENABLE_USER_GROUPS: 'true',
  REACT_APP_ENABLE_USER_ROLES: 'true',
  REACT_APP_ENABLE_USER_SYNC: 'true',

  // ---- build/runtime ----
  SKIP_PREFLIGHT_CHECK: 'true',
  GENERATE_SOURCEMAP: 'false',
  INLINE_RUNTIME_CHUNK: 'false',
  IMAGE_INLINE_SIZE_LIMIT: '0',
  REACT_APP_OPENSRP_OAUTH_SCOPES: 'openid,profile',
  REACT_APP_ENABLE_OPENSRP_OAUTH: 'true',
  REACT_APP_BACKEND_ACTIVE: 'true',
  REACT_APP_SUPPORTED_LANGUAGES: 'en',
  REACT_APP_PROJECT_CODE: 'demo',
  REACT_APP_DEFAULTS_TABLE_PAGE_SIZE: '20',
  REACT_APP_OPENSRP_LOGOUT_URL: 'null',
  REACT_APP_PRACTITIONER_TO_ORG_ASSIGNMENT_STRATEGY: 'ONE_TO_MANY',
  REACT_APP_OPENSRP_ROLES:
    '{"USERS":"ROLE_EDIT_KEYCLOAK_USERS","LOCATIONS":"ROLE_VIEW_KEYCLOAK_USERS","TEAMS":"ROLE_VIEW_KEYCLOAK_USERS","CARE_TEAM":"ROLE_VIEW_KEYCLOAK_USERS","QUEST":"ROLE_VIEW_KEYCLOAK_USERS","HEALTHCARE_SERVICE":"ROLE_VIEW_KEYCLOAK_USERS","GROUP":"ROLE_VIEW_KEYCLOAK_USERS","COMMODITY":"ROLE_VIEW_KEYCLOAK_USERS"}',
};
