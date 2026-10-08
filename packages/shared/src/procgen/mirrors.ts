// Owner: env-layout (v1.2). Van mirror (hub kind 'mirror' item / facility prop van_mirror) + decorative mirrors
// (kind 'prop' with data.mirror). mirrorsOf is a pure derivation from the items (server and clients agree);
// placeMirrors is the generation step (appended after every v1.1 item, own stream 'mirrors').
import type { LayoutSpace, LevelLayout } from '../layout.ts';
import type { Rng } from '../rng.ts';
import type { ItemList } from './common.ts';
import { rcx, rcy } from './common.ts';
import type { Placer, WallSlot } from './place.ts';

export type MirrorKind = 'strip' | 'hand' | 'hall' | 'dressing' | 'van';
export interface MirrorSpot {
  id: string;
  kind: MirrorKind;
  space: number;
  /** glass centre (y = mount height) */
  x: number; y: number; z: number;
  /** glass faces normalOfYaw(rot) */
  rot: number;
  w: number; h: number;
}
export const MIRROR_DIMS: Readonly<Record<MirrorKind, { w: number; h: number; y: number }>> = {
  strip: { w: 1.6, h: 0.7, y: 1.55 }, hand: { w: 0.45, h: 0.6, y: 1.5 }, hall: { w: 0.8, h: 1.4, y: 1.45 },
  dressing: { w: 0.8, h: 1.0, y: 1.5 }, van: { w: 0.45, h: 0.9, y: 1.5 },
};
/** frame depth of a decorative mirror (m) */
export const MIRROR_DEPTH = 0.04;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export function mirrorsOf(L: Pick<LevelLayout, 'items'>): MirrorSpot[] {
  const out: MirrorSpot[] = [];
  for (const it of L.items) {
    const dk = it.data?.mirror;
    const kind: MirrorKind | null = typeof dk === 'string' && dk in MIRROR_DIMS ? (dk as MirrorKind) : it.kind === 'mirror' ? 'van' : null;
    if (!kind) continue;
    const dim = MIRROR_DIMS[kind];
    out.push({ id: it.id, kind, space: it.space, x: it.x, y: it.y || dim.y, z: it.z, rot: it.rot ?? 0, w: num(it.data?.w, dim.w), h: num(it.data?.h, dim.h) });
  }
  return out;
}

/** decorative mirror kind by room type: sink strips in washrooms, hand mirrors on the wards, hall mirror in the lobby,
 *  a dressing mirror in the gallery */
export const MIRROR_ROOMS: Readonly<Record<string, Exclude<MirrorKind, 'van'>>> = {
  showers: 'strip', laundry: 'strip', infirmary: 'hand', nursery: 'hand', lobby: 'hall', gallery: 'dressing',
};

/** a wall slot whose floor cell stays free (the player stands in front); strips span two slots along the wall */
function mirrorSlots(P: Placer, sid: number, kind: Exclude<MirrorKind, 'van'>, reach: Uint8Array): [WallSlot, WallSlot | null][] {
  const W = P.g.W;
  const out: [WallSlot, WallSlot | null][] = [];
  for (const s of P.freeSlots(sid)) {
    if (P.usedCell[s.cell] || !reach[s.cell]) continue;
    if (kind !== 'strip') { out.push([s, null]); continue; }
    const cx = s.cx - s.nz, cy = s.cy + s.nx;
    if (cx < 0 || cy < 0 || cx >= W || cy >= P.g.H) continue;
    const s2 = P.slotByKey.get((cy * W + cx) * 4 + s.side);
    if (!s2 || P.g.owner[s2.cell] !== sid || P.usedSlot[s2.key] || P.usedCell[s2.cell] || !reach[s2.cell] || P.doorFront[s2.cell] || s2.jamb) continue;
    out.push([s, s2]);
  }
  return out;
}

/**
 * 2-4 decorative mirrors per facility, guaranteed >= 2: typed rooms first (MIRROR_ROOMS, shuffled), then the
 * lobby, an office, the showers, then any room (hand mirror). <= 1 per room; the floor cell in front is free and
 * reachable around solids (o.reach, reachAroundSolids from the crew spawn).
 * Returns the number placed.
 */
export function placeMirrors(spaces: readonly LayoutSpace[], P: Placer, items: ItemList, rng: Rng, o: { exclude: ReadonlySet<number>; reach: Uint8Array; kindFor?: (s: LayoutSpace) => Exclude<MirrorKind, 'van'> | undefined }): number {
  const want = rng.int(2, 4);
  const roomLike = (s: LayoutSpace) => (s.kind === 'room' || s.kind === 'hall') && !o.exclude.has(s.id) && s.type !== 'van';
  const kindFor = (s: LayoutSpace) => o.kindFor?.(s) ?? MIRROR_ROOMS[s.type];
  const used = new Set<number>();
  let placed = 0;
  const tryRoom = (s: LayoutSpace, kind: Exclude<MirrorKind, 'van'>): boolean => {
    if (used.has(s.id)) return false;
    const cands = mirrorSlots(P, s.id, kind, o.reach);
    if (!cands.length) return false;
    // near the middle of its wall (a mirror hung on purpose, not squeezed into a corner), randomised within ~1.5 m
    const cx = rcx(s.rect), cz = rcy(s.rect);
    let best = cands[0];
    let bs = -Infinity;
    for (const c of cands) {
      const [a, b] = c;
      const mx = b ? (a.lx + b.lx) / 2 : a.lx, mz = b ? (a.lz + b.lz) / 2 : a.lz;
      const sc = -(Math.abs(mz - cz) * Math.abs(a.nx) + Math.abs(mx - cx) * Math.abs(a.nz)) + rng.next() * 1.5;
      if (sc > bs) { bs = sc; best = c; }
    }
    const [a, b] = best;
    P.take(a);
    if (b) P.take(b);
    const dim = MIRROR_DIMS[kind];
    const off = P.mount(a, MIRROR_DEPTH);
    const x = b ? (off.x + P.mount(b, MIRROR_DEPTH).x) / 2 : off.x, z = b ? (off.z + P.mount(b, MIRROR_DEPTH).z) / 2 : off.z;
    items.add('prop', s.id, x, z, { y: dim.y, rot: off.rot, data: { prop: `mirror_${kind}`, mirror: kind, solid: false, w: dim.w, d: MIRROR_DEPTH, h: dim.h } });
    used.add(s.id);
    placed++;
    return true;
  };
  for (const s of rng.shuffle(spaces.filter((s) => roomLike(s) && kindFor(s) !== undefined))) {
    if (placed >= want) break;
    tryRoom(s, kindFor(s)!);
  }
  if (placed < 2) {
    const fall: [LayoutSpace, Exclude<MirrorKind, 'van'>][] = [];
    for (const s of spaces) if (roomLike(s) && s.type === 'lobby') fall.push([s, 'hall']);
    for (const s of spaces) if (roomLike(s) && s.type === 'office') fall.push([s, 'hand']);
    for (const s of spaces) if (roomLike(s) && s.type === 'showers') fall.push([s, 'hand']);
    for (const s of spaces) if (roomLike(s) && s.type !== 'lobby' && s.type !== 'office' && s.type !== 'showers') fall.push([s, 'hand']);
    for (const [s, k] of fall) {
      if (placed >= 2) break;
      tryRoom(s, k);
    }
  }
  return placed;
}
