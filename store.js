'use strict';
/*
 * Store module - in-memory only
 * NOTE: For the login flow to work correctly, run locally: node scripts/server.js
 * The local server maintains state in a single process.
 * Vercel serverless without KV cannot share state between invocations.
 */

const memory = globalThis.__NMB_STORE__ || (globalThis.__NMB_STORE__ = {});

const NS = { APPS: 'applications', LOGIN: 'loginVerifications', SESSIONS: 'sessions' };

async function get(ns, id) {
  const data = memory[ns];
  return data && data[id];
}

async function set(ns, id, val) {
  memory[ns] = memory[ns] || {};
  memory[ns][id] = val;
}

module.exports = { get, set, NS, usingKV: false, shared: !!globalThis.__NMB_STORE__ };