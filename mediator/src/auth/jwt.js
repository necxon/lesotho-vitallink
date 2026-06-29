/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

// Lightweight JWT helpers. NOTE: these DECODE the token payload only — they do NOT
// verify the signature. Signature/issuer/expiry verification is a separate hardening
// task (see project_security_hardening). Use these for best-effort identity/role
// scoping behind the authenticated proxy, not as a security boundary on their own.

function decodeJwt(authHeader) {
  try {
    const token   = (authHeader || '').replace(/^Bearer\s+/i, '');
    const payload = token.split('.')[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function decodeJwtRoles(authHeader) {
  return decodeJwt(authHeader)?.realm_access?.roles || [];
}

function decodeJwtSub(authHeader) {
  return decodeJwt(authHeader)?.sub || null;
}

module.exports = { decodeJwt, decodeJwtRoles, decodeJwtSub };
