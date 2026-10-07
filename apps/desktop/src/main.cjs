// @ts-check
'use strict';
// DEAD AIR desktop shell (Electron main process). CommonJS on purpose: the Chromium switches and SteamAPI_Init
// must run synchronously before app 'ready' (the Steam overlay only hooks a D3D device created after init).
//
//   REMOTE  (default): one window loads <serverUrl>/ (e.g. https://play.<domain>); the client is unchanged.
//   BUNDLED          : the client build ships in the app and is served from http://127.0.0.1:<port>/ with /ws,
//                      /assets/ and /api/ proxied to serverUrl (src/bundled.cjs). If the server runs a different
//                      client build (it rejects stale builds), the shell falls back to REMOTE for that launch.
//
// Loading screen: the window opens at once on the shell splash (static/splash.html, its own view on top of the
// game); the game loads underneath and the splash fades out when the main menu is up and its frames are smooth
// (preload.cjs), so the first-launch shader stalls happen behind it. Config: src/config.cjs. Guide: docs/STEAM.md.
//
// GPU safety (2026-10-07: the host PC crashed five times with this app open in the main menu; the root cause is the
// GPU / driver, the app was the sustained load behind it):
//   * while loading and in the main menu the game page has Chrome's background throttling; in a crew it never does
//     (voice + net keep running). The page gets the window state (deadAirDesktop.windowState / onWindowState:
//     minimized / visible / focused) so the client can cap or hold its drawing: a covered or unfocused window keeps
//     rendering at the display rate otherwise (see applyThrottle for what was measured).
//   * a GPU process crash or a WebGPU device loss stops the game page (about:blank: nothing draws while the driver
//     recovers) under a static error screen; RELOAD continues on safe graphics (?preset=low) for the rest of the
//     launch. A launch after an unclean exit (BSOD, hard reset: src/session.cjs) starts on safe graphics too.
//   * evidence survives a crash: synchronous log writes (warnings + heartbeat fsynced), a heartbeat every 60 s
//     (GPU process memory, window state, the page's frame rate), GPU info at ready, full device-lost messages.
// Host rights on the host PC (CREATE CREW + the HOST tab without copying a link): src/host.cjs.
const T0 = Date.now();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, protocol, session, shell, screen, net, crashReporter } = require('electron');
const { loadConfig, normalizeCrew, argOf, userTemplate } = require('./config.cjs');
const { createSteam } = require('./steam.cjs');
const { startBundled, localBuild } = require('./bundled.cjs');
const { readHostRights, isLoopbackOrigin } = require('./host.cjs');
const { buildGameUrl, crewOfUrl, withParam, hasParam } = require('./gameurl.cjs');
const { readMarker, writeMarker, removeMarker, assessPrevious, pidAlive } = require('./session.cjs');

const APP_NAME = 'DEAD AIR';
const APP_USER_MODEL_ID = 'com.deadair.game';
const BG = '#020303';
const APP_DIR = path.join(__dirname, '..'); // apps/desktop in dev, resources/app.asar when packaged
const VERSION = app.getVersion();
/** packaged builds carry shell-build.json (scripts/pack.mjs: hash of src + static) so the log tells builds apart */
const SHELL_BUILD = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'shell-build.json'), 'utf8')).build || '?').slice(0, 40);
  } catch {
    return 'dev';
  }
})();

// ---------------------------------------------------------------- profile / userData (before the profile opens)
app.setName(APP_NAME);
const profileArg = argOf(process.argv, 'profile');
const PROFILE = String(typeof profileArg === 'string' ? profileArg : process.env.DEADAIR_PROFILE ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
app.setPath('userData', PROFILE ? path.join(app.getPath('appData'), APP_NAME, 'profiles', PROFILE) : path.join(app.getPath('appData'), APP_NAME));
const USER_DATA = app.getPath('userData');

// ---------------------------------------------------------------- log (<userData>/logs/desktop.log)
// Synchronous writes: a BSOD or hard reset must not take the last lines with it (on 2026-10-07 the log ended with no
// trace of what the app was doing). Warnings, errors and the heartbeat are fsynced at once, info lines within 2 s.
/** @type {number | null} */
let logFd = null;
try {
  const dir = path.join(USER_DATA, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'desktop.log');
  try { if (fs.statSync(file).size > 2_000_000) fs.renameSync(file, `${file}.old`); } catch { /* new file */ }
  logFd = fs.openSync(file, 'a');
} catch { logFd = null; }
/** values that must never reach the log (the host admin token, src/host.cjs) */
const redactions = new Set();
/** @param {string} s */
const redact = (s) => {
  let out = s.replace(/(admin=)[^&#\s"'<>]+/gi, '$1***');
  for (const r of redactions) if (r) out = out.split(r).join('***');
  return out;
};
/** @type {NodeJS.Timeout | null} */
let syncTimer = null;
const syncLog = () => {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  try { if (logFd !== null) fs.fsyncSync(logFd); } catch { /* ignore */ }
};
/** one entry per line (multi-line page errors and stacks are folded with ' | ') */
/** @param {string} level @param {string} m @param {boolean} [durable] */
const line = (level, m, durable = level !== 'INFO') => {
  const s = `${new Date().toISOString()} ${level} ${redact(String(m)).replace(/\s*\r?\n\s*/g, ' | ')}`;
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, `${s}\n`);
      if (durable) syncLog();
      else if (!syncTimer) syncTimer = setTimeout(syncLog, 2000);
    } catch { /* disk full / gone */ }
  }
  if (!app.isPackaged) (level === 'INFO' ? console.log : console.error)(s);
};
const log = {
  info: (/** @type {string} */ m) => line('INFO', m),
  warn: (/** @type {string} */ m) => line('WARN', m),
  error: (/** @type {string} */ m) => line('ERROR', m),
  /** info that must survive a crash (heartbeat, GPU state) */
  durable: (/** @type {string} */ m) => line('INFO', m, true),
};
/** URLs in logs never carry the hash (#admin=TOKEN must not land in a log) */
/** @param {string} u */
const safeUrl = (u) => String(u).split('#')[0];
/** @param {unknown} e */
const errMsg = (e) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- single instance
const gotLock = PROFILE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  boot();
}

