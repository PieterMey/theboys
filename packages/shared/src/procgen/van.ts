// Owned by track ② Level. The crew van, grid-aligned so the edge grid gives it real walls:
//   cargo area (the sealed "cab" where the crew sits): VAN_CARGO_W x VAN_CARGO_L cells, its own space (type 'van'),
//   rear opening (an 'open' doorway) on the -Z side, driver cab VAN_CAB_L cells of solid (-1) on the +Z side.
// van.yaw = 0 means the van's nose points +Z (away from the facility); players board from the rear (-Z).
import type { LevelLayout, Rect, VanInfo } from '../layout.ts';
import type { AddItem } from './common.ts';
import { normalOfYaw, r3 } from './common.ts';
import { HALF_T } from './place.ts';

export const VAN_CARGO_W = 2;
/** v1.2: 4 m cargo bay (stations along the side walls); v1.1 was 3 */
export const VAN_CARGO_L = 4;
export const VAN_CAB_L = 2;
export const VAN_LEN = VAN_CARGO_L + VAN_CAB_L;

/** Stamp the van into the owner grid. (x0, y0) = first cargo cell; the rear opening is the edge on line y0. */
export function stampVan(owner: Int32Array | number[], W: number, x0: number, y0: number, vanSpace: number): VanInfo {
  for (let y = y0; y < y0 + VAN_CARGO_L; y++) for (let x = x0; x < x0 + VAN_CARGO_W; x++) owner[y * W + x] = vanSpace;
  for (let y = y0 + VAN_CARGO_L; y < y0 + VAN_LEN; y++) for (let x = x0; x < x0 + VAN_CARGO_W; x++) owner[y * W + x] = -1;
  const cab: Rect = { x: x0, y: y0, w: VAN_CARGO_W, h: VAN_CARGO_L };
  return { x: x0 + VAN_CARGO_W / 2, z: y0 + VAN_LEN / 2, yaw: 0, cab };
}

/** Console (front wall of the cargo area, facing the rear), leave lever (left wall), deposit (just inside the rear). */
export function addVanItems(van: VanInfo, vanSpace: number, add: AddItem): void {
  const c = van.cab;
  add('console', vanSpace, c.x + c.w / 2, c.y + c.h - HALF_T - 0.275, { rot: Math.PI, y: 0, data: { w: 1.7, d: 0.55 } });
  add('leave_lever', vanSpace, c.x + HALF_T + 0.1, c.y + 1.75, { rot: Math.PI / 2, y: 1.15 });
  add('deposit', vanSpace, c.x + c.w / 2, c.y + 0.75, { y: 0, data: { r: 0.9 } });
}

/**
 * 6 player spawns in two rows of three behind the rear doors, facing `yaw` (default: toward the facility, -Z).
 * opts.lookAt turns every spawn toward that point (the facility entrance door / the open van), so the first view is
 * never a blank wall; opts.spacing spreads the columns (hub: off the van's side-wall lines).
 */
export function addVanSpawns(van: VanInfo, lotSpace: number, add: AddItem, yaw = Math.PI, opts: { lookAt?: { x: number; z: number }; spacing?: number } = {}): void {
  const c = van.cab;
  const sp = opts.spacing ?? 1.2;
  for (let r = 0; r < 2; r++) for (let i = 0; i < 3; i++) {
    const x = c.x + c.w / 2 + (i - 1) * sp, z = c.y - 1.4 - r * 1.1;
    const la = opts.lookAt;
    const rot = la ? Math.round(Math.atan2(la.x - x, la.z - z) * 1e4) / 1e4 : yaw;
    add('spawn_player', lotSpace, x, z, { rot, data: { idx: r * 3 + i } });
  }
}

/** Stations: built-in items console | leave_lever | deposit | mirror, or kind 'prop' with data.station = StationKind
 *  (data.prop van_workbench | van_stash | van_shelf | van_charger | van_mirror | noticeboard). Van wall solids <= 0.30 m deep. */
