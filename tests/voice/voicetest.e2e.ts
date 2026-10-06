// Track ④ Voice: /voicetest page (phone viewport) joins a crew next to a game client and hears it.
//   node tests/voice/voicetest.e2e.ts   (BASE_URL default http://127.0.0.1:3004)
// Pages may be reloaded by Vite HMR (shared working tree): evaluations retry and the page auto-rejoins.
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { join } from 'node:path';
import { launchPlayer, screenshot, VOICE_DIR } from '../lib/launch.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3004';
const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';
const crew = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHA[b % ALPHA.length]).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, ok: boolean, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); };

async function ev<T>(page: Page, fn: () => T | Promise<T>, tries = 20): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      await page.waitForFunction(() => !!window.__voiceDebug, undefined, { timeout: 20_000 });
      return (await page.evaluate(fn)) as T;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(500);
    }
  }
}

/** poll until pred(value) or timeout; returns the last value */
async function until<T>(get: () => Promise<T>, pred: (v: T) => boolean, ms: number): Promise<T> {
  const t0 = Date.now();
  let v = await get();
  while (!pred(v) && Date.now() - t0 < ms) {
    await sleep(400);
    v = await get();
  }
  return v;
}

const game = await launchPlayer({ name: 'Gamer', wav: 'talk_en.wav', baseUrl: BASE, crew, query: { autojoin: '1' } });
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(VOICE_DIR, 'tone440.wav')}`, '--autoplay-policy=no-user-gesture-required'],
});
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.grantPermissions(['microphone']).catch(() => {});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // first: the manual flow (type the code, tap JOIN)
  await page.goto(`${BASE}/voicetest`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type=text]', { timeout: 20_000 });
  check('/voicetest serves the voice test page (no game canvas)', (await page.locator('#game').count()) === 0);
  await page.fill('input[type=text]', crew);
  await page.click('button');
  let ok = false;
  for (let i = 0; i < 90 && !ok; i++) {
    await sleep(500);
    ok = (await page.locator('.badge.direct, .badge.relay').count()) > 0;
  }
  check('voicetest peer connects to the game client (manual join)', ok, await page.locator('.badge').allTextContents().then((t) => t.join(',')));
  if (!ok) {
    const lg = (pg: Page) => pg.evaluate(() => (window.__voiceDebug as unknown as { logs(): string[] }).logs()).catch(() => []);
    console.log("voicetest logs", JSON.stringify(await lg(page)));
    console.log("game logs", JSON.stringify(await lg(game.page)));
    console.log("game peers", JSON.stringify(await game.page.evaluate(() => window.__voiceDebug!.peers()).catch(() => null)));
    console.log("vt state", JSON.stringify(await page.evaluate(() => ({ me: (window as unknown as { __vt?: unknown }).__vt, peers: window.__voiceDebug!.peers() })).catch(() => null)));
  }
  // from here on use the auto-join URL so an HMR reload re-joins by itself
  await page.goto(`${BASE}/voicetest?autojoin=1#${crew}`, { waitUntil: 'domcontentloaded' });
  const inRms = await until(
    () => ev(page, () => Math.max(0, ...Object.values((window.__voiceDebug as unknown as { inRms(): Record<string, number> }).inRms()))),
    (r) => r > 0.01, 20_000);
  check('voicetest hears the game client (incoming RMS > 0.01)', inRms > 0.01, `rms ${inRms.toFixed(4)}`);
  const out = await until(() => ev(page, () => Math.max(0, ...Object.values(window.__voiceDebug!.peers()).map((p) => Math.max(p.rmsL, p.rmsR)))), (r) => r > 0.01, 10_000);
  check('voicetest output is ungated (2D monitor) RMS > 0.01', out > 0.01, out.toFixed(4));
  const g = await until(() => ev(game.page, () => Math.max(0, ...Object.values(window.__voiceDebug!.peers()).filter((p) => p.state === 'connected').map((p) => Math.max(p.rmsL, p.rmsR)))), (r) => r > 0.005, 15_000);
  check('game client hears the voicetest peer (2D link-test route)', g > 0.005, g.toFixed(4));
  await sleep(500);
  console.log('screenshot', await screenshot(page, 'tests/artifacts/voice/voicetest-mobile.png'));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await game.close();
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exitCode = failed ? 1 : 0;
