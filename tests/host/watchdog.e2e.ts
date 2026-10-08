// Host hang watchdog, end to end (no browser, no GPU): tools/host.mjs's real startGameServer / stopGameServer /
// startWatchdog in process, and the real CLIs (tools/host.mjs, tools/server-restart.mjs), against
// tests/host/fake-server.mjs: a stand-in that answers /healthz until GET /hang, then spins a core like the
// 2026-10-08 Listener freeze (process alive, port held, /healthz silent).
// Ports 3820 (in process), 3821 (the CLIs) and 3822 (--real) only. State, logs and the restart lock live in a temp
// folder; it never touches :3000, the repo's saves/ or logs/, %APPDATA%, cloudflared or the STT sidecar, and it kills
// only its own children and whatever listens on 3820-3822. Every stand-in runs with NODE_ENV=development AI_MODE=mock
// and SAVES_DIR / SESSION_FILE from the env (default: the temp folder).
//   node tests/host/watchdog.e2e.ts          fast polls (0.4 s), about 1.5 min
//   node tests/host/watchdog.e2e.ts --real   then one hang at the real numbers (10 s polls: restart after ~60 s), +75 s
//   --keep                                   keep the temp folder (state, logs) for a look
import { strict as assert } from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HostState } from './host-api.ts';
import { importHost } from './host-api.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FAKE = 'tests/host/fake-server.mjs';
const REAL = process.argv.includes('--real');
const KEEP = process.argv.includes('--keep');
const PA = 3820;
const PB = 3821;
const PC = 3822;
const T = mkdtempSync(join(tmpdir(), 'deadair-watchdog-e2e-'));
const A = join(T, 'a');
const B = join(T, 'b');
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  AI_MODE: 'mock',
  SAVES_DIR: process.env.SAVES_DIR ?? join(T, 'saves'),
  SESSION_FILE: process.env.SESSION_FILE ?? join(T, 'session.json'),
  HOST_SERVER_ENTRY: FAKE,
  DEADAIR_HOST_FILE: join(T, 'desktop-host.json'),
  CF_METRICS: '127.0.0.1:9', // never the host's cloudflared metrics
  STT_URL: 'http://127.0.0.1:9', // never the host's STT sidecar
};
const envFor = (port: number, dir: string): Record<string, string> => ({ ...BASE_ENV, PORT: String(port), HOST_STATE: join(dir, 'host.json'), HOST_LOGS: join(dir, 'logs') });
Object.assign(process.env, envFor(PA, A));
delete process.env.FAKE_EXIT_AT_START;
delete process.env.HOST_WATCHDOG_MS;
const host = await importHost();
const HOST_URL = pathToFileURL(join(ROOT, 'tools/host.mjs')).href;

// ---- helpers ----------------------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const children: ChildProcess[] = [];
const measured: string[] = [];

