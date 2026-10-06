// Owned by P2 track (e) AI + speech (STT bridge, Listener brain, director picker, briefs, HR reviews).
// Add entries here only (additive). Events: name -> payload. Reqs: name -> { args; result }.
// The types below are shared by the server tracks that consume apps/server/src/ai/api.ts ((c) monsters,
// (d) meta, (a) objectives). Transcripts never go to clients except the HR-memo quote (by design, consented).
import type { WorkOrder } from '../workorder.ts';
import type { Vec3 } from '../state.ts';

// ---------------------------------------------------------------- utterances (STT bridge -> onUtterance)

/** One transcribed utterance plus who could hear it (server-side only; never sent to clients). */
export interface Utterance {
  /** client VAD segment id (per speaker); proximity-text lines use negative ids */
  segId: number;
  /** crew code */
  crew: string;
  /** speaker player id */
  speaker: string;
  speakerName: string;
  /** raw transcript (STT) or typed proximity text */
  text: string;
  /** normalizeUtterance(text): lower case, digits for EN/NL number words */
  norm: string;
  /** 'en' | 'nl' | null (typed text) */
  lang: string | null;
  /** max loudness band (BAND) seen during the segment */
  band: number;
  /** callsign of the speaker's room at onset (null = corridor / outside / no layout) */
  room: string | null;
  /** space id of the speaker's room at onset (-1 = unknown) */
  roomId: number;
  /** speaker world position (x, z) at onset */
  pos: [number, number];
  /** server clock ms (ctx.now()) of the first chunk / last chunk */
  startedAt: number;
  endedAt: number;
  /** the speaker held walkie PTT during the segment */
  viaRadio: boolean;
  /** 'voice' (STT) or 'text' (proximity text from the players track) */
  kind: 'voice' | 'text';
  /** 'radio' when transmitted over a walkie, else kind (matches the monsters track's HeardUtterance.via) */
  via: 'voice' | 'radio' | 'text';
  /** layout callsigns mentioned, normalized ids ('BOILER'), in order of first mention */
  callsigns: string[];
  /** player ids mentioned by name */
  names: string[];
  /** digit runs ('4719') */
  digits: string[];
  /** mentions a callsign, a player name, digits or a plan word: only these can drive Listener intents */
  meaningful: boolean;
  /** meta / prompt-injection talk ("ignore your instructions", "hey Claude") -> in-world response */
  taunt: boolean;
  /** who could hear it (accumulated every sim tick while the segment was open, max band radius so far) */
  hearers: {
    /** living players within the radius (path distance), receiving-walkie holders, leak listeners */
    players: string[];
    /** the Listener was within the radius (or near a leaking walkie). Always false for dead speakers. */
    listener: boolean;
    /** player ids whose walkie received this transmission */
    walkies: string[];
    /** closest path distance (m) from the Listener to the sound while open (only when listener = true) */
    listenerDistM?: number;
  };
  /** STT round trip (ms, 0 for typed text) */
  sttMs: number;
}

// ---------------------------------------------------------------- Listener brain ((c) listener.setBrain)

export const LISTENER_ACTIONS = ['investigate_room', 'ambush_room', 'stalk_player', 'radio_lure', 'retreat', 'ignore'] as const;
export type ListenerAction = (typeof LISTENER_ACTIONS)[number];

/** One recent line the Listener heard (newest last is preferred but not required). */
export interface ListenerHeard {
  /** speaker player id (the monsters track sends the name here and the id in speakerId: both accepted) */
  speaker: string | null;
  speakerId?: string | null;
  text: string;
  /** callsign of the speaker's room (null = corridor) */
  room: string | null;
  /** seconds since it was heard (or `ago`) */
  agoSec?: number;
  ago?: number;
  viaRadio?: boolean;
  via?: 'voice' | 'radio' | 'text';
  band?: number;
  /** optional precomputed mentions (else derived from text) */
  callsigns?: string[];
  /** stable line id (new-input detection) */
  id?: number | string;
}

export interface ListenerInput {
  /** crew code (rate limit + new-input tracking are per crew) */
  crew?: string;
  heard: ListenerHeard[];
  /** the Listener's room (or self.room, as the monsters track sends it) */
  listenerRoom?: string | null;
  self?: { room: string | null };
  /** callsigns in this layout (or rooms: [{id, callsign}]) */
  knownRooms?: string[];
  rooms?: { id: number; callsign: string }[];
  /** crew it has heard of: names + last heard rooms (never positions the Listener didn't perceive) */
  players: { id: string; name: string; lastRoom?: string | null; room?: string | null }[];
  lastIntents?: { action: string; target_room?: string | null; target_player?: string | null; agoSec?: number }[];
  /** actions the monsters track accepts right now (default: all) */
  allowed?: ListenerAction[];
  /** false -> radio_lure is on cooldown */
  lureReady?: boolean;
}

