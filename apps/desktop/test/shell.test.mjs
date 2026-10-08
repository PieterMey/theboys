// Unit tests for the desktop shell's pure modules (no Electron): host rights, game URLs, the unclean-exit marker,
// the new config switches.   node --test apps/desktop/test/
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { readHostRights, readHostFile, resolveServer, isLoopbackOrigin } = require('../src/host.cjs');
const { buildGameUrl, crewOfUrl, withParam, hasParam } = require('../src/gameurl.cjs');
const { readMarker, writeMarker, removeMarker, assessPrevious } = require('../src/session.cjs');
const { loadConfig, userTemplate, DEFAULT_SERVER } = require('../src/config.cjs');

const TMP = mkdtempSync(join(tmpdir(), 'deadair-shell-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SERVER = 'http://127.0.0.1:3000';
let n = 0;
/** @param {unknown} body @param {string} [raw] */
const hostFile = (body, raw) => {
  const f = join(TMP, `host-${++n}.json`);
  writeFileSync(f, raw ?? JSON.stringify(body));
  return f;
};
const good = { v: 1, adminToken: TOKEN, crew: 'nfwz', server: SERVER, writtenAt: '2026-10-07T12:00:00.000Z' };

/** the client's parser (apps/client/src/core/context.ts parseHash), to prove the shell's URLs round-trip */
function clientParseHash(hash) {
  const parts = hash.replace(/^#/, '').split('&').filter(Boolean);
  let code = '';
  let admin = null;
  for (const p of parts) {
    if (p.startsWith('admin=')) admin = decodeURIComponent(p.slice(6));
    else if (!code) code = p.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  return { code, admin };
}

describe('host rights (src/host.cjs)', () => {
  test('loopback origins only', () => {
    for (const o of ['http://127.0.0.1:3000', 'http://127.4.5.6', 'http://localhost:3000', 'https://localhost', 'http://[::1]:3000']) assert.equal(isLoopbackOrigin(o), true, o);
    for (const o of ['https://play.dead-air.io', 'http://127.0.0.1.evil.example', 'http://0.0.0.0:3000', 'http://192.168.1.5:3000', 'file:///C:/x', 'nonsense', '']) assert.equal(isLoopbackOrigin(o), false, o);
  });
  test('a valid file for this server', () => {
    const r = readHostRights(hostFile(good), SERVER);
    assert.deepEqual(r, { ok: true, token: TOKEN, crew: 'NFWZ', why: '' });
  });
  test('UTF-8 BOM is fine (PowerShell writes one)', () => {
    assert.equal(readHostRights(hostFile(null, `\uFEFF${JSON.stringify(good)}`), SERVER).ok, true);
  });
  test('never for a non-loopback game server, even with a valid file', () => {
    const f = hostFile({ ...good, server: 'https://play.dead-air.io' });
    const r = readHostRights(f, 'https://play.dead-air.io');
    assert.equal(r.ok, false);
    assert.equal(r.token, '');
    assert.match(r.why, /not on this PC/);
  });
  test('the file must be for exactly this server (a :3000 token never goes to a :3901 test server)', () => {
    assert.equal(readHostRights(hostFile(good), 'http://127.0.0.1:3901').ok, false);
    assert.equal(readHostRights(hostFile({ ...good, server: 'http://localhost:3000' }), SERVER).ok, false);
    assert.equal(readHostRights(hostFile({ ...good, server: undefined }), SERVER).ok, false);
    assert.match(readHostRights(hostFile(good), 'http://127.0.0.1:3901').why, /for http:\/\/127\.0\.0\.1:3000/);
  });
  test('rejects bad tokens (no fragment injection) and bad files', () => {
    for (const adminToken of ['short', `${TOKEN}&admin=x`, `${TOKEN}#X`, 'a'.repeat(129), 42, null, `${TOKEN} `]) {
      const r = readHostRights(hostFile({ ...good, adminToken }), SERVER);
      assert.equal(r.ok, false, String(adminToken));
      assert.equal(r.token, '');
    }
    assert.equal(readHostRights(hostFile({ ...good, v: 2 }), SERVER).ok, false);
    assert.equal(readHostRights(hostFile(null, 'not json'), SERVER).ok, false);
    assert.equal(readHostRights(hostFile([good]), SERVER).ok, false);
    assert.equal(readHostRights(hostFile(null, JSON.stringify({ ...good, pad: 'x'.repeat(5000) })), SERVER).ok, false);
    assert.match(readHostRights(join(TMP, 'missing.json'), SERVER).why, /no host file/);
    const dir = join(TMP, 'adir');
    mkdirSync(dir);
    assert.equal(readHostRights(dir, SERVER).ok, false);
  });
  test('a symlink is never followed', (t) => {
    const target = hostFile(good);
    const link = join(TMP, 'link.json');
    try {
      symlinkSync(target, link, 'file');
    } catch {
      t.skip('creating symlinks needs Developer Mode / admin on Windows');
      return;
    }
    assert.equal(readHostRights(link, SERVER).ok, false);
  });
  test('a bad crew code just means no crew', () => {
    const r = readHostRights(hostFile({ ...good, crew: 'way-too-long-code' }), SERVER);
    assert.equal(r.ok, true);
    assert.equal(r.crew, '');
  });
});

describe('game URLs (src/gameurl.cjs)', () => {
  test('first load carries crew + token in the fragment; the client reads both', () => {
    const u = buildGameUrl(SERVER, '', 'NFWZ', TOKEN);
    assert.equal(u, `${SERVER}/#NFWZ&admin=${TOKEN}`);
    assert.deepEqual(clientParseHash(new URL(u).hash), { code: 'NFWZ', admin: TOKEN });
    const v = buildGameUrl(SERVER, 'test=1&preset=low', '', TOKEN);
    assert.equal(v, `${SERVER}/?test=1&preset=low#admin=${TOKEN}`);
    assert.deepEqual(clientParseHash(new URL(v).hash), { code: '', admin: TOKEN });
    assert.equal(new URL(v).search, '?test=1&preset=low'); // the token is never in the query (sent over HTTP)
  });
  test('later loads: no token', () => {
    assert.equal(buildGameUrl(SERVER, '', 'NFWZ'), `${SERVER}/#NFWZ`);
    assert.equal(buildGameUrl(SERVER, 'test=1', ''), `${SERVER}/?test=1`);
    assert.equal(buildGameUrl(SERVER, '', '', ''), `${SERVER}/`);
  });
  test('crewOfUrl skips admin= parts like the client', () => {
    assert.equal(crewOfUrl(`${SERVER}/#NFWZ&admin=${TOKEN}`), 'NFWZ');
    assert.equal(crewOfUrl(`${SERVER}/#admin=${TOKEN}`), '');
    assert.equal(crewOfUrl(`${SERVER}/#admin=${TOKEN}&kfrt`), 'KFRT');
    assert.equal(crewOfUrl(`${SERVER}/`), '');
    assert.equal(crewOfUrl('about:blank'), '');
  });
  test('withParam / hasParam: the configured query wins', () => {
    assert.equal(withParam('', 'preset', 'low'), 'preset=low');
    assert.equal(withParam('test=1', 'preset', 'low'), 'test=1&preset=low');
    assert.equal(withParam('?test=1', 'preset', 'low'), 'test=1&preset=low');
    assert.equal(withParam('preset=ultra&test=1', 'preset', 'low'), 'preset=ultra&test=1');
    assert.equal(hasParam('webgl=1', 'webgl'), true);
    assert.equal(hasParam('test=1', 'preset'), false);
  });
});

describe('unclean-exit marker (src/session.cjs)', () => {
  const boot = Date.parse('2026-10-07T11:25:50.000Z');
  const m = (over = {}) => ({ v: 1, pid: 4242, startedAt: '2026-10-07T11:30:00.000Z', beatAt: '2026-10-07T11:40:00.000Z', version: '0.1.0', phase: 'menu', gpuFailures: 0, safe: '', ...over });
  test('no marker = a clean last exit', () => {
    assert.deepEqual(assessPrevious(null, { locked: true, bootTimeMs: boot, isAlive: () => true }), { unclean: false, note: '' });
  });
  test('default profile (single-instance lock): any marker = unclean', () => {
    const r = assessPrevious(m(), { locked: true, bootTimeMs: boot, isAlive: () => true });
    assert.equal(r.unclean, true);
    assert.match(r.note, /never quit/);
    assert.match(r.note, /menu/);
  });
  test('a marker from before the last boot = Windows restarted under it (BSOD / hard reset)', () => {
    const r = assessPrevious(m({ startedAt: '2026-10-07T11:19:05.000Z', beatAt: '2026-10-07T11:24:00.000Z', gpuFailures: 1 }), { locked: false, bootTimeMs: boot, isAlive: () => true });
    assert.equal(r.unclean, true);
    assert.match(r.note, /Windows restarted/);
    assert.match(r.note, /1 GPU failure/);
  });
  test('test profiles: a live owner is not a crash, a dead one is', () => {
    assert.equal(assessPrevious(m(), { locked: false, bootTimeMs: boot, isAlive: () => true }).unclean, false);
    assert.equal(assessPrevious(m(), { locked: false, bootTimeMs: boot, isAlive: () => false }).unclean, true);
  });
  test('write / read / remove', () => {
    const f = join(TMP, 'running.json');
    assert.equal(writeMarker(f, m()), true);
    assert.deepEqual(readMarker(f), m());
    assert.equal(existsSync(`${f}.tmp`), false);
    removeMarker(f);
    assert.equal(readMarker(f), null);
    writeFileSync(f, '{"v":2}');
    assert.equal(readMarker(f), null);
  });
});

describe('config switches (src/config.cjs)', () => {
  const where = (argv = [], env = {}) => {
    const d = mkdtempSync(join(TMP, 'cfg-'));
    return loadConfig({ appDir: d, exeDir: d, userDataDir: d, argv, env });
  };
  test('defaults: menu throttling + safe mode on, on-screen window', () => {
    const { config } = where();
    assert.equal(config.gpu.throttleHiddenMenu, true);
    assert.equal(config.gpu.safeModeAfterCrash, true);
    assert.equal(config.window.offscreen, false);
  });
  test('command line and env', () => {
    const { config } = where(['--no-menu-throttle', '--no-safe-mode', '--offscreen-window']);
    assert.equal(config.gpu.throttleHiddenMenu, false);
    assert.equal(config.gpu.safeModeAfterCrash, false);
    assert.equal(config.window.offscreen, true);
    assert.equal(where([], { DEADAIR_OFFSCREEN: '1' }).config.window.offscreen, true);
    assert.equal(where([], { DEADAIR_OFFSCREEN: '0' }).config.window.offscreen, false);
  });
  test('config file values', () => {
    const d = mkdtempSync(join(TMP, 'cfgf-'));
    writeFileSync(join(d, 'config.json'), JSON.stringify({ gpu: { throttleHiddenMenu: false, safeModeAfterCrash: 'yes' } }));
    const { config } = loadConfig({ appDir: d, exeDir: d, userDataDir: join(d, 'u'), argv: [], env: {} });
    assert.equal(config.gpu.throttleHiddenMenu, false);
    assert.equal(config.gpu.safeModeAfterCrash, true); // not a boolean: the default
    assert.equal(config.gpu.highPerformance, true); // objects merge
  });
  test('a config file can never make the window off-screen (only --offscreen-window / DEADAIR_OFFSCREEN)', () => {
    const d = mkdtempSync(join(TMP, 'cfgo-'));
    writeFileSync(join(d, 'config.json'), JSON.stringify({ window: { offscreen: true, width: 1280 } }));
    const { config } = loadConfig({ appDir: d, exeDir: d, userDataDir: join(d, 'u'), argv: [], env: {} });
    assert.equal(config.window.offscreen, false);
    assert.equal(config.window.width, 1280); // other window keys still apply
  });
});

describe('game server: friends default to play.dead-air.io, the host PC follows host.json (v1.2)', () => {
  /** an app dir (packaged config), an exe dir and a userData dir */
  const dirs = (app = {}, user = null, exe = null) => {
    const root = mkdtempSync(join(TMP, 'srv-'));
    const appDir = join(root, 'app');
    const exeDir = join(root, 'exe');
    const userDataDir = join(root, 'user');
    for (const d of [appDir, exeDir, userDataDir]) mkdirSync(d);
    writeFileSync(join(appDir, 'config.json'), JSON.stringify(app));
    if (user) writeFileSync(join(userDataDir, 'config.json'), JSON.stringify(user));
    if (exe) writeFileSync(join(exeDir, 'config.json'), JSON.stringify(exe));
    return { appDir, exeDir, userDataDir };
  };
  const hostAt = (userDataDir, body = good) => {
    const f = join(userDataDir, 'host.json');
    writeFileSync(f, JSON.stringify(body));
    return f;
  };
  test('the packaged config and the defaults say https://play.dead-air.io, not explicit', () => {
    const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '../config.json'), 'utf8'));
    assert.equal(shipped.serverUrl, 'https://play.dead-air.io');
    assert.equal(DEFAULT_SERVER, 'https://play.dead-air.io');
    const { config } = loadConfig({ ...dirs(shipped), argv: [], env: {} });
    assert.equal(config.serverUrl, 'https://play.dead-air.io');
    assert.equal(config.serverExplicit, false);
    assert.equal(loadConfig({ ...dirs({}), argv: [], env: {} }).config.serverUrl, 'https://play.dead-air.io');
  });
  test('explicit: --server, DEADAIR_SERVER_URL / SERVER_URL, a user / exe-dir / --config file', () => {
    const d = dirs({ serverUrl: 'https://play.dead-air.io' });
    assert.equal(loadConfig({ ...d, argv: ['--server=http://127.0.0.1:3901'], env: {} }).config.serverExplicit, true);
    assert.equal(loadConfig({ ...d, argv: [], env: { DEADAIR_SERVER_URL: 'http://127.0.0.1:3901' } }).config.serverExplicit, true);
    assert.equal(loadConfig({ ...d, argv: [], env: { SERVER_URL: 'http://127.0.0.1:3901' } }).config.serverSource, 'env SERVER_URL');
    const u = dirs({}, { serverUrl: 'https://friend.example' });
    const cu = loadConfig({ ...u, argv: [], env: {} }).config;
    assert.equal(cu.serverExplicit, true);
    assert.equal(cu.serverUrl, 'https://friend.example');
    assert.equal(loadConfig({ ...dirs({}, null, { serverUrl: 'http://192.168.1.5:3000' }), argv: [], env: {} }).config.serverExplicit, true);
    const extra = join(TMP, `extra-${++n}.json`);
    writeFileSync(extra, JSON.stringify({ serverUrl: 'http://127.0.0.1:3902' }));
    assert.equal(loadConfig({ ...dirs({}), argv: [`--config=${extra}`], env: {} }).config.serverExplicit, true);
    // a user config without serverUrl is not a choice; a bad explicit value falls back and is not one either
    assert.equal(loadConfig({ ...dirs({}, { window: { fullscreen: true } }), argv: [], env: {} }).config.serverExplicit, false);
    const bad = loadConfig({ ...dirs({}), argv: ['--server=ftp://x'], env: {} });
    assert.equal(bad.config.serverExplicit, false);
    assert.equal(bad.config.serverUrl, 'https://play.dead-air.io');
  });
  test('the host PC (valid host.json) plays on its local server with host rights, unless a server was chosen', () => {
    const d = dirs({ serverUrl: 'https://play.dead-air.io' });
    const f = hostAt(d.userDataDir);
    const cfg = loadConfig({ ...d, argv: [], env: {} }).config;
    const r = resolveServer(cfg, f);
    assert.deepEqual({ origin: r.origin, via: r.via }, { origin: 'http://127.0.0.1:3000', via: 'host' });
    assert.equal(readHostRights(f, r.origin).ok, true, 'host rights on the local server');
    // chosen explicitly: that server wins, and host rights stay off for anything not on loopback
    const explicit = loadConfig({ ...d, argv: ['--server=https://play.dead-air.io'], env: {} }).config;
    const e = resolveServer(explicit, f);
    assert.deepEqual({ origin: e.origin, via: e.via }, { origin: 'https://play.dead-air.io', via: 'config' });
    assert.equal(readHostRights(f, e.origin).ok, false);
  });
  test('friends (no / bad / non-loopback host.json) stay on the default server', () => {
    const d = dirs({ serverUrl: 'https://play.dead-air.io' });
    const cfg = loadConfig({ ...d, argv: [], env: {} }).config;
    assert.deepEqual(resolveServer(cfg, join(d.userDataDir, 'host.json')).origin, 'https://play.dead-air.io');
    for (const body of [{ ...good, adminToken: 'bad&token' }, { ...good, v: 2 }, { ...good, server: 'https://play.dead-air.io' }, { ...good, server: 'http://192.168.1.5:3000' }, { ...good, server: 42 }]) {
      const f = hostAt(d.userDataDir, body);
      const r = resolveServer(cfg, f);
      assert.equal(r.origin, 'https://play.dead-air.io', JSON.stringify(body));
      assert.equal(r.via, 'default');
    }
    const g2 = hostAt(d.userDataDir, null);
    writeFileSync(g2, 'not json');
    assert.equal(resolveServer(cfg, g2).via, 'default');
  });
  test('readHostFile keeps the v1 checks (token, version, size) and normalizes the server', () => {
    assert.deepEqual(readHostFile(hostFile(good)), { ok: true, token: TOKEN, crew: 'NFWZ', server: SERVER, why: '' });
    assert.equal(readHostFile(hostFile({ ...good, adminToken: `${TOKEN}#X` })).ok, false);
    assert.equal(readHostFile(hostFile({ ...good, server: 'http://127.0.0.1:3000/x?y' })).server, SERVER);
  });
  test('OPEN CONFIG never pins the default server (that would stop the host PC from following host.json)', () => {
    const cfg = loadConfig({ ...dirs({ serverUrl: 'https://play.dead-air.io' }), argv: [], env: {} }).config;
    const t = JSON.parse(userTemplate(cfg, 'http://127.0.0.1:3000'));
    assert.equal('serverUrl' in t, false);
    assert.match(String(t.$serverUrl), /127\.0\.0\.1:3000/);
    const chosen = loadConfig({ ...dirs({}), argv: ['--server=http://127.0.0.1:3901'], env: {} }).config;
    assert.equal(JSON.parse(userTemplate(chosen)).serverUrl, 'http://127.0.0.1:3901');
  });
});
