/*
 * Runtime config for the VitalLink web portal (form and phone-menu builder) in the
 * VHW preprod environment. Mounted over the image's config.js by docker-compose.yml
 * (service bkm-web, COMPOSE_PROFILES=builder). Keycloak realm opensrp, client bkm-web.
 * OpenHIM and DHIS2 are not part of the preprod environment; their pages stay empty.
 */
window.__BKM_CONFIG__ = {
  keycloakUrl: 'https://preprod-app.vhw.gov.ls/auth',
  fhir:        'https://preprod-app.vhw.gov.ls/fhir',
  openhim:     '',
  dhis2:       '',
};
