// Door-hitch gate (integrator, door-lag finding): opening a door or walking into a room the client has not drawn yet
// must compile NOTHING (0 node builds, 0 render pipelines, main + shadow passes). SOLO facility, one Chrome, doors
// opened through the real E path (__game.setInput({interact}) while __ix targets the door).
// Flow: bot creates the crew + facility (monsters frozen, paranormal quiet) -> the browser joins -> facility built and
// dressed (textures + props) -> the loading flow's warm-up: render.warmSite() (every mesh of the site once) then
// render.warmup() (spawn view + mirror warm set) -> N doors whose far side was never drawn: open1 (first reveal),
// close1, open2 (repeat), close2 -> a walk: through a freshly opened door into the far room and on through its open
// links (rooms never drawn) -> optional: a drawer opened in view (shots) and a poltergeist on a movable prop (shots).
// Per drawn frame it records the frame interval, the game loop's main-thread ms, the renderer's ms, and what the
// renderer CREATED (render objects, node builds, programs, pipelines, uploads), node builds / pipelines attributed to
// object + pass. Software lane (DEADAIR_RENDER=swiftshader via the guard): counts and CPU timings are meaningful, frame
// intervals / GPU time are not.
//   (server) NODE_ENV=development AI_MODE=mock SAVES_DIR=<scratch>/saves SESSION_FILE=<scratch>/session.json PORT=3812
//            ASSETS_DIR=C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage node apps/server/src/index.ts --dev
//   (build)  npx vite build --config apps/client/vite.config.ts --outDir <tmp>/dist --emptyOutDir
//   (proxy)  node tests/gates/p-proxy.mjs --port 3813 --dist <tmp>/dist --target http://127.0.0.1:3812
//   (probe)  node tools/gpu-guard.mjs --max-sec 120 -- node tests/gates/door-hitch.e2e.ts --base http://127.0.0.1:3813
//              --ws ws://127.0.0.1:3812/ws --tag sw --preset low --doors 4 --out <scratch>/door-hitch
// Exit code 0 when every check passed (1 otherwise); results in <out>/<tag>.json (written after every step).
// Dry runs (no browser, no guard): --dry 1 = the bot setup against the dev server (--ws) + the in-page scripts' syntax +
// the door choice replayed offline; --dry local = the same without any server (the facility generated in-process by
// the dev server's generator with config/balance/level.json; compare its hash with a real run's).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { SpaceLink } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { REPO, launchPlayer, waitForGame } from '../lib/launch.ts';
import { Bot, sleep } from './p-lib.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3813').replace(/\/$/, '');
const WS = arg('ws', BASE.replace(/^http/, 'ws') + '/ws');
if (/:(3000|3100)(\/|$)/.test(BASE) || /:(3000|3100)\//.test(WS)) throw new Error('refusing the live ports');
const TAG = arg('tag', 'run');
const SEED = arg('seed', 'dl-1');
const RISK = Number(arg('risk', '1'));
const PRESET = arg('preset', 'low');
const NDOORS = Number(arg('doors', '4'));
const BUDGET = Number(arg('budget', '112'));
const READY_SEC = Number(arg('ready', '45'));
/** ms the warm-up may take (render.warmSite) */
const WARM_MS = Number(arg('warmms', '45000'));
/** ms watched after each open / close */
const WAIT = Number(arg('wait', '950'));
/** cap of the spawn-view warm-up (render.warmup) after warmSite */
const SPAWN_WARM_MS = Number(arg('spawnwarm', '6000'));
const PARTS = new Set(arg('parts', 'warm,doors,walk,drawer,para,van').split(','));
const OUT = arg('out', join(REPO, 'tests/artifacts/gates/door-hitch'));
const VW = Number(arg('w', '640')), VH = Number(arg('h', '360'));
const EXTRA = Object.fromEntries(arg('query', '').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const el = () => (performance.now() - T0) / 1000;
const left = () => BUDGET - el();
const log = (s: string) => console.log(`[${TAG} ${el().toFixed(1).padStart(6)}s] ${s}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const R: Record<string, Any> = { tag: TAG, base: BASE, seed: SEED, risk: RISK, preset: PRESET, viewport: [VW, VH], parts: [...PARTS], steps: [], doors: [], checks: [] };
const save = () => writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(R, null, 1));
const step = (s: string) => { R.steps.push(`${el().toFixed(1)} ${s}`); log(s); };
const check = (name: string, pass: boolean, info: unknown = '') => { R.checks.push({ name, pass, info }); log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${typeof info === 'string' ? info : JSON.stringify(info)}`); };

interface Door { id: number; a: number; b: number; x: number; y: number; dir: 'v' | 'h'; len: number; kind: string; initiallyOpen: boolean }
interface Lay { W: number; H: number; owner: number[]; doors: Door[]; spaces: { id: number; kind: string; type: string; open?: boolean; rect: { x: number; y: number; w: number; h: number } }[]; items: { kind: string; x: number; z: number }[]; van: { cab: { x: number; y: number; w: number; h: number } }; hash: string }
const centre = (d: Door) => ({ cx: d.dir === 'v' ? d.x : d.x + d.len / 2, cz: d.dir === 'v' ? d.y + d.len / 2 : d.y });
/** a spot `back` m into the side owned by space `sp`, facing the door (yaw: forward = (sin, cos)) */
function spotFor(L: Lay, d: Door, sp: number, back = 0.8): { x: number; z: number; yaw: number } | null {
  const { cx, cz } = centre(d);
  for (const s of [-1, 1]) {
    const x = d.dir === 'v' ? cx + s * back : cx, z = d.dir === 'h' ? cz + s * back : cz;
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= L.W || iz >= L.H) continue;
    if (L.owner[iz * L.W + ix] === sp) return { x, z, yaw: Math.atan2(cx - x, cz - z) };
  }
  return null;
}
/** the probe's door candidates (closed doors / fire doors between two indoor spaces), nearest the player spawn first */
function candidatesOf(L: Lay): Door[] {
  const ent = L.items.find((i) => i.kind === 'spawn_player') ?? { x: L.van.cab.x, z: L.van.cab.y };
  const dist = (d: Door) => Math.hypot(centre(d).cx - ent.x, centre(d).cz - ent.z);
  return L.doors.filter((d) => (d.kind === 'door' || d.kind === 'fire') && !d.initiallyOpen && d.a >= 0 && d.b >= 0 && L.spaces[d.a] && L.spaces[d.b] && !L.spaces[d.a].open && !L.spaces[d.b].open)
    .sort((p, q) => dist(p) - dist(q));
}
/** the walk's rooms: the far room, then one indoor neighbour through an open doorway */
function walkRoute(L: Lay, far: number): number[] {
  const route = [far];
  for (const x of L.doors) {
    if ((x.a !== far && x.b !== far) || !(x.kind === 'open' || x.initiallyOpen)) continue;
    const o = x.a === far ? x.b : x.a;
    if (o >= 0 && !route.includes(o) && !L.spaces[o]?.open) { route.push(o); break; }
  }
  return route;
}
/** the walk's door: the first candidate whose approach() passes (its far side never drawn), the ones with both sides
 *  unused first, then any door not opened yet. Taking the first unused candidate alone always gave 'walk: no door
 *  left' on dl-1: its far side had been drawn already (verify-browser finding). */
