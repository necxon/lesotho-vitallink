/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const { Router }    = require('express');
const runtimeConfig = require('../config/runtimeConfig');

const router = Router();

router.get('/', (_req, res) => {
  res.json(runtimeConfig.getAll());
});

router.patch('/', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }
  res.json(runtimeConfig.patch(req.body));
});

module.exports = router;
