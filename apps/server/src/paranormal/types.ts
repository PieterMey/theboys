// Owner: env-paranormal (v1.2). Internal types of the paranormal core. The core (plan.ts, kinds.ts, gates.ts) only sees a
// ParaWorld, so the same code runs against a live crew (world.ts) and against the simulated crews in tests/paranormal.
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { MirrorSpot } from '@dead-air/shared/procgen/mirrors.ts';
import type { MovableRef } from '@dead-air/shared/procgen/movables.ts';
import type { LoreSpot } from '@dead-air/shared/procgen/lore.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import type { ParanormalEvent, ParanormalKind } from '@dead-air/shared/messages/paranormal.ts';
import type { PhenomenonRecord } from './api.ts';

export type Tier = 0 | 1 | 2;
export type DirectorPhase = 'build' | 'peak' | 'fade' | 'relax';

export interface ParaPlayer {
  id: string;
  name: string;
  x: number;
  z: number;
  /** radians, 0 = facing +Z */
  yaw: number;
  /** flashlight on */
  light: boolean;
  /** alive and connected */
  alive: boolean;
  /** in the van cargo or the sealed cab */
  inVan: boolean;
  /** hiding spot item id (locker) or null */
  hidden: string | null;
  /** holds a Core handle */
  core: boolean;
  /** grabbed / snatched right now */
  grabbed: boolean;
}

export interface ParaMonster { id: string; kind: string; x: number; z: number; active: boolean; state: string }

export interface DirectorView {
  phase: DirectorPhase;
  tension: Record<string, number>;
  events: readonly { t: number; kind: string; source: string }[];
}

/** Everything the core reads from (and the few things it changes in) the game. */
export interface ParaWorld {
  /** server ms (ctx.now clock) */
  now(): number;
  readonly layout: LevelLayout;
  readonly grid: EdgeGrid;
  /** live door state */
  readonly doorOpen: DoorOpenFn;
  players(): readonly ParaPlayer[];
  monsters(): readonly ParaMonster[];
  director(): DirectorView | null;
  /** in-game minutes since 22:00, -1 = unknown (the core falls back to its own contract clock) */
  clockMin(): number;
  /** real seconds per contract (clock fallback) */
  contractRealSec(): number;
  blackout(): boolean;
  coreLifted(): boolean;
  lightsOn(space: number): boolean;
  setLights(space: number, on: boolean): void;
  mirrors(): readonly MirrorSpot[];
  movables(): readonly MovableRef[];
  loreSpots(): readonly LoreSpot[];
  /** THEMES[theme].haunt */
  themeHaunt(): number;
  /** the Snatcher sits behind a grate right now */
  snatcherLurking(): boolean;
}

/** what the core sends out (index.ts maps these to ctx.emit / emitPhenomenon) */
export interface ParaOut {
  event(ev: ParanormalEvent): void;
  end(id: number, reason: 'seen' | 'lit' | 'interrupted' | 'timeout', to?: string[]): void;
  reveal(id: number, at: number, to?: string[]): void;
  phenomenon(rec: PhenomenonRecord): void;
}

/** budget / novelty group of a kind */
export type ParaGroup =
  | 'dark_walk' | 'mirror_writing' | 'mirror_figure' | 'presence' | 'knock' | 'poltergeist' | 'object_fall' | 'footprints'
  | 'cold_spot' | 'brownout_breath' | 'stretch';

export interface ActiveEv {
  ev: ParanormalEvent;
  rec: PhenomenonRecord;
  /** server ms the active part ends (Infinity while armed) */
  endAt: number;
  /** mirror writing: still waiting for its first witness */
  armed: boolean;
  /** presence: server ms a beam first lit it (0 = not lit) */
  litSince: number;
  /** dark walk: pending space kills (server ms) */
  kills?: { space: number; at: number; done: boolean }[];
}

export interface DarkSpace {
  space: number;
  walk: number;
  /** server ms a switchless space revives (Infinity = needs its switch) */
  reviveAt: number;
  /** the switch has to be flipped back on by a player */
  needsSwitch: boolean;
  /** lightsOn turned false after the kill (switch spaces revive on the next true) */
  seenOff: boolean;
  lights: string[];
}

