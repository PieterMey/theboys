// Owner: env-paranormal (v1.2). Every effect carries a server 'at' time and a seed; residue re-sent on reconnect.
import type { Vec3 } from '../state.ts';
import { safeDisplayName } from '../names.ts';

export type ParanormalKind =
  | 'dark_walk' | 'revive' | 'mirror_writing' | 'mirror_figure' | 'presence' | 'silhouette' | 'cold_spot' | 'knock'
  | 'handle_rattle' | 'poltergeist' | 'object_fall' | 'footprints' | 'brownout_breath' | 'radio_on' | 'phone_ring' | 'dead_poke';
export type ParanormalData = Record<string, number | string | boolean | number[] | string[] | number[][]>;
export interface ParanormalEvent {
  id: number;
  kind: ParanormalKind;
  tier: 0 | 1 | 2;
  /** server ms (ctx.now) the effect starts, >= emit + 250; clients use world.serverNow() */
  at: number;
  ms: number;
  seed: number;
  /** -1 = several / none */
  space: number;
  p?: Vec3;
  yaw?: number;
  /** 'light:12' | 'door:7' | 'prop:31' | 'clutter:88' | lore spot id */
  ref?: string;
  /** only these players render it */
  to?: string[];
  data?: ParanormalData;
  persist?: boolean;
}
export interface ParanormalEvents {
  'paranormal.event': ParanormalEvent;
  'paranormal.end': { id: number; reason: 'seen' | 'lit' | 'interrupted' | 'timeout' };
  /** mirror writing: reveal strokes from server time `at` (first witness) */
  'paranormal.reveal': { id: number; at: number };
  /** v1.3 site rules (flag siteRules): the building answers what was said (the bell strikes, a room's phone rings) */
  'paranormal.rule': SiteRuleEvent;
}
export interface ParanormalReqs {
  'paranormal.sync': { args: Record<string, never> | undefined; result: { residue: ParanormalEvent[]; active: ParanormalEvent[]; now: number } };
  'paranormal.seen': { args: { id: number; end?: boolean }; result: { ok: boolean } };
  /**
   * v1.3 dead pokes (flag deadPokes): a dead, spectating player KNOCKs `count` (1-3) times on the closed door or wall
   * nearest their camera, or FLICKERs the lights of the room they watch ('brownout' = 'flicker'; 'write' stays off).
   * cooldownMs = time until this kind is ready again; knockMs / flickerMs = both cooldowns after this request.
   */
  'paranormal.poke': {
    args: { kind: 'knock' | 'brownout' | 'write' | 'flicker'; callsign?: string; count?: number };
    result: { ok: boolean; cooldownMs?: number; reason?: PokeRefusal; id?: number; knockMs?: number; flickerMs?: number };
  };
}

// ---------------------------------------------------------------- v1.2 additions (env-paranormal, additive)

/** fixed mirror phrases: mirror writing is only ever a callsign, a roster name or one of these (never transcripts) */
export const PARANORMAL_PHRASES = ['IT HEARS', 'NOT ALONE', 'COUNT AGAIN'] as const;

