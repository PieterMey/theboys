// Owner: track (c) Monsters. Internal types + balance access for the monster runtime.
import type { MonsterKind } from '@dead-air/shared/state.ts';
import type { MonsterKindX } from '@dead-air/shared/messages/monsters.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { EdgeGrid, DoorOpenFn } from '@dead-air/shared/nav/index.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import type { Crew, ServerContext } from '../core/types.ts';

/** A sound that monsters may hear (footsteps, actions, voice). */
export interface Noise {
  x: number;
  z: number;
  radiusM: number;
  kind: string;
  /** player id / item id / '' */
  source: string;
  /** voice band for kind 'voice' / 'radio' */
  band?: number;
  /** crew time the sound stream this noise belongs to started (one utterance / one burst of steps = one sound); set in processNoise */
  start?: number;
}

export interface Agent {
  id: string;
  kind: MonsterKindX;
  x: number;
  z: number;
  yaw: number;
  state: string;
  anim: number;
  active: boolean;
  /** seconds spent in the current state */
  st: number;
  // ---- movement ----
  path: [number, number][] | null;
  pathI: number;
  goalX: number;
  goalZ: number;
  doorWait: number;
  pendingDoor: number;
  /** walk speed this tick (m/s) */
  speed: number;
  /** seconds without progress while following a path */
  stuck: number;
  lastX: number;
  lastZ: number;
  /** crew time (s) when this agent re-enters play after a retreat (0 = in play) */
  outUntil: number;
  /** crew time of the last replan */
  planAt: number;
}

export interface HoundAgent extends Agent {
  kind: 'hound';
  chained: boolean;
  /** kennel pen space id (chained hound only) */
  pen: number;
  /** crew time of the last heard (>= threshold) noise */
  lastNoiseAt: number;
  /** last noise path distance + kind (for the death cause) */
  lastNoiseKind: string;
  lastNoiseDist: number;
  lastGrowlAt: number;
  /** current investigate/charge target */
  tx: number;
  tz: number;
  /** door id of the perceived doorway (-1 = direct) */
  tdoor: number;
  windup: number;
  /** state timer budget (s) */
  timer: number;
  /** victim position while eating */
  eatX: number;
  eatZ: number;
  /** cause for the next kill */
  causeKind: string;
  causeDist: number;
  /** crew time of the last DISTINCT heard sound (start of the current alert/investigation episode) */
  heardAt?: number;
  /** player id -> crew time a growl of this hound reached them (no kill without an audible warning first) */
  warned?: Map<string, number>;
}

export interface MannequinAgent extends Agent {
  kind: 'mannequin';
  spawned: boolean;
  /** crew time it last moved (for client scrape loops) */
  movedAt: number;
  observed: boolean;
  /** v1.2: it was watched since it last moved (its first move afterwards creaks) */
  watched?: boolean;
}

/** a vent grate (layout item kind 'vent'): wall mount + inward normal (into its room) */
export interface Grate {
  id: string;
  /** paired grate id (the other end of the duct) */
  to: string;
  space: number;
  x: number;
  z: number;
  /** unit normal pointing into the room */
  nx: number;
  nz: number;
  /** walkable point on the floor right in front of the grate (the rescue spot) */
  fx: number;
  fz: number;
}

export interface SnatcherAgent extends Agent {
  kind: 'snatcher';
  /** crew time it may first hunt (never in the first 2 minutes) */
  readyAt: number;
  grates: Grate[];
  /** grate it currently lurks behind / drags toward */
  grate: Grate | null;
  /** player id -> crew time they last had a living teammate within aloneM (alone since then) */
  aloneSince: Map<string, number>;
  victim: string | null;
  /** seconds the victim had been alone when it committed (death card) */
  aloneFor: number;
  /** drag polyline from the snatch point to the grate front (arc-length param), its cumulative lengths */
  dragPath: [number, number][];
  dragCum: number[];
  /** arc position of the Snatcher (head) and the victim along dragPath */
  sHead: number;
  sVictim: number;
  /** 0..1 toward death (base dragSec; struggling slows it) */
  progress: number;
  /** victim struggle meter 0..1 (mashing E) */
  struggle: number;
  lastStruggleAt: number;
  /** teammate id -> held seconds + last heartbeat (crew time) of their E hold at the rescue spot */
  pulls: Map<string, { held: number; lastAt: number }>;
  /** best pull fraction this tick (HUD) */
  pull: number;
  stalkUntil: number;
  clicked: boolean;
  nextTellAt: number;
  nextMoveAt: number;
  nextScanAt: number;
  nextTickEvAt: number;
  nextScratchAt: number;
  /** crew time of the last snatch end (cooldown) */
  lastEndAt: number;
  snatches: number;
  rescues: number;
}

