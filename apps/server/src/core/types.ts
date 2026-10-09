// Server plugin API (integrator-owned). Tracks receive a ServerContext in `install(ctx)` and plug in via
// registerSystem / registerReq / registerDbg / onVoiceChunk / hooks. Keep this surface small and typed.
import type { WebSocket } from 'ws';
import type { ClientMsg, ServerMsg, VoiceChunkHeader } from '@dead-air/shared/envelope.ts';
import type { EventName, EventPayload, ReqName, ReqArgs, ReqResult } from '@dead-air/shared/messages/index.ts';
import type { CrewPublic, FullState, Phase, Snapshot } from '@dead-air/shared/state.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import type { AppConfig, Balance, Flags, ServerEnv } from './config.ts';

export type PoseMsg = Extract<ClientMsg, { op: 'pose' }>;
export type LoudMsg = Extract<ClientMsg, { op: 'loud' }>;
export type HelloMsg = Extract<ClientMsg, { op: 'hello' }>;
export type WelcomeMsg = Extract<ServerMsg, { op: 'welcome' }>;

/** Last accepted pose of a player (seq/p/yaw/pitch/stance/anim/light as sent by the client). */
export type PlayerPose = Omit<PoseMsg, 'op'>;

export interface ServerPlayer {
  /** stable id, derived from a hash of the player key (survives reconnects and server restarts) */
  id: string;
  /** secret browser player key (never send to other clients) */
  key: string;
  name: string;
  profile: Profile;
  connected: boolean;
  ready: boolean;
  alive: boolean;
  consent: { transcribe: boolean; mimic: boolean };
  /** career level shown in PlayerPublic (meta track updates it) */
  level: number;
  /** last accepted pose; initialised to the origin, the players track sets the spawn in hooks.join */
  pose: PlayerPose;
  /** performance.now() of the last accepted pose (0 = never) */
  poseAt: number;
  /** current loudness band (BAND) and radio PTT from the latest 'loud' message */
  band: number;
  radio: 0 | 1;
  socket: WebSocket | null;
  /** resume token (secret, only sent to this player) */
  resume: string;
  /** performance.now() of the first join (leader = earliest connected) */
  joinedAt: number;
  isLeader: boolean;
  /** performance.now() when the socket dropped (0 while connected) */
  disconnectedAt: number;
  /** per-track per-player scratch data, keyed by track name (e.g. slices.players, slices.voice) */
  slices: Record<string, unknown>;
  /** v1.3 P2b (additive): a scripted test client (its hello said build 'bot'); set on every hello by core/crews.ts.
   *  meta's drive wait (crewLoaded) never waits for one. Also: core/crews.ts isBot(p). */
  bot?: boolean;
}

export interface Crew {
  code: string;
  phase: Phase;
  players: Map<string, ServerPlayer>;
  layout: LevelLayout | null;
  /** per-track mission/crew data keyed by track name (e.g. slices.objectives); tracks own their key */
  slices: Record<string, unknown>;
  createdAt: number;
  /** simulation tick counter (30 Hz) */
  tick: number;
  password?: string;
  /** performance.now() when the crew became empty (0 = has players) */
  emptySince: number;
}

export interface CrewRegistry {
  get(code: string): Crew | undefined;
  list(): Crew[];
  /** create a crew; random code from CREW_CODE_ALPHABET unless given */
  create(code?: string, opts?: { password?: string }): Crew;
  remove(code: string): void;
  toPublic(crew: Crew): CrewPublic;
  /** connected players of a crew */
  connected(crew: Crew): ServerPlayer[];
  /** recompute leader + send the 'crew' event to everyone in the crew */
  broadcastRoster(crew: Crew): void;
  /** find a player by id across crews */
  findPlayer(id: string): { crew: Crew; player: ServerPlayer } | undefined;
  /** send err 'kicked', close the socket and remove the player (hooks.leave final) */
  kick(crew: Crew, id: string, reason?: string): void;
}

export interface ServerSystem {
  name: string;
  /** lower runs first; see SYSTEM_ORDER */
  order: number;
  /** dt in seconds (fixed 1/30) */
  tick(dt: number, crew: Crew, ctx: ServerContext): void;
}

/** Suggested system order bands (server). */
export const SYSTEM_ORDER = {
  net: 10,
  players: 20,
  voice: 30,
  level: 40,
  interaction: 50,
  objectives: 60,
  monsters: 70,
  director: 75,
  ai: 80,
  meta: 90,
} as const;

