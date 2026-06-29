/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const { Router } = require('express');
const axios      = require('axios');
const logger     = require('../logger');
const { canPlaceOrder } = require('../config/roles');
const { PERFORMER_MAP } = require('../mappings/mappings');
const { voidRejectedDispense } = require('../sync/reconcile');

const HAPI_URL            = process.env.HAPI_FHIR_URL || 'http://hapi-fhir:8080/fhir';
const QR_PROCESSED_SYSTEM = 'http://mediator/tags';
const QR_PROCESSED_CODE   = 'mediator-processed';

const STOCK_ORDER_QUESTIONNAIRE = /e1f2a3b4/;

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

// KC sub → FHIR Practitioner ID cache (process-lifetime, small set of users)
const _kcPracCache = new Map();

async function resolvePractitionerFromKc(kcSub) {
  if (!kcSub) return null;
  if (_kcPracCache.has(kcSub)) return _kcPracCache.get(kcSub);
  try {
    const resp = await axios.get(
      `${HAPI_URL}/Practitioner?identifier=${encodeURIComponent(kcSub)}&_count=1`,
      { headers: { Accept: 'application/fhir+json' } }
    );
    const entry = (resp.data?.entry || [])[0];
    const id    = entry?.resource?.id || null;
    if (id) _kcPracCache.set(kcSub, id);
    return id;
  } catch {
    return null;
  }
}

async function patchDispensePerformer(mdId, pracId) {
  try {
    const { data: resource } = await axios.get(
      `${HAPI_URL}/MedicationDispense/${mdId}`,
      { headers: { Accept: 'application/fhir+json' } }
    );
    if (resource.performer?.length) return; // already set

    resource.performer = [{ actor: { reference: `Practitioner/${pracId}` } }];

    // Update the smartregister practitioner tag if present
    const tags = resource.meta?.tag || [];
    const tagIdx = tags.findIndex(t => t.system === 'https://smartregister.org/practitioner-tag-id');
    if (tagIdx >= 0) tags[tagIdx].code = pracId;

    await axios.put(`${HAPI_URL}/MedicationDispense/${mdId}`, resource,
      { headers: { 'Content-Type': 'application/fhir+json' } });
    logger.info(`Patched MedicationDispense/${mdId} performer → Practitioner/${pracId}`);
  } catch (err) {
    logger.warn(`Failed to patch MedicationDispense/${mdId}: ${err.message}`);
  }
}

const router = Router();

