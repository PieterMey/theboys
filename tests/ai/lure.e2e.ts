// Track (e) e2e: THE LISTENER SPEAKS in two real Chrome clients (WebGPU, fake mics).
//   node tests/ai/lure.e2e.ts            -> spawns its own dev server on PORT (default 3015), AI_MODE (default mock)
//   BASE_URL=http://127.0.0.1:3506 node tests/ai/lure.e2e.ts   -> uses a running dev server
// Scenarios: (1) a walkie lure for Sam: Sam hears it 2D from his walkie through the radio chain, Pieter (2 m away)
// hears Sam's walkie squawk positionally; (2) an intercom lure heard by both; (3) the real monsters path: the
// Listener wakes, hears a taunt, decides radio_lure and the hook in monsters/listener.ts voices it.
// Asserts the clip was fetched + decoded and audio flowed (RMS tap), saves screenshots to tests/artifacts/ai/.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from 'playwright-core';
import { launchPlayer, waitForGame } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import { REPO } from './helpers.ts';

const PORT = Number(process.env.PORT ?? 3015);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const CREW = `LU${Date.now().toString(36).slice(-3).toUpperCase()}`;
const OUT = join(REPO, 'tests/artifacts/ai');
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
// SCENARIOS=1,3 runs a subset (live runs: one TTS call per scenario)
const want = (n: number) => !process.env.SCENARIOS || process.env.SCENARIOS.split(',').includes(String(n));
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

type LureDbg = { url: string; mode: string; ok: boolean; dur: number; peak: number; err?: string };
type W = {
  __game: { join(c: string): Promise<void>; me(): string | null; state(): Record<string, unknown>; dbg(r: string, a?: unknown): Promise<unknown>; teleport(x: number, z: number, yaw?: number): void };
  __aiDebug?: { lures(): LureDbg[] };
};

