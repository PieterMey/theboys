// players (v1.2 fix round) browser e2e: the remote-avatar draw budget, one player, SwiftShader lane
// (tools/gpu-guard.mjs sets DEADAIR_RENDER). Preset: AVD_PRESET (default low: Ultra boots too slowly under SwiftShader
// for a 120 s run; on Medium+ the AO pre-pass doubles every opaque main-pass draw):
//   - 5 lit teammates (local dummies, beams on) + the local beam, like gate P's worst view
//   - every draw attributed to avatar / view model and to its pass (main = pre-pass + scene pass, shadow, other)
//   - structure per avatar: <= 4 meshes (1 merged skinned body, helmet hard + visor, 1 badge mesh), <= 2 shadow
//     casters, the skinned body frustum culled (not drawn into every shadow map any more)
//   - crew behind the camera: their bodies leave the main pass
//   - screenshots (look at them): the crew in the beams, helmet close-up, a corpse
//     tests/artifacts/players/avatar_draws_*.png + avatar-draws.json
// Needs a --dev server (Vite middleware) on PORT (default 3801):
//   node tools/gpu-guard.mjs --max-sec 120 --label g1 -- node tests/players/avatar-draws.e2e.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';

const PORT = Number(process.env.PORT ?? 3801);
if (PORT === 3000) throw new Error('never on the live port 3000');
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const OUT = 'tests/artifacts/players';
mkdirSync(OUT, { recursive: true });
const tail = Date.now().toString(36).slice(-3).toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ]/g, 'K');
const CREW = `AVD${tail}`.slice(0, 6);
const PRESET = process.env.AVD_PRESET ?? 'low';
const t0 = Date.now();
const lap = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
/** seconds left before the internal deadline (the guard stops the run at 120 s): optional steps are skipped */
const left = () => 108 - (Date.now() - t0) / 1000;
const results: Record<string, unknown> = { preset: PRESET };
/** partial results survive a guard stop (it kills the run at its time limit) */
const save = () => { try { writeFileSync(`${OUT}/avatar-draws.json`, JSON.stringify(results, null, 1)); } catch { /* ignore */ } };
let failed = false;
const check = (cond: unknown, msg: string) => {
  if (!cond) { failed = true; console.log(`FAIL: ${msg}`); } else console.log(`ok: ${msg}`);
};

type V3 = [number, number, number];
interface Frame { draws: number; by: Record<string, number> }

// in-page draw attribution (gate P's method): renderer.info.update -> <avatar|viewmodel|self|scene>|<pass>, plus
// per-avatar totals; one record per drawn frame (info.reset)
const INSTALL = `(() => {
  if (window.__ad) return 'already';
  const t = window.__render && window.__render.three && window.__render.three();
  if (!t) return 'no __render.three';
  const { scene, renderer, camera } = t;
  const info = renderer.info;
  const frames = []; let cur = new Map();
  let shadowCams = new Set();
  const refresh = () => { shadowCams = new Set(); scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow && o.shadow.camera) shadowCams.add(o.shadow.camera); }); };
  refresh();
  const cache = new WeakMap();
  const keyOf = (o) => {
    let k = cache.get(o); if (k) return k;
    let top = o; while (top.parent && top.parent !== scene && top.parent !== camera) top = top.parent;
    const n = top.name || '';
    k = n === 'avatar:self' ? 'self' : n.startsWith('avatar:') ? 'avatar' + ':' + n.slice(7) : n === 'viewmodel' ? 'viewmodel' : 'scene';
    cache.set(o, k); return k;
  };
  const up = info.update.bind(info);
  info.update = function (object, count, instanceCount) {
    up(object, count, instanceCount);
    const rc = renderer._currentRenderContext; const cam = rc && rc.camera;
    const p = !rc ? '?' : rc.fullscreenPass ? 'post' : cam === camera ? 'main' : shadowCams.has(cam) ? 'shadow' : 'other';
    const k = keyOf(object) + '|' + p;
    cur.set(k, (cur.get(k) || 0) + 1);
  };
  const rs = info.reset.bind(info);
  info.reset = function () {
    const dc = info.render.drawCalls;
    if (dc > 0) { frames.push({ draws: dc, by: Object.fromEntries(cur) }); if (frames.length > 30) frames.shift(); }
    cur = new Map(); rs();
  };
  window.__ad = { frames, refresh, clear() { frames.length = 0; } };
  return 'ok';
})()`;

