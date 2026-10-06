// Owned by track ⑤ Players (emotes, pings, proximity text).
// Add entries here only (additive). Events: name -> payload. Reqs: name -> { args; result }.
import type { Vec3 } from '../state.ts';

/** Emote wheel entries (T). Anim ids: ANIM.emoteWave / emotePoint / emoteBeckon / emoteThumbs. */
export type EmoteKind = 'wave' | 'point' | 'beckon' | 'thumbs';
export const EMOTE_KINDS: readonly EmoteKind[] = ['wave', 'point', 'beckon', 'thumbs'];

export interface PlayersEvents {
  /** a player started an emote (everyone in the crew; flag 'emotes') */
  'players.emote': { id: string; kind: EmoteKind; anim: number };
  /** silent ping (MMB): delivered to the pinger and to living teammates with line of sight to `p` */
  'players.ping': { id: string; name: string; p: Vec3 };
  /** proximity text line (flag 'proxText'): delivered only to players within talk-band path distance */
  'players.chat': { id: string; name: string; text: string; dist: number };
}

export interface PlayersReqs {
  'players.emote': { args: { kind: EmoteKind }; result: { ok: boolean } };
  /** p = ping point (world metres, from the client's raycast) */
  'players.ping': { args: { p: Vec3 }; result: { ok: boolean; seenBy: number } };
  /** text: 1..140 chars */
  'players.chat': { args: { text: string }; result: { ok: boolean; heardBy: number } };
}
