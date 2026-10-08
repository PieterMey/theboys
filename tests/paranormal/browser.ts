// Owner: env-paranormal (v1.2). One Chrome player for the paranormal screenshots, launched like tests/lib/launch.ts but
// with Vite's HMR socket mocked out: 11 builders edit the tree tonight and a hot reload in the middle of a guarded run
// would cost the whole run. The game socket (/ws) is untouched.
// Software lane: tools/gpu-guard.mjs sets DEADAIR_RENDER=swiftshader (hardware GPU is off for agent tests since the
// 2026-10-08 00:50 crash) -> CPU-only SwiftShader flags, ?webgl=1 and ?preset=low (forced over the caller's query).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

export interface Player { browser: Browser; page: Page; errors: string[]; logs: string[]; close(): Promise<void> }

/** set by tools/gpu-guard.mjs while hardware rendering is off for agent tests */
export const SOFTWARE = process.env.DEADAIR_RENDER === 'swiftshader';

export async function launchPlayer(o: { baseUrl: string; crew: string; name: string; query?: Record<string, string>; viewport?: { width: number; height: number } }): Promise<Player> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      ...(SOFTWARE ? ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
    ],
  });
  const context = await browser.newContext({ viewport: o.viewport ?? { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors: string[] = [];
  const logs: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(`console: ${t}`);
    if (/paranormal/i.test(t)) logs.push(`${m.type()}: ${t}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // Vite HMR (path '/', token query) -> a silent mock: no hot reloads during the run
  await page.routeWebSocket((u) => u.pathname !== '/ws', () => { /* mocked, never connects */ });
  await page.addInitScript((n: string) => {
    try { localStorage.setItem('deadair.name', n); } catch { /* ignore */ }
  }, o.name);
  const q = new URLSearchParams({ test: '1', ...(o.query ?? {}) });
  if (SOFTWARE) { q.set('webgl', '1'); q.set('preset', 'low'); }
  await page.goto(`${o.baseUrl.replace(/\/$/, '')}/?${q.toString()}#${o.crew}`, { waitUntil: 'domcontentloaded' });
  return { browser, page, errors, logs, close: () => browser.close() };
}

export async function shot(page: Page, path: string): Promise<string> {
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
  return path;
}