const p = await launchPlayer({ name: 'Counter', baseUrl: BASE, crew: CREW, query: { autojoin: '1', nobright: '1', preset: PRESET }, viewport: { width: 640, height: 360 } });
const page = p.page;
const ev = <T>(fn: string, ms = 20_000): Promise<T> => Promise.race([page.evaluate(fn) as Promise<T>, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`evaluate timed out (${ms} ms): ${fn.slice(0, 60)}`)), ms))]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** n drawn frames -> per-key averages */
async function sample(n = 4, ms = 25_000): Promise<{ frames: number; avg: Record<string, number>; draws: number[] }> {
  await ev('(window.__ad.refresh(), window.__ad.clear(), 1)');
  const t = Date.now();
  while (Date.now() - t < ms) {
    if ((await ev<number>('window.__ad.frames.length').catch(() => 0)) >= n) break;
    await sleep(150);
  }
  const fr = await ev<Frame[]>('window.__ad.frames.slice()');
  const avg: Record<string, number> = {};
  for (const f of fr) for (const [k, v] of Object.entries(f.by)) avg[k] = (avg[k] ?? 0) + v / Math.max(1, fr.length);
  return { frames: fr.length, avg, draws: fr.map((f) => f.draws) };
}
const sum = (avg: Record<string, number>, test: (k: string) => boolean) => Object.entries(avg).filter(([k]) => test(k)).reduce((a, [, v]) => a + v, 0);
const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));

