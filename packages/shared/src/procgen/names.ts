// Owned by track ② Level. Callsign assignment: unique, whole-word distinct names from CALLSIGNS, sized to the room.
// A few landmark names (set-piece rooms: flooded boiler hall, server farm, morgue, canteen, chapel, warehouse stores,
// library) are placed first, on rooms whose size suits the set piece; the rest are drawn at random by size.
import { CALLSIGNS, CALLSIGN_INFO, confusable } from '../callsign.ts';
import type { Rect, SpaceKind } from '../layout.ts';
import type { Rng } from '../rng.ts';
import { GenFail, area } from './common.ts';

interface Nameable { id: number; kind: SpaceKind; rect: Rect; type: string; callsign: string | null }

const SPECIAL = new Set(['LOBBY', 'VAN', 'VAULT']);

/** landmark callsign -> [min area, max area, min short side] of a room that can host the set piece */
export const LANDMARKS: Readonly<Record<string, readonly [number, number, number]>> = {
  BOILER: [56, 400, 6],
  SERVER: [30, 140, 5],
  MORGUE: [24, 90, 5],
  CANTEEN: [48, 400, 6],
  CHAPEL: [36, 160, 6],
  STORES: [56, 400, 6],
  LIBRARY: [48, 300, 6],
};

/** Assign callsigns to every room/hall that has none yet (lobby/vault/van are set by the generator). */
export function assignCallsigns(spaces: Nameable[], rng: Rng, avoid: readonly string[], landmarks = 0): void {
  const skip = new Set([...SPECIAL, ...avoid]);
  const pool = CALLSIGNS.filter((c) => !skip.has(c));
  const used = new Set<string>(spaces.map((s) => s.callsign).filter((c): c is string => c !== null));
  const ok = (c: string) => !used.has(c) && ![...used].some((u) => confusable(u, c));
  // landmarks first: each goes to a fitting unnamed room (largest fit for the halls, random fit otherwise)
  if (landmarks > 0) {
    let placed = 0;
    for (const cs of rng.shuffle(Object.keys(LANDMARKS).filter((c) => pool.includes(c as (typeof CALLSIGNS)[number])))) {
      if (placed >= landmarks) break;
      if (!ok(cs)) continue;
      const [lo, hi, side] = LANDMARKS[cs];
      const fit = spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.callsign === null && area(s.rect) >= lo && area(s.rect) <= hi && Math.min(s.rect.w, s.rect.h) >= side);
      if (!fit.length) continue;
      const pick = lo >= 48 ? fit.sort((a, b) => area(b.rect) - area(a.rect) || a.id - b.id)[rng.int(0, Math.min(1, fit.length - 1))] : fit[rng.int(0, fit.length - 1)];
      used.add(cs);
      pick.callsign = cs;
      pick.type = CALLSIGN_INFO[cs].type;
      placed++;
    }
  }
  const big = rng.shuffle(pool.filter((c) => CALLSIGN_INFO[c].size !== 'S'));
  const small = rng.shuffle(pool.filter((c) => CALLSIGN_INFO[c].size !== 'L'));
  const rooms = spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.callsign === null)
    .sort((a, b) => area(b.rect) - area(a.rect) || a.id - b.id);
  for (const s of rooms) {
    const pref = area(s.rect) >= 48 ? big : small;
    const alt = pref === big ? small : big;
    const cs = pref.find(ok) ?? alt.find(ok);
    if (!cs) throw new GenFail('callsigns');
    used.add(cs);
    s.callsign = cs;
    s.type = CALLSIGN_INFO[cs].type;
  }
}