export type StationKind = 'console' | 'leave_lever' | 'deposit' | 'workbench' | 'stash' | 'booklet' | 'mirror' | 'charger' | 'records';
export interface Station {
  kind: StationKind;
  /** layout item id ('console:0', 'mirror:0', 'prop:57'); 'virtual:<kind>' for a virtual station */
  itemId: string;
  space: number;
  /** item position (mount point y for wall pieces), world m */
  x: number; y: number; z: number;
  /** front faces normalOfYaw(rot) */
  rot: number;
  w: number; d: number; h: number;
  /** interaction aim point and targeting radius */
  p: [number, number, number];
  r: number;
  /** true = synthesized at env-layout's planned spot because the layout has no such station yet (layouts from before
   *  gate L1, plan check #16). No layout item, never solid, never drawn; gameplay may register on it like a real one. */
  virtual?: boolean;
}
const STATION_DIMS: Readonly<Record<StationKind, { w: number; d: number; h: number; py: number; front: number; r: number }>> = {
  console: { w: 1.7, d: 0.55, h: 1.1, py: 0.95, front: 0, r: 0.7 },
  leave_lever: { w: 0.2, d: 0.15, h: 0.4, py: 1.15, front: 0, r: 0.3 },
  deposit: { w: 0.9, d: 0.6, h: 0.4, py: 0.4, front: 0, r: 0.9 },
  workbench: { w: 1.3, d: 0.3, h: 0.92, py: 0.95, front: 0.32, r: 0.45 },
  stash: { w: 0.6, d: 0.3, h: 1.9, py: 1.0, front: 0.25, r: 0.45 },
  booklet: { w: 1.0, d: 0.22, h: 0.35, py: 1.85, front: 0.15, r: 0.35 },
  mirror: { w: 0.45, d: 0.03, h: 0.9, py: 1.5, front: 0.1, r: 0.45 },
  charger: { w: 0.4, d: 0.15, h: 0.3, py: 1.1, front: 0.12, r: 0.3 },
  records: { w: 1.2, d: 0.04, h: 0.8, py: 1.55, front: 0.1, r: 0.6 },
};
const BUILTIN_STATION: Readonly<Record<string, StationKind>> = { console: 'console', leave_lever: 'leave_lever', deposit: 'deposit', mirror: 'mirror' };
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
type StationSpot = { kind: StationKind; x: number; y: number; z: number; rot: number };
/** env-layout's planned v1.2 van stations (gate L1: addVanStations), relative to the cab rect c (c.w = VAN_CARGO_W = 2):
 *  workbench + shelf + charger on the right (+X) wall facing in, stash + mirror on the left wall. Hub mirror: the kind
 *  'mirror' item (moved to the mirror spot at L1). The real props must use these spots (plan check #16). */
export function plannedVanStations(c: Rect): StationSpot[] {
  const right = c.x + c.w - HALF_T, left = c.x + HALF_T;
  return [
    { kind: 'workbench', x: r3(right - 0.15), y: 0, z: r3(c.y + 2.2), rot: -Math.PI / 2 },
    { kind: 'stash', x: r3(left + 0.15), y: 0, z: r3(c.y + 2.85), rot: Math.PI / 2 },
    { kind: 'booklet', x: r3(right - 0.11), y: 1.8, z: r3(c.y + 2.2), rot: -Math.PI / 2 },
    { kind: 'charger', x: r3(right - 0.075), y: 1.1, z: r3(c.y + 1.0), rot: -Math.PI / 2 },
    { kind: 'mirror', x: r3(left + 0.015), y: 1.5, z: r3(c.y + 0.95), rot: Math.PI / 2 },
  ];
}
/** hub records board (personnel file): on the facade 2 m right of the entrance door prop (centre), facing the lot */
export function plannedRecordsBoard(entrance: { x: number; z: number }): StationSpot {
  return { kind: 'records', x: r3(entrance.x + 2), y: 1.55, z: r3(entrance.z), rot: 0 };
}

/** layout data of each v1.2 van station prop (kind 'prop', data.station); wall solids <= 0.30 m deep */
export const VAN_STATION_PROPS: Readonly<Record<'workbench' | 'stash' | 'booklet' | 'charger' | 'mirror', Record<string, number | string | boolean>>> = {
  workbench: { prop: 'van_workbench', station: 'workbench', solid: true, w: 1.3, d: 0.3, h: 0.92 },
  stash: { prop: 'van_stash', station: 'stash', solid: true, w: 0.6, d: 0.3, h: 1.9 },
  booklet: { prop: 'van_shelf', station: 'booklet', solid: false, w: 1.0, d: 0.22, h: 0.35 },
  charger: { prop: 'van_charger', station: 'charger', solid: false, w: 0.4, d: 0.15, h: 0.3 },
  mirror: { prop: 'van_mirror', station: 'mirror', mirror: 'van', solid: false, w: 0.45, d: 0.03, h: 0.9 },
};
/** data of the hub's kind 'mirror' item (moved into the van at gate L1; still the 'Change your look' interactable) */
export const HUB_MIRROR_DATA: Readonly<Record<string, number | string | boolean>> = { solid: false, station: 'mirror', mirror: 'van', w: 0.45, d: 0.03, h: 0.9 };

