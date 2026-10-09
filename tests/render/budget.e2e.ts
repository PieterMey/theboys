// Owner: env-render (v1.3). The Low render BUDGET gate in ONE software-lane browser (WebGL2, preset Low; COUNTS and
// JS timings are meaningful there, GPU time is not). Built from the gfx-pipeline research harness (run2x):
//   - boot: pipelines compiled at the title menu (3e: no live 3D backdrop on Low / WebGL2)
//   - the site arrives under a cover (render.hold: only warm frames may draw, 2c), warmSite + the spawn-view warm-up
//     run under it; then the cover drops and the views are walked: NO frame-loop compile after the cover (budget 0)
//   - pipelines per site (after the warm - before the join) <= 120; warmSite per-frame caps (3c)
//   - draws per frame at the biggest room with 3 beams on: Low <= 140 (4a-4c)
//   - every beam off: 0 shadow draws (4a); the beams' light-list changes compile nothing (4b)
//   - the scene pass writes no velocity on Low (4c); the welcome re-apply of a stored preset rebuilds nothing (3d)
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/render/budget.e2e.ts --base http://127.0.0.1:3812 [--tag x]
//     [--report-only 1]   (a baseline server: print the numbers, never fail)
//     [--strict 1]        (also fail on the draw budget with lit beams: Low <= 140 draws then needs the Phase C content
//                          consolidation; until then it is reported, and the dark-beam frame must meet it)
//     [--looks 1]         (afterwards, time permitting: Low / Lite / Lite + SIGNAL screenshots + counts, live switch)
// The bots create the crew + the facility (dbg level.generate) before the browser joins. Result:
// tests/artifacts/render/v13/budget-<tag>.json. Exit 1 = a budget missed (unless --report-only), page errors or a crash.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { REPO, VOICE_DIR, waitForGame } from '../lib/launch.ts';
import { Bot, facilityViews, sleep } from '../gates/p-lib.ts';
import { INSTALL, draws, ev, q } from './lanelib.ts';
import type { LayoutLite, View } from '../gates/p-lib.ts';

