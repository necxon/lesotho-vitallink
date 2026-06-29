/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 *
 * Runtime environment config for bkm-web (build-less SPA — loaded by index.html
 * BEFORE core.js). Values here OVERRIDE the localhost defaults in core.js, and are
 * themselves overridden by anything the user saves in the Settings page (localStorage).
 *
 * Precedence:  core.js hardcoded localhost  <  this file  <  Settings (localStorage)
 *
 * DEV / local:  leave this empty ({}) — core.js localhost defaults apply.
 * PROD:         DO NOT edit this committed file. Instead mount a prod copy over it,
 *               e.g. in docker-compose:
 *                 volumes:
 *                   - ./config/bkm-web/config.prod.js:/usr/share/nginx/html/config.js:ro
 *               with contents like:
 *                 window.__BKM_CONFIG__ = {
 *                   keycloakUrl: 'https://lesotho-bkm.xyz/auth',
 *                   fhir:        'https://fhir.lesotho-bkm.xyz/fhir',
 *                   openhim:     'https://sync.lesotho-bkm.xyz',
 *                   dhis2:       'https://dhis2.lesotho-bkm.xyz',
 *                 };
 *               Then the SAME committed code runs in dev and prod — only this file differs.
 */
window.__BKM_CONFIG__ = {};
