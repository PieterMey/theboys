// Owner: track (e) speech. Path distance for "who heard what" (PLAN §3.1 / §4.7): the same octile sound flood
// (shared nav, doors +1 open / +6 closed) the voice gate and the monsters use, cached per source cell until the
// door state changes. The van cab is sealed: exactly one endpoint inside -> unreachable. Points in a solid cell
// (standing in a doorway edge, a monster clipping a wall) read the best 8-neighbour + 1 m. No layout -> Euclid.
import { buildEdgeGrid, floodCells } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { LevelLayout, Rect } from '@dead-air/shared/layout.ts';

const inRect = (r: Rect, x: number, z: number) => x >= r.x && x < r.x + r.w && z >= r.y && z < r.y + r.h;

export class Hearing {
  readonly layout: LevelLayout;
  readonly grid: EdgeGrid;
  readonly sealed: Rect[];
  readonly range: number;
  private cache = new Map<number, Float32Array>();
  private sig = '';
  floods = 0;

  constructor(layout: LevelLayout, range = 40) {
    this.layout = layout;
    this.grid = buildEdgeGrid(layout);
    this.sealed = layout.van?.cab ? [layout.van.cab] : [];
    this.range = range;
  }

  /** door-state signature; a change invalidates cached fields */
  doorSignature(doorOpen: DoorOpenFn): string {
    let s = '';
    for (const d of this.layout.doors) s += doorOpen(d.id) ? '1' : '0';
    return s;
  }

  setDoors(sig: string): void {
    if (sig !== this.sig) {
      this.sig = sig;
      this.cache.clear();
    }
  }

  private cellOf(x: number, z: number): number {
    const g = this.grid;
    const cx = Math.floor(x), cz = Math.floor(z);
    if (!Number.isFinite(cx) || !Number.isFinite(cz) || cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return -1;
    return cz * g.W + cx;
  }

  private sealedAt(x: number, z: number): number {
    for (let i = 0; i < this.sealed.length; i++) if (inRect(this.sealed[i], x, z)) return i;
    return -1;
  }

  private field(cell: number, doorOpen: DoorOpenFn): Float32Array {
    let f = this.cache.get(cell);
    if (f) return f;
    const g = this.grid;
    const sources: number[] = [];
    const costs: number[] = [];
    if (g.owner[cell] >= 0) {
      sources.push(cell);
      costs.push(0);
    } else {
      // solid source cell: start from walkable neighbours at +1 m
      const x = cell % g.W, z = (cell - x) / g.W;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if ((dx || dz) && nx >= 0 && nz >= 0 && nx < g.W && nz < g.H && g.owner[nz * g.W + nx] >= 0) { sources.push(nz * g.W + nx); costs.push(1); }
      }
    }
    f = floodCells(g, sources, { mode: 'sound', doorOpen, budget: this.range }, undefined, costs);
    this.floods++;
    this.cache.set(cell, f);
    if (this.cache.size > 48) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    return f;
  }

  private read(f: Float32Array, cell: number): number {
    const g = this.grid;
    const d = f[cell];
    if (Number.isFinite(d) && g.owner[cell] >= 0) return d;
    const x = cell % g.W, z = (cell - x) / g.W;
    let best = Infinity;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, nz = z + dz;
      if ((dx || dz) && nx >= 0 && nz >= 0 && nx < g.W && nz < g.H) {
        const v = f[nz * g.W + nx];
        if (v < best) best = v;
      }
    }
    return Number.isFinite(best) ? best + 1 : Infinity;
  }

  /** path distance in metres from (ax, az) to (bx, bz); Infinity if unreachable / sealed / out of range */
  dist(ax: number, az: number, bx: number, bz: number, doorOpen: DoorOpenFn): number {
    if (this.sealedAt(ax, az) !== this.sealedAt(bx, bz)) return Infinity;
    const a = this.cellOf(ax, az), b = this.cellOf(bx, bz);
    if (a < 0 || b < 0) {
      const dx = ax - bx, dz = az - bz;
      const e = Math.sqrt(dx * dx + dz * dz);
      return e <= this.range ? e : Infinity;
    }
    if (a === b) return 0;
    return this.read(this.field(a, doorOpen), b);
  }

  spaceAt(x: number, z: number): number {
    const c = this.cellOf(x, z);
    return c < 0 ? -1 : this.grid.owner[c];
  }
}

export function euclid(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}
