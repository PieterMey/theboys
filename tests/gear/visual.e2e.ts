// v1.2 (G3) gear visuals in Chrome (one batched pass per mode).
// Default mode: the new item models + world materials (instanced, with a plain-mesh A/B shot and a probe of where each
// instance projects) in a close-up, the v1.1 item models in a second close-up, the pre-warm ending and world items culled
// to the visible spaces, the first sight of new items adding no pipeline, the inventory icons / status chips / pouch
// chips and a view model, a thrown bottle, night vision on (render.setNightVision or the CSS fallback), a drawer tapped
// open with its contents, a drawer and a door mid-ease with the ring, the death-card creeping tip. A ws bot keeps the crew
// alive (a lone death would end the contract before the card shows); it waits in the van, out of every shot.
// --models: the v1.2 item models (flag itemModels): the loaded real models, the worst item-draw views of the level, ONE
// item of every visual key spawned in front of a fixed camera (the first sight adds 0 pipelines and 0 item node builds),
// close-ups of them on the floor, drawers opened with salvage / gear inside, every key in hand (a view-model gallery),
// real items in the inventory (the per-name icons).
// Every check polls (SwiftShader frames are slow; a fixed sleep raced the HUD in an earlier run).
// Needs a dev server: PORT=3803 NODE_ENV=development AI_MODE=mock ... node apps/server/src/index.ts --dev
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/gear/visual.e2e.ts 3803 [--flat] [--models] [--proto <dir>]
//   --flat = ?levelLight=1 (flat debug fill: readable model / drawer close-ups; night vision is then skipped); --models
//   implies it. --proto <dir> = serve <dir>/*.glb as prop.item_* entries (source polyhaven:<id>) when the manifest has
//   none yet (the staged item GLBs not built): the file name before '.glb' is the Poly Haven id.
// --studio: every visual key drawn by the game's visuals module into contact sheets (studio-sheet-*.png, two views per
//   model, labelled; the sheet's orientation is checked with a marker), then items in hand and in drawers.
// --dry: no browser, no server: the studio page code parses and its sheet pixel work passes synthetic readbacks.
// Screenshots: tests/artifacts/gear-v12/*.png (look at them).
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchPlayer, screenshot, waitForGame, REPO } from '../lib/launch.ts';
import { Bot } from '../interaction/bot.ts';
import { doorSpot } from '../interaction/spots.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import type { ContainerInfo } from '../../packages/shared/src/procgen/containers.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 3803);
const modelsMode = process.argv.includes('--models');
const studioMode = process.argv.includes('--studio');
const flat = process.argv.includes('--flat') || modelsMode || studioMode;
const argOf = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const protoDir = argOf('--proto');
const BASE = `http://127.0.0.1:${port}`;
const CREW = `GV${Date.now() % 100000}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
/** the guard kills at 120 s: steps check what is left */
const left = () => 116_000 - (Date.now() - t0);
// the SwiftShader lane (tools/gpu-guard.mjs) renders on the CPU: a smaller viewport keeps frames and screenshots quick
const soft = process.env.DEADAIR_RENDER === 'swiftshader';
if (process.argv.includes('--dry')) {
  // the sheet's pixel work (sheetJs) on synthetic readbacks of one sheet in every layout a backend can hand back: WebGPU
  // (top row first, rows padded to 256 bytes), WebGL as three r186 does it (viewport y turned into GL's bottom-left,
  // rows read bottom-up), the earlier double flip (cell rows reversed) and WebGPU rows taken for WebGL ones. Every label
  // row must sit on its own model; only the black and the floor-only views count as empty (a dark model does not).
  new Function(`return (${studioJs()})`);
  const S = new Function(`return ${sheetJs()}`)() as SheetFns;
  const { W, H, COLS, ROWS } = S, RW = COLS * W, RH = ROWS * H;
  const img = new Uint8Array(RW * RH * 4);
  const put = (x: number, y: number, c: readonly number[]) => { const k = (y * RW + x) * 4; img[k] = c[0]!; img[k + 1] = c[1]!; img[k + 2] = c[2]!; img[k + 3] = 255; };
  // 9 models (linear RGB): a block of the model's own colour on the floor in both views; model 4 is dark, model 7's top
  // view shows the floor only, model 8's 3/4 view nothing at all; the marker in the top-left corner of cell (0, 0)
  const colOf = (k: number) => (k === 4 ? [2, 2, 2] : [40 + k * 20, 210 - k * 15, 90 + k * 10]);
  const cells: { k: number; col: number; row: number; v: number; empty: boolean }[] = [];
  for (let k = 0; k < 9; k++) for (let v = 0; v < 2; v++) {
    const col = (k % 3) * 2 + v, row = Math.floor(k / 3), black = k === 8 && v === 0, bare = k === 7 && v === 1;
    cells.push({ k, col, row, v, empty: black || bare });
    if (black) continue;
    for (let y = row * H; y < (row + 1) * H; y++) for (let x = col * W; x < (col + 1) * W; x++) {
      put(x, y, !bare && Math.abs(x - col * W - W / 2) < 40 && Math.abs(y - row * H - H / 2 - 8) < 40 ? colOf(k) : [26, 26, 27]);
    }
  }
  for (let y = 0; y < S.MARK; y++) for (let x = 0; x < S.MARK; x++) put(x, y, [255, 0, 255]);
  const padded = Math.ceil((RW * 4) / 256) * 256;
  // [layout, backend flag, expected orientation, the sheet row held by readback row k, row stride in bytes]
  const layouts: [string, boolean, string, (k: number) => number, number][] = [
    ['WebGPU', false, 'ok', (k) => k, padded],
    ['WebGL (three r186)', true, 'ok', (k) => RH - 1 - k, RW * 4],
    ['WebGL, the earlier (ROWS - 1 - row) * H viewport', true, 'rows', (k) => Math.floor(k / H) * H + H - 1 - (k % H), RW * 4],
    ['WebGPU rows taken for WebGL rows', true, 'ok', (k) => k, padded],
  ];
  const models = cells.filter((c) => !c.empty);
  for (const [what, webgl, want, src, stride] of layouts) {
    const px = new Uint8Array((RH - 1) * stride + RW * 4);
    for (let k = 0; k < RH; k++) px.set(img.subarray(src(k) * RW * 4, (src(k) + 1) * RW * 4), k * stride);
    const out = new Uint8Array(RW * RH * 4);
    const o = S.sheet(px, RW, RH, webgl, out);
    const at = (x: number, y: number) => Array.from(out.subarray((y * RW + x) * 4, (y * RW + x) * 4 + 3)).join();
    const wrong = models.filter((c) => at(c.col * W + W / 2, S.rowAt(o.orient, c.row) * H + H / 2 + 8) !== colOf(c.k).map((v) => S.enc(v)).join());
    const marked = at(2, S.rowAt(o.orient, 0) * H + 2) !== at(S.MARK + 1, S.rowAt(o.orient, 0) * H + 2);
    ok(o.orient === want && wrong.length === 0 && !marked, `${what}: orientation ${o.orient}${o.flip ? ' (rows flipped on copy)' : ''}, ${models.length - wrong.length}/${models.length} labelled views on their own model${marked ? ', MARKER LEFT' : ''}`);
    const flagged = cells.filter((c) => S.content(out, RW, c.col * W, S.rowAt(o.orient, c.row) * H) < 8).map((c) => `model ${c.k} ${c.v ? 'top' : '3/4'}`);
    ok(flagged.join() === 'model 7 top,model 8 3/4', `${what}: empty views ${JSON.stringify(flagged)} (want model 7 top, model 8 3/4)`);
  }
  console.log(fails ? `FAILED (${fails})` : 'ALL PASS (dry)');
  process.exit(fails ? 1 : 0);
}
// --models / --studio: no one-time brightness check over the shots (meta's ?nobright)
const p = await launchPlayer({ baseUrl: BASE, crew: CREW, name: 'Vis', query: { autojoin: '1', ...(flat ? { levelLight: '1' } : {}), ...(modelsMode || studioMode ? { nobright: '1' } : {}) }, ...(soft ? { viewport: { width: 960, height: 540 } } : {}) });
const page = p.page;
const ev = <T = unknown>(js: string) => page.evaluate(js) as Promise<T>;
/** poll a page expression until truthy (false on timeout) */
const until = (js: string, ms: number) => page.waitForFunction(js, undefined, { timeout: Math.max(300, Math.min(ms, left() - 2000)), polling: 100 }).then(() => true, () => false);
/** let the render loop draw n more frames */
const frames = (n: number) => ev(`new Promise((r) => { let k = ${n}; const f = () => (--k <= 0 ? r(0) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
const tag = studioMode ? 'studio-' : modelsMode ? 'models-' : flat ? 'flat-' : '';
const ART = 'tests/artifacts/gear-v12';
const shots: string[] = [];
const shot = async (name: string) => {
  if (left() < 3500) { console.log('skip shot (time)', name); return; }
  await frames(3);
  const f = await screenshot(page, `${ART}/${tag}${name}.png`);
  shots.push(f);
  console.log('shot', f, secs());
};
const dbg = (r: string, a: unknown = {}) => ev(`__game.dbg(${JSON.stringify(r)}, ${JSON.stringify(a)})`);
const camera = (pos: number[] | null, at?: number[]) => ev(`window.__levelDebug && __levelDebug.camera(${JSON.stringify(pos)}, ${JSON.stringify(at ?? null) === 'null' ? 'undefined' : JSON.stringify(at)})`);
const ixDebug = (expr: string) => ev(`(() => { const d = __render.three().scene.getObjectByName('interaction').userData.ixDebug; return ${expr}; })()`);
interface DS { items: number; shown: number; draws: number; casters: number; warm: boolean; warmFrames: number; maxMeshesPerItem: number; thrown: number; held: number; itemModels?: boolean; glbShown?: number; templates?: number; warmProxies?: number; warmArms?: number }
const report: Record<string, unknown> = { mode: modelsMode ? 'models' : 'default', soft };
const mate = modelsMode || studioMode ? null : new Bot('Mate');

/** the routed manifest: prop.item_* entries for the prototype GLBs in --proto (only keys the manifest lacks) */
async function routeProto(dir: string): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.glb'));
  await page.route('**/assets/manifest.json', async (route) => {
    const resp = await route.fetch();
    const j = await resp.json() as { files: Record<string, { source?: string }> };
    const have = new Set(Object.values(j.files).map((e) => e.source));
    let added = 0;
    for (const f of files) {
      const id = f.replace(/\.glb$/, '').replace(/_(tape|transceiver)$/, '');
      if (have.has(`polyhaven:${id}`) && Object.keys(j.files).some((k) => k.startsWith('prop.item_') && j.files[k]!.source === `polyhaven:${id}`)) continue;
      j.files[`prop.item_proto_${id.toLowerCase()}`] = { url: `items-proto/${f}`, bytes: statSync(join(dir, f)).size, group: 'site', type: 'glb', source: `polyhaven:${id}` } as never;
      added++;
    }
    console.log(`routed manifest: +${added} prototype item GLBs`);
    await route.fulfill({ response: resp, json: j });
  });
  await page.route('**/assets/items-proto/**', (route) => {
    const f = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    return route.fulfill({ body: readFileSync(join(dir, f)), contentType: 'model/gltf-binary' });
  });
}

/** counts node builds (CPU shader graph builds) of item meshes (under the interaction root, the warm set excluded) */
const installBuildCounter = () => ev(`(() => {
  const r = __render.three().renderer;
  if (window.__ixnb) return true;
  window.__ixnb = { n: 0, items: 0, list: [] };
  const under = (o) => { for (let q = o; q; q = q.parent) { if (q.name === 'ix-warm') return false; if (q.name === 'interaction') return true; } return false; };
  const prev = r.debug.onNodeBuilderCreated;
  r.debug.onNodeBuilderCreated = (nb, ro) => {
    try { if (prev) prev(nb, ro); } catch (e) { /* keep counting */ }
    __ixnb.n++;
    const o = ro && ro.object;
    if (o && under(o)) { __ixnb.items++; if (__ixnb.list.length < 40) __ixnb.list.push([o.name, o.parent && o.parent.name, ro.material && (ro.material.name || ro.material.type)]); }
  };
  return true;
})()`);
const counters = () => ev<{ pipelines: number; vs: number; fs: number; builds: number; items: number; list: unknown[] }>(`(() => { const q = __render.pipelines(); return { ...q, builds: __ixnb.n, items: __ixnb.items, list: __ixnb.list.slice() }; })()`);

try {
  if (protoDir) await routeProto(protoDir);
  // no Vite HMR socket: other builders' edits must not reload this page mid-run
  await page.routeWebSocket(/token=/, () => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 75_000);
  await page.waitForFunction(() => !!(window as unknown as { __game?: { me(): string | null } }).__game?.me(), undefined, { timeout: 15_000 });
  console.log('game ready', secs());
  await installBuildCounter();
  if (studioMode) await studioFlow();
  else await mainFlow();
  const errs = await ev<string[]>('__game.errors()');
  ok(errs.length === 0, `no client errors ${JSON.stringify(errs.slice(0, 4))}`);
  const pe = p.errors.filter((e) => !/http 4\d\d|favicon/.test(e));
  ok(pe.length === 0, `no page errors ${JSON.stringify(pe.slice(0, 4))}`);
} catch (e) {
  console.log('FAIL', e instanceof Error ? (e.stack ?? e.message) : e);
  await screenshot(page, `${ART}/${tag}fail.png`).catch(() => undefined);
  fails++;
} finally {
  report.shots = shots;
  report.elapsed = secs();
  try { mkdirSync(join(REPO, ART), { recursive: true }); writeFileSync(join(REPO, ART, `${tag}report.json`), JSON.stringify(report, null, 1)); } catch { /* best effort */ }
  mate?.close();
  await p.close();
}
console.log(fails ? `FAILED (${fails})` : 'ALL PASS', secs());
process.exit(fails ? 1 : 0);

async function mainFlow(): Promise<void> {
  if (mate) await mate.connect(`ws://127.0.0.1:${port}/ws`, CREW);
  const SEED = modelsMode ? 'g3-models-1' : 'g3-visual-1';
  await dbg('level.generate', { seed: SEED, players: 2 });
  await dbg('monsters.freeze', { on: true }).catch(() => undefined);
  await dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => undefined);
  await page.waitForFunction((s) => (window as unknown as { __ix?: { layout(): { seed?: string } | null } }).__ix?.layout()?.seed === s, SEED, { timeout: 25_000 });
  await until('!!window.__levelDebug && __levelDebug.texturesReady()', 25_000);
  await frames(5);
  console.log('level ready', secs());
  const L = await ev<LevelLayout>('__ix.layout()');
  const conts = containersOf(L);
  const info0 = await ixDebug('d.info()') as { itemModels: boolean; templates: { key: string; prop: string; size: number[]; tris: number; casts: boolean }[]; warmProxies: number; warmArms: number };
  report.models = info0;
  console.log('item models', JSON.stringify({ on: info0.itemModels, n: info0.templates.length, warm: info0.warmProxies, arms: info0.warmArms }));
  for (const t of info0.templates) console.log('  real model', t.key.padEnd(14), t.prop.padEnd(26), t.size.join(' x '), `${t.tris} tris`, t.casts ? 'casts' : '');
  ok(info0.itemModels === true, 'itemModels on (config/flags.json)');
  const warmDone = await until(`(() => { const d = __ix.drawStats(); return !!d && !d.warm; })()`, 15_000);
  const ds0 = await ev<DS | null>('__ix.drawStats()');
  ok(warmDone, `pre-warm ended (${ds0?.warmFrames} drawn frames, ${ds0?.warmProxies} proxies, ${ds0?.warmArms} arms)`);
  ok(!!ds0 && ds0.maxMeshesPerItem <= 2, `world items merged: ${JSON.stringify(ds0)}`);

  if (modelsMode) await modelsFlow(L, conts);
  else await regressionFlow(L, conts);
}

// ---------------------------------------------------------------- --studio: every model as the game draws it (one run)

interface SheetFns {
  W: number; H: number; COLS: number; ROWS: number; MARK: number;
  enc(v: number): number;
  sheet(px: ArrayLike<number>, RW: number, RH: number, webgl: boolean, out: Uint8Array | Uint8ClampedArray): { flip: boolean; orient: string };
  rowAt(orient: string, row: number): number;
  content(d: ArrayLike<number>, RW: number, x0: number, y0: number): number;
}

/** Page code (an object literal; --dry runs it too): a contact sheet's pixel work.
 *  - copy(): a render-target readback (RGBA8, linear) into canvas pixels (sRGB, top row first). flip = the rows come
 *    bottom-up (WebGL's readPixels). WebGPU pads every row to 256 bytes, so the stride comes from the length.
 *  - sheet(): copy, then find the magenta marker drawn into the top-left corner of cell (0, 0) and act on where it is:
 *    'ok'; 'full' or 'cell' (the rows were read the wrong way up: copied again, flipped); 'rows' (the cell rows are
 *    reversed but each cell is upright: rowAt() maps label rows; the earlier sheets were like this: their viewport y
 *    was flipped on top of three's own flip); 'none' (no marker: the rows as rendered). The marker is painted over.
 *  - content(): the sampled pixels of one view cell that differ from its background, the median of its border ring
 *    (the lit floor, or black where nothing was drawn): brighter by > 16, or darker by > 16 on a lit floor (a dark
 *    model). Black pixels on a black cell never count (the old test counted every pixel below 40 as content). */
function sheetJs(): string {
  return `({
  W: 240, H: 180, COLS: 6, ROWS: 8, MARK: 6,
  enc(v) { const x = v / 255; const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(s * 255))); },
  copy(px, RW, RH, flip, out) {
    const lut = this.lut || (this.lut = Array.from({ length: 256 }, (_, v) => this.enc(v)));
    const stride = RH > 1 ? (px.length - RW * 4) / (RH - 1) : RW * 4;
    for (let y = 0; y < RH; y++) {
      const row = (flip ? RH - 1 - y : y) * stride;
      for (let x = 0; x < RW; x++) { const si = row + x * 4, di = (y * RW + x) * 4; out[di] = lut[px[si]]; out[di + 1] = lut[px[si + 1]]; out[di + 2] = lut[px[si + 2]]; out[di + 3] = 255; }
    }
  },
  markAt(d, RW, y) { const k = (y * RW + 2) * 4; return d[k] > 200 && d[k + 1] < 80 && d[k + 2] > 200; },
  orient(d, RW, RH) {
    const H = this.H;
    return this.markAt(d, RW, 2) ? 'ok' : this.markAt(d, RW, RH - H + 2) ? 'rows' : this.markAt(d, RW, RH - 3) ? 'full' : this.markAt(d, RW, H - 3) ? 'cell' : 'none';
  },
  sheet(px, RW, RH, webgl, out) {
    let flip = webgl;
    this.copy(px, RW, RH, flip, out);
    let orient = this.orient(out, RW, RH);
    if (orient === 'full' || orient === 'cell') { flip = !flip; this.copy(px, RW, RH, flip, out); orient = this.orient(out, RW, RH); }
    const y0 = orient === 'ok' ? 0 : orient === 'rows' ? RH - this.H : -1;
    if (y0 >= 0) for (let y = y0; y < y0 + this.MARK; y++) for (let x = 0; x < this.MARK; x++) for (let c = 0; c < 4; c++) out[(y * RW + x) * 4 + c] = out[(y * RW + this.MARK + 1) * 4 + c];
    return { flip, orient };
  },
  rowAt(orient, row) { return orient === 'rows' ? this.ROWS - 1 - row : row; },
  content(d, RW, x0, y0) {
    const W = this.W, H = this.H;
    const lum = (k) => 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
    const ring = [];
    for (let x = x0 + 4; x < x0 + W - 4; x += 4) ring.push(lum(((y0 + 20) * RW + x) * 4), lum(((y0 + H - 5) * RW + x) * 4));
    for (let y = y0 + 20; y < y0 + H - 4; y += 4) ring.push(lum((y * RW + x0 + 4) * 4), lum((y * RW + x0 + W - 5) * 4));
    ring.sort((a, b) => a - b);
    const bg = ring[ring.length >> 1];
    let n = 0;
    for (let y = y0 + 20; y < y0 + H - 4; y += 3) for (let x = x0 + 4; x < x0 + W - 4; x += 3) { const dl = lum((y * RW + x) * 4) - bg; if (dl > 16 || (bg > 24 && dl < -16)) n++; }
    return n;
  },
})`;
}

/** Page code: every visual key built by the game's own visuals module (its real models, the print atlas, the shared
 *  materials) and drawn in a small studio scene into a render target, two views each (3/4 on a floor, from above),
 *  read back and tiled into contact sheets (PNG data URLs; sheetJs: orientation marker, row stride, empty views).
 *  Stops at its time budget. */
function studioJs(): string {
  return `async (budgetMs) => {
  const V = await import('/src/interaction/visuals.ts');
  const { renderer, THREE } = __render.three();
  const S = ${sheetJs()};
  const W = S.W, H = S.H, COLS = S.COLS, ROWS = S.ROWS, PER = (COLS / 2) * ROWS;
  const RW = COLS * W, RH = ROWS * H;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe6edf5, 0x3c3832, 1.2));
  const key = new THREE.DirectionalLight(0xfff1e2, 2.1); key.position.set(0.8, 1.6, 1.2); scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xbcd2ff, 0.7); rim.position.set(-1.2, 0.8, -1.0); scene.add(rim, rim.target);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardNodeMaterial({ color: 0x5a5d60, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const cam = new THREE.PerspectiveCamera(34, W / H, 0.005, 40);
  // the orientation marker (S.sheet): an unlit magenta quad into the top-left corner of cell (0, 0), drawn last
  const mark = new THREE.Scene();
  const markQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicNodeMaterial({ color: 0xff00ff, depthTest: false, depthWrite: false }));
  markQuad.frustumCulled = false;
  mark.add(markQuad);
  const markCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  markCam.position.set(0, 0, 1);
  markCam.updateMatrixWorld();
  const webgl = !!renderer.backend.isWebGLBackend;
  const samples = V.itemSamples();
  const t0 = performance.now();
  const sheets = [], errs = [], orients = [];
  let done = 0;
  const tmp = new THREE.Box3();
  const solidBox = (o) => { const b = new THREE.Box3(); o.updateMatrixWorld(true); o.traverse((q) => { if (q.isMesh && q.material && q.material.blending !== THREE.AdditiveBlending) b.union(tmp.setFromObject(q, true)); }); return b; };
  for (let s0 = 0; s0 < samples.length; s0 += PER) {
    if (performance.now() - t0 > budgetMs) { errs.push('time budget: stopped at ' + s0); break; }
    const list = samples.slice(s0, s0 + PER);
    // every model of the sheet in the scene, 8 m apart; one compile for all, then one visible per cell
    const models = [];
    list.forEach((s, i) => {
      try {
        const g = V.buildItemModel(s.type, { name: s.name });
        g.position.set((i % 6) * 8, 0, Math.floor(i / 6) * 8);
        g.traverse((q) => { q.frustumCulled = false; });
        scene.add(g);
        models.push({ s, g });
      } catch (e) { errs.push(s.key + ': ' + ((e && e.message) || e)); models.push(null); }
    });
    const rt = new THREE.RenderTarget(RW, RH);
    // compile for the render target's context (no tone mapping there: other shaders than the canvas); both compiles
    // start while the target is bound (the game's frame may rebind it during the await)
    renderer.setRenderTarget(rt);
    try { await Promise.all([renderer.compileAsync(scene, cam), renderer.compileAsync(mark, markCam)]); } catch (e) { errs.push('compile: ' + ((e && e.message) || e)); }
    renderer.setRenderTarget(null);
    for (const m of models) if (m) m.g.visible = false;
    const prevAuto = renderer.autoClear;
    const cells = [];
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.autoClear = false;
    try {
      models.forEach((m, i) => {
        if (!m) return;
        m.g.visible = true;
        const b = solidBox(m.g), c = b.getCenter(new THREE.Vector3()), r = Math.max(0.03, b.getSize(new THREE.Vector3()).length() / 2);
        const dist = r / Math.sin(17 * Math.PI / 180) * 1.05;
        const col = (i % 3) * 2, row = Math.floor(i / 3);
        const views = [new THREE.Vector3(0.62, 0.62, 1), new THREE.Vector3(0.02, 1, 0.14)];
        views.forEach((d, vi) => {
          cam.position.copy(c).add(d.normalize().multiplyScalar(dist)); cam.lookAt(c); cam.updateMatrixWorld();
          // a top-left origin on both backends: three's WebGLBackend.updateViewport turns y into GL's bottom-left itself
          // (y = (ROWS - 1 - row) * H flipped it a second time: every label sat on the model of row 7 - row)
          rt.viewport.set((col + vi) * W, row * H, W, H);
          renderer.render(scene, cam);
        });
        cells.push({ col, row, key: m.s.key, text: m.s.key + (m.s.name ? '  ' + m.s.name : '') + (m.g.userData.glb ? '  [' + m.g.userData.glb + ']' : '') });
        m.g.visible = false;
        done++;
      });
      rt.viewport.set(0, 0, S.MARK, S.MARK);
      renderer.render(mark, markCam);
    } catch (e) { errs.push('render: ' + ((e && e.message) || e)); }
    renderer.autoClear = prevAuto;
    renderer.setRenderTarget(null);
    for (const m of models) if (m) scene.remove(m.g);
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, RW, RH);
    rt.dispose();
    const sheet = document.createElement('canvas'); sheet.width = RW; sheet.height = RH;
    const c2 = sheet.getContext('2d');
    const img = c2.createImageData(RW, RH);
    const o = S.sheet(px, RW, RH, webgl, img.data);
    orients.push(o.orient + (o.flip ? ' (bottom-up)' : ''));
    if (o.orient === 'none') errs.push('sheet ' + sheets.length + ': no orientation marker (labels follow the rendered rows)');
    c2.putImageData(img, 0, 0);
    // a model view without the model's pixels (a pipeline not ready in time, or nothing drawn): reported
    for (const cl of cells) for (let v = 0; v < 2; v++) {
      if (S.content(img.data, RW, (cl.col + v) * W, S.rowAt(o.orient, cl.row) * H) < 8) errs.push(cl.key + ': the ' + (v ? 'top' : '3/4') + ' view of sheet ' + sheets.length + ' looks empty');
    }
    c2.font = '12px sans-serif';
    for (const cl of cells) {
      const y = S.rowAt(o.orient, cl.row) * H;
      c2.fillStyle = 'rgba(0,0,0,0.6)'; c2.fillRect(cl.col * W, y, 2 * W, 16);
      c2.fillStyle = '#fff'; c2.fillText(cl.text, cl.col * W + 4, y + 12);
      c2.fillStyle = '#555'; c2.fillRect((cl.col + 2) * W - 1, y, 1, H);
    }
    sheets.push(sheet.toDataURL('image/png'));
  }
  return { sheets, ms: Math.round(performance.now() - t0), n: samples.length, done, errs, orient: orients, backend: webgl ? 'webgl' : 'webgpu' };
}`;
}

async function studioFlow(): Promise<void> {
  // 1) the real models load with the first layout (the hub here): every one in before the sheets
  const nReal = await ixDebug('d.realKeys().length') as number;
  // the hub's layout already started them; start them here too in case it did not (idempotent: one load per model)
  await ev(`import('/src/interaction/visuals.ts').then((V) => { void V.preloadItemModels(); return true; })`);
  const loaded = await until(`(() => { const d = __render.three().scene.getObjectByName('interaction')?.userData.ixDebug; return !!d && d.info().templates.length >= ${nReal}; })()`, 30_000);
  const info0 = await ixDebug('d.info()') as { itemModels: boolean; templates: { key: string; prop: string; size: number[]; tris: number; casts: boolean }[]; warmProxies: number; warmArms: number };
  report.models = info0;
  console.log(`real models ${info0.templates.length}/${nReal} (${loaded ? 'all' : 'not all'}) at ${secs()}, warm ${info0.warmProxies} proxies / ${info0.warmArms} arms`);
  for (const t of info0.templates) console.log('  real model', t.key.padEnd(14), t.prop.padEnd(26), t.size.join(' x '), `${t.tris} tris`, t.casts ? 'casts' : '');
  ok(info0.itemModels === true, 'itemModels on (config/flags.json / the live flags)');
  ok(info0.templates.length >= 15, `${info0.templates.length} real item models loaded`);
  // 2) the studio sheets: every key, 3/4 on a floor and from above
  const budget = Math.max(8000, Math.min(34_000, left() - 52_000));
  const res = await ev<{ sheets: string[]; ms: number; n: number; done: number; errs: string[]; orient: string[]; backend: string }>(`(${studioJs()})(${budget})`);
  report.studio = { ms: res.ms, n: res.n, done: res.done, errs: res.errs, backend: res.backend, orient: res.orient };
  mkdirSync(join(REPO, ART), { recursive: true });
  res.sheets.forEach((url, i) => {
    const f = join(REPO, ART, `${tag}sheet-${i}.png`);
    writeFileSync(f, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    shots.push(f);
    console.log('shot', f, secs());
  });
  ok(res.done === res.n && res.errs.length === 0, `studio (${res.backend}; sheet orientation ${res.orient.join(', ')}): ${res.done}/${res.n} models in ${res.ms} ms ${JSON.stringify(res.errs.slice(0, 4))}`);
  // 3) in hand (the hub): real items in the inventory (the per-name icons) and their view models; a view-model gallery
  for (const t of [['loot.medium', 'Typewriter'], ['loot.small', 'Pocket watch'], ['crowbar'], ['loot.curio', 'Taxidermy owl']]) await dbg('interaction.give', { type: t[0], ...(t[1] ? { name: t[1], value: 40 } : {}) }).catch(() => undefined);
  await until(`__ix.inventory().filter(Boolean).length >= 3`, 3000);
  const inv = await ev<(string | null)[]>('__ix.inventory()');
  console.log('inventory', JSON.stringify(inv));
  await ev(`__game.look(0, -0.3)`);
  const slotOf = (t: string) => inv.indexOf(t);
  if (slotOf('loot.small') >= 0) { await ev(`__ix.slot(${slotOf('loot.small')})`); await sleep(350); await shot('hand-watch'); }
  if (slotOf('crowbar') >= 0) { await ev(`__ix.slot(${slotOf('crowbar')})`); await sleep(350); await shot('hand-crowbar'); }
  if (slotOf('loot.medium') >= 0) { await ev(`__ix.slot(${slotOf('loot.medium')})`); await sleep(350); await shot('hand-typewriter'); }
  const gal = [{ type: 'medkit' }, { type: 'loot.heavy', name: 'Bronze bust' }, { type: 'loot.small', name: 'Old camera' }, { type: 'bottle' },
    { type: 'keycard' }, { type: 'loot.medium', name: 'Radio set' }, { type: 'battery' }, { type: 'loot.curio', name: 'Music box' }];
  await ixDebug(`d.gallery(${JSON.stringify(gal)})`);
  await shot('hand-gallery');
  await ixDebug('d.gallery(null)');
  // 4) the contract: drawers opened with fitted contents, and a few items on a lit floor
  if (left() < 30_000) { console.log('no time for the contract part'); return; }
  const SEED = 'g3-models-1';
  await dbg('level.generate', { seed: SEED, players: 2 });
  await dbg('monsters.freeze', { on: true }).catch(() => undefined);
  await dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => undefined);
  await page.waitForFunction((sd) => (window as unknown as { __ix?: { layout(): { seed?: string } | null } }).__ix?.layout()?.seed === sd, SEED, { timeout: 20_000 });
  await until('!!window.__levelDebug && __levelDebug.texturesReady()', Math.max(3000, left() - 24_000));
  await frames(3);
  console.log('level', secs());
  const L = await ev<LevelLayout>('__ix.layout()');
  const conts = containersOf(L);
  await dbg('interaction.setLights', { on: true });
  await ev(`__ix.flashlight(true)`);
  const peek = await dbg('interaction.peek') as { contents?: Record<string, unknown[]> };
  const empty = conts.filter((c) => (peek.contents?.[c.id]?.length ?? 0) === 0);
  const pickD = [empty.find((c) => c.kind === 'desk'), empty.find((c) => c.kind === 'cabinet'), empty.find((c) => c.kind !== 'desk' && c.kind !== 'cabinet'), ...empty].filter((c): c is ContainerInfo => !!c);
  const loads: [string, string?][][] = [
    [['loot.medium', 'Radio set'], ['loot.small', 'Pocket watch'], ['bottle']],
    [['loot.medium', 'Typewriter'], ['loot.small', 'Gas mask'], ['battery']],
    [['loot.medium', 'Fuse box'], ['loot.small', 'Circuit board'], ['glowstick']],
  ];
  const seen = new Set<string>();
  let nd = 0;
  for (const c of pickD) {
    if (nd >= 3 || left() < 9000 || seen.has(c.id)) continue;
    seen.add(c.id);
    const sx = c.front[0] + 0.5, sz = c.front[1] + 0.5;
    await ev(`__game.teleport(${sx}, ${sz}, ${Math.atan2(c.p[0] - sx, c.p[2] - sz)})`);
    await frames(2);
    await ev(`__ix.use('cont:${c.id}')`);
    const opened = await until(`(__ix.state().containers?.[${JSON.stringify(c.id)}]?.open ?? 0) > 0`, 2500);
    const part = (c.parts.find((q) => q.idx === c.main) ?? c.parts[0])!;
    const ax = Math.cos(c.rot), az = -Math.sin(c.rot);
    const load = loads[nd]!;
    await ev(`Promise.all(${JSON.stringify(load.map(([type, name], k) => ({ type, ...(name ? { name, value: 30 } : {}), x: part.slot[0] + ax * (k - 1) * 0.12, y: part.slot[1], z: part.slot[2] + az * (k - 1) * 0.12 })))}.map((a) => __game.dbg('interaction.spawn', a)))`);
    await sleep(450);
    const fx = Math.sin(c.rot), fz = Math.cos(c.rot);
    await camera([part.slot[0] + fx * 0.6, part.slot[1] + 0.55, part.slot[2] + fz * 0.6], [part.slot[0], part.slot[1] + 0.02, part.slot[2]]);
    console.log(`drawer ${nd}: ${c.kind} ${part.kind} ${opened ? 'open' : 'NOT OPEN'} ${load.map((x) => x.join(':')).join(' ')}`);
    await shot(`drawer-${nd}-${c.kind}`);
    nd++;
  }
  ok(nd >= 1, `${nd} drawers shot`);
  // a few items on the floor of a lit room, with the game's own light
  if (left() > 6000 && conts[0]) {
    const c = conts.find((q) => L.spaces[q.space]!.rect.w >= 4 && L.spaces[q.space]!.rect.h >= 4) ?? conts[0];
    const sx = c.front[0] + 0.5, sz = c.front[1] + 0.5;
    const away = Math.atan2(c.p[0] - sx, c.p[2] - sz) + Math.PI;
    const fx = Math.sin(away), fz = Math.cos(away), rx = Math.cos(away), rz = -Math.sin(away);
    await camera(null);
    await ev(`__game.teleport(${sx}, ${sz}, ${away})`);
    const row: [string, string?][] = [['loot.medium', 'Jerrycan'], ['loot.small', 'Tin of buttons'], ['loot.heavy', 'Cryo canister'], ['loot.curio', 'Brass diving helmet'], ['loot.medium', 'Brass lamp']];
    await ev(`Promise.all(${JSON.stringify(row.map(([type, name], k) => ({ type, ...(name ? { name, value: 30 } : {}), x: sx + fx * 1.0 + rx * (k - 2) * 0.32, z: sz + fz * 1.0 + rz * (k - 2) * 0.32 })))}.map((a) => __game.dbg('interaction.spawn', a)))`);
    await sleep(400);
    await camera([sx + fx * 0.25, 0.85, sz + fz * 0.25], [sx + fx * 1.05, 0.12, sz + fz * 1.05]);
    await shot('floor-ingame');
  }
  await camera(null);
}

// ---------------------------------------------------------------- --models: the v1.2 item models

async function modelsFlow(L: LevelLayout, conts: readonly ContainerInfo[]): Promise<void> {
  await dbg('interaction.setLights', { on: true });
  await ev(`__ix.flashlight(true)`);
  // 1) the worst views of the level as generated: the rooms with the most world items, item draws <= 20
  const st0 = await ev<{ items: Record<string, { type: string; where: string; p?: number[] }> }>('__ix.state()');
  const own = (x: number, z: number) => { const cx = Math.floor(x), cz = Math.floor(z); return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : (L.owner[cz * L.W + cx] ?? -1); };
  const bySpace = new Map<number, number[][]>();
  for (const it of Object.values(st0.items)) {
    if (it.where !== 'world' || !it.p) continue;
    const s = own(it.p[0]!, it.p[2]!);
    if (s < 0) continue;
    const l = bySpace.get(s) ?? [];
    l.push(it.p);
    bySpace.set(s, l);
  }
  const worst = [...bySpace.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  const views: { space: number; items: number; draws: number; shown: number; mats: number }[] = [];
  for (const [space, ps] of worst) {
    const r = L.spaces[space]!.rect;
    const cx = ps.reduce((a, q) => a + q[0]!, 0) / ps.length, cz = ps.reduce((a, q) => a + q[2]!, 0) / ps.length;
    const ex = Math.min(r.x + r.w - 0.4, Math.max(r.x + 0.4, r.x + r.w / 2 + (cx < r.x + r.w / 2 ? 1 : -1) * r.w * 0.3));
    const ez = Math.min(r.y + r.h - 0.4, Math.max(r.y + 0.4, r.y + r.h / 2 + (cz < r.y + r.h / 2 ? 1 : -1) * r.h * 0.3));
    await camera([ex, 1.6, ez], [cx, 0.1, cz]);
    await frames(3);
    const d = await ev<DS>('__ix.drawStats()');
    const m = await ev<{ draws: number }>('__ix.matStats()');
    views.push({ space, items: ps.length, draws: d.draws, shown: d.shown, mats: m.draws });
  }
  report.worstViews = views;
  const worstDraws = Math.max(0, ...views.map((v) => v.draws));
  ok(worstDraws <= 20, `worst item-draw view of the level: ${worstDraws} draws (<= 20) ${JSON.stringify(views)}`);
  // 2) the first sight of every visual key: a grid in the biggest room, a fixed camera, pipelines + node builds before / after
  const samples = await ixDebug('d.samples()') as { key: string; type: string; name?: string }[];
  // a furniture-free floor area for the grid (a prop's cells would hide the items): the biggest rooms first
  const solid = new Set<number>();
  for (const it of L.items) {
    if (it.kind !== 'prop') continue;
    const r0 = Math.max(Number(it.data?.w ?? 0.6), Number(it.data?.d ?? 0.6)) / 2 + 0.15;
    for (let x = Math.floor(it.x - r0); x <= Math.floor(it.x + r0); x++) for (let z = Math.floor(it.z - r0); z <= Math.floor(it.z + r0); z++) solid.add(z * L.W + x);
  }
  const freeRect = (sid: number, x0: number, z0: number, x1: number, z1: number) => {
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let z = Math.floor(z0); z <= Math.floor(z1); z++) if (solid.has(z * L.W + x) || own(x + 0.5, z + 0.5) !== sid) return false;
    return true;
  };
  const rooms = L.spaces.map((s, i) => ({ s, i })).filter(({ s }) => s.kind !== 'corridor' && s.kind !== 'vault' && s.kind !== 'outside' && !s.open && s.type !== 'van')
    .sort((a, b) => b.s.rect.w * b.s.rect.h - a.s.rect.w * a.s.rect.h);
  let grid: { room: { s: (typeof L.spaces)[number]; i: number }; sp: number; bc: number; br: number; gx: number; gz: number } | null = null;
  search: for (const room of rooms.slice(0, 8)) {
    const r = room.s.rect;
    for (const sp of [0.3, 0.26]) for (const [bc, br] of [[4, 2], [3, 3], [2, 4]] as const) {
      const pw = (bc - 1) * sp * 3.4 + sp * 2, pd = (br - 1) * sp * 3.4 + sp * 2;
      for (let cz = r.y + 0.5 + pd / 2; cz <= r.y + r.h - 0.5 - pd / 2; cz += 0.25) for (let cx = r.x + 0.5 + pw / 2; cx <= r.x + r.w - 0.5 - pw / 2; cx += 0.25) {
        if (!freeRect(room.i, cx - pw / 2 - 0.15, cz - pd / 2 - 0.15, cx + pw / 2 + 0.15, cz + pd / 2 + 0.15)) continue;
        grid = { room, sp, bc, br, gx: cx - pw / 2, gz: cz - pd / 2 };
        break search;
      }
    }
  }
  if (!grid) { const room = rooms[0]!; const r = room.s.rect; grid = { room, sp: 0.26, bc: 3, br: 3, gx: r.x + r.w / 2 - 1.2, gz: r.y + r.h / 2 - 1.2 }; console.log('no free floor found: room centre'); }
  const { room, sp, bc, gx, gz } = grid;
  const rr = room.s.rect, pitch = sp * 3.4;
  const blocks: { cx: number; cz: number; keys: string[] }[] = [];
  const spots = samples.map((s, i) => {
    const b = Math.floor(i / 9), k = i % 9;
    const bx = gx + (b % bc) * pitch, bz = gz + Math.floor(b / bc) * pitch;
    const x = bx + (k % 3) * sp, z = bz + Math.floor(k / 3) * sp;
    (blocks[b] ??= { cx: bx + sp, cz: bz + sp, keys: [] }).keys.push(s.key);
    return { ...s, x, z };
  });
  console.log(`grid in space ${room.i} (${room.s.type} ${rr.w}x${rr.h}) at ${gx.toFixed(2)},${gz.toFixed(2)}: ${bc}x${grid.br} blocks, spacing ${sp.toFixed(2)} m`);
  const gcx = gx + ((bc - 1) * pitch + sp * 2) / 2, gcz = gz + ((grid.br - 1) * pitch + sp * 2) / 2;
  await ev(`__game.teleport(${rr.x + 0.6}, ${rr.y + 0.6}, 0)`);
  await camera([gcx, 2.35, gcz + 1.1], [gcx, 0, gcz]);
  await frames(8);
  const before = await counters();
  const items0 = (await ev<DS>('__ix.drawStats()')).items;
  await ev(`Promise.all(${JSON.stringify(spots.map((s) => ({
    type: s.type, x: s.x, z: s.z, ...(s.name ? { name: s.name } : {}), ...(s.type.startsWith('loot.') ? { value: 50 } : {}),
    ...(s.type === 'mat.pouch' ? { mats: { 'mat.scrap': 2 } } : s.type.startsWith('mat.') ? { count: 2 } : {}),
  })))}.map((a) => __game.dbg('interaction.spawn', a)))`);
  const placed = await until(`(() => { const d = __ix.drawStats(); return !!d && d.items >= ${items0 + samples.filter((s) => !s.type.startsWith('mat.')).length - 1}; })()`, 8000);
  await frames(10);
  const after = await counters();
  report.firstSight = { before, after };
  ok(placed, 'every visual key spawned');
  ok(after.pipelines - before.pipelines === 0, `first sight of ${samples.length} item keys: +${after.pipelines - before.pipelines} pipelines (vs ${before.vs}->${after.vs}, fs ${before.fs}->${after.fs})`);
  ok(after.items - before.items === 0, `first sight: +${after.items - before.items} item node builds ${JSON.stringify(after.list.slice(before.list.length, before.list.length + 8))}`);
  const dsG = await ev<DS>('__ix.drawStats()');
  ok(dsG.maxMeshesPerItem <= 2, `one mesh per item (two with glass): ${dsG.maxMeshesPerItem}; ${dsG.glbShown} real models shown`);
  await shot('m0-overview');
  // 3) close-ups on the floor: one 3 x 3 block per shot
  for (const [i, b] of blocks.entries()) {
    if (left() < 30_000) break;
    await camera([b.cx, 0.62, b.cz + 0.72], [b.cx, 0.03, b.cz + 0.02]);
    await frames(2);
    console.log(`block ${i}: ${b.keys.join(' ')}`);
    await shot(`m1-floor-${i}`);
  }
  report.blocks = blocks;
  // 4) in hand: the view-model gallery (8 per shot) and real items in the inventory (the per-name icons)
  await camera(null);
  await ev(`__game.teleport(${rr.x + rr.w / 2}, ${rr.y + rr.h - 0.8}, ${Math.PI})`);
  await ev(`__game.look(${Math.PI}, -0.25)`);
  for (const t of [['loot.medium', 'Typewriter'], ['loot.small', 'Pocket watch'], ['crowbar'], ['loot.curio', 'Taxidermy owl']]) await dbg('interaction.give', { type: t[0], ...(t[1] ? { name: t[1], value: 40 } : {}) });
  await until(`__ix.inventory().filter(Boolean).length >= 4`, 3000);
  await ev('__ix.slot(1)');
  await sleep(300);
  await shot('m2-hand-real');
  await ev('__ix.slot(3)');
  await sleep(250);
  await shot('m2-hand-real2');
  await ev('__ix.slot(2)');
  for (let i = 0; i < samples.length && left() > 20_000; i += 8) {
    const n = await ixDebug(`d.gallery(${JSON.stringify(samples.slice(i, i + 8).map((s) => ({ type: s.type, name: s.name })))})`);
    console.log(`hand ${i / 8}: ${samples.slice(i, i + 8).map((s) => s.key).join(' ')} (${n})`);
    await shot(`m3-hand-${i / 8}`);
  }
  await ixDebug('d.gallery(null)');
  // 5) drawers: empty containers opened, salvage and gear spawned at the open part's slot (side by side, fitted)
  const peek = await dbg('interaction.peek') as { contents?: Record<string, unknown[]> };
  const empty = conts.filter((c) => (peek.contents?.[c.id]?.length ?? 0) === 0);
  const kinds = new Set<string>();
  const pickD = [...empty.filter((c) => { if (kinds.has(c.kind)) return false; kinds.add(c.kind); return true; }), ...empty].slice(0, 5);
  const loads: [string, string?][][] = [
    [['loot.medium', 'Radio set'], ['loot.small', 'Pocket watch'], ['bottle']],
    [['loot.medium', 'Typewriter'], ['loot.small', 'Gas mask'], ['battery']],
    [['loot.medium', 'Medical case'], ['loot.small', 'Old camera'], ['page']],
    [['loot.medium', 'Fuse box'], ['loot.small', 'Circuit board'], ['glowstick']],
    [['loot.small', 'Cassette tape'], ['loot.small', 'Reading glasses'], ['mat.chem']],
  ];
  const drawerShots: unknown[] = [];
  for (const [i, c] of pickD.entries()) {
    if (left() < 9000) break;
    const sx = c.front[0] + 0.5, sz = c.front[1] + 0.5;
    await ev(`__game.teleport(${sx}, ${sz}, ${Math.atan2(c.p[0] - sx, c.p[2] - sz)})`);
    await frames(2);
    await ev(`__ix.use('cont:${c.id}')`);
    const opened = await until(`(__ix.state().containers?.[${JSON.stringify(c.id)}]?.open ?? 0) > 0`, 3000);
    const part = (c.parts.find((q) => q.idx === c.main) ?? c.parts[0])!;
    const ax = Math.cos(c.rot), az = -Math.sin(c.rot);
    const load = loads[i % loads.length]!;
    await ev(`Promise.all(${JSON.stringify(load.map(([type, name], k) => ({ type, ...(name ? { name, value: 30 } : {}), ...(type.startsWith('mat.') ? { count: 1 } : {}), x: part.slot[0] + ax * (k - 1) * 0.12, y: part.slot[1], z: part.slot[2] + az * (k - 1) * 0.12 })))}.map((a) => __game.dbg('interaction.spawn', a)))`);
    await sleep(500);
    const fx = Math.sin(c.rot), fz = Math.cos(c.rot);
    await camera([part.slot[0] + fx * 0.55, part.slot[1] + 0.5, part.slot[2] + fz * 0.55], [part.slot[0], part.slot[1] + 0.02, part.slot[2]]);
    drawerShots.push({ id: c.id, kind: c.kind, part: part.kind, opened, load: load.map((x) => x.join(':')) });
    console.log(`drawer ${i}: ${c.kind} ${part.kind} ${opened ? 'open' : 'NOT OPEN'} ${load.map((x) => x.join(':')).join(' ')}`);
    await shot(`m4-drawer-${i}-${c.kind}`);
  }
  report.drawers = drawerShots;
  ok(drawerShots.length >= 2, `${drawerShots.length} drawers shot`);
  await camera(null);
}

// ---------------------------------------------------------------- default: the gear regression flow

async function regressionFlow(L: LevelLayout, conts: readonly ContainerInfo[]): Promise<void> {
  ok(conts.length > 0, `${conts.length} containers (E1)`);
  const pickC = (): ContainerInfo | undefined => conts.find((c) => L.spaces[c.space]?.kind !== 'corridor' && L.spaces[c.space]!.rect.w >= 4 && L.spaces[c.space]!.rect.h >= 4) ?? conts[0];
  const c0 = pickC()!;
  const sx = c0.front[0] + 0.5, sz = c0.front[1] + 0.5;
  const yawTo = (x: number, z: number) => Math.atan2(x - sx, z - sz);
  await dbg('interaction.setLights', { on: true });
  await ev(`__game.teleport(${sx}, ${sz}, ${yawTo(c0.p[0], c0.p[2])})`);
  // the mate waits in the van: out of every shot (standing on our spot put its body in front of the camera)
  if (mate) await mate.dbg('interaction.pose', { pid: mate.me, x: L.van.x, z: L.van.z });
  await sleep(300);
  await frames(3);
  // inside a room: the items of rooms the camera cannot see are not drawn
  const dsIn = await ev<DS | null>('__ix.drawStats()');
  ok(!!dsIn && (dsIn.items < 6 || dsIn.shown < dsIn.items), `items outside the visible spaces are culled (${dsIn?.shown}/${dsIn?.items} shown, ${dsIn?.draws} draws, ${dsIn?.casters} casters)`);

  // ---------------- 1) item models + instanced materials, a close-up (instanced, then the same as plain meshes); the
  // first sight of these models adds no pipeline (the camera holds still while they spawn)
  const awayYaw = yawTo(c0.p[0], c0.p[2]) + Math.PI;
  const fx = Math.sin(awayYaw), fz = Math.cos(awayYaw), rx = Math.cos(awayYaw), rz = -Math.sin(awayYaw);
  const rows = [
    ['battery', 'lockpick', 'masterkey', 'soles', 'nvg'],
    ['flashbulb', 'loot.curio', 'page', 'mat.pouch', 'mat.relic'],
    ['mat.scrap', 'mat.wiring', 'mat.chem', 'mat.optics', 'mat.cells'],
  ];
  const D0 = 0.75, DR = 0.22, DC = 0.19;
  await ev(`__ix.flashlight(true)`);
  const mid = D0 + DR;
  await camera([sx + fx * (mid - 0.42), 0.72, sz + fz * (mid - 0.42)], [sx + fx * mid, 0.02, sz + fz * mid]);
  await frames(6);
  const before = await counters();
  for (const [ri, row] of rows.entries()) {
    for (const [ci, type] of row.entries()) {
      const d = D0 + ri * DR, o = (ci - 2) * DC;
      const x = sx + fx * d + rx * o, z = sz + fz * d + rz * o;
      await dbg('interaction.spawn', { type, x, z, ...(type === 'mat.pouch' ? { mats: { 'mat.scrap': 2 }, name: 'A salvage pouch' } : {}), ...(type === 'loot.curio' ? { value: 99, name: 'Music box' } : {}), ...(type.startsWith('mat.') && type !== 'mat.pouch' ? { count: 2 } : {}) });
    }
  }
  await until(`(() => { const s = __ix.matStats(); return !!s && s.draws >= 6; })()`, 8000);
  await frames(6);
  const after = await counters();
  ok(after.pipelines === before.pipelines && after.items === before.items, `first sight of 15 item models: +${after.pipelines - before.pipelines} pipelines, +${after.items - before.items} item node builds`);
  const ms = await ev<{ draws: number; instances: number } | null>('__ix.matStats()');
  ok(!!ms && ms.draws >= 6 && ms.draws <= 7, `materials instanced: ${JSON.stringify(ms)} (<= 7 draws)`);
  const probe = await ev<{ type: string; count: number; ndc: number[]; visible: boolean; inScene: boolean }[] | null>('__ix.matProbe()');
  for (const pr of probe ?? []) console.log('probe', JSON.stringify(pr));
  // instance 0 of a type can be a level-spawned material elsewhere (scrap, cells): every mesh must be visible and in the
  // scene, and the types only this test spawned must project inside the close-up
  const inFrame = (q: { ndc: number[] }) => Math.abs(q.ndc[0]!) < 1 && Math.abs(q.ndc[1]!) < 1 && q.ndc[2]! < 1;
  ok(!!probe && probe.length >= 6 && probe.every((q) => q.visible && q.inScene) && probe.filter((q) => q.count === 1).every(inFrame),
    'every material mesh is visible and in the scene; the test-spawned ones project inside the close-up');
  await shot('1-items');
  await ev('__ix.matPlain(true)');
  await shot('1b-items-plain');
  await ev('__ix.matPlain(false)');
  // the v1.1 models (merged since the gate-P fix) and salvage by name, further into the room
  const rows11: [string, string?][][] = [
    [['bottle'], ['medkit'], ['walkie'], ['keycard'], ['badge']],
    [['flare'], ['sensor'], ['syringe'], ['charm'], ['loot.idol']],
    [['airhorn'], ['glowstick'], ['flashlight_pro'], ['loot.small', 'Hip flask'], ['crowbar']],
  ];
  const E0 = 1.65, ER = 0.3, EC = 0.24;
  const before11 = (await ev<DS | null>('__ix.drawStats()'))?.items ?? 0;
  for (const [ri, row] of rows11.entries()) {
    for (const [ci, [type, name]] of row.entries()) {
      const d = E0 + ri * ER, o = (ci - 2) * EC;
      await dbg('interaction.spawn', { type, x: sx + fx * d + rx * o, z: sz + fz * d + rz * o, ...(name ? { name, value: 20 } : {}) });
    }
  }
  const mid11 = E0 + ER;
  await camera([sx + fx * (mid11 - 0.55), 0.85, sz + fz * (mid11 - 0.55)], [sx + fx * mid11, 0.03, sz + fz * mid11]);
  await until(`(() => { const d = __ix.drawStats(); return !!d && d.items >= ${before11 + 15}; })()`, 6000);
  await frames(4);
  const ds1 = await ev<DS | null>('__ix.drawStats()');
  ok(!!ds1 && ds1.maxMeshesPerItem <= 2, `v1.1 models merged too: ${JSON.stringify(ds1)}`);
  await shot('1c-items-v11');
  await camera(null);

  // ---------------- 2) a thrown bottle flies as one merged model (pooled thrown views); before the HUD gear fills the
  // four slots
  await ev(`__game.teleport(${sx}, ${sz}, ${awayYaw})`);
  await dbg('interaction.give', { type: 'bottle' });
  ok(await until(`__ix.inventory().includes('bottle')`, 3000), 'bottle in hand');
  await ev(`__ix.slot(__ix.inventory().indexOf('bottle'))`);
  await ev(`__ix.aim(${sx + fx * 4}, 2.1, ${sz + fz * 4})`); // a high lob into the room: a longer flight to sample
  await sleep(200);
  await ev('__ix.act()');
  ok(await until(`(() => { const d = __ix.drawStats(); return !!d && d.thrown > 0; })()`, 3000), 'thrown bottle drawn in flight');
  ok(await until(`(() => { const d = __ix.drawStats(); return !!d && d.thrown === 0; })()`, 5000), 'and gone when it smashed');

  // ---------------- 2b) HUD: icons, chips (soft soles, NV ready), the pouch, a view model
  for (const t of ['nvg', 'soles', 'masterkey', 'lockpick']) await dbg('interaction.give', { type: t });
  for (const [t, n] of [['mat.scrap', 3], ['mat.wiring', 1], ['mat.optics', 2]] as const) await dbg('interaction.give', { type: t, count: n });
  await ev('__ix.slot(2)');
  await ev(`__game.look(${awayYaw}, -0.15)`);
  const chipsOk = await until(`(() => { const s = __ix.status(); return s.some((x) => /SOFT SOLES/.test(x)) && s.some((x) => /NIGHT VISION/.test(x)); })()`, 6000);
  const status = await ev<string[]>('__ix.status()');
  ok(chipsOk, `status chips: ${status.join(' | ')}`);
  await until(`(() => { const q = __ix.pouch(); return q['mat.scrap'] === 3 && q['mat.optics'] === 2; })()`, 4000);
  const pouch = await ev<Record<string, number>>('__ix.pouch()');
  ok(pouch['mat.scrap'] === 3 && pouch['mat.optics'] === 2, `pouch ${JSON.stringify(pouch)}`);
  ok(await until(`!!document.querySelector('[data-testid="ix-pouch"]')`, 4000), 'pouch chips in the HUD');
  await shot('2-hud');

  // ---------------- 3) night vision in the dark (skipped with the flat debug fill)
  if (!flat) {
    await dbg('interaction.setLights', { on: false });
    await ev(`__ix.flashlight(false)`);
    await ev(`__game.look(${awayYaw}, -0.35)`);
    await shot('3a-dark');
    await ev('__ix.nv()');
    ok(await until('__ix.nightVision()', 4000), 'night vision on');
    await sleep(400);
    await shot('3b-nv-on');
    await ev('__ix.nv()');
    ok(await until('!__ix.nightVision()', 4000), 'night vision off');
    await dbg('interaction.setLights', { on: true });
    await ev(`__ix.flashlight(true)`);
  }

  // ---------------- 4) a drawer tapped open, its contents (fitted to the open part, side by side)
  await dbg('interaction.stock', { id: c0.id, type: 'page', name: 'hound.1' });
  await ev(`__game.teleport(${sx}, ${sz}, ${yawTo(c0.p[0], c0.p[2])})`);
  await frames(3);
  await ev(`__ix.aim(${c0.p[0]}, ${c0.p[1]}, ${c0.p[2]})`);
  await until(`__ix.target()?.id === ${JSON.stringify(`cont:${c0.id}`)}`, 4000);
  const tgt = await ev<{ id: string; view?: { text: string; sub?: string } } | null>('__ix.target()');
  ok(tgt?.id === `cont:${c0.id}`, `aiming at ${tgt?.id}: "${tgt?.view?.text}" / "${tgt?.view?.sub}"`);
  if (!soft) await shot('4a-drawer-prompt');
  await ev(`__ix.use('cont:${c0.id}')`);
  ok(await until(`(__ix.state().containers?.[${JSON.stringify(c0.id)}]?.open ?? 0) > 0`, 4000), 'container open in the mirrored state');
  ok(await until(`Object.values(__ix.state().items).some((it) => it.type === 'page' && it.name === 'hound.1')`, 4000), 'stocked page in the drawer');
  const slot = (c0.parts.find((q) => q.idx === c0.main) ?? c0.parts[0])!.slot;
  await ev(`__ix.aim(${slot[0]}, ${slot[1]}, ${slot[2]})`);
  await frames(3);
  const pv = await ev<{ view?: { text: string } } | null>('__ix.target()');
  ok(!pv?.view || !/hound\.1/.test(pv.view.text), `the page never shows its id ("${pv?.view?.text ?? ''}")`);
  await camera([sx + (sx - c0.p[0]) * 0.15, 1.45, sz + (sz - c0.p[2]) * 0.15], [slot[0], slot[1], slot[2]]);
  await sleep(400);
  await shot('4b-drawer-open');
  await camera(null);

  // ---------------- 5) another drawer mid-ease (ring + label + the part creeping open)
  const c1 = conts.filter((c) => c.id !== c0.id).sort((a, b) => Math.hypot(a.x - c0.x, a.z - c0.z) - Math.hypot(b.x - c0.x, b.z - c0.z))[0];
  if (c1) {
    const x1 = c1.front[0] + 0.5, z1 = c1.front[1] + 0.5;
    await ev(`__game.teleport(${x1}, ${z1}, ${Math.atan2(c1.p[0] - x1, c1.p[2] - z1)})`);
    await frames(3);
    await ev(`__ix.aim(${c1.p[0]}, ${c1.p[1]}, ${c1.p[2]})`);
    await until(`__ix.target()?.id === ${JSON.stringify(`cont:${c1.id}`)}`, 3000);
    void ev('__ix.easeE(2200)');
    const ringOk = await until(`(() => { const h = __ix.hold(); return h.label === 'Easing it open… (quiet)' && (h.k ?? 0) > 0.25; })()`, 1900);
    const h = await ev<{ k: number | null; label: string | null }>('__ix.hold()');
    ok(ringOk && (h.k ?? 0) < 1, `ease ring ${JSON.stringify(h)}`);
    await shot('5-drawer-ease');
    ok(await until(`(__ix.state().containers?.[${JSON.stringify(c1.id)}]?.open ?? 0) > 0`, 4000), 'eased open');
  }

  // ---------------- 6) a door mid-ease: the ring, the door creeping open
  const dsp = L.doors.filter((d) => d.kind === 'door' && !d.initiallyOpen).map((d) => doorSpot(L, 'door', d.id)).find((x) => !!x);
  if (dsp) {
    await ev(`__game.teleport(${dsp.stand[0]}, ${dsp.stand[1]}, 0)`);
    // the teleport lands before we aim (a slow frame after the drawer ease once left the camera at the drawer)
    await until(`(() => { const c = __ix.camera(); return !!c && Math.hypot(c.o[0] - ${dsp.stand[0]}, c.o[2] - ${dsp.stand[1]}) < 0.35; })()`, 4000);
    await frames(3);
    await ev(`__ix.aim(${dsp.look[0]}, 1.1, ${dsp.look[2]})`);
    ok(await until(`__ix.target()?.id === ${JSON.stringify(`door:${dsp.door.id}`)}`, 4000), `aiming at door ${dsp.door.id}`);
    const wasOpen = await ev<boolean>(`!!__ix.state().doors[${dsp.door.id}]?.open`);
    void ev('__ix.easeE(2600)');
    const ringOk = await until(`(() => { const h = __ix.hold(); return /Easing it (open|shut)/.test(h.label ?? '') && (h.k ?? 0) > 0.3; })()`, 2300);
    const h = await ev<{ k: number | null; label: string | null }>('__ix.hold()');
    ok(ringOk, `door ease ring ${JSON.stringify(h)}`);
    await shot('6-door-ease');
    ok(await until(`__ix.state().doors[${dsp.door.id}]?.open === ${!wasOpen}`, 4000), `door eased ${wasOpen ? 'shut' : 'open'}`);
    const fx2 = await ev<Record<string, number>>('__ix.fx()');
    ok((fx2.doorSoft ?? 0) >= 1, `soft door fx (${JSON.stringify(fx2)})`);
  }

  // ---------------- 7) the death card's creeping tip (the mate keeps the crew alive)
  await dbg('interaction.kill', { killer: 'HOUND', reason: 'heard your FOOTSTEPS (5 m)', detail: 'You walked past it at 3 m.' });
  ok(await until(`!!document.querySelector('[data-testid="ix-death-tip"]')`, 4000), 'death card: "Creeping (C) is silent to the Hound."');
  await shot('7-deathcard');
}
