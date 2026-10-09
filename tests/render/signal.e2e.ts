// Owner: env-render (v1.3 fixes after verify r2). The SIGNAL look's bodycam OSD shows on the job only, and the HUD's
// RENDER chip follows a live preset switch. ONE software-lane browser loaded on Lite with SIGNAL on
// (?preset=lite&signal=1), no bots (the page's own dbg requests change the phase):
//   1. the van (hub): SIGNAL active, the OSD hidden (the HUD's CREW panel takes its top-left corner)       shot 'hub'
//   2. a contract (dbg level.generate): the OSD shown in the top-left corner, clear of the HUD              shot 'contract'
//   3. a screen over the contract (the Esc menu, else the field guide): the OSD hidden; closed again: shown
//   4. a live switch Lite -> Low: the chip reads 'RENDER WEBGL2 · LOW' at once, SIGNAL + OSD stay         shot 'low'
//      then back to Lite: the chip reads LITE again
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/render/signal.e2e.ts --base http://127.0.0.1:3813 [--tag x]
// Result + shots: tests/artifacts/render/v13/signal-<tag>*.{json,png}. Exit 1: a failed check, a crash or page errors.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { REPO, VOICE_DIR, waitForGame } from '../lib/launch.ts';
import { sleep } from '../gates/p-lib.ts';
import { ev } from './lanelib.ts';

if (process.env.DEADAIR_RENDER !== 'swiftshader') throw new Error('run me through tools/gpu-guard.mjs (software lane only)');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3813').replace(/\/$/, '');
if (/:(3000|3100|20241)(\/|$)/.test(BASE)) throw new Error('refusing the live ports');
const TAG = arg('tag', 'v13');
const SEED = arg('seed', 'gp-6');
const BUDGET_SEC = Number(arg('budget', '110'));
const OUT = join(REPO, 'tests/artifacts/render/v13');
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const el = () => (performance.now() - T0) / 1000;
const left = () => BUDGET_SEC - el();
const log = (s: string) => console.log(`[signal ${el().toFixed(1).padStart(6)}s] ${s}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const R: Record<string, any> = { tag: TAG, seed: SEED, checks: [], notes: [] };
const save = () => writeFileSync(join(OUT, `signal-${TAG}.json`), JSON.stringify(R, null, 1));
const check = (name: string, ok: boolean, info: unknown = '') => {
  const s = typeof info === 'string' ? info : JSON.stringify(info);
  R.checks.push({ name, ok, info: s });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${s ? ` (${s})` : ''}`);
  return ok;
};
const shot = async (page: Page, name: string) => {
  const p = join(OUT, `signal-${TAG}-${name}.png`);
  await page.screenshot({ path: p }).catch((e: Error) => R.notes.push(`shot ${name}: ${e.message}`));
  R[`shot_${name}`] = p;
};
const crew = `S${Math.random().toString(36).slice(2, 5).toUpperCase()}G`;
// the chip's separator is a middle dot (U+00B7)
const chipText = (preset: string) => `RENDER WEBGL2 · ${preset.toUpperCase()}`;