async function pickWalkDoor<A>(cands: readonly Door[], used: ReadonlySet<number>, done: readonly number[], approach: (d: Door) => Promise<A | null>,
  more: () => boolean, why: () => string, note: (s: string) => void): Promise<{ d: Door; ap: A } | null> {
  const fresh = cands.filter((x) => !used.has(x.a) && !used.has(x.b));
  const rest = cands.filter((x) => !fresh.includes(x) && !done.includes(x.id));
  for (const d of [...fresh, ...rest]) {
    if (!more()) { note('walk: stopped trying doors (budget)'); break; }
    let ap: A | null = null;
    try { ap = await approach(d); } catch (e) { note(`walk: door ${d.id} approach: ${String(e).slice(0, 160)}`); continue; }
    if (ap) return { d, ap };
    note(`walk: door ${d.id} rejected (${why()})`);
  }
  return null;
}
/** dry runs: the door choice replayed offline. The client draws what visibleSpaces() returns (a BFS from the camera's
 *  space through open links, depth 3), so `seen` = the spawn view + every approach spot so far, and each measured door's
 *  spot once more with that door open; the door loop's rules as in the run, the walk through pickWalkDoor itself. */
async function replayDoors(L: Lay, links: SpaceLink[][], ndoors: number): Promise<Record<string, unknown>> {
  const open = L.doors.map((d) => d.kind === 'open' || d.initiallyOpen);
  const linkOpen = (l: SpaceLink) => l.kind === 'fence' || l.kind === 'open' || (l.door >= 0 && open[l.door] === true);
  const roomAt = (x: number, z: number) => { const ix = Math.floor(x), iz = Math.floor(z); return ix < 0 || iz < 0 || ix >= L.W || iz >= L.H ? -1 : L.owner[iz * L.W + ix]; };
  const seen = new Set<number>();
  const look = (x: number, z: number) => {
    let s0 = roomAt(x, z);
    for (let r = 1; r <= 2 && s0 < 0; r++) for (let dz = -r; dz <= r && s0 < 0; dz++) for (let dx = -r; dx <= r && s0 < 0; dx++) s0 = roomAt(x + dx, z + dz);
    if (s0 < 0) { for (const s of L.spaces) seen.add(s.id); return; }
    const vis = new Set([s0]);
    let frontier = [s0];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: number[] = [];
      for (const s of frontier) for (const l of links[s] ?? []) if (!vis.has(l.other) && linkOpen(l)) { vis.add(l.other); next.push(l.other); }
      frontier = next;
    }
    for (const s of vis) seen.add(s);
  };
  const spawn = L.items.find((i) => i.kind === 'spawn_player');
  if (spawn) look(spawn.x, spawn.z);
  let why = '';
  const approach = async (d: Door) => {
    const sp = spotFor(L, d, d.a) ?? spotFor(L, d, d.b);
    if (!sp) { why = 'no spot'; return null; }
    const near = roomAt(sp.x, sp.z), far = near === d.a ? d.b : d.a;
    if (seen.has(far)) { why = 'far side drawn'; return null; }
    look(sp.x, sp.z);
    if (seen.has(far)) { why = 'far side visible from the near spot'; return null; }
    return { near, far, x: sp.x, z: sp.z };
  };
  const cands = candidatesOf(L);
  const used = new Set<number>();
  const done: number[] = [];
  const doors: string[] = [];
  for (const d of cands) {
    if (done.length >= ndoors) break;
    if (used.has(d.a) || used.has(d.b)) continue;
    const ap = await approach(d);
    if (!ap) { doors.push(`${d.id}: ${why}`); continue; }
    open[d.id] = true;
    look(ap.x, ap.z);
    open[d.id] = false;
    used.add(d.a); used.add(d.b);
    done.push(d.id);
    doors.push(`${d.id}: measured (${ap.near} -> ${ap.far})`);
  }
  const notes: string[] = [];
  const pick = await pickWalkDoor(cands, used, done, approach, () => true, () => why, (s) => notes.push(s));
  return { candidates: cands.length, measured: done, doors, walk: pick ? { door: pick.d.id, near: pick.ap.near, far: pick.ap.far, route: walkRoute(L, pick.ap.far) } : 'no door left', walkNotes: notes };
}

