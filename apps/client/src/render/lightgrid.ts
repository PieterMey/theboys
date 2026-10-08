// Owner: env-render (v1.2). Room light grid: ONE RGBA16F DataTexture over the layout's 1 m cells
// (rgb = fixture irradiance proxy, a = room tag = space id, -1 solid) plus a few table rows under the grid
// (fog volumes, per-space mist params). NearestFilter: read with textureLoad only, so it costs a texture binding but
// no sampler in lit materials (they sit near the 16-sampler limit). Fog, mist and GI all read this one texture
// (texture nodes with the same texture share one binding).
// Re-splats only the spaces whose fixture levels changed (every drawn frame), plus 25 % spill through doors open
// more than 2 %. Deterministic: same layout + levels + doors -> the same texels.
// Allocation-free per frame (gate P: the old update built ~50 KB of garbage per steady frame and ~1.3 MB per frame
// while every room's level changed): the lights live in ONE persistent structure-of-arrays table the caller fills in
// place (lightTable / updateTable), every per-frame buffer is a typed array sized at setLayout, and the splat inner
// loop is a top-level function over typed arrays (doubles stay unboxed in optimised code).
import * as THREE from 'three/webgpu';
import { Fn, float, floor, fract, int, ivec2, renderGroup, select, textureLoad, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { FogVolume, V3 } from './api.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export const MAX_FOG_VOLUMES = 8;
/** texels per fog volume row entry: (p, r), (density, frost, ground, 0), (rgb, 0) */
const VOL_TEXELS = 3;

export interface GridLight { space: number; x: number; y: number; z: number; r: number; g: number; b: number; cd: number; range: number; level: number }

/** structure-of-arrays light table (index i = one fixture); entries with space < 0 or level <= 0.001 are unlit */
export interface GridLightTable {
  /** entries in use (set by lightTable(n)) */
  n: number;
  space: Int32Array;
  x: Float32Array; y: Float32Array; z: Float32Array;
  r: Float32Array; g: Float32Array; b: Float32Array;
  cd: Float32Array; range: Float32Array; level: Float32Array;
}

function makeTable(cap: number): GridLightTable {
  return {
    n: 0, space: new Int32Array(cap),
    x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap),
    r: new Float32Array(cap), g: new Float32Array(cap), b: new Float32Array(cap),
    cd: new Float32Array(cap), range: new Float32Array(cap), level: new Float32Array(cap),
  };
}

export interface SpaceParams { mist: number; haze: number; frost: number; steam: number }

const DEFAULT_PARAMS: Readonly<SpaceParams> = Object.freeze({ mist: 1, haze: 1, frost: 0, steam: 0 });

export interface LightGridCfg {
  /** fraction of a room's door-side light spilling into the neighbour through an open door */
  spill: number;
  /** spill reach into the neighbour (m) */
  spillReach: number;
  /** a door counts as open above this openness */
  doorOpen: number;
}

export const GRID_DEFAULTS: LightGridCfg = { spill: 0.25, spillReach: 4, doorOpen: 0.02 };

const h = THREE.DataUtils.toHalfFloat;

/** fixture irradiance proxy at horizontal distance d (m), height difference dy, range R: cd / (1 + r^2 / 4) windowed */
export function splatWeight(d2: number, dy: number, range: number): number {
  const r2 = d2 + dy * dy;
  const w = 1 - r2 / (range * range);
  if (w <= 0) return 0;
  return (w * w) / (1 + r2 * 0.25);
}

/** typed-array state of a grid (one object, read by the hot top-level loops below) */
interface GridBufs {
  W: number;
  /** per-cell rgb: the room's own fixtures / after the door spill */
  direct: Float32Array;
  finalV: Float32Array;
  /** cells of space s: cellList[cellStart[s] .. cellStart[s + 1]) with their centres and texel offsets */
  cellStart: Int32Array;
  cellList: Int32Array;
  cellX: Float32Array;
  cellZ: Float32Array;
  cellTexel: Int32Array;
  /** doors of space s: sdList[sdStart[s] .. sdStart[s + 1]) */
  sdStart: Int32Array;
  sdList: Int32Array;
  doorA: Int32Array;
  doorCx: Float32Array;
  doorCz: Float32Array;
  doorOpen: Uint8Array;
  /** quantised openness (Float64: a Float32 copy of 0.35 never equals 0.35 again and re-spilled every frame) */
  doorSig: Float64Array;
  /** door-side cells of each door: A side dACells[dAStart[d] .. dAStart[d + 1]), B side likewise */
  dAStart: Int32Array;
  dACells: Int32Array;
  dBStart: Int32Array;
  dBCells: Int32Array;
  spill: number;
  reach2: number;
}

