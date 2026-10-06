import { generate, type Level } from './gen.ts';
import { DEFAULT_QUERY_FILTER, findPath, type Vec3 } from 'navcat';
import { generateSoloNavMesh, type SoloNavMeshOptions } from 'navcat/blocks';

// Build nav input geometry: floor quad per space + wall boxes along wall-edge runs (doors 'open'/'door' leave gaps)
export function buildNavGeometry(L: Level, H = 3, T = 0.2) {
  const pos: number[] = []; const idx: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number, y: number) => {
    const b = pos.length / 3; pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1); idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  };
  const box = (x0: number, z0: number, x1: number, z1: number) => {
    const b = pos.length / 3;
    for (const y of [0, H]) pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
    const f = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]];
    for (const t of f) idx.push(b + t[0], b + t[1], b + t[2]);
  };
  for (const s of L.spaces) quad(s.rect.x, s.rect.y, s.rect.x + s.rect.w, s.rect.y + s.rect.h, 0);
  const W = L.W, Hh = L.H;
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= Hh ? -1 : L.owner[y * W + x]);
  const openV = new Set<number>(), openH = new Set<number>();
  for (const d of L.doors) if (d.kind === 'open' || d.kind === 'door') for (let i = 0; i < d.len; i++) (d.dir === 'v' ? openV : openH).add(d.dir === 'v' ? (d.y + i) * (W + 1) + d.x : d.y * (W + 1) + d.x + i);
  let boxes = 0;
  for (let x = 0; x <= W; x++) { let start = -1; for (let y = 0; y <= Hh; y++) {
    const wall = y < Hh && own(x - 1, y) !== own(x, y) && !openV.has(y * (W + 1) + x);
    if (wall && start < 0) start = y; if (!wall && start >= 0) { box(x - T / 2, start, x + T / 2, y); boxes++; start = -1; } } }
  for (let y = 0; y <= Hh; y++) { let start = -1; for (let x = 0; x <= W; x++) {
    const wall = x < W && own(x, y - 1) !== own(x, y) && !openH.has(y * (W + 1) + x);
    if (wall && start < 0) start = x; if (!wall && start >= 0) { box(start, y - T / 2, x, y + T / 2); boxes++; start = -1; } } }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), boxes };
}

const L = generate({ seed: 'demo', W: 64, H: 48, difficulty: 0.5, locks: 2 });
const g = buildNavGeometry(L);
console.log('tris', g.indices.length / 3, 'wallBoxes', g.boxes);
for (const cellSize of [0.15, 0.2, 0.25]) {
  const cellHeight = 0.2, r = 0.3, h = 1.8, climb = 0.4;
  const o: SoloNavMeshOptions = {
    cellSize, cellHeight, walkableRadiusWorld: r, walkableRadiusVoxels: Math.ceil(r / cellSize), walkableClimbWorld: climb,
    walkableClimbVoxels: Math.ceil(climb / cellHeight), walkableHeightWorld: h, walkableHeightVoxels: Math.ceil(h / cellHeight),
    walkableSlopeAngleDegrees: 45, borderSize: 0, minRegionArea: 8, mergeRegionArea: 20, maxSimplificationError: 1.3,
    maxEdgeLength: 12, maxVerticesPerPoly: 5, detailSampleDistance: cellSize * 6, detailSampleMaxError: cellHeight * 1,
  };
  const t0 = performance.now();
  const res = generateSoloNavMesh({ positions: g.positions, indices: g.indices }, o);
  const t1 = performance.now();
  const ent = L.spaces[L.entrance].rect;
  const far = [...L.spaces].filter(s => Number.isFinite(s.dist)).sort((a, b) => b.dist - a.dist)[0].rect;
  const start: Vec3 = [ent.x + ent.w / 2, 0, ent.y + ent.h / 2], end: Vec3 = [far.x + far.w / 2, 0, far.y + far.h / 2];
  let path = findPath(res.navMesh, start, end, [1, 1, 1], DEFAULT_QUERY_FILTER);
  const t2 = performance.now();
  for (let i = 0; i < 200; i++) path = findPath(res.navMesh, start, end, [1, 1, 1], DEFAULT_QUERY_FILTER);
  const t3 = performance.now();
  const pts = path.path.map(p => p.position);
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
  console.log({ cellSize, genMs: +(t1 - t0).toFixed(0), firstPathMs: +(t2 - t1).toFixed(2), avgPathMs: +((t3 - t2) / 200).toFixed(3), success: path.success, waypoints: pts.length, pathLenM: +len.toFixed(1), last: pts[pts.length - 1]?.map(v => +v.toFixed(1)), target: end });
}