// ---------------------------------------------------------------- in-page instrumentation (after the investigator's probe)
const INSTALL = `(() => {
  if (window.__dh) return 'already';
  const t = window.__render && window.__render.three && window.__render.three();
  if (!t) return 'no __render.three';
  const { renderer, scene, camera } = t;
  const be = renderer.backend;
  const C = {};
  const shadowCams = new Set();
  const KEYS = ['ro','roMs','nb','nbMs','vs','fs','progMs','pipe','pipeMs','bind','attr','attrKB','attrMs','tex','texMs','texUp','texUpMs','ren'];
  const zero = () => { for (const k of KEYS) C[k] = 0; C.renderSeen = false; };
  zero();
  const frames = [], marks = [], nbLog = [], pipeLog = [];
  const seen = new Set();
  let last = 0, watch = -1, frameNo = 0;
  const now = () => performance.now();
  const wrap = (obj, key, after) => {
    const f = obj && obj[key];
    if (typeof f !== 'function' || f.__dh) return false;
    const w = function (...a) { const t0 = now(); try { return f.apply(this, a); } finally { after(now() - t0, a); } };
    w.__dh = true; obj[key] = w; return true;
  };
  const camKind = (c) => (c === camera ? 'main' : shadowCams.has(c) ? 'shadow' : 'other');
  // lv: the object is part of the level (under the scene's 'level' root): the door-lag goal is about these
  const inLevel = (o) => { for (let p = o; p; p = p.parent) if (p.name === 'level' && p.parent === scene) return 1; return 0; };
  const roInfo = (ro) => { try { const o = ro && ro.object; return { o: String((o && o.name) || (o && o.type) || '?').slice(0, 40), im: o && o.isInstancedMesh ? 1 : 0, lv: inLevel(o), m: String((ro.material && (ro.material.name || ro.material.type)) || '?').slice(0, 32), c: camKind(ro.camera) }; } catch (e) { return { o: 'err' }; } };
  const kb = (a) => { const arr = a && (a.array || (a.data && a.data.array)); return arr && arr.byteLength ? arr.byteLength / 1024 : 0; };
  const hooked = {
    ro: wrap(renderer._objects, 'createRenderObject', (ms) => { C.ro++; C.roMs += ms; }),
    prog: wrap(be, 'createProgram', (ms, a) => { if (a[0] && a[0].stage === 'vertex') C.vs++; else C.fs++; C.progMs += ms; }),
    pipe: wrap(be, 'createRenderPipeline', (ms, a) => { C.pipe++; C.pipeMs += ms; pipeLog.push(Object.assign(roInfo(a[0]), { n: frameNo, ms: +ms.toFixed(1) })); if (pipeLog.length > 4000) pipeLog.splice(0, 1000); }),
    bind: wrap(be, 'createBindings', () => { C.bind++; }),
    attr: wrap(be, 'createAttribute', (ms, a) => { C.attr++; C.attrKB += kb(a[0]); C.attrMs += ms; }),
    iattr: wrap(be, 'createIndexAttribute', (ms, a) => { C.attr++; C.attrKB += kb(a[0]); C.attrMs += ms; }),
    tex: wrap(be, 'createTexture', (ms) => { C.tex++; C.texMs += ms; }),
    utex: wrap(be, 'updateTexture', (ms) => { C.texUp++; C.texUpMs += ms; }),
  };
  const nm = renderer._nodes;
  if (nm && typeof nm._createNodeBuilder === 'function' && !nm._createNodeBuilder.__dh) {
    const f = nm._createNodeBuilder;
    const w = function (...a) {
      const b = f.apply(this, a);
      const info = roInfo(a[0]);
      for (const k of ['build', 'buildAsync']) {
        const g = b && b[k];
        if (typeof g !== 'function') continue;
        const done = (t0) => { const ms = now() - t0; C.nb++; C.nbMs += ms; nbLog.push(Object.assign({}, info, { n: frameNo, ms: +ms.toFixed(1) })); if (nbLog.length > 4000) nbLog.splice(0, 1000); };
        b[k] = function (...x) { const t0 = now(); const r = g.apply(this, x); if (r && typeof r.then === 'function') return r.finally(() => done(t0)); done(t0); return r; };
      }
      return b;
    };
    w.__dh = true; nm._createNodeBuilder = w; hooked.nb = true;
  }
  let depth = 0;
  const refreshShadows = () => { shadowCams.clear(); scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow && o.shadow.camera) shadowCams.add(o.shadow.camera); }); };
  refreshShadows();
  const r0 = renderer.render;
  renderer.render = function () {
    depth++;
    const t0 = now();
    try { return r0.apply(this, arguments); } finally { depth--; if (depth === 0) { C.ren += now() - t0; C.renderSeen = true; } }
  };
  const raf0 = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return raf0(function (ts) {
      const t0 = now();
      C.renderSeen = false;
      try { cb(ts); } finally {
        const dur = now() - t0;
        if (C.renderSeen) {
          const lv = window.__levelDebug;
          const rec = { n: frameNo++, t: +t0.toFixed(1), int: last ? +(t0 - last).toFixed(1) : 0, loop: +dur.toFixed(2) };
          for (const k of KEYS) if (C[k]) rec[k] = +C[k].toFixed(k.endsWith('KB') ? 0 : 2);
          rec.draws = renderer.info && renderer.info.render ? renderer.info.render.drawCalls : 0;
          if (watch >= 0 && lv) { try { const d = lv.door(watch); if (d) rec.door = +((d.t ?? (d.open ? 1 : 0))).toFixed(3); } catch (e) {} }
          if (lv && lv.visible) { try { const c = camera.position; const v = lv.visible([c.x, c.y, c.z]); let n = 0; for (const s of v) if (!seen.has(s)) { seen.add(s); n++; } rec.vis = v.length; if (n) rec.seen = n; } catch (e) {} }
          frames.push(rec);
          if (frames.length > 9000) frames.splice(0, 3000);
          last = t0; zero();
        }
      }
    });
  };
  const counts = () => {
    const pp = renderer._pipelines, ob = renderer._objects;
    return { pipelines: pp && pp.caches ? pp.caches.size : -1, vs: pp && pp.programs ? pp.programs.vertex.size : -1, fs: pp && pp.programs ? pp.programs.fragment.size : -1,
      renderObjects: ob && ob._renderObjects ? ob._renderObjects.size : -1, nodeStates: nm && nm.nodeBuilderCache ? nm.nodeBuilderCache.size : -1 };
  };
  window.__dh = {
    hooked, frames, marks, nbLog, pipeLog, counts, refreshShadows,
    mark(label) { marks.push({ t: +now().toFixed(1), label, frame: frameNo, c: counts() }); },
    watch(id) { watch = id; },
    seen(s) { return seen.has(s); },
    seenSet() { return [...seen]; },
    since(t) { return frames.filter((f) => f.t >= t); },
    quietMs() { let q = 0; for (let i = frames.length - 1; i >= 0; i--) { const f = frames[i]; if (f.ro || f.pipe || f.nb || f.vs || f.fs || f.tex || f.attr) break; q = now() - f.t; } return q; },
  };
  return hooked;
})()`;