/** adds light li of the table to `direct` over the cells [j0, j1) of one space (the weights of splatWeight) */
function splatLight(B: GridBufs, j0: number, j1: number, T: GridLightTable, q: Float32Array, li: number): void {
  const direct = B.direct, cellList = B.cellList, cellX = B.cellX, cellZ = B.cellZ;
  const k = T.cd[li] * q[li];
  const lx = T.x[li], lz = T.z[li], dy = T.y[li] - 1.0, range = T.range[li];
  const R2 = range * range, dy2 = dy * dy;
  const cr = T.r[li], cg = T.g[li], cb = T.b[li];
  for (let j = j0; j < j1; j++) {
    const dx = cellX[j] - lx, dz = cellZ[j] - lz;
    const r2 = dx * dx + dz * dz + dy2;
    const w0 = 1 - r2 / R2;
    if (w0 <= 0) continue;
    const w = ((w0 * w0) / (1 + r2 * 0.25)) * k;
    const o = cellList[j] * 3;
    direct[o] += cr * w; direct[o + 1] += cg * w; direct[o + 2] += cb * w;
  }
}

/** finalV of space s = its own light + spill of the door-side light of every open door's other side */
function spillInto(B: GridBufs, s: number): void {
  const direct = B.direct, finalV = B.finalV, cellList = B.cellList, cellX = B.cellX, cellZ = B.cellZ;
  const j0 = B.cellStart[s], j1 = B.cellStart[s + 1];
  for (let j = j0; j < j1; j++) { const o = cellList[j] * 3; finalV[o] = direct[o]; finalV[o + 1] = direct[o + 1]; finalV[o + 2] = direct[o + 2]; }
  for (let k = B.sdStart[s]; k < B.sdStart[s + 1]; k++) {
    const di = B.sdList[k];
    if (!B.doorOpen[di]) continue;
    const o = B.doorSig[di];
    // the light comes in from the far side's door cells
    const fromA = B.doorA[di] !== s;
    const st = fromA ? B.dAStart : B.dBStart, cl = fromA ? B.dACells : B.dBCells;
    const c0 = st[di], c1 = st[di + 1];
    if (c1 <= c0) continue;
    let r = 0, g = 0, b = 0;
    for (let c = c0; c < c1; c++) { const p = cl[c] * 3; r += direct[p]; g += direct[p + 1]; b += direct[p + 2]; }
    const kk = (B.spill * o) / (c1 - c0);
    r *= kk; g *= kk; b *= kk;
    if (r + g + b <= 1e-5) continue;
    const dcx = B.doorCx[di], dcz = B.doorCz[di], reach2 = B.reach2;
    for (let j = j0; j < j1; j++) {
      const dx = cellX[j] - dcx, dz = cellZ[j] - dcz;
      const qq = 1 - (dx * dx + dz * dz) / reach2;
      if (qq <= 0) continue;
      const w = qq * qq;
      const p = cellList[j] * 3;
      finalV[p] += r * w; finalV[p + 1] += g * w; finalV[p + 2] += b * w;
    }
  }
}

/** texels (rgb + room tag) of space s */
function writeSpace(B: GridBufs, data: Uint16Array, s: number): void {
  const finalV = B.finalV, cellList = B.cellList, cellTexel = B.cellTexel;
  const tag = h(s);
  for (let j = B.cellStart[s]; j < B.cellStart[s + 1]; j++) {
    const o = cellList[j] * 3, t = cellTexel[j];
    data[t] = h(finalV[o]); data[t + 1] = h(finalV[o + 1]); data[t + 2] = h(finalV[o + 2]); data[t + 3] = tag;
  }
}

