// Owner: track (c) Monsters. Like tests/lib/launch.ts launchPlayer, but blocks Vite's HMR websocket so the page is not
// reloaded every time another track saves a file in the shared working tree (dev server tests stay stable).
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

export const REPO = resolve(import.meta.dirname, '../..');

/** set by tools/gpu-guard.mjs while hardware rendering is off for agent tests (the host's GPU fault): SwiftShader */
const SOFTWARE = process.env.DEADAIR_RENDER === 'swiftshader';

export interface StablePlayer { browser: Browser; page: Page; errors: string[]; close(): Promise<void> }

export async function launchStable(opts: { name: string; baseUrl: string; crew: string; query?: Record<string, string>; viewport?: { width: number; height: number } }): Promise<StablePlayer> {
  const wav = join(REPO, 'tests/fixtures/voice/silence.wav');
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required',
      ...(SOFTWARE ? ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
  });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 720 } });
  await context.grantPermissions(['microphone']).catch(() => {});
  // the game socket is /ws; everything else is Vite's HMR channel -> refuse it (no live reloads mid-test)
  await context.routeWebSocket((url) => !url.pathname.endsWith('/ws'), (ws) => { ws.close(); });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/vite|websocket/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript((n: string) => { try { localStorage.setItem('deadair.name', n); } catch { /* ignore */ } }, opts.name);
  const q = new URLSearchParams({ test: '1', ...(SOFTWARE ? { webgl: '1', preset: 'low' } : {}), ...(opts.query ?? {}) });
  if (SOFTWARE) q.set('webgl', '1');
  await page.goto(`${opts.baseUrl.replace(/\/$/, '')}/?${q.toString()}#${opts.crew}`, { waitUntil: 'domcontentloaded' });
  return { browser, page, errors, close: () => browser.close() };
}

export async function shot(page: Page, path: string): Promise<string> {
  const abs = isAbsolute(path) ? path : join(REPO, path);
  mkdirSync(dirname(abs), { recursive: true });
  await page.screenshot({ path: abs });
  return abs;
}
