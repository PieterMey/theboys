// Owned by track ② Level. Cosmetic clutter for a finished layout: paper, small boxes, bottles, debris, fallen ceiling
// tiles + hanging cables, puddles, posters/signs, ceiling pipe runs in corridors, small asset props (rats, gas masks,
// crowbars, tipped chairs...). Never collides, never stored in the layout (clients derive it from the layout, so the
// wire format stays small), never on door-front cells, solids or cells players must reach. Deterministic per layout.
import type { LevelLayout } from '../layout.ts';
import { makeRng } from '../rng.ts';
import type { SiteTheme } from './themes.ts';
import { themeChain } from './themes.ts';

export type ClutterKind =
  | 'paper' | 'box' | 'bottle' | 'debris' | 'tile' | 'cable' | 'puddle' | 'poster' | 'pipe' | 'glb' | 'stain' | 'decal';

export interface ClutterItem {
  kind: ClutterKind;
  space: number;
  x: number;
  y: number;
  z: number;
  /** yaw (radians) */
  rot: number;
  /** size / variant parameters (kind specific) */
  a: number;
  b: number;
  /** pipe runs: end point; glb: asset key suffix (prop.<key>) */
  x2?: number;
  z2?: number;
  key?: string;
  /** glb: tip the model onto its side; decal: 1 = on the floor (else on the wall, facing rot) */
  tip?: number;
}

/** v1.2 decal atlas cells, index = cell (the staged 'decal.atlas' + 'decal.index' of tools/assets.manifest.json
 *  decals.cells, 4 x 4, opacity in albedo alpha; keep in this order). w = suggested world width (m; height = w / aspect in
 *  decal.index). ClutterItem kind 'decal': a = cell, b = world width (m), tip 1 = flat on the floor (else on the wall,
 *  facing rot). */
export const DECAL_CELLS: readonly { name: string; kind: 'leak' | 'hand' | 'footprints' | 'stain' | 'sign' | 'tape'; surface: 'wall' | 'floor' | 'any'; w: number }[] = [
  { name: 'seep', kind: 'leak', surface: 'wall', w: 1.6 }, { name: 'drip_trail', kind: 'leak', surface: 'wall', w: 0.3 },
  { name: 'streaks_a', kind: 'leak', surface: 'wall', w: 1 }, { name: 'streaks_b', kind: 'leak', surface: 'wall', w: 1 },
  { name: 'handprint', kind: 'hand', surface: 'wall', w: 0.28 }, { name: 'smudges', kind: 'hand', surface: 'wall', w: 0.4 },
  { name: 'footprints_a', kind: 'footprints', surface: 'floor', w: 0.4 }, { name: 'footprints_b', kind: 'footprints', surface: 'floor', w: 0.4 },
  { name: 'rust_streaks', kind: 'stain', surface: 'wall', w: 1 }, { name: 'mould_streaks', kind: 'stain', surface: 'wall', w: 1 },
  { name: 'algae_streaks', kind: 'stain', surface: 'wall', w: 1 }, { name: 'faint_streaks', kind: 'stain', surface: 'wall', w: 1 },
  { name: 'sign_slippery', kind: 'sign', surface: 'wall', w: 0.42 }, { name: 'sign_temperature', kind: 'sign', surface: 'wall', w: 0.42 },
  { name: 'sign_voltage', kind: 'sign', surface: 'wall', w: 0.42 }, { name: 'hazard_tape', kind: 'tape', surface: 'any', w: 0.1 },
];
const DC = { leak: [0, 1, 2, 3], hand: [4, 5], footprints: [6, 7], rust: 8, mould: 9, algae: 10, faint: 11, slippery: 12, temperature: 13, voltage: 14, tape: 15 } as const;
const COLDISH = new Set(['cold', 'cryo']);
const ELECTRIC = new Set(['server', 'radio', 'boiler', 'furnace', 'foundry', 'pumps', 'garage']);

