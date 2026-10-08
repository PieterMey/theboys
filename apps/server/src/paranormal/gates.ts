// Owner: env-paranormal (v1.2). Geometry + fairness gates for phenomena (pure, over ParaWorld).
// Gates: never in the van / cab / outside; >= 6 m from an active monster; >= 25 m from an active Mannequin for light
// kills; >= 6 m from Snatcher grates while it lurks; no knocks on doors a hidden player is behind; never between a
// player and a monster; Core carriers get T0/T1 only (plan.ts).
import type { LayoutDoor, LayoutItem, LevelLayout } from '@dead-air/shared/layout.ts';
import { los } from '@dead-air/shared/nav/index.ts';
import type { ParaMonster, ParaPlayer, ParaWorld } from './types.ts';

export const dist2 = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
};

export function spaceAtXZ(L: LevelLayout, x: number, z: number): number {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return -1;
  return L.owner[cz * L.W + cx] ?? -1;
}

export function inRect(r: { x: number; y: number; w: number; h: number }, x: number, z: number, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && z >= r.y - pad && z <= r.y + r.h + pad;
}

/** indoor facility space (not the lot, not the van) */
export function indoor(L: LevelLayout, space: number): boolean {
  const s = L.spaces[space];
  return !!s && s.kind !== 'outside' && s.type !== 'van' && !s.open;
}

/** the van space / cab (with a margin) */
export function nearVan(L: LevelLayout, x: number, z: number, m: number): boolean {
  if (L.van?.cab && inRect(L.van.cab, x, z, m)) return true;
  for (const s of L.spaces) if (s.type === 'van' && inRect(s.rect, x, z, m)) return true;
  return false;
}

export function doorCenter(d: LayoutDoor): [number, number] {
  return d.dir === 'v' ? [d.x, d.y + d.len / 2] : [d.x + d.len / 2, d.y];
}

/** unit normal of a door edge (+x for 'v', +z for 'h') */
export function doorNormal(d: LayoutDoor): [number, number] {
  return d.dir === 'v' ? [1, 0] : [0, 1];
}

const ACTIVE_SKIP = new Set(['out', 'dormant', 'vent', 'duct']);
export function activeMonsters(w: ParaWorld): ParaMonster[] {
  return w.monsters().filter((m) => m.active && !ACTIVE_SKIP.has(m.state));
}

/** no active monster within m metres */
export function monsterClear(mons: readonly ParaMonster[], x: number, z: number, m: number): boolean {
  for (const a of mons) if (dist2(a.x, a.z, x, z) < m) return false;
  return true;
}

/** no active Mannequin within m metres (light kills give it free movement) */
export function mannequinClear(mons: readonly ParaMonster[], x: number, z: number, m: number): boolean {
  for (const a of mons) if (a.kind === 'mannequin' && dist2(a.x, a.z, x, z) < m) return false;
  return true;
}

const ventCache = new WeakMap<LevelLayout, LayoutItem[]>();
export function vents(L: LevelLayout): LayoutItem[] {
  let v = ventCache.get(L);
  if (!v) { v = L.items.filter((i) => i.kind === 'vent'); ventCache.set(L, v); }
  return v;
}

/** >= m from every grate while the Snatcher lurks (its own tell is a grate rattle) */
export function grateClear(w: ParaWorld, x: number, z: number, m: number): boolean {
  if (!w.snatcherLurking()) return true;
  for (const g of vents(w.layout)) if (dist2(g.x, g.z, x, z) < m) return false;
  return true;
}

/** spaces holding a hidden player's locker */
export function hiddenSpaces(w: ParaWorld, players: readonly ParaPlayer[]): Set<number> {
  const out = new Set<number>();
  for (const p of players) {
    if (!p.hidden) continue;
    const it = itemById(w.layout, p.hidden);
    out.add(it ? it.space : spaceAtXZ(w.layout, p.x, p.z));
  }
  return out;
}

const itemIndex = new WeakMap<LevelLayout, Map<string, LayoutItem>>();
export function itemById(L: LevelLayout, id: string): LayoutItem | undefined {
  let m = itemIndex.get(L);
  if (!m) { m = new Map(L.items.map((i) => [i.id, i])); itemIndex.set(L, m); }
  return m.get(id);
}