try {
  await page.routeWebSocket((u) => !u.pathname.endsWith('/ws'), () => { /* mute Vite HMR: other builders edit all night */ });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 70_000);
  await page.waitForFunction(() => !!window.__game?.me() && !!window.__players, undefined, { timeout: 30_000 });
  lap('booted');
  const dbg = (r: string, a: unknown = {}) => page.evaluate(([r, a]) => window.__game!.dbg(r as string, a), [r, a] as const);
  await dbg('players.testLevel', { seed: 'vents-e2e-1', players: 2, risk: 1 });
  await page.waitForFunction(() => (window.__game!.state() as { phase: string; layout: unknown }).phase === 'contract' && !!(window.__game!.state() as { layout: unknown }).layout, undefined, { timeout: 20_000 });
  await dbg('monsters.freeze', { on: true }).catch(() => null);
  await dbg('net.validate', { on: false }).catch(() => null);
  await page.waitForFunction(() => window.__players!.rigReady(), undefined, { timeout: 15_000 }).catch(() => console.log('rig not ready: placeholders'));
  await sleep(1500); // arrival screen
  lap('contract');
  check(await ev<string>(INSTALL) === 'ok', 'draw hook installed');

  const lane = await ev<{ x: number; z: number; len: number } | null>('window.__players.lane()');
  results.lane = lane;
  check(lane && lane.len >= 6, `a free lane for the crew (${JSON.stringify(lane)})`);
  const lx = lane?.x ?? 0, lz = lane?.z ?? 0;
  const profiles = [
    { name: 'Ann', body: 'f', suit: ['#d4a017', '#2c3e50'], helmet: 'dome', visor: { glyphs: 'A', color: '#7dfcff' }, badge: 117 },
    { name: 'Bo', body: 'm', suit: ['#c0392b', '#ecf0f1'], helmet: 'box', visor: { glyphs: 'B0', color: '#ff4d4d' }, badge: 204 },
    { name: 'Cy', body: 'm', suit: ['#2e86c1', '#e67e22'], helmet: 'diver', visor: { glyphs: 'C', color: '#ffd84d' }, badge: 381 },
    { name: 'Dee', body: 'f', suit: ['#27ae60', '#7f8c8d'], helmet: 'box', visor: { glyphs: 'XYZ', color: '#9dff6b' }, badge: 452 },
    { name: 'Eli', body: 'm', suit: ['#8e44ad', '#1abc9c'], helmet: 'diver', visor: { glyphs: ':)', color: '#ff7df3' }, badge: 569 },
  ];
  // the crew 2.5-5.5 m down the lane, beams on, facing different ways (6 beams spread over the room)
  const spots: { p: V3; yaw: number }[] = [
    { p: [lx + 2.5, 0, lz - 0.45], yaw: -Math.PI / 2 },
    { p: [lx + 3.2, 0, lz + 0.5], yaw: -Math.PI * 0.7 },
    { p: [lx + 4.0, 0, lz - 0.2], yaw: 0 },
    { p: [lx + 4.8, 0, lz + 0.35], yaw: Math.PI },
    { p: [lx + 5.5, 0, lz - 0.4], yaw: Math.PI / 2 },
  ];
  await page.evaluate(({ lx, lz, profiles, spots }) => {
    window.__game!.teleport(lx, lz, Math.PI / 2);
    window.__game!.look(Math.PI / 2, -0.12);
    window.__players!.svc().setFlashlight(true);
    profiles.forEach((pr, i) => window.__players!.dummy(`crew${i}`, spots[i].p, spots[i].yaw, pr, { anim: 0, light: 1, pitch: -0.15 }));
  }, { lx, lz, profiles, spots });
  await sleep(2500); // build + compile the crew behind the frames we sample
  lap('crew placed');

  // ---- structure ----
  const structure = await ev<{ id: string; meshes: number; casters: number; skinned: number; skinnedCulled: number; sphere: boolean }[]>(`(() => {
    const { scene } = window.__render.three();
    const out = [];
    for (const root of scene.children) {
      if (!root.name || !root.name.startsWith('avatar:crew')) continue;
      let meshes = 0, casters = 0, skinned = 0, skinnedCulled = 0, sphere = true;
      root.traverse((o) => {
        if (!o.isMesh) return;
        meshes++; if (o.castShadow) casters++;
        if (o.isSkinnedMesh) { skinned++; if (o.frustumCulled) skinnedCulled++; if (!o.boundingSphere) sphere = false; }
      });
      out.push({ id: root.name.slice(7), meshes, casters, skinned, skinnedCulled, sphere });
    }
    return out;
  })()`);
  results.structure = structure;
  check(structure.length === 5, `5 crew avatars in the scene (${structure.length})`);
  for (const s of structure) {
    check(s.meshes <= 4 && s.casters <= 2 && s.skinned === 1 && s.skinnedCulled === 1 && s.sphere, `${s.id}: ${s.meshes} meshes (<= 4), ${s.casters} casters (<= 2), merged skinned body culled (${JSON.stringify(s)})`);
  }
  const rinfo = await ev<Record<string, unknown>>('window.__render.info()');
  results.render = { backend: rinfo.backend, preset: rinfo.preset, usedShadowed: rinfo.usedShadowed, poolShadowed: rinfo.poolShadowed, shadowRenders: rinfo.shadowRenders, size: rinfo.size };
  console.log(`render: ${JSON.stringify(results.render)}`);
  save();

  // ---- view A: the crew in front, 6 beams ----
  const A = await sample(5);
  const crewA = sum(A.avg, (k) => k.startsWith('avatar:crew'));
  const mainA = sum(A.avg, (k) => k.startsWith('avatar:crew') && k.endsWith('|main'));
  const shadowA = sum(A.avg, (k) => k.startsWith('avatar:crew') && k.endsWith('|shadow'));
  const vmA = sum(A.avg, (k) => k.startsWith('viewmodel'));
  results.viewA = { frames: A.frames, draws: A.draws, crewTotal: +crewA.toFixed(1), perAvatar: +(crewA / 5).toFixed(1), main: +mainA.toFixed(1), shadow: +shadowA.toFixed(1), viewmodel: +vmA.toFixed(1), by: round(Object.fromEntries(Object.entries(A.avg).filter(([k]) => !k.startsWith('scene')))) };
  console.log(`view A: ${JSON.stringify(results.viewA)}`);
  save();
  await screenshot(page, `${OUT}/avatar_draws_crew.png`);
  check(A.frames >= 3, `sampled frames (${A.frames})`);
  // gate P (v1.1 structure): ~50 draws per remote avatar in a 6-beam view (main 22, shadow 25), view model 18
  check(crewA / 5 <= 24, `per-avatar draws ${(crewA / 5).toFixed(1)} <= 24 (was ~50)`);
  check(vmA <= 10, `view model draws ${vmA.toFixed(1)} <= 10 (was 18)`);

  // ---- view B: the crew behind the camera ----
  await page.evaluate(() => window.__game!.look(-Math.PI / 2, -0.12));
  await sleep(600);
  const B = await sample(3);
  const mainB = sum(B.avg, (k) => k.startsWith('avatar:crew') && k.endsWith('|main'));
  const shadowB = sum(B.avg, (k) => k.startsWith('avatar:crew') && k.endsWith('|shadow'));
  results.viewB = { frames: B.frames, draws: B.draws, main: +mainB.toFixed(1), shadow: +shadowB.toFixed(1) };
  console.log(`view B (crew behind): ${JSON.stringify(results.viewB)}`);
  save();
  check(mainB < mainA / 2, `crew behind the camera leaves the main pass (main ${mainB.toFixed(1)} vs ${mainA.toFixed(1)} in front)`);

  // ---- close-ups: helmets (dome / box / diver) and a corpse (optional: only with time left) ----
  if (left() > 14) {
  await page.evaluate(({ lx, lz }) => {
    window.__game!.look(Math.PI / 2, -0.12);
    window.__players!.dummy('crew0', [lx + 2.0, 0, lz - 0.5], -Math.PI / 2, { name: 'Ann', body: 'f', suit: ['#d4a017', '#2c3e50'], helmet: 'dome', visor: { glyphs: 'A', color: '#7dfcff' }, badge: 117 }, { anim: 0, light: 0 });
    window.__players!.dummy('crew1', [lx + 2.0, 0, lz + 0.1], -Math.PI / 2, { name: 'Bo', body: 'm', suit: ['#c0392b', '#ecf0f1'], helmet: 'box', visor: { glyphs: 'B0', color: '#ff4d4d' }, badge: 204 }, { anim: 0, light: 0 });
    window.__players!.dummy('crew2', [lx + 2.0, 0, lz + 0.7], -Math.PI / 2, { name: 'Cy', body: 'm', suit: ['#2e86c1', '#e67e22'], helmet: 'diver', visor: { glyphs: 'C', color: '#ffd84d' }, badge: 381 }, { anim: 0, light: 0 });
    window.__players!.setCamera([lx + 0.6, 1.62, lz + 0.1], [lx + 2.0, 1.45, lz + 0.1]);
  }, { lx, lz });
  await sleep(1500);
  await screenshot(page, `${OUT}/avatar_draws_helmets.png`);
  // the back badge (one merged mesh with the chest patch) and a corpse lying in the beam
  await page.evaluate(({ lx, lz }) => {
    window.__players!.dummy('crew1', [lx + 2.0, 0, lz + 0.1], Math.PI / 2, { name: 'Bo', body: 'm', suit: ['#c0392b', '#ecf0f1'], helmet: 'box', visor: { glyphs: 'B0', color: '#ff4d4d' }, badge: 204 }, { anim: 0, light: 0 });
    window.__players!.dummy('crew3', [lx + 3.4, 0, lz + 0.2], 0, { name: 'Dee', body: 'f', suit: ['#27ae60', '#7f8c8d'], helmet: 'box', visor: { glyphs: 'XYZ', color: '#9dff6b' }, badge: 452 }, { anim: 12, stance: 4, light: 0 });
    window.__players!.setCamera([lx + 0.6, 1.5, lz + 0.1], [lx + 2.6, 0.7, lz + 0.15]);
  }, { lx, lz });
  await sleep(2200);
  await screenshot(page, `${OUT}/avatar_draws_back_corpse.png`);
  const corpse = await ev<{ inMain: boolean } | null>(`(() => {
    const { scene, camera } = window.__render.three();
    const root = scene.getObjectByName('avatar:crew3');
    if (!root) return null;
    let body = null; root.traverse((o) => { if (o.isSkinnedMesh) body = o; });
    if (!body) return null;
    camera.updateMatrixWorld(); root.updateMatrixWorld(true);
    const T = window.__render.three().THREE;
    const f = new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    return { inMain: f.intersectsObject(body) };
  })()`);
  results.corpse = corpse;
  check(corpse?.inMain === true, `the corpse in view is inside the main frustum test (${JSON.stringify(corpse)})`);
  } else console.log(`skipped the close-ups (${left().toFixed(0)} s left)`);

  const errs = await ev<string[]>('window.__game.errors()');
  const shaderErrs = [...errs, ...p.errors].filter((e) => /shader|wgsl|glsl|compile|attribute|hcol|hpbr|hemi|jmask|TSL/i.test(e));
  results.errors = { game: errs.slice(0, 8), page: p.errors.filter((e) => !/favicon|404/.test(e)).slice(0, 8) };
  check(shaderErrs.length === 0, `no shader / attribute errors (${shaderErrs.slice(0, 3).join(' | ')})`);
  lap('done');
} catch (e) {
  failed = true;
  console.log(`ERROR: ${e instanceof Error ? e.stack : e}`);
  await screenshot(page, `${OUT}/avatar_draws_error.png`).catch(() => null);
} finally {
  save();
  console.log(JSON.stringify(results, null, 1));
  await p.close();
}
console.log(failed ? 'FAIL players/avatar-draws' : 'PASS players/avatar-draws');
process.exit(failed ? 1 : 0);
