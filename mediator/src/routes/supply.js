/*
 * NEC XON (c) Copyright 2025.
 */
'use strict';

const { Router } = require('express');
const logger = require('../logger');
const reply = require('../reply');
const { createStockTask } = require('../tasks/tasks');

const router = Router();

// POST /fhir/SupplyDelivery — eLMIS issues stock to a VHW; creates a pending FHIR Task (BR-03)
router.post('/', async (req, res) => {
  const { performer, medication, quantity, issueRef } = req.body;
  try {
    if (!performer || !medication || !quantity) {
      return reply(res, { status: 'Error', message: 'performer, medication, and quantity are required' }, 400);
    }
    const task = await createStockTask({ performer, medication, quantity: Number(quantity), issueRef });
    reply(res, { status: 'Created', taskId: task.id, task }, 201);
  } catch (err) {
    logger.error(`SupplyDelivery failed: ${err.message}`);
    reply(res, { status: 'Error', message: err.message }, 500);
  }
});

module.exports = router;
