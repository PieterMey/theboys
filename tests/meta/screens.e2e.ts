// Owner: track (d) Meta. Playwright screenshots of every meta screen (real Chrome, real GPU):
//   join, hub HUD, brightness, board, shop, mirror, kennel, menu (how-to / settings / credits), drive, console,
//   results, HR memo (promoted), termination letter (fired).
// Run: node tests/meta/screens.e2e.ts [--keep]   (spawns its own dev server on PORT (default 3014), temp SAVES_DIR)
// Screenshots: tests/artifacts/meta/*.png
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchPlayer, REPO } from '../lib/launch.ts';
import type { Page } from 'playwright-core';

const PORT = Number(process.env.PORT ?? 3014);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(REPO, 'tests/artifacts/meta');
mkdirSync(OUT, { recursive: true });
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const want = (n: string) => !only || only.includes(n);

const saves = mkdtempSync(join(tmpdir(), 'deadair-meta-shots-'));
const srv = spawn(process.execPath, ['apps/server/src/index.ts', '--dev'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), SAVES_DIR: saves, NODE_ENV: 'development', AI_MODE: 'mock' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (b: Buffer) => { srvLog += b.toString(); });
srv.stderr.on('data', (b: Buffer) => { srvLog += b.toString(); });

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start:\n${srvLog.slice(-2000)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type W = { __game: { dbg(r: string, a?: unknown): Promise<unknown>; state(): { phase: string; screen: string } }; __meta: { open(n: string, p?: unknown): void; close(): void; screen(): string; pushIntercept(d: unknown): void } };

/**
 * Other agents edit files in the shared tree all night: Vite HMR would full-reload our pages mid-run. Serve a stub
 * /@vite/client (same exports, no socket) so test pages keep running, then reload once.
 */
const VITE_STUB = `
import '/@vite/env';
export function createHotContext() { return { data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {} }; }
const sheets = new Map();
export function updateStyle(id, css) {
  let el = sheets.get(id);
  if (!el) { el = document.createElement('style'); el.setAttribute('type', 'text/css'); el.setAttribute('data-vite-dev-id', id); document.head.appendChild(el); sheets.set(id, el); }
  el.textContent = css;
}
export function removeStyle(id) { const el = sheets.get(id); if (el) { el.remove(); sheets.delete(id); } }
export function injectQuery(url) { return url; }
export class ErrorOverlay extends HTMLElement {}
`;
async function freezeVite(page: Page): Promise<void> {
  await page.route('**/@vite/client', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function phase(page: Page, ph: string, timeout = 15000): Promise<void> {
  await page.waitForFunction((p) => (window as unknown as W).__game.state().phase === p, ph, { timeout, polling: 100 });
}
async function open(page: Page, name: string, props?: unknown): Promise<void> {
  await page.evaluate(([n, p]) => (window as unknown as W).__meta.open(n as string, p), [name, props] as const);
  await sleep(650);
}
async function dbg(page: Page, r: string, a?: unknown): Promise<unknown> {
  return page.evaluate(([rr, aa]) => (window as unknown as W).__game.dbg(rr as string, aa), [r, a] as const);
}
async function shot(page: Page, name: string): Promise<void> {
  const p = join(OUT, `${name}.png`);
  const t0 = Date.now();
  const perf = await page.evaluate(() => (window as unknown as { __game?: { perf(): { fps: number } } }).__game?.perf()).catch(() => null);
  // CDP capture straight from the compositor surface (Playwright's screenshot can stall on a busy WebGPU page)
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdp capture timeout')), 60_000)),
    ])) as { data: string };
    writeFileSync(p, Buffer.from(r.data, 'base64'));
  } finally {
    await cdp.detach().catch(() => {});
  }
  console.log(`screenshot ${p} (${((Date.now() - t0) / 1000).toFixed(1)} s, fps ${perf ? perf.fps.toFixed(0) : '?'})`);
}

