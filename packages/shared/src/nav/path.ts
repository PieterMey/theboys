// Owned by track ② Level. Octile path metric over the edge grid: Dijkstra floods (sound / path distance) and A*.
// Diagonal steps cost SQRT2 and are allowed only when both L-shaped orthogonal routes are free edges
// (no wall, door, rubble or fence on any of the 4 edges), so doors are always crossed orthogonally with their cost.
import { PATH } from '../constants.ts';
import { EDGE } from './grid.ts';
import type { DoorOpenFn, EdgeGrid } from './grid.ts';
import { MinHeap } from './heap.ts';

/**
 * 'sound': walls block; fences and open doorways are free; doors cost +doorOpenCost when open, +doorClosedCost
 *          when closed; rubble leaks like a closed door. Used for voice audibility and monster hearing.
 * 'walk':  walls, rubble and fences block; open doors cost +doorOpenCost; closed doors pass only if canOpen(id)
 *          (cost +doorClosedCost). Used for agents.
 */
export type NavMode = 'walk' | 'sound';

export interface FloodOptions {
  mode?: NavMode;
  doorOpen: DoorOpenFn;
  /** walk mode only: closed doors this agent can open itself */
  canOpen?: DoorOpenFn;
  /** do not expand beyond this distance (m). Cells farther away stay Infinity. */
  budget?: number;
  /** octile 8-neighbour steps (default true) */
  diag?: boolean;
}

const SQRT2 = PATH.diag;
const OPEN_COST = PATH.doorOpenCost;
const CLOSED_COST = PATH.doorClosedCost;
const heap = new MinHeap(4096);

/** extra cost of crossing an edge, or -1 if impassable */
function crossCost(code: number, door: number, sound: boolean, doorOpen: DoorOpenFn, canOpen: DoorOpenFn | undefined): number {
  if (code === EDGE.free) return 0;
  if (code === EDGE.door) {
    if (doorOpen(door)) return OPEN_COST;
    if (sound) return CLOSED_COST;
    return canOpen !== undefined && canOpen(door) ? CLOSED_COST : -1;
  }
  if (sound) {
    if (code === EDGE.fence) return 0;
    if (code === EDGE.blocked) return CLOSED_COST;
  }
  return -1;
}

/**
 * Dijkstra distance field (metres) from one or more source cells. Returns a Float32Array(W*H); unreachable = Infinity.
 * `sources` are cell indices; optional `srcCost` gives each source a starting distance.
 */