async function ev<T = Any>(page: Page, fn: string, ms = 30_000): Promise<T> {
  return Promise.race([page.evaluate(fn) as Promise<T>, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`evaluate timed out (${ms} ms): ${fn.slice(0, 60)}`)), ms))]);
}
/** wait until nothing was created for quietMs (or maxMs) */
async function settle(page: Page, quietMs = 600, maxMs = 3000): Promise<number> {
  const t = performance.now();
  for (;;) {
    const q = await ev<number>(page, 'window.__dh.quietMs()').catch(() => 0);
    if (q >= quietMs || performance.now() - t > maxMs) return Math.round(performance.now() - t);
    await sleep(120);
  }
}
const med = (a: number[]) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const SUM = ['ro', 'nb', 'nbMs', 'vs', 'fs', 'pipe', 'pipeMs', 'attr', 'attrKB', 'tex', 'texUp'];
/** frames from t0 to t1 (page clock): sums of what was created + the slowest frame vs the median before t0 */
async function windowOf(page: Page, t0: number, t1: number): Promise<Record<string, Any>> {
  const fr = await ev<Any[]>(page, `window.__dh.frames.filter((f) => f.t >= ${t0 - 1500} && f.t <= ${t1})`);
  const pre = fr.filter((f) => f.t < t0 - 20), win = fr.filter((f) => f.t >= t0 - 5);
  const sum: Record<string, number> = {};
  for (const k of SUM) { const v = win.reduce((a, f) => a + (f[k] ?? 0), 0); if (v) sum[k] = +v.toFixed(1); }
  const nset = new Set(win.map((f) => f.n));
  const attrib = await ev<Record<string, Any>>(page, `(() => { const ns = new Set(${JSON.stringify([...nset])}); const g = (log) => { const o = {}; for (const e of log.filter((x) => ns.has(x.n))) { const k = (e.lv ? 'L:' : '') + String(e.o).split(':')[0] + (e.im ? '[IM]' : '') + '/' + e.m + '/' + e.c; o[k] = (o[k] || 0) + 1; } return Object.entries(o).map(([k, v]) => k + ' x' + v).join('; '); }; const lv = (log) => log.filter((x) => ns.has(x.n) && x.lv).length; return { nb: g(window.__dh.nbLog), pipe: g(window.__dh.pipeLog), levelNb: lv(window.__dh.nbLog), levelPipe: lv(window.__dh.pipeLog) }; })()`);
  const worst = win.reduce<Any>((a, f) => (!a || f.loop > a.loop ? f : a), null);
  return { frames: win.length, created: sum, worstLoop: worst ? worst.loop : 0, worstInt: win.reduce((a, f) => Math.max(a, f.int), 0), preLoop: +med(pre.map((f) => f.loop)).toFixed(1), preInt: +med(pre.map((f) => f.int)).toFixed(1), seen: win.reduce((a, f) => a + (f.seen ?? 0), 0), attrib };
}

