import type { Level } from './gen.ts';
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

