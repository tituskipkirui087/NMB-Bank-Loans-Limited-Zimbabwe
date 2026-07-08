'use strict';
/*
 * Simple in-memory + JSON-file store for login/approval state.
 *
 * This works exactly like a classic single-process Telegram bot + website:
 * the Telegram callback (admin clicks Approve) and the page's status poll
 * both hit the SAME Node process, so the approval lives in this process's
 * memory and the page sees it instantly. No KV / Redis / database needed.
 *
 * Run the included server (npm start -> scripts/server.js) as ONE long-running
 * Node process. Do NOT split this across serverless functions (e.g. Vercel
 * /api): separate instances cannot share memory, which is what originally
 * broke the "admin approves -> page responds" flow.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : path.join(__dirname, '.data', 'store.json');

const NS = { APPS: 'applications', LOGIN: 'loginVerifications', SESSIONS: 'sessions' };

// Single in-process cache — shared by the callback handler AND the status poll.
const memory = globalThis.__NMB_STORE__ || (globalThis.__NMB_STORE__ = {});

function readAll() {
  try {
    if (fs.existsSync(FILE)) {
      const fileData = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      console.log('[store] Read from file, memory was empty:', Object.keys(memory).length === 0);
      // Only merge file data if memory is empty (first read)
      if (Object.keys(memory).length === 0) {
        Object.assign(memory, fileData);
      }
    }
  } catch (e) {
    /* ignore - file may not exist yet */
  }
  return memory;
}

function deepAssign(target, source) {
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      target[key] = target[key] || {};
      deepAssign(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function writeAll(data) {
  deepAssign(memory, data);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(memory));
    console.log('[store] Saved:', FILE, 'keys:', Object.keys(memory).length);
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
}

async function get(ns, id) {
  const data = readAll();
  return data[ns] && data[ns][id];
}

async function set(ns, id, val) {
  const data = readAll();
  data[ns] = data[ns] || {};
  data[ns][id] = val;
  writeAll(data);
}

// Single process => the approval state is always visible to the page's poll.
module.exports = { get, set, NS, usingKV: false, shared: true };
