/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 *
 * GET /aggregate/whoami — returns ONLY the caller's own facility/role, derived
 * from the JWT sub (matched against the performer map's sourceId/aliases). Lets the
 * web portal lock itself to the logged-in user's facility without shipping the whole
 * staff map to the browser. Facility-scoped roles (coordinator, vhw) must never
 * see another health centre's data.
 */
'use strict';

const { Router } = require('express');
const { PERFORMER_MAP } = require('../mappings/mappings');
const { decodeJwtSub } = require('../auth/jwt');

const router = Router();

function resolvePerformer(id) {
  if (!id) return null;
  if (PERFORMER_MAP[id]) return PERFORMER_MAP[id];
  const pref = `Practitioner/${id}`;
  if (PERFORMER_MAP[pref]) return PERFORMER_MAP[pref];
  return null;
}

router.get('/', (req, res) => {
  const sub = decodeJwtSub(req.headers.authorization);
  const p = resolvePerformer(sub);
  if (!p) {
    return res.json({
      resolved: false,
      practitioner: sub ? `Practitioner/${sub}` : null,
      role: null, facilityId: null, facilityName: null, programId: null, locationName: null,
    });
  }
  res.json({
    resolved: true,
    practitioner: p._canonical || (sub ? `Practitioner/${sub}` : null),
    role:         p.role         || null,
    facilityId:   p.facilityId   || null,
    facilityName: p.facilityName || null,
    programId:    p.programId    || null,
    locationName: p.locationName || null,
  });
});

module.exports = router;
