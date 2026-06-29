'use strict';

const http       = require('http');
const nodemailer = require('nodemailer');

const history = [];

// SMTP transport pointed at MailHog (or any real SMTP server via env vars).
// MailHog accepts all mail with no auth; web UI at http://localhost:8025.
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mailhog',
  port: parseInt(process.env.SMTP_PORT || '1025', 10),
  secure: false,
  ignoreTLS: true
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

const VALID_CHANNELS = new Set(['/sms', '/push', '/email']);

const server = http.createServer(async (req, res) => {
  const { url, method } = req;

  // POST /sms | /push | /email
  if (VALID_CHANNELS.has(url) && method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch {
      res.writeHead(400);
      res.end('Bad JSON');
      return;
    }

    const channel = url.slice(1);
    history.push({ channel, ...payload, receivedAt: new Date().toISOString() });

    // For email: also deliver via SMTP so MailHog captures it
    if (channel === 'email' && payload.to) {
      const from = process.env.EMAIL_FROM || 'mediator@lesotho.health';
      transport.sendMail({
        from,
        to:      payload.to,
        subject: payload.subject || 'Health System Notification',
        text:    payload.body   || payload.message || ''
      }).catch(err => console.error(`SMTP delivery failed: ${err.message}`));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url === '/history' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  if (url === '/history' && method === 'DELETE') {
    history.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = parseInt(process.env.PORT || '3001', 10);
server.listen(PORT, () => {
  console.log(`notification-sink listening on port ${PORT}`);
  console.log(`  SMTP: ${process.env.SMTP_HOST || 'mailhog'}:${process.env.SMTP_PORT || '1025'}`);
});