export interface LightGrid {
  readonly texture: THREE.DataTexture;
  readonly W: number;
  readonly H: number;
  /** (W, H, texW, volRow) */
  readonly dims: { value: THREE.Vector4 };
  /** (spaceRow0, fog volume count, 0, 0) */
  readonly rows: { value: THREE.Vector4 };
  setLayout(L: LevelLayout | null): void;
  /** the persistent light table, holding at least n entries (table.n = n). The caller writes every entry it uses
   *  each frame, in place, then calls updateTable(). A growth reallocates it (rare): always use the returned table. */
  lightTable(n: number): GridLightTable;
  /** per drawn frame, from the light table: re-splat changed spaces (+ spill through open doors). Returns the spaces
   *  rewritten (0 = nothing changed, no upload). Allocation-free. */
  updateTable(doorOpenness: (id: number) => number): number;
  /** the same from an array of lights (copied into the light table; tests / tools) */
  update(lights: readonly GridLight[], doorOpenness: (id: number) => number): number;
  /** CPU sample (tag-aware bilinear like the shader): rgb irradiance proxy at world (x, z) */
  sample(x: number, z: number, out?: V3): V3;
  /** cell value (rgb) and tag at a cell; null outside */
  cell(cx: number, cz: number): { rgb: V3; tag: number } | null;
  setVolumes(list: readonly FogVolume[]): void;
  volumes(): readonly FogVolume[];
  setSpaceParams(space: number, p: Partial<SpaceParams>): void;
  /** per-space params (a shared read-only default for unknown spaces) */
  spaceParams(space: number): Readonly<SpaceParams>;
  /** spaces re-splatted since the layout was set (tests / diag) */
  stats(): { splats: number; uploads: number; spaces: number };
}

const I32_0 = new Int32Array(0), F32_0 = new Float32Array(0);

