// Playtest driver (contract-run): launches two real Chrome players against :3202 and executes command files
// dropped into ./cmd/*.js (async function bodies with (A, B, h) in scope); writes results to ./out/<name>.json.
// Report-only playtest tooling; never touches :3000.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchPlayer, waitForGame } from '../../lib/launch.ts';
import type { Page } from 'playwright-core';

const BASE = 'http://127.0.0.1:3202';
const DIR = import.meta.dirname;
const CMD = join(DIR, 'cmd');
const OUT = join(DIR, 'out');
const SHOTS = join(DIR, 'shots');
for (const d of [CMD, OUT, SHOTS]) mkdirSync(d, { recursive: true });
const CLOG = join(DIR, 'console.log');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: Page, name: string): Promise<string> {
  const p = join(SHOTS, `${name}.png`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdp capture timeout')), 45_000)),
    ])) as { data: string };
    writeFileSync(p, Buffer.from(r.data, 'base64'));
  } finally {
    await cdp.detach().catch(() => {});
  }
  return p;
}

async function mk(name: string, wav: string, crew?: string) {
  const p = await launchPlayer({ name, wav, baseUrl: BASE, crew, query: { nobright: '1' }, viewport: { width: 1600, height: 900 } });
  p.page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') appendFileSync(CLOG, `[${new Date().toISOString().slice(11, 19)}] ${name} ${t}: ${m.text().slice(0, 600)}\n`);
  });
  p.page.on('pageerror', (e) => appendFileSync(CLOG, `[${new Date().toISOString().slice(11, 19)}] ${name} PAGEERROR: ${e.message}\n`));
  await p.page.routeWebSocket(/token=/, () => { /* HMR muted */ });
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  return p;
}

const A = await mk('Ann', 'silence.wav');
await waitForGame(A.page, 90_000).catch((e) => console.log('A waitForGame', String(e)));
const players: Record<string, Awaited<ReturnType<typeof mk>>> = { A };

const h = {
  sleep,
  shot,
  BASE,
  mk,
  players,
  waitForGame,
  st: (page: Page) => page.evaluate(() => (window as any).__game.state()),
  ev: (page: Page, fn: string, arg?: unknown) => page.evaluate(([f, a]) => (new Function('arg', f as string))(a), [fn, arg] as const),
  /** hold a key for ms */
  hold: async (page: Page, key: string, ms: number) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); },
  tap: async (page: Page, key: string) => { await page.keyboard.down(key); await sleep(60); await page.keyboard.up(key); },
};
(globalThis as any).h = h;

console.log('driver ready');
writeFileSync(join(OUT, 'ready.json'), JSON.stringify({ ok: true }));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
for (;;) {
  const files = readdirSync(CMD).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    const body = readFileSync(join(CMD, f), 'utf8');
    renameSync(join(CMD, f), join(CMD, `${f}.done`));
    const logs: string[] = [];
    const log = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const t0 = Date.now();
    let result: unknown = null;
    let error: string | null = null;
    try {
      const fn = new AsyncFunction('A', 'B', 'h', 'log', 'players', body);
      result = await fn(players.A, players.B, h, log, players);
    } catch (e) {
      error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    }
    writeFileSync(join(OUT, f.replace(/\.js$/, '.json')), JSON.stringify({ ms: Date.now() - t0, error, logs, result }, null, 1));
    if (body.includes('//EXIT')) process.exit(0);
  }
  await sleep(100);
  if (existsSync(join(CMD, 'STOP'))) break;
}
for (const p of Object.values(players)) await p.close().catch(() => {});
process.exit(0);
