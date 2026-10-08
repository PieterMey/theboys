// Gate R (v1.2) shared helpers: one Chrome per run (SwiftShader lane under tools/gpu-guard.mjs), CDP screenshots with a
// timeout, a hard time budget, and a JSON record of every view, check and error. Only for tests/gates/v12r-*.e2e.ts.
// Runs ONLY through the guard (it sets DEADAIR_RENDER=swiftshader); the backend is a dev server behind
// tests/gates/v12r-proxy.mjs, which serves a temp production build of the client.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

export const REPO = resolve(import.meta.dirname, '../..');
export type V3 = [number, number, number];
export const SOFTWARE = process.env.DEADAIR_RENDER === 'swiftshader';
if (!SOFTWARE && process.env.DEADAIR_HW_GPU_OK !== '1') throw new Error('run through node tools/gpu-guard.mjs (software lane)');
export const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3898').replace(/\/$/, '');
if (/:(3000|3100)$/.test(BASE)) throw new Error('refusing the live ports');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Run {
  tag: string; out: string;
  el(): number; left(): number; log(s: string): void;
  views: { name: string; file: string; at: number; ms: number; note?: unknown }[];
  checks: { name: string; ok: boolean; detail?: unknown }[];
  notes: Record<string, unknown>;
  check(name: string, ok: unknown, detail?: unknown): boolean;
  write(extra?: Record<string, unknown>): void;
}

export function mkRun(tag: string, budgetSec: number): Run {
  const out = join(REPO, 'tests/artifacts/gate-r', tag);
  mkdirSync(out, { recursive: true });
  const t0 = performance.now();
  const el = () => (performance.now() - t0) / 1000;
  const run: Run = {
    tag, out, el, left: () => budgetSec - el(),
    log: (s) => console.log(`[${el().toFixed(1).padStart(6)}s] ${s}`),
    views: [], checks: [], notes: {},
    check(name, ok, detail) {
      run.checks.push({ name, ok: !!ok, detail });
      run.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
      return !!ok;
    },
    write(extra = {}) {
      writeFileSync(join(out, `${tag}.json`), JSON.stringify({ tag, base: BASE, software: SOFTWARE, elapsedSec: +el().toFixed(1), views: run.views, checks: run.checks, notes: run.notes, ...extra }, null, 1));
    },
  };
  return run;
}

export interface P { browser: Browser; page: Page; errors: string[]; close(): Promise<void> }

/** one simulated player = one Chrome process; localStorage seeded BEFORE the first navigation */
export async function launch(o: { name: string; crew?: string; query?: Record<string, string>; viewport?: { width: number; height: number }; storage?: Record<string, string> }): Promise<P> {
  const wav = join(REPO, 'tests/fixtures/voice/silence.wav');
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required',
      ...(SOFTWARE ? ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
  });
  const context = await browser.newContext({ viewport: o.viewport ?? { width: 1280, height: 720 } });
  await context.grantPermissions(['microphone']).catch(() => {});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 400)}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 400)}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
  const storage = { 'deadair.name': o.name, ...(o.storage ?? {}) };
  await page.addInitScript((s: Record<string, string>) => {
    try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch { /* ignore */ }
  }, storage);
  const q = new URLSearchParams({ test: '1', webgl: '1', preset: 'low', nobright: '1', ...(o.query ?? {}) });
  if (SOFTWARE) q.set('webgl', '1');
  await page.goto(`${BASE}/?${q.toString()}${o.crew ? `#${o.crew}` : ''}`, { waitUntil: 'domcontentloaded' });
  return { browser, page, errors, close: () => browser.close() };
}

/** CDP capture (no font wait, no animation wait) with a timeout; records the view */
export async function shot(run: Run, page: Page, name: string, note?: unknown): Promise<boolean> {
  const t = performance.now();
  const file = join(run.out, `${name}.png`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('capture timeout')), Math.max(3000, Math.min(20_000, run.left() * 1000 - 2000)))),
    ])) as { data: string };
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    const ms = Math.round(performance.now() - t);
    run.views.push({ name, file, at: +run.el().toFixed(1), ms, note });
    run.log(`shot ${name} (${ms} ms)`);
    return true;
  } catch (e) {
    run.log(`shot ${name} FAILED: ${String(e).slice(0, 160)}`);
    return false;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

type AnyWin = Record<string, any>;
/** evaluate a function of the page window (typed loosely: the hooks are each package's own) */
export const ev = <R = unknown, A = unknown>(page: Page, fn: (w: AnyWin, a: A) => R | Promise<R>, a?: A): Promise<R> =>
  page.evaluate(([src, arg]) => {
    // eslint-disable-next-line no-new-func
    const f = new Function('w', 'a', `return (${src})(w, a);`) as (w: unknown, a: unknown) => unknown;
    return f(window, arg);
  }, [fn.toString(), a ?? null] as [string, unknown]) as Promise<R>;

export const dbg = <R = unknown>(page: Page, r: string, a: unknown = {}): Promise<R> =>
  page.evaluate(([rr, aa]) => (window as unknown as { __game: { dbg(r: string, a: unknown): Promise<unknown> } }).__game.dbg(rr as string, aa), [r, a] as [string, unknown]) as Promise<R>;

/** let the render loop draw n more frames (bounded) */
export const frames = (page: Page, n: number, maxMs = 8000) =>
  page.evaluate(([k, ms]) => new Promise((r) => { let left = k; const t = setTimeout(() => r(false), ms); const f = () => { if (--left <= 0) { clearTimeout(t); r(true); } else requestAnimationFrame(f); }; requestAnimationFrame(f); }), [n, maxMs] as [number, number]);

/** poll a page predicate until truthy (false on timeout) */
export async function until<A>(page: Page, fn: (w: AnyWin, a: A) => unknown, a: A, ms: number): Promise<boolean> {
  return page.waitForFunction(([src, arg]) => {
    try { return !!(new Function('w', 'a', `return (${src})(w, a);`) as (w: unknown, a: unknown) => unknown)(window, arg); } catch { return false; }
  }, [fn.toString(), a] as [string, A], { timeout: Math.max(100, ms), polling: 150 }).then(() => true, () => false);
}

/** free debug camera (E3 __levelDebug); null gives the camera back to the player */
export const camera = (page: Page, p: V3 | null, t?: V3) =>
  ev(page, (w, a: [V3 | null, V3 | null]) => { w.__levelDebug?.cull?.(true); w.__levelDebug?.camera(a[0], a[1] ?? undefined); }, [p, t ?? null] as [V3 | null, V3 | null]);

/** client error tally: __game.errors() (console + WebGPU uncaptured) and the page's own console/pageerror/http */
export async function errorTally(page: Page, p: P): Promise<{ game: string[]; page: string[]; http: string[] }> {
  const game = await ev<string[]>(page, (w) => w.__game?.errors?.() ?? []).catch(() => ['(errors() unavailable)']);
  return {
    game,
    page: p.errors.filter((e) => !e.startsWith('http ')),
    http: p.errors.filter((e) => e.startsWith('http ')),
  };
}
