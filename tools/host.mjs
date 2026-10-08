#!/usr/bin/env node
// DEAD AIR host runbook in one command (track ① Net). `npm run host` (or: node tools/host.mjs)
//  (a) start or re-attach the STT sidecar (services/stt/run.ps1, health http://127.0.0.1:3100/health)
//  (b) start or re-attach cloudflared: reuse http://127.0.0.1:20241/quicktunnel if it answers, else spawn
//      tools/bin/cloudflared.exe (detached, logs/cloudflared.log) and wait for the hostname. NEVER a second tunnel.
//  (c) npm run build            (skip with --no-build)
//  (d) game server, prod, :3000, with the .env file, detached (logs/server.log); re-attached if already healthy
//      (use --restart to replace it; tools/server-restart.mjs restarts ONLY the game server)
//  (e) prints the admin URL (host only), the invite link and a paste-ready Discord message.
//  (f) desktop app host rights: writes %APPDATA%\DEAD AIR\host.json ({ v, adminToken, crew, server, writtenAt },
//      user-only ACL) so the DEAD AIR desktop app on THIS PC opens with HOST rights and the night's crew; it only
//      uses the file for a loopback game server that matches `server` (apps/desktop/src/host.cjs). Only the path is
//      printed. --no-desktop skips it; --desktop-only writes it from saves/host.json and starts nothing else.
//  (g) hang watchdog, while this window follows logs/server.log (Ctrl+C stops both): polls /healthz every 10 s. After
//      6 misses in a row (~60 s) while the process on the port is the one this flow started (npm run host,
//      server:restart or the watchdog itself: state serverSpawnedPid) and still alive, it logs "watchdog: game server
//      not answering for 60 s, restarting" (into logs/server.log, echoed here), kills that process tree and starts a
//      new server with the same env. Never while a deliberate restart holds the restart lock (saves/host.restart.lock:
//      server-restart.mjs, and this script while it starts or --restart's the server); at most 3 automatic restarts
//      per 10 min (state watchdogRestarts), then it says so loudly and stops restarting until a deliberate restart.
//      --no-watchdog turns it off. A crashed server (nothing on the port) is reported, not restarted.
// State (pids, admin token, the night's crew code, watchdog restart times) lives in saves/host.json (gitignored, never commit).
// Flags: --no-build --no-stt --no-tunnel --restart --no-follow --no-desktop --desktop-only --no-watchdog.
// Env: PORT (3000), CF_METRICS (127.0.0.1:20241), DEADAIR_HOST_FILE (tests: write the desktop host file there).
//   Tests only (tests/host/): HOST_STATE / HOST_LOGS (state and logs elsewhere), HOST_SERVER_ENTRY (a stand-in server
//   instead of apps/server/src/index.ts: no .env file, never a build, NODE_ENV passed through), HOST_WATCHDOG_MS (the
//   watchdog's poll interval; only together with HOST_SERVER_ENTRY).
// NAMED TUNNEL (permanent link): set PUBLIC_URL (e.g. https://play.dead-air.io) in .env, plus CLOUDFLARE_TUNNEL_TOKEN.
//   If the 'Cloudflared' Windows service is installed and running, it is used and nothing is started (the token is
//   then optional). Otherwise the token is passed to cloudflared via the TUNNEL_TOKEN env var (never on the command
//   line / in logs). Either way an old quick tunnel is stopped and invites use PUBLIC_URL.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const ENV_FILE = 'C:/Users/Pieter/repos/theboys/.env';
export const PORT = Number(process.env.PORT ?? 3000);
export const METRICS = process.env.CF_METRICS ?? '127.0.0.1:20241';
export const STT_URL = process.env.STT_URL ?? 'http://127.0.0.1:3100';
const STATE = process.env.HOST_STATE ? resolve(ROOT, process.env.HOST_STATE) : join(ROOT, 'saves', 'host.json');
const LOGS = process.env.HOST_LOGS ? resolve(ROOT, process.env.HOST_LOGS) : join(ROOT, 'logs');
export const SERVER_LOG = join(LOGS, 'server.log');
/** held while the game server is deliberately (re)started or the watchdog restarts it: see acquireRestartLock */
export const RESTART_LOCK = `${STATE.replace(/\.json$/i, '')}.restart.lock`;
/** tests only (tests/host/): a stand-in for the game server; never the .env file, never a build */
export const TEST_SERVER_ENTRY = process.env.HOST_SERVER_ENTRY || null;
const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** read selected keys from .env (values are never printed) */
export function envFromFile(keys) {
  const out = {};
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && keys.includes(m[1])) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env */ }
  for (const k of keys) if (process.env[k]) out[k] = process.env[k];
  return out;
}
const NAMED = envFromFile(['CLOUDFLARE_TUNNEL_TOKEN', 'PUBLIC_URL']);
/** permanent public base URL (named tunnel), e.g. https://play.dead-air.io, or null. Needs the token, or the
 *  'Cloudflared' Windows service (installed with the token once; then the token is not needed in .env). */
