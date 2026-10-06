// Playtest driver (voice-radio scenario). Keeps real Chrome players alive and runs step files dropped into ./cmd/.
// Each cmd/<n>.js is the body of an async function (P, h) => result; output goes to cmd/<n>.out.txt.
// Only ever targets our own dev server on :3204 (never :3000 / :3100 / :20241).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

const DIR = import.meta.dirname;
const CMD = join(DIR, 'cmd');
const SHOTS = join(DIR, 'shots');
const LOGS = join(DIR, 'logs');
const VOICE = join(DIR, '../../fixtures/voice');
for (const d of [CMD, SHOTS, LOGS]) mkdirSync(d, { recursive: true });
const BASE = 'http://127.0.0.1:3204';
if (!BASE.endsWith(':3204')) throw new Error('wrong port');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const LOG = join(DIR, 'driver.log');
const ts = () => ((Date.now() - T0) / 1000).toFixed(1);
const log = (s: string) => { const l = `[${ts()}s] ${s}`; console.log(l); appendFileSync(LOG, l + '\n'); };

interface P { name: string; wav: string; browser: Browser; page: Page; console: string[] }
const players: Record<string, P> = {};

async function launch(name: string, wav: string, opts: { query?: Record<string, string>; crew?: string; viewport?: { width: number; height: number }; path?: string } = {}): Promise<P> {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(VOICE, wav)}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1600, height: 900 } });
  await context.grantPermissions(['microphone']).catch(() => {});
  // block Vite HMR before the first navigation (other agents edit files all night); the game socket is /ws
  await context.routeWebSocket((u) => !u.pathname.endsWith('/ws'), () => { /* swallowed */ });
  const page = await context.newPage();
  const lines: string[] = [];
  const file = join(LOGS, `${name}.console.log`);
  page.on('console', (m) => {
    const t = `${ts()} ${m.type()}: ${m.text().slice(0, 600)}`;
    appendFileSync(file, t + '\n');
    if (m.type() === 'error' || m.type() === 'warning' || /\[voice\]/.test(t)) { lines.push(t); if (lines.length > 4000) lines.splice(0, 1000); }
  });
  page.on('pageerror', (e) => { const t = `${ts()} pageerror: ${e.message}`; lines.push(t); appendFileSync(file, t + '\n'); });
  page.on('response', (r) => { if (r.status() >= 400) { const t = `${ts()} http ${r.status()}: ${r.url()}`; lines.push(t); appendFileSync(file, t + '\n'); } });
  await page.addInitScript((n: string) => { try { if (!localStorage.getItem('deadair.name')) localStorage.setItem('deadair.name', n); } catch { /* ignore */ } }, name);
  const q = new URLSearchParams({ test: '1', ...(opts.query ?? {}) });
  const url = `${BASE}${opts.path ?? '/'}?${q.toString()}${opts.crew ? `#${opts.crew}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const p = { name, wav, browser, page, console: lines };
  players[name] = p;
  log(`launched ${name} (${wav}) -> ${url}`);
  return p;
}

async function close(name: string): Promise<void> {
  const p = players[name];
  if (!p) return;
  await p.browser.close().catch(() => {});
  delete players[name];
  log(`closed ${name}`);
}

async function shot(page: Page, name: string): Promise<string> {
  const path = join(SHOTS, `${name}.png`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdp capture timeout')), 45_000)),
    ])) as { data: string };
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  } finally { await cdp.detach().catch(() => {}); }
  return path;
}

/** evaluate with retries (a page reload mid-step) */
async function ev<T>(page: Page, fn: string | ((a: any) => T | Promise<T>), arg?: unknown, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      if (typeof fn === 'string') return await page.evaluate(([b, a]) => (new Function('arg', b as string))(a), [fn, arg] as const) as T;
      return await page.evaluate(fn as never, arg) as T;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(500);
    }
  }
}

const me = (page: Page) => ev<string | null>(page, () => (window as any).__game?.me() ?? null);
const peers = (page: Page) => ev<Record<string, any>>(page, () => (window as any).__voiceDebug?.peers() ?? {});

/** RMS of one peer's output on `page` over `ms` (mean-square over 50 ms samples), plus gate/band */
async function measure(page: Page, id: string, ms = 2500): Promise<{ l: number; r: number; max: number; gain: number; band: number; maxGain: number }> {
  return ev(page, async ({ id, ms }: { id: string; ms: number }) => {
    let sl = 0, sr = 0, n = 0, mx = 0, gain = 0, band = -1, maxGain = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const p = (window as any).__voiceDebug?.peers()[id];
      if (p) { sl += p.rmsL * p.rmsL; sr += p.rmsR * p.rmsR; n++; mx = Math.max(mx, p.rmsL, p.rmsR); gain = p.gain; band = p.band; maxGain = Math.max(maxGain, p.gain); }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { l: Math.sqrt(sl / Math.max(1, n)), r: Math.sqrt(sr / Math.max(1, n)), max: mx, gain, band, maxGain };
  }, { id, ms });
}

