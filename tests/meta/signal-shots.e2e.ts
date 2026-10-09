// Owner: track (d) Meta. v1.3 lane screenshots (SwiftShader WebGL2, preset low, one browser): the SIGNAL look toggle
// in both settings menus (the main menu's Settings panel and the pause menu's Settings tab): on with LOW, greyed out
// with a note on MEDIUM, the Lite reload note on LITE; then the Company Line's signed-deal line (capitalised offer).
// 1) server (outside the GPU guard): PORT=3804 NODE_ENV=development AI_MODE=mock SAVES_DIR=<scratch>/saves
//      SESSION_FILE=<scratch>/session.json ASSETS_DIR=<the staged assets folder> node apps/server/src/index.ts --dev
// 2) shots: node tools/gpu-guard.mjs --max-sec 120 -- node tests/meta/signal-shots.e2e.ts
//    Screenshots: tests/artifacts/meta/v13fix-*.png
import { launchPlayer } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import { freezeVite, shot, sleep } from './lib.ts';
import type { MetaState } from '../../packages/shared/src/messages/meta.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3804';
const CREW = process.env.CREW ?? 'CLSG';
const t0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
type W = {
  __meta?: { open(n: string, p?: unknown): void; close(): void; screen(): string; meta(): MetaState | null };
  __game?: { state(): { phase: string; net: string }; dbg(r: string, a?: unknown): Promise<unknown> };
  __render?: { info(): { preset: string; signal: boolean } };
};
const TOGGLE = '[data-testid="signal-toggle"]';

