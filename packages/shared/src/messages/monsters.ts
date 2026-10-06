// Owned by P2 track (c) Monsters + director (telegraphs, intercepts, director events, death causes).
// Add entries here only (additive). Events: name -> payload. Reqs: name -> { args; result }.
import type { MonsterKind, Vec3 } from '../state.ts';

/** Kept as an alias: MonsterKind includes the v1.1 Snatcher since the integrator added it to state.ts. */
export type MonsterKindX = MonsterKind;

/** One-shot monster sound/animation cues (client maps them to sfx keys + clips). */
export type MonsterCue =
  | 'growl' // hound alert growl (sfx.hound_growl_low)
  | 'huff' // hound alert huff
  | 'bark' // hound charge wind-up bark (sfx.hound_charge_bark)
  | 'sniff' // hound sniffing (bottle / search)
  | 'eat' // hound eating the body
  | 'lunge' // chained kennel hound hits the fence
  | 'creak' // mannequin joint creak
  | 'click' // listener click/tick
  | 'vent' // grate rattle at a vent end
  | 'scream' // listener shriek (grab)
  | 'breath' // creature breath
  | 'rattle' // Snatcher: a vent grate rattles (sfx.listener_vent_crawl + metal_click)
  | 'dust' // Snatcher: dust trickles from a grate / the ceiling at p (visual + faint grit)
  | 'tick' // Snatcher: soft clicking right before a drop
  | 'snatch' // Snatcher drops onto someone (creature_scream + body_fall)
  | 'scratch' // Snatcher: scratching/dragging inside the ducts at a grate (follow it)
  | 'shriek'; // Snatcher: pulled loose, it shrieks and flees into the ducts

export type DirectorEventKind =
  | 'flicker' | 'door_slam' | 'hound_relocate' | 'mannequin_relocate' | 'fixture_failure' | 'radio_static' | 'quiet'
  /** v1.1: a vent grate near a lone player rattles + drops dust (only when a Snatcher is in this contract) */
  | 'vent_rattle';

/** Snatcher drag lifecycle (crew-wide). 'start' carries the drag route; 'tick' (~5 Hz) progress; then 'freed' | 'killed'. */
export interface SnatchEvent {
  id: string;
  victim: string;
  state: 'start' | 'tick' | 'freed' | 'killed';
  /** 'drop' | 'drag' | 'duct' while it lasts */
  phase?: 'drop' | 'drag' | 'duct';
  /** victim position (floor) */
  p: Vec3;
  /** the grate the victim is being dragged into: wall point + inward normal + the rescue spot in front of it */
  grate?: { id: string; p: Vec3; n: [number, number]; front: Vec3 };
  /** floor drag route (x, z) from the snatch point to the grate front */
  route?: [number, number][];
  /** 0..1 toward death */
  progress?: number;
  /** best teammate E-hold fraction 0..1 at the rescue spot */
  pull?: number;
  /** victim struggle 0..1 */
  struggle?: number;
  /** server ms (ctx.now clock) when it ends at the current pace */
  eta?: number;
  /** rescuer */
  by?: string;
}

export interface MonstersEvents {
  /** sound/anim cue at a monster: clients play it positionally when the local camera is within `radius` m */
  'monsters.cue': { id: string; kind: MonsterKindX; cue: MonsterCue; p: Vec3; radius: number };
  /** Listener lock-on telegraph: flicker `space` lights for `ms`; walkies of `squelch` (player ids) squelch */
  'monsters.telegraph': { space: number; ms: number; squelch: string[]; callsign: string | null };
  /** console intercept log line, e.g. text 'INTERCEPT: "…BOILER…"' (meta's console subscribes) */
  'monsters.intercept': { text: string; quote: string; speaker: string | null; callsign: string | null; action: string; at: number };
  /** the Listener woke up: facility-wide flicker for `ms` + every walkie squelches */
  'monsters.wake': { ms: number };
  /** Listener grab lifecycle: the victim has until `until` (server ms) to be freed by a teammate (E shove / crowbar) */
  'monsters.grab': { id: string; victim: string; until: number; state: 'start' | 'freed' | 'killed'; by?: string; p: Vec3 };
  /** fake radio transmission (static + garbled half-voice) through these players' walkies, or an intercom at `p` */
  'monsters.lure': { to: string[]; clip: string; ms: number; p?: Vec3; intercom?: string };
  /** walkie LED flickers red on these players' walkies (Listener tell: no PTT click) */
  'monsters.led': { to: string[]; ms: number };
  /** visor blink, sent only to the blinking player: dark frame from `at` (server ms, ctx.now() clock) for `ms` */
  'monsters.blink': { at: number; ms: number };
  /** pacing director events for clients to render/play */
  'monsters.director': { kind: DirectorEventKind; space?: number; p?: Vec3; ms?: number; to?: string[] };
  /** vent travel: grate sfx at `from` now and at `to` after `ms` */
  'monsters.vent': { id: string; from: Vec3; to: Vec3; ms: number };
  /** a monster killed a player (sent in addition to the interaction track's death flow) */
  'monsters.kill': { victim: string; killer: MonsterKindX; reason: string; detail?: string; p: Vec3 };
  /** v1.1 Snatcher drag (victim camera follows, teammates follow the trail + hold E at the grate) */
  'monsters.snatch': SnatchEvent;
}

export interface MonstersReqs {
  /**
   * Mannequin sightings computed client-side (in frustum, LOS clear, <= 30 m, not during this player's visor blink):
   * monster id -> visible. Send ~10 Hz while a mannequin is active; reports expire after ~300 ms.
   */
  'monsters.see': { args: { s: Record<string, boolean> }; result: { ok: boolean } };
  /** E shove / crowbar hit on a Listener that is grabbing a teammate (server checks range) */
  'monsters.shove': { args: { kind?: 'shove' | 'melee' } | undefined; result: { ok: boolean; freed: boolean } };
  /** Snatcher victim mashing E (each press slows the drag; server rate-limits) */
  'monsters.struggle': { args: Record<string, never> | undefined; result: { ok: boolean; struggle: number } };
  /** teammate holding E at the rescue spot: send { on: true } every <= 250 ms while held, { on: false } on release */
  'monsters.pull': { args: { on?: boolean } | undefined; result: { ok: boolean; pull: number; inRange: boolean } };
  /** Listener decision log lines ('it heard "meet in BOILER" -> ambushed BOILER') for the results screen */
  'monsters.log': { args: Record<string, never> | undefined; result: { lines: string[] } };
}
