// @ts-check
'use strict';
// DEAD AIR desktop shell config. Later layers override earlier ones (objects merge, everything else replaces):
//   1. DEFAULTS below
//   2. <app>/config.json            (apps/desktop/config.json; packaged into app.asar by scripts/pack.mjs)
//   3. <exe dir>/config.json        (optional, next to DeadAir.exe: a host can pre-configure a depot)
//   4. <userData>/config.json       (optional, %APPDATA%\DEAD AIR\config.json: per user, survives Steam updates)
//   5. DEADAIR_CONFIG=<file> / --config=<file>
//   6. environment: DEADAIR_SERVER_URL (alias SERVER_URL), DEADAIR_MODE, DEADAIR_QUERY, DEADAIR_STEAM=0|1,
//      DEADAIR_STEAM_APP_ID, DEADAIR_OVERLAY=0|1, DEADAIR_DEVTOOLS=0|1, DEADAIR_BUNDLED_PORT, DEADAIR_OFFSCREEN=0|1
//   7. command line: --server=URL --bundled --remote --url-query=a=1&b=2 --no-steam --steam --steam-app-id=N
//      --steam-overlay --no-steam-overlay --devtools --fullscreen --windowed --crew=CODE --report=FILE
//      --no-menu-throttle --no-safe-mode --offscreen-window
// Profile (--profile=NAME / DEADAIR_PROFILE) is read earlier by main.cjs: it picks the userData folder.
// GPU safety (gpu.*, after the 2026-10-07 host crashes):
//   throttleHiddenMenu  while loading and in the main menu the page gets Chrome's background throttling; never in a
//                       crew (voice + net keep running). On Windows a minimized window stops drawing either way and a
//                       covered one keeps drawing either way; the client caps its own frames from the window state.
//   safeModeAfterCrash  after a GPU reset in this launch, or when the last launch ended uncleanly (BSOD, hard reset),
//                       the game page loads with ?preset=low (unless `query` already sets preset / webgl)
// window.offscreen (tests only): the window opens outside every display, inactive, unfocusable, without a taskbar
// button, and is never focused, so a GPU test never covers the user's screen.
const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {'remote' | 'bundled'} Mode
 * @typedef {{
 *   mode: Mode,
 *   serverUrl: string,
 *   query: string,
 *   bundled: { port: number, checkBuild: boolean },
 *   window: { width: number, height: number, fullscreen: boolean, rememberBounds: boolean, offscreen: boolean },
 *   steam: {
 *     enabled: boolean, appId: number, overlay: boolean, overlayDisableDirectComposition: boolean,
 *     lobby: boolean, lobbySize: number, restartIfNecessary: boolean, presenceToken: string,
 *     richPresenceConnect: boolean, autoPresence: boolean
 *   },
 *   gpu: {
 *     highPerformance: boolean, unsafeWebGPU: boolean, ignoreBlocklist: boolean,
 *     throttleHiddenMenu: boolean, safeModeAfterCrash: boolean
 *   },
 *   splash: { enabled: boolean, maxMs: number },
 *   devtools: boolean,
 *   allowedOrigins: string[],
 *   crew: string,
 *   report: string,
 *   steamSelftest: boolean,
 * }} DesktopConfig
 */

