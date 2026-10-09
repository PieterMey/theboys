// Owner: track (d) Meta. v1.3 lane screenshots (SwiftShader WebGL2, preset low, one browser): the Company Line (F5:
// ringing HUD, the call screen with typed lines, the signed term sheet, the van HUD after the deal, the board with
// conditions + hazard pay), the settings' AUTO (detected: X) preset entry (P6) and the drive screen's house-rule strip
// with the board chip (F7, crew CLKA's first board has Varga Brothers Foundry on a Risk 1 order).
// 1) server (outside the GPU guard): PORT=3804 NODE_ENV=development AI_MODE=mock SAVES_DIR=<scratch>/saves
//      SESSION_FILE=<scratch>/session.json ASSETS_DIR=C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage
//      node apps/server/src/index.ts --dev
// 2) shots: node tools/gpu-guard.mjs --max-sec 120 -- node tests/meta/companyline-shots.e2e.ts
//    Screenshots: tests/artifacts/meta/v13-*.png
import { launchPlayer } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import { freezeVite, shot, sleep } from './lib.ts';
import type { MetaState } from '../../packages/shared/src/messages/meta.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3804';
const CREW = process.env.CREW ?? 'CLKA';
const t0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
type W = {
  __meta?: { open(n: string, p?: unknown): void; close(): void; screen(): string; meta(): MetaState | null };
  __game?: { state(): { phase: string; net: string }; dbg(r: string, a?: unknown): Promise<unknown>; req?(r: string, a?: unknown): Promise<unknown>; me(): string | null };
};

