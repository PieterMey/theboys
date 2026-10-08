// Owner: env-layout (v1.2). Openable containers derived from existing furniture: a PURE filter over the layout (no
// generation change), memoised per hash. Server and clients compute the same list.
//   - hosts: kind 'prop' items whose data.prop has a CONTAINER_DEFS entry (GLB cabinet / desk / tool_chest, procedural
//     filing / morgue_drawers / counter); never in the hub, the van, the lot or the vault
//   - the walkable cell in front of the main part must be reachable around solids (validator proxy) and free of loose
//     floor props (chairs, boxes)
//   - <= 3 per room, <= 32 per site, picked with makeRng(`${seed}:${hash}`, 'containers')
// Part tables are in the client loader's recentred model frame (x/z centred on the model box, y = 0 at its bottom,
// +Z = the room-facing front), measured from .assets/build/props/*.glb (tests/level/glb-bounds.ts re-measures them).
import type { LayoutItem, LevelLayout } from '../layout.ts';
import { makeRng } from '../rng.ts';
import { buildEdgeGrid } from '../nav/grid.ts';
import { normalOfYaw, r3 } from './common.ts';
import { reachAroundSolids } from './place.ts';

export type ContainerKind = 'cabinet' | 'desk' | 'filing' | 'tool_chest' | 'morgue_drawers' | 'counter' | 'drawer_chest' | 'nightstand';
export type ContainerPartKind = 'drawer' | 'tray' | 'door' | 'lid';
export interface ContainerPart {
  /** bit index in the open mask (0..15) */
  idx: number;
  kind: ContainerPartKind;
  /** GLB node name for model-backed hosts; absent for procedural parts */
  node?: string;
  /** centre in the host's local frame = the client loader's recentred model frame (+X width, +Z room-facing front, y up).
   *  Always the CLOSED pose (see `authoredOpen` for GLB parts authored open). */
  local: [number, number, number];
  size: [number, number, number];
  /** drawer/tray: slide along local +Z (m, <= 0.45); door/lid: max hinge angle (rad) */
  travel: number;
  /** door/lid: open(t) = the closed pose rotated by sign * travel * t (rad, right-handed about +axis) around pivot (local) */
  hinge?: { axis: 'x' | 'y'; pivot: [number, number, number]; sign: 1 | -1 };
  /** world point inside the part where items lie when open */
  slot: [number, number, number];
  /** door/lid GLB part authored fully OPEN (tool_chest lid): the authored geometry is the closed pose turned by
   *  sign * travel about the hinge, so the renderer first turns it by -sign * travel (rest correction), then by
   *  sign * travel * t. Absent = authored closed. */
  authoredOpen?: boolean;
}
export interface ContainerInfo {
  /** host prop id ('prop:41'); interactable id = v12Id('container', id) */
  id: string;
  prop: string;
  kind: ContainerKind;
  space: number;
  roomType: string;
  x: number; z: number; rot: number;
  /** aim point on the front face */
  p: [number, number, number];
  /** walkable cell in front (cx, cz) */
  front: [number, number];
  parts: ContainerPart[];
  /** part a search opens; its slot holds the contents */
  main: number;
  /** loot tier hint 0..2 */
  tier: number;
}

type V3 = [number, number, number];
/** a part in local terms (slot local too); world-placed per host by containersOf */
export interface ContainerPartDef extends Omit<ContainerPart, 'slot'> { slotLocal: V3 }
export interface ContainerDef {
  kind: ContainerKind;
  /** front face z of the host (local), for the aim point */
  frontZ: number;
  main: number;
  parts: ContainerPartDef[];
}

/** a drawer / tray part (closed pose c, size s). Its slot (where searched items, origin = bottom centre, and drawer
 *  pages lie) is on the part's inner floor, `floor` m over the part's bottom (default 3 cm: the procedural filing tray
 *  floor env-world builds at the slot), halfway along the open travel past the front. */
const drawer = (idx: number, node: string | undefined, c: V3, s: V3, travel: number, kind: 'drawer' | 'tray' = 'drawer', floor = 0.03): ContainerPartDef => {
  const front = c[2] + s[2] / 2;
  return { idx, kind, ...(node ? { node } : {}), local: c, size: s, travel, slotLocal: [c[0], r3(c[1] - s[1] / 2 + floor), r3(front + travel / 2)] };
};
/** GLB drawer / tray inner floors over the part's bottom (m), measured in the loader's recentred frame from
 *  .assets/build/props/*.glb (= the staged dist): flat across each part, every part of a host within 0.5 mm, so each
 *  slot lies on its real floor to the mm (tests/world/slots.test.ts re-measures every host's main part). */
