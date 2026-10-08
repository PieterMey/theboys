// Owner: env-layout (v1.2). Lore spots: kind 'prop' items {prop: 'lore_<style>', lore: idx} + 'drawer' spots on
// containers. The fieldguide picks which carry a bulletin or page. placeLoreSpots is the generation step (appended
// after every v1.1 item, own stream 'lore'); loreSpotsOf derives the spots from a finished layout (pure, memoised).
import type { LayoutSpace, LevelLayout } from '../layout.ts';
import type { Rng } from '../rng.ts';
import { makeRng } from '../rng.ts';
import type { ItemList } from './common.ts';
import { normalOfYaw, r3, rcx, rcy } from './common.ts';
import type { Placer } from './place.ts';
import { containersOf } from './containers.ts';
import type { SiteTheme } from './themes.ts';
import { themeChain } from './themes.ts';

export type LoreStyle = 'board' | 'clipboard' | 'plaque' | 'blackboard' | 'frame' | 'safety_card' | 'drawer';
export interface LoreSpot {
  /** host prop id; 'drawer' spots use the container id */
  id: string;
  idx: number;
  style: LoreStyle;
  space: number;
  roomType: string;
  x: number; y: number; z: number; rot: number;
  /** page aim point */
  p: [number, number, number];
  container?: string;
  part?: number;
}
export type WallLoreStyle = Exclude<LoreStyle, 'drawer'>;
/** wall-hung lore holders (m): width along the wall, depth off the wall, height; all <= 0.9 m wide (one wall cell) */
export const LORE_DIMS: Readonly<Record<WallLoreStyle, { w: number; d: number; h: number }>> = {
  board: { w: 0.9, d: 0.03, h: 0.6 },
  clipboard: { w: 0.25, d: 0.03, h: 0.34 },
  plaque: { w: 0.5, d: 0.03, h: 0.35 },
  blackboard: { w: 0.9, d: 0.04, h: 0.6 },
  frame: { w: 0.5, d: 0.04, h: 0.65 },
  safety_card: { w: 0.32, d: 0.02, h: 0.45 },
};
const WALL_STYLES = Object.keys(LORE_DIMS) as WallLoreStyle[];

/** holder styles by room type (facility look); themes override some rooms (THEME_LORE) */
const STYLE_BY_TYPE: Readonly<Record<string, readonly WallLoreStyle[]>> = {
  office: ['clipboard', 'board', 'frame'], archive: ['board', 'clipboard'], library: ['plaque', 'frame', 'board'],
  mailroom: ['board', 'clipboard'], server: ['safety_card', 'clipboard'], radio: ['clipboard', 'board'],
  storage: ['safety_card', 'clipboard'], dock: ['safety_card', 'board'], garage: ['safety_card', 'clipboard'],
  boiler: ['safety_card'], furnace: ['safety_card'], foundry: ['safety_card', 'clipboard'], pumps: ['safety_card', 'clipboard'],
  tanks: ['safety_card'], pit: ['safety_card'], greenhouse: ['clipboard', 'board'], infirmary: ['clipboard', 'board'],
  morgue: ['clipboard'], nursery: ['blackboard', 'frame'], cryo: ['safety_card', 'clipboard'], cold: ['safety_card', 'clipboard'],
  showers: ['safety_card'], kitchen: ['board', 'clipboard'], canteen: ['board', 'blackboard'], laundry: ['board', 'safety_card'],
  chapel: ['plaque', 'frame'], gallery: ['frame', 'plaque'], warden: ['frame', 'clipboard'],
};
const THEME_LORE: Partial<Record<SiteTheme, Readonly<Record<string, readonly WallLoreStyle[]>>>> = {
  hospital: { office: ['clipboard'], archive: ['clipboard', 'board'], canteen: ['board'], storage: ['clipboard', 'safety_card'] },
  records: { office: ['frame', 'clipboard'], archive: ['plaque', 'board'], storage: ['board'], mailroom: ['board'] },
  hospitality: { office: ['frame', 'board'], kitchen: ['board'], storage: ['clipboard'], canteen: ['frame', 'blackboard'] },
  comms: { office: ['board', 'clipboard'], server: ['clipboard', 'safety_card'], archive: ['board'] },
  cold_storage: { office: ['clipboard'], storage: ['safety_card', 'clipboard'], dock: ['safety_card'] },
  parish: { office: ['frame', 'plaque'], archive: ['plaque'], canteen: ['blackboard'], nursery: ['blackboard'] },
};
function stylesFor(theme: SiteTheme, roomType: string): readonly WallLoreStyle[] {
  for (const t of themeChain(theme)) { const s = THEME_LORE[t]?.[roomType]; if (s) return s; }
  return STYLE_BY_TYPE[roomType] ?? ['board', 'clipboard'];
}

/**
 * 3-6 lore holders on still-free wall slots (the floor cell in front free and reachable, o.reach) at 1.45-1.6 m, one per room, in rooms
 * without a clue note (never the van, vault or lobby: pass them in `exclude`), spread farthest-first from a random
 * start. Returns the number placed.
 */