async function waitFor<V>(what: string, ms: number, fn: () => V | Promise<V>): Promise<NonNullable<V>> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<V>;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await sleep(100);
  }
}
/** the stand-in's own pid from /healthz, or null when nothing answers */
async function healthPid(port: number): Promise<number | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(600) });
    const j = (await r.json()) as { ok?: boolean; pid?: number };
    return j.ok && j.pid ? j.pid : null;
  } catch {
    return null;
  }
}
/** freeze the stand-in on `port`; returns its pid */
async function hang(port: number): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/hang`, { signal: AbortSignal.timeout(3000) });
  const pid = Number(/pid (\d+)/.exec(await r.text())?.[1]);
  assert.ok(pid > 0, 'the stand-in reported its pid');
  return pid;
}
const stateOf = (dir: string): HostState => {
  try {
    return JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8')) as HostState;
  } catch {
    return {};
  }
};
const logOf = (dir: string): string => {
  try {
    return readFileSync(join(dir, 'logs', 'server.log'), 'utf8');
  } catch {
    return '';
  }
};
const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, 'g')) ?? []).length;
const RESTARTING = /watchdog: game server not answering for \d+ s, restarting \(pid \d+/;
/** automatic restarts inside the 10 min window, from the shared state */
const recentRestarts = (dir: string) => (stateOf(dir).watchdogRestarts ?? []).filter((t) => Date.now() - t < 10 * 60_000).length;
/** waits until the state names a server other than `not` and that server answers on `port` */
async function newServer(port: number, dir: string, not: number[], ms: number): Promise<number> {
  return waitFor(`a new healthy server on :${port} (not ${not.join(', ')})`, ms, async () => {
    const pid = stateOf(dir).serverSpawnedPid;
    return pid && !not.includes(pid) && (await healthPid(port)) === pid ? pid : null;
  });
}
/** newServer, plus the watchdog's own "back up" line for it: its restart is over and the restart lock released (the
 *  line and the release happen in one synchronous run), so the next freeze is a new episode */
async function restartedBy(text: () => string, port: number, dir: string, not: number[], ms: number): Promise<number> {
  const pid = await newServer(port, dir, not, ms);
  await waitFor(`the watchdog's back-up line for pid ${pid}`, 5000, () => new RegExp(`watchdog: game server back up after [\\d.]+ s \\(pid ${pid}\\)`).test(text()));
  return pid;
}
function killTree(pid: number | null | undefined) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}
/** kill our children still running, then whatever listens on the test ports (only ever ours) */
function killMine() {
  for (const c of children) if (c.pid && c.exitCode === null && c.signalCode === null) killTree(c.pid);
  for (let i = 0; i < 5; i++) {
    const held = [PA, PB, PC].map((p) => host.pidOnPort(p)).filter((p): p is number => !!p);
    if (!held.length) return;
    for (const p of held) killTree(p);
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 300)']);
  }
}
const scrub = (s: string) => s.split('\n').filter((l) => !/admin=|adminToken/i.test(l)).join('\n');

// ---- safety first -------------------------------------------------------------------------------------------------------
assert.equal(host.PORT, PA, 'PORT overridden before the import');
assert.equal(host.TEST_SERVER_ENTRY, FAKE);
assert.ok(host.serverArgs()[0].endsWith('fake-server.mjs') && !host.serverArgs().some((a) => a.includes('.env')), 'the stand-in, never the game server or the .env file');
for (const p of [PA, PB, PC]) assert.equal(host.pidOnPort(p), null, `port ${p} must be free before the test`);
const deadline = setTimeout(() => {
  console.error('FAIL: the whole test timed out');
  killMine();
  process.exit(1);
}, REAL ? 330_000 : 200_000);

