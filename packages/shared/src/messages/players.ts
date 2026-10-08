// Owned by track ⑤ Players (emotes, pings, proximity text) and, for v1.2, players-stealth (footstep noise, crawl vents).
// Add entries here only (additive). Events: name -> payload. Reqs: name -> { args; result }.
import type { Vec3 } from '../state.ts';
import { NOISE_M } from '../constants.ts';

/** Emote wheel entries (T). Anim ids: ANIM.emoteWave / emotePoint / emoteBeckon / emoteThumbs. */
export type EmoteKind = 'wave' | 'point' | 'beckon' | 'thumbs';
export const EMOTE_KINDS: readonly EmoteKind[] = ['wave', 'point', 'beckon', 'thumbs'];

/** footstep noise kinds (server noise bus + client 'players:step') */
export type StepKind = 'crouchStep' | 'walkStep' | 'sprintStep';
export const STEP_KINDS: readonly StepKind[] = ['crouchStep', 'walkStep', 'sprintStep'];

/** the slice of config/balance/players.json that shapes footstep noise (v1.2, flag stealthV12) */
export interface StepNoiseBalance {
  /** floor surface -> radius multiplier (missing surface = 1) */
  surfaceNoiseMult?: Readonly<Record<string, number>>;
  /** overshoes ('soles' gear) multiplier, default 0.8 */
  solesNoiseMult?: number;
}

const finitePos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * v1.2 footstep radius (m), the one formula the server's noise bus and the client's stance HUD share:
 *   NOISE_M[kind] x (bal.surfaceNoiseMult[surface] ?? 1) x (soles ? bal.solesNoiseMult ?? 0.8 : 1)
 * With players.json: walking reaches 6.5 m on metal, 7 m on grating, 5.5 m on tile, 4.25 m on carpet and 5 m elsewhere;
 * crouching stays <= 2.1 m everywhere; overshoes cut walking to 4 m. Unknown kinds use the walk radius.
 * Rounded to millimetres so 5 x 1.1 reads 5.5 everywhere.
 */
export function stepNoiseRadius(
  kind: StepKind | (string & {}),
  surface: string | null | undefined,
  soles: boolean,
  bal: StepNoiseBalance | Readonly<Record<string, unknown>> | null | undefined,
): number {
  const base = (NOISE_M as Readonly<Record<string, number>>)[kind] ?? NOISE_M.walkStep;
  const b = (bal ?? {}) as StepNoiseBalance;
  const table = b.surfaceNoiseMult && typeof b.surfaceNoiseMult === 'object' ? b.surfaceNoiseMult : null;
  const sm = surface && table ? table[surface] : undefined;
  const surfaceMult = finitePos(sm) ? sm : 1;
  const solesMult = soles ? (finitePos(b.solesNoiseMult) ? b.solesNoiseMult : 0.8) : 1;
  return Math.round(base * surfaceMult * solesMult * 1000) / 1000;
}

/** v1.2 crawl vents (flag crawlVents): one crawl through a duct between two grates of a vent pair */
export interface CrawlEvent {
  pid: string;
  /** 'enter': the crawl started at the entry grate (p = entry front); 'exit': the player came out at p (twin front) */
  phase: 'enter' | 'exit';
  p: Vec3;
  /** facing on arrival / at the grate (radians) */
  yaw: number;
  /** server ms (ctx.now() clock) when the crawl ends */
  until: number;
  /** vent item ids: the entry grate and the twin grate */
  from?: string;
  to?: string;
}

export interface PlayersEvents {
  /** a player started an emote (everyone in the crew; flag 'emotes') */
  'players.emote': { id: string; kind: EmoteKind; anim: number };
  /** silent ping (MMB): delivered to the pinger and to living teammates with line of sight to `p` */
  'players.ping': { id: string; name: string; p: Vec3 };
  /** proximity text line (flag 'proxText'): delivered only to players within talk-band path distance */
  'players.chat': { id: string; name: string; text: string; dist: number };
  /** v1.2 crawl vents: a player entered / left a duct (everyone in the crew: the grate thumps are audible anyway) */
  'players.crawl': CrawlEvent;
}

export interface PlayersReqs {
  'players.emote': { args: { kind: EmoteKind }; result: { ok: boolean } };
  /** p = ping point (world metres, from the client's raycast) */
  'players.ping': { args: { p: Vec3 }; result: { ok: boolean; seenBy: number } };
  /** text: 1..140 chars */
  'players.chat': { args: { text: string }; result: { ok: boolean; heardBy: number } };
}