/** v1.2 per-theme clutter: mess offset, extra wet room types ('corridor' too), paper and puddle multipliers */
interface ClutterTheme { mess?: number; wet?: readonly string[]; paper?: number; puddle?: number }
const THEME_CLUTTER: Readonly<Partial<Record<SiteTheme, ClutterTheme>>> = {
  hospital: { mess: -0.05, wet: ['infirmary'] },
  waterworks: { mess: 0.15, wet: ['corridor', 'storage', 'garage', 'dock'], puddle: 1.3 },
  industry: { mess: 0.2, wet: ['pit'] },
  records: { mess: 0.1, paper: 1.8 },
  hospitality: { mess: -0.1, paper: 0.8 },
  cold_storage: { wet: ['dock', 'storage', 'cryo', 'corridor'], puddle: 1.2 },
  comms: { paper: 1.3 },
  transport: { mess: 0.15 },
  retail: { mess: 0.05, paper: 1.2 },
  parish: { mess: -0.05 },
  baths: { wet: ['corridor', 'office', 'storage', 'lobby', 'gallery', 'canteen'], puddle: 1.5 },
  greenhouse: { wet: ['greenhouse', 'nursery', 'corridor', 'storage'], puddle: 1.4 },
  laundry: { wet: ['corridor', 'storage'], puddle: 1.3 },
};
function clutterTheme(theme: string): { mess: number; wet: Set<string>; paper: number; puddle: number } {
  const out = { mess: 0, wet: new Set<string>(), paper: 1, puddle: 1 };
  // base of the chain first, the theme itself last (its values win)
  for (const t of themeChain(theme).reverse()) {
    const c = THEME_CLUTTER[t];
    if (!c) continue;
    if (c.mess !== undefined) out.mess = c.mess;
    if (c.paper !== undefined) out.paper = c.paper;
    if (c.puddle !== undefined) out.puddle = c.puddle;
    for (const w of c.wet ?? []) out.wet.add(w);
  }
  return out;
}

const CEILING_TILE_TYPES = new Set(['office', 'archive', 'library', 'mailroom', 'server', 'radio', 'infirmary', 'nursery', 'chapel', 'gallery', 'lobby', 'canteen', 'morgue', 'kitchen', 'laundry', 'showers', 'cold', 'cryo']);
const INDUSTRIAL = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks', 'garage', 'dock', 'pit', 'storage', 'greenhouse']);
const WET = new Set(['boiler', 'pumps', 'tanks', 'showers', 'laundry', 'kitchen', 'cold', 'morgue', 'pit', 'greenhouse']);
const GLB_BY_TYPE: Record<string, string[]> = {
  office: ['cardboard_box', 'chair', 'radio', 'flashlight'],
  archive: ['cardboard_box', 'cardboard_box', 'flashlight'],
  library: ['cardboard_box', 'chair'],
  mailroom: ['cardboard_box', 'cardboard_box', 'cardboard_box'],
  server: ['cardboard_box', 'flashlight'],
  storage: ['cardboard_box', 'jerrycan', 'crowbar', 'rat'],
  dock: ['jerrycan', 'crowbar', 'cardboard_box', 'rat'],
  garage: ['jerrycan', 'crowbar', 'gas_mask', 'flashlight'],
  boiler: ['jerrycan', 'gas_mask', 'rat', 'crowbar'],
  furnace: ['gas_mask', 'crowbar', 'jerrycan'],
  foundry: ['gas_mask', 'crowbar', 'jerrycan'],
  pumps: ['rat', 'jerrycan', 'gas_mask'],
  tanks: ['gas_mask', 'jerrycan', 'rat'],
  pit: ['rat', 'crowbar', 'cardboard_box'],
  greenhouse: ['cardboard_box', 'jerrycan'],
  infirmary: ['medical_box', 'wheelchair', 'medical_box', 'gas_mask'],
  morgue: ['medical_box', 'rat', 'gas_mask'],
  nursery: ['cardboard_box', 'chair'],
  cryo: ['gas_mask', 'medical_box'],
  cold: ['cardboard_box', 'rat'],
  showers: ['bottles', 'rat'],
  kitchen: ['bottles', 'rat', 'cardboard_box'],
  canteen: ['chair', 'bottles', 'rat'],
  laundry: ['cardboard_box', 'bottles'],
  chapel: ['chair', 'flashlight'],
  gallery: ['cardboard_box', 'chair'],
  lobby: ['chair', 'cardboard_box', 'radio'],
};

