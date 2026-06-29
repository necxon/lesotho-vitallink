/*
 * NEC XON (c) Copyright 2025. All rights reserved.
 */
'use strict';

const winston        = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...rest }) => {
      const base = { timestamp, level, message };
      return JSON.stringify(Object.keys(rest).length ? { ...base, ...rest } : base);
    })
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename:    'logs/vital-link-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles:    '30d'
    })
  ]
});

module.exports = logger;
