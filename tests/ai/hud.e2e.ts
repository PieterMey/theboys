// Track (e) visual check: the host-only AI status line renders in a real Chrome (WebGPU) client.
//   node tests/ai/hud.e2e.ts   -> tests/artifacts/ai/hud.png (+ hud-expanded.png)
// Starts its own dev server on PORT 3015 (AI_MODE=mock) and joins with ?aistatus=1 (the host flag).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { launchPlayer, waitForGame } from '../lib/launch.ts';
import { REPO } from './helpers.ts';

const PORT = Number(process.env.PORT ?? 3015);
async function screenshot(page: Page, rel: string): Promise<string> {
  const abs = join(REPO, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  await page.screenshot({ path: abs, timeout: 90_000 });
  return abs;
}
const BASE = `http://127.0.0.1:${PORT}`;

async function up(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const server = spawn(process.execPath, ['--env-file-if-exists=C:/Users/Pieter/repos/theboys/.env', join(REPO, 'apps/server/src/index.ts'), '--dev'], {
  env: { ...process.env, PORT: String(PORT), AI_MODE: 'mock', NODE_ENV: 'development' }, stdio: ['ignore', 'ignore', 'pipe'],
});
let code = 0;
try {
  if (!(await up(`${BASE}/healthz`, 30_000))) throw new Error('server not up');
  const p = await launchPlayer({ baseUrl: BASE, name: 'Host', crew: 'AIHD', query: { aistatus: '1', preset: 'low', nobright: '1' } });
  try {
    await waitForGame(p.page, 60_000);
    await p.page.evaluate(() => (window as unknown as { __game: { join(c: string): Promise<void> } }).__game.join('AIHD'));
    const seen = await p.page.waitForFunction(() => document.body.innerText.includes('AI mock'), undefined, { timeout: 30_000, polling: 250 }).then(() => true, () => false);
    if (!seen) {
      await screenshot(p.page, 'tests/artifacts/ai/hud-fail.png');
      const diag = await p.page.evaluate(() => ({ text: document.body.innerText.slice(0, 400), st: JSON.stringify((window as unknown as { __game: { state(): unknown } }).__game.state()).slice(0, 400) }));
      throw new Error(`status line not shown; body: ${diag.text.split('\n').join(' / ')} state: ${diag.st}`);
    }
    // dismiss meta's one-time brightness check (a full-screen menu hides the HUD layer)
    await p.page.getByText('LOOKS RIGHT', { exact: false }).click({ timeout: 5000 }).catch(() => {});
    await p.page.waitForTimeout(1200);
    const a = await screenshot(p.page, 'tests/artifacts/ai/hud.png');
    // meta's one-time brightness overlay may cover the HUD: dispatch the click in the DOM
    await p.page.evaluate(() => (document.querySelector('[title^="AI / speech status"]') as HTMLElement | null)?.click());
    await p.page.waitForTimeout(600);
    const b = await screenshot(p.page, 'tests/artifacts/ai/hud-expanded.png');
    const text = await p.page.evaluate(() => document.body.innerText.split('\n').filter((l) => l.includes('AI mock') || l.includes('listener') || l.includes('stt:')).join(' | '));
    console.log(`hud text: ${text}`);
    console.log(`screenshots: ${a} ${b}`);
    const errs = p.errors.filter((e) => !e.includes('favicon'));
    if (errs.length) console.log(`page errors (${errs.length}): ${errs.slice(0, 5).join(' || ')}`);
  } finally {
    await p.close();
  }
} catch (e) {
  console.error('hud.e2e FAILED:', e instanceof Error ? e.message : e);
  code = 1;
} finally {
  server.kill();
}
process.exitCode = code;
setTimeout(() => process.exit(code), 500).unref();