export type ReqHandler<R extends ReqName> = (
  crew: Crew,
  player: ServerPlayer,
  args: ReqArgs<R>,
) => ReqResult<R> | Promise<ReqResult<R>>;

export type DbgHandler = (crew: Crew, player: ServerPlayer, args: unknown) => unknown;

export type VoiceChunkHandler = (crew: Crew, player: ServerPlayer, header: VoiceChunkHeader, pcm: Int16Array) => void;

export interface EmitOpts {
  /** only these player ids */
  to?: string[];
  /** everyone except these player ids */
  except?: string[];
}

export interface ServerHooks {
  /** after a player joins or resumes (before Welcome is built). Set spawn pose / per-player slices here. */
  join: ((crew: Crew, player: ServerPlayer, info: { resumed: boolean; created: boolean }) => void)[];
  /** socket dropped (final=false, slot held for resume) or player removed (final=true: expired/kicked) */
  leave: ((crew: Crew, player: ServerPlayer, info: { final: boolean; reason: 'disconnect' | 'expired' | 'kicked' | 'replaced' }) => void)[];
  /** inside setPhase, after crew.phase/layout changed, before the per-player 'phase' events are sent */
  phase: ((crew: Crew, from: Phase, to: Phase) => void)[];
  /** a client pose arrived; mutate it (clamp) or return false to reject it */
  pose: ((crew: Crew, player: ServerPlayer, pose: PlayerPose) => boolean | void)[];
  /** a 'loud' message arrived (player.band / player.radio already updated) */
  loud: ((crew: Crew, player: ServerPlayer, prevBand: number) => void)[];
  /** once per crew per snapshot (20 Hz): fill crew-wide data (monsters, dyn) */
  crewSnapshot: ((crew: Crew, snap: Snapshot) => void)[];
  /**
   * per receiver per snapshot: mutate the receiver's snapshot (e.g. aud, filtering).
   * Arrays are per-receiver copies, but their elements are shared: replace elements, never mutate them.
   */
  snapshot: ((crew: Crew, receiver: ServerPlayer, snap: Snapshot) => void)[];
  /** fill this player's FullState slices (welcome, resume, phase change) */
  fullState: ((crew: Crew, player: ServerPlayer, state: FullState) => void)[];
  /** mutate the Welcome message (e.g. iceServers from the voice track) */
  welcome: ((crew: Crew, player: ServerPlayer, msg: WelcomeMsg) => void)[];
  /** config/flags/balance were re-read (objects are updated in place) */
  config: (() => void)[];
}

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface ServerContext {
  /** full config; flags/balance/env are the same objects (updated in place on reload) */
  cfg: AppConfig;
  flags: Flags;
  balance: Balance;
  env: ServerEnv;
  log(scope: string): Logger;
  crews: CrewRegistry;
  registerSystem(sys: ServerSystem): void;
  registerReq<R extends ReqName>(name: R, handler: ReqHandler<R>): void;
  /** dev-only request (NODE_ENV=development); name is prefixed with 'dbg.' if missing. No-op otherwise. */
  registerDbg(name: string, handler: DbgHandler): void;
  onVoiceChunk(fn: VoiceChunkHandler): void;
  /** reliable event to everyone in the crew (filtered by opts) */
  emit<E extends EventName>(crew: Crew, e: E, d: EventPayload<E>, opts?: EmitOpts): void;
  /** raw message to one player (no-op if disconnected) */
  send(player: ServerPlayer, msg: ServerMsg): void;
  /** WebRTC signalling relay: deliver {op:'sig', from, d} to player `to` in the crew. Core already relays client 'sig' msgs. */
  sendSig(crew: Crew, from: string, to: string, d: unknown): void;
  /** toast line for the crew ('notice' event) */
  notice(crew: Crew, text: string, kind?: 'info' | 'warn' | 'error'): void;
  hooks: ServerHooks;
  /** change phase (+ optional new layout); runs hooks.phase then sends each player a 'phase' event with its FullState */
  setPhase(crew: Crew, phase: Phase, layout?: LevelLayout | null): void;
  /** build a FullState for a player (runs hooks.fullState) */
  buildFullState(crew: Crew, player: ServerPlayer): FullState;
  /** server clock in ms (epoch-based, sub-ms), same clock as Snapshot.t / Event.t */
  now(): number;
  /** re-read config/flags.json + config/balance/*.json (also on SIGHUP and dbg.reloadConfig) */
  reloadConfig(): void;
}
