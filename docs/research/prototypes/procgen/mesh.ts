import { generate, type Level } from './gen.ts';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Per-space geometry buckets with world-space UVs (metres / tile size).
// Walls = edge runs trimmed by T/2 at both ends + posts at lattice vertices (faces only where no wall continues).
type Bucket = { pos: number[]; nor: number[]; uv: number[]; idx: number[] };
export function buildLevelMeshes(L: Level, opt = { H: 3, T: 0.16, DOOR_H: 2.1, TILE: 2 }) {
  const { W, H: HH } = L; const { H, T, DOOR_H, TILE } = opt; const h2 = T / 2;
  const buckets = new Map<string, Bucket>(); // key `${spaceId}:${material}`
  const B = (space: number, mat: string) => { const k = space + ':' + mat; let b = buckets.get(k); if (!b) { b = { pos: [], nor: [], uv: [], idx: [] }; buckets.set(k, b); } return b; };
  const quad = (b: Bucket, p: number[][], n: number[]) => {
    const base = b.pos.length / 3;
    for (const v of p) {
      b.pos.push(v[0], v[1], v[2]); b.nor.push(n[0], n[1], n[2]);
      const u = Math.abs(n[0]) > 0.5 ? v[2] : v[0]; const w = Math.abs(n[1]) > 0.5 ? v[2] : v[1];
      b.uv.push(u / TILE, w / TILE); // world-space UVs: textures tile continuously across runs, posts and rooms
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= HH ? -1 : L.owner[y * W + x]);
  const kindV = new Map<number, string>(), kindH = new Map<number, string>();
  for (const d of L.doors) for (let i = 0; i < d.len; i++) {
    if (d.dir === 'v') kindV.set((d.y + i) * (W + 1) + d.x, d.kind); else kindH.set(d.y * (W + 1) + d.x + i, d.kind);
  }
  // a "solid wall edge": owners differ and the edge is not an opening/door ('blocked' renders as wall + rubble prop)
  const wallV = (x: number, y: number) => { if (y < 0 || y >= HH || own(x - 1, y) === own(x, y)) return false; const k = kindV.get(y * (W + 1) + x); return k === undefined || k === 'blocked'; };
  const wallH = (x: number, y: number) => { if (x < 0 || x >= W || own(x, y - 1) === own(x, y)) return false; const k = kindH.get(y * (W + 1) + x); return k === undefined || k === 'blocked'; };
  for (const s of L.spaces) {
    const { x, y, w, h } = s.rect; const m = s.kind === 'corridor' ? 'floorCorr' : 'floorRoom';
    quad(B(s.id, m), [[x, 0, y + h], [x + w, 0, y + h], [x + w, 0, y], [x, 0, y]], [0, 1, 0]);
    quad(B(s.id, 'ceiling'), [[x, H, y], [x + w, H, y], [x + w, H, y + h], [x, H, y + h]], [0, -1, 0]);
  }
  let runs = 0, posts = 0, lintels = 0;
  for (let x = 0; x <= W; x++) for (let y = 0; y < HH; ) {
    if (!wallV(x, y)) { y++; continue; }
    const a = own(x - 1, y), b = own(x, y); let e = y; while (e < HH && wallV(x, e) && own(x - 1, e) === a && own(x, e) === b) e++;
    const z0 = y + h2, z1 = e - h2;
    if (a >= 0) quad(B(a, 'wall'), [[x - h2, 0, z1], [x - h2, 0, z0], [x - h2, H, z0], [x - h2, H, z1]], [-1, 0, 0]);
    if (b >= 0) quad(B(b, 'wall'), [[x + h2, 0, z0], [x + h2, 0, z1], [x + h2, H, z1], [x + h2, H, z0]], [1, 0, 0]);
    runs++; y = e;
  }
  for (let y = 0; y <= HH; y++) for (let x = 0; x < W; ) {
    if (!wallH(x, y)) { x++; continue; }
    const a = own(x, y - 1), b = own(x, y); let e = x; while (e < W && wallH(e, y) && own(e, y - 1) === a && own(e, y) === b) e++;
    const x0 = x + h2, x1 = e - h2;
    if (a >= 0) quad(B(a, 'wall'), [[x0, 0, y - h2], [x1, 0, y - h2], [x1, H, y - h2], [x0, H, y - h2]], [0, 0, -1]);
    if (b >= 0) quad(B(b, 'wall'), [[x1, 0, y + h2], [x0, 0, y + h2], [x0, H, y + h2], [x1, H, y + h2]], [0, 0, 1]);
    runs++; x = e;
  }
  for (const d of L.doors) {
    if (d.kind === 'open' || d.kind === 'blocked') continue;
    const sa = d.a, sb = d.b; lintels++;
    if (d.dir === 'v') {
      const x = d.x, z0 = d.y, z1 = d.y + d.len;
      if (sa >= 0) quad(B(sa, 'wall'), [[x - h2, DOOR_H, z1], [x - h2, DOOR_H, z0], [x - h2, H, z0], [x - h2, H, z1]], [-1, 0, 0]);
      quad(B(sb, 'wall'), [[x + h2, DOOR_H, z0], [x + h2, DOOR_H, z1], [x + h2, H, z1], [x + h2, H, z0]], [1, 0, 0]);
      quad(B(sb, 'trim'), [[x - h2, DOOR_H, z0], [x + h2, DOOR_H, z0], [x + h2, DOOR_H, z1], [x - h2, DOOR_H, z1]], [0, -1, 0]);
    } else {
      const y = d.y, x0 = d.x, x1 = d.x + d.len;
      if (sa >= 0) quad(B(sa, 'wall'), [[x0, DOOR_H, y - h2], [x1, DOOR_H, y - h2], [x1, H, y - h2], [x0, H, y - h2]], [0, 0, -1]);
      quad(B(sb, 'wall'), [[x1, DOOR_H, y + h2], [x0, DOOR_H, y + h2], [x0, H, y + h2], [x1, H, y + h2]], [0, 0, 1]);
      quad(B(sb, 'trim'), [[x0, DOOR_H, y + h2], [x1, DOOR_H, y + h2], [x1, DOOR_H, y - h2], [x0, DOOR_H, y - h2]], [0, -1, 0]);
    }
  }
  for (let y = 0; y <= HH; y++) for (let x = 0; x <= W; x++) {
    const wUp = wallV(x, y - 1), wDn = wallV(x, y), wLf = wallH(x - 1, y), wRt = wallH(x, y);
    if (!(wUp || wDn || wLf || wRt)) continue; posts++;
    let tgt = own(Math.min(x, W - 1), Math.min(y, HH - 1)); if (tgt < 0) tgt = own(Math.max(x - 1, 0), Math.max(y - 1, 0));
    if (tgt < 0) continue;
    const X0 = x - h2, X1 = x + h2, Z0 = y - h2, Z1 = y + h2;
    if (!wRt) quad(B(tgt, 'wall'), [[X1, 0, Z1], [X1, 0, Z0], [X1, H, Z0], [X1, H, Z1]], [1, 0, 0]);
    if (!wLf) quad(B(tgt, 'wall'), [[X0, 0, Z0], [X0, 0, Z1], [X0, H, Z1], [X0, H, Z0]], [-1, 0, 0]);
    if (!wDn) quad(B(tgt, 'wall'), [[X0, 0, Z1], [X1, 0, Z1], [X1, H, Z1], [X0, H, Z1]], [0, 0, 1]);
    if (!wUp) quad(B(tgt, 'wall'), [[X1, 0, Z0], [X0, 0, Z0], [X0, H, Z0], [X1, H, Z0]], [0, 0, -1]);
  }
  const perSpace = new Map<number, { geos: THREE.BufferGeometry[]; mats: string[] }>();
  let tris = 0;
  for (const [k, b] of buckets) {
    const [sid, mat] = k.split(':'); const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setIndex(b.idx); tris += b.idx.length / 3;
    const e = perSpace.get(+sid) ?? { geos: [], mats: [] }; e.geos.push(g); e.mats.push(mat); perSpace.set(+sid, e);
  }
  const merged = new Map<number, { geometry: THREE.BufferGeometry; mats: string[] }>();
  for (const [sid, e] of perSpace) merged.set(sid, { geometry: mergeGeometries(e.geos, true), mats: e.mats });
  return { merged, stats: { buckets: buckets.size, spacesWithMeshes: merged.size, tris, runs, posts, lintels } };
}

const L = generate({ seed: 'demo', W: 64, H: 48, difficulty: 0.5, locks: 2 });
const t0 = performance.now(); const r = buildLevelMeshes(L); const t1 = performance.now();
console.log({ buildMs: +(t1 - t0).toFixed(1), ...r.stats });
const t2 = performance.now(); for (let i = 0; i < 20; i++) buildLevelMeshes(L); console.log('warm avg ms', ((performance.now() - t2) / 20).toFixed(1));
