// Owned by track ② Level. Callsign assignment: unique, whole-word distinct names from CALLSIGNS, sized to the room.
import { CALLSIGNS, CALLSIGN_INFO, confusable } from '../callsign.ts';
import type { Rect, SpaceKind } from '../layout.ts';
import type { Rng } from '../rng.ts';
import { GenFail, area } from './common.ts';

interface Nameable { id: number; kind: SpaceKind; rect: Rect; type: string; callsign: string | null }

const SPECIAL = new Set(['LOBBY', 'VAN', 'VAULT']);

/** Assign callsigns to every room/hall that has none yet (lobby/vault/van are set by the generator). */
export function assignCallsigns(spaces: Nameable[], rng: Rng, avoid: readonly string[]): void {
  const skip = new Set([...SPECIAL, ...avoid]);
  const pool = CALLSIGNS.filter((c) => !skip.has(c));
  const big = rng.shuffle(pool.filter((c) => CALLSIGN_INFO[c].size !== 'S'));
  const small = rng.shuffle(pool.filter((c) => CALLSIGN_INFO[c].size !== 'L'));
  const used = new Set<string>(spaces.map((s) => s.callsign).filter((c): c is string => c !== null));
  const rooms = spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.callsign === null)
    .sort((a, b) => area(b.rect) - area(a.rect) || a.id - b.id);
  for (const s of rooms) {
    const pref = area(s.rect) >= 48 ? big : small;
    const alt = pref === big ? small : big;
    const ok = (c: string) => !used.has(c) && ![...used].some((u) => confusable(u, c));
    const cs = pref.find(ok) ?? alt.find(ok);
    if (!cs) throw new GenFail('callsigns');
    used.add(cs);
    s.callsign = cs;
    s.type = CALLSIGN_INFO[cs].type;
  }
}