export const PUBLIC_URL = NAMED.PUBLIC_URL && (NAMED.CLOUDFLARE_TUNNEL_TOKEN || windowsServiceRunning()) ? NAMED.PUBLIC_URL.replace(/\/+$/, '') : null;
const say = (...a) => console.log('[host]', ...a);
const warn = (...a) => console.warn('[host] WARN', ...a);

export function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}
export function writeState(s) {
  mkdirSync(dirname(STATE), { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`; // per process: npm run host, server:restart and a watchdog may write at once
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, STATE);
}

export async function getJson(url, ms = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** STT health JSON whatever the HTTP status (it answers 503 + {loading:true} while the model loads) */
export async function sttHealth() {
  try {
    const r = await fetch(`${STT_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return await r.json().catch(() => ({ ok: r.ok }));
  } catch {
    return null;
  }
}

async function namedTunnelReady() {
  try {
    const r = await fetch(`http://${METRICS}/ready`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

function windowsServiceRunning(name = 'Cloudflared') {
  const r = spawnSync('sc', ['query', name], { encoding: 'utf8', windowsHide: true });
  return /STATE\s*:\s*4\s+RUNNING/i.test(r.stdout ?? '');
}

export async function tunnelHost() {
  if (PUBLIC_URL) return new URL(PUBLIC_URL).host;
  const j = await getJson(`http://${METRICS}/quicktunnel`, 1200);
  return j && typeof j.hostname === 'string' && j.hostname.includes('.') ? j.hostname : null;
}

export async function serverHealthy(port = PORT, ms = 1200) {
  return (await getJson(`http://127.0.0.1:${port}/healthz`, ms))?.ok === true;
}

function detached(cmd, args, logName, env = process.env, cwd = ROOT) {
  mkdirSync(LOGS, { recursive: true });
  const fd = openSync(join(LOGS, logName), 'a');
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.on('error', () => {}); // a failed spawn leaves pid undefined (callers see a dead pid); never crash the host window
  child.unref();
  return child.pid;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** pid listening on 127.0.0.1:port (Windows netstat), or null */
export function pidOnPort(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = line.trim().split(/\s+/);
    if (m.length >= 5 && m[3] === 'LISTENING' && (m[1].endsWith(`:${port}`))) return Number(m[4]) || null;
  }
  return null;
}

export function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

export function ensureHostSecrets(state) {
  // admin token + the night's crew code: stable across server restarts so links and the host tab keep working
  state.adminToken ??= randomBytes(16).toString('hex');
  if (!state.crew || !/^[A-Z]{4}$/.test(state.crew)) state.crew = Array.from({ length: 4 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
  return state;
}

/** the desktop app's host-rights file: DEADAIR_HOST_FILE, else %APPDATA%\DEAD AIR\host.json (the app's userData) */
export function desktopHostFile(env = process.env) {
  if (env.DEADAIR_HOST_FILE) return resolve(env.DEADAIR_HOST_FILE);
  return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'DEAD AIR', 'host.json');
}

/** Windows' own tools by full path (Git Bash puts a GNU whoami first on PATH) */
const SYS32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
/** the current user's SID (S-1-5-21-...), for a user-only ACL; null if whoami fails */
function userSid() {
  const r = spawnSync(join(SYS32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const m = /S-1-\d+(?:-\d+)+/.exec(r.stdout ?? '');
  return r.status === 0 && m ? m[0] : null;
}

/**
 * (f) Host rights for the DEAD AIR desktop app on this PC (apps/desktop/src/host.cjs reads the file): written
 * atomically (temp file -> user-only ACL -> rename; a same-volume rename keeps the ACL). Never prints the token.
 * Returns the file path, or null when skipped / failed.
 */
export function writeDesktopHost(state, port = PORT, file = desktopHostFile()) {
  if (process.argv.includes('--no-desktop')) { say('desktop: host rights skipped (--no-desktop)'); return null; }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(state.adminToken ?? '')) || !/^[A-Z0-9]{1,8}$/.test(String(state.crew ?? ''))) {
    warn('desktop: no admin token / crew in the host state; host rights for the desktop app not written');
    return null;
  }
  const body = { v: 1, adminToken: state.adminToken, crew: state.crew, server: `http://127.0.0.1:${port}`, writtenAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(body, null, 1)}\n`, { mode: 0o600 });
    if (process.platform === 'win32') {
      // only this user may read it (no inherited ACEs): the file holds the admin token. Only the path is passed.
      const sid = userSid();
      const r = sid ? spawnSync(join(SYS32, 'icacls.exe'), [tmp, '/inheritance:r', '/grant:r', `*${sid}:F`], { encoding: 'utf8', windowsHide: true }) : null;
      if (!r || r.status !== 0) throw new Error(`could not restrict the file to this user (${sid ? `icacls exit ${r?.status}` : 'no SID from whoami'})`);
    }
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    warn(`desktop: host rights not written: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  say(`desktop: host rights -> ${file}`);
  return file;
}

/** node arguments for the game server (tests: HOST_SERVER_ENTRY, a stand-in, without the .env file) */
export function serverArgs() {
  if (TEST_SERVER_ENTRY) return [resolve(ROOT, TEST_SERVER_ENTRY), '--prod'];
  const main = ['apps/server/src/index.ts', '--prod'];
  return existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`, ...main] : main;
}

/** start the prod game server detached; resolves once /healthz answers. The watchdog restarts through this same
 *  function from the same process, so a restarted server gets the same env. */
export async function startGameServer(state, port = PORT) {
  // AI_MODE defaults to 'live' for the real session (dev/tests default to mock); override with AI_MODE=mock
  const nodeEnv = TEST_SERVER_ENTRY ? (process.env.NODE_ENV ?? 'development') : 'production';
  const env = { ...process.env, AI_MODE: process.env.AI_MODE ?? 'live', PORT: String(port), NODE_ENV: nodeEnv, ADMIN_TOKEN: state.adminToken, HOST_CREW: state.crew };
  if (PUBLIC_URL) env.INVITE_BASE = PUBLIC_URL;
  const pid = detached(process.execPath, serverArgs(), 'server.log', env);
  state.serverPid = pid;
  state.serverSpawnedPid = pid; // started by this flow: the only process the watchdog may ever kill and restart
  state.serverPort = port;
  state.serverStartedAt = new Date().toISOString();
  writeState(state);
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if (await serverHealthy(port)) return pid;
    if (!pidAlive(pid)) break;
    await sleep(250);
  }
  throw new Error(`game server did not come up on :${port}; see logs/server.log`);
}

export async function stopGameServer(state, port = PORT) {
  const pids = new Set([state.serverPid, pidOnPort(port)].filter(Boolean));
  for (const pid of pids) killTree(pid);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && pidOnPort(port)) await sleep(200);
}

// ---- restart lock: one (re)start of the game server at a time -------------------------------------------------------
// server-restart.mjs, this script (when it starts or --restart's the game server) and the watchdog take it before they
// stop or start the game server, and the watchdog never acts while anyone holds it. The file holds { pid, by, at }; a
// lock whose process is gone, or that is older than 10 min, is stale and gets taken over.
const LOCK_MAX_AGE_MS = 10 * 60_000;

/** the lock holder { pid, by, at }, or null when there is no lock. Content that does not parse (a lock being written
 *  this instant) counts as a holder with pid 0, aged by the file's mtime. */
export function readRestartLock(file = RESTART_LOCK) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') return { pid: Number(j.pid) || 0, by: String(j.by ?? '?'), at: Number(j.at) || 0 };
  } catch { /* half written, or garbage */ }
  try { return { pid: 0, by: '?', at: statSync(file).mtimeMs }; } catch { return null; }
}

/** stale: the holder process is gone or the lock is older than 10 min (unknown holder: older than 5 s) */
export function restartLockStale(h, now = Date.now()) {
  if (!h) return true;
  if (!h.pid) return now - h.at > 5000;
  return !pidAlive(h.pid) || now - h.at > LOCK_MAX_AGE_MS;
}

/** the holder of a live restart lock (a restart is in progress right now), or null */
export function restartInProgress(file = RESTART_LOCK) {
  const h = readRestartLock(file);
  return h && !restartLockStale(h) ? h : null;
}

/** take the restart lock: { holder, release() }, or null while someone else holds it (a stale lock is taken over) */
export function acquireRestartLock(by, file = RESTART_LOCK) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const holder = { pid: process.pid, by, at: Date.now() };
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ ...holder, since: new Date(holder.at).toISOString() }), { flag: 'wx' });
      return { holder, release: () => releaseRestartLock(file) };
    } catch (e) {
      if (e?.code !== 'EEXIST') return null; // e.g. EPERM: a lock file being deleted this instant
      if (!restartLockStale(readRestartLock(file))) return null;
      try { rmSync(file, { force: true }); } catch { return null; }
    }
  }
  return null;
}

/** remove the restart lock if this process holds it (never someone else's) */
export function releaseRestartLock(file = RESTART_LOCK) {
  if (readRestartLock(file)?.pid !== process.pid) return;
  try { rmSync(file, { force: true }); } catch { /* the next taker sees our pid gone */ }
}

/** acquireRestartLock, waiting up to `ms` while another restart runs; onWait(holder) is called once if it has to wait */
export async function waitForRestartLock(by, ms = 60_000, onWait = (_h) => {}, file = RESTART_LOCK) {
  const t0 = Date.now();
  for (let told = false; ; told = true) {
    const lock = acquireRestartLock(by, file);
    if (lock || Date.now() - t0 >= ms) return lock;
    if (!told) onWait(readRestartLock(file));
    await sleep(500);
  }
}

export function lockText(h) {
  return h ? `${h.by} (pid ${h.pid || '?'}, since ${new Date(h.at).toTimeString().slice(0, 8)})` : 'nobody';
}

// ---- (g) hang watchdog ----------------------------------------------------------------------------------------------
/** poll every 10 s (5 s timeout); 6 misses in a row (~60 s) = hung; at most 3 automatic restarts per 10 min */
export const WATCHDOG = Object.freeze({ intervalMs: 10_000, timeoutMs: 5000, failLimit: 6, maxRestarts: 3, windowMs: 10 * 60_000 });

/**
 * One watchdog poll -> { mem, action }. Pure (tests/host/watchdog.test.ts); startWatchdog does what it says.
 * mem (start with {}): fails = misses in a row, seenPid = the server they count for, ownPid = the last server the
 *   watchdog started itself, gaveUp = the restart budget ran out (only a deliberate restart re-arms it).
 * obs: healthy; spawnedPid = state.serverSpawnedPid (started by npm run host, server:restart or the watchdog); when
 *   unhealthy also portPid (pid listening on the port), alive (spawnedPid alive), lock (holder of a live restart lock,
 *   i.e. a deliberate restart in progress), restarts (times of automatic restarts, shared through the state), now.
 * action: ok | miss | warn (half way) | busy (a restart in progress: leave it) | gone (nothing listens, or the pid is
 *   dead: a crash, not a hang) | foreign (the pid on the port is not the one this flow started) | off (gave up
 *   earlier) | give-up (the budget is spent: say it loudly, stop) | restart.
 */
export function watchdogStep(mem, obs, cfg = WATCHDOG) {
  const m = { fails: mem.fails ?? 0, seenPid: mem.seenPid ?? null, ownPid: mem.ownPid ?? null, gaveUp: !!mem.gaveUp };
  const pid = obs.spawnedPid ?? null;
  if (pid !== m.seenPid) {
    // another server now: count afresh. A deliberate restart (not the watchdog's own) re-arms a watchdog that gave up.
    m.fails = 0;
    if (pid && pid !== m.ownPid) m.gaveUp = false;
    m.seenPid = pid;
  }
  if (obs.healthy) return { mem: { ...m, fails: 0 }, action: 'ok' };
  m.fails += 1;
  if (m.fails < cfg.failLimit) return { mem: m, action: m.fails === Math.ceil(cfg.failLimit / 2) ? 'warn' : 'miss' };
  if (obs.lock) return { mem: m, action: 'busy' };
  if (!obs.portPid) return { mem: m, action: 'gone' };
  if (!pid || obs.portPid !== pid) return { mem: m, action: 'foreign' };
  if (!obs.alive) return { mem: m, action: 'gone' };
  if (m.gaveUp) return { mem: m, action: 'off' };
  const recent = (obs.restarts ?? []).filter((t) => obs.now - t < cfg.windowMs).length;
  if (recent >= cfg.maxRestarts) return { mem: { ...m, gaveUp: true }, action: 'give-up' };
  return { mem: m, action: 'restart' };
}

/** HH:MM:SS.mmm, like the game server's own log lines */
function stamp() {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** a watchdog line into logs/server.log, which `follow` echoes to the host window (straight to stdout if the log
 *  cannot be written) */
export function watchdogLog(text, file = SERVER_LOG) {
  const lines = String(text).split('\n').map((l) => `${stamp()} [host] ${l}\n`).join('');
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, lines);
  } catch {
    process.stdout.write(lines);
  }
}

/**
 * (g) Start the hang watchdog for the game server on `port`: { stop() }. Polls /healthz at a fixed cadence and acts
 * on watchdogStep's verdict; a restart re-checks under the restart lock (the state still names the hung pid, that pid
 * still holds the port and lives, the budget) before it kills anything. opts: port, log(text), WATCHDOG's numbers.
 */
export function startWatchdog(opts = {}) {
  const cfg = { ...WATCHDOG, ...opts };
  const port = opts.port ?? PORT;
  const log = opts.log ?? ((t) => watchdogLog(t));
  const secs = (n) => Math.round((n * cfg.intervalMs) / 1000);
  const perMin = `${Math.round(cfg.windowMs / 60_000)} min`;
  let mem = { fails: 0, seenPid: readState().serverSpawnedPid ?? null, ownPid: null, gaveUp: false };
  let noted = ''; // the problem last reported, so a long outage is one line, not one per poll
  let stopped = false;
  let timer = null;
  const note = (key, text) => {
    if (noted === key) return;
    noted = key;
    log(text);
  };

  const giveUp = (n) => {
    noted = 'give-up';
    log([
      '================================================================================',
      `watchdog: GIVING UP: the game server hung again after ${n} automatic restarts in ${perMin}.`,
      'watchdog: NOT restarting it any more; it stays frozen until you act. Read the end of logs/server.log,',
      'watchdog: then restart it by hand: npm run server:restart (that also re-arms the watchdog).',
      '================================================================================',
    ].join('\n'));
    if (!opts.log) process.stdout.write('\x07');
  };

  /** kill the hung server `hungPid` and start a new one, everything re-checked under the restart lock */
  async function restart(hungPid) {
    const lock = acquireRestartLock('watchdog');
    if (!lock) return note('busy', `watchdog: game server not answering, but a restart is in progress (${lockText(readRestartLock())}): leaving it alone`);
    const t0 = Date.now();
    let started = null;
    try {
      const state = readState(); // fresh: a deliberate restart may have replaced the server meanwhile
      if (state.serverSpawnedPid !== hungPid || pidOnPort(port) !== hungPid || !pidAlive(hungPid)) return;
      const now = Date.now();
      const recent = (state.watchdogRestarts ?? []).filter((t) => now - t < cfg.windowMs);
      if (recent.length >= cfg.maxRestarts) {
        mem = { ...mem, gaveUp: true };
        return giveUp(recent.length);
      }
      state.watchdogRestarts = [...recent, now];
      writeState(state);
      log(`watchdog: game server not answering for ${secs(cfg.failLimit)} s, restarting (pid ${hungPid}; automatic restart ${recent.length + 1} of at most ${cfg.maxRestarts} per ${perMin})`);
      await stopGameServer({ serverPid: hungPid }, port);
      const still = pidOnPort(port);
      if (still) return note('stuck', `watchdog: pid ${still} still holds :${port} after the kill: NOT starting a second server`);
      started = state; // startGameServer records the new pid in it (also when it then fails to come up)
      const pid = await startGameServer(state, port);
      noted = '';
      log(`watchdog: game server back up after ${((Date.now() - t0) / 1000).toFixed(1)} s (pid ${pid}); crews reconnect on their own`);
    } catch (e) {
      noted = 'failed';
      log(`watchdog: RESTART FAILED: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (started?.serverSpawnedPid) mem = { ...mem, fails: 0, seenPid: started.serverSpawnedPid, ownPid: started.serverSpawnedPid };
      lock.release();
    }
  }

  async function poll() {
    try {
      const state = readState(); // every poll: server:restart / another host window may have replaced the server
      const spawnedPid = state.serverSpawnedPid ?? null;
      const healthy = await serverHealthy(port, cfg.timeoutMs);
      if (stopped) return;
      const extra = healthy ? {} : { portPid: pidOnPort(port), alive: pidAlive(spawnedPid), lock: restartInProgress() };
      const step = watchdogStep(mem, { healthy, spawnedPid, restarts: state.watchdogRestarts ?? [], now: Date.now(), ...extra }, cfg);
      mem = step.mem;
      const silent = `${secs(mem.fails)} s`;
      switch (step.action) {
        case 'ok':
          if (noted) log(`watchdog: game server on :${port} answering again`);
          noted = '';
          break;
        case 'warn':
          note('warn', `watchdog: game server on :${port} not answering /healthz for ${silent} (restart after ${secs(cfg.failLimit)} s of silence)`);
          break;
        case 'busy':
          note('busy', `watchdog: game server not answering for ${silent}, but a restart is in progress (${lockText(extra.lock)}): leaving it alone`);
          break;
        case 'gone':
          note('gone', `watchdog: the game server is DOWN: nothing answers on :${port} (pid ${spawnedPid ?? '?'} ${extra.alive ? 'is not listening' : 'exited'}). Not a hang, so no automatic restart: npm run server:restart`);
          break;
        case 'foreign':
          note(`foreign:${extra.portPid}`, `watchdog: game server not answering for ${silent}, but pid ${extra.portPid} on :${port} was not started by npm run host / server:restart: not touching it`);
          break;
        case 'off': // a new silence after the give-up banner (the banner's own episode stays quiet)
          if (noted !== 'give-up') note('off', `watchdog: game server not answering for ${silent} again, and the watchdog gave up earlier: NOT restarting it; npm run server:restart`);
          break;
        case 'give-up':
          giveUp((state.watchdogRestarts ?? []).filter((t) => Date.now() - t < cfg.windowMs).length);
          break;
        case 'restart':
          await restart(spawnedPid);
          break;
        default: // miss
      }
    } catch (e) {
      note('error', `watchdog: poll failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  let inflight = null;
  /** a poll every intervalMs from the start of the last one (a slow, timed-out poll does not stretch the 60 s) */
  function tick() {
    const t0 = Date.now();
    inflight = poll().finally(() => {
      inflight = null;
      if (!stopped) timer = setTimeout(tick, Math.max(0, cfg.intervalMs - (Date.now() - t0)));
    });
  }

  timer = setTimeout(tick, cfg.intervalMs);
  return {
    /** stops polling; resolves once a poll (or restart) in flight has finished */
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      return inflight ?? Promise.resolve();
    },
  };
}

async function ensureStt(state) {
  if (process.argv.includes('--no-stt')) return say('STT: skipped (--no-stt)');
  const h = await sttHealth();
  if (h) return say(`STT: re-attached (${STT_URL}, device=${h.device ?? '?'}, warm=${h.warm})`);
  const here = join(ROOT, 'services/stt');
  // pythonw (no console): the venv's python.exe launcher opens a blank console window for the real interpreter, and
  // closing that window killed the sidecar ("forrtl: error (200): program aborting due to window-CLOSE event")
  const pyw = join(here, '.venv/Scripts/pythonw.exe');
  const py = existsSync(pyw) ? pyw : join(here, '.venv/Scripts/python.exe');
  if (!existsSync(join(here, 'server.py'))) return warn('STT: services/stt missing: speech features (Listener memory) disabled tonight');
  if (!existsSync(py)) return warn('STT: services/stt/.venv missing (run services/stt/setup.ps1): skipped');
  // same environment as services/stt/run.ps1 (a detached powershell -File exits at once on this host, so the
  // venv python is started directly)
  const port = new URL(STT_URL).port || '3100';
  const sttEnv = { ...process.env, HF_HOME: join(here, 'models'), HF_HUB_DISABLE_SYMLINKS_WARNING: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1', STT_PORT: port, FOR_DISABLE_CONSOLE_CTRL_HANDLER: '1' };
  state.sttPid = detached(py, ['-u', join(here, 'server.py')], 'stt.log', sttEnv, here);
  writeState(state);
  say('STT: starting (logs/stt.log) ...');
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    const h = await sttHealth();
    if (h) return say(`STT: up after ${((Date.now() - t0) / 1000).toFixed(0)} s (warm=${h.warm}; the model keeps loading in the background)`);
    await sleep(1000);
  }
  warn('STT: not healthy after 90 s; continuing without it (check logs/stt.log)');
}

async function ensureNamedTunnel(state) {
  const host = new URL(PUBLIC_URL).host;
  // switching from the old quick tunnel: it holds the metrics port (its /ready would look like ours) and its
  // trycloudflare link is dead weight once the permanent one is up -> stop it
  const quick = await getJson(`http://${METRICS}/quicktunnel`, 1200);
  if (quick && typeof quick.hostname === 'string' && quick.hostname.includes('.')) {
    say(`tunnel: stopping the old quick tunnel (https://${quick.hostname}) -> switching to ${PUBLIC_URL}`);
    if (state.tunnelPid && state.tunnelKind !== 'named') killTree(state.tunnelPid);
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match 'tunnel --url' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true });
    void r;
    await sleep(1500);
  }
  if (windowsServiceRunning()) {
    state.tunnelKind = 'service';
    writeState(state);
    say(`tunnel: Windows service 'Cloudflared' is running -> using it (${PUBLIC_URL})`);
    return host;
  }
  if (state.tunnelKind === 'named' && (await namedTunnelReady())) { say(`tunnel: re-attached named tunnel (${PUBLIC_URL})`); return host; }
  if (!NAMED.CLOUDFLARE_TUNNEL_TOKEN) {
    warn("tunnel: the 'Cloudflared' Windows service is not running and CLOUDFLARE_TUNNEL_TOKEN is not in .env: start the service (services.msc) or add the token");
    return host;
  }
  const exe = join(ROOT, 'tools/bin/cloudflared.exe');
  if (!existsSync(exe)) { warn('tunnel: tools/bin/cloudflared.exe missing'); return null; }
  const env = { ...process.env, TUNNEL_TOKEN: NAMED.CLOUDFLARE_TUNNEL_TOKEN };
  state.tunnelPid = detached(exe, ['tunnel', '--no-autoupdate', '--metrics', METRICS, 'run'], 'cloudflared.log', env);
  state.tunnelStartedAt = new Date().toISOString();
  state.tunnelKind = 'named';
  writeState(state);
  say(`tunnel: named tunnel starting (pid ${state.tunnelPid}, logs/cloudflared.log) ...`);
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000) {
    if (await namedTunnelReady()) { say(`tunnel: ${PUBLIC_URL} connected (${((Date.now() - t0) / 1000).toFixed(0)} s)`); return host; }
    await sleep(500);
  }
  warn('tunnel: named tunnel not ready after 45 s (check the token, the public hostname route play -> http://localhost:3000, and logs/cloudflared.log)');
  return host;
}

async function ensureTunnel(state) {
  if (process.argv.includes('--no-tunnel')) { say('tunnel: skipped (--no-tunnel)'); return null; }
  if (PUBLIC_URL) return ensureNamedTunnel(state);
  const existing = await tunnelHost();
  if (existing) { say(`tunnel: re-attached https://${existing}`); return existing; }
  const exe = join(ROOT, 'tools/bin/cloudflared.exe');
  if (!existsSync(exe)) { warn('tunnel: tools/bin/cloudflared.exe missing: friends cannot join from outside'); return null; }
  state.tunnelPid = detached(exe, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--metrics', METRICS, '--no-autoupdate'], 'cloudflared.log');
  state.tunnelStartedAt = new Date().toISOString();
  writeState(state);
  say(`tunnel: cloudflared started (pid ${state.tunnelPid}, logs/cloudflared.log), waiting for the hostname ...`);
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000) {
    const h = await tunnelHost();
    if (h) { say(`tunnel: https://${h} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); return h; }
    await sleep(500);
  }
  warn('tunnel: no hostname after 45 s (see logs/cloudflared.log); NOT starting another one');
  return null;
}

function build() {
  if (process.argv.includes('--no-build')) return say('build: skipped (--no-build)');
  if (TEST_SERVER_ENTRY) return say('build: skipped (HOST_SERVER_ENTRY: test stand-in server)');
  say('build: npm run build ...');
  const t0 = Date.now();
  const r = spawnSync('npm run build', { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) {
    console.error((r.stdout + r.stderr).split('\n').slice(-30).join('\n'));
    throw new Error('npm run build failed');
  }
  say(`build: ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

export function printInvite(state, host) {
  const local = `http://127.0.0.1:${state.serverPort ?? PORT}`;
  const link = host ? `https://${host}/#${state.crew}` : `${local}/#${state.crew}`;
  console.log('');
  console.log('================================================================');
  console.log(` HOST TAB (only you, keep private): ${local}/#${state.crew}&admin=${state.adminToken}`);
  console.log(` INVITE LINK: ${link}${host ? '' : '   (NO TUNNEL: local only)'}`);
  console.log(' Paste into Discord:');
  console.log('');
  console.log(`DEAD AIR tonight: open ${link} in Chrome, use a WIRED headset. Stay in Discord until you're in the van, then LEAVE Discord voice — the game voice is positional and the monsters hear it.`);
  console.log('');
  console.log(' Live fixes: node tools/server-restart.mjs (only while the crew is in the van; the link stays the same)');
  console.log('================================================================');
}

/** echo what gets appended to `file` (also once it appears); false with --no-follow */
function follow(file) {
  if (process.argv.includes('--no-follow')) return false;
  say(`following ${file} (Ctrl+C stops following and the watchdog; the servers keep running)`);
  let pos = existsSync(file) ? statSync(file).size : 0;
  const tick = () => {
    try {
      const size = statSync(file).size;
      if (size > pos) {
        createReadStream(file, { start: pos, end: size - 1 }).pipe(process.stdout, { end: false });
        pos = size;
      } else if (size < pos) pos = size;
    } catch { /* rotated */ }
    setTimeout(tick, 500);
  };
  tick();
  return true;
}

function reattach(state) {
  say(`game: re-attached to the server already running on :${PORT} (use --restart to replace it)`);
  if (!state.serverPid) state.serverPid = pidOnPort(PORT);
}

/** (g) for this window: announces what it watches, then startWatchdog */
function watchdogForHostWindow(port) {
  const ms = TEST_SERVER_ENTRY && Number(process.env.HOST_WATCHDOG_MS) > 0 ? Number(process.env.HOST_WATCHDOG_MS) : WATCHDOG.intervalMs;
  const cfg = { port, intervalMs: ms, timeoutMs: Math.min(WATCHDOG.timeoutMs, Math.max(100, Math.round(ms / 2))) };
  const spawned = readState().serverSpawnedPid;
  const onPort = pidOnPort(port);
  if (spawned && onPort === spawned) {
    say(`watchdog: on (polls /healthz every ${ms / 1000} s; restarts the game server after ${Math.round((WATCHDOG.failLimit * ms) / 1000)} s of silence, at most ${WATCHDOG.maxRestarts}x per ${WATCHDOG.windowMs / 60_000} min). Keep this window open.`);
  } else {
    say(`watchdog: on, but pid ${onPort ?? '(none)'} on :${port} was not started by npm run host / server:restart, so a hang is only reported; npm run server:restart puts the server under the watchdog`);
  }
  return startWatchdog(cfg);
}

async function main() {
  if (process.argv.includes('--desktop-only')) {
    // the server already runs (or runs later with the same saves/host.json): only (f), never new secrets
    const state = readState();
    if (!state.adminToken || !state.crew) {
      warn('desktop: saves/host.json has no admin token / crew yet: run `npm run host` once');
      process.exitCode = 1;
      return;
    }
    if (!writeDesktopHost(state, process.env.PORT ? PORT : Number(state.serverPort) || PORT)) process.exitCode = 1;
    return;
  }
  const state = ensureHostSecrets(readState());
  writeState(state);
  await ensureStt(state);
  const host = await ensureTunnel(state);
  const restart = process.argv.includes('--restart');
  if ((await serverHealthy()) && !restart) reattach(state);
  else {
    // a deliberate (re)start: hold the restart lock, so no watchdog (another npm run host window) acts meanwhile
    const lock = await waitForRestartLock(restart ? 'host --restart' : 'host', 60_000, (h) => say(`game: waiting for ${lockText(h)} to finish ...`));
    if (!lock) throw new Error(`another restart is still running (${lockText(readRestartLock())}); nothing was touched, try again in a minute`);
    try {
      // a watchdog restart may have replaced the server since this run read the state: take its pids and restart times
      const disk = readState();
      for (const k of ['serverPid', 'serverSpawnedPid', 'serverPort', 'serverStartedAt', 'watchdogRestarts']) state[k] = disk[k];
      const healthy = await serverHealthy();
      if (healthy && !restart) reattach(state); // it came back meanwhile
      else {
        build();
        if (healthy || pidOnPort(PORT)) {
          say('game: stopping the old game server ...');
          await stopGameServer(state);
        }
        const pid = await startGameServer(state);
        say(`game: prod server up on :${PORT} (pid ${pid}, logs/server.log)`);
      }
    } finally {
      lock.release();
    }
  }
  writeDesktopHost(state, PORT);
  if (host) {
    const inv = await getJson(`http://127.0.0.1:${PORT}/api/invite?code=${state.crew}`);
    if (inv?.url) say(`game: /api/invite -> ${inv.url}`);
  }
  printInvite(state, host);
  if (!follow(SERVER_LOG)) return;
  if (process.argv.includes('--no-watchdog')) say('watchdog: off (--no-watchdog): a hung game server is NOT restarted');
  else watchdogForHostWindow(PORT);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('[host] FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