/** @type {DesktopConfig} */
const DEFAULTS = {
  mode: 'remote',
  serverUrl: 'http://127.0.0.1:3000',
  query: '',
  bundled: { port: 43117, checkBuild: true },
  window: { width: 1600, height: 900, fullscreen: false, rememberBounds: true, offscreen: false },
  steam: {
    enabled: true,
    appId: 480,
    overlay: false,
    overlayDisableDirectComposition: false,
    lobby: true,
    lobbySize: 6,
    restartIfNecessary: true,
    presenceToken: '#Status',
    richPresenceConnect: false,
    autoPresence: true,
  },
  gpu: { highPerformance: true, unsafeWebGPU: false, ignoreBlocklist: false, throttleHiddenMenu: true, safeModeAfterCrash: true },
  splash: { enabled: true, maxMs: 45000 },
  devtools: false,
  allowedOrigins: [],
  crew: '',
  report: '',
  steamSelftest: false,
};

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge for plain objects; arrays and scalars replace. Unknown keys are kept (validated later). */
/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b */
function merge(a, b) {
  /** @type {Record<string, unknown>} */
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k.startsWith('$')) continue; // "$comment" etc.
    out[k] = isObj(v) && isObj(out[k]) ? merge(/** @type {Record<string, unknown>} */ (out[k]), v) : v;
  }
  return out;
}

/**
 * @param {string} file
 * @param {string[]} loaded
 * @param {string[]} problems
 * @returns {Record<string, unknown>}
 */