export function createLightGrid(cfg: Partial<LightGridCfg> = {}): LightGrid {
  const C = { ...GRID_DEFAULTS, ...cfg };
  let W = 1, H = 1, texW = 32, texH = 4;
  let volRow = 1, spaceRow0 = 2;
  let data = new Uint16Array(texW * texH * 4);
  const texture = new THREE.DataTexture(data, texW, texH, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.name = 'render-light-grid';
  texture.needsUpdate = true;
  const dims = { value: new THREE.Vector4(1, 1, texW, volRow) };
  const rows = { value: new THREE.Vector4(spaceRow0, 0, 0, 0) };
  let owner: Int32Array = new Int32Array(0);
  const B: GridBufs = {
    W: 1, direct: F32_0, finalV: F32_0, cellStart: new Int32Array(1), cellList: I32_0, cellX: F32_0, cellZ: F32_0, cellTexel: I32_0,
    sdStart: new Int32Array(1), sdList: I32_0, doorA: I32_0, doorCx: F32_0, doorCz: F32_0, doorOpen: new Uint8Array(0), doorSig: new Float64Array(0),
    dAStart: new Int32Array(1), dACells: I32_0, dBStart: new Int32Array(1), dBCells: I32_0, spill: C.spill, reach2: C.spillReach * C.spillReach,
  };
  let nSpaces = 0, nDoors = 0;
  let doorId: Int32Array = I32_0, doorB: Int32Array = I32_0, doorFixed = new Uint8Array(0);
  // per-frame scratch: sized at setLayout (spaces) and by lightTable (lights); never allocated per frame
  let sig = new Float64Array(0), spaceSig = new Float64Array(0);
  let dirtyD = new Uint8Array(0), dirtyF = new Uint8Array(0);
  let perStart = new Int32Array(1), perFill = new Int32Array(0);
  let table = makeTable(64);
  let q = new Float32Array(64);
  let perIdx = new Int32Array(64);
  let params: SpaceParams[] = [];
  let vols: FogVolume[] = [];
  let splats = 0, uploads = 0;
  let layoutRef: LevelLayout | null = null;
  let first = true;

  function alloc(n: number) {
    const oldW = texW, oldH = texH;
    texW = Math.max(W, MAX_FOG_VOLUMES * VOL_TEXELS, 32);
    volRow = H;
    spaceRow0 = H + 1;
    texH = H + 1 + Math.max(1, Math.ceil(n / texW));
    // a new size needs a new GPU texture (writeTexture into the old one would overflow): dispose, the renderer
    // re-creates it on the next use (level loads happen behind the loading screen)
    if ((oldW !== texW || oldH !== texH) && texture.version > 0) texture.dispose();
    data = new Uint16Array(texW * texH * 4);
    texture.image = { data, width: texW, height: texH } as unknown as typeof texture.image;
    dims.value.set(W, H, texW, volRow);
    rows.value.set(spaceRow0, vols.length, 0, 0);
  }

  function writeTexel(x: number, y: number, r: number, g: number, b: number, a: number) {
    const o = (y * texW + x) * 4;
    data[o] = h(r); data[o + 1] = h(g); data[o + 2] = h(b); data[o + 3] = h(a);
  }

  function writeVolumes() {
    for (let i = 0; i < MAX_FOG_VOLUMES; i++) {
      const v = vols[i];
      if (!v) { for (let k = 0; k < VOL_TEXELS; k++) writeTexel(i * VOL_TEXELS + k, volRow, 0, 0, 0, 0); continue; }
      const col = new THREE.Color(v.color ?? '#9aa6b0');
      writeTexel(i * VOL_TEXELS, volRow, v.p[0], v.p[1], v.p[2], Math.max(0.05, v.r));
      writeTexel(i * VOL_TEXELS + 1, volRow, Math.max(0, v.density), Math.max(0, Math.min(1, v.frost ?? 0)), v.ground ? 1 : 0, 0);
      writeTexel(i * VOL_TEXELS + 2, volRow, col.r, col.g, col.b, 0);
    }
    rows.value.y = Math.min(MAX_FOG_VOLUMES, vols.length);
  }

  function writeParams(space: number) {
    const p = params[space];
    if (!p) return;
    writeTexel(space % texW, spaceRow0 + Math.floor(space / texW), p.mist, p.haze, p.frost, p.steam);
  }

  /** per-space scratch for n spaces */
  function sizeSpaces(n: number) {
    sig = new Float64Array(n);
    spaceSig = new Float64Array(n).fill(-1);
    dirtyD = new Uint8Array(n);
    dirtyF = new Uint8Array(n);
    perStart = new Int32Array(n + 1);
    perFill = new Int32Array(n);
  }

  /** flat per-space cell lists (ascending cell index inside each space) */
  function buildCells(n: number) {
    const total = W * H;
    const start = new Int32Array(n + 1);
    for (let c = 0; c < total; c++) { const s = owner[c]; if (s >= 0 && s < n) start[s + 1]++; }
    for (let s = 0; s < n; s++) start[s + 1] += start[s];
    const m = start[n];
    const list = new Int32Array(m), cx = new Float32Array(m), cz = new Float32Array(m), tex = new Int32Array(m);
    const fill = start.slice(0, Math.max(1, n));
    for (let c = 0; c < total; c++) {
      const s = owner[c];
      if (s < 0 || s >= n) continue;
      const j = fill[s]++;
      const x = c % W, z = (c / W) | 0;
      list[j] = c; cx[j] = x + 0.5; cz[j] = z + 0.5; tex[j] = (z * texW + x) * 4;
    }
    B.cellStart = start; B.cellList = list; B.cellX = cx; B.cellZ = cz; B.cellTexel = tex;
  }

  /** doors as typed arrays + the doors of each space (layout order, a then b, like the per-space lists before) */
  function buildDoors(L: LevelLayout | null, n: number) {
    const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
    const recs: { id: number; a: number; b: number; cx: number; cz: number; cellsA: number[]; cellsB: number[]; fixed: boolean }[] = [];
    for (const d of L?.doors ?? []) {
      if (d.a < 0 || d.b < 0 || d.a >= n || d.b >= n || d.kind === 'blocked') continue;
      const cellsA: number[] = [], cellsB: number[] = [];
      for (let i = 0; i < d.len; i++) {
        const [x0, y0, x1, y1] = d.dir === 'v' ? [d.x - 1, d.y + i, d.x, d.y + i] : [d.x + i, d.y - 1, d.x + i, d.y];
        for (const [x, y] of [[x0, y0], [x1, y1]] as const) {
          const o = own(x, y);
          if (o === d.a) cellsA.push(y * W + x);
          else if (o === d.b) cellsB.push(y * W + x);
        }
      }
      const cx = d.dir === 'v' ? d.x : d.x + d.len / 2;
      const cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
      recs.push({ id: d.id, a: d.a, b: d.b, cx, cz, cellsA, cellsB, fixed: d.kind === 'open' });
    }
    nDoors = recs.length;
    doorId = Int32Array.from(recs, (r) => r.id);
    doorB = Int32Array.from(recs, (r) => r.b);
    doorFixed = Uint8Array.from(recs, (r) => (r.fixed ? 1 : 0));
    B.doorA = Int32Array.from(recs, (r) => r.a);
    B.doorCx = Float32Array.from(recs, (r) => r.cx);
    B.doorCz = Float32Array.from(recs, (r) => r.cz);
    B.doorOpen = new Uint8Array(nDoors);
    B.doorSig = new Float64Array(nDoors).fill(-1);
    const flat = (pick: (r: (typeof recs)[number]) => number[]) => {
      const st = new Int32Array(nDoors + 1);
      for (let i = 0; i < nDoors; i++) st[i + 1] = st[i] + pick(recs[i]).length;
      const cl = new Int32Array(st[nDoors]);
      for (let i = 0; i < nDoors; i++) cl.set(pick(recs[i]), st[i]);
      return [st, cl] as const;
    };
    [B.dAStart, B.dACells] = flat((r) => r.cellsA);
    [B.dBStart, B.dBCells] = flat((r) => r.cellsB);
    const sdStart = new Int32Array(n + 1);
    for (const r of recs) { sdStart[r.a + 1]++; sdStart[r.b + 1]++; }
    for (let s = 0; s < n; s++) sdStart[s + 1] += sdStart[s];
    const sdList = new Int32Array(sdStart[n]);
    const fill = sdStart.slice(0, Math.max(1, n));
    recs.forEach((r, di) => { sdList[fill[r.a]++] = di; sdList[fill[r.b]++] = di; });
    B.sdStart = sdStart;
    B.sdList = sdList;
  }

  function updateTable(doorOpenness: (id: number) => number): number {
    if (!layoutRef) return 0;
    const n = nSpaces, T = table, m = T.n;
    // 1) quantised levels (1/16: the mains hum never re-splats a steady room) + per-space signatures and light counts
    sig.fill(0);
    perFill.fill(0);
    for (let i = 0; i < m; i++) {
      const s = T.space[i];
      const lv = s >= 0 && s < n && T.level[i] > 0.001 ? Math.round(T.level[i] * 16) / 16 : 0;
      q[i] = lv;
      if (lv <= 0) continue;
      perFill[s]++;
      sig[s] += Math.round(lv * T.cd[i] * 64) * (1 + T.r[i] * 3 + T.g[i] * 7 + T.b[i] * 13) + T.x[i] * 0.001 + T.z[i] * 0.0007;
    }
    // 2) what changed: a space's signature (re-splat) or a door's quantised openness (re-composite both sides)
    let any = false;
    for (let s = 0; s < n; s++) {
      const d = first || sig[s] !== spaceSig[s] ? 1 : 0;
      dirtyD[s] = d;
      dirtyF[s] = d;
      if (d) { spaceSig[s] = sig[s]; any = true; }
    }
    for (let di = 0; di < nDoors; di++) {
      const raw = doorFixed[di] ? 1 : Math.max(0, Math.min(1, doorOpenness(doorId[di])));
      const o = raw > C.doorOpen ? Math.round(raw * 20) / 20 || 0.05 : 0;
      if (o !== B.doorSig[di]) { B.doorSig[di] = o; B.doorOpen[di] = o > 0 ? 1 : 0; dirtyF[B.doorA[di]] = 1; dirtyF[doorB[di]] = 1; any = true; }
    }
    first = false;
    if (!any) return 0;
    // a changed source re-spills into every neighbour behind an open door
    for (let s = 0; s < n; s++) {
      if (!dirtyD[s]) continue;
      for (let k = B.sdStart[s]; k < B.sdStart[s + 1]; k++) {
        const di = B.sdList[k];
        if (B.doorOpen[di]) dirtyF[B.doorA[di] === s ? doorB[di] : B.doorA[di]] = 1;
      }
    }
    // 3) per-space light index lists (a counting sort over the table)
    perStart[0] = 0;
    for (let s = 0; s < n; s++) { perStart[s + 1] = perStart[s] + perFill[s]; perFill[s] = perStart[s]; }
    for (let i = 0; i < m; i++) if (q[i] > 0) perIdx[perFill[T.space[i]]++] = i;
    // 4) re-splat the changed spaces
    const direct = B.direct, cellList = B.cellList;
    for (let s = 0; s < n; s++) {
      if (!dirtyD[s]) continue;
      const j0 = B.cellStart[s], j1 = B.cellStart[s + 1];
      for (let j = j0; j < j1; j++) { const o = cellList[j] * 3; direct[o] = 0; direct[o + 1] = 0; direct[o + 2] = 0; }
      for (let k = perStart[s]; k < perStart[s + 1]; k++) splatLight(B, j0, j1, T, q, perIdx[k]);
      splats++;
    }
    // 5) composite (door spill) + texels of every space whose result may have changed
    let count = 0;
    for (let s = 0; s < n; s++) {
      if (!dirtyF[s]) continue;
      spillInto(B, s);
      writeSpace(B, data, s);
      count++;
    }
    texture.needsUpdate = true;
    uploads++;
    return count;
  }

  const grid: LightGrid = {
    texture,
    get W() { return W; },
    get H() { return H; },
    dims: dims as unknown as { value: THREE.Vector4 },
    rows: rows as unknown as { value: THREE.Vector4 },
    stats: () => ({ splats, uploads, spaces: nSpaces }),
    setLayout(L) {
      layoutRef = L;
      splats = 0; uploads = 0; first = true;
      if (!L) {
        W = 1; H = 1; nSpaces = 0;
        B.W = 1;
        owner = new Int32Array(1).fill(-1);
        params = [];
        alloc(1);
        B.direct = new Float32Array(3); B.finalV = new Float32Array(3);
        buildCells(0);
        buildDoors(null, 0);
        sizeSpaces(0);
        writeTexel(0, 0, 0, 0, 0, -1);
        writeVolumes();
        texture.needsUpdate = true;
        return;
      }
      W = L.W; H = L.H;
      B.W = W;
      owner = Int32Array.from(L.owner);
      const n = L.spaces.length;
      nSpaces = n;
      alloc(n);
      B.direct = new Float32Array(W * H * 3);
      B.finalV = new Float32Array(W * H * 3);
      buildCells(n);
      for (let c = 0; c < W * H; c++) writeTexel(c % W, (c / W) | 0, 0, 0, 0, owner[c]);
      params = Array.from({ length: n }, () => ({ mist: 1, haze: 1, frost: 0, steam: 0 }));
      for (let s = 0; s < n; s++) writeParams(s);
      buildDoors(L, n);
      sizeSpaces(n);
      writeVolumes();
      texture.needsUpdate = true;
      uploads++;
    },
    lightTable(n) {
      if (n > table.space.length) {
        const cap = Math.max(n, table.space.length * 2);
        table = makeTable(cap);
        q = new Float32Array(cap);
        perIdx = new Int32Array(cap);
      }
      table.n = n;
      return table;
    },
    updateTable,
    update(lights, doorOpenness) {
      const T = grid.lightTable(lights.length);
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        T.space[i] = l.space; T.x[i] = l.x; T.y[i] = l.y; T.z[i] = l.z;
        T.r[i] = l.r; T.g[i] = l.g; T.b[i] = l.b; T.cd[i] = l.cd; T.range[i] = l.range; T.level[i] = l.level;
      }
      return updateTable(doorOpenness);
    },
    cell(cx, cz) {
      if (cx < 0 || cz < 0 || cx >= W || cz >= H || !layoutRef) return null;
      const c = cz * W + cx;
      const f = B.finalV;
      return { rgb: [f[c * 3], f[c * 3 + 1], f[c * 3 + 2]], tag: owner[c] };
    },
    sample(x, z, out = [0, 0, 0]) {
      out[0] = 0; out[1] = 0; out[2] = 0;
      if (!layoutRef) return out;
      const f = B.finalV;
      const cx = Math.floor(x), cz = Math.floor(z);
      const tag = cx >= 0 && cz >= 0 && cx < W && cz < H ? owner[cz * W + cx] : -1;
      const fx = x - 0.5, fz = z - 0.5;
      const x0 = Math.floor(fx), z0 = Math.floor(fz);
      const wx = fx - x0, wz = fz - z0;
      let ws = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const xi = Math.min(W - 1, Math.max(0, x0 + i)), zj = Math.min(H - 1, Math.max(0, z0 + j));
        const c = zj * W + xi;
        if (owner[c] !== tag) continue;
        const w = (i ? wx : 1 - wx) * (j ? wz : 1 - wz);
        out[0] += f[c * 3] * w; out[1] += f[c * 3 + 1] * w; out[2] += f[c * 3 + 2] * w;
        ws += w;
      }
      if (ws > 1e-4) { out[0] /= ws; out[1] /= ws; out[2] /= ws; }
      return out;
    },
    setVolumes(list) {
      vols = list.slice(0, MAX_FOG_VOLUMES).map((v) => ({ ...v, p: [v.p[0], v.p[1], v.p[2]] as V3 }));
      writeVolumes();
      texture.needsUpdate = true;
    },
    volumes: () => vols,
    setSpaceParams(space, p) {
      if (!params[space]) return;
      Object.assign(params[space], p);
      writeParams(space);
      texture.needsUpdate = true;
    },
    spaceParams: (space) => params[space] ?? DEFAULT_PARAMS,
  };
  grid.setLayout(null);
  return grid;
}

