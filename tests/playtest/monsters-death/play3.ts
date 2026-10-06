// Playtest driver (report-only): MONSTERS, DEATH, SPECTATING, REVIVE with 3 real Chrome players on :3203.
//   node tests/playtest/monsters-death/play.ts [phases]   phases: comma list of hound,death,listener,mannequin (default all)
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { REPO, launchPlayer, waitForGame } from '../../lib/launch.ts';
import { decodeMsg } from '../../../packages/shared/src/envelope.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3203';
const CREW = process.env.CREW ?? 'MDTW';
const OUT = join(REPO, 'tests/playtest/monsters-death');
const SHOTS = join(OUT, 'shots3');
mkdirSync(SHOTS, { recursive: true });
const LOG = join(OUT, 'play3.log');
const PHASES = new Set((process.argv[2] ?? 'hound,death,listener,mannequin').split(','));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a: unknown[]) => {
  const s = `[${((Date.now() - T0) / 1000).toFixed(1)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(s);
  appendFileSync(LOG, s + '\n');
};

interface Ev { t: number; e: string; d: any }
interface P { name: string; page: Page; cdp: CDPSession; ev: Ev[]; errors: string[]; id: string; close(): Promise<void> }

async function launch(name: string, wav: string): Promise<P> {
  const pl = await launchPlayer({ name, wav, baseUrl: BASE, crew: CREW, query: { autojoin: '1', nobright: '1' }, viewport: { width: 1600, height: 900 } });
  const page = pl.page;
  await page.routeWebSocket(/token=/, () => {});
  // a player who calibrated in the van (talk ~-21 dBFS) and uses push-to-talk (V) from the settings
  await page.addInitScript(() => {
    try {
      localStorage.setItem('deadair.voice.ptt', '1');
      localStorage.setItem('deadair.meta.settings', JSON.stringify({ ptt: true, brightnessDone: true, hints: true }));
      localStorage.setItem('deadair.voice.base', '-21');
      localStorage.setItem('deadair.voice.cal', JSON.stringify({ noiseDb: -75, talkDb: -21, whisperDb: -35, shoutDb: -8, at: Date.now() }));
    } catch { /* ignore */ }
  });
  const ev: Ev[] = [];
  page.on('websocket', (ws) => {
    if (!/\/ws(\?|$)/.test(ws.url())) return;
    ws.on('framereceived', (f) => {
      const b = f.payload as unknown;
      if (typeof b === 'string') return;
      const u = new Uint8Array(b as Buffer);
      if (u[0] !== 0) return;
      try {
        const m = decodeMsg(u) as { op: string; e?: string; d?: unknown };
        if (m.op === 'ev' && m.e && /^(monsters|interaction|players|objectives\.(alarm|horn))/.test(m.e) && m.e !== 'interaction.patch') ev.push({ t: Date.now(), e: m.e, d: m.d });
      } catch { /* ignore */ }
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const cdp = await page.context().newCDPSession(page);
  return { name, page, cdp, ev, errors: pl.errors, id: '', close: pl.close };
}

async function shot(p: P, name: string): Promise<string> {
  try {
    const r = (await p.cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    const f = join(SHOTS, `${name}.png`);
    writeFileSync(f, Buffer.from(r.data, 'base64'));
    log(`shot ${name}.png (${p.name})`);
    return f;
  } catch (e) {
    log(`shot ${name} FAILED: ${e}`);
    return '';
  }
}
const ev = <T>(p: P, fn: string, ...args: unknown[]): Promise<T> =>
  p.page.evaluate(([f, a]) => (window.__game as unknown as Record<string, (...x: unknown[]) => unknown>)[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const dbg = <T = any>(p: P, r: string, a: unknown = {}): Promise<T> => p.page.evaluate(([r2, a2]) => window.__game!.dbg(r2 as string, a2), [r, a] as const) as Promise<T>;
const req = <T = any>(p: P, r: string, a: unknown = {}): Promise<T> => p.page.evaluate(([r2, a2]) => window.__game!.req!(r2 as string, a2), [r, a] as const) as Promise<T>;
const ms = (p: P) => dbg<any>(p, 'monsters.state');
const agent = async (p: P, id: string) => { const m = await ms(p); if (!m.agents) { log('monsters runtime OFF (mode ' + m.mode + ')'); return { id, state: 'OFF', x: 0, z: 0 }; } return (m.agents as any[]).find((a) => a.id === id); };
const hold = async (p: P, key: string, msec: number) => { await p.page.keyboard.down(key); await sleep(msec); await p.page.keyboard.up(key); };
const evalJs = <T = any>(p: P, body: string): Promise<T> => p.page.evaluate((b) => (new Function(b))(), body) as Promise<T>;
const hud = (p: P) => evalJs<string>(p, `return [...document.querySelectorAll('[data-testid], .hud-chip, .ix-prompt, .ix-spec, .ix-death')].filter(e => e.offsetParent !== null || getComputedStyle(e).position==='fixed').map(e => (e.getAttribute('data-testid')||e.className)+': '+e.innerText.replace(/\\s+/g,' ').slice(0,160)).join(' | ')`);
const band = (p: P) => evalJs<number>(p, 'return window.__voiceDebug ? window.__voiceDebug.band() : -1');
const tp = (p: P, x: number, z: number, yaw = 0) => ev(p, 'teleport', x, z, yaw);
const look = (p: P, yaw: number, pitch = 0) => ev(p, 'look', yaw, pitch);
const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);
const alive = async (p: P, id: string) => { const s = await ev<any>(p, 'state'); return s.crew?.players?.find((q: any) => q.id === id)?.alive; };

/** poll a monster's state for ms, logging transitions */
async function watch(p: P, id: string, msec: number, label: string): Promise<string[]> {
  const seq: string[] = [];
  const t = Date.now();
  let last = '';
  while (Date.now() - t < msec) {
    const a = await agent(p, id).catch(() => null);
    if (a && a.state !== last) { last = a.state; seq.push(`${((Date.now() - t) / 1000).toFixed(1)}s:${a.state}@${a.x},${a.z}`); }
    await sleep(120);
  }
  log(`${label} ${id} states: ${seq.join(' -> ')}`);
  return seq;
}
const evSince = (p: P, t: number, re: RegExp) => p.ev.filter((e) => e.t >= t && re.test(e.e));
const brief = (e: Ev) => `${e.e}:${JSON.stringify(e.d).slice(0, 220)}`;

async function waitSmooth(p: P, msec = 40_000): Promise<number> {
  const t = Date.now();
  let worst = 999;
  while (Date.now() - t < msec) {
    worst = await evalJs<number>(p, 'return new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 12) requestAnimationFrame(f); else { let m = 0; for (let i = 1; i < ts.length; i++) m = Math.max(m, ts[i] - ts[i - 1]); res(m); } }; requestAnimationFrame(f); })');
    if (worst < 60) break;
  }
  return worst;
}
// ---------------------------------------------------------------- mannequin run via a real risk-2 order (report-only)
const players: P[] = [];
try {
  const ann = await launch('Ann', 'silence.wav');
  const bob = await launch('Bob', 'silence.wav');
  const cat = await launch('Cat', 'silence.wav');
  players.push(ann, bob, cat);
  for (const p of players) {
    await waitForGame(p.page, 90_000);
    await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 30_000 });
    p.id = (await ev<string>(p, 'me'))!;
  }
  log('joined', players.map((p) => `${p.name}=${p.id} ${'' }`).join(' '), 'backends', await Promise.all(players.map((p) => ev(p, 'backend'))));
  for (const p of players) await dbg(p, 'meta.setXp', { xp: 160 });
  await sleep(800);
  const meta = await dbg<any>(ann, 'meta.state');
  log('orders after level-up', JSON.stringify(meta.orders));
  const order = meta.orders.find((o: any) => o.available && o.risk === 2);
  if (!order) throw new Error('no risk-2 order available');
  await req(ann, 'meta.pick', { orderId: order.id });
  for (const p of players) await req(p, 'meta.ready', { ready: true });
  await sleep(1500);
  await shot(ann, 'M0-drive-risk2-ann');
  await dbg(ann, 'meta.skipDrive').catch(() => null);
  for (const p of players) await p.page.waitForFunction(() => (window.__game?.state() as { phase?: string }).phase === 'contract', undefined, { timeout: 40_000 });
  log('contract; worst frame', await waitSmooth(ann, 30_000));
  let M = await ms(ann);
  log('agents', M.agents.map((a: any) => `${a.id}:${a.state}:${a.active}`).join(' '), 'risk', M.risk);
  const L = await evalJs<any>(ann, 'return window.__monstersLayout()');
  const rooms = L.spaces.filter((s: any) => (s.kind === 'room' || s.kind === 'hall') && s.callsign && s.callsign !== 'VAN');
  rooms.sort((a: any, b: any) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h));
  const R = rooms[0];
  const r = R.rect;
  const horiz = r.w >= r.h;
  const at = (f: number, g = 0.5): [number, number] => (horiz ? [r.x + 0.6 + (r.w - 1.2) * f, r.y + 0.6 + (r.h - 1.2) * g] : [r.x + 0.6 + (r.w - 1.2) * g, r.y + 0.6 + (r.h - 1.2) * f]);
  await dbg(ann, 'interaction.power', { zone: R.powerZone, on: true }).catch(() => null);
  await dbg(ann, 'interaction.setLights', { space: R.id, on: true }).catch(() => null);
  log(`test room ${R.id} ${R.callsign} ${R.kind} rect ${JSON.stringify(r)}`);
  for (const id of ['hound0', 'hound1', 'listener0']) await dbg(ann, 'monsters.place', { id, x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 }).catch(() => null);
  const [mx, mz] = at(0.92);
  const [ax, az] = at(0.05, 0.2), [bx, bz] = at(0.05, 0.8);
  await tp(ann, ax, az, yawTo(ax, az, mx, mz));
  await tp(bob, bx, bz, yawTo(bx, bz, mx, mz));
  await tp(cat, L.van.cab.x + 1, L.van.cab.y + 1.5, 0);
  await look(ann, yawTo(ax, az, mx, mz), 0);
  await look(bob, yawTo(bx, bz, mx, mz), 0);
  await sleep(800);
  log('spawn', JSON.stringify(await dbg(ann, 'monsters.spawnMannequin', { x: mx, z: mz, blinkIn: 5 })).slice(0, 300));
  await sleep(2500);
  await shot(ann, 'M1-mannequin-watched-lit-ann');
  await watch(ann, 'mannequin0', 8000, 'M2 two watchers (blinks due ~5 s)');
  let m = await agent(ann, 'mannequin0');
  log('M2 mannequin', JSON.stringify({ state: m.state, x: m.x, z: m.z, observed: m.observed, lit: m.lit }), 'blink events (ann)', evSince(ann, Date.now() - 12000, /monsters\.blink/).map(brief).join(' ; '));
  log('M2 sight', JSON.stringify((await ms(ann)).sight), 'blinks', JSON.stringify((await ms(ann)).blinks));
  await dbg(ann, 'monsters.blink', { id: ann.id, inSec: 0.7 });
  await sleep(780);
  await shot(ann, 'M3-visor-blink-ann');
  await sleep(600);
  await look(ann, yawTo(ax, az, mx, mz) + Math.PI, 0);
  await watch(ann, 'mannequin0', 2500, 'M4 only Bob watching');
  const t = Date.now();
  await look(bob, yawTo(bx, bz, mx, mz) + Math.PI, 0);
  await watch(ann, 'mannequin0', 3500, 'M5 nobody watching');
  m = await agent(ann, 'mannequin0');
  log('M5 mannequin', JSON.stringify({ state: m.state, x: m.x, z: m.z }), 'kills', evSince(ann, t, /monsters\.kill|interaction\.death/).map(brief).join(' ; '));
  await look(bob, yawTo(bx, bz, m.x, m.z), 0);
  await sleep(500);
  await shot(bob, 'M5-mannequin-after-lookaway-bob');
  for (const p of players) if (!(await alive(ann, p.id))) await dbg(ann, 'interaction.revive', { pid: p.id });
  await sleep(800);
  await tp(ann, ax, az, yawTo(ax, az, mx, mz));
  await tp(bob, bx, bz, yawTo(bx, bz, mx, mz));
  await look(ann, yawTo(ax, az, mx, mz), 0);
  await look(bob, yawTo(bx, bz, mx, mz), 0);
  await dbg(ann, 'monsters.spawnMannequin', { x: mx, z: mz, blinkIn: 40 });
  await dbg(ann, 'interaction.setLights', { space: R.id, on: false });
  await sleep(2800);
  m = await agent(ann, 'mannequin0');
  log('M6 dark + watched', JSON.stringify({ state: m.state, x: m.x, z: m.z, lit: m.lit }), 'ann light', await evalJs(ann, 'return window.__players.local().light'), 'bob light', await evalJs(bob, 'return window.__players.local().light'));
  await shot(ann, 'M6-mannequin-dark-ann');
  await ann.page.keyboard.press('KeyF');
  await sleep(1300);
  m = await agent(ann, 'mannequin0');
  log('M7 dark + Ann pressed F', JSON.stringify({ state: m.state, x: m.x, z: m.z, lit: m.lit }), 'ann light', await evalJs(ann, 'return window.__players.local().light'));
  await shot(ann, 'M7-mannequin-dark-F-ann');
} catch (e) {
  log(`RUN ERROR ${e instanceof Error ? e.stack : e}`);
} finally {
  for (const p of players) {
    try {
      const errs = await ev<string[]>(p, 'errors');
      log(`${p.name} client errors (${errs.length + p.errors.length}):`, [...p.errors, ...errs].slice(0, 15));
    } catch { /* ignore */ }
  }
  for (const p of players) await p.close().catch(() => null);
  setTimeout(() => process.exit(0), 300).unref();
}