export interface CrewPara {
  /** layout hash + contract index this state belongs to */
  key: string;
  layout: LevelLayout;
  rng: Rng;
  /** server ms the haunt started (contract clock fallback + record times) */
  startedAt: number;
  nextAt: number;
  lastAt: number;
  /** pid -> server ms last targeted */
  perPlayer: Map<string, number>;
  used: Partial<Record<ParaGroup, number>>;
  recent: ParaGroup[];
  t1Done: boolean;
  t2Done: boolean;
  /** pid -> first-mirror guarantee state ('done' once fired / given up) */
  mirrorGuard: Map<string, { since: number; mirror: string; done: boolean }>;
  tensionEma: number;
  emaAt: number;
  active: Map<number, ActiveEv>;
  residue: Map<number, ParanormalEvent>;
  records: PhenomenonRecord[];
  dark: Map<number, DarkSpace>;
  lastDarkWalkAt: number;
  quietUntil: number;
  wokeAt: number;
  directorEventAt: number;
  dirEvSeen: number;
  dirEvLast: string;
  /** last valid Listener stalk decision (target pid) */
  stalk: { pid: string; at: number } | null;
  /** last valid Listener investigate / ambush room */
  room: { callsign: string; space: number; at: number } | null;
  loreTargets: string[];
  /** pid -> seen token bucket */
  buckets: Map<string, { tokens: number; at: number }>;
  /** last block check (ms) */
  checkAt: number;
  /** next forced (T1/T2 guarantee) attempt after a miss (ms) */
  forceAt: number;
  /** listener active last tick (wake detection without the event bus) */
  listenerActive: boolean | null;
  stats: { planned: number; noop: number; blocked: number; failed: number; emitted: number; planMs: number; planMax: number; ticks: number; tickMs: number; why: string; misses: Record<string, number> };
  /** planned slots (newest last, capped): the drawn gap, H and director phase at the time, and what happened */
  trace: { at: number; H: number; phase: DirectorPhase; gapSec: number; outcome: 'noop' | 'event' | 'fail'; kind?: string }[];
}

export interface BuildCtx {
  w: ParaWorld;
  st: CrewPara;
  b: ParaBalance;
  now: number;
  tierCap: Tier;
  /** dbg / guarantee: skip the soft gates (monster distance stays) */
  force: boolean;
  target?: string;
  space?: number;
}

export interface Built {
  kind: ParanormalKind;
  tier: Tier;
  target: string | null;
  ev: Omit<ParanormalEvent, 'id' | 'at' | 'seed' | 'kind' | 'tier'>;
  tell?: boolean;
  /** dark walk schedule */
  kills?: { space: number; at: number }[];
  armed?: boolean;
  /** active duration override (server ms after `at`); default ev.ms */
  activeMs?: number;
}

/** resolved config/balance/paranormal.json (defaults when a key is missing) */
export interface ParaBalance {
  enabled: boolean;
  tells: { stalk: boolean; intercept: boolean; ambushCold: boolean };
  leadMs: number;
  gapSlowSec: number;
  gapFastSec: number;
  gapJitter: number;
  relaxMult: number;
  firstDelaySec: number;
  retrySec: number;
  haunt: { base: number; clock: number; tension: number; blackout: number; core: number; emaSec: number };
  tierAt: [number, number, number];
  spacingSec: number;
  perPlayerSec: number;
  blockAfterWakeSec: number;
  blockAfterDirectorSec: number;
  quietSec: number;
  noopChance: number;
  budgets: Record<string, number>;
  weights: Record<string, number>;
  tierBoost: number;
  kinds: Record<string, boolean>;
  guarantees: { t1ClockMin: number; t2ClockMin: number; mirrorM: number; mirrorPendingSec: number };
  gates: { monsterM: number; mannequinLightM: number; grateM: number; vanM: number };
  darkWalk: { minM: number; maxM: number; minFixtures: number; stepMinMs: number; stepMaxMs: number; dieMs: number; gapSec: number; stalkSec: number; stalkChance: number; loneM: number; reviveMinSec: number; reviveMaxSec: number; maxSpaces: number };
  writing: { nearM: number; roomSec: number; fog: number; fogMs: number; revealMs: number; revealLeadMs: number; maxArmSec: number; lookM: number; lookDeg: number };
  figure: { armSec: number; nearM: number; behindMin: number; behindMax: number; holdMs: number; lookM: number };
  presence: { aheadMin: number; aheadMax: number; msMin: number; msMax: number; litM: number; litSec: number; litDeg: number; approachM: number; darkFixtureM: number; laneM: number };
  silhouette: { minM: number; maxM: number; coneDeg: number; msMin: number; msMax: number; approachM: number; brownMs: number; depth: number; backM: number };
  knock: { minM: number; maxM: number; msMin: number; msMax: number; lockerChance: number; beyondM: number; hearM: number };
  props: { minM: number; maxM: number; slideMin: number; slideMax: number; msMin: number; msMax: number; hearM: number };
  footprints: { fromMinM: number; fromMaxM: number; strideM: number; stepMs: number; fadeSec: number; loreChance: number; maxPrints: number };
  cold: { minM: number; maxM: number; rMin: number; rMax: number; msMin: number; msMax: number; density: number };
  breath: { msMin: number; msMax: number; depth: number; puffs: number };
  seenPerSec: number;
  witnessM: number;
}