function readJson(file, loaded, problems) {
  try {
    if (!file || !fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const j = JSON.parse(raw);
    if (!isObj(j)) {
      problems.push(`${file}: not a JSON object`);
      return {};
    }
    loaded.push(file);
    return j;
  } catch (e) {
    problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/** @param {string | undefined} v @returns {boolean | undefined} */
function envBool(v) {
  if (v === undefined || v === '') return undefined;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

/**
 * --name=value / --name (boolean) from argv. Chromium ignores switches it does not know.
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | true | undefined}
 */
function argOf(argv, name) {
  const pre = `--${name}=`;
  for (const a of argv) {
    if (a === `--${name}`) return true;
    if (a.startsWith(pre)) return a.slice(pre.length);
  }
  return undefined;
}

/** Normalizes a server URL to its origin (the client always uses root paths: /, /ws, /assets/, /api/). */
/** @param {unknown} v @returns {string | null} */
function normalizeServer(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  let s = v.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** @param {unknown} v @returns {string} crew code as the client accepts it ('' if invalid) */
function normalizeCrew(v) {
  if (typeof v !== 'string') return '';
  const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length >= 1 && c.length <= 8 ? c : '';
}

/**
 * @param {unknown} v @param {number} lo @param {number} hi @param {number} dflt
 * @returns {number}
 */
function int(v, lo, hi, dflt) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
}

/** @param {unknown} v @param {boolean} dflt */
function bool(v, dflt) {
  return typeof v === 'boolean' ? v : dflt;
}

/**
 * @param {{ appDir: string, exeDir: string, userDataDir: string, argv?: string[], env?: NodeJS.ProcessEnv }} where
 * @returns {{ config: DesktopConfig, sources: string[], problems: string[] }}
 */
function loadConfig(where) {
  const argv = where.argv ?? process.argv;
  const env = where.env ?? process.env;
  /** @type {string[]} */
  const loaded = [];
  /** @type {string[]} */
  const problems = [];

  /** @type {Record<string, unknown>} */
  let c = /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(DEFAULTS)));
  const files = [path.join(where.appDir, 'config.json')];
  const exeCfg = path.join(where.exeDir, 'config.json');
  if (path.resolve(exeCfg) !== path.resolve(files[0])) files.push(exeCfg);
  files.push(path.join(where.userDataDir, 'config.json'));
  const extra = argOf(argv, 'config');
  if (env.DEADAIR_CONFIG) files.push(env.DEADAIR_CONFIG);
  if (typeof extra === 'string') files.push(extra);
  for (const f of files) c = merge(c, readJson(f, loaded, problems));

  // environment
  /** @type {Record<string, unknown>} */
  const e = { steam: {}, bundled: {}, window: {} };
  const eSteam = /** @type {Record<string, unknown>} */ (e.steam);
  const eBundled = /** @type {Record<string, unknown>} */ (e.bundled);
  const serverEnv = env.DEADAIR_SERVER_URL || env.SERVER_URL;
  if (serverEnv) e.serverUrl = serverEnv;
  if (env.DEADAIR_MODE) e.mode = env.DEADAIR_MODE.toLowerCase();
  if (env.DEADAIR_QUERY !== undefined) e.query = env.DEADAIR_QUERY;
  if (envBool(env.DEADAIR_STEAM) !== undefined) eSteam.enabled = envBool(env.DEADAIR_STEAM);
  if (env.DEADAIR_STEAM_APP_ID) eSteam.appId = Number(env.DEADAIR_STEAM_APP_ID);
  if (envBool(env.DEADAIR_OVERLAY) !== undefined) eSteam.overlay = envBool(env.DEADAIR_OVERLAY);
  if (envBool(env.DEADAIR_DEVTOOLS) !== undefined) e.devtools = envBool(env.DEADAIR_DEVTOOLS);
  if (env.DEADAIR_BUNDLED_PORT) eBundled.port = Number(env.DEADAIR_BUNDLED_PORT);
  if (env.DEADAIR_REPORT) e.report = env.DEADAIR_REPORT;
  // window.offscreen (an invisible, unfocusable test window) comes only from DEADAIR_OFFSCREEN / --offscreen-window,
  // never from a config file, so a stray config can't hide the app from the user
  const offscreenEnv = envBool(env.DEADAIR_OFFSCREEN);
  c = merge(c, e);

  // command line
  /** @type {Record<string, unknown>} */
  const a = { steam: {}, window: {}, gpu: {} };
  const aSteam = /** @type {Record<string, unknown>} */ (a.steam);
  const aWin = /** @type {Record<string, unknown>} */ (a.window);
  const aGpu = /** @type {Record<string, unknown>} */ (a.gpu);
  const server = argOf(argv, 'server');
  if (typeof server === 'string') a.serverUrl = server;
  if (argOf(argv, 'bundled') === true) a.mode = 'bundled';
  if (argOf(argv, 'remote') === true) a.mode = 'remote';
  const q = argOf(argv, 'url-query');
  if (typeof q === 'string') a.query = q;
  if (argOf(argv, 'no-steam') === true) aSteam.enabled = false;
  if (argOf(argv, 'steam') === true) aSteam.enabled = true;
  const appId = argOf(argv, 'steam-app-id');
  if (typeof appId === 'string') aSteam.appId = Number(appId);
  if (argOf(argv, 'steam-overlay') === true) aSteam.overlay = true;
  if (argOf(argv, 'no-steam-overlay') === true) aSteam.overlay = false;
  if (argOf(argv, 'devtools') === true) a.devtools = true;
  if (argOf(argv, 'fullscreen') === true) aWin.fullscreen = true;
  if (argOf(argv, 'windowed') === true) aWin.fullscreen = false;
  const crew = argOf(argv, 'crew');
  if (typeof crew === 'string') a.crew = crew;
  const report = argOf(argv, 'report');
  if (typeof report === 'string') a.report = report;
  if (argOf(argv, 'steam-selftest') === true) a.steamSelftest = true;
  if (argOf(argv, 'no-menu-throttle') === true) aGpu.throttleHiddenMenu = false;
  if (argOf(argv, 'no-safe-mode') === true) aGpu.safeModeAfterCrash = false;
  const offscreen = argOf(argv, 'offscreen-window') === true || offscreenEnv === true;
  c = merge(c, a);

  // validate + normalize (bad values fall back to the defaults, with a note in the log)
  const d = DEFAULTS;
  const steam = isObj(c.steam) ? c.steam : {};
  const bundled = isObj(c.bundled) ? c.bundled : {};
  const win = isObj(c.window) ? c.window : {};
  const gpu = isObj(c.gpu) ? c.gpu : {};
  const splash = isObj(c.splash) ? c.splash : {};
  const serverUrl = normalizeServer(c.serverUrl);
  if (!serverUrl) problems.push(`serverUrl ${JSON.stringify(c.serverUrl)} is not an http(s) URL; using ${d.serverUrl}`);
  const mode = c.mode === 'bundled' || c.mode === 'remote' ? c.mode : 'remote';
  if (c.mode !== mode) problems.push(`mode ${JSON.stringify(c.mode)} unknown; using remote`);
  const query = typeof c.query === 'string' ? c.query.replace(/^\?/, '').slice(0, 512) : '';
  const allowed = Array.isArray(c.allowedOrigins)
    ? c.allowedOrigins.map(normalizeServer).filter(/** @returns {o is string} */ (o) => !!o)
    : [];

  /** @type {DesktopConfig} */
  const config = {
    mode,
    serverUrl: serverUrl ?? d.serverUrl,
    query,
    bundled: { port: int(bundled.port, 1024, 65535, d.bundled.port), checkBuild: bool(bundled.checkBuild, d.bundled.checkBuild) },
    window: {
      width: int(win.width, 640, 7680, d.window.width),
      height: int(win.height, 400, 4320, d.window.height),
      fullscreen: bool(win.fullscreen, d.window.fullscreen),
      rememberBounds: bool(win.rememberBounds, d.window.rememberBounds),
      offscreen,
    },
    steam: {
      enabled: bool(steam.enabled, d.steam.enabled),
      appId: int(steam.appId, 1, 0x7fffffff, d.steam.appId),
      overlay: bool(steam.overlay, d.steam.overlay),
      overlayDisableDirectComposition: bool(steam.overlayDisableDirectComposition, d.steam.overlayDisableDirectComposition),
      lobby: bool(steam.lobby, d.steam.lobby),
      lobbySize: int(steam.lobbySize, 2, 250, d.steam.lobbySize),
      restartIfNecessary: bool(steam.restartIfNecessary, d.steam.restartIfNecessary),
      presenceToken: typeof steam.presenceToken === 'string' && /^#[A-Za-z0-9_]{1,63}$/.test(steam.presenceToken) ? steam.presenceToken : d.steam.presenceToken,
      richPresenceConnect: bool(steam.richPresenceConnect, d.steam.richPresenceConnect),
      autoPresence: bool(steam.autoPresence, d.steam.autoPresence),
    },
    gpu: {
      highPerformance: bool(gpu.highPerformance, d.gpu.highPerformance),
      unsafeWebGPU: bool(gpu.unsafeWebGPU, d.gpu.unsafeWebGPU),
      ignoreBlocklist: bool(gpu.ignoreBlocklist, d.gpu.ignoreBlocklist),
      throttleHiddenMenu: bool(gpu.throttleHiddenMenu, d.gpu.throttleHiddenMenu),
      safeModeAfterCrash: bool(gpu.safeModeAfterCrash, d.gpu.safeModeAfterCrash),
    },
    splash: { enabled: bool(splash.enabled, d.splash.enabled), maxMs: int(splash.maxMs, 3000, 600000, d.splash.maxMs) },
    devtools: bool(c.devtools, d.devtools),
    allowedOrigins: allowed,
    crew: normalizeCrew(c.crew),
    report: typeof c.report === 'string' ? c.report : '',
    steamSelftest: bool(c.steamSelftest, false),
  };
  return { config, sources: loaded, problems };
}

/** A starter file for <userData>/config.json (written by "OPEN CONFIG" on the splash when none exists). */
/** @param {DesktopConfig} cfg */
function userTemplate(cfg) {
  return `${JSON.stringify({
    $comment: 'DEAD AIR per-user settings. Only keep the keys you want to change; see docs/STEAM.md in the repo.',
    serverUrl: cfg.serverUrl,
    window: { fullscreen: cfg.window.fullscreen },
    steam: { overlay: cfg.steam.overlay },
  }, null, 2)}\n`;
}

module.exports = { DEFAULTS, loadConfig, normalizeServer, normalizeCrew, argOf, userTemplate };