// ------------------------------------------------------------------------------------------------ TSL helpers

export interface GridNodes {
  /** the ONE texture node source (every helper builds textureLoad nodes on the same texture: one binding) */
  texture: THREE.DataTexture;
  dims: N;
  rows: N;
  /** texel (ix, iz) of the grid region (clamped) */
  load(ix: N, iz: N): N;
  /** tag-aware bilinear rgb at world (x, z); tag = the room tag to keep (or -2 = any) */
  bilinear(x: N, z: N, tag: N): N;
  /** room tag at world (x, z) */
  tagAt(x: N, z: N): N;
  /** per-space params vec4 (mist, haze, frost, steam) for tag */
  spaceParams(tag: N): N;
  /** fog volume i: [p.xyz, r], [density, frost, ground, 0], [rgb, 0] */
  volume(i: N): { a: N; b: N; c: N };
}

export function gridNodes(grid: LightGrid): GridNodes {
  const dims = uniform(grid.dims.value).setGroup(renderGroup);
  const rows = uniform(grid.rows.value).setGroup(renderGroup);
  const tex = grid.texture;
  const load = (ix: N, iz: N) => {
    const x = (int(ix) as N).clamp(int(0), int(dims.x).sub(int(1)));
    const z = (int(iz) as N).clamp(int(0), int(dims.y).sub(int(1)));
    return textureLoad(tex, ivec2(x, z));
  };
  const tagAt = (x: N, z: N) => load(floor(x), floor(z)).a;
  const bilinear = Fn(([x, z, tag]: [N, N, N]) => {
    const f = vec2(x, z).sub(0.5).toVar();
    const i0 = floor(f).toVar();
    const w = fract(f).toVar();
    const t00 = load(i0.x, i0.y);
    const t10 = load(i0.x.add(1), i0.y);
    const t01 = load(i0.x, i0.y.add(1));
    const t11 = load(i0.x.add(1), i0.y.add(1));
    const any = (tag as N).lessThan(-1.5);
    const m = (t: N) => select(any.or(t.a.sub(tag).abs().lessThan(0.5)), float(1), float(0));
    const w00 = w.x.oneMinus().mul(w.y.oneMinus()).mul(m(t00));
    const w10 = w.x.mul(w.y.oneMinus()).mul(m(t10));
    const w01 = w.x.oneMinus().mul(w.y).mul(m(t01));
    const w11 = w.x.mul(w.y).mul(m(t11));
    const sum = t00.rgb.mul(w00).add(t10.rgb.mul(w10)).add(t01.rgb.mul(w01)).add(t11.rgb.mul(w11));
    return sum.div(w00.add(w10).add(w01).add(w11).max(1e-3));
  });
  const spaceParams = (tag: N) => {
    const id = int((tag as N).max(0));
    const tw = int(dims.z);
    return textureLoad(tex, ivec2(id.mod(tw), int(rows.x).add(id.div(tw)))).toVar();
  };
  const volume = (i: N) => {
    const row = int(dims.w);
    const x = int(i).mul(int(VOL_TEXELS));
    return { a: textureLoad(tex, ivec2(x, row)), b: textureLoad(tex, ivec2(x.add(int(1)), row)), c: textureLoad(tex, ivec2(x.add(int(2)), row)) };
  };
  void vec3; void vec4;
  return { texture: tex, dims, rows, load, bilinear: (x, z, tag) => bilinear(x, z, tag), tagAt, spaceParams, volume };
}