/** in-page scripts with arguments (syntax-checked by --dry 1) */
const JS = {
  warmSlow: (tw: number) => `(() => { const fr = window.__dh.frames.filter((f) => f.t >= ${tw} && f.loop > 250); return fr.slice(-24).map((f) => { const nb = {}; for (const e of window.__dh.nbLog) if (e.n === f.n) { const k = (e.lv ? 'L:' : '') + String(e.o).split(':')[0] + (e.im ? '[IM]' : '') + '/' + e.c; nb[k] = (nb[k] || 0) + 1; } return { n: f.n, loop: f.loop, ren: f.ren, nb: f.nb, pipe: f.pipe, pipeMs: f.pipeMs, what: nb }; }); })()`,
  toggle: (id: number) => `(() => { const tg = window.__ix && window.__ix.target(); if (tg && tg.id === 'door:${id}') { window.__game.setInput({ interact: true }); return 'E'; } window.__ix.use('door:${id}'); return 'use'; })()`,
  partMatrix: (id: string, idx: number) => `(() => { const m = new (window.__render.three().THREE.Matrix4)(); window.__levelDebug.level().containerPartMatrix(${JSON.stringify(id)}, ${idx}, m); return m.elements; })()`,
  moving: () => `(() => { let n = 0; window.__render.three().scene.traverse((o) => { if (String(o.name).startsWith('movable:')) n++; }); return n; })()`,
  landed: (x: number, z: number) => `(() => { const T = window.__render.three(); const m = new T.THREE.Matrix4(); let best = 1e9; T.scene.traverse((o) => { if (!o.isInstancedMesh || !String(o.name).startsWith('glb:')) return; for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); const d = Math.hypot(m.elements[12] - ${x}, m.elements[14] - ${z}); if (d < best) best = d; } }); return +best.toFixed(3); })()`,
};

// ---------------------------------------------------------------- run
const DRY = arg('dry', '0');
const crew = `D${Math.random().toString(36).slice(2, 5).toUpperCase()}H`;
const bot = new Bot('DoorHost');
let L: Lay | null = null;
const setup = DRY === 'local'
  ? (async () => {
    // the dev server's dbg level.generate without a server: the same generator and balance file (procgen is loaded
    // here only, so a probe run never depends on it)
    const { generateFacility, resolveTuning } = await import('../../packages/shared/src/procgen/index.ts');
    const t0 = performance.now();
    const g = generateFacility({ seed: SEED, players: 1, risk: RISK }, resolveTuning(JSON.parse(readFileSync(join(REPO, 'config/balance/level.json'), 'utf8')) as Record<string, unknown>));
    R.layout = { hash: g.hash, genMs: +(performance.now() - t0).toFixed(2), local: true };
    L = g as unknown as Lay;
  })()
  : (async () => {
    await bot.connect(WS, crew);
    await bot.dbg('net.validate', { on: false });
    const g = await bot.dbg<Any>('level.generate', { seed: SEED, players: 1, risk: RISK });
    R.layout = { hash: g.hash, genMs: g.genMs };
    await bot.dbg('monsters.freeze', { on: true }).catch((e) => R.steps.push(`freeze: ${e}`));
    await bot.dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => {});
    L = (await bot.req<{ layout: Lay }>('level.get', {})).layout;
  })();
