// Tests for scripts/steam-vdf.mjs and the SteamPipe templates next to this file. No steamcmd, no network, no upload:
// fake packed apps in a temp folder, the CLI spawned with a clean environment, the output parsed as KeyValues.
//   node --test apps/desktop/steam/steam-vdf.test.mjs
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  TEMPLATES, UsageError, checkBranch, cleanDesc, exclusionPatterns, fillTemplate, parseArgs, placeholdersOf,
  resolveSettings, steamcmdCommand, vdfDir,
} from '../scripts/steam-vdf.mjs';

const DESKTOP = resolve(import.meta.dirname, '..');
const SCRIPT = join(DESKTOP, 'scripts', 'steam-vdf.mjs');
const asar = createRequire(join(DESKTOP, 'package.json'))('@electron/asar');
const TMP = mkdtempSync(join(tmpdir(), 'deadair-steamvdf-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const APP = 1234560;
const DEPOT = APP + 1;
const APP_TPL = readFileSync(join(TEMPLATES, 'app_build.vdf.template'), 'utf8');
const DEPOT_TPL = readFileSync(join(TEMPLATES, 'depot_build.vdf.template'), 'utf8');
const GOOD = { mode: 'remote', serverUrl: 'https://play.example.test', steam: { enabled: true, appId: APP } };
const STEAMCMD = process.platform === 'win32' ? 'C:\\steamworks\\sdk\\tools\\ContentBuilder\\builder\\steamcmd.exe' : '/opt/steamworks/steamcmd.sh';

/**
 * Minimal KeyValues reader: quoted tokens, braces, // comments, no escape sequences (SteamPipe's own samples end paths
 * with a backslash before the closing quote). Repeated keys become arrays.
 * @param {string} text
 */
function parseVdf(text) {
  /** @type {Array<'{' | '}' | { s: string }>} */
  const toks = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{' || c === '}') { toks.push(c); i++; continue; }
    assert.equal(c, '"', `unexpected ${JSON.stringify(c)} at offset ${i}`);
    const j = text.indexOf('"', i + 1);
    assert.ok(j > i, 'unterminated string');
    assert.ok(!/[\r\n]/.test(text.slice(i + 1, j)), 'a string spans lines');
    toks.push({ s: text.slice(i + 1, j) });
    i = j + 1;
  }
  let p = 0;
  /** @returns {Record<string, any>} */
  const block = () => {
    /** @type {Record<string, any>} */
    const o = {};
    while (p < toks.length && toks[p] !== '}') {
      const k = toks[p++];
      assert.ok(typeof k === 'object', 'a key was expected');
      const v = toks[p++];
      let val;
      if (v === '{') {
        val = block();
        assert.equal(toks[p++], '}', 'unbalanced braces');
      } else {
        assert.ok(typeof v === 'object', `a value was expected after "${k.s}"`);
        val = v.s;
      }
      o[k.s] = Object.hasOwn(o, k.s) ? [].concat(o[k.s], val) : val;
    }
    return o;
  };
  const root = block();
  assert.equal(p, toks.length, 'unbalanced braces or trailing tokens');
  return root;
}

/** every value the templates need, as steam-vdf fills them */
const ALL = {
  APP_ID: String(APP), DEPOT_ID: String(DEPOT), BUILD_DESC: 'DEAD AIR desktop 0.1.0 shell abc', PREVIEW: '1', BRANCH: 'friends',
  CONTENT_ROOT: `..${sep}out${sep}win-unpacked${sep}`, BUILD_OUTPUT: `output${sep}`, DEPOT_SCRIPT: `depot_build_${DEPOT}.vdf`,
};

let n = 0;
/**
 * A fake packed app like scripts/pack.mjs makes: DeadAir.exe, resources/app.asar (config.json, shell-build.json,
 * package.json), the steamworks.js native files, plus `extra` files (relative path -> body).
 * @param {unknown} cfg @param {Record<string, string>} [extra]
 */
async function fakeBuild(cfg, extra = {}) {
  const base = join(TMP, `build-${++n}`);
  const dir = join(base, 'out', 'win-unpacked');
  const src = join(base, 'asar-src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'config.json'), JSON.stringify(cfg));
  writeFileSync(join(src, 'shell-build.json'), JSON.stringify({ build: 'abc123def456', packedAt: '2026-10-07T12:00:00.000Z' }));
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'dead-air', version: '0.1.0' }));
  mkdirSync(join(dir, 'resources'), { recursive: true });
  await asar.createPackage(src, join(dir, 'resources', 'app.asar'));
  writeFileSync(join(dir, 'DeadAir.exe'), 'MZ (fake)');
  writeFileSync(join(dir, 'LICENSES.chromium.html'), '<html></html>');
  const native = join(dir, 'resources', 'app.asar.unpacked', 'vendor', 'steamworks.js', 'dist', 'win64');
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, 'steam_api64.dll'), 'x');
  writeFileSync(join(native, 'steamworksjs.win32-x64-msvc.node'), 'x');
  for (const [rel, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, out: join(base, '.steam-build') };
}

