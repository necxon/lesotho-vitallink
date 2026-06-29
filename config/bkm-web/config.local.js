/*
 * LOCAL (localhost) runtime config for bkm-web. NOT used unless mounted.
 * Mounted over the container's default config.js by docker-compose.override.yml
 * (local-only, gitignored) so the SAME lesotho-test branch runs both:
 *   - locally  → this file (localhost URLs; Keycloak under /auth, port 8083)
 *   - on site  → config.prod.js (lesotho-bkm.xyz), mounted by docker-compose.yml
 * Only the mounted file differs; committed app code is identical across envs.
 */
window.__BKM_CONFIG__ = {
  keycloakUrl: 'http://localhost:8083/auth',
  fhir:        'http://localhost:8079/fhir',
  openhim:     'http://localhost:5001',
  dhis2:       'http://localhost:8081',
};
