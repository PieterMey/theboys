// P3 QA / bug-bash helpers: HMR-proof Chrome players, CDP screenshots, page probes, server samples, bot routines.
// Everything targets a server the caller started (BASE_URL, default http://127.0.0.1:3096); never the live :3000.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO, launchPlayer, waitForGame } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import { connectBot, walkable } from '../bots/bot-client.ts';
import type { Bot } from '../bots/bot-client.ts';
import type { ObjLoot } from '../../packages/shared/src/messages/objectives.ts';

export const BASE = (process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3096}`).replace(/\/$/, '');
export const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;
export const PORT = Number(new URL(BASE).port || 80);
if (PORT === 3000 || PORT === 3100 || PORT === 20241) throw new Error(`refusing to run QA against the live/shared port ${PORT}`);
export const OUT = join(REPO, 'tests/artifacts/qa');
mkdirSync(OUT, { recursive: true });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = performance.now();
export const ts = () => ((performance.now() - T0) / 1000).toFixed(1).padStart(6);
export const log = (s: string) => console.log(`[${ts()}s] ${s}`);

export function randomCrew(): string {
  const A = 'BCDFGHJKLMNPQRSTVWXZ';
  let s = 'Q';
  for (let i = 0; i < 3; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// ---------------------------------------------------------------- Chrome players

export interface QaPlayer extends Player {
  name: string;
  wav: string;
  /** warnings, errors and [voice] lines since launch ("<sec> <type>: text"), bounded */
  console: string[];
  /** the game socket(s) seen by the page, for simulated network drops (dropSocket) */
  sockets: { close(): Promise<void> }[];
}

export interface QaPlayerOpts {
  viewport?: { width: number; height: number };
  query?: Record<string, string>;
  /** reuse a player identity (localStorage 'deadair.key'): same player id as an earlier browser */
  playerKey?: string;
  /** skip the HMR-mute reload (the first page load joins once) */
  noReload?: boolean;
  /** proxy the game socket through Playwright so dropSocket() can simulate a network blip. Off by default: the
   *  proxy runs in this test process and adds backpressure (server-side snapshot skips) when the runner is busy */
  proxyWs?: boolean;
}

/** One Chrome process per player (fake mic = its WAV), HMR muted, joined to `crew`. */
export async function qaPlayer(name: string, wav: string, crew: string, opts: QaPlayerOpts = {}): Promise<QaPlayer> {
  const p = await launchPlayer({ name, wav, baseUrl: BASE, crew, query: { autojoin: '1', nobright: '1', ...(opts.query ?? {}) }, viewport: opts.viewport ?? { width: 480, height: 270 } });
  const lines: string[] = [];
  const t0 = performance.now();
  p.page.on('console', (m) => {
    const t = m.text();
    if (m.type() !== 'error' && m.type() !== 'warning' && !t.startsWith('[voice]')) return;
    lines.push(`${((performance.now() - t0) / 1000).toFixed(1)} ${m.type()}: ${t.slice(0, 500)}`);
    if (lines.length > 3000) lines.splice(0, 500);
  });
  const sockets: { close(): Promise<void> }[] = [];
  // other agents save files all night: mute Vite's HMR socket (anything but the game's /ws) so no full reloads;
  // the game socket is proxied (messages flow both ways untouched) so tests can drop it like a network blip
  await p.page.routeWebSocket((u) => !u.pathname.endsWith('/ws'), () => { /* mocked: never reaches Vite */ });
  if (opts.proxyWs) {
    await p.page.routeWebSocket((u) => u.pathname.endsWith('/ws'), (ws) => {
      const server = ws.connectToServer();
      sockets.push({ close: async () => { await ws.close({ code: 4999, reason: 'qa drop' }).catch(() => {}); await server.close().catch(() => {}); } });
    });
  }
  if (opts.playerKey) {
    const key = opts.playerKey;
    await p.page.addInitScript((k: string) => { try { localStorage.setItem('deadair.key', k); } catch { /* ignore */ } }, key);
  }
  if (!opts.noReload || opts.playerKey) await p.page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(p.page, 90_000);
  await p.page.waitForFunction(() => window.__game?.state() && (window.__game.state() as { net: string }).net === 'joined', undefined, { timeout: 60_000, polling: 200 });
  return Object.assign(p, { name, wav, console: lines, sockets });
}

/**
 * wait until the page renders smoothly again (frame time below `ms`): on a GPU shared with other test agents a page
 * can sit at 1-5 fps for a while after a join / layout build, and movement checks would then measure the host
 */
export async function settled(page: Page, ms = 80, timeoutMs = 30_000): Promise<number> {
  const t0 = performance.now();
  let f = 1e9;
  while (performance.now() - t0 < timeoutMs) {
    f = await page.evaluate(() => window.__game!.perf().frameMs).catch(() => 1e9);
    if (f < ms) return f;
    await sleep(500);
  }
  return f;
}

/** close the page's current game socket(s) from the outside (the client reconnects with its resume token) */
export async function dropSocket(p: QaPlayer): Promise<number> {
  const list = p.sockets.splice(0);
  for (const s of list) await s.close();
  return list.length;
}

export async function playerKey(p: QaPlayer): Promise<string> {
  return p.page.evaluate(() => localStorage.getItem('deadair.key') ?? '');
}

type AnyState = {
  phase: string; me: string; net: string; screen: string;
  crew: { code: string; players: { id: string; name: string; connected: boolean; ready: boolean; alive: boolean; isLeader: boolean }[] } | null;
  players: { id: string; p: [number, number, number]; stance: number }[];
  objectives: Record<string, unknown> | null;
  interaction: { dead?: string[] } | null;
  layout: { seed: string; hash: string } | null;
  diag: { net?: { snapHz?: number; rtt?: number; status?: string; corrections?: number }; voice?: Record<string, unknown> };
};

export async function st(page: Page): Promise<AnyState> {
  return page.evaluate(() => window.__game!.state() as never);
}
export async function req<T = unknown>(page: Page, r: string, a: unknown = {}): Promise<T> {
  return page.evaluate(([rr, aa]) => window.__game!.req!(rr as string, aa) as Promise<never>, [r, a] as const);
}
export async function dbg<T = unknown>(page: Page, r: string, a: unknown = {}): Promise<T> {
  return page.evaluate(([rr, aa]) => window.__game!.dbg(rr as string, aa) as Promise<never>, [r, a] as const);
}
export async function waitPhase(page: Page, phase: string, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction((ph) => (window.__game!.state() as { phase: string }).phase === ph, phase, { timeout: timeoutMs, polling: 250 });
}

export interface PageProbe {
  name: string; phase: string; net: string; fps: number; frameMs: number; snapHz: number; rtt: number; errors: number; heapMB: number;
  voice: { peers: number; connected: number; states: string[]; bytes: number }; alive: boolean; screen: string;
}

export async function probe(p: QaPlayer): Promise<PageProbe> {
  return p.page.evaluate((name) => {
    const g = window.__game!;
    const s = g.state() as AnyState;
    const perf = g.perf();
    const peers = window.__voiceDebug?.peers() ?? {};
    const vals = Object.values(peers);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const me = s.crew?.players.find((x) => x.id === s.me);
    return {
      name, phase: s.phase, net: s.net, fps: Math.round(perf.fps), frameMs: Math.round(perf.frameMs * 10) / 10,
      snapHz: Number(s.diag?.net?.snapHz ?? 0), rtt: Number(s.diag?.net?.rtt ?? 0), errors: g.errors().length,
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1e5) / 10 : 0,
      voice: { peers: vals.length, connected: vals.filter((v) => v.state === 'connected').length, states: vals.map((v) => `${v.state}/${v.candidate}`), bytes: vals.reduce((a, v) => a + v.bytesReceived, 0) },
      alive: me?.alive ?? false, screen: s.screen,
    };
  }, p.name);
}

/** GPU-side resources three.js still tracks + scene graph size (a leak shows up as growth per contract) */
export async function gpuRes(page: Page): Promise<{ geometries: number; textures: number; objects: number; programs: number }> {
  return page.evaluate(() => {
    const t = window.__render?.three?.();
    if (!t) return { geometries: -1, textures: -1, objects: -1, programs: -1 };
    const info = t.renderer.info as unknown as { memory?: { geometries?: number; textures?: number }; programs?: unknown[] };
    let objects = 0;
    t.scene.traverse(() => { objects++; });
    return { geometries: info.memory?.geometries ?? -1, textures: info.memory?.textures ?? -1, objects, programs: Array.isArray(info.programs) ? info.programs.length : -1 };
  });
}

/** JS heap actually in use after a forced full GC (CDP), MB: grows contract over contract only on a real leak */
export async function gcHeapMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const h = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number };
    return Math.round(h.usedSize / 1e5) / 10;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** CDP capture from the compositor (Playwright's screenshot can stall on a busy WebGPU page) */
export async function shot(page: Page, name: string): Promise<string> {
  const path = join(OUT, `${name}.png`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdp capture timeout')), 45_000)),
    ])) as { data: string };
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  } finally {
    await cdp.detach().catch(() => {});
  }
  return path;
}

// ---------------------------------------------------------------- server side samples

export function serverPid(port = PORT): number | null {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
  } catch { /* ignore */ }
  return null;
}

/** working set (MB) of a process (tasklist) */
export function procMB(pid: number | null): number {
  if (!pid) return 0;
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
    const m = /"([\d.,\s]+) K"/.exec(out);
    return m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : 0;
  } catch {
    return 0;
  }
}

/** lines of the server log added since `from` (byte offset) that look like trouble */
export function serverTrouble(logFile: string, from: number): { lines: string[]; size: number } {
  if (!logFile || !existsSync(logFile)) return { lines: [], size: from };
  const size = statSync(logFile).size;
  const txt = readFileSync(logFile, 'utf8').slice(from);
  const lines = txt.split(/\r?\n/).filter((l) => /ERROR|threw|Exception|TypeError|RangeError|ReferenceError|failed|Unhandled| WARN /.test(l));
  return { lines, size };
}

// ---------------------------------------------------------------- bots

export { connectBot, walkable };
export type { Bot };

/** a walkable standing point near (x, z) within reach */
export function standNear(bot: Bot, x: number, z: number, avoid?: [number, number]): [number, number] {
  const L = bot.layout!;
  const cands: [number, number][] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const cx = Math.floor(x) + dx + 0.5, cz = Math.floor(z) + dz + 0.5;
    if (walkable(L, cx, cz)) cands.push([cx, cz]);
  }
  if (!cands.length) return [x, z];
  const score = (c: [number, number]) => Math.hypot(c[0] - x, c[1] - z) + (avoid ? -0.3 * Math.hypot(c[0] - avoid[0], c[1] - avoid[1]) : 0);
  cands.sort((a, b) => score(a) - score(b));
  return cands.find((c) => Math.hypot(c[0] - x, c[1] - z) <= 1.6) ?? cands[0];
}

export function botAlive(b: Bot): boolean {
  const dead = (b.full?.interaction as { dead?: string[] } | null | undefined)?.dead ?? [];
  return !dead.includes(b.id);
}

export function vanInside(b: Bot): [number, number] {
  const v = b.obj!.van!;
  return [v.x + v.w / 2, v.y + v.h / 2];
}

/**
 * Two ws bots work a running contract like contract-bot (loot -> twin breakers -> keypad -> Core carry -> van),
 * but with monsters ON and tolerant of deaths: every step is best-effort and logged; returns what got done.
 */
export async function botShift(A: Bot, B: Bot, o: { speed?: number; lootTrips?: number; deadlineMs: number; say?: (s: string) => void }): Promise<string[]> {
  const say = o.say ?? log;
  const done: string[] = [];
  const speed = o.speed ?? 2.8;
  const left = () => Math.max(1500, o.deadlineMs - performance.now());
  const obj = () => A.obj!;
  const both = [A, B];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    if (performance.now() > o.deadlineMs) throw new Error('deadline');
    try {
      await fn();
      done.push(name);
      say(`bots: ${name} ok`);
    } catch (e) {
      say(`bots: ${name} FAILED: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
  };
  for (const b of both) {
    const sp = b.serverPos();
    if (sp) b.setPos(sp[0], sp[1]);
  }
  try {
    await A.dbg('objectives.doors', { open: true }).catch(() => undefined);
    // salvage: one nearest item each, deposit in the van
    const claimed = new Set<string>();
    const lootRun = async (bot: Bot) => {
      for (let t = 0; t < (o.lootTrips ?? 1); t++) {
        if (!botAlive(bot)) return;
        const world = obj().loot.filter((l: ObjLoot) => l.where === 'world' && !claimed.has(l.id));
        const ranked = world.map((l) => ({ l, c: bot.pathCost(l.p[0], l.p[2]) })).filter((x) => Number.isFinite(x.c)).sort((a, b) => a.c - b.c);
        const pick = ranked[0]?.l;
        if (!pick) return;
        claimed.add(pick.id);
        const ix = obj().lootMode === 'interaction';
        const [sx, sz] = standNear(bot, pick.p[0], pick.p[2]);
        await bot.goTo(sx, sz, { timeoutMs: Math.min(40_000, left()), speed });
        const r = ix ? await bot.req('interaction.use', { id: pick.id }) : await bot.req('objectives.pick', { id: pick.id });
        if (!r.ok) throw new Error(`${bot.name}: pick ${pick.id}: ${r.msg}`);
        const dep = obj().deposit!.p;
        const [dx, dz] = standNear(bot, dep[0], dep[2]);
        await bot.goTo(dx, dz, { timeoutMs: Math.min(40_000, left()), speed });
        const d = ix ? await bot.req('interaction.use', { id: 'deposit:0' }) : await bot.req('objectives.deposit', {});
        if (!d.ok) throw new Error(`${bot.name}: deposit: ${d.msg}`);
      }
    };
    await step('salvage run', () => Promise.all(both.map(lootRun)));
    const levers = obj().levers;
    await step('walk to both breakers', async () => {
      const [ax, az] = standNear(A, levers[0].p[0], levers[0].p[2]);
      const [bx, bz] = standNear(B, levers[1].p[0], levers[1].p[2]);
      await Promise.all([A.goTo(ax, az, { timeoutMs: left(), speed }), B.goTo(bx, bz, { timeoutMs: left(), speed })]);
    });
    await step('twin breakers -> power', async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const [ra, rb] = await Promise.all([A.req('objectives.lever', { id: levers[0].id }), B.req('objectives.lever', { id: levers[1].id })]);
        await sleep(400);
        if (obj().power[levers[0].zone]) return;
        say(`bots: breakers ${ra.result}/${rb.result} (${ra.msg ?? ''} ${rb.msg ?? ''}), retry`);
        await sleep(Math.min(21_000, Math.max(0, obj().leverCooldownUntil - Date.now()) + 300));
      }
      throw new Error('no power after 3 attempts');
    });
    await step('keypad -> vault', async () => {
      const k = obj().keypad!;
      const [kx, kz] = standNear(A, k.p[0], k.p[2]);
      const [bx, bz] = standNear(B, k.p[0], k.p[2], [kx, kz]);
      await Promise.all([A.goTo(kx, kz, { timeoutMs: left(), speed }), B.goTo(bx, bz, { timeoutMs: left(), speed }).catch(() => undefined)]);
      const r = await A.req('objectives.keypad', { code: obj().code });
      if (!r.ok) throw new Error(`keypad: ${r.msg}`);
      await A.waitFor(() => obj().vaultOpen, 3000, 'vaultOpen');
    });
    await step('lift the Core', async () => {
      const L = A.layout!;
      const c = obj().core!.p;
      let ha: [number, number] = [c[0] - 0.9, c[2]], hb: [number, number] = [c[0] + 0.9, c[2]];
      for (const [ux, uz] of [[1, 0], [0, 1]] as [number, number][]) {
        const a: [number, number] = [c[0] - ux * 0.9, c[2] - uz * 0.9], b: [number, number] = [c[0] + ux * 0.9, c[2] + uz * 0.9];
        if (walkable(L, a[0], a[1]) && walkable(L, b[0], b[1])) { ha = a; hb = b; break; }
      }
      await Promise.all([A.goTo(ha[0], ha[1], { timeoutMs: left(), speed }), B.goTo(hb[0], hb[1], { timeoutMs: left(), speed })]);
      const ra = await A.req('objectives.core', { action: 'grab' });
      const rb = await B.req('objectives.core', { action: 'grab' });
      if (!ra.ok || !rb.ok) throw new Error(`grab: ${ra.msg ?? ''} / ${rb.msg ?? ''}`);
      await A.waitFor(() => obj().coreState === 'carried', 3000, 'core carried');
    });
    await step('carry the Core to the van', async () => {
      const [tx, tz] = vanInside(A);
      const trail: [number, number][] = [[A.pos[0], A.pos[1]]];
      let fin = false;
      const lead = A.goTo(tx, tz, { speed: 1.6, timeoutMs: left(), tol: 0.3 }).then(() => { fin = true; }, () => { fin = true; });
      const follow = (async () => {
        while (!fin && obj().coreState === 'carried') {
          const last = trail[trail.length - 1];
          if (Math.hypot(A.pos[0] - last[0], A.pos[1] - last[1]) > 0.1) trail.push([A.pos[0], A.pos[1]]);
          let need = 1.3, target = trail[0];
          for (let i = trail.length - 1; i > 0; i--) {
            const seg = Math.hypot(trail[i][0] - trail[i - 1][0], trail[i][1] - trail[i - 1][1]);
            if (seg >= need) {
              const k = need / (seg || 1);
              target = [trail[i][0] + (trail[i - 1][0] - trail[i][0]) * k, trail[i][1] + (trail[i - 1][1] - trail[i][1]) * k];
              need = 0;
              break;
            }
            need -= seg;
          }
          B.stepToward(target[0], target[1], 2.4);
          await sleep(50);
        }
      })();
      await Promise.race([
        A.waitFor(() => obj().coreState === 'van', left(), 'core in van'),
        A.waitFor(() => obj().coreState === 'dropped', left(), 'core dropped').then(() => { throw new Error('Core dropped during the carry'); }),
      ]);
      await lead;
      fin = true;
      await follow;
    });
  } catch { /* logged by step() */ }
  // whatever happened: survivors head into the van
  const [vx, vz] = vanInside(A);
  await Promise.all(both.filter(botAlive).map((b, i) => b.goTo(vx, vz + (i ? 0.4 : -0.4), { timeoutMs: Math.min(60_000, left()), speed }).catch(() => undefined)));
  return done;
}
