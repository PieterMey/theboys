// Owner: track (b) Interaction. Camera-ray targeting against interactable proxies (spheres; doors = boxes on their
// wall edge), line of sight over the shared edge grid (closed doors block), then a short proximity/cone fallback.
import { buildEdgeGrid, los } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { LevelLayout, LayoutDoor } from '@dead-air/shared/layout.ts';
import { INTERACT_RADIUS } from '@dead-air/shared/interactables.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';
import type { InteractionState } from '@dead-air/shared/messages/interaction.ts';

export type V3 = [number, number, number];

export interface Candidate {
  id: string;
  kind: string;
  /** interaction point */
  p: V3;
  info: InteractableInfo | null;
  /** world item id (when kind === 'item') */
  item?: string;
}

export interface Hit {
  c: Candidate;
  /** distance along the camera ray (m) */
  t: number;
}

let gridCache: { key: string; L: LevelLayout; grid: EdgeGrid; doors: Map<number, LayoutDoor> } | null = null;

export function gridFor(L: LevelLayout | null): { grid: EdgeGrid; doors: Map<number, LayoutDoor> } | null {
  if (!L) return null;
  if (gridCache?.L === L) return gridCache; // the same layout object: no key string per frame
  const key = `${L.kind}:${L.seed}:${L.hash}`;
  if (gridCache?.key === key) { gridCache.L = L; return gridCache; }
  try {
    gridCache = { key, L, grid: buildEdgeGrid(L), doors: new Map(L.doors.map((d) => [d.id, d])) };
  } catch {
    gridCache = null;
  }
  return gridCache;
}

function raySphere(o: V3, d: V3, c: V3, r: number): number | null {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  const t2 = -b + s;
  return t2 >= 0 ? 0 : null;
}

function rayBox(o: V3, d: V3, mn: V3, mx: V3): number | null {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
      continue;
    }
    let a = (mn[i] - o[i]) / d[i], b = (mx[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

/** kinds whose prop is a tall stack: the ray is tested against spheres stacked up to ~1.7 m */
const TALL_KINDS = new Set(['shop']);

export interface PickOpts {
  st: InteractionState;
  layout: LevelLayout | null;
  me: string | null;
  origin: V3;
  dir: V3;
  /** max ray distance from the camera (m) */
  reach: number;
  /** ids to skip */
  skip?: (c: Candidate) => boolean;
  /** the state's patch counter: with it the candidate list is rebuilt only when the state (or me) changed */
  version?: number;
}

let candCache: { st: InteractionState; me: string | null; version: number; list: Candidate[] } | null = null;
function candidatesFor(o: PickOpts): Candidate[] {
  if (o.version === undefined) return candidates(o.st, o.me);
  const c = candCache;
  if (c && c.st === o.st && c.me === o.me && c.version === o.version) return c.list;
  const list = candidates(o.st, o.me);
  candCache = { st: o.st, me: o.me, version: o.version, list };
  return list;
}

export function candidates(st: InteractionState, me: string | null): Candidate[] {
  const out: Candidate[] = [];
  for (const info of Object.values(st.ints)) {
    if (info.kind === 'body' && info.ref === me) continue;
    out.push({ id: info.id, kind: info.kind, p: info.p, info });
  }
  for (const it of Object.values(st.items)) {
    if (it.where !== 'world' || !it.p) continue;
    out.push({ id: it.id, kind: 'item', p: [it.p[0], Math.max(0.12, it.p[1] + 0.1), it.p[2]], info: null, item: it.id });
  }
  return out;
}

export function pick(o: PickOpts): Hit | null {
  const g = gridFor(o.layout);
  const doorOpen = (id: number) => !!o.st.doors[id]?.open;
  const losOk = (tx: number, tz: number): boolean => {
    if (!g) return true;
    const ax = o.origin[0], az = o.origin[2];
    if (Math.floor(ax) === Math.floor(tx) && Math.floor(az) === Math.floor(tz)) return true;
    return los(g.grid, ax, az, tx, tz, doorOpen);
  };
  let best: Hit | null = null;
  let bestOn: Hit | null = null;
  const all = candidatesFor(o);
  for (const c of all) {
    if (o.skip?.(c)) continue;
    const dx = c.p[0] - o.origin[0], dz = c.p[2] - o.origin[2];
    if (dx * dx + dz * dz > (o.reach + 1.6) ** 2) continue;
    let t: number | null = null;
    let tx = c.p[0], tz = c.p[2];
    if (c.kind === 'door' && g && c.info) {
      const d = g.doors.get(Number(c.info.ref));
      if (!d) continue;
      const th = 0.12;
      const mn: V3 = d.dir === 'v' ? [d.x - th, 0, d.y] : [d.x, 0, d.y - th];
      const mx: V3 = d.dir === 'v' ? [d.x + th, 2.15, d.y + d.len] : [d.x + d.len, 2.15, d.y + th];
      t = rayBox(o.origin, o.dir, mn, mx);
      if (t !== null) {
        const hx = o.origin[0] + o.dir[0] * t, hz = o.origin[2] + o.dir[2] * t;
        // nudge to the camera side of the door edge for the LOS test
        tx = d.dir === 'v' ? hx + Math.sign(o.origin[0] - d.x) * 0.25 : hx;
        tz = d.dir === 'h' ? hz + Math.sign(o.origin[2] - d.y) * 0.25 : hz;
      }
    } else {
      const r = (c.info?.r ?? INTERACT_RADIUS[c.kind] ?? 0.3) * 1.25;
      t = raySphere(o.origin, o.dir, c.p, r);
      if (TALL_KINDS.has(c.kind)) {
        // stacked props (store crates): the whole stack up to ~1.7 m is the target, not just the bottom crate
        for (let y = c.p[1] + 0.45; y <= Math.max(c.p[1], 1.7) + 1e-6; y += 0.45) {
          const ty = raySphere(o.origin, o.dir, [c.p[0], y, c.p[2]], r);
          if (ty !== null && (t === null || ty < t)) t = ty;
        }
      }
      if (t !== null) {
        // test LOS to a point slightly in front of the target (wall-mounted things sit on the wall line)
        const back = Math.min(0.3, t);
        tx = c.p[0] - o.dir[0] * back;
        tz = c.p[2] - o.dir[2] * back;
      }
    }
    if (t === null || t > o.reach) continue;
    if (!losOk(tx, tz)) continue;
    if (!best || t < best.t) best = { c, t };
    // an enabled target on the ray wins over a disabled one (a badge beside its body, a dropped Core by a spent breaker)
    if (c.info?.enabled !== false && (!bestOn || t < bestOn.t)) bestOn = { c, t };
  }
  if (bestOn) return bestOn;
  if (best) return best;
  // fallback: something right in front of us (within ~1.3 m, < 28 deg off the view direction, horizontal)
  const hl = Math.hypot(o.dir[0], o.dir[2]) || 1;
  const fx = o.dir[0] / hl, fz = o.dir[2] / hl;
  let bestScore = Infinity;
  let fb: Hit | null = null;
  for (const c of all) {
    if (o.skip?.(c) || c.kind === 'door') continue;
    const dx = c.p[0] - o.origin[0], dz = c.p[2] - o.origin[2];
    const d = Math.hypot(dx, dz);
    if (d > 1.3 || d < 0.05) continue;
    const cos = (dx * fx + dz * fz) / d;
    if (cos < 0.88) continue;
    if (!losOk(c.p[0], c.p[2])) continue;
    const score = d * (2 - cos);
    if (score < bestScore) { bestScore = score; fb = { c, t: d }; }
  }
  return fb;
}