async function up(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const dbg = <T>(p: Player, r: string, a?: unknown): Promise<T> => p.page.evaluate(([r2, a2]) => (window as unknown as W).__game.dbg(r2 as string, a2), [r, a] as const) as Promise<T>;
const lures = (p: Player): Promise<LureDbg[]> => p.page.evaluate(() => (window as unknown as W).__aiDebug?.lures() ?? []);
const phase = (p: Player): Promise<string> => p.page.evaluate(() => String((window as unknown as W).__game.state().phase ?? ''));

async function joinAs(name: string): Promise<Player> {
  const p = await launchPlayer({ name, baseUrl: BASE, crew: CREW, query: { preset: 'low', nobright: '1' } });
  // other agents keep saving files: swallow Vite's HMR socket so the page never full-reloads mid-test
  await p.page.routeWebSocket(/token=/, () => {});
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(p.page, 120_000);
  await p.page.evaluate((c) => (window as unknown as W).__game.join(c), CREW);
  await p.page.waitForFunction(() => !!(window as unknown as W).__game.me(), undefined, { timeout: 30_000 });
  return p;
}

async function waitFor(p: Page, fn: () => boolean, ms: number): Promise<boolean> {
  return p.waitForFunction(fn, undefined, { timeout: ms, polling: 100 }).then(() => true, () => false);
}

let server: ChildProcess | null = null;
const players: Player[] = [];
let code = 0;
try {
  if (!process.env.BASE_URL) {
    server = spawn(process.execPath, ['--env-file-if-exists=C:/Users/Pieter/repos/theboys/.env', join(REPO, 'apps/server/src/index.ts'), '--dev'], {
      env: { ...process.env, PORT: String(PORT), AI_MODE: process.env.AI_MODE ?? 'mock', NODE_ENV: 'development', NET_SESSION: '0', SAVES_DIR: join(tmpdir(), `dead-air-lure-e2e-${PORT}`) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  if (!(await up(`${BASE}/healthz`, 40_000))) throw new Error(`server not up at ${BASE}`);
  step(`server ${BASE}, crew ${CREW}`);
  const A = await joinAs('Sam');
  players.push(A);
  const B = await joinAs('Pieter');
  players.push(B);
  const aId = await A.page.evaluate(() => (window as unknown as W).__game.me());
  step(`joined: Sam=${aId}`);

  // ---- contract with monsters, frozen while we stage
  const st = await dbg<{ ok: boolean; seed?: string }>(A, 'monsters.start', { risk: 1 });
  step(`monsters.start ok=${st.ok} seed=${st.seed}`);
  for (const p of [A, B]) {
    const ok = await waitFor(p.page, () => (window as unknown as W).__game.state().phase === 'contract', 30_000);
    if (!ok) throw new Error(`${p === A ? 'Sam' : 'Pieter'} not in contract (phase ${await phase(p)})`);
  }
  await dbg(A, 'monsters.freeze', { on: true });
  await A.page.waitForTimeout(1500);
  const ms = await dbg<{ poses: { id: string; p: number[] }[] }>(A, 'monsters.state');
  const ap = ms.poses.find((x) => x.id === aId)?.p ?? [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    await B.page.evaluate(([x, z]) => (window as unknown as W).__game.teleport(x, z), [ap[0] + 1.6, ap[2]] as const);
    await A.page.waitForTimeout(1200);
    const ps = (await dbg<{ poses: { id: string; p: number[] }[] }>(A, 'monsters.state')).poses;
    const b0 = ps.find((x) => x.id !== aId)?.p;
    if (b0 && Math.hypot(b0[0] - ap[0], b0[2] - ap[2]) < 3) break;
  }
  const poses = (await dbg<{ poses: { id: string; p: number[] }[] }>(A, 'monsters.state')).poses.map((x) => `${x.id === aId ? 'Sam' : 'Pieter'} [${x.p.map((v) => v.toFixed(1)).join(', ')}]`);
  step(`poses after the teleport: ${poses.join(' ')}`);

  // ---- (1) walkie lure for Sam
  const r1 = await dbg<{ started: boolean; garbled: boolean; room: string | null; rooms: string[] }>(A, 'ai.lure', {
    victim: aId, room: '*', heard: [
      { text: 'okay guys', speaker: 'Pieter', agoSec: 20 },
      { text: 'Sam meet me in the {ROOM}, I have the core', speaker: 'Pieter', agoSec: 4 },
    ],
  });
  step(`(1) ai.lure started=${r1.started} room=${r1.room} (layout rooms ${r1.rooms.slice(0, 6).join(' ')}...)`);
  if (!r1.started) throw new Error('lure not started');
  if (process.env.DEBUG_NEAR) {
    for (let i = 0; i < 25; i++) {
      const x = await B.page.evaluate(() => ({ l: (window as unknown as W).__aiDebug?.lures() ?? [], e: (window as unknown as { __game: { errors(): string[] } }).__game.errors().slice(-3) }));
      console.log('near probe', i, JSON.stringify(x));
      await B.page.waitForTimeout(200);
    }
  }
  await A.page.waitForTimeout(900);
  await A.page.screenshot({ path: join(OUT, 'lure-walkie-sam.png') });
  await A.page.waitForTimeout(3200);
  const la = await lures(A);
  const lb = await lures(B);
  step(`(1) Sam: ${JSON.stringify(la)}`);
  step(`(1) Pieter: ${JSON.stringify(lb)}`);
  const self = la.find((l) => l.mode === 'self');
  const near = lb.find((l) => l.mode === 'near');
  if (!self?.ok || self.peak < 0.002) throw new Error(`Sam did not hear the lure through his walkie (${JSON.stringify(self)})`);
  if (!near?.ok || near.peak < 0.0005) {
    const ge = await B.page.evaluate(() => (window as unknown as { __game: { errors(): string[] } }).__game.errors().slice(-5));
    throw new Error(`Pieter did not hear Sam's walkie (${JSON.stringify(near)}); game errors: ${JSON.stringify(ge)}; page errors: ${B.errors.slice(-5).join(' || ')}`);
  }
  const recent1 = await dbg<{ recent: { ok: boolean; source: string; ms: number; reason: string | null; text?: string }[] }>(A, 'ai.lures');
  step(`(1) server: ${JSON.stringify(recent1.recent.slice(-1))}`);

  // ---- (2) intercom lure next to Pieter
  if (want(2)) {
  const bp = (await dbg<{ poses: { id: string; p: number[] }[] }>(A, 'monsters.state')).poses.find((x) => x.id !== aId)?.p ?? ap;
  const r2 = await dbg<{ started: boolean }>(B, 'ai.lure', { intercom: [bp[0] + 2.5, 1.6, bp[2]], heard: [{ text: 'where is everyone', speaker: 'Sam', agoSec: 3 }] });
  step(`(2) intercom ai.lure started=${r2.started}`);
  await B.page.waitForTimeout(4000);
  const ia = (await lures(A)).filter((l) => l.mode === 'intercom');
  const ib = (await lures(B)).filter((l) => l.mode === 'intercom');
  step(`(2) intercom: Sam ${JSON.stringify(ia)} Pieter ${JSON.stringify(ib)}`);
  if (!ib[0]?.ok || ib[0].peak < 0.0005) throw new Error('Pieter did not hear the intercom lure');
  }

  // ---- (3) the real monsters path: wake, taunt, radio_lure -> hook -> voiced lure
  const before = (await dbg<{ recent: unknown[] }>(A, 'ai.lures', { reset: true })).recent.length; // reset the 60 s crew cooldown
  await dbg(A, 'monsters.freeze', { on: false });
  await dbg(A, 'monsters.wake');
  await A.page.waitForTimeout(400);
  const u = await dbg<{ ok: boolean }>(A, 'monsters.utter', { text: 'come and get me stupid monster', listener: true });
  step(`(3) taunt heard by the Listener: ${u.ok}`);
  const deadline = Date.now() + 9000;
  let after: { ok: boolean; source: string; reason: string | null; text?: string }[] = [];
  while (Date.now() < deadline) {
    after = (await dbg<{ recent: typeof after }>(A, 'ai.lures')).recent;
    if (after.length > before) break;
    await A.page.waitForTimeout(300);
  }
  await dbg(A, 'monsters.freeze', { on: true });
  const mlog = (await dbg<{ log: { line: string; source: string }[] }>(A, 'monsters.state')).log.slice(-3);
  step(`(3) monsters log: ${JSON.stringify(mlog)}`);
  const st3 = await dbg<{ status: { lastReason: string | null; skipped: number } }>(A, 'ai.lures');
  step(`(3) lure entries: ${JSON.stringify(after.slice(before))} status: ${JSON.stringify(st3.status)}`);
  if (after.length <= before) throw new Error('the monsters radio_lure never reached speakLure');
  await A.page.waitForTimeout(3500);
  step(`(3) Sam client: ${JSON.stringify((await lures(A)).slice(-1))}`);
  await A.page.screenshot({ path: join(OUT, 'lure-monsters-sam.png') });
  const errs = [...A.errors, ...B.errors].filter((e) => !e.includes('favicon') && /vo-gen|ai\/lure|decodeAudio/i.test(e));
  if (errs.length) throw new Error(`page errors: ${errs.slice(0, 4).join(' || ')}`);
  step('PASS');
} catch (e) {
  console.error('lure.e2e FAILED:', e instanceof Error ? e.message : e);
  code = 1;
} finally {
  for (const p of players) await p.close().catch(() => {});
  server?.kill();
}
process.exitCode = code;
setTimeout(() => process.exit(code), 500).unref();