/** Cosmetic clutter for a layout (facility interiors; the hub and the lot get none). */
export function clutterFor(L: LevelLayout): ClutterItem[] {
  const out: ClutterItem[] = [];
  if (L.kind !== 'facility') return out;
  const { W, H, owner, spaces } = L;
  const rng = makeRng(`${L.seed}:${L.hash}`, 'decor:clutter');
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
  // cells to keep clear: door fronts, every item's cell (solid props: their whole box), loot/levers/...
  const busy = new Uint8Array(W * H);
  const mark = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < W && y < H) busy[y * W + x] = 1; };
  for (const d of L.doors) for (let i = 0; i < d.len; i++) {
    if (d.dir === 'v') { mark(d.x - 1, d.y + i); mark(d.x, d.y + i); } else { mark(d.x + i, d.y - 1); mark(d.x + i, d.y); }
  }
  const wallItem = new Uint8Array(W * H);
  for (const it of L.items) {
    if (it.kind === 'light' || it.kind.startsWith('spawn_')) continue;
    const isProp = it.kind === 'prop';
    if (isProp && it.data?.solid === true) {
      const q = Math.abs(Math.round((it.rot ?? 0) / (Math.PI / 2))) % 2 === 0;
      const w = Number(it.data.w ?? 0), d = Number(it.data.d ?? 0);
      const hw = (q ? w : d) / 2 + 0.15, hd = (q ? d : w) / 2 + 0.15;
      for (let z = Math.floor(it.z - hd); z <= Math.floor(it.z + hd); z++) for (let x = Math.floor(it.x - hw); x <= Math.floor(it.x + hw); x++) mark(x, z);
      continue;
    }
    const cx = Math.floor(it.x), cz = Math.floor(it.z);
    if (isProp && (it.y ?? 0) > 0.5) { if (cx >= 0 && cz >= 0 && cx < W && cz < H) wallItem[cz * W + cx] = 1; continue; }
    mark(cx, cz);
  }
  const wallH = L.wallH;
  // wall sides of a cell (toward a different owner and not a door): [nx, nz, line x/z]
  const wallSides = (x: number, y: number): [number, number][] => {
    const s = own(x, y), res: [number, number][] = [];
    if (own(x - 1, y) !== s) res.push([1, 0]);
    if (own(x + 1, y) !== s) res.push([-1, 0]);
    if (own(x, y - 1) !== s) res.push([0, 1]);
    if (own(x, y + 1) !== s) res.push([0, -1]);
    return res;
  };
  const yawOf = (nx: number, nz: number) => (nx > 0.5 ? Math.PI / 2 : nx < -0.5 ? -Math.PI / 2 : nz > 0 ? 0 : Math.PI);
  // v1.2 site theme + modifiers (theme 'facility' with no modifiers keeps every draw and probability of v1.1)
  const th = clutterTheme(L.theme);
  const damp = L.metrics?.['mod:damp'] === 1 ? 2 : 1;
  const cluttered = L.metrics?.['mod:cluttered'] === 1 ? 0.35 : 0;
  for (const s of spaces) {
    if (s.open || s.type === 'van' || s.kind === 'vault') continue;
    const r = s.rect;
    const depth = Math.min(1, s.dist / 60);
    const dark = s.light === 'off' || s.light === 'broken';
    const isCor = s.kind === 'corridor';
    const glbs = GLB_BY_TYPE[s.type] ?? ['cardboard_box'];
    const tiles = isCor || CEILING_TILE_TYPES.has(s.type);
    const wet = WET.has(s.type) || th.wet.has(isCor ? 'corridor' : s.type);
    const mess = 0.55 + depth * 0.5 + (dark ? 0.3 : 0) + th.mess + cluttered;
    let posters = isCor ? (r.w * r.h >= 12 && rng.chance(0.5) ? 1 : 0) : rng.int(0, 2);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const c = y * W + x;
      if (owner[c] !== s.id) continue;
      const sides = wallSides(x, y);
      const edge = sides.length > 0;
      // ceiling damage + hanging cables (the floor below may be busy: the tile then lands beside it)
      if (tiles && rng.chance((isCor ? 0.035 : 0.03) * mess)) {
        out.push({ kind: 'tile', space: s.id, x: x + 0.2 + rng.next() * 0.6, y: wallH, z: y + 0.2 + rng.next() * 0.6, rot: rng.next() * Math.PI, a: rng.next(), b: busy[c] ? 0 : 1 });
        if (rng.chance(0.6)) out.push({ kind: 'cable', space: s.id, x: x + 0.3 + rng.next() * 0.4, y: wallH, z: y + 0.3 + rng.next() * 0.4, rot: rng.next() * Math.PI, a: 0.5 + rng.next() * 1.0, b: rng.int(1, 3) });
      }
      if (busy[c]) continue;
      // floor litter
      if (rng.chance((isCor ? 0.1 : 0.14) * mess * th.paper)) out.push({ kind: 'paper', space: s.id, x: x + 0.15 + rng.next() * 0.7, y: 0.004 + rng.next() * 0.003, z: y + 0.15 + rng.next() * 0.7, rot: rng.next() * Math.PI * 2, a: rng.int(1, 3), b: rng.next() });
      if (wet && rng.chance(0.07 * mess * th.puddle * damp)) out.push({ kind: 'puddle', space: s.id, x: x + 0.5, y: 0.006, z: y + 0.5, rot: rng.next() * Math.PI, a: 0.5 + rng.next() * 0.9, b: 0.4 + rng.next() * 0.6 });
      else if (rng.chance(0.03 * mess)) out.push({ kind: 'stain', space: s.id, x: x + 0.5, y: 0.005, z: y + 0.5, rot: rng.next() * Math.PI, a: 0.4 + rng.next() * 0.7, b: rng.next() });
      if (!edge) continue;
      // against the walls: boxes, bottles, debris, small asset props, posters
      const [nx, nz] = sides[rng.int(0, sides.length - 1)];
      const px = x + 0.5 - nx * 0.2, pz = y + 0.5 - nz * 0.2;
      const roll = rng.next();
      if (roll < 0.07 * mess) out.push({ kind: 'debris', space: s.id, x: px, y: 0, z: pz, rot: rng.next() * Math.PI, a: rng.int(3, 7), b: rng.next() });
      else if (roll < 0.13 * mess && !isCor) out.push({ kind: 'box', space: s.id, x: px + (rng.next() - 0.5) * 0.3, y: 0, z: pz + (rng.next() - 0.5) * 0.3, rot: yawOf(nx, nz) + (rng.next() - 0.5) * 0.5, a: rng.int(1, 3), b: rng.next() });
      else if (roll < 0.17 * mess) out.push({ kind: 'bottle', space: s.id, x: px + (rng.next() - 0.5) * 0.4, y: 0, z: pz + (rng.next() - 0.5) * 0.4, rot: rng.next() * Math.PI * 2, a: rng.int(1, 4), b: rng.next() });
      else if (roll < 0.2 * mess && !isCor) {
        const key = glbs[rng.int(0, glbs.length - 1)];
        out.push({ kind: 'glb', key, space: s.id, x: x + 0.5 - nx * 0.15, y: 0, z: y + 0.5 - nz * 0.15, rot: yawOf(nx, nz) + (rng.next() - 0.5) * 1.2, a: 0, b: 0, tip: key === 'chair' && rng.chance(0.5) ? 1 : 0 });
      }
      if (posters > 0 && !wallItem[c] && rng.chance(isCor ? 0.08 : 0.06)) {
        posters--;
        out.push({ kind: 'poster', space: s.id, x: x + 0.5 - nx * 0.414, y: 1.35 + rng.next() * 0.35, z: y + 0.5 - nz * 0.414, rot: yawOf(nx, nz), a: rng.int(0, 7), b: (rng.next() - 0.5) * 0.12 });
      }
    }
    // service pipes under the ceiling: corridors (along the long axis) and industrial rooms (along a long wall)
    if (isCor ? Math.max(r.w, r.h) >= 4 && rng.chance(0.75) : INDUSTRIAL.has(s.type) && rng.chance(0.85)) {
      const alongX = r.w >= r.h;
      const n = isCor ? rng.int(1, 3) : rng.int(2, 4);
      const side = rng.chance(0.5) ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const inset = 0.22 + k * 0.17;
        const yy = wallH - 0.16 - (k % 2) * 0.12;
        const radius = k === 0 ? 0.09 : 0.05 + rng.next() * 0.03;
        if (alongX) {
          const z = side > 0 ? r.y + r.h - inset : r.y + inset;
          out.push({ kind: 'pipe', space: s.id, x: r.x + 0.08, y: yy, z, x2: r.x + r.w - 0.08, z2: z, rot: 0, a: radius, b: k });
        } else {
          const x = side > 0 ? r.x + r.w - inset : r.x + inset;
          out.push({ kind: 'pipe', space: s.id, x, y: yy, z: r.y + 0.08, x2: x, z2: r.y + r.h - 0.08, rot: 0, a: radius, b: k });
        }
      }
    }
  }
  decalsFor(L, busy, th.wet, out);
  return out;
}

