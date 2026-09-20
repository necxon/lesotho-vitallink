/*
 * Runtime config for bkm-web on the single-domain gov deployment:
 *   https://elmis-bkm.gov.ls  (one domain, one TLS cert, path-based routing)
 *
 * All service calls go same-origin through the host nginx -> bkm-web, which
 * proxies /fhir-api, /openhim-api, /dhis2-api, /lmis-api internally. Keycloak is
 * served by host nginx at /auth. No subdomains required.
 *
 * Mount over the container's default config.js in docker-compose.override.yml:
 *   bkm-web:
 *     volumes:
 *       - ./config/bkm-web/config.elmis.js:/usr/share/nginx/html/config.js:ro
 */
window.__BKM_CONFIG__ = {
  keycloakUrl: 'https://elmis-bkm.gov.ls/auth',
  fhir:        '/fhir-api/fhir',
  lmis:        '/lmis-api',
  openhim:     '/openhim-api',
  dhis2:       '/dhis2-api',
};
