// Owned by track ② Level. Furniture ('prop' items) from the asset library, placed against walls by room type.
// Solid props carry their footprint (data.w along the wall, data.d depth) so collision + server pose validation
// treat them as boxes. Placement never blocks a door, wall item or another solid, and keeps every room's doors
// and interaction points mutually reachable (cell BFS check per placement).
import type { LayoutSpace } from '../layout.ts';
import type { Rng } from '../rng.ts';
import type { ItemList } from './common.ts';
import { HALF_T } from './place.ts';
import type { Placer, WallSlot } from './place.ts';

export interface PropDef {
  /** manifest key suffix: prop.<key> */
  key: string;
  /** footprint along the wall / away from the wall / height (m), matching the asset's bounds */
  w: number;
  d: number;
  h: number;
  /** wall cells it spans */
  cells: 1 | 2;
  solid: boolean;
  /** 'floor' = stands on the floor with its back to the wall; 'wall' = hung at height y */
  mount: 'floor' | 'wall';
  y?: number;
}

export const PROP_DEFS: Readonly<Record<string, PropDef>> = {
  desk: { key: 'desk', w: 2.0, d: 0.95, h: 0.79, cells: 2, solid: true, mount: 'floor' },
  cabinet: { key: 'cabinet', w: 1.14, d: 0.49, h: 1.88, cells: 2, solid: true, mount: 'floor' },
  shelves: { key: 'shelves', w: 1.1, d: 0.5, h: 2.14, cells: 2, solid: true, mount: 'floor' },
  trash_can: { key: 'trash_can', w: 1.85, d: 0.56, h: 0.91, cells: 2, solid: true, mount: 'floor' },
  bed_frame: { key: 'bed_frame', w: 0.9, d: 2.0, h: 1.2, cells: 1, solid: true, mount: 'floor' },
  barrel: { key: 'barrel', w: 0.56, d: 0.56, h: 0.88, cells: 1, solid: true, mount: 'floor' },
  crate: { key: 'crate', w: 0.83, d: 0.41, h: 0.35, cells: 1, solid: true, mount: 'floor' },
  generator: { key: 'generator', w: 0.82, d: 0.56, h: 0.58, cells: 1, solid: true, mount: 'floor' },
  tool_chest: { key: 'tool_chest', w: 0.69, d: 0.41, h: 0.65, cells: 1, solid: true, mount: 'floor' },
  wheelchair: { key: 'wheelchair', w: 0.82, d: 1.09, h: 1.1, cells: 1, solid: true, mount: 'floor' },
  chair: { key: 'chair', w: 0.57, d: 0.68, h: 1.01, cells: 1, solid: false, mount: 'floor' },
  cardboard_box: { key: 'cardboard_box', w: 0.39, d: 0.52, h: 0.34, cells: 1, solid: false, mount: 'floor' },
  jerrycan: { key: 'jerrycan', w: 0.35, d: 0.17, h: 0.46, cells: 1, solid: false, mount: 'floor' },
  bottles: { key: 'bottles', w: 0.68, d: 0.08, h: 0.33, cells: 1, solid: false, mount: 'floor' },
  medical_box: { key: 'medical_box', w: 0.53, d: 0.35, h: 0.1, cells: 1, solid: false, mount: 'floor' },
  fuse_box: { key: 'fuse_box', w: 0.46, d: 0.4, h: 0.5, cells: 1, solid: false, mount: 'wall', y: 1.5 },
  security_camera: { key: 'security_camera', w: 0.17, d: 0.55, h: 0.29, cells: 1, solid: false, mount: 'wall', y: 2.62 },
};

