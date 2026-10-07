// @ts-check
'use strict';
// Game page URLs: <base>/?<query>#<CREW>[&admin=<token>]. The fragment is what the client's parseHash reads
// (apps/client/src/core/context.ts): the first part that is not 'admin=...' is the crew code; an 'admin=' part is
// stored as the host token and stripped from the address bar. Fragments never leave the machine over HTTP.
const { normalizeCrew } = require('./config.cjs');

/**
 * @param {string} base origin, e.g. http://127.0.0.1:3000
 * @param {string} query without '?', e.g. 'test=1&preset=low' ('' = none)
 * @param {string} crew crew code ('' = none)
 * @param {string} [admin] host admin token ('' = none; only ever on the first load, see host.cjs)
 */
function buildGameUrl(base, query, crew, admin = '') {
  /** @type {string[]} */
  const parts = [];
  if (crew) parts.push(crew);
  if (admin) parts.push(`admin=${encodeURIComponent(admin)}`);
  return `${base}/${query ? `?${query}` : ''}${parts.length ? `#${parts.join('&')}` : ''}`;
}

/** @param {string} u @returns {string} the crew code in a game URL's fragment ('' = none) */
function crewOfUrl(u) {
  const h = String(u).split('#')[1] ?? '';
  for (const p of h.split('&')) {
    if (!p || p.startsWith('admin=')) continue;
    return normalizeCrew(p);
  }
  return '';
}

/**
 * Adds key=value to a query string unless the key is already set (the user's own config wins).
 * @param {string} query @param {string} key @param {string} value
 */
function withParam(query, key, value) {
  const q = String(query ?? '').replace(/^\?/, '');
  if (new URLSearchParams(q).has(key)) return q;
  const kv = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  return q ? `${q}&${kv}` : kv;
}

/** @param {string} query @param {string} key */
function hasParam(query, key) {
  return new URLSearchParams(String(query ?? '').replace(/^\?/, '')).has(key);
}

module.exports = { buildGameUrl, crewOfUrl, withParam, hasParam };
