// Owned by track ② Level. Cosmetic clutter for a finished layout: paper, small boxes, bottles, debris, fallen ceiling
// tiles + hanging cables, puddles, posters/signs, ceiling pipe runs in corridors, small asset props (rats, gas masks,
// crowbars, tipped chairs...). Never collides, never stored in the layout (clients derive it from the layout, so the
// wire format stays small), never on door-front cells, solids or cells players must reach. Deterministic per layout.
import type { LevelLayout } from '../layout.ts';
import { makeRng } from '../rng.ts';

export type ClutterKind =
  | 'paper' | 'box' | 'bottle' | 'debris' | 'tile' | 'cable' | 'puddle' | 'poster' | 'pipe' | 'glb' | 'stain';

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
  /** glb: tip the model onto its side */
  tip?: number;
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
  for (const s of spaces) {
    if (s.open || s.type === 'van' || s.kind === 'vault') continue;
    const r = s.rect;
    const depth = Math.min(1, s.dist / 60);
    const dark = s.light === 'off' || s.light === 'broken';
    const isCor = s.kind === 'corridor';
    const glbs = GLB_BY_TYPE[s.type] ?? ['cardboard_box'];
    const tiles = isCor || CEILING_TILE_TYPES.has(s.type);
    const wet = WET.has(s.type);
    const mess = 0.55 + depth * 0.5 + (dark ? 0.3 : 0);
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
      if (rng.chance((isCor ? 0.1 : 0.14) * mess)) out.push({ kind: 'paper', space: s.id, x: x + 0.15 + rng.next() * 0.7, y: 0.004 + rng.next() * 0.003, z: y + 0.15 + rng.next() * 0.7, rot: rng.next() * Math.PI * 2, a: rng.int(1, 3), b: rng.next() });
      if (wet && rng.chance(0.07 * mess)) out.push({ kind: 'puddle', space: s.id, x: x + 0.5, y: 0.006, z: y + 0.5, rot: rng.next() * Math.PI, a: 0.5 + rng.next() * 0.9, b: 0.4 + rng.next() * 0.6 });
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
  return out;
}
