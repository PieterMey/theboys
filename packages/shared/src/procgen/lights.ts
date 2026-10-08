// Owned by track ② Level. Fixture light states and positions ('light' items; the render track owns the light pool).
import type { LayoutDoor, LayoutSpace, LightState } from '../layout.ts';
import type { Rng } from '../rng.ts';
import type { LevelTuning } from './tuning.ts';
import type { ItemList } from './common.ts';
import { HALF_T } from './place.ts';
import type { Placer, WallSlot } from './place.ts';
import type { SiteTheme } from './themes.ts';
import { themeChain } from './themes.ts';

/** Space-level light state: deeper and riskier = more off / broken. */
export function rollLight(rng: Rng, t: LevelTuning, risk: number, depth: number): LightState {
  const pBroken = t.lightBrokenBase + t.lightBrokenDepth * depth + t.lightBrokenPerRisk * (risk - 1);
  const pOff = t.lightOffBase + t.lightOffPerRisk * (risk - 1) + t.lightOffDepth * depth;
  const pFlicker = t.lightFlickerBase + t.lightFlickerPerRisk * (risk - 1);
  const r = rng.next();
  if (r < pBroken) return 'broken';
  if (r < pBroken + pOff) return 'off';
  if (r < pBroken + pOff + pFlicker) return 'flicker';
  return 'on';
}

function fixtureState(rng: Rng, t: LevelTuning, s: LightState, depth: number): LightState {
  if (!rng.chance(t.fixtureDeviate)) return s;
  if (s === 'on') return rng.chance(0.35 + 0.4 * depth) ? 'broken' : 'flicker';
  if (s === 'flicker') return 'on';
  return 'broken';
}

export interface FixtureOpts {
  lot: number;
  van: number;
  exitDoor: LayoutDoor | null;
  lotLamps: number;
}

/** Ceiling fixtures for every indoor space, lot lamps, the van interior light. */
export function addFixtures(S: readonly LayoutSpace[], items: ItemList, rng: Rng, t: LevelTuning, wallH: number, o: FixtureOpts): void {
  let maxDist = 1;
  for (const s of S) if (!s.open && s.type !== 'van') maxDist = Math.max(maxDist, s.dist);
  const yCeil = wallH - 0.04;
  for (const s of S) {
    if (s.open || s.id === o.van) continue;
    const { x, y, w, h } = s.rect;
    const depth = Math.min(1, s.dist / maxDist);
    const pts: [number, number][] = [];
    if (s.kind === 'corridor') {
      if (w <= 2 && h <= 2) pts.push([x + w / 2, y + h / 2]);
      else if (w >= h) { const n = Math.max(1, Math.round(w / 5)); for (let i = 0; i < n; i++) pts.push([x + ((i + 0.5) * w) / n, y + h / 2]); }
      else { const n = Math.max(1, Math.round(h / 5)); for (let i = 0; i < n; i++) pts.push([x + w / 2, y + ((i + 0.5) * h) / n]); }
    } else {
      const nx = Math.max(1, Math.round(w / 4.5)), ny = Math.max(1, Math.round(h / 4.5));
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([x + ((i + 0.5) * w) / nx, y + ((j + 0.5) * h) / ny]);
    }
    for (const [px, pz] of pts) {
      items.add('light', s.id, px, pz, { y: yCeil, data: { state: fixtureState(rng, t, s.light, depth), kind: 'tube' } });
    }
  }
  // parking lot: tall sodium lamps along the far fence + a wall lamp over the entrance
  const lot = S[o.lot];
  if (lot) {
    const r = lot.rect;
    for (let i = 0; i < o.lotLamps; i++) {
      const lx = r.x + ((i + 0.5) * r.w) / o.lotLamps;
      items.add('light', lot.id, lx, r.y + r.h - 1.2, { y: 6, data: { state: i === 1 && rng.chance(0.5) ? 'flicker' : 'on', kind: 'lamp' } });
    }
    if (o.exitDoor) {
      const d = o.exitDoor;
      const cx = d.dir === 'h' ? d.x + d.len / 2 : d.x;
      items.add('light', lot.id, cx, r.y + 0.2, { y: 2.75, rot: 0, data: { state: 'on', kind: 'wall' } });
    }
  }
  // v1.2: the van's lights come from addVanStations (van.ts), appended after every v1.1 item
}