const GLB_FLOOR = { cabinet: 0.0585, deskDrawer: 0.0155, deskTray: 0.0025, drawerChest: 0.0146, nightstand: 0.0026 } as const;

/** GLB cabinet (prop.cabinet: drawer_cabinet + 4 drawers, measured; raised drawer bottoms) */
const CABINET: ContainerDef = {
  kind: 'cabinet', frontZ: 0.244, main: 1,
  parts: [1, 2, 3, 4].map((n, i) => drawer(i, `drawer_cabinet_drawer_0${n}`, [-0.002, [1.029, 0.854, 0.679, 0.504][i], 0.03], [1.034, 0.149, 0.428], 0.35, 'drawer', GLB_FLOOR.cabinet)),
};
/** GLB metal office desk (prop.desk): drawers 01-03 right pedestal (top down), 04-06 left, pencil trays 01 (left) 02 (right) */
const DESK: ContainerDef = {
  kind: 'desk', frontZ: 0.474, main: 0,
  parts: [
    drawer(0, 'metal_office_desk_drawer_01', [0.718, 0.631, 0.084], [0.411, 0.162, 0.779], 0.4, 'drawer', GLB_FLOOR.deskDrawer),
    drawer(1, 'metal_office_desk_drawer_02', [0.719, 0.468, 0.083], [0.411, 0.162, 0.779], 0.4, 'drawer', GLB_FLOOR.deskDrawer),
    drawer(2, 'metal_office_desk_drawer_03', [0.718, 0.303, 0.08], [0.411, 0.162, 0.779], 0.4, 'drawer', GLB_FLOOR.deskDrawer),
    drawer(3, 'metal_office_desk_drawer_04', [-0.718, 0.628, 0.082], [0.411, 0.162, 0.779], 0.4, 'drawer', GLB_FLOOR.deskDrawer),
    drawer(4, 'metal_office_desk_drawer_05', [-0.718, 0.465, 0.08], [0.411, 0.162, 0.779], 0.4, 'drawer', GLB_FLOOR.deskDrawer),
    drawer(5, 'metal_office_desk_drawer_06', [-0.718, 0.303, 0.08], [0.411, 0.162, 0.779], 0.4, 'drawer', GLB_FLOOR.deskDrawer),
    drawer(6, 'metal_office_desk_tray_01', [-0.718, 0.739, 0.159], [0.413, 0.023, 0.552], 0.3, 'tray', GLB_FLOOR.deskTray),
    drawer(7, 'metal_office_desk_tray_02', [0.718, 0.739, 0.156], [0.413, 0.023, 0.552], 0.3, 'tray', GLB_FLOOR.deskTray),
  ],
};
/** GLB metal tool chest (prop.tool_chest). The GLB is authored with the lid fully open (vertical at the back); the
 *  closed lid lies on the chest (y 0.348-0.426). Hinge along +X at the chest's top back edge (y 0.3505, z -0.1285):
 *  closed -> open = -90 deg about +X. The 'lid' part group = metal_tool_chest_lid + metal_tool_chest_hinge_lid.
 *  The slot lies on the lid compartment's floor: the top of the solid lower body, flat at y 0.2733 (measured). */
const TOOL_CHEST: ContainerDef = {
  kind: 'tool_chest', frontZ: 0.176, main: 0,
  parts: [{
    idx: 0, kind: 'lid', node: 'metal_tool_chest_lid', local: [0, 0.387, 0.0165], size: [0.66, 0.078, 0.313], travel: Math.PI / 2,
    hinge: { axis: 'x', pivot: [0, 0.3505, -0.1285], sign: -1 }, authoredOpen: true, slotLocal: [0, 0.273, 0.018],
  }],
};
/** STRETCH hosts (inactive until decor places prop keys 'drawer_chest' / 'nightstand'): Poly Haven GLBs, measured.
 *  vintage_wooden_drawer_01: 2 rows x 3 drawers (node numbers 01-03 top, left to right; 04-06 bottom) */