if (process.env.DEADAIR_RENDER !== 'swiftshader') throw new Error('run me through tools/gpu-guard.mjs (software lane only)');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3812').replace(/\/$/, '');
if (/:(3000|3100|20241)(\/|$)/.test(BASE)) throw new Error('refusing the live ports');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const TAG = arg('tag', 'v13');
const SEED = arg('seed', 'gp-6');
const PLAYERS = Number(arg('players', '3'));
const REPORT_ONLY = arg('report-only', '0') === '1';
const STRICT = arg('strict', '0') === '1';
const LOOKS = arg('looks', '1') === '1';
const BUDGET_SEC = Number(arg('budget', '114'));
const LIMITS = { draws: 140, sitePipelines: 120, afterCover: 0, shadowOff: 0, flat: 0 };
const OUT = join(REPO, 'tests/artifacts/render/v13');
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const el = () => (performance.now() - T0) / 1000;
const left = () => BUDGET_SEC - el();
const log = (s: string) => console.log(`[budget ${el().toFixed(1).padStart(6)}s] ${s}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const R: Record<string, any> = { tag: TAG, seed: SEED, players: PLAYERS, base: BASE, views: [], fails: [], notes: [] };
const save = () => writeFileSync(join(OUT, `budget-${TAG}.json`), JSON.stringify(R, null, 1));
const crew = `B${Math.random().toString(36).slice(2, 5).toUpperCase()}T`;

const INIT = () => {
  // the stored choice of a player who picked Low in the settings (3d: the welcome re-apply must rebuild nothing)
  try {
    localStorage.setItem('deadair.render.preset', 'low');
    localStorage.setItem('deadair.meta.settings', JSON.stringify({ preset: 'low', brightnessDone: true }));
    localStorage.setItem('deadair.name', 'BudgetCam');
  } catch { /* ignore */ }
};

const fail = (msg: string) => { R.fails.push(msg); log(`BUDGET MISSED: ${msg}`); };

const bots = [new Bot('Beam1'), new Bot('Beam2')];
const botsReady = (async () => {
  await bots[0].connect(WS, crew);
  await bots[1].connect(WS, crew);
  await bots[0].dbg('net.validate', { on: false });
  const g = await bots[0].dbg<{ hash: string; theme?: string }>('level.generate', { seed: SEED, players: PLAYERS, risk: 1 });
  R.layout = { hash: g.hash, theme: g.theme ?? null };
  await bots[0].dbg('monsters.freeze', { on: true }).catch(() => {});
  await bots[0].dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => {});
  return ((await bots[0].req('level.get', {})) as { layout: LayoutLite }).layout;
})();

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(VOICE_DIR, 'silence.wav')}`, '--autoplay-policy=no-user-gesture-required',
    '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 635 } });
await context.grantPermissions(['microphone']).catch(() => {});
const page = await context.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.routeWebSocket(/token=/, () => { /* no Vite HMR reloads mid-run */ });
await page.addInitScript(INIT);
// no ?preset: the stored 'low' choice decides (SwiftShader detects 'low' too); auto quality off for stable counts
await page.goto(`${BASE}/?test=1&webgl=1&autoq=0&nobright=1#${crew}`, { waitUntil: 'domcontentloaded' });
let crashed = 0;
try {
  const L = await botsReady;
  await waitForGame(page, 60_000);
  log(`ready, install ${await ev(page, INSTALL)}`);
  await sleep(600);
  R.boot = { ...(await ev<Record<string, number>>(page, 'window.__bx.pipelines()')), menu: await ev(page, 'window.__game.state().diag.menuBackdrop ?? null').catch(() => null), preset: await ev(page, 'window.__render.info().preset') };
  log(`boot (title menu): ${JSON.stringify(R.boot)}`);
  await page.screenshot({ path: join(OUT, `budget-${TAG}-menu.png`) }).catch(() => null);
  // ---- the site arrives under a cover: only warm frames may draw (2c)
  await ev(page, `(window.__bx.phase = 'cover', window.__render.v12().hold(true), 1)`);
  const before = await ev<Record<string, number>>(page, 'window.__bx.pipelines()');
  await ev(page, `window.__game.join(${JSON.stringify(crew)})`, 30_000);
  const tj = performance.now();
  const views = facilityViews(L, 1, 1);
  const place = async (v: View, light = 1) => {
    await ev(page, `(window.__game.teleport(${v.x}, ${v.z}, ${v.yaw}), window.__game.look(${v.yaw}, ${v.pitch}), 1)`);
    v.bots.slice(0, 2).forEach((b, i) => { bots[i].target = { x: b.x, z: b.z, yaw: b.yaw, pitch: -0.08, light: light as 0 | 1, anim: 0 }; });
  };
  await place(views[0]);
  for (;;) {
    const ok = await ev<boolean>(page, `(() => { const d = window.__levelDebug; const i = d && d.info(); return !!(i && i.kind === 'facility' && d.texturesReady()); })()`, 30_000).catch(() => false);
    if (ok || performance.now() - tj > 25_000) { R.facilityReady = ok; break; }
    await sleep(300);
  }
  R.joinMs = Math.round(performance.now() - tj);
  log(`facility + content ready ${R.facilityReady} after ${R.joinMs} ms (held)`);
  // the welcome re-apply (meta applySettings ~600 ms after welcome) has run by now
  R.pipeBuildsAfterWelcome = await ev(page, 'window.__render.info().pipeBuilds ?? null');
  await ev(page, '(window.__bx.refresh(), window.__game.setInput({ flashlight: true }), 1)');
  const tw = performance.now();
  R.warmSite = await ev(page, `window.__render.v12().warmSite(${Math.max(8000, Math.min(52_000, (left() - 48) * 1000))})`, 60_000).catch((e: Error) => ({ error: e.message }));
  R.warmSiteWallMs = Math.round(performance.now() - tw);
  R.siteWarmInfo = await ev(page, 'window.__render.siteWarm()').catch(() => null);
  await ev(page, 'window.__render.v12().warmup()', 30_000).catch(() => null);
  const afterWarm = await ev<Record<string, number>>(page, 'window.__bx.pipelines()');
  const coverLog = await ev<{ phase: string; made: number; warm: boolean; ms: number }[]>(page, `window.__bx.log.filter((x) => x.phase === 'cover')`);
  R.cover = {
    pipelinesBefore: before, pipelinesAfterWarm: afterWarm, sitePipelines: afterWarm.pipelines - before.pipelines,
    framesWithCompiles: coverLog.length, maxPerFrame: Math.max(0, ...coverLog.map((x) => x.made)), maxFrameMs: Math.max(0, ...coverLog.map((x) => x.ms)),
    outsideSiteWarm: coverLog.filter((x) => !x.warm).reduce((a, x) => a + x.made, 0),
  };
  log(`warmSite ${JSON.stringify(R.warmSite)} in ${R.warmSiteWallMs} ms; info ${JSON.stringify(R.siteWarmInfo)}`);
  log(`cover: ${JSON.stringify(R.cover)}`);
  save();
  // ---- the cover drops: walk the views; nothing may compile in the frame loop now
  await ev(page, `(window.__bx.phase = 'game', window.__render.v12().hold(false), 1)`);
  for (const v of views) {
    if (left() < 26) { R.notes.push(`skipped view ${v.name} (time)`); break; }
    await place(v);
    await sleep(1200);
    const d = await draws(page, 1300);
    R.views.push({ name: v.name, draws: d });
    log(`${v.name}: draws ${d ? `${d.draws} ${JSON.stringify(d.pass)}` : '-'}`);
  }
  const gameLog = await ev<{ made: number }[]>(page, `window.__bx.log.filter((x) => x.phase === 'game')`);
  R.afterCover = { pipelinesCreated: gameLog.reduce((a, x) => a + x.made, 0), frames: gameLog.length };
  // ---- the biggest room: beams on, then every beam off (4a, 4b). The flashlight input is a toggle and the spawn
  // state varies: drive YOUR beam to a known state from render's own lit-beam list
  const setLocal = async (want: boolean): Promise<boolean> => {
    for (let i = 0; i < 4; i++) {
      const lit = await ev<boolean>(page, 'window.__render.v12().beams().some((b) => b.local)');
      if (lit === want) return true;
      await ev(page, '(window.__game.setInput({ flashlight: true }), 1)');
      await sleep(800);
    }
    return false;
  };
  const room = views.find((v) => v.name.startsWith('room')) ?? views[0];
  await place(room);
  await setLocal(true);
  await sleep(900);
  const litOn = await ev<number>(page, 'window.__render.v12().beams().length');
  const on = await draws(page);
  const p0 = (await ev<Record<string, number>>(page, 'window.__bx.pipelines()')).pipelines;
  bots.forEach((b) => { if (b.target) b.target.light = 0; });
  await setLocal(false);
  await sleep(1400);
  const litOff = await ev<number>(page, 'window.__render.v12().beams().length');
  const off = await draws(page);
  const p1 = (await ev<Record<string, number>>(page, 'window.__bx.pipelines()')).pipelines;
  bots.forEach((b) => { if (b.target) b.target.light = 1; });
  await setLocal(true);
  await sleep(1200);
  const back = await draws(page, 1000);
  const p2 = (await ev<Record<string, number>>(page, 'window.__bx.pipelines()')).pipelines;
  R.room = { name: room.name, litOn, on, litOff, off, back, pipelines: [p0, p1, p2] };
  const info = await ev<Record<string, unknown>>(page, 'window.__render.info()');
  R.info = { preset: info.preset, presetSource: info.presetSource ?? null, size: info.size, pipe: info.pipe ?? null, pipeBuilds: info.pipeBuilds ?? null, shadowRenders: info.shadowRenders, usedShadowed: info.usedShadowed, mode: info.mode, menuBackdrop: null };
  R.renderMs = await ev<number[]>(page, 'window.__bx.renderMs.slice(-60)').then((a) => ({ p50: q(a, 0.5), p95: q(a, 0.95) }));
  R.final = await ev(page, 'window.__bx.pipelines()');
  log(`room ${room.name}: ${litOn} lit beams: ${on?.draws} ${JSON.stringify(on?.pass)} | ${litOff} lit: ${off?.draws} ${JSON.stringify(off?.pass)} | back ${back?.draws}; pipelines ${p0} -> ${p1} -> ${p2}`);
  log(`info ${JSON.stringify(R.info)} renderMs ${JSON.stringify(R.renderMs)}`);
  // ---- budgets
  const shadowOff = off?.pass?.shadow ?? 0;
  if ((on?.draws ?? Infinity) > LIMITS.draws) {
    const msg = `draws ${on?.draws} > ${LIMITS.draws} (Low, ${room.name}, ${litOn} lit beams; needs the Phase C content consolidation)`;
    if (STRICT) fail(msg); else { R.notes.push(`OVER BUDGET (reported): ${msg}`); log(`over budget (reported; --strict 1 fails it): ${msg}`); }
  }
  if ((off?.draws ?? Infinity) > LIMITS.draws) fail(`draws ${off?.draws} > ${LIMITS.draws} with every beam dark`);
  if (R.cover.sitePipelines > LIMITS.sitePipelines) fail(`site pipelines ${R.cover.sitePipelines} > ${LIMITS.sitePipelines}`);
  if (R.afterCover.pipelinesCreated > LIMITS.afterCover) fail(`${R.afterCover.pipelinesCreated} pipelines compiled in the frame loop after the cover dropped`);
  if (shadowOff > LIMITS.shadowOff) fail(`${shadowOff} shadow draws with every beam off`);
  if (p1 - p0 > LIMITS.flat || p2 - p1 > LIMITS.flat) fail(`beams on/off compiled ${p1 - p0} + ${p2 - p1} pipelines (must stay flat)`);
  if (R.cover.outsideSiteWarm > 0 && (R.info.pipe as { velocity?: boolean } | null)) R.notes.push(`${R.cover.outsideSiteWarm} pipelines under the cover outside warmSite frames (spawn-view warm-up / boot frames)`);
  if ((R.info.pipe as { velocity?: boolean } | null)?.velocity === true) fail('the Low scene pass writes a velocity target');
  if (typeof R.pipeBuildsAfterWelcome === 'number' && R.pipeBuildsAfterWelcome > 1) fail(`the welcome re-apply rebuilt the pipeline (${R.pipeBuildsAfterWelcome} builds)`);
  R.errors = [...errors, ...(await ev<string[]>(page, 'window.__game.errors()', 5000).catch(() => []))].slice(0, 20);
  if (R.errors.length) fail(`page errors: ${R.errors.slice(0, 3).join(' | ')}`);
  save();
  // ---- looks (time permitting): Low, Lite (live switch: the pools + Lite's load-time parts stay Low's), Lite + SIGNAL
  if (LOOKS && left() > 34) {
    R.looks = [];
    const look = async (name: string, setup: string, settleMs: number) => {
      if (left() < 12) { R.notes.push(`skipped look ${name} (time)`); return; }
      if (setup) await ev(page, setup);
      const t0 = performance.now();
      let last = -1;
      while (performance.now() - t0 < settleMs && left() > 10) {
        await sleep(1500);
        const n = (await ev<Record<string, number>>(page, 'window.__bx.pipelines()')).pipelines;
        if (n === last) break;
        last = n;
      }
      const d = await draws(page, 1000);
      const inf = await ev<Record<string, unknown>>(page, 'window.__render.info()');
      await page.screenshot({ path: join(OUT, `budget-${TAG}-${name}.png`) }).catch(() => null);
      R.looks.push({ name, draws: d, pipelines: (await ev<Record<string, number>>(page, 'window.__bx.pipelines()')), size: inf.size, pipe: inf.pipe ?? null, signal: inf.signal ?? null, signalK: inf.signalK ?? null, osd: inf.osd ?? null, settledMs: Math.round(performance.now() - t0) });
      log(`look ${name}: ${JSON.stringify(R.looks[R.looks.length - 1])}`);
      save();
    };
    await look('low', '', 0);
    await look('lite', "(window.__render.setPreset('lite'), 1)", 20_000);
    await look('lite-signal', '(window.__render.v12().setSignalLook && window.__render.v12().setSignalLook(true), 1)', 12_000);
  }
} catch (e) {
  crashed++;
  R.crashed = String(e instanceof Error ? e.stack : e).slice(0, 1500);
  log(`CRASHED: ${R.crashed}`);
} finally {
  R.totalSec = +el().toFixed(1);
  save();
  for (const b of bots) b.close();
  await browser.close().catch(() => {});
  const failed = crashed > 0 || (!REPORT_ONLY && R.fails.length > 0);
  log(`${failed ? 'FAIL' : 'DONE'}${REPORT_ONLY ? ' (report only)' : ''}: ${R.fails.length} budget(s) missed -> tests/artifacts/render/v13/budget-${TAG}.json`);
  process.exit(failed ? 1 : 0);
}