/** furniture sets by room type (cycled in order; first entries are placed first) */
const SETS: Record<string, string[]> = {
  office: ['desk', 'cabinet', 'chair', 'shelves', 'cardboard_box', 'trash_can'],
  archive: ['shelves', 'shelves', 'cabinet', 'shelves', 'cardboard_box', 'shelves'],
  library: ['shelves', 'shelves', 'shelves', 'desk', 'chair', 'shelves'],
  mailroom: ['shelves', 'desk', 'cardboard_box', 'cardboard_box', 'cabinet'],
  server: ['cabinet', 'cabinet', 'cabinet', 'desk', 'fuse_box'],
  radio: ['desk', 'cabinet', 'chair', 'fuse_box'],
  storage: ['shelves', 'shelves', 'crate', 'barrel', 'cardboard_box', 'shelves', 'jerrycan'],
  dock: ['crate', 'crate', 'barrel', 'shelves', 'trash_can', 'jerrycan', 'crate'],
  garage: ['tool_chest', 'shelves', 'barrel', 'jerrycan', 'tool_chest', 'generator', 'crate'],
  boiler: ['generator', 'barrel', 'fuse_box', 'barrel', 'tool_chest', 'jerrycan'],
  furnace: ['barrel', 'generator', 'barrel', 'crate', 'fuse_box'],
  foundry: ['crate', 'barrel', 'generator', 'crate', 'tool_chest', 'barrel'],
  pumps: ['generator', 'barrel', 'fuse_box', 'barrel', 'tool_chest'],
  tanks: ['barrel', 'barrel', 'barrel', 'generator', 'fuse_box', 'barrel'],
  pit: ['crate', 'barrel', 'cardboard_box', 'crate', 'jerrycan'],
  greenhouse: ['shelves', 'crate', 'barrel', 'shelves', 'cardboard_box'],
  infirmary: ['bed_frame', 'bed_frame', 'cabinet', 'wheelchair', 'medical_box', 'bed_frame'],
  morgue: ['bed_frame', 'cabinet', 'bed_frame', 'medical_box', 'wheelchair'],
  nursery: ['bed_frame', 'shelves', 'cardboard_box', 'chair'],
  cryo: ['cabinet', 'cabinet', 'generator', 'fuse_box', 'medical_box'],
  cold: ['shelves', 'shelves', 'crate', 'cardboard_box'],
  showers: ['bottles', 'trash_can', 'shelves'],
  kitchen: ['shelves', 'cabinet', 'trash_can', 'bottles', 'crate'],
  canteen: ['desk', 'desk', 'chair', 'chair', 'trash_can', 'chair'],
  laundry: ['shelves', 'cabinet', 'cardboard_box', 'trash_can', 'barrel'],
  chapel: ['chair', 'chair', 'chair', 'cabinet', 'chair'],
  gallery: ['crate', 'cardboard_box', 'chair', 'crate'],
  lobby: ['desk', 'chair', 'trash_can', 'cabinet'],
  vault: ['shelves', 'crate'],
};
const CORRIDOR_SET = ['fuse_box', 'security_camera', 'trash_can', 'cardboard_box'];

interface Ctx {
  W: number;
  H: number;
  owner: Int32Array;
  spaces: readonly LayoutSpace[];
  P: Placer;
  items: ItemList;
  /** cells that must stay reachable inside each room (interactive wall items, loot, the Core) */
  keep: Uint8Array;
  /** cells covered by solids (lockers + solid furniture) */
  blocked: Uint8Array;
  /** BFS scratch */
  stamp: Uint32Array;
  gen: number;
  queue: Int32Array;
}

/** neighbour slot along the wall (same side, next cell along the tangent) */
function nextAlong(P: Placer, s: WallSlot, W: number): WallSlot | null {
  const cx = s.cx - s.nz, cy = s.cy + s.nx;
  if (cx < 0 || cy < 0 || cx >= W || cy >= P.g.H) return null;
  const q = P.slotByKey.get((cy * W + cx) * 4 + s.side);
  return q && P.g.owner[q.cell] === P.g.owner[s.cell] ? q : null;
}

/** cells a floor prop covers: the slot cell(s) and, for deep props, the cells in front of them */
function footprintCells(s: WallSlot, s2: WallSlot | null, depthCells: number, W: number, out: number[]): number[] {
  out.length = 0;
  for (const base of s2 ? [s, s2] : [s]) {
    for (let k = 0; k < depthCells; k++) out.push((base.cy + base.nz * k) * W + base.cx + base.nx * k);
  }
  return out;
}

/** every door-front / keep cell of the room must stay reachable from the first one (cells in `extra` blocked too) */
function roomStaysConnected(c: Ctx, sid: number, extra: readonly number[]): boolean {
  const cells = c.P.cells[sid];
  const { P, blocked, W } = c;
  for (const q of extra) if (P.doorFront[q] || c.keep[q]) return false;
  for (const q of extra) blocked[q] |= 2;
  let first = -1, mustCount = 0;
  for (const q of cells) if (!blocked[q] && (P.doorFront[q] || c.keep[q])) { mustCount++; if (first < 0) first = q; }
  let ok = true;
  if (mustCount > 1) {
    c.gen = (c.gen + 1) >>> 0;
    const gen = c.gen, st = c.stamp, qu = c.queue, g = P.g;
    let head = 0, tail = 0, reached = 0;
    st[first] = gen; qu[tail++] = first;
    const own = c.owner;
    while (head < tail) {
      const u = qu[head++];
      if (P.doorFront[u] || c.keep[u]) reached++;
      const x = u % W, y = (u - x) / W;
      if (x + 1 < W && g.v[y * (W + 1) + x + 1] === 0) { const v = u + 1; if (st[v] !== gen && own[v] === sid && !blocked[v]) { st[v] = gen; qu[tail++] = v; } }
      if (x > 0 && g.v[y * (W + 1) + x] === 0) { const v = u - 1; if (st[v] !== gen && own[v] === sid && !blocked[v]) { st[v] = gen; qu[tail++] = v; } }
      if (y + 1 < c.H && g.h[(y + 1) * W + x] === 0) { const v = u + W; if (st[v] !== gen && own[v] === sid && !blocked[v]) { st[v] = gen; qu[tail++] = v; } }
      if (y > 0 && g.h[y * W + x] === 0) { const v = u - W; if (st[v] !== gen && own[v] === sid && !blocked[v]) { st[v] = gen; qu[tail++] = v; } }
    }
    ok = reached === mustCount;
  }
  for (const q of extra) blocked[q] &= ~2;
  return ok;
}

