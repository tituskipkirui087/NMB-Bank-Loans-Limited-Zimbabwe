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
 *   - Vercel KV (`@vercel/kv`) when available AND reachable, or
 *   - a JSON file on disk as a fallback (covers local runs and single-instance
 *     serverless, and survives restarts).
 *
 * CRITICAL: `shared` must accurately reflect whether the store is actually
 * visible to BOTH the webhook-callback instance and the status-poll instance.
 * If KV env vars are present but the backend is unreachable, we must NOT
 * report `shared: true` (that would make the UI hide its setup warning and
 * silently hang). A startup health-check downgrades an unreachable KV to the
 * file fallback so `shared` is correct.
 */

const fs = require('fs');
const path = require('path');

let kv = null;
let kvBroken = false;

try {
  const mod = require('@vercel/kv');
  const hasKvEnv = (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) ||
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  kv = hasKvEnv ? (mod.kv || mod.default || mod) : null;
  if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function') {
    kv = null;
  }
} catch (e) {
  kv = null;
}

const memory = globalThis.__NMB_STORE__ || (globalThis.__NMB_STORE__ = {});

// On Vercel the project directory is read-only, so write the JSON fallback to
// /tmp (writable). /tmp is per-instance, which is fine for `vercel dev` and
// local runs; production Vercel still requires KV (see `shared` below).
const FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : process.env.VERCEL
    ? '/tmp/nmb-store.json'
    : path.join(__dirname, '.data', 'store.json');

const NS = { APPS: 'applications', LOGIN: 'loginVerifications' };

function readAll() {
  if (Object.keys(memory).length) return memory;
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeAll(data) {
  Object.assign(memory, data);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data));
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
}

async function get(ns, id) {
  if (kv && !kvBroken) {
    try {
      return await kv.get(`nmb:${ns}:${id}`);
    } catch (e) {
      kvBroken = true;
      console.error('[store] kv get failed, falling back to file store:', e.message);
    }
  }
  const data = readAll();
  return data[ns] && data[ns][id];
}

async function set(ns, id, val) {
  if (kv && !kvBroken) {
    try {
      await kv.set(`nmb:${ns}:${id}`, val);
      return;
    } catch (e) {
      kvBroken = true;
      console.error('[store] kv set failed, falling back to file store:', e.message);
    }
  }
  const data = readAll();
  data[ns] = data[ns] || {};
  data[ns][id] = val;
  writeAll(data);
}

// Health-check: if KV is "configured" but unreachable, drop it. Otherwise the
// UI would think approvals are persisted (shared: true) while every read/write
// actually throws and the user is stuck on the PIN/OTP screen with no warning.
// Bounded by a timeout so a dead KV URL can't delay serverless cold starts.
(async () => {
  if (!kv) return;
  const ping = (async () => {
    await kv.set('nmb:__health__', '1');
    await kv.get('nmb:__health__');
  })();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('health check timed out')), 2000));
  try {
    await Promise.race([ping, timeout]);
  } catch (e) {
    console.error('[store] KV unreachable, falling back to file store:', e.message);
    kv = null;
    kvBroken = true;
  }
})();

module.exports = {
  get,
  set,
  NS,
  get usingKV() { return !!kv && !kvBroken; },
  // Only KV truly shares state across serverless instances. A local/single
  // instance works with the file store, so it is considered shared there.
  get shared() { return (!!kv && !kvBroken) || !process.env.VERCEL; }
};
