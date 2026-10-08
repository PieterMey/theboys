// Gate P (integrator): draw calls per fixed view with 6 players (this camera + 5 ws bots, all beams on), attributed
// per scene root / level category and per pass, lights per pool, the shader pipeline count before/after the first
// mirror view (same spot, facing away -> facing the glass), paranormal effect deltas, and an optional CPU + allocation
// sampling window. Works against v1.1 (40227e4) and v1.2 clients (test API + __render.three() only). ONE browser; run
// it through the GPU guard (several probes can share one guard slot via tests/gates/p-pair.mjs):
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/gates/p-draws.e2e.ts --base http://127.0.0.1:3896 \
//     --ws ws://127.0.0.1:3895/ws --tag v12 --seed gp-6 [--theme records] [--preset ultra] [--parts fac,mirror,para,prof]
// The bots create the crew and the facility BEFORE the browser joins (no hub build: SwiftShader compiles are slow).
// Results: <out>/<tag>.json (written after every step). Software frame times are NOT perf: only counts are reported.
// Real-GPU pass (integrator, with the user's OK): add --query loading=1 so the loading flow runs render.warmup() (the
// v1.2 warm set) before the first mirror view, and use --w 2560 --h 1440 for hostperf-like counts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO, launchPlayer, waitForGame } from '../lib/launch.ts';
import { Bot, botsAhead, facilityViews, mirrorView, sleep } from './p-lib.ts';
import type { LayoutLite, View } from './p-lib.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3896').replace(/\/$/, '');
const WS = arg('ws', BASE.replace(/^http/, 'ws') + '/ws');
if (/:(3000|3100)(\/|$)/.test(BASE) || /:(3000|3100)\//.test(WS)) throw new Error('refusing the live ports');
const TAG = arg('tag', 'run');
const SEED = arg('seed', 'gp-6');
const THEME = arg('theme', '');
const PRESET = arg('preset', 'ultra');
const PARTS = new Set(arg('parts', 'fac,mirror,para,prof').split(','));
const BUDGET = Number(arg('budget', '112'));
const ROOMS = Number(arg('rooms', '3'));
const CORRS = Number(arg('corrs', '2'));
const MIRROR = arg('mirror', '');
const READY_SEC = Number(arg('ready', '42'));
const OUT = arg('out', join(REPO, 'tests/artifacts/gates/p'));
const VW = Number(arg('w', '480')), VH = Number(arg('h', '270'));
/** extra page query, e.g. --query loading=1 (the real loading flow + render.warmup(); ?test=1 skips it by default) */
const EXTRA = Object.fromEntries(arg('query', '').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const el = () => (performance.now() - T0) / 1000;
const log = (s: string) => console.log(`[${TAG} ${el().toFixed(1).padStart(6)}s] ${s}`);
const left = () => BUDGET - el();
const R: Record<string, unknown> & { views: Record<string, unknown>[]; steps: string[] } = { tag: TAG, base: BASE, seed: SEED, theme: THEME || null, preset: PRESET, viewport: [VW, VH], views: [], steps: [] };
const save = () => writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(R, null, 1));
const crew = `G${Math.random().toString(36).slice(2, 5).toUpperCase()}P`;

/** page.evaluate with a timeout (a shader-compile stall blocks the page's main thread) */
async function ev<T>(page: Page, fn: string, ms = 20_000): Promise<T> {
  return Promise.race([page.evaluate(fn) as Promise<T>, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`evaluate timed out (${ms} ms)`)), ms))]);
}