const STEAM_ENV = ['STEAM_APP_ID', 'STEAM_DEPOT_ID', 'STEAM_BRANCH', 'STEAM_BUILD_DESC', 'STEAMCMD', 'STEAM_BUILD_LOGIN'];
/** runs the CLI without any STEAM_* variables from the developer's shell @param {string[]} args @param {Record<string, string>} [env] */
function cli(args, env = {}) {
  const e = { ...process.env };
  for (const k of STEAM_ENV) delete e[k];
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...e, ...env }, cwd: TMP, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('templates (apps/desktop/steam)', () => {
  test('use exactly the expected placeholders and plain ASCII', () => {
    assert.deepEqual(placeholdersOf(APP_TPL), ['APP_ID', 'BRANCH', 'BUILD_DESC', 'BUILD_OUTPUT', 'CONTENT_ROOT', 'DEPOT_ID', 'DEPOT_SCRIPT', 'PREVIEW']);
    assert.deepEqual(placeholdersOf(DEPOT_TPL), ['CONTENT_ROOT', 'DEPOT_ID']);
    for (const t of [APP_TPL, DEPOT_TPL]) assert.match(t, /^[\t\n\r\x20-\x7e]*$/);
  });

  test('filled, both parse as SteamPipe KeyValues with the expected keys', () => {
    const app = parseVdf(fillTemplate(APP_TPL, ALL)).AppBuild;
    assert.equal(app.AppID, String(APP));
    assert.equal(app.Desc, ALL.BUILD_DESC);
    assert.equal(app.Preview, '1');
    assert.equal(app.SetLive, 'friends');
    assert.equal(app.ContentRoot, ALL.CONTENT_ROOT);
    assert.equal(app.BuildOutput, ALL.BUILD_OUTPUT);
    assert.deepEqual(app.Depots, { [String(DEPOT)]: `depot_build_${DEPOT}.vdf` });
    const depot = parseVdf(fillTemplate(DEPOT_TPL, ALL)).DepotBuild;
    assert.equal(depot.DepotID, String(DEPOT));
    assert.equal(depot.ContentRoot, ALL.CONTENT_ROOT);
    assert.deepEqual(depot.FileMapping, { LocalPath: '*', DepotPath: '.', Recursive: '1' });
    assert.deepEqual(depot.FileExclusion, ['*.pdb', '*.log', '*.dmp', 'logs\\*']);
  });

  test('optional lines (Preview, SetLive) are left out when unset', () => {
    const text = fillTemplate(APP_TPL, { ...ALL, PREVIEW: null, BRANCH: null });
    const app = parseVdf(text).AppBuild;
    assert.equal(app.Preview, undefined);
    assert.equal(app.SetLive, undefined);
    assert.equal(app.AppID, String(APP));
    assert.doesNotMatch(text, /"Preview"|"SetLive"/);
  });

  test('rich_presence.vdf defines the token the shell sets (config.json steam.presenceToken)', () => {
    const token = JSON.parse(readFileSync(join(DESKTOP, 'config.json'), 'utf8')).steam.presenceToken;
    const rp = parseVdf(readFileSync(join(TEMPLATES, 'rich_presence.vdf'), 'utf8'));
    assert.equal(rp.lang.english.tokens[token], '%status%');
  });
});

