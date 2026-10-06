// Owned by track ② Level. Furniture ('prop' items): asset-library models (prop.* GLBs) plus procedural set pieces
// (server racks, pews, canteen tables, pallet racks, boilers, morgue drawers...), placed by room type.
//  1. set pieces: free-standing rows / grids in the room interior (canteen tables, chapel pews, server-farm racks,
//     warehouse pallet racks, library stacks, boiler tanks, autopsy tables...), each on an exact cell rectangle
//  2. wall-backed furniture by room type, dense (about one piece per decorAreaPerProp m2)
// Solid props carry their footprint (data.w along the local x axis, data.d depth) so collision + server pose
// validation treat them as boxes. Placement never blocks a door, wall item or another solid, and keeps every room's
// doors and interaction points mutually reachable (cell BFS check per solid placement).
import type { LayoutSpace } from '../layout.ts';
import type { Rng } from '../rng.ts';
import type { ItemList } from './common.ts';
import { HALF_T } from './place.ts';
import type { Placer, WallSlot } from './place.ts';

export interface PropDef {
  /** manifest key suffix: prop.<key> (procedural props have no GLB; the client models them) */
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
  /** modelled by the client (apps/client/src/level/setpieces.ts), no asset */
  proc?: boolean;
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
  // ---- procedural set pieces (client-modelled) ----
  server_rack: { key: 'server_rack', w: 0.62, d: 0.9, h: 2.05, cells: 1, solid: true, mount: 'floor', proc: true },
  morgue_drawers: { key: 'morgue_drawers', w: 1.9, d: 0.78, h: 2.0, cells: 2, solid: true, mount: 'floor', proc: true },
  autopsy_table: { key: 'autopsy_table', w: 1.9, d: 0.8, h: 0.92, cells: 2, solid: true, mount: 'floor', proc: true },
  table: { key: 'table', w: 1.8, d: 0.8, h: 0.76, cells: 2, solid: true, mount: 'floor', proc: true },
  pew: { key: 'pew', w: 2.7, d: 0.62, h: 0.95, cells: 2, solid: true, mount: 'floor', proc: true },
  altar: { key: 'altar', w: 1.8, d: 0.75, h: 1.05, cells: 2, solid: true, mount: 'floor', proc: true },
  pallet_rack: { key: 'pallet_rack', w: 1.9, d: 0.9, h: 2.6, cells: 2, solid: true, mount: 'floor', proc: true },
  boiler_tank: { key: 'boiler_tank', w: 1.8, d: 1.8, h: 2.5, cells: 2, solid: true, mount: 'floor', proc: true },
  tank: { key: 'tank', w: 0.85, d: 0.85, h: 1.9, cells: 1, solid: true, mount: 'floor', proc: true },
  counter: { key: 'counter', w: 1.9, d: 0.7, h: 0.95, cells: 2, solid: true, mount: 'floor', proc: true },
  workbench: { key: 'workbench', w: 1.85, d: 0.75, h: 0.92, cells: 2, solid: true, mount: 'floor', proc: true },
  washer: { key: 'washer', w: 0.7, d: 0.68, h: 0.92, cells: 1, solid: true, mount: 'floor', proc: true },
  stove: { key: 'stove', w: 0.9, d: 0.72, h: 0.92, cells: 1, solid: true, mount: 'floor', proc: true },
  pallet_stack: { key: 'pallet_stack', w: 1.2, d: 0.9, h: 1.1, cells: 1, solid: true, mount: 'floor', proc: true },
  plant_table: { key: 'plant_table', w: 1.8, d: 0.8, h: 0.9, cells: 2, solid: true, mount: 'floor', proc: true },
  bench: { key: 'bench', w: 1.6, d: 0.42, h: 0.46, cells: 2, solid: true, mount: 'floor', proc: true },
  filing: { key: 'filing', w: 0.5, d: 0.62, h: 1.32, cells: 1, solid: true, mount: 'floor', proc: true },
  pipes_wall: { key: 'pipes_wall', w: 0.7, d: 0.22, h: 2.6, cells: 1, solid: false, mount: 'wall', y: 1.32, proc: true },
  fire_ext: { key: 'fire_ext', w: 0.32, d: 0.2, h: 0.62, cells: 1, solid: false, mount: 'wall', y: 1.05, proc: true },
  noticeboard: { key: 'noticeboard', w: 1.2, d: 0.04, h: 0.8, cells: 1, solid: false, mount: 'wall', y: 1.55, proc: true },
  clock: { key: 'clock', w: 0.34, d: 0.06, h: 0.34, cells: 1, solid: false, mount: 'wall', y: 2.2, proc: true },
  crucifix: { key: 'crucifix', w: 0.5, d: 0.05, h: 0.8, cells: 1, solid: false, mount: 'wall', y: 1.9, proc: true },
};