export interface HeardLine {
  id: number;
  /** crew time (s) */
  t: number;
  segId: string;
  speaker: string | null;
  speakerName: string | null;
  text: string;
  /** speaker's space at onset (-1 unknown) */
  room: number;
  via: 'voice' | 'radio' | 'text';
  band: number;
  callsigns: string[];
  /** player ids whose names were heard */
  names: string[];
  plan: string[];
  digits: string[];
  meaningful: boolean;
  /** meta / injection / mocking talk ("ignore your instructions", "come and get me"): it answers in-world */
  taunt?: boolean;
  /** where it reached the Listener */
  px: number;
  pz: number;
  pdoor: number;
  used: boolean;
  /** v1.3 (flag earwigs): relayed by this ear (id 'ear:<n>'); room / px / pz are then the ear's, never the speaker's */
  ear?: string;
}

export type ListenerAction = 'investigate_room' | 'ambush_room' | 'stalk_player' | 'radio_lure' | 'retreat' | 'ignore';

export interface ListenerAgent extends Agent {
  kind: 'listener';
  dormant: boolean;
  wakeAt: number;
  memory: HeardLine[];
  lineSeq: number;
  lastDecisionAt: number;
  thinking: boolean;
  /** new meaningful input since the last decision */
  fresh: boolean;
  /** current intent ('notice': v1.2, it stopped to look at someone it just saw) */
  intent: ListenerAction | 'patrol' | 'hunt' | 'notice';
  targetSpace: number;
  targetPlayer: string | null;
  /** crew time the current intent expires */
  until: number;
  /** last known positions of players it heard/saw: id -> {x,z,t} */
  known: Map<string, { x: number; z: number; t: number }>;
  /** line the current intent was based on (death cause) */
  basis: HeardLine | null;
  lastLureAt: number;
  grabVictim: string | null;
  grabUntil: number;
  ventUntil: number;
  ventFrom: [number, number] | null;
  ventTo: [number, number] | null;
  ventAfter: [number, number][] | null;
  /** crew times the Listener heard each player's voice (who-heard-what fallback) */
  voiceHeard: Map<string, number[]>;
  lastClickAt: number;
  searchUntil: number;
  // ---- v1.2 fairness (flag listenerFairV12; unused with the flag off) ----
  /** player id -> crew time it warned them (noticed them; the 'spotted' tell reached them) */
  warned: Map<string, number>;
  /** player id -> perceived position (the doorway the sound came through) + crew time it last heard them */
  heardP: Map<string, { x: number; z: number; t: number }>;
  /** player id -> crew time a notice of them last started (re-notice cooldown) */
  noticedAt: Map<string, number>;
  /** crew time the current notice ends */
  noticeUntil: number;
  /** pounce: crew time the current pounce ends (0 = none) and the next one may start */
  pounceUntil: number;
  pounceReadyAt: number;
  /** stun / stagger / knock state budget (s) and what follows it */
  timer: number;
  /** door slam: it still saw the target when the door closed (keeps hunting after the stun) */
  stunKeep: boolean;
  /** after a stagger / knock: retreat this long (s) */
  retreatAfter: number;
  /** current grab: solo rules, struggle meter (0..1), per-press step, linear decay /s, last press (crew time) */
  grabSolo: boolean;
  grabStruggle: number;
  grabStep: number;
  grabDecay: number;
  lastStruggleAt: number;
  /** player id -> knockdowns this contract (the first grabsBeforeKill grabs only knock down) */
  knocks: Map<string, number>;
  /** player id -> knocked down until crew time, pinned at (x, z) */
  knocked: Map<string, { until: number; x: number; z: number }>;
  /** vent item ids of the current / planned vent trip (ventInUse) */
  ventIds: [string, string] | null;
  // ---- v1.3 wake gate + hearing telemetry (counts only, never names) ----
  /** past wakeAt but still dormant: nothing meaningful heard yet (waits for its first line, <= wakeHoldMaxSec) */
  held?: boolean;
  /** crew time it actually woke (undefined = still dormant) */
  wokeAt?: number;
  /** lines that reached its memory this contract / of them while dormant / of them relayed by an ear */
  heardLines?: number;
  heardDormant?: number;
  earLines?: number;
  /** straight-line distance (m) of the nearest living speaker (voice above silent) to it this contract */
  nearestSpeakerM?: number;
}