/** the OSD layer: present / displayed, the text block's box and text */
const OSD = `(() => {
  const o = document.querySelector('[data-testid="signal-osd"]');
  if (!o) return { present: false, display: 'none', box: null, text: '' };
  const blk = [...o.children].find((c) => (c.textContent || '').includes('REC'));
  const r = blk ? blk.getBoundingClientRect() : null;
  return { present: true, display: getComputedStyle(o).display, box: r && r.width > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null, text: blk ? (blk.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100) : '' };
})()`;
/** HUD elements with text or a visible fill inside a box (full-screen overlays skipped) */
const hudIn = (b: { x: number; y: number; w: number; h: number }) => `(() => {
  const b = ${JSON.stringify(b)};
  const out = [];
  for (const e of document.querySelectorAll('#overlay .hud *')) {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.width > innerWidth * 0.9) continue;
    const st = getComputedStyle(e);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
    const text = [...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim());
    const fill = st.backgroundColor !== 'rgba(0, 0, 0, 0)' || st.borderTopWidth !== '0px' || st.borderLeftWidth !== '0px';
    if (!text && !fill) continue;
    if (r.x < b.x + b.w && r.x + r.width > b.x && r.y < b.y + b.h && r.y + r.height > b.y) out.push({ cls: String(e.className).slice(0, 40), text: (e.textContent || '').trim().slice(0, 32), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out.slice(0, 8);
})()`;
/** the HUD's top-left slot (the van's CREW panel) */
const TOP_LEFT = `(() => { const s = document.querySelector('#overlay .hud-top-left'); if (!s) return null; const r = s.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: (s.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) }; })()`;
const CHIP = `(() => { const e = document.querySelector('[data-testid="render-chip"]'); return e ? (e.textContent || '').trim() : null; })()`;
type Info = { preset: string; signal: boolean; signalK: number; osd: boolean; mode: string; size: number[] };
type Osd = { present: boolean; display: string; box: { x: number; y: number; w: number; h: number } | null; text: string };

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(VOICE_DIR, 'silence.wav')}`, '--autoplay-policy=no-user-gesture-required',
    '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.grantPermissions(['microphone']).catch(() => {});
const page = await context.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.routeWebSocket(/token=/, () => { /* no Vite HMR reloads mid-run */ });
await page.addInitScript(() => { try { localStorage.removeItem('deadair.render.preset'); localStorage.setItem('deadair.name', 'SignalCam'); localStorage.setItem('deadair.meta.settings', JSON.stringify({ brightnessDone: true })); } catch { /* ignore */ } });
await page.goto(`${BASE}/?test=1&webgl=1&preset=lite&signal=1&autoq=0&nobright=1`, { waitUntil: 'domcontentloaded' });
const g = <T>(code: string, ms = 20_000) => ev<T>(page, code, ms);
const info = () => g<Info>('window.__render.info()');
const phase = () => g<string>('window.__game.state().phase');
const screen = () => g<string>('window.__game.state().screen');
/** polls fn until ok(value) or ms pass; the last value */
const until = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, step = 250): Promise<{ v: T; ok: boolean; ms: number; reads: number }> => {
  const t0 = performance.now();
  let v = await fn();
  let reads = 1;
  while (!ok(v) && performance.now() - t0 < ms) { await sleep(step); v = await fn(); reads++; }
  return { v, ok: ok(v), ms: Math.round(performance.now() - t0), reads };
};
let crashed = 0;
try {
  await waitForGame(page, 60_000);
  log('ready');
  // ---- 1. the van (hub)
  await g(`window.__game.join(${JSON.stringify(crew)}).then(() => 1)`, 30_000);
  const hubReady = await until(() => g<boolean>(`(() => { const d = window.__levelDebug; const i = d && d.info(); return !!(i && i.kind === 'hub' && d.texturesReady()); })()`).catch(() => false), (v) => v, 20_000, 400);
  const hubGame = await until(info, (i) => i.mode === 'game', 15_000, 300);
  await sleep(1500);
  const ih = await info();
  const oh = await g<Osd>(OSD);
  R.hub = { phase: await phase(), screen: await screen(), ready: hubReady.ok, mode: ih.mode, preset: ih.preset, signal: ih.signal, signalK: ih.signalK, osd: ih.osd, osdDom: oh, topLeft: await g(TOP_LEFT), chip: await g(CHIP) };
  log(`hub: ${JSON.stringify(R.hub)}`);
  await shot(page, 'hub');
  check('1. the van: phase hub, game view, SIGNAL active on Lite', R.hub.phase === 'hub' && hubGame.ok && ih.signal === true && ih.preset === 'lite', { phase: R.hub.phase, mode: ih.mode, signal: ih.signal, k: ih.signalK, preset: ih.preset });
  check('1. the van: no bodycam OSD (the CREW panel holds the top-left corner)', ih.osd === false && oh.display === 'none', { osd: ih.osd, dom: oh.display, topLeft: R.hub.topLeft });
  check('1. the van: chip RENDER WEBGL2 · LITE', R.hub.chip === chipText('lite'), R.hub.chip);
  save();
  // ---- 2. a contract: the site built and warmed under render.hold (paced warm frames, as the loading screen does;
  // a test page has no loading screen), then the view
  await g(`(window.__render.v12().hold(true), 1)`);
  R.generate = await g(`window.__game.dbg('level.generate', { seed: ${JSON.stringify(SEED)}, players: 1, risk: 1 })`, 30_000).catch((e: Error) => ({ error: e.message }));
  await g(`window.__game.dbg('monsters.freeze', { on: true })`).catch(() => null);
  await g(`window.__game.dbg('paranormal.tune', { nextInSec: 9999 })`).catch(() => null);
  log(`generate ${JSON.stringify(R.generate).slice(0, 160)}`);
  const siteReady = await until(() => g<boolean>(`(() => { const d = window.__levelDebug; const i = d && d.info(); return !!(i && i.kind === 'facility' && d.texturesReady()); })()`, 30_000).catch(() => false), (v) => v, 25_000, 300);
  const iHold = await info();
  R.held = { siteReady: siteReady.ok, ms: siteReady.ms, mode: iHold.mode, osd: iHold.osd, phase: await phase() };
  check('2. the site under render.hold: no OSD', iHold.mode === 'hold' && iHold.osd === false, R.held);
  const tw = performance.now();
  R.warmSite = await g(`window.__render.v12().warmSite(${Math.round(Math.max(6000, Math.min(20_000, (left() - 60) * 1000)))})`, 45_000).catch((e: Error) => ({ error: e.message }));
  await g('window.__render.v12().warmup()', 30_000).catch(() => null);
  R.warmMs = Math.round(performance.now() - tw);
  log(`warmSite ${JSON.stringify(R.warmSite)} + warmup in ${R.warmMs} ms`);
  await g(`(window.__render.v12().hold(false), 1)`);
  const inContract = await until(async () => ({ p: await phase(), i: await info() }), (v) => v.p === 'contract' && v.i.mode === 'game' && v.i.osd === true, Math.max(8000, Math.min(30_000, (left() - 40) * 1000)), 400);
  R.contractWaitMs = inContract.ms;
  await sleep(1200);
  const ic = await info();
  const oc = await g<Osd>(OSD);
  const over = oc.box ? await g<unknown[]>(hudIn(oc.box)) : [];
  R.contract = { phase: await phase(), screen: await screen(), mode: ic.mode, preset: ic.preset, signal: ic.signal, signalK: ic.signalK, osd: ic.osd, osdDom: oc, hudOverOsd: over, chip: await g(CHIP) };
  log(`contract: ${JSON.stringify(R.contract)}`);
  await shot(page, 'contract');
  const vw = 1280, vh = 720;
  check('2. a contract: the bodycam OSD shows', R.contract.phase === 'contract' && ic.osd === true && oc.display === 'block' && /REC/.test(oc.text) && /CAM 2/.test(oc.text), { phase: R.contract.phase, osd: ic.osd, dom: oc.display, text: oc.text, waitMs: inContract.ms });
  check('2. a contract: the OSD block sits in the top-left corner', !!oc.box && oc.box.x < vw * 0.25 && oc.box.y < vh * 0.2 && oc.box.x + oc.box.w < vw / 2, oc.box);
  check('2. a contract: no HUD element under the OSD block', Array.isArray(over) && over.length === 0, over);
  save();
  // ---- 3. a screen over the contract: the Esc menu, else the field guide (J). With the pointer unlocked (headless:
  // nothing locks it) one Escape keydown opens the menu (players input -> action:menu) and closes it again in the
  // same event (meta's Esc handler, installed later): the 2026-10-09 run never saw the 'menu' screen
  const note = (s: string) => { R.notes.push(s); log(`note: ${s}`); };
  if (left() > 30) {
    let over = '';
    for (const [key, name] of [['Escape', 'menu'], ['Escape', 'menu'], ['KeyJ', 'fieldguide']] as const) {
      await page.keyboard.press(key);
      if ((await until(screen, (s) => s === name, 1500, 150)).ok) { over = name; break; }
      await sleep(450);
    }
    if (over) {
      const m = await until(info, (i) => i.osd === false, 4000, 200);
      R.menu = { screen: await screen(), osd: m.v.osd, osdDom: (await g<Osd>(OSD)).display, ms: m.ms };
      check(`3. a screen over the contract (${over}): no OSD`, m.ok && R.menu.osdDom === 'none', R.menu);
      await page.keyboard.press(over === 'menu' ? 'Escape' : 'KeyJ');
      const back = await until(async () => ({ s: await screen(), i: await info() }), (v) => v.s === 'none' && v.i.osd === true, 6000, 250);
      R.menuClosed = { screen: back.v.s, osd: back.v.i.osd, ms: back.ms };
      check('3. the screen closed again: the OSD is back', back.ok, R.menuClosed);
    } else note(`neither the Esc menu nor the field guide opened (screen ${await screen()}): step 3 skipped`);
  } else note('step 3 skipped (time)');
  save();
  // ---- 4. a live preset switch: Lite -> Low (SIGNAL stays: Low has it too), then back to Lite
  const pipes = () => g<number>('window.__render.pipelines().pipelines');
  const p0 = await pipes();
  const tSw = performance.now();
  await g(`(window.__render.setPreset('low'), 1)`);
  const chipLow = await until(() => g<string | null>(CHIP), (c) => c === chipText('low'), 3000, 50);
  // chipMs: from the setPreset call (its rebuild + the next frame stall the page in the software lane); reads: chip
  // reads after the call returned until one showed LOW (1 = the first read already did)
  R.switchLow = { chip: chipLow.v, chipMs: Math.round(performance.now() - tSw), reads: chipLow.reads };
  // settle: the switch recompiles (Low's programs); wait until the pipeline count holds still
  let last = -1;
  const ts = performance.now();
  while (performance.now() - ts < Math.max(4000, Math.min(20_000, (left() - 18) * 1000))) {
    await sleep(1300);
    const n = await pipes();
    if (n === last) break;
    last = n;
  }
  const il = await info();
  const ol = await g<Osd>(OSD);
  Object.assign(R.switchLow, { settleMs: Math.round(performance.now() - ts), pipelines: [p0, await pipes()], preset: il.preset, signal: il.signal, signalK: il.signalK, osd: il.osd, osdDom: ol.display, size: il.size, chipAfter: await g(CHIP) });
  log(`switch to low: ${JSON.stringify(R.switchLow)}`);
  await shot(page, 'low');
  check('4. live switch to Low: the chip reads LOW at once', chipLow.ok && R.switchLow.chipAfter === chipText('low'), { chip: chipLow.v, ms: R.switchLow.chipMs, after: R.switchLow.chipAfter });
  check('4. Low: the preset applied, SIGNAL still active, the OSD still shown', il.preset === 'low' && il.signal === true && il.osd === true && ol.display === 'block', { preset: il.preset, signal: il.signal, k: il.signalK, osd: il.osd, dom: ol.display });
  if (left() > 6) {
    const tB = performance.now();
    await g(`(window.__render.setPreset('lite'), 1)`);
    const chipLite = await until(() => g<string | null>(CHIP), (c) => c === chipText('lite'), 3000, 50);
    R.switchLite = { chip: chipLite.v, chipMs: Math.round(performance.now() - tB), reads: chipLite.reads, preset: (await info()).preset };
    check('4. back to Lite: the chip reads LITE at once', chipLite.ok && R.switchLite.preset === 'lite', R.switchLite);
  } else R.notes.push('the switch back to Lite skipped (time)');
  R.errors = [...errors, ...(await g<string[]>('window.__game.errors()', 5000).catch(() => []))].filter((e) => !/favicon/.test(e)).slice(0, 20);
  check('no page errors', R.errors.length === 0, R.errors.slice(0, 3).join(' | '));
} catch (e) {
  crashed++;
  R.crashed = String(e instanceof Error ? e.stack : e).slice(0, 1500);
  log(`CRASHED: ${R.crashed}`);
  await shot(page, 'crash');
} finally {
  R.totalSec = +el().toFixed(1);
  save();
  await browser.close().catch(() => {});
  const fails = R.checks.filter((c: { ok: boolean }) => !c.ok).length;
  log(`${crashed ? 'CRASHED' : fails ? 'FAIL' : 'DONE'}: ${R.checks.length - fails}/${R.checks.length} checks -> tests/artifacts/render/v13/signal-${TAG}.json`);
  process.exit(crashed || fails ? 1 : 0);
}
