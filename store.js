'use strict';
/*
 * Simple in-memory + JSON-file store for login/approval state.
 * For Vercel serverless: uses @vercel/kv if available.
 * For local development: uses JSON file with in-memory cache.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : path.join(__dirname, '.data', 'store.json');

const NS = { APPS: 'applications', LOGIN: 'loginVerifications', SESSIONS: 'sessions' };

// Try to load Vercel KV if available
let kv = null;
let usingKV = false;
try {
  kv = require('@vercel/kv');
  usingKV = true;
} catch (e) {
  // KV not available, use file-based storage
}

// Single in-process cache
const memory = globalThis.__NMB_STORE__ || (globalThis.__NMB_STORE__ = {});

// KV-based implementation
if (usingKV) {
  module.exports = {
    get: async (ns, id) => {
      const key = `${ns}:${id}`;
      const data = await kv.get(key);
      return data ? JSON.parse(data) : null;
    },
    set: async (ns, id, val) => {
      const key = `${ns}:${id}`;
      await kv.set(key, JSON.stringify(val));
    },
    NS,
    usingKV: true,
    shared: true
  };
} else {
  // File-based implementation for local development
  function readAll() {
    try {
      if (fs.existsSync(FILE)) {
        const fileData = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (Object.keys(memory).length === 0) {
          Object.assign(memory, fileData);
        }
      }
    } catch (e) { /* ignore */ }
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

  module.exports = { get, set, NS, usingKV: false, shared: true };
}
