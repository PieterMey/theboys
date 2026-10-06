import { generate, type Level } from './gen.ts';
import FlatQueue from 'flatqueue';

// Edge-wall grid: wallV[y*(W+1)+x] blocks movement between (x-1,y) and (x,y); wallH[y*W+x] between (x,y-1) and (x,y)
// Values: 0 = free, 1 = wall, 2 = door (state looked up per door id), 3 = blocked
export function buildEdgeGrid(L: Level) {
  const { W, H } = L;
  const wallV = new Uint8Array((W + 1) * H), wallH = new Uint8Array(W * (H + 1));
  const doorV = new Int32Array((W + 1) * H).fill(-1), doorH = new Int32Array(W * (H + 1)).fill(-1);
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : L.owner[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x <= W; x++) if (own(x - 1, y) !== own(x, y)) wallV[y * (W + 1) + x] = 1;
  for (let y = 0; y <= H; y++) for (let x = 0; x < W; x++) if (own(x, y - 1) !== own(x, y)) wallH[y * W + x] = 1;
  for (const d of L.doors) for (let i = 0; i < d.len; i++) {
    const v = d.kind === 'open' ? 0 : d.kind === 'blocked' ? 3 : 2;
    if (d.dir === 'v') { wallV[(d.y + i) * (W + 1) + d.x] = v; doorV[(d.y + i) * (W + 1) + d.x] = d.id; }
    else { wallH[d.y * W + d.x + i] = v; doorH[d.y * W + d.x + i] = d.id; }
  }
  return { W, H, wallV, wallH, doorV, doorH };
}
type EG = ReturnType<typeof buildEdgeGrid>;
// door state provider: true if passable for this agent
export function canCross(g: EG, x: number, y: number, dx: number, dy: number, doorOpen: (id: number) => boolean): boolean {
  let v: number, id: number;
  if (dx === 1) { v = g.wallV[y * (g.W + 1) + x + 1]; id = g.doorV[y * (g.W + 1) + x + 1]; }
  else if (dx === -1) { v = g.wallV[y * (g.W + 1) + x]; id = g.doorV[y * (g.W + 1) + x]; }
  else if (dy === 1) { v = g.wallH[(y + 1) * g.W + x]; id = g.doorH[(y + 1) * g.W + x]; }
  else { v = g.wallH[y * g.W + x]; id = g.doorH[y * g.W + x]; }
  return v === 0 || (v === 2 && doorOpen(id));
}
const q = new FlatQueue<number>();
export function astar(g: EG, sx: number, sy: number, tx: number, ty: number, doorOpen: (id: number) => boolean, doorCost = 2): number[] | null {
  const N = g.W * g.H; const gs = new Float32Array(N).fill(Infinity); const came = new Int32Array(N).fill(-1);
  const s = sy * g.W + sx, t = ty * g.W + tx; gs[s] = 0; q.clear(); q.push(s, 0);
  const D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (q.length) {
    const u = q.pop()!; if (u === t) break;
    const ux = u % g.W, uy = (u - ux) / g.W;
    for (const [dx, dy] of D) {
      const nx = ux + dx, ny = uy + dy; if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
      if (!canCross(g, ux, uy, dx, dy, doorOpen)) continue;
      const v = ny * g.W + nx; const isDoor = (dx ? g.doorV[uy * (g.W + 1) + ux + (dx > 0 ? 1 : 0)] : g.doorH[(uy + (dy > 0 ? 1 : 0)) * g.W + ux]) >= 0;
      const c = gs[u] + 1 + (isDoor ? doorCost : 0);
      if (c < gs[v]) { gs[v] = c; came[v] = u; q.push(v, c + Math.abs(nx - tx) + Math.abs(ny - ty)); }
    }
  }
  if (!Number.isFinite(gs[t])) return null;
  const path: number[] = []; for (let c = t; c >= 0; c = came[c]) path.push(c); return path.reverse();
}
// LOS: Amanatides-Woo traversal over cells, checking the edge crossed at each step (corner crossings check both)
export function los(g: EG, ax: number, ay: number, bx: number, by: number, doorOpen: (id: number) => boolean): boolean {
  let x = Math.floor(ax), y = Math.floor(ay); const tx = Math.floor(bx), ty = Math.floor(by);
  const dx = bx - ax, dy = by - ay; const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tDy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMx = dx !== 0 ? (stepX > 0 ? x + 1 - ax : ax - x) * tDx : Infinity, tMy = dy !== 0 ? (stepY > 0 ? y + 1 - ay : ay - y) * tDy : Infinity;
  for (let guard = 0; guard < 4096 && (x !== tx || y !== ty); guard++) {
    if (tMx < tMy) { if (!canCross(g, x, y, stepX, 0, doorOpen)) return false; x += stepX; tMx += tDx; }
    else if (tMy < tMx) { if (!canCross(g, x, y, 0, stepY, doorOpen)) return false; y += stepY; tMy += tDy; }
    else { // exact corner: require both L-shaped routes to be clear (conservative)
      if (!(canCross(g, x, y, stepX, 0, doorOpen) && canCross(g, x + stepX, y, 0, stepY, doorOpen)) || !(canCross(g, x, y, 0, stepY, doorOpen) && canCross(g, x, y + stepY, stepX, 0, doorOpen))) return false;
      x += stepX; y += stepY; tMx += tDx; tMy += tDy;
    }
  }
  return true;
}
// Sound: Dijkstra flood on cells, cost 1/cell, closed door +6, open door +1, stop at budget (loudness in metres)
export function soundFlood(g: EG, sx: number, sy: number, budget: number, doorOpen: (id: number) => boolean): Float32Array {
  const N = g.W * g.H; const d = new Float32Array(N).fill(Infinity); const s = sy * g.W + sx; d[s] = 0; q.clear(); q.push(s, 0);
  const D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (q.length) {
    const u = q.pop()!; const ux = u % g.W, uy = (u - ux) / g.W; const du = d[u];
    for (const [dx, dy] of D) {
      const nx = ux + dx, ny = uy + dy; if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
      let v: number, id: number;
      if (dx) { const e = uy * (g.W + 1) + ux + (dx > 0 ? 1 : 0); v = g.wallV[e]; id = g.doorV[e]; } else { const e = (uy + (dy > 0 ? 1 : 0)) * g.W + ux; v = g.wallH[e]; id = g.doorH[e]; }
      let c = 1; if (v === 1 || v === 3) continue; if (v === 2) c += doorOpen(id) ? 1 : 6;
      const nd = du + c; const vi = ny * g.W + nx; if (nd < d[vi] && nd <= budget) { d[vi] = nd; q.push(vi, nd); }
    }
  }
  return d;
}