/** wall-backed furniture sets by room type (cycled in order; first entries are placed first) */
const SETS: Record<string, string[]> = {
  office: ['desk', 'filing', 'cabinet', 'chair', 'shelves', 'noticeboard', 'cardboard_box', 'filing', 'trash_can', 'clock', 'desk', 'cardboard_box'],
  archive: ['shelves', 'filing', 'shelves', 'cabinet', 'filing', 'shelves', 'cardboard_box', 'filing', 'cardboard_box'],
  library: ['shelves', 'shelves', 'desk', 'chair', 'shelves', 'clock', 'shelves', 'cardboard_box'],
  mailroom: ['shelves', 'desk', 'cardboard_box', 'filing', 'cardboard_box', 'cabinet', 'noticeboard', 'cardboard_box'],
  server: ['server_rack', 'server_rack', 'cabinet', 'fuse_box', 'server_rack', 'desk', 'chair', 'pipes_wall', 'server_rack'],
  radio: ['desk', 'cabinet', 'chair', 'fuse_box', 'filing', 'noticeboard'],
  storage: ['pallet_rack', 'shelves', 'crate', 'barrel', 'cardboard_box', 'pallet_stack', 'shelves', 'jerrycan', 'cardboard_box', 'fire_ext'],
  dock: ['pallet_stack', 'crate', 'barrel', 'pallet_rack', 'trash_can', 'jerrycan', 'crate', 'pallet_stack', 'cardboard_box', 'fire_ext'],
  garage: ['workbench', 'tool_chest', 'shelves', 'barrel', 'jerrycan', 'tool_chest', 'generator', 'crate', 'workbench', 'fire_ext', 'pipes_wall'],
  boiler: ['pipes_wall', 'generator', 'barrel', 'fuse_box', 'pipes_wall', 'tool_chest', 'barrel', 'jerrycan', 'fire_ext'],
  furnace: ['barrel', 'generator', 'pipes_wall', 'barrel', 'crate', 'fuse_box', 'workbench', 'jerrycan'],
  foundry: ['workbench', 'crate', 'barrel', 'generator', 'pipes_wall', 'crate', 'tool_chest', 'barrel', 'pallet_stack'],
  pumps: ['pipes_wall', 'generator', 'tank', 'barrel', 'fuse_box', 'pipes_wall', 'tool_chest', 'tank'],
  tanks: ['tank', 'barrel', 'tank', 'pipes_wall', 'barrel', 'generator', 'fuse_box', 'tank', 'barrel'],
  pit: ['crate', 'barrel', 'cardboard_box', 'pallet_stack', 'crate', 'jerrycan', 'barrel'],
  greenhouse: ['plant_table', 'shelves', 'crate', 'barrel', 'plant_table', 'cardboard_box', 'jerrycan'],
  infirmary: ['bed_frame', 'bed_frame', 'cabinet', 'wheelchair', 'medical_box', 'bed_frame', 'filing', 'clock', 'bed_frame', 'medical_box'],
  morgue: ['morgue_drawers', 'morgue_drawers', 'cabinet', 'medical_box', 'morgue_drawers', 'wheelchair', 'clock'],
  nursery: ['bed_frame', 'shelves', 'cardboard_box', 'chair', 'bed_frame', 'clock', 'cardboard_box'],
  cryo: ['tank', 'cabinet', 'tank', 'generator', 'fuse_box', 'medical_box', 'pipes_wall', 'tank'],
  cold: ['shelves', 'shelves', 'crate', 'cardboard_box', 'pallet_stack', 'shelves', 'crate'],
  showers: ['bench', 'bottles', 'trash_can', 'bench', 'shelves', 'pipes_wall'],
  kitchen: ['counter', 'stove', 'counter', 'shelves', 'stove', 'trash_can', 'bottles', 'crate', 'counter', 'fire_ext'],
  canteen: ['counter', 'counter', 'trash_can', 'chair', 'noticeboard', 'clock', 'cardboard_box', 'chair'],
  laundry: ['washer', 'washer', 'washer', 'shelves', 'cabinet', 'cardboard_box', 'washer', 'trash_can', 'barrel', 'washer'],
  chapel: ['altar', 'crucifix', 'chair', 'cabinet', 'chair', 'bench', 'chair'],
  gallery: ['crate', 'pallet_stack', 'cardboard_box', 'chair', 'crate', 'bench', 'noticeboard'],
  lobby: ['desk', 'chair', 'bench', 'trash_can', 'cabinet', 'noticeboard', 'clock', 'fire_ext'],
  vault: ['shelves', 'crate', 'filing'],
};
/** at most one per room */
const ONCE = new Set(['altar', 'clock', 'desk_lobby']);
const CORRIDOR_SET = ['fuse_box', 'fire_ext', 'trash_can', 'security_camera', 'cardboard_box', 'pipes_wall', 'noticeboard', 'jerrycan'];

