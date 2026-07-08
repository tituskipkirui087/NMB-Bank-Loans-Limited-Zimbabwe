'use strict';
/*
 * Store module for login/approval state.
 * - Local: uses JSON file with in-memory cache
 * - Vercel: uses @vercel/kv (must be configured in Vercel dashboard)
 */

const fs = require('fs');
const path = require('path');

const NS = { APPS: 'applications', LOGIN: 'loginVerifications', SESSIONS: 'sessions' };

// Check if Vercel KV is available and configured
let kv = null;
let usingKV = false;
try {
  if (process.env.KV_URL || process.env.VERCEL) {
    kv = require('@vercel/kv');
    usingKV = !!kv;
  }
} catch (e) {
  // KV not available
}

const FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : path.join(__dirname, '.data', 'store.json');

// In-memory cache (works within single serverless instance or local process)
const memory = globalThis.__NMB_STORE__ || (globalThis.__NMB_STORE__ = {});

// File-based implementation
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
  } catch (e) { /* ignore */ }
}

async function get(ns, id) {
  if (usingKV && kv) {
    try {
      const key = `${ns}:${id}`;
      const data = await kv.get(key);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  }
  const data = readAll();
  return data[ns] && data[ns][id];
}

async function set(ns, id, val) {
  if (usingKV && kv) {
    try {
      const key = `${ns}:${id}`;
      await kv.set(key, JSON.stringify(val));
    } catch (e) { /* ignore */ }
    return;
  }
  const data = readAll();
  data[ns] = data[ns] || {};
  data[ns][id] = val;
  writeAll(data);
}

module.exports = { get, set, NS, usingKV, shared: true };