export function floodCells(g: EdgeGrid, sources: ArrayLike<number>, opt: FloodOptions, out?: Float32Array, srcCost?: ArrayLike<number>): Float32Array {
  const W = g.W, H = g.H, N = W * H;
  const d = out && out.length === N ? out : new Float32Array(N);
  d.fill(Infinity);
  const sound = (opt.mode ?? 'sound') === 'sound';
  const budget = opt.budget ?? Infinity;
  const diag = opt.diag !== false;
  const { doorOpen, canOpen } = opt;
  const v = g.v, h = g.h, vD = g.vDoor, hD = g.hDoor, W1 = W + 1;
  heap.clear();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s < 0 || s >= N) continue;
    const c0 = srcCost ? srcCost[i] : 0;
    if (c0 < d[s]) { d[s] = c0; heap.push(s, d[s]); }
  }
  while (heap.length > 0) {
    const u = heap.pop();
    const du = heap.lastKey;
    if (du > d[u]) continue;
    const x = u % W, y = (u - x) / W;
    // +x
    if (x + 1 < W) {
      const e = y * W1 + x + 1; const c = crossCost(v[e], vD[e], sound, doorOpen, canOpen);
      if (c >= 0) { const nd = du + 1 + c; const n = u + 1; if (nd < d[n] && nd <= budget) { d[n] = nd; heap.push(n, d[n]); } }
    }
    // -x
    if (x > 0) {
      const e = y * W1 + x; const c = crossCost(v[e], vD[e], sound, doorOpen, canOpen);
      if (c >= 0) { const nd = du + 1 + c; const n = u - 1; if (nd < d[n] && nd <= budget) { d[n] = nd; heap.push(n, d[n]); } }
    }
    // +y
    if (y + 1 < H) {
      const e = (y + 1) * W + x; const c = crossCost(h[e], hD[e], sound, doorOpen, canOpen);
      if (c >= 0) { const nd = du + 1 + c; const n = u + W; if (nd < d[n] && nd <= budget) { d[n] = nd; heap.push(n, d[n]); } }
    }
    // -y
    if (y > 0) {
      const e = y * W + x; const c = crossCost(h[e], hD[e], sound, doorOpen, canOpen);
      if (c >= 0) { const nd = du + 1 + c; const n = u - W; if (nd < d[n] && nd <= budget) { d[n] = nd; heap.push(n, d[n]); } }
    }
    if (!diag) continue;
    const nd = du + SQRT2;
    if (nd > budget) continue;
    // diagonals: all four edges of the 2x2 block must be free
    const r = x + 1 < W, l = x > 0, dn = y + 1 < H, up = y > 0;
    if (r && dn) {
      const n = u + W + 1;
      if (nd < d[n] && v[y * W1 + x + 1] === 0 && v[(y + 1) * W1 + x + 1] === 0 && h[(y + 1) * W + x] === 0 && h[(y + 1) * W + x + 1] === 0) { d[n] = nd; heap.push(n, d[n]); }
    }
    if (l && dn) {
      const n = u + W - 1;
      if (nd < d[n] && v[y * W1 + x] === 0 && v[(y + 1) * W1 + x] === 0 && h[(y + 1) * W + x] === 0 && h[(y + 1) * W + x - 1] === 0) { d[n] = nd; heap.push(n, d[n]); }
    }
    if (r && up) {
      const n = u - W + 1;
      if (nd < d[n] && v[y * W1 + x + 1] === 0 && v[(y - 1) * W1 + x + 1] === 0 && h[y * W + x] === 0 && h[y * W + x + 1] === 0) { d[n] = nd; heap.push(n, d[n]); }
    }
    if (l && up) {
      const n = u - W - 1;
      if (nd < d[n] && v[y * W1 + x] === 0 && v[(y - 1) * W1 + x] === 0 && h[y * W + x] === 0 && h[y * W + x - 1] === 0) { d[n] = nd; heap.push(n, d[n]); }
    }
  }
  return d;
}

function cellIndex(g: EdgeGrid, x: number, z: number): number {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return -1;
  return cz * g.W + cx;
}

/** Path distance field (m) from world position (x, z). Default mode 'sound'. */
export function pathDistanceField(g: EdgeGrid, x: number, z: number, opt: FloodOptions, out?: Float32Array): Float32Array {
  return floodCells(g, [cellIndex(g, x, z)], opt, out);
}

/** Sound flood with a budget = loudness radius (m): cells beyond the budget stay Infinity. */
export function soundFlood(g: EdgeGrid, x: number, z: number, budget: number, doorOpen: DoorOpenFn, out?: Float32Array): Float32Array {
  return floodCells(g, [cellIndex(g, x, z)], { mode: 'sound', doorOpen, budget }, out);
}

/** Read a field at a world position (Infinity outside the grid). */
export function fieldAt(g: Pick<EdgeGrid, 'W' | 'H'>, field: ArrayLike<number>, x: number, z: number): number {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return Infinity;
  return field[cz * g.W + cx];
}

export interface AStarOptions extends FloodOptions {
  /** give up beyond this cost */
  maxCost?: number;
}

export interface AStarResult {
  /** cell indices from start to goal (inclusive) */
  cells: number[];
  /** path cost in metres (octile + door costs) */
  cost: number;
}

let gScore = new Float64Array(0);
let came = new Int32Array(0);
let stamp = new Uint32Array(0);
let stampGen = 0;