/** free-standing set-piece plans by room type: grid of props in the room interior */
interface FreePlan {
  key: string;
  /** cells per item along its own x / z (local, before rotation) */
  cw: number;
  ch: number;
  /** extra cells between items along x / z */
  gx: number;
  gz: number;
  /** keep this many cells free along every wall */
  margin: number;
  /** minimum room short side to use the plan */
  minSide: number;
  /** items get rotated so their x runs along the room's long axis ('long') or short axis ('short') */
  axis: 'long' | 'short';
  /** for row props: the row is one item n cells long (n = data.n) instead of one item per cell group */
  row?: boolean;
  /** chairs beside every item (canteen tables, desks) */
  chairs?: boolean;
  /** asset rows: models back to back (double-sided stack, box depth = 2 models) */
  double?: boolean;
  chance?: number;
}
const FREE: Record<string, FreePlan> = {
  canteen: { key: 'table', cw: 2, ch: 1, gx: 1, gz: 2, margin: 2, minSide: 6, axis: 'long', chairs: true },
  chapel: { key: 'pew', cw: 3, ch: 1, gx: 1, gz: 1, margin: 2, minSide: 6, axis: 'short' },
  server: { key: 'server_rack', cw: 1, ch: 1, gx: 0, gz: 2, margin: 2, minSide: 5, axis: 'long', row: true },
  storage: { key: 'pallet_rack', cw: 2, ch: 1, gx: 0, gz: 2, margin: 2, minSide: 6, axis: 'long', row: true },
  dock: { key: 'pallet_stack', cw: 1, ch: 1, gx: 2, gz: 2, margin: 2, minSide: 6, axis: 'long', chance: 0.75 },
  library: { key: 'shelves', cw: 2, ch: 1, gx: 0, gz: 2, margin: 2, minSide: 6, axis: 'long', row: true, double: true },
  archive: { key: 'shelves', cw: 2, ch: 1, gx: 0, gz: 2, margin: 2, minSide: 5, axis: 'long', row: true, double: true },
  cold: { key: 'pallet_rack', cw: 2, ch: 1, gx: 0, gz: 2, margin: 2, minSide: 6, axis: 'long', row: true },
  boiler: { key: 'boiler_tank', cw: 2, ch: 2, gx: 2, gz: 2, margin: 2, minSide: 6, axis: 'long' },
  tanks: { key: 'tank', cw: 1, ch: 1, gx: 1, gz: 2, margin: 2, minSide: 6, axis: 'long' },
  pumps: { key: 'tank', cw: 1, ch: 1, gx: 2, gz: 2, margin: 2, minSide: 6, axis: 'long', chance: 0.8 },
  morgue: { key: 'autopsy_table', cw: 2, ch: 1, gx: 1, gz: 2, margin: 2, minSide: 5, axis: 'long' },
  greenhouse: { key: 'plant_table', cw: 2, ch: 1, gx: 1, gz: 2, margin: 2, minSide: 6, axis: 'long' },
  office: { key: 'desk', cw: 2, ch: 1, gx: 1, gz: 2, margin: 2, minSide: 7, axis: 'long', chairs: true, chance: 0.8 },
  kitchen: { key: 'table', cw: 2, ch: 1, gx: 2, gz: 2, margin: 2, minSide: 6, axis: 'long', chance: 0.7 },
  laundry: { key: 'table', cw: 2, ch: 1, gx: 2, gz: 2, margin: 2, minSide: 6, axis: 'long', chance: 0.6 },
  garage: { key: 'pallet_stack', cw: 1, ch: 1, gx: 3, gz: 2, margin: 2, minSide: 7, axis: 'long', chance: 0.6 },
  foundry: { key: 'pallet_stack', cw: 1, ch: 1, gx: 3, gz: 2, margin: 2, minSide: 7, axis: 'long', chance: 0.7 },
  gallery: { key: 'pallet_stack', cw: 1, ch: 1, gx: 3, gz: 3, margin: 2, minSide: 7, axis: 'long', chance: 0.6 },
  infirmary: { key: 'bed_frame', cw: 1, ch: 2, gx: 1, gz: 2, margin: 2, minSide: 8, axis: 'short', chance: 0.6 },
};

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
  } else if (mustCount === 0) {
    // nothing to reach (should not happen: every room has a door) - refuse rather than wall the room in
    ok = false;
  }
  for (const q of extra) blocked[q] &= ~2;
  return ok;
}