/**
 * Place furniture in every room / hall (and a few wall fixtures in corridors). Call after all gameplay items.
 * `keep` marks cells players must reach (in front of interactive wall items, loot, the Core).
 */
export function placeDecor(W: number, H: number, owner: Int32Array, spaces: readonly LayoutSpace[], P: Placer, items: ItemList, rng: Rng, keep: Uint8Array): number {
  const c: Ctx = { W, H, owner, spaces, P, items, keep, blocked: new Uint8Array(W * H), stamp: new Uint32Array(W * H), gen: 0, queue: new Int32Array(W * H) };
  for (const it of items.items) if (it.kind === 'hiding') c.blocked[Math.floor(it.z) * W + Math.floor(it.x)] = 1;
  let placed = 0;
  for (const s of spaces) {
    if (s.open || s.type === 'van') continue;
    const area = s.rect.w * s.rect.h;
    const set = s.kind === 'corridor' ? CORRIDOR_SET : SETS[s.type] ?? SETS.storage;
    const want = s.kind === 'corridor' ? (area >= 10 && rng.chance(0.45) ? 1 : 0) : Math.min(8, Math.max(1, Math.round(area / 9)));
    let n = 0;
    for (let k = 0; k < set.length * 2 && n < want; k++) {
      const def = PROP_DEFS[set[k % set.length]];
      if (!def) continue;
      if (s.kind === 'corridor' && def.solid && def.d > 0.6) continue;
      if (placeOne(c, s.id, def, rng)) { n++; placed++; }
    }
  }
  return placed;
}

const fp: number[] = [];

function placeOne(c: Ctx, sid: number, def: PropDef, rng: Rng): boolean {
  const { P, W } = c;
  const slots = rng.shuffle(P.freeSlots(sid, { solid: def.mount === 'floor' }));
  const depthCells = Math.max(1, Math.ceil(def.d - 0.05));
  for (const s of slots) {
    if (def.mount === 'wall') {
      P.take(s);
      const m = P.mount(s, def.d);
      c.items.add('prop', sid, m.x, m.z, { y: def.y ?? 1.5, rot: m.rot, data: { prop: def.key, solid: false, w: def.w, d: def.d } });
      return true;
    }
    let s2: WallSlot | null = null;
    if (def.cells === 2) {
      s2 = nextAlong(P, s, W);
      if (!s2 || P.usedSlot[s2.key] || P.usedCell[s2.cell] || P.doorFront[s2.cell] || P.solidBlock[s2.cell] || s2.jamb) continue;
    }
    const cells = footprintCells(s, s2, depthCells, W, fp);
    let ok = true;
    for (const q of cells) {
      if (q < 0 || q >= c.owner.length || c.owner[q] !== sid || P.usedCell[q] || P.doorFront[q] || c.keep[q] || P.solidBlock[q] || c.blocked[q]) { ok = false; break; }
    }
    if (!ok) continue;
    if (def.solid && !roomStaysConnected(c, sid, cells)) continue;
    if (def.solid) for (const q of cells) c.blocked[q] = 1;
    P.take(s, true);
    if (s2) P.take(s2, true);
    for (const q of cells) P.usedCell[q] = 1;
    // centre: between the two slots for 2-cell props, depth/2 off the wall face
    const off = HALF_T + def.d / 2 + 0.02;
    const lx = s2 ? (s.lx + s2.lx) / 2 : s.lx, lz = s2 ? (s.lz + s2.lz) / 2 : s.lz;
    const m = P.mount(s, 0);
    c.items.add('prop', sid, lx + s.nx * off, lz + s.nz * off, { y: 0, rot: m.rot, data: { prop: def.key, solid: def.solid, w: def.w, d: def.d } });
    return true;
  }
  return false;
}
