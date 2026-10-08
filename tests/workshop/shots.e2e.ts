// Owner: workshop (v1.2). One batched browser pass (real Chrome, real GPU; run it through the GPU guard):
//   the van interior at the workbench (upgrade parts hidden), the workbench screen (craft / upgrades / locker tabs),
//   then dbg.workshop.unlock all -> the van with every upgrade part visible (level.setVanUpgrades).
// Needs a dev server already running (started outside the guard so Vite's first compile is not on the GPU clock):
//   PORT=3805 NODE_ENV=development AI_MODE=mock SAVES_DIR=<tmp> SESSION_FILE=<tmp>/session.json node apps/server/src/index.ts --dev
// Run: node tools/gpu-guard.mjs --max-sec 120 -- node tests/workshop/shots.e2e.ts
// Screenshots: tests/artifacts/workshop/*.png (or SHOTS_DIR)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO, launchPlayer } from '../lib/launch.ts';

const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3805}`;
const OUT = process.env.SHOTS_DIR ?? join(REPO, 'tests/artifacts/workshop');
mkdirSync(OUT, { recursive: true });
const CREW = process.env.CREW ?? 'WBSH';
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type St = { workbench: { x: number; z: number; rot: number; p: [number, number, number] } | null; stashStation: { x: number; z: number; rot: number; p: [number, number, number] } | null };
type G = {
  __game: { state(): { net: string; phase: string }; ready(): boolean; dbg(r: string, a?: unknown): Promise<unknown>; teleport(x: number, z: number, yaw?: number): void; look(yaw: number, pitch: number): void; errors(): string[]; perf(): { fps: number; drawCalls?: number } };
  __workshop?: { open(tab?: string): void; unlocks(): string[] | null; applied(): string | null; sync(): void };
  __meta?: { close(): void; screen(): string };
};

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

async function shot(page: Page, name: string): Promise<void> {
  const p = join(OUT, `${name}.png`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdp capture timeout')), 20_000)),
    ])) as { data: string };
    writeFileSync(p, Buffer.from(r.data, 'base64'));
  } finally {
    await cdp.detach().catch(() => {});
  }
  log(`screenshot ${p}`);
}

const ev = <R, A = undefined>(page: Page, fn: (a: A) => R, a?: A) => page.evaluate(fn as never, a as never) as Promise<R>;
const dbg = (page: Page, r: string, a?: unknown) => ev(page, ([rr, aa]: [string, unknown]) => (window as unknown as G).__game.dbg(rr, aa), [r, a] as [string, unknown]);

let code = 0;
const p = await launchPlayer({ name: 'Wren', baseUrl: BASE, crew: CREW, query: { autojoin: '1', nobright: '1' }, viewport: { width: 1440, height: 810 } });
try {
  await p.page.route('**/@vite/client', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  await p.page.waitForFunction(() => (window as unknown as G).__game?.state().net === 'joined', undefined, { timeout: 45_000, polling: 200 });
  log('joined');
  await p.page.waitForFunction(() => (window as unknown as G).__game?.ready() === true, undefined, { timeout: 45_000, polling: 250 }).catch(() => log('ready() timed out: shooting anyway'));
  const st = (await dbg(p.page, 'workshop.state')) as St;
  const wb = st.workbench!;
  // stand across the cargo bay from the bench, looking at it (yaw: forward = (sin, cos); the bench faces normalOfYaw(rot))
  const look = wb.rot + Math.PI;
  const [fx, fz] = [Math.round(Math.sin(wb.rot) * 1e6) / 1e6, Math.round(Math.cos(wb.rot) * 1e6) / 1e6];
  const standX = wb.x + fx * 1.25, standZ = wb.z + fz * 1.25;
  await dbg(p.page, 'workshop.reset');
  await dbg(p.page, 'workshop.give', { mats: { 'mat.scrap': 9, 'mat.wiring': 5, 'mat.chem': 4, 'mat.optics': 2, 'mat.cells': 1 } });
  await dbg(p.page, 'meta.shift', { balance: 420 });
  await ev(p.page, ([x, z, y]: [number, number, number]) => { const g = (window as unknown as G).__game; g.teleport(x, z, y); g.look(y, -0.12); }, [standX, standZ, look] as [number, number, number]);
  await dbg(p.page, 'interaction.pose', { x: standX, z: standZ, yaw: look });
  await sleep(2500);
  await shot(p.page, 'van-bench');

  // the screen: craft tab (tier II locked), then buy the Soldering station through the UI, upgrades + locker tabs
  await ev(p.page, () => (window as unknown as G).__workshop?.open('craft'));
  await p.page.waitForSelector('.wb-card', { timeout: 8000 }).catch(() => log('no recipe cards rendered'));
  await sleep(900);
  await shot(p.page, 'workbench-craft');
  await p.page.click('.wb-card.can .m-btn.primary').catch(() => log('no affordable recipe to click'));
  await sleep(900);
  await shot(p.page, 'workbench-crafted');
  await p.page.click('.wb-tab[data-tab="upgrades"]');
  await sleep(400);
  await p.page.click('[data-upgrade="bench_tools"] .m-btn.primary').catch(() => log('bench_tools not buyable'));
  await sleep(900);
  await shot(p.page, 'workbench-upgrades');
  await p.page.click('.wb-tab[data-tab="locker"]');
  await sleep(900);
  await shot(p.page, 'workbench-locker');
  await p.page.click('.wb-tab[data-tab="craft"]');
  await sleep(500);
  await p.page.evaluate(() => window.scrollTo(0, 0));
  await p.page.$eval('.m-screen', (el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
  await sleep(500);
  await shot(p.page, 'workbench-tier2');
  await p.page.keyboard.press('Escape');
  await sleep(500);
  const closed = await ev(p.page, () => (window as unknown as G).__meta?.screen?.() ?? 'unknown');
  log(`after Esc the screen is '${closed}'`);

  // every van upgrade: the parts become visible (setVanUpgrades follows MetaState.unlocks)
  await dbg(p.page, 'workshop.unlock', { id: 'all' });
  await sleep(1200);
  const u = await ev(p.page, () => ({ unlocks: (window as unknown as G).__workshop?.unlocks() ?? null, applied: (window as unknown as G).__workshop?.applied() ?? null }));
  log(`client unlocks ${JSON.stringify(u)}`);
  await ev(p.page, ([x, z, y]: [number, number, number]) => { const g = (window as unknown as G).__game; g.teleport(x, z, y); g.look(y, -0.12); }, [standX, standZ, look] as [number, number, number]);
  await sleep(1500);
  await shot(p.page, 'van-upgrades');
  // the other way: the locker wall and the rear doors
  await ev(p.page, ([x, z, y]: [number, number, number]) => { const g = (window as unknown as G).__game; g.teleport(x, z, y); g.look(y, -0.08); }, [wb.x + fx * 0.55, wb.z + fz * 0.55, wb.rot - 0.5] as [number, number, number]);
  await sleep(1200);
  await shot(p.page, 'van-upgrades-rev');
  const errs = await ev(p.page, () => (window as unknown as G).__game.errors());
  const perf = await ev(p.page, () => (window as unknown as G).__game.perf());
  log(`perf ${JSON.stringify(perf)}; game errors ${errs.length}${errs.length ? `: ${errs.slice(0, 5).join(' | ')}` : ''}`);
  log(`page errors ${p.errors.length}${p.errors.length ? `: ${p.errors.slice(0, 5).join(' | ')}` : ''}`);
} catch (e) {
  console.error('FAIL', e instanceof Error ? (e.stack ?? e.message) : e);
  await shot(p.page, 'failure').catch(() => {});
  code = 1;
} finally {
  await p.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 200).unref();
}