let code = 0;
const closers: (() => Promise<void>)[] = [];
try {
  await waitHealthy();
  console.log(`server up on ${BASE} (saves ${saves})`);

  if (want('join')) {
    const j = await launchPlayer({ name: 'Ann', baseUrl: BASE, crew: 'SHOT', viewport: { width: 1280, height: 720 } });
    closers.push(() => j.close());
    await freezeVite(j.page);
    await j.page.waitForFunction(() => !!(window as unknown as { __game?: unknown }).__game, undefined, { timeout: 30000 });
    await sleep(2500);
    await shot(j.page, 'join');
    await j.close();
  }

  const a = await launchPlayer({ name: 'Ann', baseUrl: BASE, crew: 'SHOT', query: { autojoin: '1', nobright: '1' }, viewport: { width: 1280, height: 720 } });
  closers.push(() => a.close());
  await freezeVite(a.page);
  await a.page.waitForFunction(() => (window as unknown as { __game?: { state(): { net: string } } }).__game?.state().net === 'joined', undefined, { timeout: 30000, polling: 200 });
  // second player so the crew list / banner / ready count are populated
  const b = await launchPlayer({ name: 'Bob', baseUrl: BASE, crew: 'SHOT', query: { autojoin: '1', nobright: '1' }, viewport: { width: 320, height: 180 } });
  closers.push(() => b.close());
  await freezeVite(b.page);
  await b.page.waitForFunction(() => (window as unknown as { __game?: { state(): { net: string } } }).__game?.state().net === 'joined', undefined, { timeout: 30000, polling: 200 });
  await sleep(3500);
  if (want('hub')) await shot(a.page, 'hub');

  if (want('brightness')) { await open(a.page, 'brightness', { first: true }); await shot(a.page, 'brightness'); }
  if (want('board')) { await open(a.page, 'board'); await shot(a.page, 'board'); }
  if (want('shop')) { await open(a.page, 'shop'); await shot(a.page, 'shop'); }
  if (want('mirror')) { await open(a.page, 'mirror'); await shot(a.page, 'mirror'); }
  if (want('kennel')) { await open(a.page, 'kennel'); await sleep(800); await shot(a.page, 'kennel'); }
  if (want('menu')) {
    await open(a.page, 'menu', { tab: 'howto' }); await shot(a.page, 'menu-howto');
    await open(a.page, 'menu', { tab: 'settings' }); await shot(a.page, 'menu-settings');
    await open(a.page, 'menu', { tab: 'credits' }); await sleep(500); await shot(a.page, 'menu-credits');
  }
  await a.page.evaluate(() => (window as unknown as W).__meta.close());

  // ---- pick + ready -> drive
  // use the board UI: click the first order card, then ready both players
  await open(a.page, 'board');
  await a.page.click('.m-order:not(.locked)');
  await sleep(300);
  if (want('board')) await shot(a.page, 'board-picked');
  await a.page.keyboard.press('Escape');
  await b.page.keyboard.press('KeyR');
  await a.page.keyboard.press('KeyR');
  await phase(a.page, 'drive');
  await dbg(a.page, 'meta.driveFor', { sec: 90 });
  await sleep(3200);
  if (want('drive')) await shot(a.page, 'drive');
  await dbg(a.page, 'meta.skipDrive');
  await phase(a.page, 'contract');
  await sleep(2500);
  if (want('contract')) await shot(a.page, 'contract');

  if (want('console')) {
    await open(a.page, 'console');
    await a.page.evaluate(() => {
      const m = (window as unknown as W).__meta;
      m.pushIntercept({ text: 'INTERCEPT: "…meet in BOILER…"', quote: 'ok meet in boiler in two', speaker: 'Bob', callsign: 'BOILER', action: 'ambush_room', at: Date.now() });
      m.pushIntercept({ text: 'INTERCEPT: "…code is four…"', quote: 'the code is four seven', speaker: 'Ann', callsign: null, action: 'investigate_room', at: Date.now() });
    });
    await sleep(1200);
    await shot(a.page, 'console');
    await a.page.evaluate(() => (window as unknown as W).__meta.close());
  }

  // ---- results (contract 1)
  const bId = await b.page.evaluate(() => (window as unknown as { __game: { me(): string } }).__game.me());
  await dbg(a.page, 'meta.endContract', { hauled: 412, lootTotal: 980, coreExtracted: true, deaths: [{ player: bId, killer: 'HOUND', reason: 'heard your SPRINT, 9 m', detail: 'It was 9 m away, behind the BOILER door. You were not crouching.' }] });
  await phase(a.page, 'results');
  await sleep(2200);
  if (want('results')) await shot(a.page, 'results');

  // ---- shift end: jump to contract 3 and finish it -> HR memo (promoted)
  await a.page.evaluate(() => (window as unknown as { __game: { dbg(r: string): Promise<unknown> } }).__game.dbg('meta.resultsNow'));
  await phase(a.page, 'hub');
  await dbg(a.page, 'meta.shift', { contract: 2, hauled: 640 });
  await open(a.page, 'board');
  await a.page.click('.m-order:not(.locked)');
  await a.page.keyboard.press('Escape');
  await b.page.keyboard.press('KeyR');
  await a.page.keyboard.press('KeyR');
  await phase(a.page, 'drive');
  await dbg(a.page, 'meta.skipDrive');
  await phase(a.page, 'contract');
  await dbg(a.page, 'meta.endContract', { hauled: 120 });
  await phase(a.page, 'results');
  await sleep(1500);
  if (want('memo')) {
    await open(a.page, 'memo');
    await sleep(1200);
    await shot(a.page, 'memo-typing');
    await a.page.click('.m-paper');
    await sleep(600);
    await shot(a.page, 'memo');
  }

  // ---- fired: next shift, jump to contract 3 with nothing hauled
  await dbg(a.page, 'meta.resultsNow');
  await phase(a.page, 'hub');
  await dbg(a.page, 'meta.shift', { contract: 2, hauled: 0 });
  await open(a.page, 'board');
  await a.page.click('.m-order:not(.locked)');
  await a.page.keyboard.press('Escape');
  await b.page.keyboard.press('KeyR');
  await a.page.keyboard.press('KeyR');
  await phase(a.page, 'drive');
  await dbg(a.page, 'meta.skipDrive');
  await phase(a.page, 'contract');
  await dbg(a.page, 'meta.endContract', { hauled: 35 });
  await phase(a.page, 'results');
  await sleep(800);
  if (want('memo')) {
    await open(a.page, 'memo');
    await a.page.click('.m-paper');
    await sleep(700);
    await shot(a.page, 'memo-fired');
    await a.page.evaluate(() => { const el = document.querySelector('.m-screen'); if (el) el.scrollTop = el.scrollHeight; });
    await sleep(300);
    await shot(a.page, 'memo-fired-letter');
  }
  const errs = [...a.errors, ...b.errors].filter((e) => !/favicon|404|ERR_|WebGPU|net::/.test(e));
  if (errs.length) console.log(`page errors (${errs.length}):\n  ${errs.slice(0, 12).join('\n  ')}`);
  console.log('META SCREENS DONE');
} catch (e) {
  code = 1;
  console.error('META SCREENS FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
  console.error(srvLog.split('\n').filter((l) => /meta|ERROR|WARN/.test(l)).slice(-30).join('\n'));
} finally {
  for (const c of closers) await c().catch(() => {});
  srv.kill();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
