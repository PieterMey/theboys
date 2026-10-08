// Owner: track (d) Meta. Shared helpers for the meta browser tests: own dev server, HMR-proof pages, CDP screenshots.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO } from '../lib/launch.ts';

export const OUT = join(REPO, 'tests/artifacts/meta');
mkdirSync(OUT, { recursive: true });

export interface DevServer { base: string; proc: ChildProcess; log(): string; stop(): void }

/** dev server on `port` with a temp SAVES_DIR + SESSION_FILE (AI mock); `saves` reuses a folder (restart tests) */
export async function startServer(port: number, opts: { saves?: string; env?: Record<string, string> } = {}): Promise<DevServer & { saves: string }> {
  const saves = opts.saves ?? mkdtempSync(join(tmpdir(), 'deadair-meta-ui-'));
  const proc = spawn(process.execPath, ['apps/server/src/index.ts', '--dev'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), SAVES_DIR: saves, SESSION_FILE: join(saves, 'session.json'), NODE_ENV: 'development', AI_MODE: 'mock', ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', (b: Buffer) => { log += b.toString(); });
  proc.stderr?.on('data', (b: Buffer) => { log += b.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { base, saves, proc, log: () => log, stop: () => proc.kill() };
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`server did not start:\n${log.slice(-2000)}`);
}

/**
 * Other agents edit files in the shared tree all night: Vite HMR would full-reload our pages mid-run. Serve a stub
 * /@vite/client (same exports, no socket; keeps /@vite/env for define globals) and reload once.
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

export async function freezeVite(page: Page): Promise<void> {
  await page.route('**/@vite/client', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/** CDP capture straight from the compositor surface (Playwright's screenshot can stall on a busy WebGPU page) */
export async function shot(page: Page, name: string): Promise<string> {
  const p = join(OUT, `${name}.png`);
  const t0 = Date.now();
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
  console.log(`screenshot ${p} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return p;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type G = { __game: { state(): { phase: string; net: string; crew: { players: { id: string; profile: { suit: string[] } }[] } | null }; dbg(r: string, a?: unknown): Promise<unknown>; me(): string; teleport(x: number, z: number, yaw?: number): void; setInput(i: Record<string, unknown>): void }; __meta: { open(n: string, p?: unknown): void; close(): void; screen(): string; near(): unknown } };

export const W = (page: Page) => page.evaluate.bind(page) as <R, A>(fn: (a: A) => R, a: A) => Promise<R>;

export async function joined(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as G).__game?.state().net === 'joined', undefined, { timeout: 30_000, polling: 200 });
}
export async function phase(page: Page, ph: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction((p) => (window as unknown as G).__game.state().phase === p, ph, { timeout, polling: 100 });
}
export async function screenIs(page: Page, name: string, timeout = 5_000): Promise<void> {
  await page.waitForFunction((n) => (window as unknown as G).__meta.screen() === n, name, { timeout, polling: 100 });
}
export async function dbg(page: Page, r: string, a?: unknown): Promise<unknown> {
  return page.evaluate(([rr, aa]) => (window as unknown as G).__game.dbg(rr as string, aa), [r, a] as const);
}
export type { G };