let player: Player | null = null;
const failed: string[] = [];
async function attempt(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    step(`${name} ok`);
  } catch (e) {
    failed.push(name);
    console.error(`${name} FAILED: ${e instanceof Error ? e.message.split(/\r?\n/)[0] : e}`);
    if (player) await shot(player.page, `v13fix-fail-${name}`).catch(() => {});
  }
}
let code = 0;
try {
  player = await launchPlayer({
    name: 'Ann', baseUrl: BASE, crew: CREW, webgl: true, viewport: { width: 1440, height: 900 },
    query: { preset: 'low', nobright: '1' },
    extraArgs: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = player.page;
  await page.addInitScript(() => {
    try { localStorage.setItem('deadair.meta.settings', JSON.stringify({ brightnessDone: true, hints: true })); } catch { /* ignore */ }
  });
  await freezeVite(page);
  const ev = page.evaluate.bind(page) as <R, A>(fn: (a: A) => R | Promise<R>, a: A) => Promise<R>;
  const info = () => ev(() => (window as unknown as W).__render?.info() ?? null, null);
  const toggleState = () => ev((sel: string) => {
    const el = document.querySelector(sel) as HTMLInputElement | null;
    const row = el?.closest('.m-set');
    return el ? { checked: el.checked, disabled: el.disabled, note: row?.textContent ?? '' } : null;
  }, TOGGLE);
  const preset = async (p: string) => {
    await page.selectOption('[data-testid="preset-select"]', p);
    await page.waitForFunction((want) => (window as unknown as W).__render?.info().preset === want, p, { timeout: 20_000, polling: 200 });
    await sleep(600);
  };
  /** the title panel scrolls under its header: show the Video rows (preset, Lite note, SIGNAL) in the shot */
  const panelTop = () => ev(() => { const b = document.querySelector('[data-testid="menu-panel-settings"] .mm-panel-body'); if (b) b.scrollTop = 0; }, null);

  // ---------------------------------------------------------------- the main menu's Settings panel
  await page.waitForSelector('[data-testid="main-menu"]', { timeout: 60_000 });
  await page.waitForFunction(() => !!(window as unknown as W).__render, undefined, { timeout: 60_000, polling: 250 });
  step(`main menu (render ${JSON.stringify(await info())})`);
  await attempt('title-signal', async () => {
    await page.click('[data-testid="menu-settings"]');
    await page.waitForSelector(`[data-testid="menu-panel-settings"] ${TOGGLE}`, { timeout: 10_000 });
    const before = await toggleState();
    if (!before || before.disabled || before.checked) throw new Error(`toggle on LOW, before: ${JSON.stringify(before)}`);
    if (!(await page.$('[data-testid="lite-note"]'))) throw new Error('no Lite note');
    await page.click(TOGGLE);
    await page.waitForFunction(() => (window as unknown as W).__render?.info().signal === true, undefined, { timeout: 15_000, polling: 200 });
    await sleep(800);
    console.log(`title, LOW: toggle ${JSON.stringify(await toggleState())}`);
    await panelTop();
    await shot(page, 'v13fix-title-settings-signal');
  });
  await attempt('title-medium', async () => {
    await preset('medium');
    const st = await toggleState();
    if (!st || !st.disabled || !st.checked || !/LITE and LOW presets only \(now MEDIUM\)/.test(st.note)) throw new Error(`toggle on MEDIUM: ${JSON.stringify(st)}`);
    if ((await info())?.signal !== false) throw new Error('SIGNAL active on MEDIUM');
    console.log(`title, MEDIUM: toggle ${JSON.stringify(st)}`);
    await panelTop();
    await shot(page, 'v13fix-title-settings-medium');
  });
  await attempt('title-lite', async () => {
    await preset('lite');
    const st = await toggleState();
    if (!st || st.disabled || !st.checked) throw new Error(`toggle on LITE: ${JSON.stringify(st)}`);
    const note = await ev(() => { const n = document.querySelector('[data-testid="lite-note"] span.m-small'); return n ? { text: n.textContent, amber: n.classList.contains('m-amber') } : null; }, null);
    if (!note?.amber) throw new Error(`the Lite note after picking LITE: ${JSON.stringify(note)}`);
    console.log(`title, LITE: toggle ${JSON.stringify(st)}, note ${JSON.stringify(note)}, signal ${(await info())?.signal}`);
    await panelTop();
    await shot(page, 'v13fix-title-settings-lite');
    await preset('low');
  });

  // ---------------------------------------------------------------- the van: the pause menu's Settings tab
  await page.goto(`${BASE}/?test=1&webgl=1&preset=low&nobright=1&autojoin=1#${CREW}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as unknown as W).__game?.state().net === 'joined' && (window as unknown as W).__game?.state().phase === 'hub', undefined, { timeout: 60_000, polling: 250 });
  await page.waitForFunction(() => (window as unknown as W).__meta?.screen() === 'none', undefined, { timeout: 30_000, polling: 250 });
  step('joined the van');
  await sleep(1500);
  await attempt('pause-signal', async () => {
    await ev(() => (window as unknown as W).__meta!.open('menu', { tab: 'settings' }), null);
    await page.waitForSelector(TOGGLE, { timeout: 8_000 });
    const st = await toggleState();
    // render stored the toggle: still on after the reload, active on LOW
    if (!st || st.disabled || !st.checked) throw new Error(`pause menu toggle: ${JSON.stringify(st)}`);
    if ((await info())?.signal !== true) throw new Error('SIGNAL not active in the van');
    console.log(`pause menu, LOW: toggle ${JSON.stringify(st)}`);
    await sleep(600);
    await shot(page, 'v13fix-pause-settings-signal');
    await page.click(TOGGLE);
    await page.waitForFunction(() => (window as unknown as W).__render?.info().signal === false, undefined, { timeout: 15_000, polling: 200 });
    await ev(() => (window as unknown as W).__meta!.close(), null);
  });

  // ---------------------------------------------------------------- the Company Line: the signed-deal line
  await attempt('signed', async () => {
    await ev(async () => { await (window as unknown as W).__game!.dbg('setFlags', { set: { companyLine: true } }); }, null);
    await ev(async () => { await (window as unknown as W).__game!.dbg('meta.phoneRing', {}); }, null);
    await page.waitForSelector('[data-testid="phone-hud"][data-state="ringing"]', { timeout: 10_000 });
    await page.keyboard.press('KeyP');
    await page.waitForSelector('[data-testid="phone-screen"][data-state="active"]', { timeout: 8_000 });
    await page.fill('[data-testid="phone-input"]', 'We are new here, Dale. Give us a chance.');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as unknown as W).__meta?.meta()?.call?.offer.quotaPct === 0, undefined, { timeout: 8_000, polling: 150 });
    await sleep(500);
    await page.click('[data-testid="phone-sign"]');
    await page.waitForSelector('[data-testid="phone-screen"][data-state="ended"]', { timeout: 6_000 });
    const lines = await ev(() => ((window as unknown as W).__meta?.meta()?.call?.lines ?? []).filter((l) => l.who === 'dale').map((l) => l.text), null);
    const close = lines[lines.length - 1] ?? '';
    console.log(`Dale's signed-deal line: ${close}`);
    if (!/(?:^|[.!?] )Quota ±0%/.test(close) || /(?:^|(?<!\.)[.!?]\s+)\p{Ll}/u.test(close)) throw new Error(`the signed line: ${close}`);
    await sleep(700);
    await shot(page, 'v13fix-cl-signed');
  });
  const errs = player.errors.filter((e) => !/favicon|ERR_ABORTED|net::|WebGPU|GPU stall|404/.test(e)).slice(0, 8);
  if (errs.length) console.log(`page errors:\n  ${errs.join('\n  ')}`);
  if (failed.length) code = 1;
  console.log(`V13FIX SHOTS ${failed.length ? `FAILED (${failed.join(', ')})` : 'PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
} catch (e) {
  code = 1;
  console.error('V13FIX SHOTS FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
  if (player) await shot(player.page, 'v13fix-fail-fatal').catch(() => {});
} finally {
  await player?.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