/** v1.2 decals (stream 'decor:decal', appended after every other clutter item): leak streaks high on the walls of wet
 *  rooms, hand prints by doors, footprints on floors (along corridors), rust / mould / algae streaks by room, warning
 *  signs (wet floor, temperature, high voltage) where they belong, hazard tape on industrial floors. Never on door-front
 *  or busy floor cells; <= 140 per site. */
function decalsFor(L: LevelLayout, busy: Uint8Array, wetExtra: ReadonlySet<string>, out: ClutterItem[]): void {
  const { W, H, owner, spaces } = L;
  const rng = makeRng(`${L.seed}:${L.hash}`, 'decor:decal');
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
  const doorCell = new Uint8Array(W * H);
  for (const d of L.doors) for (let i = 0; i < d.len; i++) {
    const cs = d.dir === 'v' ? [[d.x - 1, d.y + i], [d.x, d.y + i]] : [[d.x + i, d.y - 1], [d.x + i, d.y]];
    for (const [x, y] of cs) if (x >= 0 && y >= 0 && x < W && y < H) doorCell[y * W + x] = 1;
  }
  const wallH = L.wallH;
  const cold = themeChain(L.theme).includes('cold_storage');
  let n = 0;
  const MAX = 140;
  const yawOfN = (nx: number, nz: number) => (nx > 0.5 ? Math.PI / 2 : nx < -0.5 ? -Math.PI / 2 : nz > 0 ? 0 : Math.PI);
  for (const s of spaces) {
    if (n >= MAX) break;
    if (s.open || s.type === 'van' || s.kind === 'vault') continue;
    const isCor = s.kind === 'corridor';
    const wet = WET.has(s.type) || wetExtra.has(isCor ? 'corridor' : s.type);
    const ind = INDUSTRIAL.has(s.type);
    const r = s.rect;
    // wall cells of this space (cell, inward normal); floor cells free of clutter-busy marks
    const walls: [number, number, number, number][] = [], floors: [number, number][] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (owner[y * W + x] !== s.id) continue;
      if (!busy[y * W + x] && !doorCell[y * W + x]) floors.push([x, y]);
      if (own(x - 1, y) !== s.id) walls.push([x, y, 1, 0]);
      if (own(x + 1, y) !== s.id) walls.push([x, y, -1, 0]);
      if (own(x, y - 1) !== s.id) walls.push([x, y, 0, 1]);
      if (own(x, y + 1) !== s.id) walls.push([x, y, 0, -1]);
    }
    if (!walls.length) continue;
    const area = r.w * r.h;
    const wallDecal = (cell: number, y0: number, y1: number, nearDoor: boolean) => {
      const pool = nearDoor ? walls.filter(([x, y]) => doorCell[y * W + x]) : walls;
      if (!pool.length || n >= MAX) return;
      const [x, y, nx, nz] = pool[rng.int(0, pool.length - 1)];
      const along = (rng.next() - 0.5) * 0.5;
      out.push({ kind: 'decal', space: s.id, x: x + 0.5 - nx * 0.416 + (nz !== 0 ? along : 0), y: y0 + rng.next() * (y1 - y0), z: y + 0.5 - nz * 0.416 + (nx !== 0 ? along : 0), rot: yawOfN(nx, nz), a: cell, b: DECAL_CELLS[cell].w * (0.85 + rng.next() * 0.3), tip: 0 });
      n++;
    };
    const floorDecal = (cell: number, rot: number) => {
      if (!floors.length || n >= MAX) return;
      const [x, y] = floors[rng.int(0, floors.length - 1)];
      out.push({ kind: 'decal', space: s.id, x: x + 0.3 + rng.next() * 0.4, y: 0.003, z: y + 0.3 + rng.next() * 0.4, rot, a: cell, b: DECAL_CELLS[cell].w * (0.85 + rng.next() * 0.3), tip: 1 });
      n++;
    };
    // along a corridor (or a room's long axis), either way, a little skew
    const axisYaw = () => (r.w >= r.h ? Math.PI / 2 : 0) + (rng.chance(0.5) ? Math.PI : 0) + (rng.next() - 0.5) * 0.4;
    if (wet) for (let i = rng.int(1, 2); i > 0; i--) wallDecal(DC.leak[rng.int(0, DC.leak.length - 1)], wallH - 0.95, wallH - 0.6, false);
    const k = isCor ? Math.min(2, Math.floor(area / 16)) : Math.min(4, 1 + Math.floor(area / 30));
    for (let i = 0; i < k; i++) {
      const roll = rng.next();
      if (roll < 0.25) wallDecal(DC.hand[rng.int(0, 1)], 0.95, 1.45, true);
      else if (roll < 0.5) floorDecal(DC.footprints[rng.int(0, 1)], axisYaw());
      else if (roll < 0.75) wallDecal(ind ? DC.rust : wet ? (rng.chance(0.5) ? DC.mould : DC.algae) : DC.faint, 1.0, 1.9, false);
      else if (ind && rng.chance(0.6)) floorDecal(DC.tape, axisYaw());
      else {
        const sign = wet ? DC.slippery : COLDISH.has(s.type) || (cold && !isCor) ? DC.temperature : ELECTRIC.has(s.type) ? DC.voltage : -1;
        if (sign >= 0) wallDecal(sign, 1.45, 1.65, false);
        else wallDecal(DC.faint, 1.0, 1.9, false);
      }
    }
  }
}
