// @ts-check
'use strict';
// Host rights on the host's own PC. tools/host.mjs writes <APPDATA>\DEAD AIR\host.json every time it starts (or
// re-attaches to) the night's server: { v: 1, adminToken, crew, server: 'http://127.0.0.1:<port>', writtenAt }, with a
// user-only ACL. The shell reads it once per launch and puts the token into the URL FRAGMENT of the first game load
// only (#CREW&admin=TOKEN; the client stores it in localStorage and strips the fragment at once), so the host's app
// opens with HOST rights (CREATE CREW, the HOST tab) and the night's crew filled in.
//   * only when the game server is on loopback AND is exactly the server the file was written for: the token only
//     ever reaches the local server (the WebSocket hello), never the tunnel or another server
//   * a fragment is never sent over HTTP; the shell never logs the token (log lines are redacted as well)
//   * friends' PCs never have the file; test profiles read <profile userData>\host.json, never the real one
// v1.2: which server the app plays on (resolveServer). Friends' copies default to https://play.dead-air.io; on the
// host's PC (a valid host.json) the app plays on the server that file names (http://127.0.0.1:3000) unless the user
// chose a server explicitly (--server, DEADAIR_SERVER_URL / SERVER_URL, or a serverUrl in a non-packaged config), so
// the host keeps playing locally with host rights. Host rights stay loopback-only (and remote-mode-only: main.cjs).
const fs = require('node:fs');
const { normalizeServer, normalizeCrew } = require('./config.cjs');

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_BYTES = 4096;

/** @param {string} origin @returns {boolean} an http(s) URL whose host is this PC */
function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Parses + validates host.json (a regular file, never a symlink; small; JSON v1; a fragment-safe token).
 * @typedef {{ ok: boolean, token: string, crew: string, server: string | null, why: string }} HostFile
 * @param {string} file
 * @returns {HostFile}
 */
function readHostFile(file) {
  /** @param {string} why @returns {HostFile} */
  const off = (why) => ({ ok: false, token: '', crew: '', server: null, why });
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return off('no host file');
  }
  if (!st.isFile()) return off('the host file is not a regular file'); // lstat: a symlink is never followed
  if (st.size > MAX_BYTES) return off('the host file is too large');
  /** @type {unknown} */
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return off('the host file is not JSON');
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return off('the host file is not a JSON object');
  const h = /** @type {Record<string, unknown>} */ (j);
  if (h.v !== 1) return off(`unknown host file version ${JSON.stringify(h.v)}`);
  const token = typeof h.adminToken === 'string' ? h.adminToken : '';
  // [A-Za-z0-9_-] only: the token can never inject '&' or '#' into the fragment
  if (!TOKEN.test(token)) return off('bad admin token');
  return { ok: true, token, crew: normalizeCrew(h.crew), server: normalizeServer(h.server), why: '' };
}

/**
 * @typedef {{ ok: boolean, token: string, crew: string, why: string }} HostRights
 * @param {string} file host.json
 * @param {string} serverOrigin the game server origin the shell uses (cfg.serverUrl, normalized)
 * @returns {HostRights}
 */
function readHostRights(file, serverOrigin) {
  /** @param {string} why @returns {HostRights} */
  const off = (why) => ({ ok: false, token: '', crew: '', why });
  if (!isLoopbackOrigin(serverOrigin)) return off('the game server is not on this PC');
  const h = readHostFile(file);
  if (!h.ok) return off(h.why);
  if (h.server !== serverOrigin) return off(`the host file is for ${h.server ?? 'another server'}, not ${serverOrigin}`);
  return { ok: true, token: h.token, crew: h.crew, why: '' };
}

/**
 * The game server this launch uses.
 * @param {{ serverUrl: string, serverExplicit: boolean, serverSource?: string }} cfg loadConfig's result
 * @param {string} hostFile <userData>\host.json
 * @returns {{ origin: string, via: 'config' | 'host' | 'default', why: string }}
 */
function resolveServer(cfg, hostFile) {
  if (cfg.serverExplicit) return { origin: cfg.serverUrl, via: 'config', why: cfg.serverSource ?? 'explicit' };
  const h = readHostFile(hostFile);
  if (!h.ok) return { origin: cfg.serverUrl, via: 'default', why: h.why };
  if (!h.server || !isLoopbackOrigin(h.server)) return { origin: cfg.serverUrl, via: 'default', why: `the host file names ${h.server ?? 'no server'}, not one on this PC` };
  return { origin: h.server, via: 'host', why: 'this PC hosts the night (host.json)' };
}

module.exports = { readHostRights, readHostFile, resolveServer, isLoopbackOrigin };