/** angle (rad) between a player's facing and the direction to (x, z) */
export function angleTo(p: { x: number; z: number; yaw: number }, x: number, z: number): number {
  const dx = x - p.x, dz = z - p.z;
  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
  const l = Math.hypot(dx, dz) || 1;
  const c = (dx * fx + dz * fz) / l;
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** is any living player looking at (x, z): within maxM, inside +-deg of their yaw, grid line of sight */
export function anyoneLooking(w: ParaWorld, players: readonly ParaPlayer[], x: number, z: number, maxM: number, deg: number, except?: string): boolean {
  const lim = (deg * Math.PI) / 180;
  for (const p of players) {
    if (!p.alive || p.id === except) continue;
    if (dist2(p.x, p.z, x, z) > maxM) continue;
    if (angleTo(p, x, z) > lim) continue;
    if (los(w.grid, p.x, p.z, x, z, w.doorOpen)) return true;
  }
  return false;
}

/** distance from point to segment a-b and the projection parameter */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return { d: Math.hypot(px - (ax + dx * t), pz - (az + dz * t)), t };
}

/** (x, z) lies in the lane between some player and some active monster (within laneM of the segment, both < 30 m apart) */
export function betweenPlayerAndMonster(players: readonly ParaPlayer[], mons: readonly ParaMonster[], x: number, z: number, laneM: number): boolean {
  for (const m of mons) {
    for (const p of players) {
      if (!p.alive) continue;
      if (dist2(p.x, p.z, m.x, m.z) > 30) continue;
      const s = segDist(x, z, p.x, p.z, m.x, m.z);
      if (s.t > 0.02 && s.t < 0.98 && s.d < laneM) return true;
    }
  }
  return false;
}

/** no other living player within m of pid */
export function isLone(players: readonly ParaPlayer[], pid: string, m: number): boolean {
  const me = players.find((p) => p.id === pid);
  if (!me) return false;
  for (const p of players) if (p.id !== pid && p.alive && !p.inVan && dist2(p.x, p.z, me.x, me.z) < m) return false;
  return true;
}

/** within r of a door edge's centre line (doorways stay clear for presences) */
export function inDoorway(L: LevelLayout, x: number, z: number, r = 0.9): boolean {
  for (const d of L.doors) {
    if (d.dir === 'v') {
      if (Math.abs(x - d.x) < r && z > d.y - 0.3 && z < d.y + d.len + 0.3) return true;
    } else if (Math.abs(z - d.y) < r && x > d.x - 0.3 && x < d.x + d.len + 0.3) return true;
  }
  return false;
}

export interface Fixture { id: string; space: number; x: number; y: number; z: number; state: string; kind: string }
const fixCache = new WeakMap<LevelLayout, Fixture[]>();
/** every 'light' item (ceiling fixtures, lot lamps, van light) */
export function fixturesOf(L: LevelLayout): Fixture[] {
  let f = fixCache.get(L);
  if (!f) {
    f = L.items.filter((i) => i.kind === 'light').map((i) => ({
      id: i.id, space: i.space, x: i.x, y: i.y ?? 2.9, z: i.z, state: String(i.data?.state ?? 'on'), kind: String(i.data?.kind ?? 'tube'),
    }));
    fixCache.set(L, f);
  }
  return f;
}

const bySpaceCache = new WeakMap<LevelLayout, Map<number, Fixture[]>>();
export function fixturesBySpace(L: LevelLayout): Map<number, Fixture[]> {
  let m = bySpaceCache.get(L);
  if (!m) {
    m = new Map();
    for (const f of fixturesOf(L)) {
      let a = m.get(f.space);
      if (!a) m.set(f.space, (a = []));
      a.push(f);
    }
    bySpaceCache.set(L, m);
  }
  return m;
}

/** a fixture that can glow (generated on/flicker; broken and off never light) */
export const glowing = (f: Fixture): boolean => f.state === 'on' || f.state === 'flicker';

/** (x, z) is dark: its space is off, or no glowing fixture of a lit space within m */
export function darkAt(w: ParaWorld, x: number, z: number, m: number): boolean {
  const s = spaceAtXZ(w.layout, x, z);
  if (s < 0) return false;
  if (!w.lightsOn(s)) return true;
  const fx = fixturesBySpace(w.layout).get(s) ?? [];
  for (const f of fx) if (glowing(f) && dist2(f.x, f.z, x, z) < m) return false;
  return true;
}

const switchCache = new WeakMap<LevelLayout, Set<number>>();
/** spaces with a light switch (rooms revive by switch; corridors revive on a timer) */
export function switchSpaces(L: LevelLayout): Set<number> {
  let s = switchCache.get(L);
  if (!s) {
    s = new Set();
    for (const it of L.items) if (it.kind === 'switch') s.add(Number(it.data?.space ?? it.space));
    switchCache.set(L, s);
  }
  return s;
}

/** walkable cell (inside the grid, owned by a space) */
export function walkable(L: LevelLayout, x: number, z: number): boolean {
  return spaceAtXZ(L, x, z) >= 0;
}

/** cell centre of (x, z) */
export const cellCentre = (x: number, z: number): [number, number] => [Math.floor(x) + 0.5, Math.floor(z) + 0.5];
