// Owner: env-render (v1.3, 4e + SIGNAL). A page LOADED on Lite with the SIGNAL look (?preset=lite&signal=1: Lite's
// load-time parts too: noise-volume surfaces, low-poly halos, one shadowed slot) in ONE software-lane browser:
//   - the title menu (no crew hash: the bare title view over the static still, 3e)
//   - the site under a cover (render.hold), warmSite + the spawn-view warm-up, then the views: draws per pass,
//     pipelines per site, fragment program sizes, nothing compiled in the frame loop after the cover
//   - the biggest room with every beam lit: SIGNAL (pixelated, dithered, the bodycam OSD), then SIGNAL off
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/render/lite.e2e.ts --base http://127.0.0.1:3812 [--tag x]
// Result + shots: tests/artifacts/render/v13/lite-<tag>*.{json,png}. Exit 1: a crash, page errors, Lite not active,
// more than one shadowed beam, or a frame-loop compile after the cover.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { REPO, VOICE_DIR, waitForGame } from '../lib/launch.ts';
import { Bot, facilityViews, sleep } from '../gates/p-lib.ts';
import type { LayoutLite, View } from '../gates/p-lib.ts';
import { INSTALL, PROGRAM_STATS, draws, ev } from './lanelib.ts';

if (process.env.DEADAIR_RENDER !== 'swiftshader') throw new Error('run me through tools/gpu-guard.mjs (software lane only)');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3812').replace(/\/$/, '');
if (/:(3000|3100|20241)(\/|$)/.test(BASE)) throw new Error('refusing the live ports');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const TAG = arg('tag', 'v13');
const SEED = arg('seed', 'gp-6');
const BUDGET_SEC = Number(arg('budget', '112'));
const OUT = join(REPO, 'tests/artifacts/render/v13');
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const el = () => (performance.now() - T0) / 1000;
const left = () => BUDGET_SEC - el();
const log = (s: string) => console.log(`[lite ${el().toFixed(1).padStart(6)}s] ${s}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const R: Record<string, any> = { tag: TAG, seed: SEED, views: [], fails: [], notes: [] };
const save = () => writeFileSync(join(OUT, `lite-${TAG}.json`), JSON.stringify(R, null, 1));
const crew = `L${Math.random().toString(36).slice(2, 5).toUpperCase()}T`;
const shot = (page: import('playwright-core').Page, name: string) => page.screenshot({ path: join(OUT, `lite-${TAG}-${name}.png`) }).catch(() => null);

const bots = [new Bot('Beam1'), new Bot('Beam2')];
const botsReady = (async () => {
  await bots[0].connect(WS, crew);
  await bots[1].connect(WS, crew);
  await bots[0].dbg('net.validate', { on: false });
  await bots[0].dbg('level.generate', { seed: SEED, players: 3, risk: 1 });
  await bots[0].dbg('monsters.freeze', { on: true }).catch(() => {});
  await bots[0].dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => {});
  return ((await bots[0].req('level.get', {})) as { layout: LayoutLite }).layout;
})();

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
await page.addInitScript(() => { try { localStorage.removeItem('deadair.render.preset'); localStorage.setItem('deadair.name', 'LiteCam'); localStorage.setItem('deadair.meta.settings', JSON.stringify({ brightnessDone: true })); } catch { /* ignore */ } });
await page.goto(`${BASE}/?test=1&webgl=1&preset=lite&signal=1&autoq=0&nobright=1`, { waitUntil: 'domcontentloaded' });
let crashed = 0;
try {
  const L = await botsReady;
  await waitForGame(page, 60_000);
  log(`ready, install ${await ev(page, INSTALL)}`);
  await sleep(800);
  R.boot = { ...(await ev<Record<string, number>>(page, 'window.__bx.pipelines()')), menu: await ev(page, 'window.__game.state().diag.menuBackdrop ?? null').catch(() => null) };
  await shot(page, 'title');
  log(`boot (title): ${JSON.stringify(R.boot)}`);
  await ev(page, `(window.__bx.phase = 'cover', window.__render.v12().hold(true), 1)`);
  const before = await ev<Record<string, number>>(page, 'window.__bx.pipelines()');
  await ev(page, `window.__game.join(${JSON.stringify(crew)})`, 30_000);
  const views = facilityViews(L, 1, 1);
  const place = async (v: View, light = 1) => {
    await ev(page, `(window.__game.teleport(${v.x}, ${v.z}, ${v.yaw}), window.__game.look(${v.yaw}, ${v.pitch}), 1)`);
    v.bots.slice(0, 2).forEach((b, i) => { bots[i].target = { x: b.x, z: b.z, yaw: b.yaw, pitch: -0.08, light: light as 0 | 1, anim: 0 }; });
  };
  await place(views[0]);
  const tj = performance.now();
  for (;;) {
    const ok = await ev<boolean>(page, `(() => { const d = window.__levelDebug; const i = d && d.info(); return !!(i && i.kind === 'facility' && d.texturesReady()); })()`, 30_000).catch(() => false);
    if (ok || performance.now() - tj > 25_000) { R.facilityReady = ok; break; }
    await sleep(300);
  }
  await ev(page, '(window.__bx.refresh(), 1)');
  const tw = performance.now();
  R.warmSite = await ev(page, `window.__render.v12().warmSite(${Math.max(8000, Math.min(45_000, (left() - 45) * 1000))})`, 55_000).catch((e: Error) => ({ error: e.message }));
  R.warmSiteWallMs = Math.round(performance.now() - tw);
  R.siteWarmInfo = await ev(page, 'window.__render.siteWarm()').catch(() => null);
  await ev(page, 'window.__render.v12().warmup()', 30_000).catch(() => null);
  const afterWarm = await ev<Record<string, number>>(page, 'window.__bx.pipelines()');
  const coverLog = await ev<{ made: number; warm: boolean; ms: number }[]>(page, `window.__bx.log.filter((x) => x.phase === 'cover')`);
  R.cover = { sitePipelines: afterWarm.pipelines - before.pipelines, total: afterWarm, maxPerFrame: Math.max(0, ...coverLog.map((x) => x.made)), maxFrameMs: Math.max(0, ...coverLog.map((x) => x.ms)), outsideSiteWarm: coverLog.filter((x) => !x.warm).reduce((a, x) => a + x.made, 0) };
  R.programs = await ev(page, PROGRAM_STATS);
  log(`warmSite ${JSON.stringify(R.warmSite)} in ${R.warmSiteWallMs} ms; cover ${JSON.stringify(R.cover)}; fs programs ${JSON.stringify(R.programs)}`);
  save();
  await ev(page, `(window.__bx.phase = 'game', window.__render.v12().hold(false), 1)`);
  // your beam on (the flashlight input is a toggle; render's lit-beam list says where it is)
  for (let i = 0; i < 4; i++) {
    if (await ev<boolean>(page, 'window.__render.v12().beams().some((b) => b.local)')) break;
    await ev(page, '(window.__game.setInput({ flashlight: true }), 1)');
    await sleep(800);
  }
  for (const v of views) {
    if (left() < 30) { R.notes.push(`skipped view ${v.name} (time)`); break; }
    await place(v);
    await sleep(1100);
    R.views.push({ name: v.name, draws: await draws(page, 1300) });
    log(`${v.name}: ${JSON.stringify(R.views[R.views.length - 1].draws)}`);
  }
  const room = views.find((v) => v.name.startsWith('room')) ?? views[0];
  await place(room);
  await sleep(1200);
  const info = await ev<Record<string, unknown>>(page, 'window.__render.info()');
  R.info = { preset: info.preset, presetSource: info.presetSource, size: info.size, pipe: info.pipe, signal: info.signal, signalK: info.signalK, osd: info.osd, usedShadowed: info.usedShadowed, shadowRenders: info.shadowRenders, poolShadowed: info.poolShadowed, beams: await ev<number>(page, 'window.__render.v12().beams().length') };
  R.room = { name: room.name, signal: await draws(page, 1300) };
  await shot(page, 'room-signal');
  const viewsLog = await ev<{ made: number }[]>(page, `window.__bx.log.filter((x) => x.phase === 'game')`);
  R.afterCoverViews = viewsLog.reduce((a, x) => a + x.made, 0);
  await ev(page, `(window.__bx.phase = 'toggle', 1)`);
  if (left() > 14) {
    await ev(page, '(window.__render.v12().setSignalLook(false), 1)');
    await sleep(2500);
    R.room.plain = await draws(page, 1200);
    R.room.plainSize = (await ev<Record<string, unknown>>(page, 'window.__render.info()')).size;
    await shot(page, 'room-plain');
    await ev(page, '(window.__render.v12().setSignalLook(true), 1)');
  }
  const toggleLog = await ev<{ made: number }[]>(page, `window.__bx.log.filter((x) => x.phase === 'toggle')`);
  R.afterCover = { pipelinesCreated: R.afterCoverViews, signalToggles: toggleLog.reduce((a, x) => a + x.made, 0) };
  log(`room ${room.name}: ${JSON.stringify(R.room)}; info ${JSON.stringify(R.info)}; after cover ${JSON.stringify(R.afterCover)}`);
  if (R.info.preset !== 'lite' || !(R.info.pipe as { lite?: boolean } | null)?.lite) R.fails.push(`Lite not active: ${JSON.stringify(R.info)}`);
  if (Number(R.info.poolShadowed) !== 1) R.fails.push(`Lite loads one shadowed slot, got ${R.info.poolShadowed}`);
  if (R.afterCover.pipelinesCreated > 0) R.fails.push(`${R.afterCover.pipelinesCreated} pipelines compiled in the frame loop after the cover`);
  R.errors = [...errors, ...(await ev<string[]>(page, 'window.__game.errors()', 5000).catch(() => []))].slice(0, 20);
  if (R.errors.length) R.fails.push(`page errors: ${R.errors.slice(0, 3).join(' | ')}`);
} catch (e) {
  crashed++;
  R.crashed = String(e instanceof Error ? e.stack : e).slice(0, 1500);
  log(`CRASHED: ${R.crashed}`);
} finally {
  R.totalSec = +el().toFixed(1);
  save();
  for (const b of bots) b.close();
  await browser.close().catch(() => {});
  const failed = crashed > 0 || R.fails.length > 0;
  log(`${failed ? 'FAIL' : 'DONE'}: ${R.fails.join(' | ') || 'ok'} -> tests/artifacts/render/v13/lite-${TAG}.json`);
  process.exit(failed ? 1 : 0);
}
