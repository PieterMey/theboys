// Owned by track ② Level. The hub: a fixed night-time parking lot in front of a facility facade, with the crew van,
// a fenced training kennel (chained Hound), the locker mirror, the work-order board and the shop.
import { GEN_VERSION } from '../layout.ts';
import type { LayoutDoor, LayoutSpace, LevelLayout } from '../layout.ts';
import { WORLD } from '../constants.ts';
import { ALL_OPEN, buildEdgeGrid } from '../nav/grid.ts';
import { floodCells } from '../nav/path.ts';
import { layoutHash } from './hash.ts';
import { ItemList, centreCell, r1 } from './common.ts';
import { VAN_CARGO_W, addVanItems, addVanSpawns, stampVan } from './van.ts';
import { HALF_T } from './place.ts';
import { PROP_DEFS } from './decor.ts';

export const HUB = {
  W: 30,
  H: 24,
  /** building depth (solid cells) behind the facade line */
  buildingDepth: 4,
  van: { x0: 14, y0: 10 },
  kennel: { x: 3, y: 14, w: 6, h: 4 },
  entranceX: 8,
} as const;

export function generateHub(): LevelLayout {
  const { W, H, buildingDepth: BD } = HUB;
  const owner = new Int32Array(W * H).fill(-1);
  const spaces: LayoutSpace[] = [];
  const add = (s: Omit<LayoutSpace, 'id'>) => {
    const id = spaces.length;
    spaces.push({ id, ...s });
    const r = s.rect;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) owner[y * W + x] = id;
    return id;
  };
  const lot = add({ kind: 'outside', rect: { x: 0, y: BD, w: W, h: H - BD }, zone: 0, type: 'lot', callsign: null, dist: 0, light: 'on', open: true, powerZone: 0 });
  const k = HUB.kennel;
  const kennel = add({ kind: 'outside', rect: { x: k.x, y: k.y, w: k.w, h: k.h }, zone: 0, type: 'kennel', callsign: null, dist: 0, light: 'on', open: true, powerZone: 0 });
  const vanId = spaces.length;
  const van = stampVan(owner, W, HUB.van.x0, HUB.van.y0, vanId);
  spaces.push({ id: vanId, kind: 'room', rect: { ...van.cab }, zone: 0, type: 'van', callsign: 'VAN', dist: 0, light: 'on', open: false, powerZone: 0 });
  const doors: LayoutDoor[] = [
    { id: 0, a: lot, b: vanId, x: HUB.van.x0, y: HUB.van.y0, dir: 'h', len: VAN_CARGO_W, kind: 'open', lock: 0, initiallyOpen: true },
  ];

  const items = new ItemList();
  const a = items.add;
  addVanItems(van, vanId, a);
  addVanSpawns(van, lot, a, 0);
  // facility facade with its (closed, decorative) entrance in the hub
  a('prop', lot, HUB.entranceX + 1, BD + HALF_T + 0.02, { y: 0, rot: 0, data: { prop: 'entrance_door', w: 2, closed: true } });
  // training kennel: interaction point at the front fence, chained hound inside
  a('kennel', lot, k.x + k.w / 2, k.y - 0.6, { y: 0, rot: Math.PI, data: { pen: kennel, w: k.w, h: k.h, fenceZ: k.y } });
  a('spawn_hound', kennel, k.x + k.w / 2, k.y + k.h / 2 + 0.5, { rot: Math.PI, data: { order: 0, chained: true } });
  // locker mirror left of the van, board on the van's right flank, shop crate beside it
  a('mirror', lot, HUB.van.x0 - 1.0, HUB.van.y0 + 1.2, { y: 0, rot: -Math.PI / 2 });
  a('board', lot, HUB.van.x0 + VAN_CARGO_W + 0.12 + 0.15, HUB.van.y0 + 1.6, { y: 0, rot: Math.PI / 2 });
  a('shop', lot, HUB.van.x0 + VAN_CARGO_W + 1.4, HUB.van.y0 + 3.9, { y: 0, rot: Math.PI / 2 });
  // set dressing: dumpster against the facade, barrels + a jerrycan by the shop
  const prop = (key: string, x: number, z: number, rot: number) => {
    const d = PROP_DEFS[key];
    a('prop', lot, x, z, { y: 0, rot, data: { prop: key, solid: d.solid, w: d.w, d: d.d } });
  };
  prop('trash_can', 24, BD + HALF_T + PROP_DEFS.trash_can.d / 2 + 0.03, 0);
  prop('barrel', 19.4, 12.2, 0);
  prop('barrel', 20.1, 12.8, Math.PI / 2);
  prop('crate', 19.8, 14.3, Math.PI / 2);
  prop('jerrycan', 18.7, 12.0, 0);
  // a few dim lot lights
  a('light', lot, 5, 7.5, { y: 6, data: { state: 'flicker', kind: 'lamp' } });
  a('light', lot, 24, 9, { y: 6, data: { state: 'on', kind: 'lamp' } });
  a('light', lot, 17, H - 1.5, { y: 6, data: { state: 'on', kind: 'lamp' } });
  a('light', lot, HUB.entranceX + 1, BD + 0.2, { y: 2.75, rot: 0, data: { state: 'on', kind: 'wall' } });
  a('light', vanId, van.cab.x + van.cab.w / 2, van.cab.y + van.cab.h / 2, { y: 2.05, data: { state: 'on', kind: 'van' } });

  const g = buildEdgeGrid({ W, H, owner, spaces, doors });
  const df = floodCells(g, [centreCell(owner, W, lot, spaces[lot].rect)], { mode: 'sound', doorOpen: ALL_OPEN });
  for (const s of spaces) { const d = df[centreCell(owner, W, s.id, s.rect)]; s.dist = Number.isFinite(d) ? r1(d) : 0; }

  const L: LevelLayout = {
    genVersion: GEN_VERSION,
    kind: 'hub',
    seed: 'hub',
    hash: '',
    theme: 'hub',
    W, H,
    owner: Array.from(owner),
    spaces,
    doors,
    items: items.items,
    entrance: lot,
    van,
    zones: 1,
    wallH: WORLD.wallH,
    metrics: { lot, kennel, vanSpace: vanId, buildingDepth: BD },
  };
  L.hash = layoutHash(L);
  return L;
}
