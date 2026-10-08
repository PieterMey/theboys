// Owner: track (c) Monsters (v1.2 G2). Prop cover for the Listener's sight (flag listenerFairV12):
//  - low cover: a CROUCHED target (players' stealthStance, never the claimed pose) is unseen when a solid prop with
//    PROP_DEFS h >= lowCoverMinH (0.75: desk, counter, pew, workbench, bed, altar, barrel... never a crate, bench,
//    generator or tool chest) crosses the sight segment within lowCoverRangeM (2.5 m) of the target;
//  - taller props (h > lowCoverMaxH 1.25: filing, cabinets, shelves, racks, tanks) hide a crouched target anywhere along
//    the segment (plan check #10: no maximum height), and h >= tallCoverMinH (1.7) hides a standing target too.
// Boxes are cached per layout (seed + hash); only targets that already passed range, cone and wall LOS are tested.
import { PROP_DEFS } from '@dead-air/shared/procgen/decor.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { num } from './types.ts';
import type { Bal } from './types.ts';

export interface CoverBoxes {
  key: string;
  n: number;
  /** x0, z0, x1, z1, h per solid prop (axis-aligned: generated props are rotated by multiples of 90 deg) */
  b: Float32Array;
}

const cache = new Map<string, CoverBoxes>();

/** height of a prop item: data.h if given, else PROP_DEFS[data.prop].h, else NaN (unknown: never cover) */
function propHeight(data: Record<string, unknown> | undefined): number {
  const h = Number(data?.h);
  if (Number.isFinite(h) && h > 0) return h;
  const key = typeof data?.prop === 'string' ? data.prop : '';
  return PROP_DEFS[key]?.h ?? NaN;
}

export function coverBoxes(L: LevelLayout): CoverBoxes {
  const key = `${L.kind}:${L.seed}:${L.hash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out: number[] = [];
  for (const it of L.items) {
    if (it.kind !== 'prop' || it.data?.solid !== true) continue;
    const h = propHeight(it.data as Record<string, unknown>);
    const w = Number(it.data.w ?? 0), d = Number(it.data.d ?? 0);
    if (!(h > 0) || !(w > 0) || !(d > 0)) continue;
    const rot = it.rot ?? 0;
    const alongX = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 0;
    const hw = (alongX ? w : d) / 2, hd = (alongX ? d : w) / 2;
    out.push(it.x - hw, it.z - hd, it.x + hw, it.z + hd, h);
  }
  const boxes: CoverBoxes = { key, n: out.length / 5, b: Float32Array.from(out) };
  if (cache.size >= 8) cache.delete(cache.keys().next().value as string);
  cache.set(key, boxes);
  return boxes;
}

const inBox = (x: number, z: number, x0: number, z0: number, x1: number, z1: number) => x > x0 && x < x1 && z > z0 && z < z1;

/**
 * Slab test of the segment (ax, az) + s * (dx, dz), s in [s0, s1], against the box. True if it crosses the box.
 */
function segHits(ax: number, az: number, dx: number, dz: number, s0: number, s1: number, x0: number, z0: number, x1: number, z1: number): boolean {
  let lo = s0, hi = s1;
  if (Math.abs(dx) < 1e-9) {
    if (ax <= x0 || ax >= x1) return false;
  } else {
    let ta = (x0 - ax) / dx, tb = (x1 - ax) / dx;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    lo = Math.max(lo, ta);
    hi = Math.min(hi, tb);
    if (lo >= hi) return false;
  }
  if (Math.abs(dz) < 1e-9) {
    if (az <= z0 || az >= z1) return false;
  } else {
    let ta = (z0 - az) / dz, tb = (z1 - az) / dz;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    lo = Math.max(lo, ta);
    hi = Math.min(hi, tb);
    if (lo >= hi) return false;
  }
  return true;
}

/**
 * Does prop cover hide the target at (tx, tz) from a viewer at (vx, vz)? `crouched` = the server's stealth stance says
 * crouch. Boxes containing the viewer or the target are ignored (monsters walk through props; bots may stand in them).
 */
export function propCovers(L: LevelLayout, b: Bal, vx: number, vz: number, tx: number, tz: number, crouched: boolean): boolean {
  const minH = num(b, 'lowCoverMinH', 0.75), lowMax = num(b, 'lowCoverMaxH', 1.25);
  const range = num(b, 'lowCoverRangeM', 2.5), tallH = num(b, 'tallCoverMinH', 1.7);
  const dx = vx - tx, dz = vz - tz;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return false;
  const near = Math.min(1, range / len);
  const cb = coverBoxes(L);
  const B = cb.b;
  const mnx = Math.min(vx, tx), mxx = Math.max(vx, tx), mnz = Math.min(vz, tz), mxz = Math.max(vz, tz);
  for (let i = 0; i < cb.n; i++) {
    const o = i * 5;
    const h = B[o + 4];
    if (h < minH) continue;
    if (!crouched && h < tallH) continue;
    const x0 = B[o], z0 = B[o + 1], x1 = B[o + 2], z1 = B[o + 3];
    if (x1 < mnx || x0 > mxx || z1 < mnz || z0 > mxz) continue;
    if (inBox(vx, vz, x0, z0, x1, z1) || inBox(tx, tz, x0, z0, x1, z1)) continue;
    // low props only count close to the target (it looks down over a desk at someone further away)
    const s1 = !crouched || h > lowMax ? 1 : near;
    if (segHits(tx, tz, dx, dz, 0, s1, x0, z0, x1, z1)) return true;
  }
  return false;
}

/** test/debug: the cover boxes near (x, z) with their heights */
export function coverNear(L: LevelLayout, x: number, z: number, r: number): { x0: number; z0: number; x1: number; z1: number; h: number }[] {
  const cb = coverBoxes(L);
  const out: { x0: number; z0: number; x1: number; z1: number; h: number }[] = [];
  for (let i = 0; i < cb.n; i++) {
    const o = i * 5;
    const cx = (cb.b[o] + cb.b[o + 2]) / 2, cz = (cb.b[o + 1] + cb.b[o + 3]) / 2;
    if (Math.hypot(cx - x, cz - z) <= r) out.push({ x0: cb.b[o], z0: cb.b[o + 1], x1: cb.b[o + 2], z1: cb.b[o + 3], h: cb.b[o + 4] });
  }
  return out;
}
