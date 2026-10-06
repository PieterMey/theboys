// Owned by track ② Level. Placement helper: wall slots (one per wall-facing cell side) and floor cells per space,
// with door-front / jamb bookkeeping so props never block doors and solids never stack.
import type { LayoutDoor } from '../layout.ts';
import type { Rng } from '../rng.ts';
import { EDGE } from '../nav/grid.ts';
import type { EdgeGrid } from '../nav/grid.ts';
import { yawOf } from './common.ts';

/** visual wall thickness (m); the client mesher uses the same value */
export const WALL_T = 0.16;
export const HALF_T = WALL_T / 2;

export interface WallSlot {
  /** cell * 4 + side */
  key: number;
  cell: number;
  cx: number;
  cy: number;
  /** 0: wall on line x=cx (normal +X), 1: line x=cx+1 (normal -X), 2: line y=cy (normal +Z), 3: line y=cy+1 (normal -Z) */
  side: number;
  /** point on the wall line at the middle of the cell side */
  lx: number;
  lz: number;
  nx: number;
  nz: number;
  jamb: boolean;
}

export interface Mount { x: number; z: number; rot: number; cell: number }

const NORMALS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Placer {
  readonly g: EdgeGrid;
  readonly slots: WallSlot[][];
  readonly cells: number[][];
  readonly usedSlot: Uint8Array;
  /** floor cell taken by an item (solid or floor prop) */
  readonly usedCell: Uint8Array;
  /** cell faces a solid across it: no second solid here (keeps corridors passable) */
  readonly solidBlock: Uint8Array;
  readonly doorFront: Uint8Array;
  private jambKeys = new Set<number>();
  /** slot by key (cell * 4 + side) */
  readonly slotByKey = new Map<number, WallSlot>();

  constructor(g: EdgeGrid, nSpaces: number) {
    this.g = g;
    const { W, H, owner } = g;
    this.usedSlot = new Uint8Array(W * H * 4);
    this.usedCell = new Uint8Array(W * H);
    this.solidBlock = new Uint8Array(W * H);
    this.doorFront = new Uint8Array(W * H);
    const mark = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < W && y < H) this.doorFront[y * W + x] = 1; };
    for (const d of g.doors) {
      for (let i = 0; i < d.len; i++) {
        if (d.dir === 'v') { mark(d.x - 1, d.y + i); mark(d.x, d.y + i); }
        else { mark(d.x + i, d.y - 1); mark(d.x + i, d.y); }
      }
      if (d.kind === 'open') continue;
      // jamb slots: the wall cells right beyond each end of the opening, on both sides
      if (d.dir === 'h') {
        for (const [cx, cy, side] of [[d.x - 1, d.y, 2], [d.x + d.len, d.y, 2], [d.x - 1, d.y - 1, 3], [d.x + d.len, d.y - 1, 3]]) {
          if (cx >= 0 && cy >= 0 && cx < W && cy < H) this.jambKeys.add((cy * W + cx) * 4 + side);
        }
      } else {
        for (const [cx, cy, side] of [[d.x, d.y - 1, 0], [d.x, d.y + d.len, 0], [d.x - 1, d.y - 1, 1], [d.x - 1, d.y + d.len, 1]]) {
          if (cx >= 0 && cy >= 0 && cx < W && cy < H) this.jambKeys.add((cy * W + cx) * 4 + side);
        }
      }
    }
    this.slots = Array.from({ length: nSpaces }, () => []);
    this.cells = Array.from({ length: nSpaces }, () => []);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x, s = owner[c];
      if (s < 0 || s >= nSpaces) continue;
      this.cells[s].push(c);
      const codes = [g.v[y * (W + 1) + x], g.v[y * (W + 1) + x + 1], g.h[y * W + x], g.h[(y + 1) * W + x]];
      for (let side = 0; side < 4; side++) {
        if (codes[side] !== EDGE.wall) continue;
        const [nx, nz] = NORMALS[side];
        const lx = side === 0 ? x : side === 1 ? x + 1 : x + 0.5;
        const lz = side === 2 ? y : side === 3 ? y + 1 : y + 0.5;
        const key = c * 4 + side;
        const slot: WallSlot = { key, cell: c, cx: x, cy: y, side, lx, lz, nx, nz, jamb: this.jambKeys.has(key) };
        this.slots[s].push(slot);
        this.slotByKey.set(key, slot);
      }
    }
  }

  /** world placement for an item of `depth` metres mounted on a slot, shifted `along` the wall (tangent) */
  mount(s: WallSlot, depth: number, along = 0): Mount {
    const off = HALF_T + depth / 2;
    const tx = -s.nz, tz = s.nx; // tangent
    return { x: s.lx + s.nx * off + tx * along, z: s.lz + s.nz * off + tz * along, rot: yawOf(s.nx, s.nz), cell: s.cell };
  }

  private solidOk(s: WallSlot): boolean {
    if (this.usedCell[s.cell] || this.solidBlock[s.cell] || this.doorFront[s.cell]) return false;
    const k = s.cell * 4;
    if (this.usedSlot[k] || this.usedSlot[k + 1] || this.usedSlot[k + 2] || this.usedSlot[k + 3]) return false;
    // keep the cell in front clear of door approaches
    const fx = s.cx + s.nx, fy = s.cy + s.nz;
    const W = this.g.W;
    if (fx >= 0 && fy >= 0 && fx < W && fy < this.g.H && this.doorFront[fy * W + fx] && this.g.owner[fy * W + fx] !== this.g.owner[s.cell]) return false;
    return true;
  }

  take(s: WallSlot, solid = false): void {
    this.usedSlot[s.key] = 1;
    if (solid) {
      this.usedCell[s.cell] = 1;
      const fx = s.cx + s.nx, fy = s.cy + s.nz, W = this.g.W;
      if (fx >= 0 && fy >= 0 && fx < W && fy < this.g.H) this.solidBlock[fy * W + fx] = 1;
      // a solid fills the cell: no wall item on its other sides either (corner overlap)
      for (let side = 0; side < 4; side++) this.usedSlot[s.cell * 4 + side] = 1;
    }
  }

  freeSlots(space: number, opts: { solid?: boolean; allowDoorFront?: boolean; allowJamb?: boolean } = {}): WallSlot[] {
    return this.slots[space].filter((s) =>
      !this.usedSlot[s.key] && (opts.allowDoorFront || !this.doorFront[s.cell]) && (opts.allowJamb || !s.jamb) && (!opts.solid || this.solidOk(s)));
  }

  /** pick a wall slot (random, or best by score), mark it used, return the mounted position */
  pickWall(space: number, rng: Rng, depth: number, opts: { solid?: boolean; allowDoorFront?: boolean; allowJamb?: boolean; score?: (s: WallSlot) => number } = {}): Mount | null {
    const c = this.freeSlots(space, opts);
    if (!c.length) return null;
    let s: WallSlot;
    if (opts.score) {
      s = c[0];
      let bs = opts.score(s);
      for (let i = 1; i < c.length; i++) { const v = opts.score(c[i]); if (v > bs) { bs = v; s = c[i]; } }
    } else s = c[rng.int(0, c.length - 1)];
    this.take(s, opts.solid);
    return this.mount(s, depth);
  }

  /**
   * Wall point right beside door d (inside `space`), `along` metres from the jamb. Used for switches and keypads.
   * Tries both jambs (order randomised by rng when given).
   */
  jamb(d: LayoutDoor, space: number, depth: number, rng: Rng | null, along = 0.3): Mount | null {
    const W = this.g.W, owner = this.g.owner;
    type Cand = { cx: number; cy: number; side: number; ax: number; az: number };
    const cands: Cand[] = [];
    if (d.dir === 'h') {
      const below = d.y < this.g.H && owner[d.y * W + d.x] === space;
      const cy = below ? d.y : d.y - 1, side = below ? 2 : 3;
      cands.push({ cx: d.x - 1, cy, side, ax: d.x - along, az: d.y }, { cx: d.x + d.len, cy, side, ax: d.x + d.len + along, az: d.y });
    } else {
      const right = d.x < W && owner[d.y * W + d.x] === space;
      const cx = right ? d.x : d.x - 1, side = right ? 0 : 1;
      cands.push({ cx, cy: d.y - 1, side, ax: d.x, az: d.y - along }, { cx, cy: d.y + d.len, side, ax: d.x, az: d.y + d.len + along });
    }
    if (rng && rng.chance(0.5)) cands.reverse();
    for (const c of cands) {
      if (c.cx < 0 || c.cy < 0 || c.cx >= W || c.cy >= this.g.H) continue;
      const cell = c.cy * W + c.cx;
      if (owner[cell] !== space) continue;
      const slot = this.slots[space].find((s) => s.cell === cell && s.side === c.side);
      if (!slot || this.usedSlot[slot.key]) continue;
      this.take(slot);
      const off = HALF_T + depth / 2;
      return { x: c.ax + slot.nx * off, z: c.az + slot.nz * off, rot: yawOf(slot.nx, slot.nz), cell };
    }
    return null;
  }

  /** pick a free floor cell (random, or best by score); marks it used. Returns -1 if none. */
  pickFloor(space: number, rng: Rng, opts: { allowDoorFront?: boolean; filter?: (cell: number) => boolean; score?: (cell: number) => number } = {}): number {
    const c = this.cells[space].filter((cell) => !this.usedCell[cell] && (opts.allowDoorFront || !this.doorFront[cell]) && (!opts.filter || opts.filter(cell)));
    if (!c.length) return -1;
    let cell: number;
    if (opts.score) {
      cell = c[0];
      let bs = opts.score(cell);
      for (let i = 1; i < c.length; i++) { const v = opts.score(c[i]); if (v > bs) { bs = v; cell = c[i]; } }
    } else cell = c[rng.int(0, c.length - 1)];
    this.usedCell[cell] = 1;
    return cell;
  }
}
