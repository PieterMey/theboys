// tools/host.mjs hang watchdog, unit level: the pure decision (watchdogStep) and the restart lock that
// tools/server-restart.mjs, `npm run host` and the watchdog share. No servers, no ports: the state and the locks live
// in a temp folder (HOST_STATE), never the repo's saves/. The end-to-end run is tests/host/watchdog.e2e.ts.
//   node --test tests/host/watchdog.test.ts
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { LockHolder, WatchdogAction, WatchdogMem, WatchdogObs } from './host-api.ts';
import { importHost } from './host-api.ts';

const TMP = mkdtempSync(join(tmpdir(), 'deadair-watchdog-unit-'));
process.env.HOST_STATE = join(TMP, 'host.json'); // before the import: host.mjs resolves its paths at load
process.env.HOST_LOGS = join(TMP, 'logs');
const host = await importHost();
after(() => rmSync(TMP, { recursive: true, force: true }));

const W = host.WATCHDOG;
const MIN = 60_000;
const T0 = 1_791_400_000_000;
/** a poll of a hung server that this flow started (alive, listening on the port, no restart lock) */
const hung = (o: Partial<WatchdogObs> = {}): WatchdogObs => ({ healthy: false, spawnedPid: 100, portPid: 100, alive: true, lock: null, restarts: [], now: T0, ...o });
const fine = (o: Partial<WatchdogObs> = {}): WatchdogObs => ({ healthy: true, spawnedPid: 100, now: T0, ...o });
const times = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
/** feeds the polls in order: every action, and the memory at the end */
function run(polls: WatchdogObs[], mem: WatchdogMem = {}): { actions: WatchdogAction[]; mem: WatchdogMem } {
  const actions: WatchdogAction[] = [];
  for (const o of polls) {
    const r = host.watchdogStep(mem, o);
    mem = r.mem;
    actions.push(r.action);
  }
  return { actions, mem };
}
const three = [T0 - 9 * MIN, T0 - 5 * MIN, T0 - 1 * MIN]; // 3 automatic restarts within the last 10 min
const deliberate: LockHolder = { pid: 7, by: 'server-restart', at: T0 };