// POST /fhir/bundle-sync
// Called by the fhir-proxy mirror whenever the app posts a FHIR transaction
// bundle to /fhir/.  Extracts stock QuestionnaireResponse entries and forwards
// them to the QR fan-out handler.  Also patches MedicationDispense performer
// from the JWT when the app omits it.
router.post('/', async (req, res) => {
  const bundle = req.body;
  if (!bundle?.entry?.length) {
    return res.status(200).json({ status: 'Ignored', reason: 'empty bundle' });
  }

  const resources = bundle.entry.map(e => e.resource).filter(Boolean);

  const allQRs = resources.filter(r => r.resourceType === 'QuestionnaireResponse');
  const allMDs = resources.filter(r => r.resourceType === 'MedicationDispense');

  if (allQRs.length) {
    logger.info(`Bundle sync: ${bundle.entry.length} entries, ${allQRs.length} QR(s): ${allQRs.map(r => r.questionnaire).join(', ')}`);
  }

  const stockQRs = allQRs.filter(r =>
    /qn-stock/.test(r?.questionnaire || '') ||
    /d5e6f708/.test(r?.questionnaire || '') ||
    /e1f2a3b4/.test(r?.questionnaire || '') ||
    /patient-dispense-medicine/.test(r?.questionnaire || '')
  );

  // MedicationDispenses missing a performer — patch from JWT
  const unpatchedMDs = allMDs.filter(md => !md.performer?.length && md.id);

  if (!stockQRs.length && !unpatchedMDs.length) {
    return res.status(200).json({ status: 'Ignored', reason: 'no stock QR or unpatched dispense in bundle' });
  }

  // ── Stock order role gate ─────────────────────────────────────────────────
  const orderQRs = stockQRs.filter(r => STOCK_ORDER_QUESTIONNAIRE.test(r?.questionnaire || ''));
  if (orderQRs.length) {
    const roles    = decodeJwtRoles(req.headers.authorization);
    const canOrder = roles.some(r => canPlaceOrder(r.toLowerCase()));
    if (!canOrder) {
      logger.warn(`Bundle sync: stock order rejected — roles [${roles.join(',')}] cannot place orders`);
      return res.status(403).json({ status: 'Rejected', reason: 'not-authorised', message: 'Only store managers or coordinators can place stock orders' });
    }
  }

  // ── Patch missing performer (author) from the JWT ─────────────────────────
  // The app omits QR.author and tags the practitioner as "Not defined", so a
  // dispense can't be attributed to the VHW — questionnaire.js falls back to
  // opensrp-admin and the per-VHW allocation never deducts. The JWT sub is the
  // reliable identity of the logged-in VHW, so resolve it to a Practitioner and
  // stamp author before dispatch. (Orders use the role gate, not per-VHW author.)
  const qrsNeedAuthor = stockQRs.filter(qr =>
    !qr.author?.reference && !STOCK_ORDER_QUESTIONNAIRE.test(qr?.questionnaire || ''));
  if (qrsNeedAuthor.length) {
    const sub = decodeJwtSub(req.headers.authorization);
    // The per-VHW allocation is keyed by the VHW's FHIR Practitioner id (bkm-web stores
    // `vhw_allocations.practitioner` as `Practitioner/<fhirId>`), NOT the Keycloak sub.
    // Resolve the JWT sub → real Practitioner id so the dispense attributes to the same
    // identity the allocation lives under; otherwise checkAllocation does an exact match
    // on a non-matching `Practitioner/<sub>` and the deduction silently no-ops.
    // Only fall back to an explicit performer-map _canonical when the sub can't be resolved.
    let pracRef = null;
    const resolvedId = await resolvePractitionerFromKc(sub);
    if (resolvedId) pracRef = `Practitioner/${resolvedId}`;
    if (!pracRef) {
      const mapped = sub && (PERFORMER_MAP[sub] || PERFORMER_MAP[`Practitioner/${sub}`]);
      if (mapped && mapped._canonical) pracRef = mapped._canonical;
    }
    if (pracRef) {
      qrsNeedAuthor.forEach(qr => { qr.author = { reference: pracRef }; });
      logger.info(`Bundle sync: stamped author ${pracRef} on ${qrsNeedAuthor.length} QR(s) from JWT sub ${sub}`);
    } else {
      logger.warn(`Bundle sync: ${qrsNeedAuthor.length} dispense QR(s) missing author and JWT sub ${sub} resolved no Practitioner — will attribute to fallback`);
    }
  }

  // ── Dispatch stock QRs through OpenHIM ────────────────────────────────────
  if (stockQRs.length) {
    logger.info(`Bundle sync: dispatching ${stockQRs.length} stock QR(s)`);
    // Stock/allocation rejections → void the dispense's resources so the offline-first
    // app drops them on next sync and its optimistic local count self-corrects. The
    // app's balance lives in its own "balance-after/before-*" Observations (keyed by the
    // commodity Group, not linked to the QR) — those arrive in this same bundle.
    const STOCK_REJECTS = ['insufficient-allocation', 'no-allocation', 'insufficient-stock', 'insufficient-facility-stock'];
    const balanceObs = resources.filter(r => r.resourceType === 'Observation' &&
      /balance-(after|before)/i.test((r.code && r.code.coding && r.code.coding[0] && r.code.coding[0].code) || (r.code && r.code.text) || ''));

    for (const qr of stockQRs) {
      let resp;
      try {
        resp = await axios.post('http://openhim-core:5001/fhir/QuestionnaireResponse', qr,
          { headers: { 'Content-Type': 'application/fhir+json' } });
      } catch (err) {
        resp = err.response;
        if (!resp) { logger.error(`QR dispatch error: ${err.message}`); continue; }
      }
      // questionnaire.js returns plain JSON; OpenHIM may wrap it (response.body is a JSON string).
      let body = (resp && resp.data) || {};
      if (body.response && typeof body.response.body === 'string') {
        try { body = JSON.parse(body.response.body); } catch (_) { /* keep raw */ }
      }
      if (STOCK_REJECTS.includes(body.reason)) {
        logger.warn(`Bundle sync: dispense rejected (${body.reason}) — voiding QR + MedicationDispense(s) + balance Observation(s) so the app count self-corrects`);
        for (const r of [qr, ...allMDs, ...balanceObs]) {
          await voidRejectedDispense(r, body.reason);
        }
      }
    }

    // Tag each QR as processed so the 60s poll never re-dispatches it
    await Promise.allSettled(
      stockQRs.filter(qr => qr.id).map(qr =>
        axios.post(`${HAPI_URL}/QuestionnaireResponse/${qr.id}/$meta-add`, {
          resourceType: 'Parameters',
          parameter: [{ name: 'meta', valueMeta: {
            tag: [{ system: QR_PROCESSED_SYSTEM, code: QR_PROCESSED_CODE }]
          }}]
        }, { headers: { 'Content-Type': 'application/fhir+json' } }).catch(() => {})
      )
    );
  }

  // ── Patch MedicationDispense performer from JWT ───────────────────────────
  if (unpatchedMDs.length) {
    const kcSub = decodeJwtSub(req.headers.authorization);
    // Prefer the performer map (KC-sub alias → canonical id) so attribution works
    // even when the VHW's HAPI Practitioner is missing; fall back to a HAPI lookup.
    let pracId = null;
    const mapped = kcSub && (PERFORMER_MAP[kcSub] || PERFORMER_MAP[`Practitioner/${kcSub}`]);
    if (mapped && mapped._canonical) pracId = String(mapped._canonical).replace(/^Practitioner\//, '');
    if (!pracId) pracId = await resolvePractitionerFromKc(kcSub);
    if (pracId) {
      logger.info(`Bundle sync: patching performer on ${unpatchedMDs.length} MedicationDispense(s) → Practitioner/${pracId}`);
      await Promise.allSettled(unpatchedMDs.map(md => patchDispensePerformer(md.id, pracId)));
    } else {
      logger.warn(`Bundle sync: ${unpatchedMDs.length} MedicationDispense(s) have no performer and KC sub ${kcSub} resolved no FHIR Practitioner`);
    }
  }

  res.status(200).json({
    status:    'Dispatched',
    qrCount:   stockQRs.length,
    mdPatched: unpatchedMDs.length,
  });
});

module.exports = router;
