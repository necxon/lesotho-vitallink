/*
 * PROD runtime config for bkm-web (lesotho-bkm.xyz). NOT used unless mounted.
 * Mount over the container's localhost default in docker-compose (prod/lesotho-test):
 *   bkm-web:
 *     volumes:
 *       - ./config/bkm-web/config.prod.js:/usr/share/nginx/html/config.js:ro
 * This keeps the committed app code identical across environments — only this file
 * (mounted, not baked) carries the prod URLs.
 */
window.__BKM_CONFIG__ = {
  keycloakUrl: 'https://lesotho-bkm.xyz/auth',
  fhir:        'https://fhir.lesotho-bkm.xyz/fhir',
  openhim:     'https://sync.lesotho-bkm.xyz',
  dhis2:       'https://dhis2.lesotho-bkm.xyz',
  // Admin Portal (Services page) "Open" links. Without this map they fall back
  // to the localhost defaults baked into js/pages/services.js.
  services: {
    opensrp:    'https://opensrp.lesotho-bkm.xyz',
    openhim:    'https://openhim.lesotho-bkm.xyz',
    keycloak:   'https://lesotho-bkm.xyz/auth',
    fhir:       'https://fhir.lesotho-bkm.xyz',
    dhis2:      'https://dhis2.lesotho-bkm.xyz',
    openlmis:   'https://lmis.lesotho-bkm.xyz',
    grafana:    'https://grafana.lesotho-bkm.xyz',
    prometheus: 'https://prometheus.lesotho-bkm.xyz',
    mailhog:    'https://mailhog.lesotho-bkm.xyz',
  },
};
