// SteamPipe build scripts for the DEAD AIR desktop depot (docs/STEAM.md, "Build and upload").
// Fills apps/desktop/steam/{app,depot}_build.vdf.template from options / environment variables, writes the result to
// apps/desktop/.steam-build/ (gitignored) and prints the steamcmd command to run. It never runs steamcmd, never
// uploads and never takes a password or Steam Guard code: you run steamcmd yourself and type those into it.
//
//   node apps/desktop/scripts/steam-vdf.mjs --app-id N [options]
//   npm run steam:vdf -w @dead-air/desktop -- --app-id N [options]
//     --app-id N        your Steam App ID (env STEAM_APP_ID; else config.json steam.appId unless it is 480)
//     --depot-id N      the Windows depot (env STEAM_DEPOT_ID; default App ID + 1, the depot Steamworks creates)
//     --branch NAME     set the build live on this beta branch once it is uploaded (env STEAM_BRANCH). Never
//                       "default": SteamPipe can't, set the default branch live in Steamworks (SteamPipe > Builds)
//     --desc TEXT       build description in Steamworks (env STEAM_BUILD_DESC; default: version, shell build, commit)
//     --preview         dry run: steamcmd checks and logs the depot but uploads nothing
//     --content DIR     the packed app (default apps/desktop/out/win-unpacked, made by scripts/pack.mjs)
//     --out DIR         where the .vdf files go (default apps/desktop/.steam-build)
//     --steamcmd PATH   steamcmd.exe for the printed command (env STEAMCMD)
//     --login NAME      your build account's name for the printed command (env STEAM_BUILD_LOGIN). Never a password.
//     --allow-mismatch  write the scripts even if the packed app targets another App ID or a server on this PC
//     --json            print a JSON summary instead of text
// Relative --content / --out paths resolve from the current folder.
// Exit codes: 0 written, 1 refused (a bad value, or a build that must not go to Steam), 2 bad usage.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DESKTOP = resolve(import.meta.dirname, '..');
const REPO = resolve(DESKTOP, '../..');
export const TEMPLATES = join(DESKTOP, 'steam');
const SPACEWAR = 480;
const MAX_ID = 0xffffffff;
const EOL = process.platform === 'win32' ? '\r\n' : '\n';
const PACK_HINT = 'node apps/desktop/scripts/pack.mjs --server-url https://play.dead-air.io --app-id';

/** Bad command line (exit 2). */
export class UsageError extends Error {}

/** The scripts were not written: every reason, and whether --allow-mismatch would have written them (exit 1). */
export class Refusal extends Error {
  /** @param {string[]} reasons @param {boolean} overridable */
  constructor(reasons, overridable) {
    super(reasons.join('; '));
    this.reasons = reasons;
    this.overridable = overridable;
  }
}

/**
 * @typedef {{
 *   appId?: string, depotId?: string, branch?: string, desc?: string, content?: string, out?: string,
 *   steamcmd?: string, login?: string, preview: boolean, allowMismatch: boolean, json: boolean, help: boolean
 * }} CliOptions
 * @typedef {'appId' | 'depotId' | 'branch' | 'desc' | 'content' | 'out' | 'steamcmd' | 'login'} ValueKey
 * @typedef {'preview' | 'allowMismatch' | 'json' | 'help'} FlagKey
 */

/** @type {Record<string, ValueKey>} */
const VALUE_OPTS = {
  'app-id': 'appId', 'depot-id': 'depotId', branch: 'branch', desc: 'desc',
  content: 'content', out: 'out', steamcmd: 'steamcmd', login: 'login',
};
/** @type {Record<string, FlagKey>} */
const FLAG_OPTS = { preview: 'preview', 'allow-mismatch': 'allowMismatch', json: 'json', help: 'help' };
/** anything that looks like a credential: refused before its value is ever read (and never echoed) */
const SECRET_OPT = /^-{1,2}(pass(word)?|pwd?|secret|guard|code|auth(code)?|token|totp|2fa|otp)(=|$)/i;

const HELP = `steam-vdf: writes the SteamPipe scripts for the DEAD AIR depot (never uploads; see docs/STEAM.md)
  node apps/desktop/scripts/steam-vdf.mjs --app-id N [--depot-id N] [--branch NAME] [--desc TEXT] [--preview]
      [--content DIR] [--out DIR] [--steamcmd PATH] [--login NAME] [--allow-mismatch] [--json]
  env: STEAM_APP_ID STEAM_DEPOT_ID STEAM_BRANCH STEAM_BUILD_DESC STEAMCMD STEAM_BUILD_LOGIN
  It never takes a password or Steam Guard code: steamcmd asks for those when you run it.`;

