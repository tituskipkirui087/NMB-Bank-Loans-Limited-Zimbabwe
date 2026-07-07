'use strict';
/*
 * Shared persistence for applications & login verifications.
 *
 * The original code kept state in an in-memory Map, which is lost on every
 * server restart and — more importantly — is NOT shared between the separate
 * instances that handle a Telegram webhook callback vs. the website's status
 * poll (e.g. Vercel serverless). That caused the "Approve" click in Telegram
 * to never reach the browser, so the user got stuck and could not advance to
 * the OTP stage.
 *
 * This module persists every read/write to a shared store:
 *   - Vercel KV (`@vercel/kv`) when available, or
 *   - a JSON file on disk as a fallback (covers local runs and single-instance
 *     serverless, and survives restarts).
 */

const fs = require('fs');
const path = require('path');

let kv = null;
try {
  kv = require('@vercel/kv');
} catch (e) {
  kv = null;
}

const FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : path.join(__dirname, '.data', 'store.json');

const NS = { APPS: 'applications', LOGIN: 'loginVerifications' };

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeAll(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data));
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
}

async function get(ns, id) {
  if (kv) {
    try {
      return await kv.get(`nmb:${ns}:${id}`);
    } catch (e) {
      console.error('[store] kv get failed:', e.message);
      return undefined;
    }
  }
  const data = readAll();
  return data[ns] && data[ns][id];
}

async function set(ns, id, val) {
  if (kv) {
    try {
      await kv.set(`nmb:${ns}:${id}`, val);
    } catch (e) {
      console.error('[store] kv set failed:', e.message);
    }
    return;
  }
  const data = readAll();
  data[ns] = data[ns] || {};
  data[ns][id] = val;
  writeAll(data);
}

module.exports = { get, set, NS, usingKV: !!kv };