export function placeLoreSpots(spaces: readonly LayoutSpace[], P: Placer, items: ItemList, rng: Rng, o: { theme: SiteTheme; exclude: ReadonlySet<number>; reach: Uint8Array }): number {
  const noteRooms = new Set(items.items.filter((it) => it.kind === 'note').map((it) => it.space));
  const slotsOf = (sid: number) => P.freeSlots(sid).filter((s) => !P.usedCell[s.cell] && o.reach[s.cell]);
  const pool = spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && !o.exclude.has(s.id) && !noteRooms.has(s.id) &&
    s.type !== 'lobby' && s.type !== 'van' && s.type !== 'vault' && slotsOf(s.id).length > 0);
  const want = rng.int(3, 6);
  const picked: LayoutSpace[] = [];
  const md = (s: LayoutSpace) => {
    let d = Infinity;
    for (const p of picked) d = Math.min(d, Math.abs(rcx(p.rect) - rcx(s.rect)) + Math.abs(rcy(p.rect) - rcy(s.rect)));
    return d;
  };
  let idx = 0;
  while (idx < want && pool.length) {
    let bi = 0;
    if (!picked.length) bi = rng.int(0, pool.length - 1);
    else { let bd = -1; for (let i = 0; i < pool.length; i++) { const d = md(pool[i]); if (d > bd) { bd = d; bi = i; } } }
    const s = pool.splice(bi, 1)[0];
    picked.push(s);
    const free = slotsOf(s.id);
    if (!free.length) continue;
    const slot = free[rng.int(0, free.length - 1)];
    const style = rng.pick(stylesFor(o.theme, s.type));
    const dim = LORE_DIMS[style];
    P.take(slot);
    const m = P.mount(slot, dim.d);
    items.add('prop', s.id, m.x, m.z, { y: 1.45 + rng.next() * 0.15, rot: m.rot, data: { prop: `lore_${style}`, lore: idx, solid: false, w: dim.w, d: dim.d, h: dim.h } });
    idx++;
  }
  return idx;
}

const cache = new Map<string, readonly LoreSpot[]>();
/** 3..6 wall spots (+ up to 2 drawer spots) per facility; none in hub, van, vault, lobby or clue-note rooms */
export function loreSpotsOf(L: LevelLayout): readonly LoreSpot[] {
  const key = `${L.seed}|${L.hash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out: LoreSpot[] = [];
  if (L.kind === 'facility') {
    for (const it of L.items) {
      const prop = it.kind === 'prop' ? String(it.data?.prop ?? '') : '';
      const style = prop.startsWith('lore_') ? (prop.slice(5) as WallLoreStyle) : null;
      if (!style || !WALL_STYLES.includes(style) || typeof it.data?.lore !== 'number') continue;
      const rot = it.rot ?? 0, y = it.y ?? 1.5;
      const [nx, nz] = normalOfYaw(rot);
      const f = LORE_DIMS[style].d / 2 + 0.02;
      out.push({ id: it.id, idx: it.data.lore, style, space: it.space, roomType: L.spaces[it.space]?.type ?? '', x: it.x, y, z: it.z, rot, p: [r3(it.x + nx * f), y, r3(it.z + nz * f)] });
    }
    out.sort((a, b) => a.idx - b.idx);
    // 1-2 drawer spots: containers in rooms without a wall spot or a note, spread apart, chosen per layout hash
    const noteRooms = new Set(L.items.filter((it) => it.kind === 'note').map((it) => it.space));
    const wallRooms = new Set(out.map((s) => s.space));
    const usable = containersOf(L).filter((c) => !noteRooms.has(c.space) && c.roomType !== 'lobby');
    const spread = usable.filter((c) => !wallRooms.has(c.space));
    const conts = spread.length ? spread : usable;
    const rng = makeRng(`${L.seed}:${L.hash}`, 'lore:drawers');
    const n = Math.min(conts.length, rng.int(1, 2));
    let next = out.length ? out[out.length - 1].idx + 1 : 0;
    const chosen: typeof conts[number][] = [];
    for (let k = 0; k < n; k++) {
      let pick = conts[rng.int(0, conts.length - 1)];
      if (chosen.length) {
        let bd = -1;
        for (const c of conts) {
          if (chosen.includes(c) || chosen.some((q) => q.space === c.space)) continue;
          const d = Math.min(...chosen.map((q) => Math.abs(q.x - c.x) + Math.abs(q.z - c.z)));
          if (d > bd) { bd = d; pick = c; }
        }
        if (bd < 0) break;
      }
      chosen.push(pick);
      const part = pick.parts.find((p) => p.idx === pick.main) ?? pick.parts[0];
      const slot = part?.slot ?? pick.p;
      out.push({ id: pick.id, idx: next++, style: 'drawer', space: pick.space, roomType: pick.roomType, x: pick.x, y: slot[1], z: pick.z, rot: pick.rot, p: [slot[0], slot[1], slot[2]], container: pick.id, part: pick.main });
    }
  }
  if (cache.size > 16) cache.clear();
  cache.set(key, out);
  return out;
}