/**
 * v1.2 van fit-out, appended at the END of generation (after the fixtures) so every v1.1 item id stays the same:
 * 2 'van' ceiling lights (the first takes the id of v1.1's single van light), an LED strip over the workbench wall, a
 * rear work flood and 2 headlights (lot space), then the station props at plannedVanStations. The hub keeps its
 * kind 'mirror' item as the van mirror (`hubMirror`), so it gets no van_mirror prop.
 */
export function addVanStations(van: VanInfo, vanSpace: number, lotSpace: number, add: AddItem, o: { hubMirror: boolean }): void {
  const c = van.cab;
  const right = c.x + c.w - HALF_T;
  add('light', vanSpace, c.x + c.w / 2, c.y + 1.2, { y: 2.05, data: { state: 'on', kind: 'van' } });
  add('light', vanSpace, c.x + c.w / 2, c.y + 3.0, { y: 2.05, data: { state: 'on', kind: 'van' } });
  add('light', vanSpace, right - 0.04, c.y + 2.0, { y: 2.08, rot: -Math.PI / 2, data: { state: 'on', kind: 'led_strip', len: 3.0 } });
  add('light', lotSpace, c.x + c.w / 2, c.y - 0.06, { y: 2.3, rot: Math.PI, data: { state: 'on', kind: 'flood' } });
  for (const hx of [c.x + 0.3, c.x + c.w - 0.3]) add('light', lotSpace, hx, c.y + VAN_LEN + 0.05, { y: 0.8, rot: 0, data: { state: 'on', kind: 'headlight' } });
  for (const s of plannedVanStations(c)) {
    if (s.kind === 'mirror' && o.hubMirror) continue;
    const data = VAN_STATION_PROPS[s.kind as keyof typeof VAN_STATION_PROPS];
    if (data) add('prop', vanSpace, s.x, s.z, { y: s.y, rot: s.rot, data: { ...data } });
  }
}
function stationAt(kind: StationKind, itemId: string, space: number, x: number, y: number, z: number, rot: number, data?: Record<string, unknown>): Station {
  const dim = STATION_DIMS[kind];
  const [nx, nz] = normalOfYaw(rot);
  return {
    kind, itemId, space, x, y, z, rot,
    w: num(data?.w, dim.w), d: num(data?.d, dim.d), h: num(data?.h, dim.h),
    p: [x + nx * dim.front, dim.py, z + nz * dim.front], r: dim.r,
  };
}
/** every station in item order, then virtual ones for v1.2 stations the layout lacks (pure: server and clients agree).
 *  Pass the whole layout: van and kind drive the virtual stations. */
export function stationsOf(L: Pick<LevelLayout, 'items'> & Partial<Pick<LevelLayout, 'kind' | 'van'>>): Station[] {
  const out: Station[] = [];
  for (const it of L.items) {
    const dk = it.kind === 'prop' ? it.data?.station : undefined;
    const kind: StationKind | undefined = typeof dk === 'string' && dk in STATION_DIMS ? (dk as StationKind) : BUILTIN_STATION[it.kind];
    if (!kind) continue;
    out.push(stationAt(kind, it.id, it.space, it.x, it.y ?? 0, it.z, it.rot ?? 0, it.data));
  }
  const have = new Set(out.map((s) => s.kind));
  const vanSpace = L.items.find((it) => it.kind === 'console')?.space;
  const spots: (StationSpot & { space: number })[] = [];
  if (L.van && vanSpace !== undefined) for (const s of plannedVanStations(L.van.cab)) spots.push({ ...s, space: vanSpace });
  const door = L.kind === 'hub' ? L.items.find((it) => it.kind === 'prop' && it.data?.prop === 'entrance_door') : undefined;
  if (door) spots.push({ ...plannedRecordsBoard(door), space: door.space });
  for (const s of spots) {
    if (have.has(s.kind)) continue;
    have.add(s.kind);
    out.push({ ...stationAt(s.kind, `virtual:${s.kind}`, s.space, s.x, s.y, s.z, s.rot), virtual: true });
  }
  return out;
}
export function stationOf(L: Pick<LevelLayout, 'items'> & Partial<Pick<LevelLayout, 'kind' | 'van'>>, kind: StationKind): Station | null {
  return stationsOf(L).find((s) => s.kind === kind) ?? null;
}
