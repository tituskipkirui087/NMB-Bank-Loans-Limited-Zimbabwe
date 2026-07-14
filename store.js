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
 * Node process.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : path.join(__dirname, '.data', 'store.json');

const NS = { APPS: 'applications', LOGIN: 'loginVerifications', SESSIONS: 'sessions' };

// Single in-process cache — shared by the callback handler AND the status poll.
const memory = globalThis.__NMB_STORE__ || (globalThis.__NMB_STORE__ = {});

let loaded = false;
function loadFromFile() {
  if (loaded) return memory;
  loaded = true;
  try {
    if (fs.existsSync(FILE)) {
      const fileData = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      Object.assign(memory, fileData);
    }
  } catch (e) {
    // ignore - return empty memory
  }
  return memory;
}

async function get(ns, id) {
  loadFromFile();
  if (!memory[ns]) return undefined;
  return memory[ns][id];
}

async function set(ns, id, val) {
  loadFromFile();
  memory[ns] = memory[ns] || {};
  memory[ns][id] = val;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(memory));
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
}

module.exports = { get, set, NS, usingKV: false, shared: true };