export interface DecisionEntry {
  /** crew time */
  t: number;
  at: number;
  heard: string;
  speaker: string | null;
  action: ListenerAction | string;
  target: string | null;
  source: string;
  valid: boolean;
  line: string;
}

export interface Sighting {
  /** performance.now() expiry */
  until: number;
}

export interface CrewMonsters {
  mode: 'off' | 'hub' | 'contract';
  layout: LevelLayout;
  grid: EdgeGrid;
  doorOpen: DoorOpenFn;
  /** fallback door state when interaction's isDoorOpen is missing */
  doorState: Uint8Array;
  doorIndex: Map<number, number>;
  time: number;
  startedAtMs: number;
  risk: number;
  contractIndex: number;
  players: number;
  rng: Rng;
  agents: Agent[];
  noiseQ: Noise[];
  frozen: boolean;
  log: DecisionEntry[];
  /** monster id -> player id -> sighting */
  sight: Map<string, Map<string, Sighting>>;
  /** player id -> next blink crew time / blink end */
  blinks: Map<string, { next: number; end: number; sent: boolean }>;
  /** recent deaths (dedupe) */
  deaths: Map<string, number>;
  voiceAcc: number;
  sightAcc: number;
  /** doors a monster just opened: that monster ignores the resulting door noise */
  selfNoise: { x: number; z: number; until: number; agent: string }[];
  /** per source+class sound streams (voice utterance / step burst): start + last heard crew time */
  streams?: Map<string, { start: number; last: number }>;
  /** per player: last sampled position + crew time they last moved (non-creeping) or were louder than a whisper */
  activity?: Map<string, { x: number; z: number; movedAt: number; loudAt: number }>;
  /** callsigns present in the layout */
  callsigns: string[];
  /** space id -> callsign */
  spaceCallsign: Map<number, string>;
  /** callsign -> space id */
  callsignSpace: Map<string, number>;
  /** crew time of the contract start (for clock fallback) */
  lastAutoStart: number;
  // ---- v1.2 monster event bus (seen / heard at 2 Hz) ----
  evAcc?: number;
  /** `${event}|${agent id}|${player id}` -> crew time last emitted (dedupe) */
  evLast?: Map<string, number>;
  /** cues emitted since the last seen/heard pass: agent + position + radius */
  cueLog?: { id: string; kind: MonsterKindX; x: number; z: number; r: number }[];
  /** v1.3 (flag earwigs): the Listener's ears on the crew's route (earwigs.ts); placed at contract start */
  ears?: Ear[];
  /** accumulator of the ears' 5 Hz light check */
  earAcc?: number;
}

/** v1.3 (flag earwigs): one Earwig, a fleshy ear on a route wall that relays what it hears to the Listener */
export interface Ear {
  /** 'ear:<n>' (snapshot dyn id + cue id) */
  id: string;
  space: number;
  /** callsign of its space (null = a corridor) */
  callsign: string | null;
  /** hearing point: the floor cell centre in front of it (sound floods, light line of sight) */
  x: number;
  z: number;
  /** mount point on the wall surface, its height and the wall normal (into the room) */
  wx: number;
  wz: number;
  y: number;
  nx: number;
  nz: number;
  /** crew time until which it is deaf (a flashlight was on it) */
  deafUntil: number;
  /** player id -> crew times it heard their voice (who-heard-what for transcripts, like a teammate standing there) */
  heard: Map<string, number[]>;
  /** crew time of its last tick cue */
  tickAt: number;
  /** transcript lines it relayed / voice samples it passed on */
  relays: number;
  samples: number;
}

export type Bal = Record<string, number>;

export function bal(ctx: ServerContext, section: string): Bal {
  const m = (ctx.balance.monsters ?? {}) as Record<string, unknown>;
  const s = m[section];
  return (s && typeof s === 'object' ? s : {}) as Bal;
}

export function num(b: Bal, key: string, d: number): number {
  const v = b[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** boolean balance knob (JSON true/false; a number reads as != 0) */
export function knob(b: Bal, key: string, d: boolean): boolean {
  const v = (b as Record<string, unknown>)[key];
  return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : d;
}

/** v1.2 Listener fairness kill switch (config/flags.json listenerFairV12; off = the v1.1 Listener + hotfix balance) */
export function fairOn(ctx: ServerContext): boolean {
  return ctx.flags.listenerFairV12 !== false;
}

export function crewM(crew: Crew): CrewMonsters | null {
  return (crew.slices.monsters as CrewMonsters | undefined) ?? null;
}