/** @param {string[]} argv @returns {CliOptions} */
export function parseArgs(argv) {
  /** @type {CliOptions} */
  const o = { preview: false, allowMismatch: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (SECRET_OPT.test(a)) {
      throw new UsageError(`${a.split('=')[0]}: steam-vdf never takes a password or Steam Guard code. steamcmd asks for them when you run it.`);
    }
    if (a === '-h') { o.help = true; continue; }
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${JSON.stringify(a)}`);
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (Object.hasOwn(FLAG_OPTS, name)) {
      if (eq > 0) throw new UsageError(`--${name} takes no value`);
      o[FLAG_OPTS[name]] = true;
      continue;
    }
    if (!Object.hasOwn(VALUE_OPTS, name)) throw new UsageError(`unknown option --${name}`);
    let v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined || (eq < 0 && v.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
    v = v.trim();
    if (!v) throw new UsageError(`--${name} needs a value`);
    o[VALUE_OPTS[name]] = v;
  }
  return o;
}

/**
 * A Steam App ID or depot ID (unsigned 32-bit, never 0).
 * @param {string} what @param {string | undefined} v
 * @returns {number | undefined}
 */
function steamId(what, v) {
  if (v === undefined || String(v).trim() === '') return undefined;
  const s = String(v).trim();
  if (!/^\d{1,10}$/.test(s) || Number(s) < 1 || Number(s) > MAX_ID) {
    throw new Error(`${what} must be a whole number from 1 to ${MAX_ID} (got ${JSON.stringify(s.slice(0, 40))})`);
  }
  return Number(s);
}

/**
 * The beta branch for SetLive, or null (do not set live). SteamPipe can't set the default branch ("public") live.
 * @param {string | undefined} raw
 * @returns {string | null}
 */
export function checkBranch(raw) {
  const b = String(raw ?? '').trim();
  if (!b) return null;
  if (/^(default|public)$/i.test(b)) {
    throw new Error(`SteamPipe cannot set a build live on the default branch ("${b}"): leave --branch out and set it live in Steamworks (SteamPipe > Builds)`);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(b)) {
    throw new Error(`branch ${JSON.stringify(b.slice(0, 80))}: use the branch name exactly as created in Steamworks (letters, digits, - and _, no spaces)`);
  }
  return b;
}

/** @param {string | undefined} raw @returns {string | null} a Steam account name, only for the printed command */
function checkLogin(raw) {
  const l = String(raw ?? '').trim();
  if (!l) return null;
  if (!/^[A-Za-z0-9_]{3,64}$/.test(l)) throw new Error('--login: a Steam account name has 3 to 64 letters, digits or _ (and steam-vdf never takes the password)');
  return l;
}

/**
 * The build description as one VDF-safe line: no quotes, backslashes or control characters, at most 200 characters.
 * @param {string} s
 */
export function cleanDesc(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f"]+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim();
}

/**
 * A folder for a VDF value: relative to the folder the VDF file is in (SteamPipe resolves it from there), with the
 * platform separator and a trailing one, like Valve's samples ("..\content\"). Another drive gives an absolute path.
 * @param {string} vdfDir @param {string} dir
 */
export function vdfDir(vdfDir, dir) {
  const r = relative(vdfDir, dir) || '.';
  return r.endsWith(sep) ? r : `${r}${sep}`;
}

/** @param {string} parent @param {string} child @returns {boolean} child is parent or inside it */
function isInside(parent, child) {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/** @param {string} template @returns {string[]} the placeholder names it uses, sorted, once each */
export function placeholdersOf(template) {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
}

/**
 * Fills {{NAME}} placeholders. A value of null means "optional and absent": every line that uses it is left out.
 * A placeholder without a value, or a value with a quote or line break, is an error (it would break the VDF).
 * @param {string} template
 * @param {Record<string, string | null>} values
 * @returns {string}
 */
export function fillTemplate(template, values) {
  /** @type {string[]} */
  const out = [];
  for (const line of template.split(/\r?\n/)) {
    let drop = false;
    const filled = line.replace(PLACEHOLDER, (_m, key) => {
      if (!Object.hasOwn(values, key)) throw new Error(`template placeholder {{${key}}} has no value`);
      const v = values[key];
      if (v === null) {
        drop = true;
        return '';
      }
      if (/["\r\n]/.test(v)) throw new Error(`the value for {{${key}}} contains a quote or a line break`);
      return v;
    });
    if (!drop) out.push(filled);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return `${out.join(EOL)}${EOL}`;
}

/**
 * The depot template's FileExclusion patterns as regular expressions over paths relative to the content root
 * ('*' and '?' wildcards, '\' or '/' as the separator, case-insensitive like Windows).
 * @param {string} depotTemplate
 * @returns {RegExp[]}
 */
export function exclusionPatterns(depotTemplate) {
  return [...depotTemplate.matchAll(/"FileExclusion"\s+"([^"]+)"/g)].map((m) => {
    let re = '';
    for (const c of m[1]) {
      if (c === '*') re += '.*';
      else if (c === '?') re += '[^\\\\/]';
      else if (c === '\\' || c === '/') re += '[\\\\/]';
      else re += c.replace(/[.+^${}()|[\]]/g, '\\$&');
    }
    return new RegExp(`^${re}$`, 'i');
  });
}

/** @param {string} file @returns {any} parsed JSON, or null when missing / unreadable */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v ? v : null);

/** @param {string} url @returns {boolean} an http(s) URL whose host is this PC */
function isLoopbackUrl(url) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * @typedef {{ mode: string | null, serverUrl: string | null, appId: number | null, steamEnabled: boolean | null }} ShellSettings
 * @typedef {{
 *   dir: string, exists: boolean, exe: boolean, asar: boolean, files: number, bytes: number, excluded: string[],
 *   version: string | null, shellBuild: string | null, packedAt: string | null,
 *   packed: ShellSettings | null, exeDirConfig: boolean, effective: ShellSettings,
 *   steamworksNative: boolean, readError: string | null
 * }} BuildInfo
 */

/**
 * Looks at a packed app folder (scripts/pack.mjs output): DeadAir.exe, the config packed into app.asar plus an
 * optional config.json next to the exe (it overrides the packed one at runtime), the steamworks.js native files,
 * size, and which files the depot's FileExclusion patterns drop.
 * @param {string} dir
 * @param {RegExp[]} [exclusions]
 * @returns {BuildInfo}
 */
export function inspectBuild(dir, exclusions = []) {
  /** @type {BuildInfo} */
  const info = {
    dir, exists: false, exe: false, asar: false, files: 0, bytes: 0, excluded: [],
    version: null, shellBuild: null, packedAt: null, packed: null, exeDirConfig: false,
    effective: { mode: null, serverUrl: null, appId: null, steamEnabled: null },
    steamworksNative: false, readError: null,
  };
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return info;
  info.exists = true;
  info.exe = existsSync(join(dir, 'DeadAir.exe'));
  const asarFile = join(dir, 'resources', 'app.asar');
  info.asar = existsSync(asarFile);
  /** @param {string} d */
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const rel = relative(dir, p);
        if (exclusions.some((re) => re.test(rel))) info.excluded.push(rel);
        else {
          info.files++;
          info.bytes += statSync(p).size;
        }
      }
    }
  };
  walk(dir);
  const native = join(dir, 'resources', 'app.asar.unpacked', 'vendor', 'steamworks.js', 'dist', 'win64');
  info.steamworksNative = existsSync(join(native, 'steam_api64.dll')) && existsSync(join(native, 'steamworksjs.win32-x64-msvc.node'));

  /** @type {any} */
  let packedCfg = null;
  if (info.asar) {
    try {
      // the same asar module scripts/pack.mjs uses (a dependency of electron-builder)
      const asar = createRequire(join(DESKTOP, 'package.json'))('@electron/asar');
      /** @param {string} name @returns {any} */
      const fromAsar = (name) => {
        try {
          return JSON.parse(asar.extractFile(asarFile, name).toString('utf8'));
        } catch {
          return null;
        }
      };
      packedCfg = fromAsar('config.json');
      const shell = fromAsar('shell-build.json');
      const pkg = fromAsar('package.json');
      info.shellBuild = str(shell?.build);
      info.packedAt = str(shell?.packedAt);
      info.version = str(pkg?.version);
      if (!packedCfg) info.readError = 'app.asar has no readable config.json';
    } catch (e) {
      info.readError = `cannot read app.asar: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  /** @param {any} c @returns {ShellSettings} */
  const settingsOf = (c) => ({
    mode: str(c?.mode),
    serverUrl: str(c?.serverUrl),
    appId: typeof c?.steam?.appId === 'number' ? c.steam.appId : null,
    steamEnabled: typeof c?.steam?.enabled === 'boolean' ? c.steam.enabled : null,
  });
  if (packedCfg) info.packed = settingsOf(packedCfg);
  const exeCfg = readJson(join(dir, 'config.json'));
  info.exeDirConfig = !!exeCfg;
  const p = info.packed ?? settingsOf(null);
  const x = settingsOf(exeCfg);
  info.effective = {
    mode: x.mode ?? p.mode,
    serverUrl: x.serverUrl ?? p.serverUrl,
    appId: x.appId ?? p.appId,
    steamEnabled: x.steamEnabled ?? p.steamEnabled,
  };
  return info;
}

/** @returns {string | null} the short commit of the repo's HEAD, if git is there */
function gitHead() {
  try {
    const h = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{
 *   appId: number, depotId: number, branch: string | null, desc: string | null, preview: boolean,
 *   content: string, out: string, steamcmd: string | null, login: string | null, allowMismatch: boolean, json: boolean
 * }} Settings
 */

/**
 * Command line + environment -> validated settings. The App ID falls back to config.json's steam.appId unless that is
 * still 480 (Spacewar: nobody can upload to it).
 * @param {CliOptions} o
 * @param {Record<string, string | undefined>} env
 * @param {{ cwd?: string, configFile?: string }} [where]
 * @returns {Settings}
 */
export function resolveSettings(o, env, where = {}) {
  const cwd = where.cwd ?? process.cwd();
  let appId = steamId('--app-id', o.appId) ?? steamId('STEAM_APP_ID', env.STEAM_APP_ID);
  if (appId === undefined) {
    const cfgId = readJson(where.configFile ?? join(DESKTOP, 'config.json'))?.steam?.appId;
    if (typeof cfgId === 'number' && Number.isInteger(cfgId) && cfgId > 0 && cfgId !== SPACEWAR) appId = cfgId;
  }
  if (appId === undefined) {
    throw new Error('no App ID: pass --app-id N (or set STEAM_APP_ID). apps/desktop/config.json still has 480 (Spacewar), which nobody can upload to; create your app first (docs/STEAM.md)');
  }
  if (appId === SPACEWAR) {
    throw new Error('App ID 480 is Spacewar, Valve\'s shared test app: nobody can upload builds to it. Use your own App ID (docs/STEAM.md)');
  }
  const depotId = steamId('--depot-id', o.depotId) ?? steamId('STEAM_DEPOT_ID', env.STEAM_DEPOT_ID) ?? appId + 1;
  if (depotId > MAX_ID) throw new Error(`depot ID ${depotId} is out of range: pass --depot-id`);
  if (depotId === appId) throw new Error('the depot ID must differ from the App ID (Steamworks > SteamPipe > Depots lists it; usually App ID + 1)');
  const branch = checkBranch(o.branch ?? env.STEAM_BRANCH);
  const descRaw = o.desc ?? env.STEAM_BUILD_DESC;
  const desc = descRaw !== undefined && descRaw.trim() ? cleanDesc(descRaw) : null;
  if (descRaw !== undefined && descRaw.trim() && !desc) throw new Error('--desc is empty after removing quotes and control characters');
  const steamcmdRaw = (o.steamcmd ?? env.STEAMCMD ?? '').trim();
  if (/[\u0000-\u001f"]/.test(steamcmdRaw)) throw new Error('--steamcmd: the path contains a quote or a control character');
  return {
    appId,
    depotId,
    branch,
    desc,
    preview: o.preview,
    content: resolve(cwd, o.content ?? join(DESKTOP, 'out', 'win-unpacked')),
    out: resolve(cwd, o.out ?? join(DESKTOP, '.steam-build')),
    steamcmd: steamcmdRaw ? resolve(cwd, steamcmdRaw) : null,
    login: checkLogin(o.login ?? env.STEAM_BUILD_LOGIN),
    allowMismatch: o.allowMismatch,
    json: o.json,
  };
}

/**
 * The PowerShell command that runs the upload. steamcmd prompts for the password and, the first time on a PC, the
 * Steam Guard code; with its login cached it may ask for neither.
 * @param {{ steamcmd: string | null, login: string | null, appBuildFile: string }} o
 */
export function steamcmdCommand({ steamcmd, login, appBuildFile }) {
  /** @param {string} s */
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  return `& ${q(steamcmd ?? 'steamcmd.exe')} +login ${login ?? 'YOUR_BUILD_ACCOUNT'} +run_app_build ${q(appBuildFile)} +quit`;
}

/**
 * @typedef {{
 *   appId: number, depotId: number, branch: string | null, preview: boolean, desc: string,
 *   appBuildFile: string, depotBuildFile: string, buildOutput: string, command: string,
 *   build: BuildInfo, warnings: string[], notes: string[]
 * }} Result
 */

/**
 * Checks the packed app, then writes app_build_<app>.vdf and depot_build_<depot>.vdf. Throws a Refusal (nothing
 * written) when the build must not be uploaded as it is.
 * @param {Settings} s
 * @param {{ templatesDir?: string }} [where]
 * @returns {Result}
 */
export function generate(s, where = {}) {
  const tdir = where.templatesDir ?? TEMPLATES;
  const appTpl = readFileSync(join(tdir, 'app_build.vdf.template'), 'utf8');
  const depotTpl = readFileSync(join(tdir, 'depot_build.vdf.template'), 'utf8');
  const content = resolve(s.content);
  const out = resolve(s.out);
  if (isInside(content, out)) {
    throw new Refusal([`the output folder ${out} is inside the content root ${content}: the scripts and steamcmd's cache would be uploaded too (pick another --out)`], false);
  }
  const build = inspectBuild(content, exclusionPatterns(depotTpl));
  const repack = `${PACK_HINT} ${s.appId}`;
  if (!build.exists || !build.exe || !build.asar) {
    const what = !build.exists ? `no folder at ${content}` : !build.exe ? `no DeadAir.exe in ${content}` : `no resources\\app.asar in ${content}`;
    throw new Refusal([`${what}: pack the app first (${repack})`], false);
  }
  /** @type {string[]} */
  const mismatches = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const notes = [];
  const eff = build.effective;
  if (build.readError) mismatches.push(`${build.readError}: cannot check which App ID and server the packed app uses`);
  else {
    if (eff.appId !== s.appId) {
      mismatches.push(`the packed app uses Steam App ID ${eff.appId ?? '(none)'} (config.json steam.appId), not ${s.appId}: Steam would start it as the wrong app. Re-pack: ${repack}`);
    }
    if (eff.serverUrl && isLoopbackUrl(eff.serverUrl)) {
      mismatches.push(`the packed app connects to ${eff.serverUrl}, a server on the PC it runs on: your friends' copies would find no server. Re-pack: ${repack}`);
    } else if (!eff.serverUrl) {
      warnings.push('the packed config has no serverUrl: the app falls back to http://127.0.0.1:3000');
    }
    if (eff.steamEnabled === false) warnings.push('Steam is switched off in this build (steam.enabled=false): no invites, presence or lobbies');
    if (eff.mode === 'bundled') notes.push('bundled mode: the client ships inside the app; it loads the server\'s client instead when their builds differ');
  }
  if (build.exeDirConfig) notes.push('config.json next to DeadAir.exe ships too and overrides the packed config (the checks above include it)');
  if (!build.steamworksNative) warnings.push('the steamworks.js native files are missing from resources\\app.asar.unpacked: Steam features will be off');
  if (mismatches.length) {
    if (!s.allowMismatch) throw new Refusal(mismatches, true);
    warnings.push(...mismatches.map((m) => `(allowed) ${m}`));
  }

  const head = gitHead();
  const desc = s.desc ?? cleanDesc([
    `DEAD AIR desktop ${build.version ?? '?'}`,
    `shell ${build.shellBuild ?? '?'}`,
    build.packedAt ? `packed ${build.packedAt.slice(0, 16)}Z` : '',
    head ? `git ${head}` : '',
  ].filter(Boolean).join(' '));
  const appBuildFile = join(out, `app_build_${s.appId}.vdf`);
  const depotScript = `depot_build_${s.depotId}.vdf`;
  const depotBuildFile = join(out, depotScript);
  const buildOutput = join(out, 'output');
  /** @type {Record<string, string | null>} */
  const values = {
    APP_ID: String(s.appId),
    DEPOT_ID: String(s.depotId),
    BUILD_DESC: desc,
    PREVIEW: s.preview ? '1' : null,
    BRANCH: s.branch,
    CONTENT_ROOT: vdfDir(out, content),
    BUILD_OUTPUT: vdfDir(out, buildOutput),
    DEPOT_SCRIPT: depotScript,
  };
  const appVdf = fillTemplate(appTpl, values);
  const depotVdf = fillTemplate(depotTpl, values);
  mkdirSync(buildOutput, { recursive: true });
  writeFileSync(appBuildFile, appVdf);
  writeFileSync(depotBuildFile, depotVdf);
  if (s.steamcmd && !existsSync(s.steamcmd)) warnings.push(`steamcmd not found at ${s.steamcmd} (yet)`);
  return {
    appId: s.appId, depotId: s.depotId, branch: s.branch, preview: s.preview, desc,
    appBuildFile, depotBuildFile, buildOutput,
    command: steamcmdCommand({ steamcmd: s.steamcmd, login: s.login, appBuildFile }),
    build, warnings, notes,
  };
}

/** @param {Result} r @returns {string} */
function report(r) {
  const b = r.build;
  /** @param {number} n */
  const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  const eff = b.effective;
  const lines = [
    `steam-vdf: SteamPipe scripts for App ${r.appId}, depot ${r.depotId}`,
    `  content   ${b.dir} (${b.files} files, ${mb(b.bytes)})`,
    `  build     DEAD AIR desktop ${b.version ?? '?'}, shell ${b.shellBuild ?? '?'}${b.packedAt ? `, packed ${b.packedAt}` : ''}`,
    `  shell     ${eff.mode ?? '?'} mode, server ${eff.serverUrl ?? '?'}, Steam App ${eff.appId ?? '?'}${eff.steamEnabled === false ? ' (Steam off)' : ''}`,
    `  desc      ${r.desc}`,
    r.branch
      ? `  live on   beta branch "${r.branch}" once uploaded (create it first: Steamworks > SteamPipe > Builds)`
      : '  live on   nothing yet: set the build live in Steamworks (SteamPipe > Builds)',
  ];
  if (r.preview) lines.push('  preview   yes: steamcmd checks the depot and uploads nothing');
  if (b.excluded.length) lines.push(`  excluded  ${b.excluded.length} file(s) match FileExclusion: ${b.excluded.slice(0, 5).join(', ')}${b.excluded.length > 5 ? ', ...' : ''}`);
  for (const n of r.notes) lines.push(`  note      ${n}`);
  for (const w of r.warnings) lines.push(`  WARNING   ${w}`);
  lines.push('wrote', `  ${r.appBuildFile}`, `  ${r.depotBuildFile}`);
  lines.push(
    'Run steamcmd yourself in PowerShell. It asks for the build account\'s password and, the first time on this PC,',
    'a Steam Guard code (steam-vdf never sees either):',
    `  ${r.command}`,
  );
  if (r.command.includes("'steamcmd.exe'")) lines.push('  (steamcmd.exe is in the Steamworks SDK: sdk\\tools\\ContentBuilder\\builder\\; --steamcmd PATH prints the full path)');
  if (r.command.includes('YOUR_BUILD_ACCOUNT')) lines.push('  (YOUR_BUILD_ACCOUNT: the Steam account you upload with; --login NAME fills it in)');
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {number} exit code
 */
export function main(argv, env) {
  /** @type {CliOptions} */
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`steam-vdf: ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  try {
    const r = generate(resolveSettings(o, env));
    console.log(o.json ? JSON.stringify({ ok: true, ...r }, null, 2) : report(r));
    return 0;
  } catch (e) {
    const reasons = e instanceof Refusal ? e.reasons : [e instanceof Error ? e.message : String(e)];
    const overridable = e instanceof Refusal && e.overridable;
    if (o.json) console.log(JSON.stringify({ ok: false, errors: reasons, overridable }, null, 2));
    else {
      console.error(`steam-vdf: nothing written:\n${reasons.map((m) => `  - ${m}`).join('\n')}`);
      if (overridable) console.error('  (--allow-mismatch writes the scripts anyway)');
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