// in-page instrumentation: every draw (renderer.info.update) is attributed to <scene root>/<category>|<pass> (main
// camera, shadow camera, fullscreen post, other = mirror reflection / misc); transient warm-up meshes (any ancestor
// scaled below 1 cm, or a warm-up instance) are keyed 'warm/...'; one record per drawn frame (info.reset)
const INSTALL = `(() => {
  if (window.__gp) return 'already';
  const t = window.__render && window.__render.three && window.__render.three();
  if (!t) return 'no __render.three';
  const { scene, renderer, camera } = t;
  const info = renderer.info;
  const frames = []; let cur = new Map(); let pass = new Map(); let total = 0;
  const cache = new WeakMap();
  let shadowCams = new Set();
  const refresh = () => { shadowCams = new Set(); scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow && o.shadow.camera) shadowCams.add(o.shadow.camera); }); };
  refresh();
  const norm = (s) => String(s || '').split(':')[0].replace(/[.\\-_]?\\d+$/, '');
  const tiny = (o) => { for (let p = o; p && p !== scene; p = p.parent) if (Math.abs(p.scale.x) < 0.01) return true; return false; };
  const keyOf = (o) => {
    if (o.isInstancedMesh && o.count === 1 && o.instanceMatrix && Math.abs(o.instanceMatrix.array[0]) < 0.01) return 'warm/' + norm(o.name || 'inst');
    let k = cache.get(o); if (k) return k;
    const chain = []; for (let p = o; p && p !== scene; p = p.parent) chain.push(p);
    chain.reverse();
    const top = chain[0] || o;
    const tname = top.name || (top.isInstancedMesh ? 'InstancedMesh' : top.type);
    let cat = '';
    if (tiny(o)) cat = 'WARM';
    else if (tname === 'level') {
      let i = 1; while (i < chain.length && /^space:/.test(chain[i].name)) i++;
      const c = chain[i] || o;
      cat = norm(c.name || c.type);
      if (/decal/.test(o.name) || /decal/.test((o.material && o.material.name) || '')) cat = 'decal';
    } else if (chain.length > 1) {
      cat = norm(chain[1].name || chain[1].type);
      if (!chain[1].name && chain.length > 2) cat += '>' + norm(chain[2].name || chain[2].type);
    } else cat = norm(o.name || o.type);
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
    if (dc > 0) { total++; frames.push({ draws: dc, tris: info.render.triangles, by: Object.fromEntries(cur), pass: Object.fromEntries(pass) }); if (frames.length > 40) frames.shift(); }
    cur = new Map(); pass = new Map(); rs();
  };
  const lights = () => {
    const out = {}; let n = 0;
    scene.traverse((o) => { if (!o.isLight) return; n++; const k = o.type + (o.castShadow ? '+shadow' : '') + (o.visible ? '' : '(hidden)'); out[k] = (out[k] || 0) + 1; });
    return { total: n, byType: out };
  };
  const pipelines = () => { const pp = renderer._pipelines; return { pipelines: pp && pp.caches ? pp.caches.size : -1, vs: pp && pp.programs ? pp.programs.vertex.size : -1, fs: pp && pp.programs ? pp.programs.fragment.size : -1 }; };
  const roots = () => scene.children.map((c) => { let m = 0, v = 0; c.traverse((o) => { if (o.isMesh || o.isSprite || o.isPoints || o.isLine) m++; }); c.traverseVisible((o) => { if (o.isMesh || o.isSprite) v++; }); return { name: c.name || c.type, meshes: m, visibleMeshes: v }; }).filter((r) => r.meshes > 0);
  window.__gp = { frames, total: () => total, refresh, lights, pipelines, roots, clear() { frames.length = 0; } };
  return 'ok';
})()`;

const SNAP = `(() => {
  const ri = window.__render && window.__render.info ? window.__render.info() : {};
  const pick = (o, ks) => Object.fromEntries(ks.filter((k) => k in o).map((k) => [k, o[k]]));
  const lv = window.__levelDebug && window.__levelDebug.renderInfo ? window.__levelDebug.renderInfo() : {};
  const d = window.__levelDebug;
  return {
    ready: !!(d && d.texturesReady()),
    render: pick(ri, ['backend', 'preset', 'size', 'poolShadowed', 'poolUnshadowed', 'poolFixtures', 'poolOmni', 'capSpots', 'capPoints', 'usedShadowed', 'fixturesLit', 'parkedShadows', 'shadowRenders', 'mirrorsLive', 'mirrors', 'mode', 'features', 'mist', 'auto', 'autoEnabled', 'grid']),
    level: pick(lv, ['triangles', 'levelMeshes', 'levelMeshesVisible', 'van', 'containers', 'lorePages', 'mirrors', 'decals']),
    pipes: window.__gp ? window.__gp.pipelines() : null,
    para: window.__paranormal ? window.__paranormal.effects() : null,
  };
})()`;