/** histogram of the local detected band over ms */
async function bandHist(page: Page, ms = 6000): Promise<Record<string, number>> {
  return ev(page, async (ms: number) => {
    const names = ['silent', 'whisper', 'talk', 'shout', 'scream'];
    const h: Record<string, number> = {};
    const t0 = performance.now();
    const lv: number[] = [];
    while (performance.now() - t0 < ms) {
      const b = (window as any).__voiceDebug?.band() ?? -1;
      const k = names[b] ?? String(b);
      h[k] = (h[k] ?? 0) + 1;
      const l = (window as any).__voiceDebug?.level?.();
      if (l) lv.push(l.db);
      await new Promise((r) => setTimeout(r, 50));
    }
    const l = (window as any).__voiceDebug?.level?.();
    lv.sort((a, b) => a - b);
    return { ...h, base: l ? Math.round(l.base * 10) / 10 : null, gate: l ? Math.round(l.gate * 10) / 10 : null, p50db: lv.length ? Math.round(lv[lv.length >> 1]) : null, p90db: lv.length ? Math.round(lv[Math.floor(lv.length * 0.9)]) : null } as never;
  }, ms);
}

type AnyState = { phase: string; me: string; net: string; screen: string; players: { id: string; p: [number, number, number]; yaw?: number }[]; crew: { code: string; players: { id: string; name: string; ready: boolean; alive: boolean; connected: boolean }[] } | null; pending?: string[] };
const st = (page: Page) => ev<AnyState>(page, () => (window as any).__game?.state());

async function pose(page: Page): Promise<{ x: number; z: number; yaw: number } | null> {
  return ev(page, () => {
    const g = (window as any).__game;
    const s = g?.state();
    const m = s?.players?.find((q: any) => q.id === s.me);
    return m ? { x: m.p[0], z: m.p[2], yaw: m.yaw ?? 0 } : null;
  });
}

async function hold(page: Page, key: string, ms: number) { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); }
async function tap(page: Page, key: string) { await page.keyboard.down(key); await sleep(70); await page.keyboard.up(key); }
const dbg = (page: Page, r: string, a: unknown = {}) => ev<any>(page, ([r, a]: [string, unknown]) => (window as any).__game.dbg(r, a), [r, a]);
const req = (page: Page, r: string, a: unknown = {}) => ev<any>(page, ([r, a]: [string, unknown]) => (window as any).__game.req(r, a), [r, a]);
/** teleport via the server (dbg.net.teleport) then wait for the client to settle */
async function tp(page: Page, x: number, z: number, yaw?: number) {
  const r = await dbg(page, 'net.teleport', yaw === undefined ? { x, z } : { x, z, yaw });
  return r;
}
const dB = (x: number) => Math.round(20 * Math.log10(Math.max(1e-9, x)) * 10) / 10;

const h = { launch, close, shot, ev, me, peers, measure, bandHist, st, pose, hold, tap, dbg, req, tp, dB, sleep, log, players, BASE, writeFileSync, readFileSync, appendFileSync, join, DIR, SHOTS, state: {} as Record<string, unknown> };

const done = new Set<string>();
log('driver up; waiting for cmd/*.js');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
for (;;) {
  let files: string[] = [];
  try { files = readdirSync(CMD).filter((f) => f.endsWith('.js') && !done.has(f)).sort(); } catch { /* ignore */ }
  for (const f of files) {
    done.add(f);
    const out = join(CMD, f.replace(/\.js$/, '.out.txt'));
    const code = readFileSync(join(CMD, f), 'utf8');
    log(`run ${f}`);
    const t = Date.now();
    let res: string;
    try {
      const fn = new AsyncFunction('P', 'h', code);
      const r = await Promise.race([fn(players, h), new Promise((_, rej) => setTimeout(() => rej(new Error('step timeout 300s')), 300_000))]);
      res = typeof r === 'string' ? r : JSON.stringify(r, null, 1);
    } catch (e) {
      res = `STEP ERROR: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`;
    }
    writeFileSync(out, `${res}\n-- ${((Date.now() - t) / 1000).toFixed(1)} s\n`);
    log(`done ${f}`);
  }
  if (existsSync(join(CMD, 'QUIT'))) break;
  await sleep(200);
}
for (const p of Object.values(players)) await p.browser.close().catch(() => {});
log('driver exit');
process.exit(0);