describe('watchdogStep: when the host watchdog restarts the game server', () => {
  test('the numbers: polls every 10 s, 6 misses in a row (~60 s), at most 3 automatic restarts per 10 min', () => {
    assert.deepEqual({ ...W }, { intervalMs: 10_000, timeoutMs: 5000, failLimit: 6, maxRestarts: 3, windowMs: 10 * MIN });
  });

  test('restarts on the 6th miss in a row and warns half way; the decision lands ~60 s after the last answer', () => {
    const r = run([fine(), ...times(6, (i) => hung({ now: T0 + (i + 1) * W.intervalMs }))]);
    assert.deepEqual(r.actions, ['ok', 'miss', 'miss', 'warn', 'miss', 'miss', 'restart']);
    // on the real clock: polls every 10 s, the server freezes 3 s after a good poll, a silent poll costs its 5 s timeout
    let mem: WatchdogMem = {};
    let decidedAt = -1;
    for (let poll = 1; poll <= 12 && decidedAt < 0; poll++) {
      const t = poll * W.intervalMs;
      const step = host.watchdogStep(mem, t < 13_000 ? fine({ now: t }) : hung({ now: t }));
      mem = step.mem;
      if (step.action === 'restart') decidedAt = t + W.timeoutMs;
    }
    assert.equal(decidedAt - 13_000, 62_000, 'frozen at 13 s, restart decided at 75 s');
  });

  test('one answer in between resets the count (a slow moment is not a hang)', () => {
    const r = run([...times(5, () => hung()), fine(), ...times(5, () => hung())]);
    assert.equal(r.actions[5], 'ok');
    assert.ok(!r.actions.includes('restart'), r.actions.join(','));
  });

  test('never while a deliberate restart holds the lock; acts on the next poll once it is gone', () => {
    const r = run([...times(5, () => hung()), ...times(4, () => hung({ lock: deliberate })), hung()]);
    assert.deepEqual(r.actions.slice(5), ['busy', 'busy', 'busy', 'busy', 'restart']);
  });

  test('a deliberate restart that replaced the server starts the count afresh (no restart of the new one)', () => {
    const next = { spawnedPid: 101, portPid: 101 };
    const r = run([...times(5, () => hung()), hung({ lock: deliberate }), hung({ ...next, lock: deliberate }), ...times(4, () => hung(next))]);
    assert.deepEqual(r.actions, ['miss', 'miss', 'warn', 'miss', 'miss', 'busy', 'miss', 'miss', 'warn', 'miss', 'miss']);
    assert.equal(r.mem.fails, 5);
  });

  test('never a server this flow did not start', () => {
    // another pid on the port (started by hand, or by another checkout's host flow)
    assert.equal(run(times(6, () => hung({ portPid: 200 }))).actions[5], 'foreign');
    // re-attached to a server it never started: no serverSpawnedPid (also every state file from before the watchdog)
    assert.equal(run(times(6, () => hung({ spawnedPid: null, portPid: 200 }))).actions[5], 'foreign');
    assert.equal(run(times(9, () => hung({ portPid: 200 }))).actions.filter((a) => a === 'restart').length, 0);
  });

  test('a crash is not a hang: reported, never restarted', () => {
    assert.equal(run(times(6, () => hung({ portPid: null, alive: false }))).actions[5], 'gone');
    assert.equal(run(times(6, () => hung({ portPid: null, alive: true }))).actions[5], 'gone'); // alive but not listening
    assert.equal(run(times(6, () => hung({ alive: false }))).actions[5], 'gone');
  });

  test('at most 3 automatic restarts in 10 min: the 4th hang gives up, and it stays given up', () => {
    const r = run([...times(9, () => hung({ restarts: three })), fine(), ...times(6, () => hung({ restarts: three }))]);
    assert.equal(r.actions[5], 'give-up');
    assert.deepEqual(r.actions.slice(6, 9), ['off', 'off', 'off']);
    assert.equal(r.actions[9], 'ok');
    assert.equal(r.actions.at(-1), 'off', 'a new hang after it recovered is still not restarted');
    assert.equal(r.mem.gaveUp, true);
    assert.ok(!r.actions.includes('restart'));
    // restarts older than 10 min no longer count
    assert.equal(run(times(6, () => hung({ restarts: [T0 - 11 * MIN, T0 - 10 * MIN, T0 - 1 * MIN] }))).actions[5], 'restart');
    assert.equal(run(times(6, () => hung({ restarts: [T0 - 5 * MIN, T0 - 1 * MIN] }))).actions[5], 'restart');
  });

  test("a deliberate restart re-arms a watchdog that gave up (its own restart does not), within the same budget", () => {
    const gaveUp: WatchdogMem = { fails: 6, seenPid: 100, ownPid: 100, gaveUp: true };
    // the server the watchdog itself started: still given up
    assert.equal(host.watchdogStep({ ...gaveUp, ownPid: 101 }, fine({ spawnedPid: 101 })).mem.gaveUp, true);
    // server:restart / npm run host --restart started 102: re-armed, counting from zero
    const r = host.watchdogStep(gaveUp, hung({ spawnedPid: 102, portPid: 102 }));
    assert.deepEqual([r.mem.gaveUp, r.mem.fails, r.mem.seenPid], [false, 1, 102]);
    assert.equal(run(times(6, () => hung({ spawnedPid: 102, portPid: 102 })), gaveUp).actions[5], 'restart');
    // ...but 3 automatic restarts in the window still mean no 4th one
    assert.equal(run(times(6, () => hung({ spawnedPid: 102, portPid: 102, restarts: three })), gaveUp).actions[5], 'give-up');
  });
});