/** roster name as it may appear in mirror writing: A-Z 0-9 space ' -, collapsed, <= 12 chars ('' = unusable) */
export function mirrorName(name: string): string {
  const s = String(name ?? '').toUpperCase().replace(/[^A-Z0-9 '-]/g, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, 12).trim();
}

/**
 * v1.3 P1d: mirrorName() guarded by names.ts: '' (= write a phrase instead) unless the roster name AND its mirror form
 * pass safeDisplayName. The mirror form needs its own check: dropping dots, underscores and invisibles, upper-casing and
 * cutting at 12 characters can rebuild a word the original spelling hid.
 */
export function safeMirrorName(name: string, id: string): string {
  const m = mirrorName(name);
  if (!m) return '';
  if (safeDisplayName(name, id).blocked || safeDisplayName(m, id).blocked) return '';
  return m;
}

/**
 * ParanormalEvent.data keys per kind (all optional for forward compatibility; clients ignore unknown keys):
 * - dark_walk: lights string[] (fixture item ids in death order), stepMs, dieMs, spaces number[] (kill order),
 *   killAt number[] (ms after `at` when each space's last fixture dies), dead number[] (residue: spaces still dark)
 * - revive: lights string[] (fixture ids of `space`), walk (dark_walk id)
 * - mirror_writing: mirror (item id), text, fog, fogMs, revealMs, revealAt (server ms, once revealed)
 * - mirror_figure: mirrors string[], behind (m), side (m), holdMs, nearM (sent only to the armed player)
 * - presence: interf (T2 beam interference), litM, litMs, approachM, variant
 * - silhouette: room (lit space id behind the figure), end (space id beyond the corridor end, -1 = outside the map),
 *   brownMs, depth, approachM
 * - knock / handle_rattle: door (door id, -1 = locker), pattern ('wood' | 'metal' | 'locker'), count, amp, rattle
 * - poltergeist: key, from number[] [x, y, z, rot], to number[] [x, y, z, rot]
 * - object_fall: key, from number[] [x, y, z, rot], to number[] [x, z, yaw], tilt [ax, az] (unit axis), angle
 * - footprints: pts number[][] ([x, z, yaw] per print), stepMs, fadeMs, toLore (bool)
 * - cold_spot: r, density, frost
 * - brownout_breath: depth, puffs
 * - dead_poke (v1.3): poke 'knock' | 'flicker'. knock: door (door id, -1 = a wall), pattern, count (1-3), amp.
 *   flicker: lights string[] (glowing fixture ids of `space`), curve ('pulse'). Never says which dead player it was.
 */

// ---------------------------------------------------------------- v1.3 additions (paranormal-players-audio, additive)

/** v1.3 F4 dead pokes (flag deadPokes): what a dead (spectating) player can do through 'paranormal.poke' */
export const POKE_KINDS = ['knock', 'flicker'] as const;
export type PokeKind = (typeof POKE_KINDS)[number];
/**
 * why a poke was refused: off (flag / module off), alive (only the dead poke), phase (no contract), cooldown, budget
 * (per-contract cap), busy (another poke just now), far (no living teammate near the camera), nothing (nothing to knock
 * on), dark (the watched room has no working light)
 */
export type PokeRefusal = 'off' | 'alive' | 'phase' | 'cooldown' | 'budget' | 'busy' | 'far' | 'nothing' | 'dark';

/** v1.3 F7 site rules (flag siteRules): the house rule a site memo promises, made real (2 sites in v0). The same ids as
 *  meta's MetaSiteRule (messages/meta.ts): meta writes the drive-screen rule card, paranormal makes the building answer */
export const SITE_RULE_IDS = ['bell_digits', 'phone_callsign'] as const;
export type SiteRuleId = (typeof SITE_RULE_IDS)[number];
export interface SiteRuleDef {
  id: SiteRuleId;
  /** template site name (apps/server/src/meta/templates.ts SITES) */
  site: string;
  /** that site's SiteTheme and its first template modifier chip: an AI-renamed order still matches on these */
  theme: string;
  chip: string;
  /** what sets it off: any spoken number / a spoken room callsign */
  trigger: 'digits' | 'callsign';
}
export const SITE_RULES: readonly SiteRuleDef[] = [
  // "The last bell ... rings once whenever someone says a number out loud": a spoken number strikes the bell that many
  // times (1-12; a longer code strikes once per digit), heard across the building, at the bell in the furnace hall
  { id: 'bell_digits', site: 'Varga Brothers Foundry', theme: 'industry', chip: 'HEAVY SALVAGE', trigger: 'digits' },
  // "If one rings, it is not for you ... do not tell it where you are": a spoken callsign rings that room's phone
  { id: 'phone_callsign', site: 'Old Quarry Road Telephone Exchange', theme: 'comms', chip: 'RADIO HEAVY', trigger: 'callsign' },
];

/**
 * The house rule of a work order (null = none): order.siteRule when meta stamps one, else the template site name, else
 * the template's theme + first modifier chip (an AI brief may rename the site, never its theme or chips). The server
 * prefers meta/api.ts siteRule(crew) (meta keeps each order's template site name); this is the fallback.
 */
export function siteRuleOf(order: { siteName?: string; siteTheme?: string; modifiers?: readonly string[]; siteRule?: unknown } | null | undefined): SiteRuleId | null {
  if (!order) return null;
  if (typeof order.siteRule === 'string') {
    const tagged = SITE_RULES.find((r) => r.id === order.siteRule);
    if (tagged) return tagged.id;
  }
  const byName = SITE_RULES.find((r) => r.site === order.siteName);
  if (byName) return byName.id;
  const chips = Array.isArray(order.modifiers) ? order.modifiers : [];
  return SITE_RULES.find((r) => r.theme === order.siteTheme && chips.includes(r.chip))?.id ?? null;
}

/** one site-rule reaction, to the whole crew: the bell strikes / the named room's phone rings from server time `at` */
export interface SiteRuleEvent {
  id: number;
  rule: SiteRuleId;
  /** server ms (ctx.now) of the first strike / ring, >= emit + 250 (a mechanical wind-up plays before it) */
  at: number;
  seed: number;
  space: number;
  p: Vec3;
  /** bell_digits: strikes, everyMs. phone_callsign: callsign, rings, everyMs, ringMs */
  data: ParanormalData;
}