let player: Player | null = null;
const failed: string[] = [];
async function attempt(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    step(`${name} ok`);
  } catch (e) {
    failed.push(name);
    console.error(`${name} FAILED: ${e instanceof Error ? e.message.split(/\r?\n/)[0] : e}`);
    if (player) await shot(player.page, `v13-fail-${name}`).catch(() => {});
  }
}
let code = 0;
try {
  player = await launchPlayer({
    name: 'Ann', baseUrl: BASE, crew: CREW, webgl: true, viewport: { width: 1440, height: 900 },
    query: { preset: 'low', nobright: '1', autojoin: '1' },
    extraArgs: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = player.page;
  await page.addInitScript(() => {
    try { localStorage.setItem('deadair.meta.settings', JSON.stringify({ brightnessDone: true, hints: true })); } catch { /* ignore */ }
  });
  await freezeVite(page);
  await page.waitForFunction(() => (window as unknown as W).__game?.state().net === 'joined' && (window as unknown as W).__game?.state().phase === 'hub', undefined, { timeout: 60_000, polling: 250 });
  step('joined the van');
  const ev = page.evaluate.bind(page) as <R, A>(fn: (a: A) => R | Promise<R>, a: A) => Promise<R>;
  await ev(async () => { await (window as unknown as W).__game!.dbg('setFlags', { set: { companyLine: true, siteRules: true } }); }, null);
  // the van HUD and the level need a moment in SwiftShader
  await page.waitForFunction(() => (window as unknown as W).__meta?.screen() === 'none', undefined, { timeout: 30_000, polling: 250 });
  await sleep(1500);

  // ---------------------------------------------------------------- F5: ring -> answer -> lines -> sign
  await attempt('ring', async () => {
    await ev(async () => { await (window as unknown as W).__game!.dbg('meta.phoneRing', {}); }, null);
    await page.waitForSelector('[data-testid="phone-hud"][data-state="ringing"]', { timeout: 10_000 });
    await sleep(900);
    await shot(page, 'v13-cl-ringing');
  });
  await attempt('call', async () => {
    await page.keyboard.press('KeyP');
    await page.waitForSelector('[data-testid="phone-screen"][data-state="active"]', { timeout: 8_000 });
    await page.waitForSelector('[data-testid="phone-input"]', { timeout: 5_000 });
    /** type a line, Enter, wait for the host's offer to move ('zero' = quota at today's level, 'bonus' = hazard pay) */
    const say = async (text: string, want: 'zero' | 'bonus') => {
      await page.fill('[data-testid="phone-input"]', text);
      await page.keyboard.press('Enter');
      await page.waitForFunction((w) => {
        const c = (window as unknown as W).__meta?.meta()?.call;
        return !!c && (w === 'zero' ? c.offer.quotaPct === 0 : c.offer.bonus > 0);
      }, want, { timeout: 8_000, polling: 150 });
    };
    await say('We are new here, Dale. Give us a chance.', 'zero');
    await sleep(4300);
    await say('Hazard pay and we take a harder site.', 'bonus');
    await sleep(900);
    await shot(page, 'v13-cl-call');
  });
  await attempt('signed', async () => {
    await page.click('[data-testid="phone-sign"]');
    await page.waitForSelector('[data-testid="phone-screen"][data-state="ended"]', { timeout: 6_000 });
    await sleep(700);
    await shot(page, 'v13-cl-signed');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="phone-hud"][data-state="ended"]', { timeout: 6_000 });
    await page.waitForSelector('[data-testid="hub-deal"]', { timeout: 6_000 });
    await sleep(500);
    await shot(page, 'v13-cl-hud-deal');
  });

  // ---------------------------------------------------------------- board: conditions, hazard pay, the house-rule chip
  await attempt('board', async () => {
    await ev(() => (window as unknown as W).__meta!.open('board'), null);
    await page.waitForSelector('[data-testid="order-house-rule"]', { timeout: 6_000 });
    await sleep(800);
    await shot(page, 'v13-board-terms');
    await ev(() => (window as unknown as W).__meta!.close(), null);
  });

  // ---------------------------------------------------------------- P6: settings preset entry
  await attempt('settings', async () => {
    await ev(() => (window as unknown as W).__meta!.open('menu', { tab: 'settings' }), null);
    await page.waitForSelector('[data-testid="preset-select"]', { timeout: 6_000 });
    const opts = await ev(() => [...document.querySelectorAll('[data-testid="preset-select"] option')].map((o) => o.textContent ?? ''), null);
    const value = await ev(() => (document.querySelector('[data-testid="preset-select"]') as HTMLSelectElement | null)?.value ?? '', null);
    console.log(`preset options: ${JSON.stringify(opts)} (selected ${value})`);
    if (!/^AUTO \(detected: [A-Z]+\)$/.test(opts[0] ?? '')) throw new Error(`first option is ${opts[0]}`);
    await sleep(500);
    await shot(page, 'v13-p6-settings');
    await ev(() => (window as unknown as W).__meta!.close(), null);
  });

  // ---------------------------------------------------------------- F7: drive to the house-rule site
  await attempt('drive', async () => {
    const meta = await ev(() => (window as unknown as W).__meta!.meta(), null);
    const rules = meta?.siteRules ?? {};
    const id = Object.keys(rules)[0];
    if (!id) throw new Error('no house-rule order on the board');
    await ev(async (oid: string) => {
      const g = (window as unknown as W).__game!;
      await g.req?.('meta.pick', { orderId: oid });
      await g.req?.('meta.ready', { ready: true });
    }, id);
    await page.waitForSelector('[data-testid="drive-house-rule"]', { timeout: 15_000 });
    await sleep(2200);
    await shot(page, 'v13-f7-drive');
  });
  const errs = player.errors.filter((e) => !/favicon|ERR_ABORTED|net::|WebGPU|GPU stall|404/.test(e)).slice(0, 8);
  if (errs.length) console.log(`page errors:\n  ${errs.join('\n  ')}`);
  if (failed.length) code = 1;
  console.log(`V13 SHOTS ${failed.length ? `FAILED (${failed.join(', ')})` : 'PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
} catch (e) {
  code = 1;
  console.error('V13 SHOTS FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
  if (player) await shot(player.page, 'v13-fail-fatal').catch(() => {});
} finally {
  await player?.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