const DRAWER_CHEST: ContainerDef = {
  kind: 'drawer_chest', frontZ: 0.229, main: 1,
  parts: [[-0.277, 0.388, 0.005], [0, 0.388, 0.007], [0.276, 0.388, 0.005], [-0.277, 0.173, 0.006], [0, 0.173, 0.004], [0.276, 0.173, 0.007]]
    .map((c, i) => drawer(i, `vintage_wooden_drawer_01_drawer0${i + 1}`, c as V3, [0.255, 0.214, 0.443], 0.3, 'drawer', GLB_FLOOR.drawerChest)),
};
/** painted_wooden_nightstand: one drawer under the top */
const NIGHTSTAND: ContainerDef = {
  kind: 'nightstand', frontZ: 0.254, main: 0,
  parts: [drawer(0, 'painted_wooden_nightstand_drawer', [0.002, 0.515, 0.042], [0.343, 0.095, 0.424], 0.3, 'drawer', GLB_FLOOR.nightstand)],
};
/** procedural filing cabinet (client setpieces.ts FILING_DRAWER: centres y 0.17 + k * 0.32, 0.29 tall): 4 drawers */
export const FILING_DRAWER = { y0: 0.17, pitch: 0.32, h: 0.29 } as const;
function filingDef(w: number, d: number): ContainerDef {
  const depth = Math.min(d - 0.06, 0.56), front = d / 2 + 0.02;
  return {
    kind: 'filing', frontZ: front, main: 2,
    parts: [0, 1, 2, 3].map((k) => drawer(k, undefined, [0, r3(FILING_DRAWER.y0 + k * FILING_DRAWER.pitch), r3(front - depth / 2)], [r3(w - 0.04), FILING_DRAWER.h, r3(depth)], 0.4)),
  };
}
/** procedural morgue drawers (setpieces.ts: 3 x 3 doors w/3 - 0.06 wide, 0.5 tall, centres y 0.42 + r * 0.6), idx r*3+c */
function morgueDef(w: number, d: number): ContainerDef {
  const depth = Math.min(d - 0.06, 0.7), front = d / 2 + 0.025, pw = r3(w / 3 - 0.06);
  const parts: ContainerPartDef[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const x = r3(-w / 2 + (c + 0.5) * (w / 3)), y = r3(0.42 + r * 0.6);
    const p = drawer(r * 3 + c, undefined, [x, y, r3(front - depth / 2)], [pw, 0.5, r3(depth)], 0.45);
    p.slotLocal = [x, r3(y - 0.13), r3(front + 0.2)];
    parts.push(p);
  }
  return { kind: 'morgue_drawers', frontZ: front, main: 4, parts };
}
/** procedural counter (setpieces.ts: 3 cupboard doors w/3 - 0.06 wide, 0.6 tall at y 0.5, front z d/2 - 0.03) */
function counterDef(w: number, d: number): ContainerDef {
  const pw = r3(w / 3 - 0.06), z = r3(d / 2 - 0.03);
  const parts: ContainerPartDef[] = [0, 1, 2].map((k) => {
    const x = r3(-w / 3 + k * (w / 3));
    return {
      idx: k, kind: 'door' as const, local: [x, 0.5, z] as V3, size: [pw, 0.6, 0.012] as V3, travel: 1.75,
      hinge: { axis: 'y' as const, pivot: [r3(x - pw / 2), 0.5, z] as V3, sign: -1 as const }, slotLocal: [x, 0.15, r3(d / 2 - 0.25)] as V3,
    };
  });
  return { kind: 'counter', frontZ: r3(d / 2), main: 1, parts };
}

/** container definition of a host prop (null = not a container host) */
export function containerDefFor(it: Pick<LayoutItem, 'data'>): ContainerDef | null {
  const key = String(it.data?.prop ?? '');
  const w = Number(it.data?.w ?? 0), d = Number(it.data?.d ?? 0);
  switch (key) {
    case 'cabinet': return CABINET;
    case 'desk': return DESK;
    case 'tool_chest': return TOOL_CHEST;
    case 'drawer_chest': return DRAWER_CHEST;
    case 'nightstand': return NIGHTSTAND;
    case 'filing': return filingDef(w || 0.5, d || 0.62);
    case 'morgue_drawers': return morgueDef(w || 1.9, d || 0.78);
    case 'counter': return counterDef(w || 1.9, d || 0.7);
    default: return null;
  }
}
/** GLB-backed container keys and their part node names (the client keeps these nodes as separate parts) */
export const CONTAINER_NODES: Readonly<Record<string, readonly string[]>> = {
  cabinet: CABINET.parts.map((p) => p.node!),
  desk: DESK.parts.map((p) => p.node!),
  tool_chest: ['metal_tool_chest_lid', 'metal_tool_chest_hinge_lid'],
  drawer_chest: DRAWER_CHEST.parts.map((p) => p.node!),
  nightstand: NIGHTSTAND.parts.map((p) => p.node!),
};
export const CONTAINER_LIMITS = { perRoom: 3, perSite: 32, maxTravel: 0.45 } as const;
const NEVER = new Set(['van', 'lot', 'vault', 'kennel']);