export interface DecorOpts {
  /** furniture per room = area / areaPerProp, clamped to [1, maxPerRoom] */
  areaPerProp?: number;
  maxPerRoom?: number;
}

/**
 * Place furniture in every room / hall (and wall fixtures + a little clutter in corridors). Call after all gameplay
 * items. `keep` marks cells players must reach (in front of interactive wall items, loot, the Core).
 */
export function placeDecor(W: number, H: number, owner: Int32Array, spaces: readonly LayoutSpace[], P: Placer, items: ItemList, rng: Rng, keep: Uint8Array, o: DecorOpts = {}): number {
  const c: Ctx = { W, H, owner, spaces, P, items, keep, blocked: new Uint8Array(W * H), stamp: new Uint32Array(W * H), gen: 0, queue: new Int32Array(W * H) };
  for (const it of items.items) if (it.kind === 'hiding') c.blocked[Math.floor(it.z) * W + Math.floor(it.x)] = 1;
  const perProp = o.areaPerProp ?? 9, maxPer = o.maxPerRoom ?? 8;
  let placed = 0;
  for (const s of spaces) {
    if (s.open || s.type === 'van') continue;
    const area = s.rect.w * s.rect.h;
    // 1. set pieces in the interior
    const plan = s.kind === 'corridor' ? undefined : FREE[s.type];
    if (plan && Math.min(s.rect.w, s.rect.h) >= plan.minSide && rng.chance(plan.chance ?? 1)) placed += placeFree(c, s, plan, rng);
    // 2. wall-backed furniture
    const set = s.kind === 'corridor' ? CORRIDOR_SET : SETS[s.type] ?? SETS.storage;
    const want = s.kind === 'corridor' ? Math.min(4, Math.floor(area / 9) + (rng.chance(0.5) ? 1 : 0)) : Math.min(maxPer, Math.max(1, Math.round(area / perProp)));
    let n = 0;
    const once = new Set<string>();
    for (let k = 0; k < set.length * 3 && n < want; k++) {
      const def = PROP_DEFS[set[k % set.length]];
      if (!def || once.has(def.key)) continue;
      if (ONCE.has(def.key)) once.add(def.key);
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
      if (c.blocked[s.cell] || P.usedCell[s.cell]) continue;
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

const rectCells: number[] = [];

/** Free-standing grid / rows of one prop in the room interior. Every item sits on an exact cell rectangle. */
function placeFree(c: Ctx, s: LayoutSpace, plan: FreePlan, rng: Rng): number {
  const { P, W } = c;
  const def = PROP_DEFS[plan.key];
  if (!def) return 0;
  const r = s.rect;
  const longX = r.w >= r.h;
  // item x axis runs along world X when (axis long and room long in X) or (axis short and room long in Z)
  const itemAlongX = plan.axis === 'long' ? longX : !longX;
  const m = plan.margin;
  const x0 = r.x + m, x1 = r.x + r.w - m, z0 = r.y + m, z1 = r.y + r.h - m; // interior [x0, x1) x [z0, z1)
  if (x1 - x0 < 1 || z1 - z0 < 1) return 0;
  // cell size of one item (world axes) and the pitch between items
  const cwX = itemAlongX ? plan.cw : plan.ch, chZ = itemAlongX ? plan.ch : plan.cw;
  const gX = itemAlongX ? plan.gx : plan.gz, gZ = itemAlongX ? plan.gz : plan.gx;
  const rot0 = itemAlongX ? 0 : Math.PI / 2;
  const flip = rng.chance(0.5) ? Math.PI : 0; // which way the pews / chairs face (whole room)
  let placed = 0;
  const tryRect = (cx: number, cz: number, wC: number, hC: number, n: number): boolean => {
    rectCells.length = 0;
    for (let z = cz; z < cz + hC; z++) for (let x = cx; x < cx + wC; x++) {
      const q = z * W + x;
      if (c.owner[q] !== s.id || P.usedCell[q] || P.doorFront[q] || c.keep[q] || P.solidBlock[q] || c.blocked[q]) return false;
      rectCells.push(q);
    }
    if (def.solid && !roomStaysConnected(c, s.id, rectCells)) return false;
    for (const q of rectCells) { if (def.solid) c.blocked[q] = 1; P.usedCell[q] = 1; for (let side = 0; side < 4; side++) P.usedSlot[q * 4 + side] = 1; }
    const len = n > 1 ? n * (itemAlongX ? wC / n : hC / n) : 0;
    // box: the item def's size, never larger than its cell rect minus a 5 cm skin on each side
    const spanX = wC - 0.1, spanZ = hC - 0.1;
    const w = n > 1 ? (itemAlongX ? spanX : spanZ) : Math.min(def.w, itemAlongX ? spanX : spanZ);
    const d = Math.min(plan.double ? def.d * 2 + 0.02 : def.d, itemAlongX ? spanZ : spanX);
    const data: Record<string, number | string | boolean> = { prop: def.key, solid: def.solid, w: Math.round(w * 1000) / 1000, d: Math.round(d * 1000) / 1000, free: true };
    if (n > 1) { data.n = n; data.len = len; }
    c.items.add('prop', s.id, cx + wC / 2, cz + hC / 2, { y: 0, rot: rot0 + flip, data });
    placed++;
    if (plan.chairs) {
      // chairs on both long sides (non-solid, cosmetic seats), only on free cells
      const chair = PROP_DEFS.chair;
      for (const side of [-1, 1]) for (let k = 0; k < (itemAlongX ? wC : hC); k++) {
        const ccx = itemAlongX ? cx + k : side < 0 ? cx - 1 : cx + wC;
        const ccz = itemAlongX ? (side < 0 ? cz - 1 : cz + hC) : cz + k;
        const q = ccz * W + ccx;
        if (ccx < 0 || ccz < 0 || ccx >= W || ccz >= c.H || c.owner[q] !== s.id || P.usedCell[q] || P.doorFront[q] || c.keep[q] || c.blocked[q]) continue;
        if (!rng.chance(0.8)) continue;
        P.usedCell[q] = 1;
        // seat faces the table: back away from it
        const px = itemAlongX ? ccx + 0.5 : ccx + 0.5 + (side < 0 ? 0.1 : -0.1);
        const pz = itemAlongX ? ccz + 0.5 + (side < 0 ? 0.1 : -0.1) : ccz + 0.5;
        const yaw = itemAlongX ? (side < 0 ? 0 : Math.PI) : (side < 0 ? Math.PI / 2 : -Math.PI / 2);
        c.items.add('prop', s.id, px, pz, { y: 0, rot: yaw, data: { prop: chair.key, solid: false, w: chair.w, d: chair.d } });
      }
    }
    return true;
  };
  if (plan.row) {
    // rows along the item axis, each one long item (n units), split where blocked
    const unit = itemAlongX ? cwX : chZ;
    const across = itemAlongX ? chZ : cwX;
    const pitch = across + (itemAlongX ? gZ : gX);
    const a0 = itemAlongX ? z0 : x0, a1 = itemAlongX ? z1 : x1;
    const b0 = itemAlongX ? x0 : z0, b1 = itemAlongX ? x1 : z1;
    for (let a = a0; a + across <= a1; a += pitch) {
      let b = b0;
      while (b + unit <= b1) {
        // grow the run as long as the next unit fits
        let n = 0;
        while (b + (n + 1) * unit <= b1) {
          const ok = (() => {
            for (let k = 0; k < unit; k++) for (let j = 0; j < across; j++) {
              const x = itemAlongX ? b + n * unit + k : a + j, z = itemAlongX ? a + j : b + n * unit + k;
              const q = z * W + x;
              if (c.owner[q] !== s.id || P.usedCell[q] || P.doorFront[q] || c.keep[q] || P.solidBlock[q] || c.blocked[q]) return false;
            }
            return true;
          })();
          if (!ok) break;
          n++;
        }
        if (n === 0) { b++; continue; }
        // long rows get a gap in the middle so the aisles connect
        if (n * unit > 8) n = Math.ceil(n / 2);
        const done = itemAlongX ? tryRect(b, a, n * unit, across, n) : tryRect(a, b, across, n * unit, n);
        b += done ? n * unit + 1 : 1;
      }
    }
  } else {
    for (let z = z0; z + chZ <= z1; z += chZ + gZ) for (let x = x0; x + cwX <= x1; x += cwX + gX) tryRect(x, z, cwX, chZ, 1);
  }
  return placed;
}
