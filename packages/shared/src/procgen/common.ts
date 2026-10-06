// Owned by track ② Level. Small shared helpers for the generators (pure, deterministic, integer-friendly).
import type { LayoutItem, Rect, SlotKind } from '../layout.ts';
import type { Rng } from '../rng.ts';

/** Thrown for a recoverable generation failure: the caller retries with a derived seed. */
export class GenFail extends Error {}

export const area = (r: Rect) => r.w * r.h;
export const rcx = (r: Rect) => r.x + r.w / 2;
export const rcy = (r: Rect) => r.y + r.h / 2;
/** round to millimetres (compact JSON, exact decimal arithmetic) */
export const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const r1 = (v: number) => Math.round(v * 10) / 10;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const HALF_PI = Math.PI / 2;
/** yaw for an inward wall normal: (sin yaw, cos yaw) = (nx, nz) */
export function yawOf(nx: number, nz: number): number {
  if (nx > 0.5) return HALF_PI;
  if (nx < -0.5) return -HALF_PI;
  return nz > 0 ? 0 : Math.PI;
}

export type ItemExtra = { y?: number; rot?: number; data?: Record<string, number | string | boolean> };
export type AddItem = (kind: SlotKind, space: number, x: number, z: number, extra?: ItemExtra) => LayoutItem;

/** Item list with stable per-kind ids ('loot:0', 'loot:1', ...). */
export class ItemList {
  items: LayoutItem[] = [];
  private counts = new Map<string, number>();
  add: AddItem = (kind, space, x, z, extra) => {
    const n = this.counts.get(kind) ?? 0;
    this.counts.set(kind, n + 1);
    const it: LayoutItem = { id: `${kind}:${n}`, kind, space, x: r3(x), z: r3(z) };
    if (extra?.y !== undefined) it.y = r3(extra.y);
    if (extra?.rot !== undefined) it.rot = extra.rot;
    if (extra?.data) it.data = extra.data;
    this.items.push(it);
    return it;
  };
  count(kind: SlotKind): number { return this.counts.get(kind) ?? 0; }
}

export function partition(total: number, n: number, minEach: number, rng: Rng): number[] {
  const s = new Array<number>(n).fill(minEach);
  let rest = total - n * minEach;
  while (rest > 0) { s[rng.int(0, n - 1)]++; rest--; }
  return s;
}

/** Binary space partition of r into rooms (all sides >= minSide when possible). */
export function bsp(r: Rect, rng: Rng, out: Rect[], minSide: number, maxSide: number, maxArea: number, stopChance: number): void {
  const canW = r.w >= 2 * minSide, canH = r.h >= 2 * minSide;
  const tooBig = r.w > maxSide || r.h > maxSide || area(r) > maxArea;
  if ((!canW && !canH) || (!tooBig && rng.chance(stopChance))) { out.push(r); return; }
  let splitW = r.w > r.h ? true : r.h > r.w ? false : rng.chance(0.5);
  if (splitW && !canW) splitW = false;
  if (!splitW && !canH) splitW = true;
  if (splitW) {
    const s = rng.int(minSide, r.w - minSide);
    bsp({ x: r.x, y: r.y, w: s, h: r.h }, rng, out, minSide, maxSide, maxArea, stopChance);
    bsp({ x: r.x + s, y: r.y, w: r.w - s, h: r.h }, rng, out, minSide, maxSide, maxArea, stopChance);
  } else {
    const s = rng.int(minSide, r.h - minSide);
    bsp({ x: r.x, y: r.y, w: r.w, h: s }, rng, out, minSide, maxSide, maxArea, stopChance);
    bsp({ x: r.x, y: r.y + s, w: r.w, h: r.h - s }, rng, out, minSide, maxSide, maxArea, stopChance);
  }
}

export interface GEdge { a: number; b: number; w: number }

/** O(V^2) Dijkstra over a small space graph (V <= ~150). skip = node treated as removed. */
export function graphDijkstra(n: number, adj: GEdge[][], srcs: readonly number[], skip = -1): Float64Array {
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  for (const s of srcs) if (s !== skip) dist[s] = 0;
  if (skip >= 0) done[skip] = 1;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (const e of adj[u]) {
      const v = e.a === u ? e.b : e.a;
      if (done[v]) continue;
      const nd = best + e.w;
      if (nd < dist[v]) dist[v] = nd;
    }
  }
  return dist;
}

/** BFS reachability over adjacency lists of node ids. */
export function reach(n: number, adj: number[][], src: number, skip = -1): Uint8Array {
  const seen = new Uint8Array(n);
  if (src === skip) return seen;
  const q = [src];
  seen[src] = 1;
  if (skip >= 0) seen[skip] = 2;
  for (let qi = 0; qi < q.length; qi++) {
    const u = q[qi];
    for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; q.push(v); }
  }
  if (skip >= 0) seen[skip] = 0;
  return seen;
}

/** Nearest cell owned by `id` to the centre of its rect (tie: lowest index). */
export function centreCell(owner: ArrayLike<number>, W: number, id: number, r: Rect): number {
  const cx2 = 2 * r.x + r.w, cy2 = 2 * r.y + r.h; // doubled centre (integers)
  let best = -1, bd = Infinity;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const c = y * W + x;
    if (owner[c] !== id) continue;
    const dx = 2 * x + 1 - cx2, dy = 2 * y + 1 - cy2;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/** inward normal (x, z) for a wall-aligned yaw (multiples of PI/2), by comparison only (no trig in generation) */
export function normalOfYaw(yaw: number): [number, number] {
  const q = Math.round(yaw / HALF_PI);
  const m = ((q % 4) + 4) % 4;
  return m === 0 ? [0, 1] : m === 1 ? [1, 0] : m === 2 ? [0, -1] : [-1, 0];
}