describe('restart lock (server-restart.mjs, npm run host and the watchdog)', () => {
  let n = 0;
  const lockFile = () => join(TMP, `lock-${++n}.lock`);
  const alivePid = process.ppid; // the test runner / shell: alive for the whole test
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // has exited when spawnSync returns

  test('the lock sits next to the host state (saves/host.restart.lock for saves/host.json)', () => {
    assert.equal(host.RESTART_LOCK, join(TMP, 'host.restart.lock'));
  });

  test('one holder at a time, the same process included; release frees it', () => {
    const f = lockFile();
    const a = host.acquireRestartLock('server-restart', f);
    assert.ok(a);
    assert.deepEqual({ ...host.readRestartLock(f), at: 0 }, { pid: process.pid, by: 'server-restart', at: 0 });
    assert.equal(host.restartInProgress(f)?.by, 'server-restart');
    assert.equal(host.acquireRestartLock('watchdog', f), null);
    a.release();
    assert.equal(existsSync(f), false);
    assert.equal(host.restartInProgress(f), null);
    const b = host.acquireRestartLock('watchdog', f);
    assert.ok(b);
    b.release();
  });

  test("another live process's lock blocks, and release() never removes it", () => {
    const f = lockFile();
    writeFileSync(f, JSON.stringify({ pid: alivePid, by: 'host --restart', at: Date.now() }));
    assert.equal(host.acquireRestartLock('watchdog', f), null);
    assert.equal(host.restartInProgress(f)?.pid, alivePid);
    host.releaseRestartLock(f);
    assert.ok(existsSync(f));
  });

  test('stale locks are taken over: the holder is gone, or the lock is older than 10 min', () => {
    const f = lockFile();
    writeFileSync(f, JSON.stringify({ pid: deadPid(), by: 'server-restart', at: Date.now() }));
    assert.equal(host.restartInProgress(f), null);
    const a = host.acquireRestartLock('watchdog', f);
    assert.ok(a);
    assert.equal(host.readRestartLock(f)?.pid, process.pid);
    a.release();
    writeFileSync(f, JSON.stringify({ pid: alivePid, by: 'server-restart', at: Date.now() - 9 * MIN }));
    assert.equal(host.acquireRestartLock('watchdog', f), null, '9 min old, holder alive: still held');
    writeFileSync(f, JSON.stringify({ pid: alivePid, by: 'server-restart', at: Date.now() - 11 * MIN }));
    const b = host.acquireRestartLock('watchdog', f);
    assert.ok(b, '11 min old: stale');
    b.release();
  });

  test('a lock file caught half written counts as held for 5 s, then as stale', () => {
    const f = lockFile();
    writeFileSync(f, '{"pid":');
    assert.equal(host.readRestartLock(f)?.pid, 0);
    assert.equal(host.acquireRestartLock('watchdog', f), null);
    const old = new Date(Date.now() - 10_000);
    utimesSync(f, old, old);
    const a = host.acquireRestartLock('watchdog', f);
    assert.ok(a);
    a.release();
  });

  test('waitForRestartLock waits for the holder, then takes the lock; or gives up after its time', async () => {
    const f = lockFile();
    writeFileSync(f, JSON.stringify({ pid: alivePid, by: 'watchdog', at: Date.now() }));
    const seen: (LockHolder | null)[] = [];
    const t0 = Date.now();
    assert.equal(await host.waitForRestartLock('server-restart', 700, (h) => seen.push(h), f), null);
    assert.ok(Date.now() - t0 >= 700);
    assert.equal(seen.length, 1, 'onWait is called once');
    assert.equal(seen[0]?.by, 'watchdog');
    setTimeout(() => rmSync(f, { force: true }), 600);
    const got = await host.waitForRestartLock('server-restart', 5000, () => {}, f);
    assert.ok(got);
    assert.equal(host.readRestartLock(f)?.by, 'server-restart');
    got.release();
  });
});