/** height of an emergency light over a door frame (DOOR_H 2.1 + 0.3) */
export const EMERGENCY_Y = 2.4;
const EMERGENCY_DOOR_SCORE: Readonly<Partial<Record<LayoutDoor['kind'], number>>> = { exit: 3, security: 2, fire: 1, door: 0 };

/**
 * v1.2 battery emergency lights (data.battery, kind 'emergency'): 1-2 per power zone, on the wall over a door
 * (exit > security > fire > door; corridor side first), facing into the space they hang in. Appended after every v1.1
 * item, stream 'theme:lights' (first draws). Returns the number placed.
 */
export function addEmergencyLights(S: readonly LayoutSpace[], doors: readonly LayoutDoor[], owner: ArrayLike<number>, W: number, items: ItemList, rng: Rng): number {
  const indoor = (id: number) => id >= 0 && S[id] !== undefined && !S[id].open && S[id].type !== 'van' && S[id].kind !== 'vault';
  type Cand = { d: LayoutDoor; s: number; score: number; x: number; z: number; rot: number };
  const zones = new Map<number, Cand[]>();
  for (const d of doors) {
    const score = EMERGENCY_DOOR_SCORE[d.kind];
    if (score === undefined) continue;
    // mount side: the corridor (or the lobby for the exit), else either indoor side
    const sides = [d.a, d.b].filter(indoor).sort((p, q) => Number(S[q].kind === 'corridor') - Number(S[p].kind === 'corridor') || p - q);
    const s = sides[0];
    if (s === undefined) continue;
    let x: number, z: number, rot: number;
    if (d.dir === 'v') {
      const right = owner[d.y * W + d.x] === s;
      x = right ? d.x + HALF_T + 0.05 : d.x - HALF_T - 0.05; z = d.y + d.len / 2; rot = right ? Math.PI / 2 : -Math.PI / 2;
    } else {
      const below = owner[d.y * W + d.x] === s;
      x = d.x + d.len / 2; z = below ? d.y + HALF_T + 0.05 : d.y - HALF_T - 0.05; rot = below ? 0 : Math.PI;
    }
    const pz = S[s].powerZone;
    if (!zones.has(pz)) zones.set(pz, []);
    zones.get(pz)!.push({ d, s, score, x, z, rot });
  }
  let placed = 0;
  for (const pz of [...zones.keys()].sort((a, b) => a - b)) {
    const cands = rng.shuffle(zones.get(pz)!).sort((p, q) => q.score - p.score);
    const n = Math.min(cands.length, rng.int(1, 2));
    const chosen: Cand[] = [];
    for (const c of cands) {
      if (chosen.length >= n) break;
      if (chosen.some((q) => q.s === c.s || Math.abs(q.x - c.x) + Math.abs(q.z - c.z) < 8)) continue;
      chosen.push(c);
    }
    for (const c of chosen) {
      items.add('light', c.s, c.x, c.z, { y: EMERGENCY_Y, rot: c.rot, data: { state: 'on', kind: 'emergency', battery: true, door: c.d.id } });
      placed++;
    }
  }
  return placed;
}

