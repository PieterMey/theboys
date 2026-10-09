// FROZEN aggregation (P0). Each track owns ONE file in this folder and only adds entries to its own
// interfaces. Never edit another track's file; never rename/remove entries (additive only).
import type { NetEvents, NetReqs } from './net.ts';
import type { LevelEvents, LevelReqs } from './level.ts';
import type { PlayersEvents, PlayersReqs } from './players.ts';
import type { VoiceEvents, VoiceReqs } from './voice.ts';
import type { ObjectivesEvents, ObjectivesReqs } from './objectives.ts';
import type { InteractionEvents, InteractionReqs } from './interaction.ts';
import type { MonstersEvents, MonstersReqs } from './monsters.ts';
import type { MetaEvents, MetaReqs } from './meta.ts';
import type { AiEvents, AiReqs } from './ai.ts';
import type { ParanormalEvents, ParanormalReqs } from './paranormal.ts';
import type { FieldguideEvents, FieldguideReqs } from './fieldguide.ts';

// ---- integrator-owned core requests (v1.3, additive; there is no messages/core.ts this round) ----

/** v1.3 telemetry v2 (P5), once per join and when the preset or backend changes. Buckets only: never the raw GPU
 *  renderer string, never a name. */
export interface CoreDiagJoin {
  kind: 'join';
  why: 'join' | 'preset' | 'backend';
  /** 'nvidia' | 'amd' | 'intel' | 'apple' | 'qualcomm' | 'arm' | 'imagination' | 'microsoft' | 'google' | 'mesa' | 'other' | 'unknown' */
  gpuVendor: string;
  /** 'high' | 'mid' | 'low' | 'igpu' | 'software' | 'unknown' */
  gpuTier: string;
  backend: 'webgpu' | 'webgl2' | 'none';
  /** why WebGPU is not in use: '' (it is), 'forced' (?webgl=1), 'no-api', 'no-adapter', 'device-error', 'init-error', 'unknown' */
  fallback: string;
  /** brand + major version, e.g. 'chrome 141', 'edge 140', 'firefox 143', 'safari 18', 'electron 44' */
  browser: string;
  /** 'windows' | 'mac' | 'linux' | 'android' | 'ios' | 'chromeos' | 'other' */
  os: string;
  shell: 'desktop' | 'browser';
  cores: number | null;
  /** navigator.deviceMemory (GB, Chromium only, capped at 8 by the browser) */
  memGB: number | null;
  /** KHR_parallel_shader_compile on the WebGL2 context (null on WebGPU) */
  parallel: boolean | null;
  preset: string;
  presetSource: 'url' | 'stored' | 'auto' | 'safe';
}

/** v1.3 telemetry v2 (P5): one per ~30 s window while joined */
export interface CoreDiagWindow {
  kind: 'window';
  sec: number;
  frames: number;
  /** largest gap between two animation frames (ms) */
  gapMax: number;
  /** time the page was hidden in this window (ms) */
  hiddenMs: number;
  /** Long Animation Frames (null = the browser has no LoAF): count, summed blocking ms, longest frame ms, its top script */
  loaf: { n: number; blockMs: number; maxMs: number; top: string } | null;
  /** render pipelines / node builds alive now and created in this window (null = not readable) */
  pipes: { total: number; created: number; nodes: number; nodesNew: number } | null;
  /** draw calls per frame over the window (null = unknown) */
  draws: { p50: number; max: number } | null;
  /** app-level RTT median (ms; includes the page's frame time) */
  rtt: number;
  /** STT voice chunks skipped for a backed-up socket in this window */
  voiceSkipped: number;
  preset: string;
  phase: string;
  /** the last drive preload, once it finished (ms after the drive event reached the page; -1 = not reached) */
  preload?: { asked: number; reply: number; built: number; done: number; ok: boolean; early: boolean } | null;
}

export interface CoreReqs {
  /** telemetry v2: logged on the server without names (apps/server/src/core/diag.ts) */
  'core.diag': { args: CoreDiagJoin | CoreDiagWindow; result: { ok: boolean } };
}

/** event name -> payload (server -> client, reliable, ordered) */
export interface EventMap
  extends NetEvents, LevelEvents, PlayersEvents, VoiceEvents, ObjectivesEvents, InteractionEvents, MonstersEvents, MetaEvents, AiEvents,
    ParanormalEvents, FieldguideEvents {}

/** request name -> { args; result } (client -> server, answered by 'rep') */
export interface ReqMap
  extends NetReqs, LevelReqs, PlayersReqs, VoiceReqs, ObjectivesReqs, InteractionReqs, MonstersReqs, MetaReqs, AiReqs,
    ParanormalReqs, FieldguideReqs, CoreReqs {}

export type EventName = keyof EventMap & string;
export type EventPayload<E extends EventName> = EventMap[E];
export type ReqName = keyof ReqMap & string;
export type ReqArgs<R extends ReqName> = ReqMap[R] extends { args: infer A } ? A : never;
export type ReqResult<R extends ReqName> = ReqMap[R] extends { result: infer X } ? X : never;
