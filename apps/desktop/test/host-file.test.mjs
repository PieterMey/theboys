// tools/host.mjs -> the desktop app's host-rights file: written atomically with a user-only ACL, readable by the
// shell (src/host.cjs), never printed. Uses a temp file (never %APPDATA%\DEAD AIR\host.json) and a fake token.
//   node --test apps/desktop/test/
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { desktopHostFile, writeDesktopHost } from '../../../tools/host.mjs';

const require = createRequire(import.meta.url);
const { readHostRights } = require('../src/host.cjs');

const TMP = mkdtempSync(join(tmpdir(), 'deadair-hostfile-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const FAKE = { adminToken: 'feedfacecafebeef0123456789abcdef', crew: 'TSTA' };

/** runs fn with console output captured */
function quiet(fn) {
  const out = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a) => out.push(a.join(' '));
  console.warn = (...a) => out.push(a.join(' '));
  try {
    return { value: fn(), out: out.join('\n') };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

describe('tools/host.mjs desktop host file', () => {
  test('location: DEADAIR_HOST_FILE, else %APPDATA%\\DEAD AIR\\host.json', () => {
    assert.equal(desktopHostFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), join('C:\\Users\\x\\AppData\\Roaming', 'DEAD AIR', 'host.json'));
    assert.equal(desktopHostFile({ DEADAIR_HOST_FILE: join(TMP, 'h.json'), APPDATA: 'C:\\nope' }), resolve(TMP, 'h.json'));
  });

  test('writes a file the shell accepts for exactly that server, prints only the path', () => {
    const file = join(TMP, 'DEAD AIR', 'host.json');
    const { value, out } = quiet(() => writeDesktopHost(FAKE, 3901, file));
    assert.equal(value, file);
    assert.ok(!out.includes(FAKE.adminToken), 'the token is never printed');
    assert.ok(out.includes(file));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual({ ...j, writtenAt: 'x' }, { v: 1, adminToken: FAKE.adminToken, crew: 'TSTA', server: 'http://127.0.0.1:3901', writtenAt: 'x' });
    assert.deepEqual(readHostRights(file, 'http://127.0.0.1:3901'), { ok: true, token: FAKE.adminToken, crew: 'TSTA', why: '' });
    assert.equal(readHostRights(file, 'http://127.0.0.1:3000').ok, false);
    // no temp file left behind
    assert.deepEqual(readdirSync(join(TMP, 'DEAD AIR')), ['host.json']);
    // rewritten on every start (atomic rename over the old one)
    const again = quiet(() => writeDesktopHost({ ...FAKE, crew: 'TSTB' }, 3901, file));
    assert.equal(again.value, file);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).crew, 'TSTB');
  });

  test('user-only ACL: no inherited entries, no other principals', (t) => {
    if (process.platform !== 'win32') return t.skip('Windows ACL');
    const file = join(TMP, 'acl', 'host.json');
    quiet(() => writeDesktopHost(FAKE, 3901, file));
    const r = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [file], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const aces = r.stdout.split(/\r?\n/).map((l) => l.replace(file, '').trim()).filter((l) => /\(/.test(l) && !/Successfully processed/i.test(l));
    assert.equal(aces.length, 1, `exactly one ACE, got: ${JSON.stringify(aces)}`);
    assert.match(aces[0], /\(F\)$/);
    assert.doesNotMatch(aces[0], /\(I\)/);
    assert.doesNotMatch(aces[0], /Administrators|SYSTEM|Everyone|\\Users\b|Authenticated/i);
  });

  test('no token / crew in the state -> nothing written', () => {
    const file = join(TMP, 'none', 'host.json');
    const { value, out } = quiet(() => writeDesktopHost({ crew: 'TSTA' }, 3901, file));
    assert.equal(value, null);
    assert.equal(existsSync(file), false);
    assert.match(out, /not written/);
    assert.equal(quiet(() => writeDesktopHost({ adminToken: 'bad&token&1234567890', crew: 'TSTA' }, 3901, file)).value, null);
  });

  test('--no-desktop skips it', () => {
    const file = join(TMP, 'skip', 'host.json');
    process.argv.push('--no-desktop');
    try {
      assert.equal(quiet(() => writeDesktopHost(FAKE, 3901, file)).value, null);
    } finally {
      process.argv.pop();
    }
    assert.equal(existsSync(file), false);
  });
});