describe('fillTemplate', () => {
  test('missing values, quotes and line breaks are errors', () => {
    assert.throws(() => fillTemplate('"A" "{{X}}"', {}), /\{\{X\}\} has no value/);
    assert.throws(() => fillTemplate('"A" "{{X}}"', { X: 'a"b' }), /quote/);
    assert.throws(() => fillTemplate('"A" "{{X}}"', { X: 'a\nb' }), /line break/);
  });
  test('null drops only the lines that use it; no placeholder is left behind', () => {
    const t = fillTemplate('one {{A}}\r\ntwo {{B}}\nthree {{A}} {{B}}\n', { A: 'a', B: null });
    assert.deepEqual(t.split(/\r?\n/).filter(Boolean), ['one a']);
    assert.doesNotMatch(fillTemplate(APP_TPL, ALL), /\{\{/);
  });
});

describe('values', () => {
  test('branch names', () => {
    assert.equal(checkBranch(undefined), null);
    assert.equal(checkBranch('  '), null);
    assert.equal(checkBranch('friends'), 'friends');
    assert.equal(checkBranch('Alpha_Test-2'), 'Alpha_Test-2');
    assert.throws(() => checkBranch('default'), /default branch/);
    assert.throws(() => checkBranch('Public'), /default branch/);
    assert.throws(() => checkBranch('my branch'), /no spaces/);
    assert.throws(() => checkBranch('a"b'), /no spaces/);
  });
  test('build descriptions are one VDF-safe line', () => {
    assert.equal(cleanDesc('test "build"\r\n\tC:\\x'), 'test build C:/x');
    assert.equal(cleanDesc('x'.repeat(500)).length, 200);
  });
  test('folders are relative to the VDF file, with a trailing separator', () => {
    const base = join(TMP, 'rel');
    assert.equal(vdfDir(join(base, '.steam-build'), join(base, 'out', 'win-unpacked')), `..${sep}out${sep}win-unpacked${sep}`);
    assert.equal(vdfDir(join(base, '.steam-build'), join(base, '.steam-build', 'output')), `output${sep}`);
    assert.equal(vdfDir(base, base), `.${sep}`);
  });
  test('FileExclusion patterns drop symbols, logs and dumps only', () => {
    const ex = exclusionPatterns(DEPOT_TPL);
    const hit = (/** @type {string} */ p) => ex.some((re) => re.test(p.split('/').join(sep)));
    for (const p of ['x.pdb', 'sub/y.PDB', 'debug.log', 'resources/crash.dmp', 'logs/a.txt']) assert.ok(hit(p), p);
    for (const p of ['DeadAir.exe', 'resources/app.asar', 'LICENSES.chromium.html', 'locales/en-US.pak', 'dxcompiler.dll', 'catalogs/x.txt']) assert.ok(!hit(p), p);
  });
  test('the printed steamcmd command never carries a password', () => {
    const c = steamcmdCommand({ steamcmd: null, login: null, appBuildFile: "C:\\it's here\\app_build_1.vdf" });
    assert.equal(c, "& 'steamcmd.exe' +login YOUR_BUILD_ACCOUNT +run_app_build 'C:\\it''s here\\app_build_1.vdf' +quit");
    const d = steamcmdCommand({ steamcmd: 'D:\\sdk\\steamcmd.exe', login: 'deadair_builds', appBuildFile: 'D:\\b\\app_build_1.vdf' });
    assert.equal(d, "& 'D:\\sdk\\steamcmd.exe' +login deadair_builds +run_app_build 'D:\\b\\app_build_1.vdf' +quit");
  });
});

describe('arguments and settings', () => {
  test('password-like options are refused without reading or echoing the value', () => {
    for (const args of [['--password', 'hunter2'], ['--password=hunter2'], ['--pass', 'hunter2'], ['--code=hunter2'], ['--token', 'hunter2']]) {
      assert.throws(
        () => parseArgs(['--app-id', '7', ...args]),
        (e) => e instanceof UsageError && /never takes a password/.test(e.message) && !e.message.includes('hunter2'),
        args.join(' '),
      );
    }
  });
  test('options, flags and usage errors', () => {
    const o = parseArgs(['--app-id', '42', '--branch=friends', '--preview', '--json', '--allow-mismatch']);
    assert.equal(o.appId, '42');
    assert.equal(o.branch, 'friends');
    assert.equal(o.preview && o.json && o.allowMismatch, true);
    assert.throws(() => parseArgs(['--nope']), UsageError);
    assert.throws(() => parseArgs(['--app-id']), /needs a value/);
    assert.throws(() => parseArgs(['--app-id', '--preview']), /needs a value/);
    assert.throws(() => parseArgs(['--preview=1']), /takes no value/);
    assert.throws(() => parseArgs(['stray']), /unexpected argument/);
  });
  test('App ID: never 480; depot defaults to App ID + 1; env and config.json fallbacks', () => {
    const cfg480 = join(TMP, 'cfg480.json');
    const cfgOwn = join(TMP, 'cfgOwn.json');
    writeFileSync(cfg480, JSON.stringify({ steam: { appId: 480 } }));
    writeFileSync(cfgOwn, JSON.stringify({ steam: { appId: 2000000 } }));
    const o = parseArgs([]);
    assert.throws(() => resolveSettings(parseArgs(['--app-id', '480']), {}, { configFile: cfg480 }), /Spacewar/);
    assert.throws(() => resolveSettings(o, {}, { configFile: cfg480 }), /no App ID/);
    assert.equal(resolveSettings(o, {}, { configFile: cfgOwn }).appId, 2000000);
    const s = resolveSettings(o, { STEAM_APP_ID: String(APP) }, { configFile: cfg480 });
    assert.equal(s.appId, APP);
    assert.equal(s.depotId, DEPOT);
    assert.equal(s.branch, null);
    assert.equal(resolveSettings(parseArgs(['--app-id', '7', '--depot-id', '9']), {}).depotId, 9);
    assert.throws(() => resolveSettings(parseArgs(['--app-id', '7', '--depot-id', '7']), {}), /must differ/);
    assert.throws(() => resolveSettings(parseArgs(['--app-id', '12ab']), {}), /whole number/);
    assert.throws(() => resolveSettings(parseArgs(['--app-id', '7', '--login', 'a b']), {}), /account name/);
  });
});

describe('CLI (spawned, temp folders only)', () => {
  /** @type {{ dir: string, out: string }} */
  let good;
  before(async () => {
    good = await fakeBuild(GOOD, { 'sub/debug.pdb': 'x', 'logs/old.log': 'x' });
  });

  test('writes both scripts and prints the steamcmd command', () => {
    const r = cli(['--app-id', String(APP), '--content', good.dir, '--out', good.out, '--branch', 'friends',
      '--desc', 'nightly "test" build', '--login', 'deadair_builds', '--steamcmd', STEAMCMD]);
    assert.equal(r.code, 0, r.err);
    const appFile = join(good.out, `app_build_${APP}.vdf`);
    const depotFile = join(good.out, `depot_build_${DEPOT}.vdf`);
    const appText = readFileSync(appFile, 'utf8');
    if (process.platform === 'win32') assert.match(appText, /\r\n/);
    const app = parseVdf(appText).AppBuild;
    assert.equal(app.AppID, String(APP));
    assert.equal(app.Desc, 'nightly test build');
    assert.equal(app.SetLive, 'friends');
    assert.equal(app.Preview, undefined);
    assert.equal(resolve(good.out, app.ContentRoot), good.dir);
    assert.equal(resolve(good.out, app.BuildOutput), join(good.out, 'output'));
    assert.ok(existsSync(join(good.out, 'output')));
    assert.deepEqual(app.Depots, { [String(DEPOT)]: `depot_build_${DEPOT}.vdf` });
    const depot = parseVdf(readFileSync(depotFile, 'utf8')).DepotBuild;
    assert.equal(depot.DepotID, String(DEPOT));
    assert.equal(resolve(good.out, depot.ContentRoot), good.dir);
    assert.ok(r.out.includes(`& '${STEAMCMD}' +login deadair_builds +run_app_build '${appFile}' +quit`), r.out);
    assert.match(r.out, /2 file\(s\) match FileExclusion/);
    assert.doesNotMatch(r.out + r.err, /password\s*[:=]/i);
  });

  test('--preview without a branch: a dry run that sets nothing live', () => {
    const out = join(TMP, 'preview-out');
    const r = cli(['--app-id', String(APP), '--content', good.dir, '--out', out, '--preview']);
    assert.equal(r.code, 0, r.err);
    const app = parseVdf(readFileSync(join(out, `app_build_${APP}.vdf`), 'utf8')).AppBuild;
    assert.equal(app.Preview, '1');
    assert.equal(app.SetLive, undefined);
    assert.match(r.out, /uploads nothing/);
    assert.match(r.out, /YOUR_BUILD_ACCOUNT/);
  });

  test('App ID from STEAM_APP_ID; the default description names the packed shell build', () => {
    const out = join(TMP, 'env-out');
    const r = cli(['--content', good.dir, '--out', out, '--json'], { STEAM_APP_ID: String(APP), STEAM_BRANCH: 'friends' });
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.ok, true);
    assert.equal(j.appId, APP);
    assert.equal(j.depotId, DEPOT);
    assert.equal(j.branch, 'friends');
    assert.match(j.desc, /^DEAD AIR desktop 0\.1\.0 shell abc123def456 packed 2026-10-07T12:00Z/);
    assert.equal(j.build.effective.serverUrl, 'https://play.example.test');
    assert.equal(parseVdf(readFileSync(j.appBuildFile, 'utf8')).AppBuild.Desc, j.desc);
  });

  test('refuses a build packed for another App ID (here 480) unless --allow-mismatch', async () => {
    const b = await fakeBuild({ ...GOOD, steam: { enabled: true, appId: 480 } });
    const r = cli(['--app-id', String(APP), '--content', b.dir, '--out', b.out]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Steam App ID 480/);
    assert.ok(r.err.includes(`--app-id ${APP}`), r.err);
    assert.match(r.err, /--allow-mismatch/);
    assert.equal(existsSync(join(b.out, `app_build_${APP}.vdf`)), false);
    const forced = cli(['--app-id', String(APP), '--content', b.dir, '--out', b.out, '--allow-mismatch']);
    assert.equal(forced.code, 0, forced.err);
    assert.match(forced.out, /WARNING\s+\(allowed\)/);
  });

  test('refuses a build whose server is on the PC it runs on (also via config.json next to the exe)', async () => {
    const b = await fakeBuild({ ...GOOD, serverUrl: 'http://127.0.0.1:3000' });
    const r = cli(['--app-id', String(APP), '--content', b.dir, '--out', b.out]);
    assert.equal(r.code, 1);
    assert.match(r.err, /127\.0\.0\.1:3000/);
    const c = await fakeBuild(GOOD, { 'config.json': JSON.stringify({ serverUrl: 'http://localhost:3000' }) });
    assert.equal(cli(['--app-id', String(APP), '--content', c.dir, '--out', c.out]).code, 1);
    // ...and an exe-dir config.json that fixes the App ID makes a 480 build acceptable (it is what the app will use)
    const d = await fakeBuild({ ...GOOD, steam: { enabled: true, appId: 480 } }, { 'config.json': JSON.stringify({ steam: { appId: APP } }) });
    const ok = cli(['--app-id', String(APP), '--content', d.dir, '--out', d.out]);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /config\.json next to DeadAir\.exe ships too/);
  });

  test('refuses App 480, the default branch, a missing build and an --out inside the content root', () => {
    const base = ['--content', good.dir, '--out', join(TMP, 'refused-out')];
    assert.equal(cli(['--app-id', '480', ...base]).code, 1);
    assert.equal(cli(['--app-id', String(APP), '--branch', 'default', ...base]).code, 1);
    const missing = cli(['--app-id', String(APP), '--content', join(TMP, 'nothing-here'), '--out', join(TMP, 'x')]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /pack the app first/);
    const inside = cli(['--app-id', String(APP), '--content', good.dir, '--out', join(good.dir, 'steam')]);
    assert.equal(inside.code, 1);
    assert.match(inside.err, /inside the content root/);
    assert.equal(existsSync(join(good.dir, 'steam')), false);
    assert.equal(existsSync(join(TMP, 'refused-out')), false);
  });

  test('never takes a password (exit 2, value not echoed)', () => {
    for (const args of [['--password', 'hunter2'], ['--password=hunter2']]) {
      const r = cli(['--app-id', String(APP), ...args]);
      assert.equal(r.code, 2);
      assert.match(r.err, /never takes a password/);
      assert.ok(!(r.out + r.err).includes('hunter2'));
    }
  });
});
