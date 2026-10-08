// Owner: env-render (v1.2). Gate P re-check of E2's fixes in ONE browser (run it through tools/gpu-guard.mjs; the
// software lane is fine: draw and pipeline COUNTS are scene-graph numbers, not perf):
//  1. draws per pass at Ultra with 6 beams (this camera + 5 ws bots, all beams on) at the arrival and the biggest
//     rooms of the gate seed. High / Ultra shadow 4 beams (yours + the 3 nearest / most centred teammates) and
//     teammates' beams reach flashlight.remoteDistance (their shadow far plane); the biggest room is measured again
//     with the old 28 m ranges (the far plane's share of the saving).
//  2. the first live mirror WITHOUT the loading flow (?test=1, no ?loading=1): the automatic mirror warm (render: on a
//     mirror-registry change) must already have compiled it, so the pipeline count stays flat from 'same spot, facing
//     away' to 'facing the glass'.
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/render/drawbudget.e2e.ts --base http://127.0.0.1:3812 [--tag x]
// The bots create the crew + the facility (dbg level.generate) before the browser joins. Results:
// tests/artifacts/render/v12/drawbudget-<tag>.json. Exit 1: more than 4 shadowed beams at Ultra, a non-flat first
// mirror view, or page errors.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO, launchPlayer, waitForGame } from '../lib/launch.ts';
import { Bot, facilityViews, mirrorView, sleep } from '../gates/p-lib.ts';
import type { LayoutLite, View } from '../gates/p-lib.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3812').replace(/\/$/, '');
const WS = arg('ws', BASE.replace(/^http/, 'ws') + '/ws');
if (/:(3000|3100|20241)(\/|$)/.test(BASE)) throw new Error('refusing the live ports');
const TAG = arg('tag', 'fix');
const SEED = arg('seed', 'gp-6');
const THEME = arg('theme', '');
const PRESET = arg('preset', 'ultra');
const BUDGET = Number(arg('budget', '112'));
const ROOMS = Number(arg('rooms', '2'));
const READY_SEC = Number(arg('ready', '4'));
const VW = Number(arg('w', '480')), VH = Number(arg('h', '270'));
const OUT = join(REPO, 'tests/artifacts/render/v12');
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const el = () => (performance.now() - T0) / 1000;
const left = () => BUDGET - el();
const log = (s: string) => console.log(`[draws ${el().toFixed(1).padStart(6)}s] ${s}`);
const R: Record<string, unknown> & { views: Record<string, unknown>[]; fails: string[] } = { tag: TAG, seed: SEED, preset: PRESET, viewport: [VW, VH], views: [], fails: [] };
const save = () => writeFileSync(join(OUT, `drawbudget-${TAG}.json`), JSON.stringify(R, null, 1));
const crew = `D${Math.random().toString(36).slice(2, 5).toUpperCase()}E`;

async function ev<T>(page: Page, fn: string, ms = 20_000): Promise<T> {
  return Promise.race([page.evaluate(fn) as Promise<T>, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`evaluate timed out (${ms} ms)`)), ms))]);
}