function boot() {
  const { config: cfg, sources, problems } = loadConfig({
    appDir: APP_DIR,
    exeDir: app.isPackaged ? path.dirname(process.execPath) : APP_DIR,
    userDataDir: USER_DATA,
  });
  const serverOrigin = cfg.serverUrl;
  const serverHost = new URL(serverOrigin).host;
  log.info(`DEAD AIR desktop ${VERSION} shell ${SHELL_BUILD} (electron ${process.versions.electron}, chrome ${process.versions.chrome}) mode=${cfg.mode} server=${serverOrigin}${PROFILE ? ` profile=${PROFILE}` : ''} packaged=${app.isPackaged}`);
  log.info(`config: ${sources.length ? sources.join(', ') : '(defaults)'}`);
  for (const p of problems) log.warn(`config: ${p}`);

  // -------------------------------------------------------------- host rights (src/host.cjs)
  // <userData>\host.json = %APPDATA%\DEAD AIR\host.json for the default profile; a test profile only ever reads its
  // own folder (...\profiles\<name>\host.json), never the real token
  const host = readHostRights(path.join(USER_DATA, 'host.json'), serverOrigin);
  if (host.ok) {
    redactions.add(host.token);
    redactions.add(encodeURIComponent(host.token));
  }
  log.info(host.ok ? `host rights: on (crew ${host.crew || 'none'})` : `host rights: off (${host.why})`);

  // -------------------------------------------------------------- previous session (src/session.cjs)
  const markerFile = path.join(USER_DATA, 'running.json');
  const prev = assessPrevious(readMarker(markerFile), { locked: !PROFILE, bootTimeMs: Date.now() - os.uptime() * 1000, isAlive: pidAlive });
  if (prev.unclean) log.warn(`previous session ended uncleanly: ${prev.note}`);
  /** why this launch draws on safe graphics ('' = it does not): see config gpu.safeModeAfterCrash */
  let safeReason = prev.unclean && cfg.gpu.safeModeAfterCrash ? 'the last session ended unexpectedly' : '';

  /** @type {Record<string, any>} */
  const report = {
    version: VERSION, shell: SHELL_BUILD, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    pid: process.pid, packaged: app.isPackaged, profile: PROFILE, mode: cfg.mode, server: serverOrigin, userData: USER_DATA,
    configSources: sources, configProblems: problems, timings: {}, events: [],
    hostRights: host.ok, previousUnclean: prev.unclean,
  };
  const writeReport = () => {
    if (!cfg.report) return;
    try {
      const f = path.resolve(cfg.report);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      report.safeGraphics = safeReason;
      fs.writeFileSync(f, `${JSON.stringify(report, null, 2)}\n`);
    } catch (e) {
      log.warn(`report: ${errMsg(e)}`);
    }
  };
  /** @param {string} name */
  const mark = (name) => {
    report.timings[name] ??= Date.now() - T0;
    writeReport();
  };
  /** @param {string} what */
  const event = (what) => {
    if (report.events.length < 200) report.events.push(`${Date.now() - T0}ms ${what}`);
  };

  // -------------------------------------------------------------- Chromium switches (before ready)
  try { crashReporter.start({ uploadToServer: false }); } catch { /* local minidumps only */ }
  // the shell's own pages (loading screen) come from deadair://shell/ (read with Electron's asar-aware fs): with the
  // grantFileProtocolExtraPrivileges fuse off, file:// cannot read inside app.asar (the splash was a white error page)
  protocol.registerSchemesAsPrivileged([{ scheme: 'deadair', privileges: { standard: true, secure: true } }]);
  app.setAppUserModelId(APP_USER_MODEL_ID);
  // WebGPU is on by default on Windows (Chromium 113+); never disable hardware acceleration (also kills the overlay)
  if (cfg.gpu.highPerformance) app.commandLine.appendSwitch('force_high_performance_gpu'); // laptops: discrete GPU
  if (cfg.gpu.unsafeWebGPU) app.commandLine.appendSwitch('enable-unsafe-webgpu'); // blocklisted GPUs only
  if (cfg.gpu.ignoreBlocklist) app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  // no 'disable-renderer-backgrounding' (0.1.0 had it): a hidden menu may drop to background priority like a Chrome
  // tab. In a crew the page is never hidden (setBackgroundThrottling(false), applyThrottle), so voice + net keep their
  // priority there. Never --disable-gpu-vsync / --disable-frame-rate-limit.
  // plain-http LAN servers are not secure contexts (no WebGPU, no mic): trust exactly the configured origin
  const srvUrl = new URL(serverOrigin);
  if (srvUrl.protocol === 'http:' && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(srvUrl.hostname)) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', serverOrigin);
  }

  // -------------------------------------------------------------- Steam (synchronous, before ready)
  const steam = createSteam({ cfg: cfg.steam, log, serverOrigin });
  const st = steam.initEarly(app);
  report.steam = { enabled: st.enabled, available: st.available, appId: st.appId, overlay: st.overlay, error: st.error, personaName: st.personaName ? `(${st.personaName.length} chars)` : null };
  log.info(st.available ? `steam: ready (app ${st.appId}${st.overlay ? ', overlay on: in-process-gpu' : ''})` : `steam: off (${st.error})`);
  /** live Steam state for --report (tests read the lobby id from here) */
  const updateSteamReport = () => {
    const s = steam.snapshot();
    report.steam = { ...report.steam, lobbyId: s.lobbyId, crew: s.crew, presence: s.presence };
    writeReport();
  };
  if (st.restarting) {
    log.info('steam: relaunching through Steam');
    app.exit(0);
    return;
  }
  // Steam "Join Game" on a cold start: DeadAir.exe +connect_lobby <64-bit lobby id>
  /** @param {string[]} argv */
  const lobbyArg = (argv) => {
    const i = argv.indexOf('+connect_lobby');
    const id = i >= 0 ? argv[i + 1] ?? '' : '';
    return /^\d{1,20}$/.test(id) ? id : '';
  };
  const startLobby = lobbyArg(process.argv);

  // -------------------------------------------------------------- state
  /** @type {BrowserWindow | null} */
  let win = null;
  /** @type {WebContentsView | null} */
  let splash = null;
  /** @type {Record<string, unknown>} */
  let splashState = { phase: 'boot', step: 'Starting', pct: 2, t0: T0 };
  let gameBase = serverOrigin; // where the game page is loaded from (bundled: the local origin)
  let gameUrl = '';
  const trusted = new Set([serverOrigin, ...cfg.allowedOrigins]);
  /** @type {{ origin: string, close(): Promise<void> } | null} */
  let bundledSrv = null;
  let loadedOnce = false;
  let readyAt = 0;
  let retries = 0;
  /** @type {NodeJS.Timeout | null} */
  let retryTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let capTimer = null;
  let explicitPresence = false;
  let uiMenu = true;
  let hashCrew = '';
  let lastAuto = '';
  let consoleErrors = 0;
  let lostLogged = 0;
  let bootCrew = ''; // the launch URL's crew: RELOAD falls back to it
  let adminDelivered = false; // the client stored the host token (desktop:ready): no later URL carries it
  let parked = false; // after a GPU failure the game page sits on about:blank until RELOAD
  let gpuFailures = 0;
  let lastGpuFailureAt = 0;
  let safeLogged = '';
  let gpuLogged = false;
  let quitting = false;
  let focusFlips = 0;
  let beatSeq = 0;
  let beatPending = 0;
  /** @type {NodeJS.Timeout | null} */
  let beatTimer = null;
  const BEAT_MS = Math.max(2000, Math.min(600_000, Number(process.env.DEADAIR_BEAT_MS) || 60_000));

  /** @param {string} u */
  const originOf = (u) => {
    try { return new URL(u).origin; } catch { return ''; }
  };
  /** @param {string} u */
  const isParkUrl = (u) => String(u).startsWith('about:blank');
  /** the game page's query: the configured one, plus preset=low on safe graphics (a configured preset / webgl wins) */
  const pageQuery = () => (safeReason && !hasParam(cfg.query, 'preset') && !hasParam(cfg.query, 'webgl') ? withParam(cfg.query, 'preset', 'low') : cfg.query);
  /** the host token rides only on loads before the client has stored it, only to a loopback page origin, and only in
   *  remote mode (base === serverOrigin): a bundled page lives on a fixed local origin whatever server it proxies to,
   *  so a token stored there could later reach another server */
  /** @param {string} base */
  const adminFor = (base) => (host.ok && !adminDelivered && base === serverOrigin && isLoopbackOrigin(base) ? host.token : '');
  /** @param {string} base @param {string} crew */
  const buildUrl = (base, crew) => buildGameUrl(base, pageQuery(), crew, adminFor(base));
  const steamLabel = () => (st.available ? `STEAM · ${steam.snapshot().personaName ?? 'ONLINE'}` : cfg.steam.enabled ? 'STEAM OFFLINE' : '');

  const windowState = () => {
    const w = win && !win.isDestroyed() ? win : null;
    const minimized = !!w && w.isMinimized();
    return { minimized, visible: !!w && w.isVisible() && !minimized, focused: !!w && w.isFocused(), fullscreen: !!w && w.isFullScreen() };
  };
  /** what the page is doing, for the heartbeat + the unclean-exit marker */
  const phase = () => (parked ? 'parked' : !readyAt ? 'loading' : uiMenu ? 'menu' : 'crew');
  const saveMarker = () => writeMarker(markerFile, {
    v: 1, pid: process.pid, startedAt: new Date(T0).toISOString(), beatAt: new Date().toISOString(), version: VERSION,
    phase: phase(), gpuFailures, safe: safeReason,
  });

  /**
   * Chrome-tab background throttling while loading and in the menu; never in a crew (voice + net keep running behind
   * other windows). Measured on Windows with Electron 44 (scripts/probe.mjs, 2026-10-07): a minimized window stops
   * drawing either way (rAF ~1/s, ~0% GPU), and a covered / off-screen window keeps drawing either way (Electron has
   * no occlusion tracking on Windows). So the GPU savings in the menu come from the client's own frame caps, fed by
   * the window state sent to the page (preload: deadAirDesktop.windowState / onWindowState).
   */
  const applyThrottle = () => {
    if (!win || win.isDestroyed()) return;
    const want = cfg.gpu.throttleHiddenMenu && (uiMenu || !readyAt);
    const wc = win.webContents;
    if (wc.getBackgroundThrottling() === want) return;
    wc.setBackgroundThrottling(want);
    log.info(`throttle: ${want ? 'on (menu/loading: hidden = no frames)' : 'off (crew: voice + net keep running)'}`);
  };

  /** @param {Record<string, unknown>} s */
  const setSplash = (s) => {
    splashState = { server: new URL(gameUrl || serverOrigin).host.toUpperCase(), version: VERSION, steam: steamLabel(), mode: safeReason ? 'SAFE GRAPHICS' : '', t0: splashState.t0 ?? T0, ...s };
    try { splash?.webContents.send('splash:status', splashState); } catch { /* view gone */ }
  };

  const layoutSplash = () => {
    if (!win || !splash) return;
    const [w, h] = win.getContentSize();
    splash.setBounds({ x: 0, y: 0, width: w, height: h });
  };

  /** @param {Record<string, unknown>} [s] */
  const showSplash = (s) => {
    if (!win || !cfg.splash.enabled) return;
    if (s) {
      splashState = { t0: Date.now() };
      setSplash(s);
    }
    if (splash) return;
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.cjs'),
        // background throttling stays on (the default): the loading screen has nothing to do while hidden
        contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, devTools: cfg.devtools,
      },
    });
    view.setBackgroundColor('#00000000'); // transparent: the fade-out reveals the game underneath
    splash = view;
    win.contentView.addChildView(view);
    layoutSplash();
    view.webContents.on('will-navigate', (e) => e.preventDefault());
    view.webContents.once('did-finish-load', () => mark('splashLoaded'));
    // never leave an error page over the game: no loading screen beats a white one
    view.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      log.error(`splash failed to load (${desc || code}); continuing without it`);
      if (splash === view) hideSplash('splash-failed');
    });
    void view.webContents.loadURL('deadair://shell/splash.html').catch(() => { /* did-fail-load handles it */ });
  };

  /** @param {string} why */
  const hideSplash = (why) => {
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    const view = splash;
    if (!view) return;
    splash = null;
    try { view.webContents.send('splash:status', { ...splashState, phase: 'ready' }); } catch { /* gone */ }
    event(`splash hidden (${why})`);
    // the page fades itself out (450 ms CSS), then the view and its renderer go; a failed splash goes at once
    setTimeout(() => {
      try { win?.contentView.removeChildView(view); } catch { /* window gone */ }
      try { view.webContents.close(); } catch { /* gone */ }
      if (win && !win.isDestroyed() && !cfg.window.offscreen) win.webContents.focus();
    }, why === 'splash-failed' ? 0 : 480);
  };

  const focusWindow = () => {
    if (!win || cfg.window.offscreen) return; // tests: never take the user's focus
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  // -------------------------------------------------------------- window state
  const stateFile = path.join(USER_DATA, 'window-state.json');
  /** @returns {{ x: number, y: number, width: number, height: number, maximized?: boolean, fullscreen?: boolean } | null} */
  const readWindowState = () => {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (![s.x, s.y, s.width, s.height].every(Number.isFinite)) return null;
      const wa = screen.getDisplayMatching(s).workArea;
      const visible = s.x < wa.x + wa.width - 100 && s.x + s.width > wa.x + 100 && s.y < wa.y + wa.height - 100 && s.y + s.height > wa.y + 50;
      return visible ? s : null;
    } catch {
      return null;
    }
  };
  const saveWindowState = () => {
    if (!win || !cfg.window.rememberBounds || cfg.window.offscreen) return;
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() }));
    } catch (e) {
      log.warn(`window state: ${errMsg(e)}`);
    }
  };
  const toggleFullscreen = () => {
    if (!win) return;
    win.setFullScreen(!win.isFullScreen());
  };

  // -------------------------------------------------------------- game loading
  /** @param {string} code @param {string} message @param {{ retry?: boolean, reload?: boolean, title?: string }} [o] */
  const showError = (code, message, o = {}) => {
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    const retry = o.retry !== false;
    const delay = retry ? Math.min(30, 5 * 2 ** Math.min(retries, 3)) : 0;
    retries++;
    showSplash();
    setSplash({ phase: 'error', title: o.title ?? 'No carrier', error: { code, message, canRetry: retry, canReload: !!o.reload, retryInSec: retry ? delay : 0 } });
    event(`error ${code}`);
    log.warn(`game: ${code}: ${message}`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = retry ? setTimeout(() => loadGame(), delay * 1000) : null;
  };

  const loadGame = () => {
    if (!win) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    parked = false;
    readyAt = 0;
    applyThrottle();
    showSplash();
    setSplash({ phase: 'connecting', title: 'Clocking in', step: `Connecting to ${new URL(gameUrl).host}`, detail: '', pct: 6 });
    event(`load ${safeUrl(gameUrl)}`);
    if (safeReason && safeLogged !== safeReason) {
      safeLogged = safeReason;
      log.warn(`game: safe graphics (preset=low): ${safeReason}`);
    }
    void win.webContents.loadURL(gameUrl).catch(() => { /* did-fail-load shows it */ });
  };

  /** RELOAD on the error screen (GPU reset, renderer crash): the page's last crew, on safe graphics if they are on */
  const reloadGame = () => {
    gameUrl = buildUrl(gameBase, hashCrew || bootCrew);
    loadGame();
  };

  /**
   * The GPU process died or the page lost its WebGPU device (the client has no device-loss recovery): stop the game
   * page so nothing draws while the driver recovers, show a static error screen, and make RELOAD use safe graphics.
   * @param {string} what
   */
  const gpuFailure = (what) => {
    if (quitting) return;
    // one incident often reports twice (the page's device loss + the GPU process exit): count it once
    if (!(parked && Date.now() - lastGpuFailureAt < 5000)) gpuFailures++;
    lastGpuFailureAt = Date.now();
    if (!safeReason && cfg.gpu.safeModeAfterCrash) safeReason = 'the graphics driver reset in this session';
    gpuLogged = false; // log the GPU state again at the next ready (software fallback after repeated crashes?)
    saveMarker();
    event(`gpu failure: ${what}`);
    if (!win || win.isDestroyed() || parked) {
      log.warn(`gpu: ${what}${parked ? ' (page already stopped)' : ''}`);
      return;
    }
    parked = true;
    readyAt = 0;
    log.warn(`gpu: ${what}: the game page is stopped until RELOAD${safeReason ? ' (RELOAD uses safe graphics)' : ''}`);
    void win.webContents.loadURL('about:blank').catch(() => { /* already gone */ });
    showError('GPU reset', `The graphics driver reset. DEAD AIR stopped drawing so the driver can recover.${safeReason ? ' RELOAD continues on safe graphics (low preset);' : ' Reload to continue;'} the game resumes your crew.`, { retry: false, reload: true, title: 'Signal lost' });
  };

  /** @param {string} code */
  const joinCrew = (code) => {
    if (!win || !code) return;
    focusWindow();
    event(`join crew ${code}`);
    log.info(`join: crew ${code}${parked ? ' (from the GPU-reset screen: reloading onto it)' : ''}`);
    if (!loadedOnce || parked) {
      // nothing listens yet (first load) or any more (parked on about:blank): load the game onto the crew
      gameUrl = buildUrl(gameBase, code);
      loadGame();
      return;
    }
    win.webContents.send('desktop:join', { code });
  };

  /** @param {string} lobbyId @param {string} via */
  const joinLobby = async (lobbyId, via) => {
    if (!st.available) return '';
    if (splash) setSplash({ phase: 'joining', title: 'Joining a friend', step: 'Asking Steam for the lobby', pct: 4 });
    const r = await steam.joinLobby(lobbyId);
    event(`steam lobby ${via}: ${r.crew || r.error}`);
    if (!r.crew) log.warn(`steam: join lobby ${lobbyId} (${via}) failed: ${r.error}`);
    return r.crew;
  };

  const autoPresence = () => {
    // not while the page boots: its first menu report can lag a crew code in the URL (a lobby for a second)
    if (!cfg.steam.autoPresence || explicitPresence || !st.available || !readyAt) return;
    const crew = uiMenu ? '' : hashCrew;
    const text = crew ? `In a crew — ${crew}` : 'In the main menu';
    if (`${text}|${crew}` === lastAuto) return;
    lastAuto = `${text}|${crew}`;
    void steam.setPresence(text, crew).then(updateSteamReport);
  };

  // -------------------------------------------------------------- heartbeat (desktop.log + the marker)
  /** @param {unknown} kb */
  const mb = (kb) => Math.round((Number(kb) || 0) / 1024);
  /** @param {Record<string, unknown> | null} page */
  const logBeat = (page) => {
    const ws = windowState();
    let procs = '';
    try {
      const m = app.getAppMetrics();
      const gpu = m.find((p) => p.type === 'GPU');
      const tabPid = win && !win.isDestroyed() ? win.webContents.getOSProcessId() : 0;
      const tab = m.find((p) => p.pid === tabPid);
      if (gpu) procs += ` gpu ws=${mb(gpu.memory.workingSetSize)}MB priv=${mb(gpu.memory.privateBytes)}MB cpu=${gpu.cpu.percentCPUUsage.toFixed(1)}%`;
      if (tab) procs += ` tab ws=${mb(tab.memory.workingSetSize)}MB cpu=${tab.cpu.percentCPUUsage.toFixed(1)}%`;
    } catch { /* metrics unavailable */ }
    const pg = page
      ? ` page raf=${page.raf}/s draw=${page.draw}/s view=${page.view} vis=${page.vis} focus=${page.focus ? 1 : 0} canvas=${page.w}x${page.h} dpr=${page.dpr} preset=${page.preset}`
      : ' page -';
    const throttled = !!win && !win.isDestroyed() && win.webContents.getBackgroundThrottling();
    log.durable(`beat: ${phase()} window=${ws.minimized ? 'minimized' : ws.visible ? 'visible' : 'hidden'}${ws.focused ? '+focus' : ''}${ws.fullscreen ? '+fullscreen' : ''} focusFlips=${focusFlips} throttle=${throttled ? 'on' : 'off'}${safeReason ? ' safe' : ''}${procs}${pg}`);
    focusFlips = 0;
  };
  const beat = () => {
    saveMarker();
    if (!win || win.isDestroyed()) return;
    if (parked || !loadedOnce || beatPending) {
      logBeat(null);
      return;
    }
    const id = ++beatSeq;
    beatPending = id;
    try { win.webContents.send('desktop:stats?', id); } catch { /* gone */ }
    // a hidden page answers late (its timers run at 1 Hz) or not at all (an error page has no preload)
    setTimeout(() => {
      if (beatPending !== id) return;
      beatPending = 0;
      logBeat(null);
    }, 3500);
  };

  // -------------------------------------------------------------- security: every webContents
  /** @param {string} url */
  const openExternal = (url) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => {});
  };
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (ev) => {
      const isGame = !!win && contents === win.webContents;
      if (isGame && trusted.has(originOf(ev.url))) return;
      ev.preventDefault();
      if (isGame) openExternal(ev.url);
    });
    contents.on('will-redirect', (ev) => {
      const isGame = !!win && contents === win.webContents;
      if (ev.isMainFrame && !(isGame && trusted.has(originOf(ev.url)))) {
        ev.preventDefault();
        log.warn(`blocked redirect to ${safeUrl(ev.url)}`);
      }
    });
  });

  /** IPC from the game page's main frame on a trusted origin only. @param {Electron.IpcMainEvent | Electron.IpcMainInvokeEvent} e */
  const fromGame = (e) => {
    const f = e.senderFrame;
    return !!win && e.sender === win.webContents && !!f && !f.parent && trusted.has(originOf(f.url));
  };

  ipcMain.on('desktop:info', (e) => {
    const s = steam.snapshot();
    e.returnValue = fromGame(e)
      ? {
        version: VERSION, mode: gameBase === serverOrigin ? 'remote' : 'bundled', electron: process.versions.electron, chrome: process.versions.chrome,
        steam: { available: s.available, personaName: s.personaName, appId: s.available ? s.appId : null, overlay: s.overlay },
        window: windowState(), safeGraphics: safeReason,
      }
      : null;
  });
  ipcMain.handle('desktop:steam:invite', async (e) => {
    if (!fromGame(e)) return { ok: false, how: 'none', error: 'untrusted' };
    const crew = hashCrew || crewOfUrl(win?.webContents.getURL() ?? '');
    return steam.inviteFriends(uiMenu ? '' : crew);
  });
  ipcMain.handle('desktop:steam:presence', async (e, text, connect) => {
    if (!fromGame(e)) return false;
    explicitPresence = true;
    const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    const ok = await steam.setPresence(t, normalizeCrew(String(connect ?? '')));
    updateSteamReport();
    return ok;
  });
  ipcMain.handle('desktop:fullscreen', (e) => {
    if (!fromGame(e) || !win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });
  ipcMain.on('desktop:quit', (e) => { if (fromGame(e)) app.quit(); });
  ipcMain.on('desktop:progress', (e, p) => {
    if (!fromGame(e) || !splash || readyAt) return;
    const stage = String(p?.stage ?? '');
    if (stage === 'dom') {
      mark('gameDom');
      setSplash({ phase: 'loading', step: 'Starting the client', detail: '', pct: 38 });
    } else if (stage === 'ui') {
      mark('gameUi');
      setSplash({ phase: 'warming', step: 'Warming up shaders', detail: loadedOnce && retries === 0 ? 'the first launch takes longest' : '', pct: 58 });
    } else if (stage === 'warm') {
      const k = Math.max(0, Math.min(1, Number(p?.k) || 0));
      const dt = Number(p?.dt) || 0;
      setSplash({ phase: 'warming', step: 'Warming up shaders', detail: dt > 0 ? `frame ${dt} ms` : '', pct: 58 + 40 * k });
    }
  });
  ipcMain.on('desktop:ready', (e, p) => {
    if (!fromGame(e) || readyAt) return;
    readyAt = Date.now();
    retries = 0;
    report.readyWhy = String(p?.why ?? '');
    const lt = p?.longTasks;
    if (lt && typeof lt === 'object') report.longTasks = { n: Number(lt.n) || 0, totalMs: Number(lt.totalMs) || 0, maxMs: Number(lt.maxMs) || 0, top: Array.isArray(lt.top) ? lt.top.slice(0, 8) : [] };
    if (host.ok && !adminDelivered) {
      if (p?.hasAdmin === true) {
        // the client stored + stripped the token (core/context.ts parseHash): retries and reloads no longer carry it
        adminDelivered = true;
        gameUrl = buildUrl(gameBase, crewOfUrl(gameUrl));
        report.hostDelivered = true;
        log.info('host rights: the client has the host token');
      } else {
        log.warn('host rights: the client did not store the host token (kept for the next load)');
      }
    }
    mark('ready');
    log.info(`game: ready (${report.readyWhy}) ${readyAt - T0} ms after start${report.longTasks ? `; main-thread long tasks ${report.longTasks.n} = ${report.longTasks.totalMs} ms (max ${report.longTasks.maxMs} ms)` : ''}`);
    hideSplash(String(p?.why ?? 'ready'));
    applyThrottle();
    autoPresence();
    saveMarker();
    void afterReady();
  });
  ipcMain.on('desktop:ui', (e, s) => {
    if (!fromGame(e)) return;
    uiMenu = !!s?.menu;
    applyThrottle();
    autoPresence();
  });
  ipcMain.on('desktop:stats', (e, s) => {
    if (!fromGame(e) || !beatPending || Number(s?.id) !== beatPending) return;
    beatPending = 0;
    /** @param {unknown} v @param {number} hi */
    const n = (v, hi) => Math.max(0, Math.min(hi, Math.round(Number(v) || 0)));
    logBeat({
      raf: n(s?.raf, 1000), vis: String(s?.vis ?? '').replace(/[^a-z]/g, '').slice(0, 10), focus: !!s?.focus,
      draw: s?.draw === '' || s?.draw === undefined ? '?' : n(s.draw, 1000), view: String(s?.view ?? '').replace(/[^a-z-]/g, '').slice(0, 12) || '?',
      w: n(s?.w, 16384), h: n(s?.h, 16384), dpr: Math.round((Number(s?.dpr) || 0) * 100) / 100,
      preset: String(s?.preset ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || '?',
    });
  });
  ipcMain.on('desktop:reloading', (e, d) => {
    if (!fromGame(e)) return;
    const code = normalizeCrew(String(d?.code ?? ''));
    showSplash({ phase: 'joining', title: code ? `Joining crew ${code}` : 'Joining', step: 'Reloading onto the invite', pct: 5 });
  });
  ipcMain.on('splash:hello', (e) => {
    if (splash && e.sender === splash.webContents) e.sender.send('splash:status', splashState);
  });
  ipcMain.on('splash:action', (e, what) => {
    if (!splash || e.sender !== splash.webContents) return;
    if (what === 'quit') app.quit();
    else if (what === 'retry') loadGame();
    else if (what === 'reload') reloadGame();
    else if (what === 'config') {
      const f = path.join(USER_DATA, 'config.json');
      try { if (!fs.existsSync(f)) fs.writeFileSync(f, userTemplate(cfg)); } catch (err) { log.warn(`config template: ${errMsg(err)}`); }
      shell.showItemInFolder(f);
    }
  });

  app.on('second-instance', (_e, argv) => {
    focusWindow();
    const lob = lobbyArg(argv);
    if (lob) void joinLobby(lob, 'second-instance').then(joinCrew);
    const c = normalizeCrew(argOf(argv, 'crew') ?? '');
    if (c) joinCrew(c);
  });
  steam.onJoinRequest((lobbyId) => void joinLobby(lobbyId, 'callback').then(joinCrew));

  /** @param {unknown} n */
  const hex4 = (n) => `0x${(Number(n) || 0).toString(16).padStart(4, '0')}`;
  const afterReady = async () => {
    try {
      const features = app.getGPUFeatureStatus();
      report.gpuFeatureStatus = features;
      const g = /** @type {{ gpuDevice?: { vendorId: number, deviceId: number, active?: boolean, driverVersion?: string }[] }} */ (await app.getGPUInfo('basic'));
      report.gpuDevices = (g.gpuDevice ?? []).map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active, driverVersion: d.driverVersion }));
      report.processes = app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid }));
      if (!gpuLogged) {
        gpuLogged = true;
        const devs = (g.gpuDevice ?? []).map((d) => `${hex4(d.vendorId)}:${hex4(d.deviceId)}${d.active ? ' active' : ''}${d.driverVersion ? ` driver ${String(d.driverVersion).slice(0, 32)}` : ''}`).join(', ');
        const feat = Object.entries(features).map(([k, v]) => `${k}=${v}`).join(' ');
        log.durable(`gpu: ${devs || 'no device info'} | ${feat.slice(0, 900)}`);
      }
    } catch (e) {
      report.gpuError = errMsg(e);
    }
    if (cfg.steamSelftest) {
      report.steamSelftest = await steam.selftest();
      lastAuto = ''; // the self-test cleared the presence
      autoPresence();
    }
    updateSteamReport();
  };

  // -------------------------------------------------------------- session: permissions, downloads
  /** @param {Electron.Session} ses */
  const setupSession = (ses) => {
    const REQUEST_OK = new Set(['media', 'pointerLock', 'fullscreen', 'keyboardLock', 'speaker-selection', 'clipboard-sanitized-write', 'screen-wake-lock', 'local-network-access', 'local-network', 'loopback-network']);
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      const origin = originOf(details.requestingUrl ?? '');
      const ok = !!win && wc === win.webContents && trusted.has(origin);
      if (!ok || !REQUEST_OK.has(permission)) {
        if (permission !== 'notifications') log.warn(`permission ${permission} denied for ${origin || 'unknown origin'}`);
        return cb(false);
      }
      if (permission === 'media') {
        const types = /** @type {Electron.MediaAccessPermissionRequest} */ (details).mediaTypes ?? [];
        return cb(types.length > 0 && types.every((t) => t === 'audio')); // voice chat: microphone only, never camera
      }
      cb(true);
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      if (!trusted.has(originOf(requestingOrigin))) return false;
      if (wc && win && wc !== win.webContents) return false;
      if (permission === 'media') return details.mediaType === 'audio';
      return REQUEST_OK.has(permission);
    });
    ses.setDevicePermissionHandler(() => false); // HID / USB / serial
    ses.on('will-download', (e) => e.preventDefault());
    ses.setSpellCheckerEnabled(false);
  };

  // -------------------------------------------------------------- window
  const createWindow = () => {
    const off = cfg.window.offscreen;
    const ws = cfg.window.rememberBounds && !off ? readWindowState() : null;
    const iconFile = path.join(APP_DIR, 'build', 'icon.png');
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const width = Math.min(cfg.window.width, wa.width);
    const height = Math.min(cfg.window.height, wa.height);
    /** tests (--offscreen-window): left of and above every display, so it never covers the user's screen */
    const offPos = () => {
      const ds = screen.getAllDisplays();
      return { x: Math.min(...ds.map((d) => d.bounds.x)) - width - 400, y: Math.min(...ds.map((d) => d.bounds.y)) - height - 400 };
    };
    win = new BrowserWindow({
      title: APP_NAME,
      icon: fs.existsSync(iconFile) ? iconFile : undefined,
      show: false,
      backgroundColor: BG,
      width: ws?.width ?? width,
      height: ws?.height ?? height,
      ...(off ? { ...offPos(), skipTaskbar: true, focusable: false } : ws ? { x: ws.x, y: ws.y } : {}),
      minWidth: 960,
      minHeight: 540,
      useContentSize: !ws,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        // the menu is throttled like a Chrome tab; a crew never is (applyThrottle)
        backgroundThrottling: cfg.gpu.throttleHiddenMenu,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
        devTools: cfg.devtools,
        safeDialogs: true,
        navigateOnDragDrop: false,
        v8CacheOptions: 'bypassHeatCheck', // code cache on first run: faster second launch
        additionalArguments: [`--deadair-origins=${[...trusted].join(',')}`],
      },
    });
    const w = win;
    w.setMenu(null);
    w.on('page-title-updated', (e) => e.preventDefault());
    w.on('resize', layoutSplash);
    w.on('close', saveWindowState);
    w.on('closed', () => { win = null; });
    // Windows shutdown / restart / log-off is a clean end, not a crash
    w.on('session-end', () => {
      log.info('window: the Windows session ends');
      removeMarker(markerFile);
      syncLog();
    });
    // window state -> the log (focus changes are only counted, alt-tab can be busy) and the page (preload.cjs)
    /** @param {string} what */
    const onWindow = (what) => {
      if (what === 'focus' || what === 'blur') focusFlips++;
      else log.info(`window: ${what}`);
      try { if (!w.isDestroyed()) w.webContents.send('desktop:window', windowState()); } catch { /* gone */ }
    };
    for (const ev of ['minimize', 'restore', 'maximize', 'unmaximize', 'hide', 'show', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen']) {
      w.on(/** @type {any} */ (ev), () => onWindow(ev));
    }
    if (!off) {
      const explicitFs = argOf(process.argv, 'fullscreen') === true || argOf(process.argv, 'windowed') === true;
      if (explicitFs ? cfg.window.fullscreen : ws?.fullscreen ?? cfg.window.fullscreen) w.setFullScreen(true);
      else if (ws?.maximized) w.maximize();
    }

    const wc = w.webContents;
    wc.setVisualZoomLevelLimits(1, 1).catch(() => {});
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (input.key === 'F11' || (input.key === 'Enter' && input.alt)) {
        e.preventDefault();
        toggleFullscreen();
      } else if (input.key === 'F12' && cfg.devtools) {
        e.preventDefault();
        wc.toggleDevTools();
      }
    });
    wc.on('did-start-navigation', (d) => {
      if (!d.isMainFrame || d.isSameDocument || isParkUrl(d.url)) return; // parked: the error screen stays up
      readyAt = 0;
      hashCrew = crewOfUrl(d.url);
      applyThrottle();
      // any full (re)load of the game, also the client's own RELOAD button: the loading screen covers it again
      if (!splash) showSplash({ phase: 'connecting', title: 'Clocking in', step: `Connecting to ${new URL(d.url).host}`, pct: 6 });
    });
    wc.on('did-navigate', (_e, url, code, status) => {
      if (isParkUrl(url)) return;
      event(`navigated ${code}`);
      if (code >= 400) return showError(`HTTP ${code}${status ? ` ${status}` : ''}`, `The server at ${new URL(url).host} answered with an error. The host's PC or tunnel may be offline.`);
      loadedOnce = true;
      hashCrew = crewOfUrl(url);
      mark('gameNavigated');
      if (splash) setSplash({ phase: 'loading', step: 'Loading the client', detail: '', pct: 22 });
      if (capTimer) clearTimeout(capTimer);
      capTimer = setTimeout(() => {
        log.warn(`game: no ready signal after ${cfg.splash.maxMs} ms; showing the page`);
        hideSplash('cap');
      }, cfg.splash.maxMs);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      hashCrew = crewOfUrl(url);
      autoPresence();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || isParkUrl(url)) return; // -3 = ERR_ABORTED (a newer navigation replaced it)
      showError(desc || `error ${code}`, `Can't reach ${originOf(url) ? new URL(url).host : serverHost}. The host's PC or server may be off, or this PC is offline.`);
    });
    wc.on('render-process-gone', (_e, d) => {
      if (quitting) return;
      log.error(`renderer gone: ${d.reason} (exit ${d.exitCode})`);
      showError(`renderer ${d.reason}`, 'The game stopped unexpectedly.', { retry: false, reload: true, title: 'Signal lost' });
    });
    wc.on('console-message', (d) => {
      if (d.level !== 'error') return;
      const msg = String(d.message);
      // the device-lost reason is the one line that matters after a GPU reset: keep it whole (0.1.0 cut it at 300)
      const lost = /device lost|device removed|context lost/i.test(msg);
      if (lost ? lostLogged++ < 10 : consoleErrors++ < 50) log.warn(`page: ${msg.slice(0, lost ? 2000 : 300)}`);
      // three.js: 'THREE.WebGPURenderer: WebGPU Device Lost: ... Reason: <reason>'; 'destroyed' = the page let it go
      if (/webgpu device lost/i.test(msg) && !/reason:\s*destroyed/i.test(msg)) gpuFailure('WebGPU device lost');
    });

    // first paint is the splash: show the window as soon as it rendered (cap 1.5 s)
    let shown = false;
    const show = () => {
      if (shown || !win) return;
      shown = true;
      if (off) w.showInactive(); // tests: never activate (the window is off every screen anyway)
      else w.show();
      mark('windowShown');
    };
    if (cfg.splash.enabled) {
      showSplash({ phase: 'boot', step: 'Starting', pct: 3 });
      splash?.webContents.once('did-finish-load', () => setTimeout(show, 30));
      setTimeout(show, 1500);
    } else {
      w.once('ready-to-show', show);
      setTimeout(show, 3000);
    }
  };

  app.on('child-process-gone', (_e, d) => {
    log.warn(`child process gone: ${d.type} ${d.reason} (exit ${d.exitCode})${d.serviceName ? ` ${d.serviceName}` : ''}`);
    if (d.type === 'GPU' && d.reason !== 'clean-exit') gpuFailure(`GPU process ${d.reason} (exit ${d.exitCode})`);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    mark('quit');
    try { steam.shutdown(); } catch { /* ignore */ }
    void bundledSrv?.close();
  });
  app.on('quit', () => {
    removeMarker(markerFile); // a clean exit: the next launch is not "after a crash"
    log.info(`quit after ${Math.round((Date.now() - T0) / 1000)} s`);
    syncLog();
  });

  // -------------------------------------------------------------- go
  saveMarker();
  beatTimer = setInterval(beat, BEAT_MS);
  app.whenReady().then(async () => {
    mark('appReady');
    Menu.setApplicationMenu(null); // no Ctrl+R / Ctrl+W / Ctrl+Shift+I accelerators
    // product token without the space in "DEAD AIR" (Electron puts "<name>/<version>" into the user agent)
    const ua = app.userAgentFallback.replace(/DEAD ?AIR\/[\w.-]+/i, `DeadAir/${VERSION}`);
    if (ua) app.userAgentFallback = ua;
    setupSession(session.defaultSession);
    const STATIC = path.join(APP_DIR, 'static');
    /** @type {Record<string, string>} */
    const SHELL_TYPES = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png' };
    protocol.handle('deadair', async (req) => {
      const u = new URL(req.url);
      const rel = path.posix.normalize(decodeURIComponent(u.pathname)).replace(/^\/+/, '');
      const file = path.join(STATIC, rel);
      const type = SHELL_TYPES[path.extname(file).toLowerCase()];
      if (u.host !== 'shell' || !rel || !type || !file.startsWith(STATIC + path.sep)) return new Response('not found', { status: 404 });
      try {
        return new Response(await fs.promises.readFile(file), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });

    if (cfg.mode === 'bundled') {
      const root = path.join(APP_DIR, 'client');
      try {
        bundledSrv = await startBundled({ root, upstream: serverOrigin, port: cfg.bundled.port, log });
        trusted.add(bundledSrv.origin);
        gameBase = bundledSrv.origin;
      } catch (e) {
        log.warn(`bundled: ${errMsg(e)}; falling back to remote`);
        event('bundled failed: remote');
      }
    }
    createWindow();

    if (bundledSrv && cfg.bundled.checkBuild) {
      // the production server rejects other client builds ('stale_build'): if it runs a different one, load it remotely
      const mine = localBuild(path.join(APP_DIR, 'client'));
      let theirs = null;
      try {
        const r = await net.fetch(`${serverOrigin}/build.json`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (r.ok && /json/.test(r.headers.get('content-type') ?? '')) theirs = String((/** @type {{ build?: unknown }} */ (await r.json())).build ?? '') || null;
      } catch { theirs = null; }
      report.builds = { bundled: mine, server: theirs };
      if (mine && theirs && mine !== theirs) {
        log.warn(`bundled: client ${mine} != server ${theirs}; loading the server's client this launch`);
        event('bundled build mismatch: remote');
        gameBase = serverOrigin;
      }
    }
    report.mode = gameBase === serverOrigin ? 'remote' : 'bundled';

    // crew precedence: a Steam "Join Game" lobby > --crew / config crew > the host's crew (host.json)
    let crew = cfg.crew;
    if (startLobby) {
      if (splash) setSplash({ phase: 'joining', title: 'Joining a friend', step: 'Asking Steam for the lobby', pct: 4 });
      crew = (await joinLobby(startLobby, 'argv')) || crew;
    }
    if (!crew && host.ok) crew = host.crew;
    bootCrew = crew;
    gameUrl = buildUrl(gameBase, crew);
    report.url = safeUrl(gameUrl);
    loadGame();
  }).catch((e) => {
    log.error(`startup failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
    app.exit(1);
  });
}
