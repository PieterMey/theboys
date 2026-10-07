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
// State (pids, admin token, the night's crew code) lives in saves/host.json (gitignored, never commit).
// Flags: --no-build --no-stt --no-tunnel --restart --no-follow --no-desktop --desktop-only.
// Env: PORT (3000), CF_METRICS (127.0.0.1:20241), DEADAIR_HOST_FILE (tests: write the desktop host file there).
// NAMED TUNNEL (permanent link): set PUBLIC_URL (e.g. https://play.dead-air.io) in .env, plus CLOUDFLARE_TUNNEL_TOKEN.
//   If the 'Cloudflared' Windows service is installed and running, it is used and nothing is started (the token is
//   then optional). Otherwise the token is passed to cloudflared via the TUNNEL_TOKEN env var (never on the command
//   line / in logs). Either way an old quick tunnel is stopped and invites use PUBLIC_URL.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const ENV_FILE = 'C:/Users/Pieter/repos/theboys/.env';
export const PORT = Number(process.env.PORT ?? 3000);
export const METRICS = process.env.CF_METRICS ?? '127.0.0.1:20241';
export const STT_URL = process.env.STT_URL ?? 'http://127.0.0.1:3100';
const STATE = process.env.HOST_STATE ? resolve(ROOT, process.env.HOST_STATE) : join(ROOT, 'saves', 'host.json');
const LOGS = join(ROOT, 'logs');
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
  const tmp = `${STATE}.tmp`;
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

export async function serverHealthy(port = PORT) {
  return (await getJson(`http://127.0.0.1:${port}/healthz`, 1200))?.ok === true;
}

function detached(cmd, args, logName, env = process.env, cwd = ROOT) {
  mkdirSync(LOGS, { recursive: true });
  const fd = openSync(join(LOGS, logName), 'a');
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
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

/** start the prod game server detached; resolves once /healthz answers */
export async function startGameServer(state, port = PORT) {
  // AI_MODE defaults to 'live' for the real session (dev/tests default to mock); override with AI_MODE=mock
  const env = { ...process.env, AI_MODE: process.env.AI_MODE ?? 'live', PORT: String(port), NODE_ENV: 'production', ADMIN_TOKEN: state.adminToken, HOST_CREW: state.crew };
  if (PUBLIC_URL) env.INVITE_BASE = PUBLIC_URL;
  const args = existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`, 'apps/server/src/index.ts', '--prod'] : ['apps/server/src/index.ts', '--prod'];
  const pid = detached(process.execPath, args, 'server.log', env);
  state.serverPid = pid;
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

function follow(file) {
  if (process.argv.includes('--no-follow') || !existsSync(file)) return;
  say(`following ${file} (Ctrl+C stops following; the servers keep running)`);
  let pos = statSync(file).size;
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
  const healthy = await serverHealthy();
  if (healthy && !process.argv.includes('--restart')) {
    say(`game: re-attached to the server already running on :${PORT} (use --restart to replace it)`);
    if (!state.serverPid) state.serverPid = pidOnPort(PORT);
  } else {
    build();
    if (healthy || pidOnPort(PORT)) {
      say('game: stopping the old game server ...');
      await stopGameServer(state);
    }
    const pid = await startGameServer(state);
    say(`game: prod server up on :${PORT} (pid ${pid}, logs/server.log)`);
  }
  writeDesktopHost(state, PORT);
  if (host) {
    const inv = await getJson(`http://127.0.0.1:${PORT}/api/invite?code=${state.crew}`);
    if (inv?.url) say(`game: /api/invite -> ${inv.url}`);
  }
  printInvite(state, host);
  follow(join(LOGS, 'server.log'));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('[host] FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
