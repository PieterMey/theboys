// @ts-check
'use strict';
// Game page preload (sandboxed, contextIsolation; runs in an isolated world, shares only the DOM with the page).
// Exposes window.deadAirDesktop to the game origin only, and tells the shell when the client is up and its frames
// are smooth so the loading screen (shell splash) can fade into a menu that no longer stutters. Also relays the
// window state (minimized / visible / focused) to the page and answers the shell's heartbeat with frame stats.
const { contextBridge, ipcRenderer } = require('electron');

/** @typedef {{ minimized: boolean, visible: boolean, focused: boolean, fullscreen: boolean }} WindowState */
/** @param {unknown} s @returns {WindowState} */
function windowStateOf(s) {
  const o = /** @type {Record<string, unknown>} */ (s && typeof s === 'object' ? s : {});
  return { minimized: o.minimized === true, visible: o.visible !== false, focused: o.focused === true, fullscreen: o.fullscreen === true };
}

/** @param {string} name */
function argValue(name) {
  const pre = `--${name}=`;
  for (const a of process.argv) if (a.startsWith(pre)) return a.slice(pre.length);
  return '';
}

const trustedOrigins = argValue('deadair-origins').split(',').filter(Boolean);
const trusted = trustedOrigins.includes(location.origin);

if (trusted) {
  /** @type {{ version: string, mode: string, electron: string, chrome: string, steam: { available: boolean, personaName: string | null, appId: number | null, overlay: boolean }, window?: unknown, safeGraphics?: string } | null} */
  let info = null;
  try {
    info = ipcRenderer.sendSync('desktop:info');
  } catch {
    info = null;
  }

  // ---------- window state (the shell sends every minimize / restore / focus change) ----------
  let winState = windowStateOf(info?.window);
  /** @type {Set<(s: WindowState) => unknown>} */
  const winHandlers = new Set();
  ipcRenderer.on('desktop:window', (_e, s) => {
    winState = windowStateOf(s);
    for (const h of [...winHandlers]) {
      try { h({ ...winState }); } catch { /* the page's handler */ }
    }
    try { window.dispatchEvent(new Event('deadair:window')); } catch { /* ignore */ }
  });

  // ---------- v1.2 hotkeys the shell maps (src/hotkeys.cjs): Left Ctrl -> { action: 'crouch', down } ----------
  /** @typedef {{ action: string, down: boolean }} Hotkey */
  /** @type {Set<(ev: Hotkey) => unknown>} */
  const hotkeyHandlers = new Set();
  ipcRenderer.on('desktop:hotkey', (_e, ev) => {
    const action = String(ev?.action ?? '');
    if (action !== 'crouch') return;
    const hk = { action, down: ev?.down === true };
    for (const h of [...hotkeyHandlers]) {
      try { h({ ...hk }); } catch { /* the page's handler */ }
    }
  });

  // ---------- heartbeat: the shell asks every 60 s; frames per second over 1 s, canvas size, preset ----------
  ipcRenderer.on('desktop:stats?', (_e, id) => {
    let frames = 0;
    const t0 = performance.now();
    /** @type {FrameRequestCallback} */
    const count = (now) => {
      frames++;
      if (now - t0 < 1000) requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    setTimeout(() => {
      const dt = Math.max(1, performance.now() - t0);
      const c = document.querySelector('#game canvas');
      let preset = 'auto';
      try { preset = new URLSearchParams(location.search).get('preset') || localStorage.getItem('deadair.render.preset') || 'auto'; } catch { /* storage blocked */ }
      const canvas = c instanceof HTMLCanvasElement ? c : null;
      ipcRenderer.send('desktop:stats', {
        id,
        raf: Math.round((frames * 1000) / dt),
        // the client's own draw rate + what covers the canvas (render/index.ts publishes them on the canvas once a
        // second; rAF keeps the display rate when it skips draws)
        draw: canvas?.dataset.drawFps ?? '',
        view: canvas?.dataset.view ?? '',
        vis: document.visibilityState,
        focus: document.hasFocus(),
        w: canvas ? canvas.width : 0,
        h: canvas ? canvas.height : 0,
        dpr: devicePixelRatio,
        preset,
      });
    }, 1000);
  });

  /** @type {((code: string) => unknown) | null} */
  let joinHandler = null;
  let readyFinished = false;
  /** @type {(why: string) => void} */
  let finishReady = () => {};

  ipcRenderer.on('desktop:join', (_e, /** @type {{ code: string }} */ d) => {
    const code = String(d?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) return;
    if (joinHandler) {
      try {
        joinHandler(code);
        return;
      } catch {
        /* fall through: reload onto the invite */
      }
    }
    // default: reload onto the invite link (#CODE): the menu opens on PLAY with the code filled in
    ipcRenderer.send('desktop:reloading', { code });
    location.hash = code;
    location.reload();
  });

  const steam = Object.freeze({
    available: !!info?.steam.available,
    personaName: info?.steam.personaName ?? null,
    appId: info?.steam.appId ?? null,
    overlay: !!info?.steam.overlay,
    /** Steam invite dialog for the current crew (the shell keeps a friends-only lobby with the crew code). */
    inviteFriends: () => ipcRenderer.invoke('desktop:steam:invite'),
    /**
     * Rich presence. text: e.g. 'In the van — crew KFRT' / 'On a contract'. connect: the crew code friends join
     * ('' when not in a crew). The first call switches the shell's automatic presence off.
     * @param {string} text @param {string} [connect]
     */
    setPresence: (text, connect) => ipcRenderer.invoke('desktop:steam:presence', String(text ?? ''), String(connect ?? '')),
  });

  contextBridge.exposeInMainWorld('deadAirDesktop', Object.freeze({
    version: info?.version ?? '',
    mode: info?.mode ?? '',
    electron: info?.electron ?? '',
    chrome: info?.chrome ?? '',
    steam,
    /** Handle Steam "Join Game" / invite accepts in-app (otherwise the shell reloads onto #CODE). Returns an unsubscribe. */
    onJoin: (/** @type {(code: string) => unknown} */ cb) => {
      joinHandler = typeof cb === 'function' ? cb : null;
      return () => { if (joinHandler === cb) joinHandler = null; };
    },
    /** The client is interactive and warmed up: hide the shell's loading screen now (optional; there is a heuristic). */
    appReady: () => finishReady('page'),
    toggleFullscreen: () => ipcRenderer.invoke('desktop:fullscreen'),
    quit: () => ipcRenderer.send('desktop:quit'),
    /**
     * The desktop window: { minimized, visible, focused, fullscreen }. document.hidden does not track it on Windows
     * (a covered or unfocused window keeps rendering at the display rate; in a crew the shell never lets Chromium hide
     * the page, for voice + net), so the client should hold its drawing while `minimized` / not `visible` and may draw
     * less while not `focused`.
     */
    windowState: () => ({ ...winState }),
    /** Called on every window state change (a 'deadair:window' event also fires on window). Returns an unsubscribe. */
    onWindowState: (/** @type {(s: WindowState) => unknown} */ cb) => {
      if (typeof cb !== 'function') return () => {};
      winHandlers.add(cb);
      return () => { winHandlers.delete(cb); };
    },
    /** '' or why the shell loaded this page on safe graphics (?preset=low): a GPU reset, or an unclean last exit. */
    safeGraphics: typeof info?.safeGraphics === 'string' ? info.safeGraphics : '',
    /**
     * v1.2: keys only the desktop app maps (the web page never reads Ctrl): Left Ctrl arrives as { action: 'crouch',
     * down } (AltGr's synthetic Ctrl filtered; a release is sent when the window loses focus). Returns an unsubscribe.
     */
    onHotkey: (/** @type {(ev: Hotkey) => unknown} */ cb) => {
      if (typeof cb !== 'function') return () => {};
      hotkeyHandlers.add(cb);
      return () => { hotkeyHandlers.delete(cb); };
    },
  }));

  // ---------- readiness: UI mounted + canvas + smooth frames (no long tasks) ----------
  const UI = '[data-testid="main-menu"], [data-testid="join-panel"], [data-testid="loading-screen"]';
  const NEED_GOOD = 30; // consecutive frames under 40 ms (~0.5 s at 60 Hz)
  const MIN_AFTER_UI = 700; // ms: the 3D backdrop's first pipelines compile right after the menu mounts
  const CAP_AFTER_UI = 20_000;
  const QUIET_MS = 700; // no main-thread long task (WGSL generation, shader compiles) for this long
  let longTaskEnd = 0;
  /** main-thread long tasks until ready (diagnostics for the shell log / --report) */
  const longTasks = { n: 0, totalMs: 0, maxMs: 0, top: /** @type {[number, number][]} */ ([]) };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTaskEnd = Math.max(longTaskEnd, e.startTime + e.duration);
        longTasks.n++;
        longTasks.totalMs += e.duration;
        longTasks.maxMs = Math.max(longTasks.maxMs, e.duration);
        longTasks.top.push([Math.round(e.startTime), Math.round(e.duration)]);
        longTasks.top.sort((a, b) => b[1] - a[1]);
        longTasks.top.length = Math.min(longTasks.top.length, 8);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* no long-task timing: frame pacing alone */
  }
  let lastSent = 0;
  /** @param {string} stage @param {Record<string, unknown>} [extra] */
  const progress = (stage, extra = {}) => ipcRenderer.send('desktop:progress', { stage, t: Math.round(performance.now()), ...extra });
  finishReady = (why) => {
    if (readyFinished) return;
    readyFinished = true;
    // whether the client holds a host token (the shell stops putting it into URLs once it does); never the token
    let hasAdmin = false;
    try { hasAdmin = !!localStorage.getItem('deadair.admin'); } catch { /* storage blocked */ }
    ipcRenderer.send('desktop:ready', { why, t: Math.round(performance.now()), hasAdmin, longTasks: { ...longTasks, totalMs: Math.round(longTasks.totalMs), maxMs: Math.round(longTasks.maxMs) } });
  };

  const start = () => {
    progress('dom');
    let uiAt = 0;
    let last = 0;
    let good = 0;
    let longest = 0;
    /** @param {number} now */
    const tick = (now) => {
      if (readyFinished) return;
      const dt = last ? now - last : 0;
      last = now;
      if (!uiAt) {
        if (document.querySelector(UI) && document.querySelector('#game canvas')) {
          uiAt = now;
          progress('ui');
        }
      } else {
        good = dt > 0 && dt < 40 ? good + 1 : 0;
        longest = Math.max(longest, dt);
        const quiet = now - longTaskEnd > QUIET_MS;
        if (now - lastSent > 200) {
          lastSent = now;
          progress('warm', { k: Math.min(1, good / NEED_GOOD) * (quiet ? 1 : 0.85), dt: Math.round(dt) });
        }
        if (good >= NEED_GOOD && quiet && now - uiAt > MIN_AFTER_UI) return finishReady('stable');
        if (now - uiAt > CAP_AFTER_UI) return finishReady('cap');
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // ---------- menu visibility for the automatic Steam presence ----------
  let menu = /** @type {boolean | null} */ (null);
  const checkMenu = () => {
    const m = !!document.querySelector('[data-testid="main-menu"], [data-testid="join-panel"]');
    if (m !== menu) {
      menu = m;
      ipcRenderer.send('desktop:ui', { menu: m });
    }
  };
  setInterval(checkMenu, 1500);
  document.addEventListener('DOMContentLoaded', checkMenu, { once: true });
}
