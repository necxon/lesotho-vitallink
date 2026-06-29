/*
 * NEC XON (c) Copyright 2025.
 */
/*  */'use strict';

const axios  = require('axios');
const { CONFIG } = require('./config/config');

let _lmisToken = null, _lmisExpires = 0, refreshingLMIS = null;

async function getOpenLMISToken() {
  if (_lmisToken && Date.now() < _lmisExpires) return _lmisToken;
  if (refreshingLMIS) return refreshingLMIS;

  refreshingLMIS = (async () => {
    try {
      const res = await axios.post(
        `${CONFIG.lmis.authUrl}/api/oauth/token`,
        `grant_type=password&username=${CONFIG.lmis.user}&password=${CONFIG.lmis.pass}`,
        {
          auth:    { username: CONFIG.lmis.client, password: CONFIG.lmis.secret },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );
      _lmisToken   = res.data.access_token;
      _lmisExpires = Date.now() + (res.data.expires_in - 60) * 1000;
      return _lmisToken;
    } finally { refreshingLMIS = null; }
  })();
  return refreshingLMIS;
}

/**
 * Calls fn(token). If OpenLMIS rejects with 401 (token expired or invalidated
 * server-side before our cache TTL), clears the cache and retries once with a
 * fresh token. All other errors propagate normally.
 */
async function withOpenLMISToken(fn) {
  const token = await getOpenLMISToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    _lmisToken = null;
    _lmisExpires = 0;
    const fresh = await getOpenLMISToken();
    return fn(fresh);
  }
}

let _kcToken = null, _kcExpires = 0, refreshingKC = null;

async function getKeycloakToken() {
  if (_kcToken && Date.now() < _kcExpires) return _kcToken;
  if (refreshingKC) return refreshingKC;

  refreshingKC = (async () => {
    try {
      const res = await axios.post(
        `${CONFIG.keycloak.url}/realms/opensrp/protocol/openid-connect/token`,
        'grant_type=client_credentials',
        {
          auth:    { username: CONFIG.opensrp.clientId, password: CONFIG.opensrp.clientSecret },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );
      _kcToken   = res.data.access_token;
      _kcExpires = Date.now() + (res.data.expires_in - 60) * 1000;
      return _kcToken;
    } finally { refreshingKC = null; }
  })();
  return refreshingKC;
}

module.exports = { getOpenLMISToken, withOpenLMISToken, getKeycloakToken };