// the gate's attribution (tests/gates/p-draws.e2e.ts): every draw -> <scene root>/<category>|<pass>; one record per
// drawn frame; 'warm/...' = transient warm-up instances
const INSTALL = `(() => {
  if (window.__gp) return 'already';
  const t = window.__render && window.__render.three && window.__render.three();
  if (!t) return 'no __render.three';
  const { scene, renderer, camera } = t;
  const info = renderer.info;
  const frames = []; let cur = new Map(); let pass = new Map();
  const cache = new WeakMap();
  let shadowCams = new Set();
  const refresh = () => { shadowCams = new Set(); scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow && o.shadow.camera) shadowCams.add(o.shadow.camera); }); };
  refresh();
  const norm = (s) => String(s || '').split(':')[0].replace(/[.\\-_]?\\d+$/, '');
  const keyOf = (o) => {
    if (o.isInstancedMesh && o.count === 1 && o.instanceMatrix && Math.abs(o.instanceMatrix.array[0]) < 0.01) return 'warm/' + norm(o.name || 'inst');
    let k = cache.get(o); if (k) return k;
    const chain = []; for (let p = o; p && p !== scene; p = p.parent) chain.push(p);
    chain.reverse();
    const top = chain[0] || o;
    const tname = top.name || (top.isInstancedMesh ? 'InstancedMesh' : top.type);
    let cat = '';
    if (tname === 'level') { let i = 1; while (i < chain.length && /^space:/.test(chain[i].name)) i++; const c = chain[i] || o; cat = norm(c.name || c.type); }
    else if (chain.length > 1) cat = norm(chain[1].name || chain[1].type);
    else cat = norm(o.name || o.type);
    k = (tname.startsWith('avatar:') && tname !== 'avatar:self' ? 'avatar' : tname) + '/' + cat; cache.set(o, k); return k;
  };
  const up = info.update.bind(info);
  info.update = function (object, count, instanceCount) {
    up(object, count, instanceCount);
    const rc = renderer._currentRenderContext; const cam = rc && rc.camera;
    const p = !rc ? '?' : rc.fullscreenPass ? 'post' : cam === camera ? 'main' : shadowCams.has(cam) ? 'shadow' : 'other';
    const k = keyOf(object) + '|' + p;
    cur.set(k, (cur.get(k) || 0) + 1); pass.set(p, (pass.get(p) || 0) + 1);
  };
  const rs = info.reset.bind(info);
  info.reset = function () {
    const dc = info.render.drawCalls;
    if (dc > 0) { frames.push({ draws: dc, by: Object.fromEntries(cur), pass: Object.fromEntries(pass) }); if (frames.length > 40) frames.shift(); }
    cur = new Map(); pass = new Map(); rs();
  };
  const pipelines = () => { const pp = renderer._pipelines; return { pipelines: pp && pp.caches ? pp.caches.size : -1, vs: pp && pp.programs ? pp.programs.vertex.size : -1, fs: pp && pp.programs ? pp.programs.fragment.size : -1 }; };
  // what compiles while logPipes is on: pass, material, object chain, +pipelines / +vertex / +fragment programs
  const created = [];
  const pp = renderer._pipelines;
  if (pp && pp.getForRender) {
    const gfr = pp.getForRender.bind(pp);
    pp.getForRender = function (ro, promises) {
      const n0 = pp.caches.size, v0 = pp.programs.vertex.size, f0 = pp.programs.fragment.size;
      const r = gfr(ro, promises);
      if (window.__gp && window.__gp.logPipes && (pp.caches.size !== n0 || pp.programs.vertex.size !== v0 || pp.programs.fragment.size !== f0) && created.length < 60) {
        const chain = []; for (let p = ro.object; p && p !== scene && chain.length < 5; p = p.parent) chain.push(p.name || p.type);
        const cam = ro.camera;
        created.push({ pass: cam === camera ? 'main' : shadowCams.has(cam) ? 'shadow' : 'other', mat: (ro.material && (ro.material.name || ro.material.type)) || '?', obj: chain.join('<'), dp: pp.caches.size - n0, dv: pp.programs.vertex.size - v0, df: pp.programs.fragment.size - f0 });
      }
      return r;
    };
  }
  window.__gp = { frames, refresh, pipelines, created, logPipes: false, clear() { frames.length = 0; } };
  return 'ok';
})()`;

interface Frame { draws: number; by: Record<string, number>; pass: Record<string, number> }
async function sample(page: Page, n = 4, ms = 15_000): Promise<Frame | null> {
  await ev(page, 'window.__gp.clear()');
  const t = performance.now();
  for (;;) {
    const k = await ev<number>(page, 'window.__gp.frames.length').catch(() => 0);
    if (k >= n || performance.now() - t > ms) break;
    await sleep(100);
  }
  const fr = await ev<Frame[]>(page, 'window.__gp.frames.slice()');
  return fr.reduce<Frame | null>((a, f) => (!a || f.draws > a.draws ? f : a), null);
}

