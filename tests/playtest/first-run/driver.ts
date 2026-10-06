// Playtest driver (first-run scenario). Keeps real Chrome players alive and runs step files dropped into ./cmd/.
// Each cmd/<n>.js is the body of an async function (P, h) => result; output goes to cmd/<n>.out.txt.
// Never targets anything but our own dev server on :3201.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

const DIR = import.meta.dirname;
const CMD = join(DIR, 'cmd');
const SHOTS = join(DIR, 'shots');
const VOICE = join(DIR, '../../fixtures/voice');
mkdirSync(CMD, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const BASE = 'http://127.0.0.1:3201';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const LOG = join(DIR, 'driver.log');
const log = (s: string) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); appendFileSync(LOG, l + '\n'); };

interface P { name: string; browser: Browser; page: Page; console: string[] }
const players: Record<string, P> = {};

async function launch(name: string, wav: string, opts: { url?: string; viewport?: { width: number; height: number } } = {}): Promise<P> {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(VOICE, wav)}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1600, height: 900 } });
  await context.grantPermissions(['microphone']).catch(() => {});
  // block Vite HMR before the first navigation (other agents edit files all night)
  await context.routeWebSocket((u) => !u.pathname.endsWith('/ws'), () => { /* swallowed */ });
  const page = await context.newPage();
  const lines: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || /error|fail|warn/i.test(t)) lines.push(`${((Date.now() - T0) / 1000).toFixed(1)} ${m.type()}: ${t.slice(0, 400)}`);
  });
  page.on('pageerror', (e) => lines.push(`${((Date.now() - T0) / 1000).toFixed(1)} pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) lines.push(`http ${r.status()}: ${r.url()}`); });
  const url = opts.url ?? `${BASE}/?test=1#PLAY1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const p = { name, browser, page, console: lines };
  players[name] = p;
  log(`launched ${name} (${wav}) -> ${url}`);
  return p;
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

type AnyState = { phase: string; me: string; net: string; screen: string; players: { id: string; p: [number, number, number]; yaw?: number }[]; crew: { code: string; players: { id: string; name: string; ready: boolean; profile: unknown }[] } | null; pending?: string[] };
const st = (page: Page) => page.evaluate(() => (window as any).__game?.state() as AnyState | undefined);

async function pose(page: Page): Promise<{ x: number; z: number; yaw: number } | null> {
  return page.evaluate(() => {
    const g = (window as any).__game;
    const s = g?.state();
    const me = s?.players?.find((q: any) => q.id === s.me);
    return me ? { x: me.p[0], z: me.p[2], yaw: me.yaw ?? 0 } : null;
  });
}

/** hold a key for ms (real keyboard events) */
async function hold(page: Page, key: string, ms: number) { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); }
async function tap(page: Page, key: string) { await page.keyboard.down(key); await sleep(70); await page.keyboard.up(key); }

/** face (x,z) with __game.look (looking only) and walk there with real W presses */
async function walkTo(page: Page, x: number, z: number, tol = 0.6, maxSteps = 12): Promise<string> {
  const trail: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const q = await pose(page);
    if (!q) return 'no pose';
    const dx = x - q.x, dz = z - q.z;
    const d = Math.hypot(dx, dz);
    trail.push(`(${q.x.toFixed(2)},${q.z.toFixed(2)}) d=${d.toFixed(2)}`);
    if (d <= tol) return `arrived: ${trail.join(' -> ')}`;
    const yaw = Math.atan2(dx, dz);
    await page.evaluate(([y]) => (window as any).__game.look(y, 0), [yaw]);
    await sleep(60);
    await hold(page, 'KeyW', Math.min(1500, Math.max(120, (d / 3.0) * 1000 * 0.85)));
    await sleep(250);
  }
  const q = await pose(page);
  return `NOT arrived (stuck?) at ${q ? `${q.x.toFixed(2)},${q.z.toFixed(2)}` : '?'}: ${trail.join(' -> ')}`;
}

const h = { launch, shot, st, pose, hold, tap, walkTo, sleep, log, players, BASE, writeFileSync, readFileSync, join, DIR, SHOTS };

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
      const r = await Promise.race([fn(players, h), new Promise((_, rej) => setTimeout(() => rej(new Error('step timeout 240s')), 240_000))]);
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
