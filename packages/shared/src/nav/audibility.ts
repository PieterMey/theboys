// Owned by track ② Level. Per-tick audibility: path distance (sound metric) for N speakers x M receivers.
// One bounded flood per speaker cell, cached until the speaker changes cell or any door changes state.
// Sealed rects (the van cab): a pair with exactly one endpoint inside is unreachable (255).
import { PATH } from '../constants.ts';
import type { Rect } from '../layout.ts';
import type { DoorOpenFn, EdgeGrid } from './grid.ts';
import { floodCells } from './path.ts';

export interface AudPoint { id: string; x: number; z: number }

export interface AudibilityOptions {
  /** flood budget (m); anything farther is reported as unreachable. Default 40 (> scream radius 35). */
  range?: number;
  /** sealed interiors, e.g. [layout.van.cab] */
  sealed?: readonly Rect[];
  /** cached fields kept (LRU) */
  cacheSize?: number;
}

export const UNREACHABLE = PATH.unreachable;

const inRect = (r: Rect, x: number, z: number) => x >= r.x && x < r.x + r.w && z >= r.y && z < r.y + r.h;

export class Audibility {
  readonly grid: EdgeGrid;
  readonly range: number;
  readonly sealed: readonly Rect[];
  private cacheSize: number;
  private cache = new Map<number, Float32Array>();
  private doorVersion = 0;
  private cacheVersion = 0;
  /** floods computed since construction (for perf tests / debugging) */
  floods = 0;

  constructor(grid: EdgeGrid, opts: AudibilityOptions = {}) {
    this.grid = grid;
    this.range = opts.range ?? 40;
    this.sealed = opts.sealed ?? [];
    this.cacheSize = opts.cacheSize ?? 24;
  }

  /** Call whenever any door opens/closes/locks (invalidates cached fields). */
  doorsChanged(): void { this.doorVersion++; }

  /** sealed-region index containing (x, z), or -1 */
  sealedAt(x: number, z: number): number {
    for (let i = 0; i < this.sealed.length; i++) if (inRect(this.sealed[i], x, z)) return i;
    return -1;
  }

  /** Cached bounded sound field from the cell containing (x, z). */
  field(x: number, z: number, doorOpen: DoorOpenFn): Float32Array | null {
    const g = this.grid;
    const cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return null;
    if (this.cacheVersion !== this.doorVersion) { this.cache.clear(); this.cacheVersion = this.doorVersion; }
    const key = cz * g.W + cx;
    let f = this.cache.get(key);
    if (f) { this.cache.delete(key); this.cache.set(key, f); return f; }
    f = floodCells(g, [key], { mode: 'sound', doorOpen, budget: this.range });
    this.floods++;
    this.cache.set(key, f);
    if (this.cache.size > this.cacheSize) { const first = this.cache.keys().next().value; if (first !== undefined) this.cache.delete(first); }
    return f;
  }

  /** Rounded path distance (m) between two points, 255 if unreachable, sealed or beyond range. */
  distance(ax: number, az: number, bx: number, bz: number, doorOpen: DoorOpenFn): number {
    const sa = this.sealedAt(ax, az), sb = this.sealedAt(bx, bz);
    if (sa !== sb) return UNREACHABLE;
    const f = this.field(ax, az, doorOpen);
    if (!f) return UNREACHABLE;
    const cx = Math.floor(bx), cz = Math.floor(bz);
    if (cx < 0 || cz < 0 || cx >= this.grid.W || cz >= this.grid.H) return UNREACHABLE;
    const d = f[cz * this.grid.W + cx];
    return Number.isFinite(d) ? Math.min(UNREACHABLE - 1, Math.round(d)) : UNREACHABLE;
  }

  /**
   * Distances for every speaker -> receiver pair: result[speakerId][receiverId] (rounded m, 255 = unreachable).
   * The sound metric is symmetric, so result[a][b] === result[b][a] up to cell rounding.
   */
  matrix(speakers: readonly AudPoint[], receivers: readonly AudPoint[], doorOpen: DoorOpenFn): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const s of speakers) {
      const row: Record<string, number> = {};
      for (const r of receivers) row[r.id] = r.id === s.id ? 0 : this.distance(s.x, s.z, r.x, r.z, doorOpen);
      out[s.id] = row;
    }
    return out;
  }
}