const bots = Array.from({ length: 5 }, (_, i) => new Bot(`Beam${i + 1}`));
async function place(page: Page, v: View): Promise<void> {
  await ev(page, `(window.__game.teleport(${v.x}, ${v.z}, ${v.yaw}), window.__game.look(${v.yaw}, ${v.pitch}), 1)`);
  v.bots.forEach((b, i) => { if (bots[i]) bots[i].target = { x: b.x, z: b.z, yaw: b.yaw, pitch: -0.08, light: 1, anim: 0 }; });
}
const transient = (k: string) => k.startsWith('interaction/WARM') || k.startsWith('warm/') || k.includes('render-warm-proxies');
async function measure(page: Page, v: View, label: string, settle = 900): Promise<Record<string, unknown>> {
  await place(page, v);
  await sleep(settle);
  const f = await sample(page);
  const info: Record<string, unknown> = await ev<Record<string, unknown>>(page, 'window.__render.info()').catch(() => ({}));
  let tr = 0, shadow = 0;
  const shadowBy: Record<string, number> = {};
  for (const [k, n] of Object.entries(f?.by ?? {})) {
    if (transient(k)) { tr += n; continue; }
    if (k.endsWith('|shadow')) { shadow += n; const c = k.split('|')[0]; shadowBy[c] = (shadowBy[c] ?? 0) + n; }
  }
  const rec = {
    name: label, draws: f?.draws ?? null, steady: f ? f.draws - tr : null, transient: tr, steadyShadow: shadow, pass: f?.pass ?? null,
    shadowBy: Object.fromEntries(Object.entries(shadowBy).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    usedShadowed: info.usedShadowed, poolShadowed: info.poolShadowed, poolUnshadowed: info.poolUnshadowed, beamRanges: info.beamRanges,
  };
  R.views.push(rec);
  save();
  log(`${label}: draws ${rec.draws} steady ${rec.steady} (shadow ${shadow}, transient ${tr}) pass ${JSON.stringify(rec.pass)} shadowed ${String(info.usedShadowed)}/${String(info.poolShadowed)}+${String(info.poolUnshadowed)} ranges ${JSON.stringify(info.beamRanges)}`);
  return rec;
}

const botsReady = (async () => {
  await bots[0].connect(WS, crew);
  for (const b of bots.slice(1)) await b.connect(WS, crew);
  await bots[0].dbg('net.validate', { on: false });
  const g = await bots[0].dbg<Record<string, unknown>>('level.generate', { seed: SEED, players: 6, risk: 2, ...(THEME ? { theme: THEME } : {}) });
  R.layout = { hash: g.hash, theme: g.theme ?? null };
  await bots[0].dbg('monsters.freeze', { on: true }).catch(() => {});
  await bots[0].dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => {});
  return (await bots[0].req<{ layout: LayoutLite }>('level.get', {})).layout;
})();