interface Frame { draws: number; tris: number; by: Record<string, number>; pass: Record<string, number> }
async function sample(page: Page, n = 4, ms = 15_000): Promise<{ draws: number[]; max: Frame | null; min: Frame | null }> {
  await ev(page, 'window.__gp.clear()');
  const t = performance.now();
  for (;;) {
    const k = await ev<number>(page, 'window.__gp.frames.length').catch(() => 0);
    if (k >= n || performance.now() - t > ms) break;
    await sleep(100);
  }
  const fr = await ev<Frame[]>(page, 'window.__gp.frames.slice()');
  const max = fr.reduce<Frame | null>((a, f) => (!a || f.draws > a.draws ? f : a), null);
  const min = fr.reduce<Frame | null>((a, f) => (!a || f.draws < a.draws ? f : a), null);
  return { draws: fr.map((f) => f.draws), max, min };
}

const bots = Array.from({ length: 5 }, (_, i) => new Bot(`Beam${i + 1}`));
async function place(page: Page, v: View): Promise<void> {
  await ev(page, `(window.__game.teleport(${v.x}, ${v.z}, ${v.yaw}), window.__game.look(${v.yaw}, ${v.pitch}), 1)`);
  v.bots.forEach((b, i) => { if (bots[i]) bots[i].target = { x: b.x, z: b.z, yaw: b.yaw, pitch: -0.08, light: 1, anim: 0 }; });
}

const warmOf = (by: Record<string, number> | null | undefined) => Object.entries(by ?? {}).filter(([k]) => k.startsWith('warm/') || k.includes('/WARM')).reduce((a, [, v]) => a + v, 0);
async function measure(page: Page, v: View, label = v.name, settle = 800, n = 4): Promise<Record<string, unknown>> {
  await place(page, v);
  await sleep(settle);
  const s = await sample(page, n);
  const snap = await ev<Record<string, unknown>>(page, SNAP).catch((e) => ({ error: String(e) }));
  const warm = warmOf(s.max?.by);
  const rec = { name: label, at: +el().toFixed(1), x: +v.x.toFixed(2), z: +v.z.toFixed(2), yaw: +v.yaw.toFixed(3), draws: s.draws, maxDraws: s.max?.draws ?? null, warm, steady: s.max ? s.max.draws - warm : null, minDraws: s.min?.draws ?? null, tris: s.max?.tris ?? null, pass: s.max?.pass ?? null, by: s.max?.by ?? null, ...snap };
  R.views.push(rec);
  save();
  log(`${label}: draws ${s.draws.join(',')} (warm ${warm}) pass ${JSON.stringify(s.max?.pass ?? {})} ready ${(snap as { ready?: boolean }).ready} pipes ${JSON.stringify((snap as { pipes?: unknown }).pipes)}`);
  return rec;
}

async function myLight(page: Page): Promise<boolean | null> {
  return ev<boolean | null>(page, `(() => { const s = window.__game.state(); const me = (s.players || []).find((p) => p.id === s.me); return me ? !!me.light : null; })()`).catch(() => null);
}
async function ensureLight(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const on = await myLight(page);
    R.steps.push(`light check ${i}: ${on}`);
    if (on || (on === null && i > 0)) return;
    await ev(page, `(window.__game.setInput({ flashlight: true }), 1)`);
    await sleep(500);
  }
}

// ---- bots first: the crew + the facility exist before the browser joins (no hub build in the page)
const botsReady = (async () => {
  await bots[0].connect(WS, crew);
  for (const b of bots.slice(1)) await b.connect(WS, crew);
  await bots[0].dbg('net.validate', { on: false });
  const g = await bots[0].dbg<Record<string, unknown>>('level.generate', { seed: SEED, players: 6, risk: 2, ...(THEME ? { theme: THEME } : {}) });
  R.layout = { hash: g.hash, theme: g.theme ?? null, genMs: g.genMs };
  await bots[0].dbg('monsters.freeze', { on: true }).catch((e) => R.steps.push(`freeze: ${e}`));
  await bots[0].dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => R.steps.push('no paranormal (v1.1)'));
  const L = (await bots[0].req<{ layout: LayoutLite }>('level.get', {})).layout;
  return L;
})();

