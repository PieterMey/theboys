// Layout helpers for interaction tests: where to stand to use a door / locker / switch / item of a live layout.
import type { LevelLayout, LayoutDoor, LayoutItem } from '../../packages/shared/src/layout.ts';

export interface Spot { stand: [number, number]; look: [number, number, number]; id: string }

const owner = (L: LevelLayout, x: number, z: number) => {
  const cx = Math.floor(x), cz = Math.floor(z);
  return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : L.owner[cz * L.W + cx];
};

/** a door of `kind`, standing 0.75 m from its centre on a walkable side (prefers corridors) */
export function doorSpot(L: LevelLayout, kind: string, pickId?: number): (Spot & { door: LayoutDoor }) | null {
  const cands = L.doors.filter((d) => d.kind === kind && (pickId === undefined || d.id === pickId));
  for (const d of cands) {
    const cx = d.dir === 'v' ? d.x : d.x + d.len / 2;
    const cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
    const sides: [number, number][] = d.dir === 'v' ? [[cx - 0.75, cz], [cx + 0.75, cz]] : [[cx, cz - 0.75], [cx, cz + 0.75]];
    const ok = sides.filter(([x, z]) => owner(L, x, z) >= 0).sort((a, b) => {
      const ka = L.spaces[owner(L, a[0], a[1])]?.kind === 'corridor' ? 0 : 1;
      const kb = L.spaces[owner(L, b[0], b[1])]?.kind === 'corridor' ? 0 : 1;
      return ka - kb;
    });
    if (ok.length) return { door: d, stand: ok[0], look: [cx, 1.1, cz], id: `door:${d.id}` };
  }
  return null;
}

/** in front of a wall/floor item facing it (front = +rot direction) */
export function itemFront(it: LayoutItem, dist = 0.8, lookY = 1.0): Spot {
  const rot = it.rot ?? 0;
  return { stand: [it.x + Math.sin(rot) * dist, it.z + Math.cos(rot) * dist], look: [it.x, lookY, it.z], id: it.id };
}

export function firstItem(L: LevelLayout, kind: string, pred: (i: LayoutItem) => boolean = () => true): LayoutItem | null {
  return L.items.find((i) => i.kind === kind && pred(i)) ?? null;
}

/** a light switch of a lit, powered (zone 0) room */
export function switchSpot(L: LevelLayout): Spot | null {
  const sw = L.items.find((i) => i.kind === 'switch' && L.spaces[Number(i.data?.space ?? i.space)]?.powerZone === 0 && L.spaces[Number(i.data?.space ?? i.space)]?.light === 'on');
  return sw ? itemFront(sw, 0.7, 1.3) : null;
}

/** the longest straight corridor run (for bottle throws): start point + far point */
export function corridorRun(L: LevelLayout): { from: [number, number]; to: [number, number] } | null {
  let best: { from: [number, number]; to: [number, number]; len: number } | null = null;
  for (const s of L.spaces) {
    if (s.kind !== 'corridor') continue;
    const r = s.rect;
    if (r.w >= r.h && r.w > (best?.len ?? 0)) best = { from: [r.x + 0.8, r.y + r.h / 2], to: [r.x + r.w - 0.5, r.y + r.h / 2], len: r.w };
    if (r.h > r.w && r.h > (best?.len ?? 0)) best = { from: [r.x + r.w / 2, r.y + 0.8], to: [r.x + r.w / 2, r.y + r.h - 0.5], len: r.h };
  }
  return best;
}