const player = await launchPlayer({ name: 'DrawCam', baseUrl: BASE, crew, viewport: { width: VW, height: VH }, query: { preset: PRESET, autoq: '0', nobright: '1' } });
const page = player.page;
let failed = 0;
try {
  const L = await botsReady;
  log(`crew ${crew} facility ${(R.layout as { hash?: string }).hash}`);
  await waitForGame(page, 80_000);
  log(`game ready (${await ev(page, 'window.__game.backend()')})`);
  R.install = await ev(page, INSTALL);
  await ev(page, `window.__game.join(${JSON.stringify(crew)})`, 30_000);
  log('joined');
  const views = facilityViews(L, ROOMS, 0);
  await place(page, views[0]).catch(() => {});
  const t = performance.now();
  let ready = false;
  while (!ready && (performance.now() - t) / 1000 < READY_SEC && left() > 50) {
    ready = await ev<boolean>(page, `(() => { const d = window.__levelDebug; const i = d && d.info(); return !!(i && i.kind === 'facility' && d.texturesReady()); })()`, 30_000).catch(() => false);
    if (!ready) await sleep(400);
  }
  R.facReady = ready;
  log(`facility ready=${ready}`);
  await ev(page, 'window.__gp.refresh()');
  await ev(page, `(window.__game.setInput({ flashlight: true }), 1)`).catch(() => {});
  // ---- 1. draws at Ultra, 6 beams
  const room = views.filter((v) => v.name.startsWith('room')).slice(0, ROOMS);
  for (const v of [views[0], ...room]) {
    if (left() < 30) { R.fails.push(`budget: skipped ${v.name}`); break; }
    const rec = await measure(page, v, v.name);
    if (PRESET === 'ultra' && Number(rec.usedShadowed) > 4) { failed++; R.fails.push(`${v.name}: ${String(rec.usedShadowed)} shadowed beams at Ultra (max 4)`); }
  }
  if (room[0] && left() > 28) {
    const was = await ev<{ local: number; remote: number }>(page, 'window.__render.flashRanges(28, 28)');
    await measure(page, room[0], `${room[0].name}_ranges28`);
    await ev(page, `window.__render.flashRanges(${was.local}, ${was.remote})`);
  }
  // ---- 2. the first live mirror without the loading flow
  const mv = mirrorView(L);
  if (mv && left() > 14) {
    const mw = await ev<Record<string, unknown>>(page, 'window.__render.info().mirrorWarm');
    R.mirrorWarmBefore = mw;
    log(`mirror warm before the mirror view: ${JSON.stringify(mw)}`);
    // wait (bounded) for a pending automatic warm to finish: it must not depend on the loading screen
    const tw = performance.now();
    while (performance.now() - tw < 8000 && left() > 12) {
      const m = await ev<{ state?: string; frames?: number }>(page, 'window.__render.info().mirrorWarm').catch(() => null);
      if (m && (m.state === 'done' || m.state === 'early') && !m.frames) break;
      await sleep(200);
    }
    const away = { ...mv, name: `${mv.name}_away`, yaw: mv.yaw + Math.PI };
    await measure(page, away, away.name, 1200);
    const pa = await ev(page, 'window.__gp.pipelines()');
    await ev(page, '(window.__gp.created.length = 0, window.__gp.logPipes = true, 1)');
    await place(page, mv);
    const t1 = performance.now();
    let live = 0;
    while (performance.now() - t1 < 9000 && left() > 6) {
      live = await ev<number>(page, '(window.__render.info().mirrorsLive || 0)', 25_000).catch(() => 0);
      if (live > 0) break;
      await sleep(150);
    }
    await sleep(600);
    const pb = await ev<{ pipelines: number }>(page, 'window.__gp.pipelines()').catch(() => null);
    const created = await ev<unknown[]>(page, '(window.__gp.logPipes = false, window.__gp.created.slice())').catch(() => []);
    R.mirror = { view: mv.name, away: pa, facing: pb, live, liveAfterMs: Math.round(performance.now() - t1), warm: await ev(page, 'window.__render.info().mirrorWarm').catch(() => null), created };
    log(`mirror: live=${live} pipelines ${JSON.stringify(pa)} -> ${JSON.stringify(pb)}${created.length ? ` new: ${JSON.stringify(created).slice(0, 900)}` : ''}`);
    if (live > 0 && pb && (pa as { pipelines: number }).pipelines !== pb.pipelines) { failed++; R.fails.push(`first mirror view: pipelines ${(pa as { pipelines: number }).pipelines} -> ${pb.pipelines}`); }
    if (!live) R.fails.push('mirror never went live (not counted as a failure: budget / view)');
  } else if (!mv) R.fails.push('no mirror in this layout');
  R.info = await ev(page, 'JSON.parse(JSON.stringify(window.__render.info()))').catch(() => null);
  const pageErrors = [...player.errors, ...(await ev<string[]>(page, 'window.__game.errors()', 5000).catch(() => []))];
  R.errors = pageErrors.slice(0, 30);
  const hard = pageErrors.filter((e) => !/http 404: .*\/assets\//.test(e) && !/Failed to load resource/.test(e));
  if (hard.length) { failed++; R.fails.push(`${hard.length} page errors: ${hard.slice(0, 3).join(' | ')}`); }
} catch (e) {
  failed++;
  R.failed = String(e instanceof Error ? e.stack : e).slice(0, 1500);
  log(`FAILED: ${R.failed}`);
} finally {
  R.totalSec = +el().toFixed(1);
  R.ok = failed === 0;
  save();
  for (const b of bots) b.close();
  await player.close().catch(() => {});
  log(`${failed ? 'FAIL' : 'PASS'} -> tests/artifacts/render/v12/drawbudget-${TAG}.json ${R.fails.length ? JSON.stringify(R.fails) : ''}`);
  process.exit(failed ? 1 : 0);
}