if (DRY === '1' || DRY === 'local') {
  // no browser: the setup, the in-page scripts' syntax and the door choice replayed offline
  await setup;
  for (const js of [INSTALL, JS.warmSlow(1), JS.toggle(3), JS.partMatrix('prop:1', 0), JS.moving(), JS.landed(1, 2)]) new Function(`return ${js}`);
  const fake = { evaluate: async (fn: string) => { new Function(`return (${fn})`); return fn.startsWith('window.__dh.frames') ? [{ n: 1, t: 1500, loop: 5, int: 16 }] : { levelNb: 0, levelPipe: 0 }; } };
  console.log('windowOf (fake page):', JSON.stringify(await windowOf(fake as unknown as Page, 1000, 2000)));
  const Ld = L as unknown as Lay;
  const c = candidatesOf(Ld);
  console.log(JSON.stringify({ layout: R.layout, spaces: Ld.spaces.length, doors: Ld.doors.length, candidates: c.length, spots: c.slice(0, 6).map((d) => ({ id: d.id, a: d.a, b: d.b, spot: spotFor(Ld, d, d.a) ?? spotFor(Ld, d, d.b) })) }));
  const { spaceLinks } = await import('../../packages/shared/src/nav/index.ts');
  console.log('door choice (replayed offline):', JSON.stringify(await replayDoors(Ld, spaceLinks(Ld as unknown as LevelLayout), NDOORS)));
  bot.close();
  process.exit(0);
}
const player = await launchPlayer({ name: 'DoorProbe', baseUrl: BASE, crew, viewport: { width: VW, height: VH }, query: { preset: PRESET, autoq: '0', nobright: '1', ...EXTRA } });
const page = player.page;
const shot = async (name: string) => { try { const p = join(OUT, `${TAG}-${name}.png`); await page.screenshot({ path: p, timeout: 15_000 }); R.shots = [...(R.shots ?? []), p]; } catch (e) { R.steps.push(`shot ${name}: ${e}`); } };
let failed = false;
try {
  await setup;
  step(`crew ${crew} facility ${R.layout.hash} (${SEED})`);
  await waitForGame(page, 80_000);
  R.backend = await ev(page, 'window.__game.backend()');
  R.install = await ev(page, INSTALL);
  step(`game ready (${R.backend}, ${PRESET}); hooks ${Object.values(R.install).every(Boolean) ? 'ok' : JSON.stringify(R.install)}`);
  await ev(page, `window.__game.join(${JSON.stringify(crew)})`, 40_000);
  step('joined');
  bot.close();
  const tr = performance.now();
  let ready = false;
  while (!ready && (performance.now() - tr) / 1000 < READY_SEC && left() > 40) {
    ready = await ev<boolean>(page, `(() => { const d = window.__levelDebug; const i = d && d.info(); return !!(i && i.kind === 'facility' && d.texturesReady()); })()`).catch(() => false);
    if (!ready) await sleep(300);
  }
  R.ready = ready;
  await ev(page, 'window.__dh.refreshShadows()');
  R.levelInfo = await ev(page, 'JSON.parse(JSON.stringify(window.__levelDebug.info()))').catch(() => null);
  R.batches = await ev(page, 'window.__levelDebug.batches ? window.__levelDebug.batches() : null').catch(() => null);
  step(`facility ready=${ready}; ${R.batches ? `${R.batches.length} site batches` : 'no site batches (old build)'}`);
  // flashlight on (live play explores with the local beam + its shadow pass on)
  const lightOn = () => ev<boolean | null>(page, `(() => { const s = window.__game.state(); const me = (s.players || []).find((p) => p.id === s.me); return me ? !!me.light : null; })()`).catch(() => null);
  await ev(page, '(window.__ix && window.__ix.flashlight && window.__ix.flashlight(true), 1)').catch(() => {});
  await sleep(300);
  if ((await lightOn()) === false) { await ev(page, '(window.__game.setInput({ flashlight: true }), 1)').catch(() => {}); await sleep(400); }
  R.light = await lightOn();

  // ---- the loading flow's warm-up: warmSite (every mesh of the site) + warmup (spawn view, mirror warm set)
  if (PARTS.has('warm')) {
    const c0 = await ev(page, 'window.__dh.counts()');
    const tw = await ev<number>(page, `(window.__dh.mark('warm'), performance.now())`);
    const t0 = performance.now();
    R.warmSite = await ev(page, `(async () => { const s = window.__render.v12(); if (!s.warmSite) return 'no warmSite'; return await s.warmSite(${WARM_MS}); })()`, WARM_MS + 15_000).catch((e) => String(e));
    R.warmSiteSec = +((performance.now() - t0) / 1000).toFixed(1);
    R.warmSiteInfo = await ev(page, 'window.__render.siteWarm ? window.__render.siteWarm() : null').catch(() => null);
    const tsw = performance.now();
    if (SPAWN_WARM_MS > 0) await ev(page, `(async () => { const s = window.__render.v12(); await Promise.race([s.warmup(), new Promise((r) => setTimeout(r, ${SPAWN_WARM_MS}))]); return 1; })()`, SPAWN_WARM_MS + 8000).catch((e) => R.steps.push(`warmup: ${e}`));
    R.spawnWarmSec = +((performance.now() - tsw) / 1000).toFixed(1);
    R.warmSettleMs = await settle(page, 500, 2500);
    // the slowest frames of the warm (what they compiled, per pass)
    R.warmSlow = await ev(page, JS.warmSlow(tw)).catch((e) => String(e));
    const c1 = await ev(page, 'window.__dh.counts()');
    const w = await windowOf(page, tw, await ev<number>(page, 'performance.now()'));
    R.warm = { before: c0, after: c1, window: w };
    step(`warmSite ${JSON.stringify(R.warmSite)} in ${R.warmSiteSec}s; pipelines ${c0.pipelines} -> ${c1.pipelines}, node states ${c0.nodeStates} -> ${c1.nodeStates}; worst frame ${w.worstLoop} ms`);
    check('warmSite completed', typeof R.warmSite === 'object' && R.warmSite?.done === true, R.warmSite);
  }
  R.countsAtStart = await ev(page, 'window.__dh.counts()');
  save();

  const Lr = L as unknown as Lay;
  const cands = candidatesOf(Lr);
  R.candidates = cands.length;
  const used = new Set<number>();
  const cam = `(() => { const c = window.__render.three().camera.position; return [c.x, c.y, c.z]; })()`;

  /** toggle a door through the E path; resolves when the client applied the new state */
  const toggle = async (d: Door, label: string, want: boolean): Promise<Record<string, Any>> => {
    const t = await ev<number>(page, `(window.__dh.watch(${d.id}), window.__dh.mark(${JSON.stringify(`${label}:door:${d.id}`)}), performance.now())`);
    const how = await ev<string>(page, JS.toggle(d.id));
    const t1 = performance.now();
    let applied: number | null = null;
    while (performance.now() - t1 < 2500) {
      applied = await ev<number | null>(page, `(() => { const s = window.__levelDebug.door(${d.id}); return s && s.open === ${want} ? performance.now() : null; })()`).catch(() => null);
      if (applied) break;
      await sleep(30);
    }
    return { t, how, applied };
  };
  /** stand at the door's near side facing it; null when the far side was ever drawn (the reason: rejectWhy) */
  let rejectWhy = '';
  const approach = async (d: Door): Promise<{ near: number; far: number; settleMs: number } | null> => {
    const sp = spotFor(Lr, d, d.a) ?? spotFor(Lr, d, d.b);
    if (!sp) { rejectWhy = 'no spot'; return null; }
    const near = Lr.owner[Math.floor(sp.z) * Lr.W + Math.floor(sp.x)];
    const far = near === d.a ? d.b : d.a;
    if (await ev<boolean>(page, `window.__dh.seen(${far})`)) { rejectWhy = 'far side drawn'; return null; }
    await ev(page, `(window.__game.teleport(${sp.x}, ${sp.z}, ${sp.yaw}), window.__game.look(${sp.yaw}, -0.04), 1)`);
    await sleep(200);
    const { cx, cz } = centre(d);
    await ev(page, `(window.__ix.aim(${cx}, 1.25, ${cz}), 1)`).catch(() => {});
    const settleMs = await settle(page, 500, 2500);
    const vis = await ev<number[]>(page, `window.__levelDebug.visible(${cam})`);
    if (vis.includes(far) || await ev<boolean>(page, `window.__dh.seen(${far})`)) { rejectWhy = 'far side visible from the near spot'; return null; }
    return { near, far, settleMs };
  };

  // ---- first opens (every far side never drawn before) + a repeat open as the control
  const doorsDone: number[] = [];
  if (PARTS.has('doors')) {
    for (const d of cands) {
      if (doorsDone.length >= NDOORS) break;
      if (left() < 9) { R.steps.push(`budget: stopped the doors at ${doorsDone.length}`); break; }
      if (used.has(d.a) || used.has(d.b)) continue;
      const ap = await approach(d).catch((e) => { R.steps.push(`door ${d.id} approach: ${e}`); return null; });
      if (!ap) continue;
      try {
        const rec: Record<string, Any> = { door: d.id, kind: d.kind, ...ap, c0: await ev(page, 'window.__dh.counts()') };
        for (const [label, want, wait] of [['open1', true, WAIT], ['close1', false, Math.round(WAIT * 0.7)], ['open2', true, WAIT], ['close2', false, 400]] as const) {
          if (label === 'open2' && doorsDone.length >= 2 && left() < 28) { rec.skipped = 'repeat (budget)'; break; }
          const tg = await toggle(d, label, want);
          await sleep(wait);
          const t1 = await ev<number>(page, 'performance.now()');
          rec[label] = { ...tg, ...(await windowOf(page, tg.t, t1)) };
        }
        rec.c1 = await ev(page, 'window.__dh.counts()');
        rec.seenFar = await ev<boolean>(page, `window.__dh.seen(${ap.far})`);
        R.doors.push(rec);
        used.add(d.a); used.add(d.b);
        doorsDone.push(d.id);
        const o1 = rec.open1;
        log(`door ${d.id} (${ap.near} -> ${ap.far}, far drawn ${rec.seenFar}): open1 created ${JSON.stringify(o1.created)} worst ${o1.worstLoop} ms (before ${o1.preLoop}); open2 ${JSON.stringify(rec.open2?.created ?? null)}`);
        save();
      } catch (e) { R.steps.push(`door ${d.id}: ${String(e).slice(0, 200)}`); used.add(d.a); used.add(d.b); }
    }
    check(`${NDOORS}+ first door opens measured`, doorsDone.length >= Math.min(NDOORS, 4), doorsDone);
    for (const r of R.doors) {
      const o = r.open1;
      // the goal: no level shader (room, door, prop batch) compiles; anything else is reported (other packages)
      check(`door ${r.door} first open: 0 level node builds, 0 level pipelines`, o.attrib.levelNb === 0 && o.attrib.levelPipe === 0, { created: o.created, attrib: o.attrib, farDrawn: r.seenFar, worstLoop: o.worstLoop, preLoop: o.preLoop });
      R.allZero = (R.allZero ?? true) && !(o.created.nb > 0) && !(o.created.pipe > 0);
      if (r.open2) check(`door ${r.door} repeat open compiles nothing`, !(r.open2.created.nb > 0) && !(r.open2.created.pipe > 0), r.open2.created);
    }
  }

  // ---- a walk: through a freshly opened door into rooms never drawn
  if (PARTS.has('walk') && left() > 8) {
    const pick = await pickWalkDoor(cands, used, doorsDone, approach, () => left() > 9, () => rejectWhy, (s) => R.steps.push(s));
    if (pick) {
      const { d, ap } = pick;
      const tg = await toggle(d, 'walk-open', true);
      await sleep(WAIT);
      const w0 = await windowOf(page, tg.t, await ev<number>(page, 'performance.now()'));
      const steps: Any[] = [{ step: 'open', ...w0 }];
      // step into the far room's centre, then into one neighbour through an open doorway
      const route = walkRoute(Lr, ap.far);
      for (const s of route) {
        if (left() < 5) break;
        const r = Lr.spaces[s].rect;
        const t = await ev<number>(page, `(window.__dh.mark('walk:${s}'), window.__game.teleport(${r.x + r.w / 2}, ${r.y + r.h / 2}, 0), performance.now())`);
        await sleep(900);
        steps.push({ step: `into ${s}`, ...(await windowOf(page, t, await ev<number>(page, 'performance.now()'))) });
      }
      R.walk = { door: d.id, near: ap.near, far: ap.far, route, steps };
      const created = steps.reduce((a, s) => ({ nb: a.nb + (s.created.nb ?? 0), pipe: a.pipe + (s.created.pipe ?? 0), levelNb: a.levelNb + s.attrib.levelNb, levelPipe: a.levelPipe + s.attrib.levelPipe, seen: a.seen + s.seen }), { nb: 0, pipe: 0, levelNb: 0, levelPipe: 0, seen: 0 });
      check('walking into never-drawn rooms: 0 level node builds, 0 level pipelines', created.levelNb === 0 && created.levelPipe === 0, { ...created, attrib: steps.map((s) => s.attrib.nb).filter(Boolean) });
      check('the walk revealed rooms never drawn before', created.seen > 0, created.seen);
      save();
    } else R.steps.push('walk: no door left');
  }

  // ---- a drawer in view (shots), a poltergeist on a movable prop (shots)
  if (PARTS.has('drawer') && left() > 8) {
    const vis = await ev<number[]>(page, `window.__levelDebug.visible(${cam})`);
    const conts = await ev<Any[]>(page, 'JSON.parse(JSON.stringify(window.__levelDebug.level().containers()))');
    const c = conts.find((x) => vis.includes(x.space) && Lr.spaces[x.space]?.kind === 'room') ?? conts.find((x) => vis.includes(x.space));
    if (c) {
      const fx = c.front?.[0] ?? c.x, fz = c.front?.[1] ?? c.z;
      const dx = fx - c.p[0], dz = fz - c.p[2], n = Math.hypot(dx, dz) || 1;
      const eye = [c.p[0] + (dx / n) * 1.3, 1.45, c.p[2] + (dz / n) * 1.3];
      await ev(page, `(window.__levelDebug.camera(${JSON.stringify(eye)}, ${JSON.stringify(c.p)}), 1)`);
      await sleep(600);
      await shot(`drawer-${c.prop}-closed`);
      const t = await ev<number>(page, `(window.__levelDebug.level().setContainerOpen(${JSON.stringify(c.id)}, ${1 << c.main}), performance.now())`);
      await sleep(900);
      await shot(`drawer-${c.prop}-open`);
      const m = await ev<number[]>(page, JS.partMatrix(c.id, c.main));
      R.drawer = { id: c.id, prop: c.prop, anim: await ev(page, `window.__levelDebug.level().containerAnim(${JSON.stringify(c.id)}, ${c.main})`), part: [m[12], m[13], m[14]], ...(await windowOf(page, t, await ev<number>(page, 'performance.now()'))) };
      check(`drawer (${c.prop}) slides open`, R.drawer.anim === 1, R.drawer.anim);
      await ev(page, '(window.__levelDebug.camera(null), 1)');
      save();
    } else R.steps.push('drawer: none in view');
  }
  if (PARTS.has('para') && left() > 7) {
    const r = await ev<Any>(page, `window.__game.dbg('paranormal.fire', { kind: 'poltergeist', self: true, force: true })`, 8000).catch((e) => ({ ok: false, reason: String(e) }));
    R.para = { fire: r?.ok ? { kind: r.ev?.kind, ref: r.ev?.ref, data: r.ev?.data } : r };
    if (r?.ok) {
      // poltergeist: to = [x, y, z, yaw]; a fall: [x, z, yaw]
      const to0 = r.ev?.data?.to as number[] | undefined;
      const to = to0 ? (to0.length >= 4 ? [to0[0], to0[2]] : [to0[0], to0[1]]) : undefined;
      const from = r.ev?.data?.from as number[] | undefined;
      if (from) await ev(page, `(window.__levelDebug.camera([${from[0] + 1.6}, 1.5, ${from[2] + 1.6}], [${from[0]}, 0.4, ${from[2]}]), 1)`);
      const t = await ev<number>(page, 'performance.now()');
      await sleep(400);
      R.para.moving = await ev(page, JS.moving());
      await shot('poltergeist-moving');
      await sleep(Math.max(1500, Number(r.ev?.ms ?? 0) + 800));
      await shot('poltergeist-after');
      R.para.window = await windowOf(page, t, await ev<number>(page, 'performance.now()'));
      // the committed instance sits at the event's final position
      if (to) R.para.landed = await ev(page, JS.landed(to[0], to[1]));
      check('poltergeist: the prop moved (a movable clone, then committed at its final spot)', (R.para.moving ?? 0) > 0 || (typeof R.para.landed === 'number' && R.para.landed < 0.05), { moving: R.para.moving, landed: R.para.landed });
      await ev(page, '(window.__levelDebug.camera(null), 1)');
    }
    save();
  }
  // the van in the lot: from behind (exterior) and inside the cargo (the same van.ts build as the hub's)
  if (PARTS.has('van') && left() > 5) {
    const c = Lr.van.cab, vx = c.x + c.w / 2;
    await ev(page, `(window.__levelDebug.camera([${vx - 2.6}, 1.9, ${c.y - 4.2}], [${vx}, 1.1, ${c.y + 1.2}]), 1)`);
    await sleep(700);
    await shot('van-exterior');
    await ev(page, `(window.__levelDebug.camera([${vx}, 1.62, ${c.y + 0.25}], [${vx}, 1.15, ${c.y + c.h - 0.4}]), 1)`);
    await sleep(700);
    await shot('van-interior');
    await ev(page, '(window.__levelDebug.camera(null), 1)');
  }
  R.errors = [...player.errors, ...(await ev<string[]>(page, 'window.__game.errors()', 5000).catch(() => []))].slice(0, 30);
  check('no page errors', R.errors.filter((e: string) => !/favicon|404|net::ERR/.test(e)).length === 0, R.errors.slice(0, 5));
} catch (e) {
  failed = true;
  R.failed = String(e instanceof Error ? e.stack : e).slice(0, 1500);
  log(`FAILED: ${R.failed}`);
} finally {
  try {
    R.marks = await ev(page, 'window.__dh ? window.__dh.marks : []', 8000);
    R.countsAtEnd = await ev(page, 'window.__dh ? window.__dh.counts() : null', 8000);
    R.siteWarmEnd = await ev(page, 'window.__render.siteWarm ? window.__render.siteWarm() : null', 8000).catch(() => null);
  } catch (e) { R.dumpError = String(e); }
  R.totalSec = +el().toFixed(1);
  const bad = R.checks.filter((c: Any) => !c.pass);
  R.ok = !failed && bad.length === 0;
  save();
  bot.close();
  await player.close().catch(() => {});
  log(`${R.ok ? 'OK' : 'FAIL'}: ${R.checks.length - bad.length}/${R.checks.length} checks -> ${join(OUT, `${TAG}.json`)}`);
  process.exit(R.ok ? 0 : 1);
}