/** A* between two world positions. Default mode 'walk'. Returns null when unreachable. */
export function astar(g: EdgeGrid, sx: number, sz: number, tx: number, tz: number, opt: AStarOptions): AStarResult | null {
  const W = g.W, H = g.H, N = W * H;
  const s = cellIndex(g, sx, sz), t = cellIndex(g, tx, tz);
  if (s < 0 || t < 0) return null;
  if (gScore.length < N) { gScore = new Float64Array(N); came = new Int32Array(N); stamp = new Uint32Array(N); stampGen = 0; }
  stampGen = (stampGen + 1) >>> 0;
  if (stampGen === 0) { stamp.fill(0); stampGen = 1; }
  const gen = stampGen;
  const sound = (opt.mode ?? 'walk') === 'sound';
  const diag = opt.diag !== false;
  const maxCost = opt.maxCost ?? opt.budget ?? Infinity;
  const { doorOpen, canOpen } = opt;
  const v = g.v, h = g.h, vD = g.vDoor, hD = g.hDoor, W1 = W + 1;
  const txc = t % W, tyc = (t - txc) / W;
  const heur = (n: number) => {
    const nx = n % W, ny = (n - nx) / W;
    const dx = Math.abs(nx - txc), dy = Math.abs(ny - tyc);
    return diag ? Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
  };
  const gs = (n: number) => (stamp[n] === gen ? gScore[n] : Infinity);
  const relax = (u: number, n: number, nd: number) => {
    if (nd > maxCost) return;
    if (nd < gs(n)) { stamp[n] = gen; gScore[n] = nd; came[n] = u; heap.push(n, nd + heur(n)); }
  };
  heap.clear();
  stamp[s] = gen; gScore[s] = 0; came[s] = -1;
  heap.push(s, heur(s));
  let found = false;
  while (heap.length > 0) {
    const u = heap.pop();
    const fu = heap.lastKey;
    const du = gScore[u];
    if (fu - heur(u) > du + 1e-9) continue; // stale
    if (u === t) { found = true; break; }
    const x = u % W, y = (u - x) / W;
    if (x + 1 < W) { const e = y * W1 + x + 1; const c = crossCost(v[e], vD[e], sound, doorOpen, canOpen); if (c >= 0) relax(u, u + 1, du + 1 + c); }
    if (x > 0) { const e = y * W1 + x; const c = crossCost(v[e], vD[e], sound, doorOpen, canOpen); if (c >= 0) relax(u, u - 1, du + 1 + c); }
    if (y + 1 < H) { const e = (y + 1) * W + x; const c = crossCost(h[e], hD[e], sound, doorOpen, canOpen); if (c >= 0) relax(u, u + W, du + 1 + c); }
    if (y > 0) { const e = y * W + x; const c = crossCost(h[e], hD[e], sound, doorOpen, canOpen); if (c >= 0) relax(u, u - W, du + 1 + c); }
    if (!diag) continue;
    const nd = du + SQRT2;
    const r = x + 1 < W, l = x > 0, dn = y + 1 < H, up = y > 0;
    if (r && dn && v[y * W1 + x + 1] === 0 && v[(y + 1) * W1 + x + 1] === 0 && h[(y + 1) * W + x] === 0 && h[(y + 1) * W + x + 1] === 0) relax(u, u + W + 1, nd);
    if (l && dn && v[y * W1 + x] === 0 && v[(y + 1) * W1 + x] === 0 && h[(y + 1) * W + x] === 0 && h[(y + 1) * W + x - 1] === 0) relax(u, u + W - 1, nd);
    if (r && up && v[y * W1 + x + 1] === 0 && v[(y - 1) * W1 + x + 1] === 0 && h[y * W + x] === 0 && h[y * W + x + 1] === 0) relax(u, u - W + 1, nd);
    if (l && up && v[y * W1 + x] === 0 && v[(y - 1) * W1 + x] === 0 && h[y * W + x] === 0 && h[y * W + x - 1] === 0) relax(u, u - W - 1, nd);
  }
  if (!found) return null;
  const cells: number[] = [];
  for (let c = t; c >= 0; c = came[c]) { cells.push(c); if (c === s) break; }
  cells.reverse();
  return { cells, cost: gScore[t] };
}

/** Point-to-point path distance in metres (default 'sound' metric, as used for voice + hearing). Infinity if unreachable. */
export function pathDistance(g: EdgeGrid, ax: number, az: number, bx: number, bz: number, opt: AStarOptions): number {
  const r = astar(g, ax, az, bx, bz, { mode: 'sound', ...opt });
  return r ? r.cost : Infinity;
}

/** Cell centres of an A* path as world [x, z] pairs. */
export function pathPoints(g: Pick<EdgeGrid, 'W'>, cells: readonly number[]): [number, number][] {
  return cells.map((c) => { const x = c % g.W; return [x + 0.5, (c - x) / g.W + 0.5]; });
}