/** host local -> world (quarter-turn yaws: (sin, cos) = normalOfYaw, exact) */
function toWorld(it: LayoutItem, l: V3): V3 {
  const [s, c] = normalOfYaw(it.rot ?? 0);
  return [r3(it.x + l[0] * c + l[2] * s), r3((it.y ?? 0) + l[1]), r3(it.z - l[0] * s + l[2] * c)];
}

const cache = new Map<string, readonly ContainerInfo[]>();
/** <= 3 per room, <= 32 per site; deterministic (memoised per seed + hash) */
export function containersOf(L: LevelLayout): readonly ContainerInfo[] {
  const key = `${L.seed}|${L.hash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = containersOfFresh(L);
  if (cache.size > 16) cache.clear();
  cache.set(key, out);
  return out;
}
/** containersOf without the memo (tests) */
export function containersOfFresh(L: LevelLayout): ContainerInfo[] {
  const out: ContainerInfo[] = [];
  if (L.kind === 'facility') {
    const { W, H, owner, spaces } = L;
    const g = buildEdgeGrid(L);
    const sp = L.items.find((it) => it.kind === 'spawn_player');
    const seen = reachAroundSolids(g, sp ? Math.floor(sp.z) * W + Math.floor(sp.x) : -1);
    // cells holding a loose floor prop (chairs, boxes, cans: anything non-solid standing on the floor) never count as a
    // container's front: a drawer would open into it
    const clutterCell = new Set<number>();
    for (const it of L.items) if (it.kind === 'prop' && it.data?.solid !== true && (it.y ?? 0) < 0.3 && !it.data?.station) clutterCell.add(Math.floor(it.z) * W + Math.floor(it.x));
    let maxDist = 1;
    for (const s of spaces) if (!s.open && s.type !== 'van') maxDist = Math.max(maxDist, s.dist);
    const cands: ContainerInfo[] = [];
    for (const it of L.items) {
      if (it.kind !== 'prop') continue;
      const def = containerDefFor(it);
      if (!def) continue;
      const s = spaces[it.space];
      if (!s || s.open || s.kind === 'vault' || s.kind === 'outside' || NEVER.has(s.type)) continue;
      if (Number(it.data?.n ?? 1) > 1) continue;
      const main = def.parts.find((p) => p.idx === def.main)!;
      // the first walkable cell in front of the main part (just past the front face, else one cell further): same
      // space, reachable around solids, and no chair in the way
      let fx = -1, fz = -1;
      for (const ahead of [0.05, 0.55]) {
        const fp = toWorld(it, [main.local[0], 0, def.frontZ + ahead]);
        const cx = Math.floor(fp[0]), cz = Math.floor(fp[2]);
        if (cx < 0 || cz < 0 || cx >= W || cz >= H) break;
        if (owner[cz * W + cx] === it.space && seen[cz * W + cx]) { fx = cx; fz = cz; break; }
      }
      if (fx < 0 || clutterCell.has(fz * W + fx)) continue;
      const pa = toWorld(it, [main.local[0], main.kind === 'lid' ? 0.3 : main.local[1], def.frontZ + 0.02]);
      const parts: ContainerPart[] = def.parts.map(({ slotLocal, ...p }) => ({ ...p, local: [...p.local] as V3, size: [...p.size] as V3, ...(p.hinge ? { hinge: { ...p.hinge, pivot: [...p.hinge.pivot] as V3 } } : {}), slot: toWorld(it, slotLocal) }));
      const tier = Math.max(0, Math.min(2, Math.floor((s.dist / maxDist) * 3)));
      cands.push({ id: it.id, prop: String(it.data?.prop), kind: def.kind, space: it.space, roomType: s.type, x: it.x, z: it.z, rot: it.rot ?? 0, p: pa, front: [fx, fz], parts, main: def.main, tier });
    }
    const rng = makeRng(`${L.seed}:${L.hash}`, 'containers');
    const perRoom = new Map<number, number>();
    const picked = new Set<string>();
    for (const c of rng.shuffle(cands.slice())) {
      if (picked.size >= CONTAINER_LIMITS.perSite) break;
      const n = perRoom.get(c.space) ?? 0;
      if (n >= CONTAINER_LIMITS.perRoom) continue;
      perRoom.set(c.space, n + 1);
      picked.add(c.id);
    }
    for (const c of cands) if (picked.has(c.id)) out.push(c);
  }
  return out;
}
export function containerById(L: LevelLayout, id: string): ContainerInfo | null {
  return containersOf(L).find((c) => c.id === id) ?? null;
}