/** ceiling fixture kind per site theme, keyed by room type, 'hall' (big rooms) or 'corridor' (theme chain; else tube) */
export const THEME_FIXTURES: Readonly<Partial<Record<SiteTheme, Readonly<Record<string, string>>>>> = {
  hospital: { chapel: 'bulb', nursery: 'bulb' },
  waterworks: {
    corridor: 'bulb', hall: 'highbay', boiler: 'highbay', furnace: 'highbay', foundry: 'highbay', pumps: 'highbay', tanks: 'highbay',
    pit: 'highbay', garage: 'highbay', dock: 'highbay', storage: 'highbay', greenhouse: 'highbay',
  },
  records: { corridor: 'bulb', library: 'bulb', archive: 'bulb', gallery: 'bulb', chapel: 'bulb', lobby: 'bulb', canteen: 'bulb' },
  hospitality: { corridor: 'bulb', canteen: 'bulb', gallery: 'bulb', lobby: 'bulb', chapel: 'bulb', office: 'bulb', nursery: 'bulb', library: 'bulb' },
  cold_storage: { hall: 'highbay', dock: 'highbay', storage: 'highbay' },
  comms: { corridor: 'tube', lobby: 'tube' },
  transport: { corridor: 'tube', gallery: 'highbay', canteen: 'tube' },
  retail: { gallery: 'tube', corridor: 'tube' },
  parish: { chapel: 'bulb', corridor: 'bulb', nursery: 'bulb' },
  baths: { showers: 'bulb', pumps: 'bulb' },
  greenhouse: { greenhouse: 'highbay', nursery: 'highbay', corridor: 'tube' },
  laundry: { corridor: 'tube' },
};
/** room types that get 1-2 wall sconces (theme chain) */
const THEME_SCONCES: Readonly<Partial<Record<SiteTheme, ReadonlySet<string>>>> = {
  records: new Set(['lobby', 'gallery', 'library', 'chapel']),
  hospitality: new Set(['lobby', 'gallery', 'canteen', 'chapel', 'library']),
  parish: new Set(['chapel', 'gallery', 'library', 'lobby']),
};
const SCONCE_Y = 1.95;
const lookup = <T>(theme: SiteTheme, table: Readonly<Partial<Record<SiteTheme, T>>>): T | undefined => {
  for (const t of themeChain(theme)) if (table[t] !== undefined) return table[t];
  return undefined;
};
function fixtureKindFor(theme: SiteTheme, s: LayoutSpace): string | undefined {
  for (const t of themeChain(theme)) {
    const m = THEME_FIXTURES[t];
    if (!m) continue;
    const k = s.kind === 'corridor' ? m.corridor : m[s.type] ?? (s.kind === 'hall' ? m.hall : undefined);
    if (k) return k;
  }
  return undefined;
}

/**
 * v1.2 site-theme lighting on a finished themed layout (never for 'facility'): ceiling fixture kinds per space
 * (THEME_FIXTURES: bulbs, high-bays; the positions and states stay), 1-2 wall sconces in dressed rooms on free, reachable
 * wall slots at 1.95 m (state = the room's light state), and 2 candles on a chapel altar (parish / hospital chain).
 * Continues the 'theme:lights' stream after addEmergencyLights. Returns the number of lights added.
 */
export function addThemeLights(S: readonly LayoutSpace[], items: ItemList, P: Placer, rng: Rng, theme: SiteTheme, reach: Uint8Array): number {
  for (const it of items.items) {
    if (it.kind !== 'light' || it.data?.kind !== 'tube') continue;
    const k = fixtureKindFor(theme, S[it.space]);
    if (k) it.data.kind = k;
  }
  let added = 0;
  const sconceRooms = lookup(theme, THEME_SCONCES);
  if (sconceRooms) for (const s of S) {
    if ((s.kind !== 'room' && s.kind !== 'hall') || !sconceRooms.has(s.type)) continue;
    const free = P.freeSlots(s.id).filter((sl) => !P.usedCell[sl.cell] && reach[sl.cell]);
    if (!free.length) continue;
    const first = free[rng.int(0, free.length - 1)];
    const picks: WallSlot[] = [first];
    // the second sconce: the free slot farthest from the first (other wall, other end)
    let best: WallSlot | null = null, bd = 3;
    for (const sl of free) { const d = Math.abs(sl.lx - first.lx) + Math.abs(sl.lz - first.lz); if (d > bd) { bd = d; best = sl; } }
    if (best && rng.chance(0.75)) picks.push(best);
    for (const sl of picks) {
      P.take(sl);
      const m = P.mount(sl, 0.12);
      items.add('light', s.id, m.x, m.z, { y: SCONCE_Y, rot: m.rot, data: { state: s.light, kind: 'sconce' } });
      added++;
    }
  }
  const chain = themeChain(theme);
  if (chain.includes('parish') || chain.includes('hospital')) {
    for (const altar of items.items.filter((it) => it.kind === 'prop' && it.data?.prop === 'altar')) {
      const along = Math.abs(Math.round((altar.rot ?? 0) / (Math.PI / 2))) % 2 === 0;
      const half = Math.min(0.7, Number(altar.data?.w ?? 1.8) / 2 - 0.2);
      for (const sgn of [-1, 1]) {
        items.add('light', altar.space, altar.x + (along ? sgn * half : 0), altar.z + (along ? 0 : sgn * half), { y: 1.12, data: { state: 'on', kind: 'candle' } });
        added++;
      }
    }
  }
  return added;
}
