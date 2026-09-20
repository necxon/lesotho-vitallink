/*
 * IP-ONLY runtime config for bkm-web (no domain/TLS yet — plain HTTP).
 *
 * 0.0.0.0 below is a PLACEHOLDER, not a working address. Replace every
 * occurrence with your server's own IP before deploying — a browser cannot
 * connect to 0.0.0.0.
 *
 * Same mechanism as config.local.js / config.prod.js: mounted over the container's
 * baked-in config.js by a docker-compose.override.yml on the server. Swap for
 * config.prod.js once a real domain + HTTPS are in place.
 *   bkm-web:
 *     volumes:
 *       - ./config/bkm-web/config.ip.js:/usr/share/nginx/html/config.js:ro
 */
window.__BKM_CONFIG__ = {
  keycloakUrl: 'http://0.0.0.0:8083/auth',
  fhir:        'http://0.0.0.0:8079/fhir',
  openhim:     'http://0.0.0.0:5001',
  dhis2:       'http://0.0.0.0:8081',
  // Admin Portal "Open" links (Services page).
  services: {
    opensrp:    'http://0.0.0.0:9901',
    openhim:    'http://0.0.0.0:9285',
    keycloak:   'http://0.0.0.0:8083/auth',
    fhir:       'http://0.0.0.0:8079',
    dhis2:      'http://0.0.0.0:8081',
    openlmis:   'http://0.0.0.0:8082',
    grafana:    'http://0.0.0.0:3005',
    prometheus: 'http://0.0.0.0:9290',
    mailhog:    'http://0.0.0.0:8025',
  },
};