const L = generate({ seed: 'demo', W: 64, H: 48, difficulty: 0.5, locks: 2 });
const g = buildEdgeGrid(L);
const open = (_id: number) => true; // all doors open/unlocked (monster with master key)
const ent = L.spaces[L.entrance].rect; const far = [...L.spaces].sort((a, b) => b.dist - a.dist)[0].rect;
let t0 = performance.now(); let p = astar(g, ent.x + 1, ent.y + 1, far.x + 1, far.y + 1, open); let t1 = performance.now();
for (let i = 0; i < 200; i++) p = astar(g, ent.x + 1, ent.y + 1, far.x + 1, far.y + 1, open);
let t2 = performance.now();
console.log('A* first ms', (t1 - t0).toFixed(2), 'avg ms', ((t2 - t1) / 200).toFixed(3), 'len cells', p?.length);
const lockedClosed = (id: number) => L.doors[id].kind !== 'locked';
console.log('A* with locked doors closed reaches far room?', astar(g, ent.x + 1, ent.y + 1, far.x + 1, far.y + 1, lockedClosed) !== null);
// LOS sampling
let hits = 0; t0 = performance.now();
for (let i = 0; i < 100000; i++) { const ax = (i * 7919) % 64 + 0.5, ay = (i * 104729) % 48 + 0.5, bx = (i * 31) % 64 + 0.5, by = (i * 17) % 48 + 0.5; if (los(g, ax, ay, bx, by, open)) hits++; }
t1 = performance.now(); console.log('LOS 100k rays ms', (t1 - t0).toFixed(1), 'clear', hits);
t0 = performance.now(); let d!: Float32Array; for (let i = 0; i < 100; i++) d = soundFlood(g, ent.x + 1, ent.y + 1, 30, (id) => L.doors[id].kind === 'open'); t1 = performance.now();
console.log('sound flood (30 m budget) avg ms', ((t1 - t0) / 100).toFixed(3), 'cells reached', d.reduce((s, v) => s + (Number.isFinite(v) ? 1 : 0), 0));
