// Owner: track ② Level. Level geometry from a LevelLayout: one merged BufferGeometry per space (groups = materials).
// Walls are edge runs trimmed by T/2 at both ends; a post at every grid vertex touched by a wall emits faces only
// where no wall continues (jambs, outside corners). Lintels over door openings are trimmed the same way, so no two
// faces ever overlap (no z-fighting). Faces belong to the space they face (per-space culling just works).
// UVs are world-space metres / TILE with a right-handed tangent frame (u along up x n, v up).
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LayoutDoor, LayoutSpace, LevelLayout } from '@dead-air/shared/layout.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import { VAN_CAB_L } from '@dead-air/shared/procgen/van.ts';
import type { MatId } from './materials.ts';

export const DOOR_H = 2.1;
/** outdoor face height of building walls (the facade) */
export const FACADE_H = 4.6;
export const WAINSCOT = 1.15;
export const TILE = 2;

export interface SpaceTheme { floor: MatId; wallLo: MatId; wallHi: MatId; ceil: MatId }

const CLINICAL = new Set(['morgue', 'infirmary', 'showers', 'cold', 'cryo', 'kitchen', 'laundry', 'nursery']);
const INDUSTRIAL = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks', 'garage', 'dock', 'pit', 'storage', 'greenhouse']);
const HEAVY = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks']);