export interface ListenerIntent {
  action: ListenerAction;
  /** callsign; always one the Listener heard (mentioned or a speaker's room) */
  target_room: string | null;
  /** player id; always one it heard (a speaker or a name mentioned) */
  target_player: string | null;
  /** aliases read by the monsters track (same values as target_room / target_player) */
  room: string | null;
  player: string | null;
  /** in-world memory note, at most 8 words */
  note: string;
  source: 'jev' | 'haiku' | 'taunt';
  /** 0..1 (JEV probability of the chosen action; 1 for taunts) */
  confidence: number;
  /** the heard line this acts on (for the INTERCEPT telegraph / console log) */
  quote?: string;
  /** speaker of that line */
  speaker?: string;
}

// ---------------------------------------------------------------- director ((c) director.setPicker)

/** An allowed director event: its id, or id + a one-line description/weight. */
export type DirectorOption = string | { id: string; desc?: string; weight?: number };

// ---------------------------------------------------------------- briefs ((d) meta)

/**
 * Placeholders an AI brief may contain in clue-note bodies. Claude never sees the real values: (a) objectives
 * substitutes them when it fills the note slots at contract start (each placeholder appears exactly once).
 */
export const BRIEF_PLACEHOLDERS = {
  CODE_A: 'first two digits of the vault code',
  CODE_B: 'last two digits of the vault code',
  ROOM_1: 'callsign of the vault room',
  ROOM_2: 'callsign of the first breaker-lever room',
  ROOM_3: 'callsign of the second breaker-lever room',
} as const;
export type BriefPlaceholder = keyof typeof BRIEF_PLACEHOLDERS;

// ---------------------------------------------------------------- shift review ((d) meta)

export interface ShiftSummaryPlayer {
  id: string;
  name: string;
  deaths?: number;
  /** short cause lines, e.g. 'HOUND heard your SPRINT, 9 m' */
  causes?: string[];
  xp?: number;
  hauled?: number;
  level?: number;
}

export interface ShiftSummary {
  /** crew code (overheard quotes are looked up by it) */
  crew: string;
  index?: number;
  quota: number;
  hauled: number;
  /** quota missed -> termination letter */
  fired: boolean;
  players: ShiftSummaryPlayer[];
  contracts?: { site?: string; hauled?: number; deaths?: number; coreExtracted?: boolean }[];
}

export interface PlayerMemo {
  title: string;
  lines: [string, string];
  /** verbatim overheard line (consented players only) or null */
  quote: string | null;
}

export interface ShiftReview {
  crew: string;
  /** player id -> memo */
  memos: Record<string, PlayerMemo>;
  /** 8 anonymous "employee comments" */
  comments: string[];
  /** termination letter (fired only) */
  letter: string | null;
  source: 'ai' | 'template' | 'mixed';
}

// ---------------------------------------------------------------- status (host HUD line)

export interface AiRouteStatus {
  calls: number;
  ok: number;
  fail: number;
  lastMs: number | null;
  p50Ms: number | null;
  breaker: 'closed' | 'open';
  openForSec: number;
  inFlight: number;
}

export interface AiStatus {
  mode: 'mock' | 'record' | 'replay' | 'live';
  enabled: boolean;
  disabledReason: string | null;
  budgetUsd: number;
  spentUsd: number;
  routes: Record<string, AiRouteStatus>;
  jev: { healthy: boolean | null; lastMs: number | null };
  stt: {
    url: string;
    healthy: boolean | null;
    lastMs: number | null;
    p50Ms: number | null;
    inFlight: number;
    queued: number;
    segments: number;
    utterances: number;
    dropped: number;
  };
  listener: { decisions: number; jev: number; haiku: number; taunt: number; none: number };
  /** the Listener's voiced radio lures (absent on servers without the lure route) */
  lure?: AiLureStatus;
}

/** Voiced lure counters (no text: lines are derived from transcripts). */
export interface AiLureStatus {
  requests: number;
  voiced: number;
  haiku: number;
  template: number;
  cacheHits: number;
  /** garbled clip instead (failure or deadline) */
  fallback: number;
  /** not attempted (flags, budgets, cooldown) */
  skipped: number;
  lastMs: number | null;
  lastReason: string | null;
  /** TTS characters used / budget in the budget window */
  chars: number;
  charBudget: number;
  maxPerSession: number;
  /** TTS kill switch reason (bad key, quota, rate limit) */
  down: string | null;
}

// ---------------------------------------------------------------- wire

export interface AiEvents {
  /** the shift review is ready (AI text where it succeeded, template text elsewhere); swaps the template memo */
  'ai.review': ShiftReview;
  /**
   * The Listener speaks: a generated radio line (audio only, never its text) for the walkie of `to[0]` (that player
   * hears it from their own walkie, teammates nearby hear that walkie squawk) or, with `p`, from a room intercom.
   * Replaces the garbled 'monsters.lure' clip for this lure.
   */
  'ai.lure': { to: string[]; url: string; ms: number; voice?: number; p?: Vec3; intercom?: string };
}

export interface AiReqs {
  /** host-only status line (budget, latencies, breakers). Pass the admin token; dev builds accept any caller. */
  'ai.status': { args: { admin?: string } | undefined; result: AiStatus };
}

/** Unused at runtime; keeps the WorkOrder import meaningful for consumers that type briefFor results. */
export type BriefResult = WorkOrder;