let wd: { stop(): Promise<void> } | null = null;
let out = ''; // the CLI host window's console
let failed = false;
try {
  // ---- A: in process, :3820, the real functions -------------------------------------------------------------------
  console.log(`== A: in process on :${PA} (polls every 0.4 s; 6 misses, 3 restarts per 10 min as in production)`);
  let state = host.ensureHostSecrets(host.readState());
  host.writeState(state);
  const p0 = await host.startGameServer(state, PA);
  assert.equal(host.pidOnPort(PA), p0, 'the stand-in listens itself: pid on the port = pid spawned');
  assert.equal(host.readState().serverSpawnedPid, p0);
  assert.match(logOf(A), /NODE_ENV=development, AI_MODE=mock, args --prod/);

  // A0 before: nothing restarts a hung server
  await hang(PA);
  await sleep(4000);
  assert.ok(host.pidAlive(p0) && host.pidOnPort(PA) === p0 && !(await host.serverHealthy(PA, 500)));
  console.log('PASS A0 before: without the watchdog a frozen server stays frozen (4.0 s: alive, port held, /healthz silent)');

  // A1 the watchdog kills it and starts a new one
  wd = host.startWatchdog({ port: PA, intervalMs: 400, timeoutMs: 250 });
  let t = Date.now();
  await waitFor('the restart line', 10_000, () => count(logOf(A), RESTARTING) === 1);
  const detect = Date.now() - t;
  const p1 = await restartedBy(() => logOf(A), PA, A, [p0], 10_000);
  const up = Date.now() - t;
  assert.ok(!host.pidAlive(p0), 'the hung process tree is gone');
  assert.equal(recentRestarts(A), 1);
  assert.match(logOf(A), new RegExp(`\\[host\\] watchdog: game server not answering for 2 s, restarting \\(pid ${p0}; automatic restart 1 of at most 3 per 10 min\\)`));
  assert.match(logOf(A), new RegExp(`\\[host\\] watchdog: game server back up after [\\d.]+ s \\(pid ${p1}\\); crews reconnect on their own`));
  assert.match(logOf(A), /\[host\] watchdog: game server on :3820 not answering \/healthz for 1 s \(restart after 2 s of silence\)/);
  measured.push(`A1 restart line ${secs(detect)} after the watchdog started on a frozen server (6 polls x 0.4 s), healthy again at ${secs(up)}`);
  console.log(`PASS A1 hung pid ${p0} -> restarted as pid ${p1} (${measured.at(-1)})`);

  // A2 a deliberate restart in progress (another process holds the lock): left alone, restarted once it is over
  const HOLD = "const h = await import(process.argv[1]); const l = h.acquireRestartLock('test: deliberate restart'); console.log(l ? 'held' : 'busy'); setTimeout(() => { l?.release(); process.exit(0); }, Number(process.argv[2]));";
  const holder = spawn(process.execPath, ['--input-type=module', '-e', HOLD, HOST_URL, '5000'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  children.push(holder);
  let held = '';
  holder.stdout?.on('data', (d: Buffer) => { held += String(d); });
  await waitFor('the lock holder', 10_000, () => held.includes('held'));
  assert.equal(host.restartInProgress()?.by, 'test: deliberate restart');
  await hang(PA);
  await sleep(3500); // 6 polls of 0.4 s are 2.4 s
  assert.equal(host.pidOnPort(PA), p1);
  assert.ok(host.pidAlive(p1));
  assert.equal(count(logOf(A), RESTARTING), 1, 'no restart while the lock is held');
  assert.match(logOf(A), /watchdog: game server not answering for \d+ s, but a restart is in progress \(test: deliberate restart \(pid \d+/);
  await waitFor('the lock released', 6000, () => !host.restartInProgress());
  t = Date.now();
  const p2 = await restartedBy(() => logOf(A), PA, A, [p1], 10_000);
  assert.equal(recentRestarts(A), 2);
  console.log(`PASS A2 a held restart lock kept the watchdog off a frozen server for 5 s; restarted ${secs(Date.now() - t)} after the release (pid ${p2})`);

  // A3 a crash is reported, not restarted; a server this flow did not start is never touched
  assert.equal(host.pidOnPort(PA), p2);
  killTree(p2);
  await waitFor('the port free', 8000, () => !host.pidOnPort(PA));
  await waitFor('the DOWN report', 8000, () => /watchdog: the game server is DOWN: nothing answers on :3820 \(pid \d+ exited\)/.test(logOf(A)));
  const foreign = spawn(process.execPath, [FAKE], { cwd: ROOT, env: { ...process.env, PORT: String(PA) }, detached: true, stdio: 'ignore', windowsHide: true });
  children.push(foreign);
  const pf = foreign.pid ?? 0;
  await waitFor('the foreign stand-in', 8000, async () => (await healthPid(PA)) === pf);
  await hang(PA);
  await sleep(3500);
  assert.equal(host.pidOnPort(PA), pf);
  assert.ok(host.pidAlive(pf), 'the foreign server was not killed');
  assert.match(logOf(A), new RegExp(`pid ${pf} on :3820 was not started by npm run host / server:restart: not touching it`));
  assert.equal(recentRestarts(A), 2);
  killTree(pf);
  await waitFor('the port free', 8000, () => !host.pidOnPort(PA));
  console.log(`PASS A3 a crash was reported (DOWN), not restarted; a frozen server it did not start (pid ${pf}) was left alone`);

  // A4 the budget: the 3rd automatic restart in 10 min happens, the 4th hang gives up loudly and stays frozen
  state = host.readState();
  const p3 = await host.startGameServer(state, PA); // a deliberate start (npm run host)
  await hang(PA);
  const p4 = await restartedBy(() => logOf(A), PA, A, [p3], 10_000);
  assert.equal(recentRestarts(A), 3);
  await hang(PA);
  t = Date.now();
  await waitFor('the GIVING UP banner', 10_000, () => /watchdog: GIVING UP: the game server hung again after 3 automatic restarts in 10 min\./.test(logOf(A)));
  const gaveUpAfter = Date.now() - t;
  await sleep(2500);
  assert.equal(host.pidOnPort(PA), p4);
  assert.ok(host.pidAlive(p4) && !(await host.serverHealthy(PA, 300)), 'left frozen');
  assert.equal(recentRestarts(A), 3);
  assert.equal(count(logOf(A), RESTARTING), 3);
  assert.match(logOf(A), /watchdog: NOT restarting it any more; it stays frozen until you act/);
  console.log(`PASS A4 3 automatic restarts, then the 4th hang: GIVING UP after ${secs(gaveUpAfter)}, no 4th restart`);

  // A5 a deliberate restart (what server-restart.mjs does, under the lock) re-arms it; the 10 min budget still holds,
  //    and once those restarts are older than 10 min it restarts again
  const deliberate = async (): Promise<number> => {
    const lock = host.acquireRestartLock('test: server-restart');
    assert.ok(lock);
    try {
      const s = host.readState();
      await host.stopGameServer(s, PA);
      return await host.startGameServer(s, PA);
    } finally {
      lock.release();
    }
  };
  const p5 = await deliberate();
  assert.ok(!host.pidAlive(p4));
  await sleep(1000);
  await hang(PA);
  await waitFor('a second GIVING UP', 10_000, () => count(logOf(A), /watchdog: GIVING UP/) === 2);
  await sleep(1500);
  assert.equal(host.pidOnPort(PA), p5);
  assert.equal(recentRestarts(A), 3);
  state = host.readState();
  state.watchdogRestarts = (state.watchdogRestarts ?? []).map((x) => x - 11 * 60_000); // as if 11 min had passed
  host.writeState(state);
  const p6 = await deliberate();
  await sleep(1000);
  await hang(PA);
  const p7 = await restartedBy(() => logOf(A), PA, A, [p6], 10_000);
  assert.equal(recentRestarts(A), 1);
  assert.equal(count(logOf(A), RESTARTING), 4);
  console.log(`PASS A5 re-armed by a deliberate restart but still within budget: GIVING UP again; budget aged out: restarted (pid ${p7})`);

  // A6 a restart whose new server dies at boot: reported loudly, then DOWN, no retry loop
  assert.equal(count(logOf(A), /RESTART FAILED/), 0, 'every restart so far came up');
  process.env.FAKE_EXIT_AT_START = '1';
  await hang(PA);
  await waitFor('RESTART FAILED', 10_000, () => /watchdog: RESTART FAILED: game server did not come up on :3820/.test(logOf(A)));
  delete process.env.FAKE_EXIT_AT_START;
  const downs = count(logOf(A), /the game server is DOWN/);
  await waitFor('DOWN after the failed restart', 8000, () => count(logOf(A), /the game server is DOWN/) > downs);
  await sleep(1500);
  assert.equal(host.pidOnPort(PA), null);
  assert.ok(!host.pidAlive(p7));
  assert.equal(recentRestarts(A), 2, 'the failed attempt counts; nothing retried it');
  await wd.stop();
  wd = null;
  console.log('PASS A6 a restart that never came up: RESTART FAILED, then DOWN, no retry loop');

  // ---- B: the CLIs on :3821 ---------------------------------------------------------------------------------------
  console.log(`== B: node tools/host.mjs (its log follower + watchdog), server-restart.mjs and host --restart on :${PB}`);
  const envB = { ...process.env, ...envFor(PB, B), HOST_WATCHDOG_MS: '400' };
  const hostArgs = ['tools/host.mjs', '--no-build', '--no-stt', '--no-tunnel', '--no-desktop'];
  const win = spawn(process.execPath, hostArgs, { cwd: ROOT, env: envB, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.push(win);
  win.stdout?.on('data', (d: Buffer) => { out += String(d); });
  win.stderr?.on('data', (d: Buffer) => { out += String(d); });
  await waitFor('the host window with its watchdog', 20_000, () => /\[host\] watchdog: on \(polls \/healthz every 0\.4 s; restarts the game server after 2 s of silence, at most 3x per 10 min\)/.test(out));
  assert.match(out, /build: skipped/);
  const b1 = stateOf(B).serverSpawnedPid ?? 0;
  assert.equal(host.pidOnPort(PB), b1);

  // B1 a hang: the window shows the watchdog's lines (echoed from logs/server.log) and the server comes back
  await hang(PB);
  t = Date.now();
  await waitFor('the restart shown in the host window', 15_000, () => /watchdog: game server not answering for 2 s, restarting/.test(out));
  const b2 = await restartedBy(() => out, PB, B, [b1], 10_000);
  console.log(`PASS B1 the host window printed the restart (${secs(Date.now() - t)} after the freeze); pid ${b1} -> ${b2}`);

  // B2 server-restart.mjs right after a freeze: it holds the lock; the window's watchdog leaves it alone, follows the new pid
  await hang(PB);
  const rs = spawnSync(process.execPath, ['tools/server-restart.mjs'], { cwd: ROOT, env: envB, encoding: 'utf8', timeout: 90_000, windowsHide: true });
  assert.equal(rs.status, 0, scrub(rs.stdout + rs.stderr));
  assert.match(rs.stdout, /\[restart\] game server up again in [\d.]+ s/);
  const b3 = stateOf(B).serverSpawnedPid ?? 0;
  assert.ok(b3 !== b2 && (await healthPid(PB)) === b3);
  await sleep(3500);
  assert.equal(count(out, RESTARTING), 1, 'the watchdog did not restart anything around server:restart');
  assert.equal(stateOf(B).serverSpawnedPid, b3);
  console.log(`PASS B2 server-restart.mjs on a frozen server: one restart (pid ${b3}), the watchdog stayed out of it`);

  // B3 npm run host --restart from a second window
  const rh = spawnSync(process.execPath, [...hostArgs, '--restart', '--no-follow'], { cwd: ROOT, env: envB, encoding: 'utf8', timeout: 90_000, windowsHide: true });
  assert.equal(rh.status, 0, scrub(rh.stdout + rh.stderr));
  assert.match(rh.stdout, /game: stopping the old game server/);
  const b4 = stateOf(B).serverSpawnedPid ?? 0;
  assert.ok(b4 !== b3 && (await healthPid(PB)) === b4);
  await sleep(1500);
  assert.equal(count(out, RESTARTING), 1);
  console.log(`PASS B3 host --restart from a second window: pid ${b4}, no watchdog restart`);

  // B4 the first window's watchdog now guards the server the second window started
  await hang(PB);
  await waitFor('a second restart in the host window', 15_000, () => count(out, RESTARTING) === 2);
  const b5 = await restartedBy(() => out, PB, B, [b4], 10_000);
  console.log(`PASS B4 the first window's watchdog restarted the server another window started (pid ${b4} -> ${b5})`);
  win.kill(); // like closing the console: only the window's process (its detached servers live on)
  await waitFor('the host window gone', 8000, () => win.exitCode !== null || win.signalCode !== null);
  await sleep(500);
  assert.equal(await healthPid(PB), b5, 'closing the host window leaves the game server running');

  /** a host window that re-attaches (the server is healthy): its console, and a stop() */
  const reattachWindow = async (extra: string[], banner: RegExp) => {
    let text = '';
    const w = spawn(process.execPath, [...hostArgs, ...extra], { cwd: ROOT, env: envB, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(w);
    w.stdout?.on('data', (d: Buffer) => { text += String(d); });
    w.stderr?.on('data', (d: Buffer) => { text += String(d); });
    await waitFor(`the banner ${banner}`, 20_000, () => banner.test(text));
    assert.match(text, /game: re-attached to the server already running on :3821/);
    return {
      text: () => text,
      stop: async () => {
        w.kill();
        await waitFor('the window gone', 8000, () => w.exitCode !== null || w.signalCode !== null);
      },
    };
  };
  // B5 re-attach with --no-watchdog
  const w5 = await reattachWindow(['--no-watchdog'], /\[host\] watchdog: off \(--no-watchdog\)/);
  await w5.stop();
  // B6 re-attach to a server from a state file written before the watchdog existed (no serverSpawnedPid: the live
  //    checkout's state tonight): reported, never touched, until a deliberate restart
  const legacy = stateOf(B);
  delete legacy.serverSpawnedPid;
  delete legacy.watchdogRestarts;
  writeFileSync(join(B, 'host.json'), JSON.stringify(legacy, null, 1));
  const w6 = await reattachWindow([], new RegExp(`\\[host\\] watchdog: on, but pid ${b5} on :3821 was not started by npm run host / server:restart, so a hang is only reported`));
  await hang(PB);
  await waitFor('the not-ours report', 10_000, () => new RegExp(`pid ${b5} on :3821 was not started by npm run host / server:restart: not touching it`).test(w6.text()));
  await sleep(1500);
  assert.equal(host.pidOnPort(PB), b5);
  assert.ok(host.pidAlive(b5), 'not killed');
  assert.equal(count(w6.text(), RESTARTING), 0);
  await w6.stop();
  console.log('PASS B5/B6 re-attach: --no-watchdog says off; a pre-watchdog state file: banner says "not started by", the frozen server is left alone');

  // ---- C: the real numbers (--real) ------------------------------------------------------------------------------
  if (REAL) {
    console.log(`== C: in process on :${PC} with the production numbers (10 s polls, 5 s timeout, 6 misses)`);
    state = host.readState();
    state.watchdogRestarts = [];
    host.writeState(state);
    const c0 = await host.startGameServer(state, PC);
    wd = host.startWatchdog({ port: PC });
    await hang(PC);
    t = Date.now();
    await waitFor('the restart at the real numbers', 100_000, () => /watchdog: game server not answering for 60 s, restarting \(pid \d+/.test(logOf(A)));
    const det = Date.now() - t;
    const c1 = await newServer(PC, A, [c0], 40_000);
    const upC = Date.now() - t;
    await wd.stop();
    wd = null;
    assert.ok(det >= 50_000 && det <= 76_000, `restart decided after ${det} ms`);
    measured.push(`C real numbers: "watchdog: game server not answering for 60 s, restarting" ${secs(det)} after the freeze, healthy again (pid ${c1}) at ${secs(upC)}`);
    console.log(`PASS C ${measured.at(-1)}`);
  }
} catch (e) {
  failed = true;
  console.error(`FAIL: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  console.error(`--- log A (tail)\n${logOf(A).split('\n').slice(-25).join('\n')}`);
  if (out) console.error(`--- host window (tail)\n${scrub(out).split('\n').slice(-25).join('\n')}`);
} finally {
  if (wd) await wd.stop();
  killMine();
  clearTimeout(deadline);
}

const left = [PA, PB, PC].filter((p) => host.pidOnPort(p));
if (left.length) {
  failed = true;
  console.error(`FAIL: still listening on ${left.join(', ')}`);
}
for (const m of measured) console.log(`measured: ${m}`);
if (KEEP) console.log(`kept: ${T}`);
else rmSync(T, { recursive: true, force: true });
console.log(failed ? 'host watchdog e2e: FAIL' : 'host watchdog e2e: OK');
process.exitCode = failed ? 1 : 0;