export function themeOf(s: LayoutSpace): SpaceTheme {
  if (s.kind === 'outside') return { floor: s.type === 'kennel' ? 'floor_dirt' : 'asphalt', wallLo: 'facade', wallHi: 'facade', ceil: 'ceiling_concrete' };
  if (s.kind === 'corridor') return { floor: 'floor_lino', wallLo: 'wall_tile_green', wallHi: 'wall_plaster_green', ceil: 'ceiling_tiles' };
  if (s.kind === 'vault') return { floor: 'floor_metal', wallLo: 'wall_vault', wallHi: 'wall_vault', ceil: 'ceiling_concrete' };
  if (s.type === 'lobby') return { floor: 'floor_tiles', wallLo: 'wall_tile_green', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
  if (CLINICAL.has(s.type)) return { floor: 'floor_tiles', wallLo: 'wall_tile_white', wallHi: 'wall_tile_white', ceil: 'ceiling_tiles' };
  if (INDUSTRIAL.has(s.type)) return { floor: HEAVY.has(s.type) ? 'floor_metal' : 'floor_concrete', wallLo: 'wall_concrete_dark', wallHi: 'wall_concrete', ceil: 'ceiling_metal' };
  if (s.type === 'server' || s.type === 'radio') return { floor: 'floor_rubber', wallLo: 'wall_plaster_blue', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
  return { floor: 'floor_lino', wallLo: 'wall_plaster_blue', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
}

interface Bucket { pos: number[]; nor: number[]; uv: number[]; idx: number[] }

export interface FenceRun { x0: number; z0: number; x1: number; z1: number }

export interface LevelGeometry {
  spaces: Map<number, { geometry: THREE.BufferGeometry; mats: MatId[] }>;
  fences: FenceRun[];
  /** cells covered by the van model (cargo + driver cab) */
  vanMask: Uint8Array;
  stats: { tris: number; buckets: number; runs: number; posts: number; lintels: number };
}

const EK = { none: 0, wall: 1, opening: 2, fence: 3 } as const;

export function buildLevelGeometry(L: LevelLayout): LevelGeometry {
  const { W, H, owner, spaces } = L;
  const WH = L.wallH;
  const h2 = HALF_T;
  const buckets = new Map<string, Bucket>();
  const B = (space: number, mat: MatId): Bucket => {
    const k = `${space}|${mat}`;
    let b = buckets.get(k);
    if (!b) { b = { pos: [], nor: [], uv: [], idx: [] }; buckets.set(k, b); }
    return b;
  };
  let tris = 0;
  /** emit a planar quad with normal n; corners in any order around the quad; winding fixed to face n */
  const quad = (b: Bucket, p: number[][], n: readonly [number, number, number]) => {
    const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
    const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const pts = cx * n[0] + cy * n[1] + cz * n[2] >= 0 ? p : [p[0], p[3], p[2], p[1]];
    const base = b.pos.length / 3;
    // tangent t = up x n for walls; floors u=x v=-z; ceilings u=x v=z
    for (const v of pts) {
      b.pos.push(v[0], v[1], v[2]);
      b.nor.push(n[0], n[1], n[2]);
      let u: number, w: number;
      if (n[1] > 0.5) { u = v[0]; w = -v[2]; }
      else if (n[1] < -0.5) { u = v[0]; w = v[2]; }
      else { u = v[0] * n[2] - v[2] * n[0]; w = v[1]; }
      b.uv.push(u / TILE, w / TILE);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    tris += 2;
  };

  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
  const isOpen = (s: number) => s >= 0 && spaces[s].open;
  const theme = spaces.map((s) => themeOf(s));
  // van footprint: rendered by the van model, not the mesher
  const vanMask = new Uint8Array(W * H);
  const cab = L.van.cab;
  for (let y = cab.y; y < Math.min(H, cab.y + cab.h + VAN_CAB_L); y++) for (let x = cab.x; x < cab.x + cab.w; x++) vanMask[y * W + x] = 1;
  const masked = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && vanMask[y * W + x] === 1;
  const isVanSpace = (s: number) => s >= 0 && spaces[s].type === 'van';

  const doorV = new Map<number, LayoutDoor>(), doorH = new Map<number, LayoutDoor>();
  for (const d of L.doors) for (let i = 0; i < d.len; i++) {
    if (d.dir === 'v') doorV.set((d.y + i) * (W + 1) + d.x, d); else doorH.set(d.y * W + d.x + i, d);
  }
  const kindV = (x: number, y: number): number => {
    if (y < 0 || y >= H || x < 0 || x > W) return EK.none;
    const a = own(x - 1, y), b = own(x, y);
    if (a === b || masked(x - 1, y) || masked(x, y)) return EK.none;
    const d = doorV.get(y * (W + 1) + x);
    if (d) return d.kind === 'open' ? EK.none : EK.opening;
    const oa = isOpen(a), ob = isOpen(b);
    if ((oa && ob) || (oa && x === W) || (ob && x === 0)) return EK.fence;
    return EK.wall;
  };
  const kindH = (x: number, y: number): number => {
    if (x < 0 || x >= W || y < 0 || y > H) return EK.none;
    const a = own(x, y - 1), b = own(x, y);
    if (a === b || masked(x, y - 1) || masked(x, y)) return EK.none;
    const d = doorH.get(y * W + x);
    if (d) return d.kind === 'open' ? EK.none : EK.opening;
    const oa = isOpen(a), ob = isOpen(b);
    if ((oa && ob) || (oa && y === H) || (ob && y === 0)) return EK.fence;
    return EK.wall;
  };
  const sideH = (s: number) => (isOpen(s) ? FACADE_H : WH);
  const faceable = (s: number) => s >= 0 && !isVanSpace(s);

  /** vertical face strip with the wainscot split for indoor spaces */
  const wallFace = (s: number, corners: (y0: number, y1: number) => number[][], n: readonly [number, number, number], y0 = 0, y1 = sideH(s)) => {
    const th = theme[s];
    if (isOpen(s)) { quad(B(s, th.wallHi), corners(y0, y1), n); return; }
    if (y0 < WAINSCOT && y1 > WAINSCOT) {
      quad(B(s, th.wallLo), corners(y0, WAINSCOT), n);
      quad(B(s, th.wallHi), corners(WAINSCOT, y1), n);
    } else quad(B(s, y1 <= WAINSCOT ? th.wallLo : th.wallHi), corners(y0, y1), n);
  };

  // ---- floors + ceilings (greedy rectangles over owned cells; outdoor floors also fill under the van) ----
  for (const s of spaces) {
    if (isVanSpace(s.id)) continue;
    const r = s.rect;
    const inSet = (x: number, y: number) => owner[y * W + x] === s.id || (s.open && vanMask[y * W + x] === 1);
    const rects = greedyRects(r.x, r.y, r.w, r.h, inSet);
    const th = theme[s.id];
    for (const q of rects) {
      const x0 = q.x, x1 = q.x + q.w, z0 = q.y, z1 = q.y + q.h;
      quad(B(s.id, th.floor), [[x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]], [0, 1, 0]);
      if (!s.open) quad(B(s.id, th.ceil), [[x0, WH, z0], [x1, WH, z0], [x1, WH, z1], [x0, WH, z1]], [0, -1, 0]);
    }
  }

  // ---- wall runs ----
  let runs = 0;
  for (let x = 0; x <= W; x++) for (let y = 0; y < H;) {
    if (kindV(x, y) !== EK.wall) { y++; continue; }
    const a = own(x - 1, y), b = own(x, y);
    let e = y;
    while (e < H && kindV(x, e) === EK.wall && own(x - 1, e) === a && own(x, e) === b) e++;
    const z0 = y + h2, z1 = e - h2;
    if (faceable(a)) wallFace(a, (p, q) => [[x - h2, p, z0], [x - h2, p, z1], [x - h2, q, z1], [x - h2, q, z0]], [-1, 0, 0]);
    if (faceable(b)) wallFace(b, (p, q) => [[x + h2, p, z0], [x + h2, p, z1], [x + h2, q, z1], [x + h2, q, z0]], [1, 0, 0]);
    runs++;
    y = e;
  }
  for (let y = 0; y <= H; y++) for (let x = 0; x < W;) {
    if (kindH(x, y) !== EK.wall) { x++; continue; }
    const a = own(x, y - 1), b = own(x, y);
    let e = x;
    while (e < W && kindH(e, y) === EK.wall && own(e, y - 1) === a && own(e, y) === b) e++;
    const x0 = x + h2, x1 = e - h2;
    if (faceable(a)) wallFace(a, (p, q) => [[x0, p, y - h2], [x1, p, y - h2], [x1, q, y - h2], [x0, q, y - h2]], [0, 0, -1]);
    if (faceable(b)) wallFace(b, (p, q) => [[x0, p, y + h2], [x1, p, y + h2], [x1, q, y + h2], [x0, q, y + h2]], [0, 0, 1]);
    runs++;
    x = e;
  }

  // ---- lintels + soffits over door openings (trimmed by T/2 like wall runs) ----
  let lintels = 0;
  for (const d of L.doors) {
    if (d.kind === 'open') continue;
    if (d.dir === 'v') {
      const x = d.x, z0 = d.y + h2, z1 = d.y + d.len - h2;
      const a = own(x - 1, d.y), b = own(x, d.y);
      if (masked(x - 1, d.y) || masked(x, d.y)) continue;
      if (faceable(a)) wallFace(a, (p, q) => [[x - h2, p, z0], [x - h2, p, z1], [x - h2, q, z1], [x - h2, q, z0]], [-1, 0, 0], DOOR_H, sideH(a));
      if (faceable(b)) wallFace(b, (p, q) => [[x + h2, p, z0], [x + h2, p, z1], [x + h2, q, z1], [x + h2, q, z0]], [1, 0, 0], DOOR_H, sideH(b));
      const so = faceable(a) && !isOpen(a) ? a : b;
      if (faceable(so)) quad(B(so, theme[so].wallHi), [[x - h2, DOOR_H, z0], [x + h2, DOOR_H, z0], [x + h2, DOOR_H, z1], [x - h2, DOOR_H, z1]], [0, -1, 0]);
    } else {
      const y = d.y, x0 = d.x + h2, x1 = d.x + d.len - h2;
      const a = own(d.x, y - 1), b = own(d.x, y);
      if (masked(d.x, y - 1) || masked(d.x, y)) continue;
      if (faceable(a)) wallFace(a, (p, q) => [[x0, p, y - h2], [x1, p, y - h2], [x1, q, y - h2], [x0, q, y - h2]], [0, 0, -1], DOOR_H, sideH(a));
      if (faceable(b)) wallFace(b, (p, q) => [[x0, p, y + h2], [x1, p, y + h2], [x1, q, y + h2], [x0, q, y + h2]], [0, 0, 1], DOOR_H, sideH(b));
      const so = faceable(a) && !isOpen(a) ? a : b;
      if (faceable(so)) quad(B(so, theme[so].wallHi), [[x0, DOOR_H, y - h2], [x1, DOOR_H, y - h2], [x1, DOOR_H, y + h2], [x0, DOOR_H, y + h2]], [0, -1, 0]);
    }
    lintels++;
  }

  // ---- posts at vertices (only exposed faces) ----
  let posts = 0;
  const pick = (c1: number, c2: number): number => {
    // prefer an outdoor space (facade jambs must stay visible from the lot), then any faceable space
    const ok = (s: number) => faceable(s);
    if (ok(c1) && isOpen(c1)) return c1;
    if (ok(c2) && isOpen(c2)) return c2;
    if (ok(c1)) return c1;
    if (ok(c2)) return c2;
    return -1;
  };
  for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) {
    const wUp = kindV(x, y - 1) === EK.wall, wDn = kindV(x, y) === EK.wall;
    const wLf = kindH(x - 1, y) === EK.wall, wRt = kindH(x, y) === EK.wall;
    if (!(wUp || wDn || wLf || wRt)) continue;
    posts++;
    const X0 = x - h2, X1 = x + h2, Z0 = y - h2, Z1 = y + h2;
    if (!wRt) { const s = pick(own(x, y), own(x, y - 1)); if (s >= 0) wallFace(s, (p, q) => [[X1, p, Z0], [X1, p, Z1], [X1, q, Z1], [X1, q, Z0]], [1, 0, 0]); }
    if (!wLf) { const s = pick(own(x - 1, y), own(x - 1, y - 1)); if (s >= 0) wallFace(s, (p, q) => [[X0, p, Z0], [X0, p, Z1], [X0, q, Z1], [X0, q, Z0]], [-1, 0, 0]); }
    if (!wDn) { const s = pick(own(x, y), own(x - 1, y)); if (s >= 0) wallFace(s, (p, q) => [[X0, p, Z1], [X1, p, Z1], [X1, q, Z1], [X0, q, Z1]], [0, 0, 1]); }
    if (!wUp) { const s = pick(own(x, y - 1), own(x - 1, y - 1)); if (s >= 0) wallFace(s, (p, q) => [[X0, p, Z0], [X1, p, Z0], [X1, q, Z0], [X0, q, Z0]], [0, 0, -1]); }
  }

  // ---- fences (rendered by the exterior builder) ----
  const fences: FenceRun[] = [];
  for (let x = 0; x <= W; x++) for (let y = 0; y < H;) {
    if (kindV(x, y) !== EK.fence) { y++; continue; }
    let e = y; while (e < H && kindV(x, e) === EK.fence) e++;
    fences.push({ x0: x, z0: y, x1: x, z1: e });
    y = e;
  }
  for (let y = 0; y <= H; y++) for (let x = 0; x < W;) {
    if (kindH(x, y) !== EK.fence) { x++; continue; }
    let e = x; while (e < W && kindH(e, y) === EK.fence) e++;
    fences.push({ x0: x, z0: y, x1: e, z1: y });
    x = e;
  }

  // ---- merge per space ----
  const per = new Map<number, { geos: THREE.BufferGeometry[]; mats: MatId[] }>();
  for (const [k, b] of buckets) {
    const [sid, mat] = k.split('|');
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setIndex(b.idx);
    const e = per.get(+sid) ?? { geos: [], mats: [] };
    e.geos.push(g);
    e.mats.push(mat as MatId);
    per.set(+sid, e);
  }
  const out = new Map<number, { geometry: THREE.BufferGeometry; mats: MatId[] }>();
  for (const [sid, e] of per) {
    const geometry = e.geos.length === 1 ? e.geos[0] : mergeGeometries(e.geos, true);
    if (e.geos.length === 1) geometry.addGroup(0, geometry.index!.count, 0);
    else for (const g of e.geos) g.dispose();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    out.set(sid, { geometry, mats: e.mats });
  }
  return { spaces: out, fences, vanMask, stats: { tris, buckets: buckets.size, runs, posts, lintels } };
}

/** Greedy rectangle cover of the cells where inSet(x, y) inside a bounding rect (row runs merged downward). */
export function greedyRects(rx: number, ry: number, rw: number, rh: number, inSet: (x: number, y: number) => boolean): { x: number; y: number; w: number; h: number }[] {
  const used = new Uint8Array(rw * rh);
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
    if (used[j * rw + i] || !inSet(rx + i, ry + j)) continue;
    let w = 1;
    while (i + w < rw && !used[j * rw + i + w] && inSet(rx + i + w, ry + j)) w++;
    let h = 1;
    outer: while (j + h < rh) {
      for (let k = 0; k < w; k++) if (used[(j + h) * rw + i + k] || !inSet(rx + i + k, ry + j + h)) break outer;
      h++;
    }
    for (let jj = 0; jj < h; jj++) for (let k = 0; k < w; k++) used[(j + jj) * rw + i + k] = 1;
    out.push({ x: rx + i, y: ry + j, w, h });
  }
  return out;
}