const player = await launchPlayer({ name: 'GateCam', baseUrl: BASE, crew, viewport: { width: VW, height: VH }, query: { preset: PRESET, autoq: '0', nobright: '1', ...EXTRA } });
const page = player.page;
try {
  const L = await botsReady;
  const views = facilityViews(L, ROOMS, CORRS);
  // the van in the facility lot: from behind the spawns (exterior) and from inside the cargo
  const c = L.van.cab, vx = c.x + c.w / 2;
  const lot = L.spaces.find((s) => s.type === 'lot')?.rect ?? { x: c.x - 6, y: c.y - 8, w: 14, h: 10 };
  views.push({ name: 'van_ext', x: vx, z: c.y - 4.4, yaw: 0, pitch: -0.05, bots: botsAhead(lot, vx, c.y - 4.4, 0).map((b) => ({ ...b, z: Math.min(b.z, c.y - 0.6) })) });
  views.push({ name: 'van_int', x: vx, z: c.y + 0.45, yaw: 0, pitch: -0.18, bots: [-0.8, -0.3, 0.3, 0.8, 0].map((dx, i) => ({ x: vx + dx, z: c.y - 1.2 - (i % 2) * 0.8, yaw: 0 })) });
  log(`crew ${crew} facility ${(R.layout as { hash?: string }).hash} ready on the server; ${views.length} views`);
  await waitForGame(page, 80_000);
  R.bootSec = +el().toFixed(1);
  log(`game ready (${await ev(page, 'window.__game.backend()')})`);
  R.install = await ev(page, INSTALL);
  await ev(page, `window.__game.join(${JSON.stringify(crew)})`, 30_000);
  R.joinSec = +el().toFixed(1);
  log('joined');
  await place(page, views[0]).catch(() => {});
  // ready = the level's textures + props are in; measure anyway after READY_SEC (recorded per view)
  const t = performance.now();
  let ready = false;
  while (!ready && (performance.now() - t) / 1000 < READY_SEC && left() > 40) {
    ready = await ev<boolean>(page, `(() => { const d = window.__levelDebug; const i = d && d.info(); return !!(i && i.kind === 'facility' && d.texturesReady()); })()`, 30_000).catch(() => false);
    if (!ready) await sleep(400);
  }
  R.facReadySec = +el().toFixed(1);
  R.facReady = ready;
  log(`facility ready=${ready}`);
  await ev(page, 'window.__gp.refresh()');
  await ensureLight(page);
  R.facLights = await ev(page, 'window.__gp.lights()');
  R.roots = await ev(page, 'window.__gp.roots()');
  R.levelInfo = await ev(page, `JSON.parse(JSON.stringify(window.__levelDebug.info()))`).catch(() => null);
  R.pipesAtReady = await ev(page, 'window.__gp.pipelines()');
  save();
  if (PARTS.has('fac')) {
    for (const v of views) {
      if (left() < 16) { R.steps.push(`budget: skipped ${v.name}`); continue; }
      await measure(page, v);
    }
  }
  R.pipesAfterViews = await ev(page, 'window.__gp.pipelines()');
  R.roots2 = await ev(page, 'window.__gp.roots()');

  const step_para = async () => {
  // ---------------- paranormal effects (v1.2): draws while an effect runs, at a corridor view
  if (PARTS.has('para') && left() > 16) {
    const v = views.find((x) => x.name.startsWith('corr')) ?? views[0];
    const base = await measure(page, v, `${v.name}_para_base`, 400, 3);
    R.para = [];
    for (const kind of ['presence', 'footprints', 'silhouette', 'cold_spot']) {
      if (left() < 9) break;
      const r = await ev<Record<string, unknown>>(page, `window.__game.dbg('paranormal.fire', { kind: '${kind}', self: true, force: true })`, 8000).catch((e) => ({ ok: false, reason: String(e) }));
      if (!r || r.ok === false) { (R.para as unknown[]).push({ kind, fired: false, reason: r?.reason ?? null }); continue; }
      await sleep(1100);
      const s = await sample(page, 3, 8000);
      const fx = await ev(page, 'window.__paranormal ? window.__paranormal.effects() : null').catch(() => null);
      (R.para as unknown[]).push({ kind, fired: true, draws: s.draws, baseMax: base.maxDraws, delta: (s.max?.draws ?? 0) - Number(base.maxDraws ?? 0), by: s.max?.by ?? null, active: fx, pipes: await ev(page, 'window.__gp.pipelines()').catch(() => null) });
      log(`para ${kind}: draws ${s.draws.join(',')} (base ${base.maxDraws})`);
      save();
    }
  }

  };
  const step_prof = async () => {
  // ---------------- CPU + allocation sampling window (counts only, never frame times)
  if (PARTS.has('prof') && left() > 13) {
    const v = views[1] ?? views[0];
    await place(page, v);
    await sleep(500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('HeapProfiler.enable');
    const f0 = await ev<number>(page, 'window.__gp.total()');
    await cdp.send('Profiler.start');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true } as never);
    const sec = 4;
    await sleep(sec * 1000);
    const heap = (await cdp.send('HeapProfiler.stopSampling')) as { profile: unknown };
    const cpu = (await cdp.send('Profiler.stop')) as { profile: unknown };
    const f1 = await ev<number>(page, 'window.__gp.total()');
    writeFileSync(join(OUT, `${TAG}.heap.json`), JSON.stringify(heap.profile));
    writeFileSync(join(OUT, `${TAG}.cpuprofile`), JSON.stringify(cpu.profile));
    R.prof = { view: v.name, sec, frames: f1 - f0 };
    log(`profile: ${f1 - f0} drawn frames in ${sec} s`);
    save();
  }

  };
  const step_mirror = async () => {
  // ---------------- the first mirror view (last: it may stall the page while pipelines compile)
  if (PARTS.has('mirror') && left() > 12) {
    let mv = mirrorView(L);
    if (!mv && MIRROR) {
      const [x, z, yaw] = MIRROR.split(',').map(Number);
      const own = L.owner[Math.floor(z) * L.W + Math.floor(x)];
      const r = own >= 0 ? L.spaces[own].rect : { x: x - 2, y: z - 2, w: 4, h: 4 };
      mv = { name: 'mirror_spot', x, z, yaw, pitch: -0.02, bots: botsAhead(r, x, z, yaw + Math.PI).map((b) => ({ ...b, yaw })) };
    }
    if (mv) {
      // A: same spot facing away from the glass (the room behind the camera compiles now), B: face the glass
      const away = { ...mv, name: `${mv.name}_away`, yaw: mv.yaw + Math.PI };
      const a = await measure(page, away, away.name, 1000, 3);
      const pa = await ev(page, 'window.__gp.pipelines()');
      await place(page, mv);
      const t1 = performance.now();
      let live = 0, maxBlock = 0;
      while (performance.now() - t1 < 9000 && left() > 6) {
        const tq = performance.now();
        live = await ev<number>(page, '(window.__render.info().mirrorsLive || 0)', 25_000).catch(() => 0);
        maxBlock = Math.max(maxBlock, performance.now() - tq);
        if (live > 0) break;
        await sleep(150);
      }
      const liveMs = Math.round(performance.now() - t1);
      const b = left() > 4 ? await measure(page, mv, `${mv.name}${live ? '' : '_notlive'}`, 300, 3) : null;
      const pb = await ev(page, 'window.__gp.pipelines()').catch(() => null);
      R.mirror = { away: pa, facing: pb, live, liveAfterMs: liveMs, maxEvaluateBlockMs: Math.round(maxBlock), drawsAway: a.maxDraws, drawsFacing: b?.maxDraws ?? null };
      log(`mirror: live=${live} after ${liveMs} ms (page blocked up to ${Math.round(maxBlock)} ms) pipelines ${JSON.stringify(pa)} -> ${JSON.stringify(pb)}`);
      save();
    }
  }
  };
  for (const p of [...PARTS]) { if (p === 'para') await step_para(); else if (p === 'prof') await step_prof(); else if (p === 'mirror') await step_mirror(); }
  R.errors = [...player.errors, ...(await ev<string[]>(page, 'window.__game.errors()', 5000).catch(() => []))].slice(0, 30);
} catch (e) {
  R.failed = String(e instanceof Error ? e.stack : e).slice(0, 1500);
  log(`FAILED: ${R.failed}`);
} finally {
  R.totalSec = +el().toFixed(1);
  save();
  for (const b of bots) b.close();
  await player.close().catch(() => {});
  log(`-> ${join(OUT, `${TAG}.json`)}`);
  process.exit(0);
}
