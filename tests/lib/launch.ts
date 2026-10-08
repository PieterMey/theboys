// Playwright launcher for one simulated player = one Chrome process (the fake-mic WAV is per process).
// Real Chrome (channel 'chrome') headless => real RTX 5090 WebGPU; screenshots capture the canvas.
//   const p = await launchPlayer({ name: 'Ann', wav: 'talk_en.wav', baseUrl, crew: 'BKRT' });
//   await waitForGame(p.page); await p.page.evaluate(() => window.__game!.join('BKRT'));
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import type { GameTestApi } from '../../packages/shared/src/test-api.ts';

export const REPO = resolve(import.meta.dirname, '../..');
export const VOICE_DIR = join(REPO, 'tests/fixtures/voice');

export interface LaunchOpts {
  /** player name (stored as the client's saved name before load) */
  name?: string;
  /** fake mic WAV: absolute path or a file name in tests/fixtures/voice (default silence.wav); loops */
  wav?: string;
  /** e.g. process.env.BASE_URL ?? 'http://127.0.0.1:3000' */
  baseUrl: string;
  /** crew code put in the URL hash */
  crew?: string;
  /** force the WebGL2 backend (?webgl=1) */
  webgl?: boolean;
  headless?: boolean;
  /** extra query params, e.g. { autojoin: '1', preset: 'low' } */
  query?: Record<string, string>;
  extraArgs?: string[];
  viewport?: { width: number; height: number };
}

export interface Player {
  browser: Browser;
  page: Page;
  /** console errors + page errors collected since launch */
  errors: string[];
  close(): Promise<void>;
}

/** set by tools/gpu-guard.mjs while hardware rendering is off for agent tests (the host's GPU fault) */
const SOFTWARE = process.env.DEADAIR_RENDER === 'swiftshader';

export async function launchPlayer(opts: LaunchOpts): Promise<Player> {
  const wavName = opts.wav ?? 'silence.wav';
  const wav = isAbsolute(wavName) ? wavName : join(VOICE_DIR, wavName);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: opts.headless ?? true,
    // Playwright's defaults keep background timers unthrottled; add extraArgs to simulate a backgrounded tab
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(opts.extraArgs ?? []),
      // tools/gpu-guard.mjs sets this while hardware rendering is off for agent tests: CPU-only SwiftShader
      ...(SOFTWARE ? ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
    ],
  });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 720 } });
  await context.grantPermissions(['microphone']).catch(() => {});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  if (opts.name) {
    const name = opts.name;
    await page.addInitScript((n: string) => {
      try { localStorage.setItem('deadair.name', n); } catch { /* ignore */ }
    }, name);
  }
  const q = new URLSearchParams({ test: '1', ...(opts.webgl || SOFTWARE ? { webgl: '1' } : {}), ...(SOFTWARE ? { preset: 'low' } : {}), ...(opts.query ?? {}) });
  if (SOFTWARE) q.set('webgl', '1');
  const url = `${opts.baseUrl.replace(/\/$/, '')}/?${q.toString()}${opts.crew ? `#${opts.crew}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { browser, page, errors, close: () => browser.close() };
}

/** Waits until window.__game.ready() is true (renderer + required parts done). */
export async function waitForGame(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(() => (window as { __game?: GameTestApi }).__game?.ready() === true, undefined, { timeout: timeoutMs, polling: 100 });
}

export async function screenshot(page: Page, path: string): Promise<string> {
  const abs = isAbsolute(path) ? path : join(REPO, path);
  mkdirSync(dirname(abs), { recursive: true });
  await page.screenshot({ path: abs });
  return abs;
}
