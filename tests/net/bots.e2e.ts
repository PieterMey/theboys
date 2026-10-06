// Track ① Net e2e (no browser): prod server on a free port with its own SESSION_FILE; bots join a crew, walk,
// get corrected on a teleport, drop + resume, then the server is RESTARTED and the bots must come back with the
// same ids into the same (restored) crew in 'hub', leader order kept; stale build + unknown crew are rejected.
// Run: node tests/net/bots.e2e.ts
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Bot } from './bot.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ART = join(ROOT, 'tests/artifacts/net');
mkdirSync(ART, { recursive: true });
const SESSION = join(ART, 'session-bots.json');
rmSync(SESSION, { force: true });
const ADMIN = randomBytes(12).toString('hex');

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});
const PORT = Number(process.env.NET_TEST_PORT ?? (await freePort()));
const URL = `ws://127.0.0.1:${PORT}/ws`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, failN = 0;
const check = (name: string, ok: boolean, info = '') => {
  ok ? pass++ : failN++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};

let log = '';
function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['apps/server/src/index.ts', '--prod'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', ADMIN_TOKEN: ADMIN, SESSION_FILE: SESSION, AI_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  return (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return child; } catch { /* not yet */ }
      await sleep(150);
    }
    throw new Error('server did not start:\n' + log.slice(-2000));
  })();
}
async function stopServer(c: ChildProcess): Promise<void> {
  const done = new Promise((r) => c.once('exit', r));
  c.kill();
  await Promise.race([done, sleep(5000)]);
}

let server = await startServer();
const bots: Bot[] = [];
try {
  // ---- join ----
  const a = new Bot({ url: URL, name: 'Alpha', crew: '', admin: ADMIN });
  const wa = await a.connect();
  const code = wa.crew.code;
  check('admin creates a crew in prod', /^[A-Z]{4}$/.test(code), code);
  const b = new Bot({ url: URL, name: 'Bravo', crew: code });
  const wb = await b.connect();
  bots.push(a, b);
  check('second bot joins the same crew', wb.crew.code === code && wb.crew.players.length === 2);
  check('first joiner is leader', wb.crew.players.find((p) => p.id === a.me)?.isLeader === true);

  // ---- WebRTC signalling relay over the game socket (voice depends on it) ----
  a.send({ op: 'sig', to: b.me!, d: { v: 'test', n: 1 } });
  await sleep(300);
  check("sig relay: B receives the signal from A (from = A)", b.sigs.some((x) => x.from === a.me && (x.d as { n?: number }).n === 1));

  // ---- walk 6 m ----
  const start = a.pos;
  a.pose(start);
  await sleep(200);
  const startSeen = b.seen(a.me) ?? start;
  await a.walk([start[0] + 6, 0, start[2]], 3);
  await sleep(300);
  const endSeen = b.seen(a.me);
  const moved = endSeen ? Math.hypot(endSeen[0] - startSeen[0], endSeen[2] - startSeen[2]) : 0;
  check('walk 6 m at 3 m/s: server accepted (seen by the other bot)', moved > 5.5, `${moved.toFixed(2)} m`);
  check('snapshot carries aud for the other player', typeof b.lastSnap?.aud?.[a.me!] === 'number', JSON.stringify(b.lastSnap?.aud));
  check('no corrections during a legal walk', !a.events.some((e) => e.e === 'net.correct'));

  // ---- teleport is rejected + corrected (to this player only) ----
  const before = b.seen(a.me);
  const corr = a.waitEvent<{ p: number[]; reason: string }>('net.correct', () => true, 2000);
  a.pose([a.pos[0] + 40, 0, a.pos[2] + 40]);
  const c = await corr.catch(() => null);
  check('teleport -> net.correct', !!c && c.reason === 'speed', JSON.stringify(c));
  await sleep(200);
  const after = b.seen(a.me);
  check('teleported pose not applied on the server', !!before && !!after && Math.hypot(after[0] - before[0], after[2] - before[2]) < 0.5);
  check('correction sent only to the offender', !b.events.some((e) => e.e === 'net.correct'));

  // ---- drop + resume ----
  const idA = a.me;
  a.drop();
  await sleep(300);
  const wa2 = await a.connect();
  check('resume after socket drop keeps id', wa2.you === idA);

  // ---- reject paths ----
  const stale = new Bot({ url: URL, name: 'Stale', crew: code, build: 'b-old' });
  const se = await stale.connect().then(() => 'welcome', (e: Error & { code?: string }) => e.code ?? e.message);
  check('stale build rejected', se === 'stale_build', se);
  const unk = new Bot({ url: URL, name: 'Nope', crew: 'ZZZZ' });
  const ue = await unk.connect().then(() => 'welcome', (e: Error & { code?: string }) => e.code ?? e.message);
  check('unknown crew rejected in prod', ue === 'unknown_crew', ue);

  // ---- session file ----
  await sleep(400);
  const saved = JSON.parse(readFileSync(SESSION, 'utf8')) as { crews: { code: string; players: { id: string }[] }[] };
  const sc = saved.crews.find((x) => x.code === code);
  check('saves session file with the roster', !!sc && sc.players.length === 2, SESSION);

  // ---- restart the server; bots come back with the same ids ----
  const idB = b.me;
  await stopServer(server);
  await sleep(300);
  server = await startServer();
  check('server restored the session', /restored 1 crew/.test(log), (log.match(/restored .*/)?.[0] ?? '').slice(0, 120));
  // B reconnects first: A must still be leader once back
  const wb3 = await b.connect();
  const wa3 = await a.connect();
  check('B back with the same id in the same crew', wb3.you === idB && wb3.crew.code === code);
  check('A back with the same id in the same crew', wa3.you === idA && wa3.crew.code === code);
  check("restored crew is in 'hub'", wa3.state.phase === 'hub', wa3.state.phase);
  await sleep(300);
  const roster = wa3.crew.players;
  check('leader kept across the restart (A)', roster.find((p) => p.id === idA)?.isLeader === true || (b.events.filter((e) => e.e === 'crew').at(-1)?.d as { players: { id: string; isLeader: boolean }[] } | undefined)?.players.find((p) => p.id === idA)?.isLeader === true);
  // walking still validates after the restart
  a.pose(a.pos);
  await sleep(150);
  const s0 = b.seen(a.me) ?? a.pos;
  await a.walk([a.pos[0], 0, a.pos[2] + 3], 3);
  await sleep(300);
  const s1 = b.seen(a.me);
  check('walk after restart accepted', !!s1 && Math.hypot(s1[0] - s0[0], s1[2] - s0[2]) > 2.5);
} catch (e) {
  check('e2e run', false, e instanceof Error ? e.message : String(e));
} finally {
  for (const b of bots) b.close();
  await stopServer(server);
}
console.log(`\nbots.e2e: ${failN ? 'FAIL' : 'PASS'} (${pass} pass, ${failN} fail)`);
process.exitCode = failN ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
