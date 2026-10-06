// Owner: track ⑤ Players. Server-side noise bus: footsteps (computed here from pose deltas) and any other
// track's action noises (doors, bottles, ...) go through emitNoise(); monsters/director subscribe with onNoise().
//   import { onNoise, emitNoise } from '../players/noise.ts';
//   onNoise((crew, n) => { if (n.radiusM >= pathDist(monster, n)) investigate(n.x, n.z); });
//   emitNoise(crew, { x, z, radiusM: NOISE_M.door, kind: 'door', source: player.id });
// The same bus is also available as ctx.noise (module augmentation below) once the players track installed.
import type { Crew, ServerPlayer } from '../core/types.ts';

export type NoiseKind =
  | 'crouchStep' | 'walkStep' | 'sprintStep' | 'door' | 'securityDoor' | 'coreDrop' | 'bottle' | 'leverAlarm'
  | 'airhorn' | 'crowbar' | 'deadStatic' | (string & {});

export interface NoiseEvent {
  /** world metres */
  x: number;
  z: number;
  /** hearable path radius (m); see NOISE_M */
  radiusM: number;
  kind: NoiseKind;
  /** player id, monster id or an item id ('' = environment) */
  source: string;
  /** server clock ms (ctx.now()) */
  t: number;
}

export type NoiseListener = (crew: Crew, n: NoiseEvent) => void;

/** Proximity text line (flag proxText) that reached the server: the Listener/AI track can treat it like speech. */
export interface ProxTextEvent {
  player: ServerPlayer;
  text: string;
  x: number;
  z: number;
  /** talk radius used (m) */
  radiusM: number;
  /** ids of players who received the line */
  heardBy: string[];
  t: number;
}
export type ProxTextListener = (crew: Crew, e: ProxTextEvent) => void;

export interface NoiseBus {
  onNoise(fn: NoiseListener): () => void;
  emitNoise(crew: Crew, n: Omit<NoiseEvent, 't'> & { t?: number }): void;
  /** last noises per crew (most recent last, max 64) for debugging / director heuristics */
  recent(crew: Crew): readonly NoiseEvent[];
  onProxText(fn: ProxTextListener): () => void;
}

const listeners = new Set<NoiseListener>();
const textListeners = new Set<ProxTextListener>();
const recentByCrew = new WeakMap<Crew, NoiseEvent[]>();
let clock: () => number = () => performance.timeOrigin + performance.now();

export function setNoiseClock(fn: () => number): void {
  clock = fn;
}

export function onNoise(fn: NoiseListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitNoise(crew: Crew, n: Omit<NoiseEvent, 't'> & { t?: number }): void {
  if (!Number.isFinite(n.x) || !Number.isFinite(n.z) || !(n.radiusM > 0)) return;
  const ev: NoiseEvent = { x: n.x, z: n.z, radiusM: n.radiusM, kind: n.kind, source: n.source, t: n.t ?? clock() };
  let list = recentByCrew.get(crew);
  if (!list) recentByCrew.set(crew, (list = []));
  list.push(ev);
  if (list.length > 64) list.splice(0, list.length - 64);
  for (const fn of listeners) {
    try {
      fn(crew, ev);
    } catch (e) {
      console.warn('[players] noise listener threw:', e instanceof Error ? e.message : e);
    }
  }
}

export function recentNoises(crew: Crew): readonly NoiseEvent[] {
  return recentByCrew.get(crew) ?? [];
}

export function onProxText(fn: ProxTextListener): () => void {
  textListeners.add(fn);
  return () => textListeners.delete(fn);
}

export function emitProxText(crew: Crew, e: ProxTextEvent): void {
  for (const fn of textListeners) {
    try {
      fn(crew, e);
    } catch (err) {
      console.warn('[players] prox-text listener threw:', err instanceof Error ? err.message : err);
    }
  }
}

export const noiseBus: NoiseBus = { onNoise, emitNoise, recent: recentNoises, onProxText };

declare module '../core/types.ts' {
  interface ServerContext {
    /** provided by track ⑤ Players at install (undefined before). Same functions as apps/server/src/players/noise.ts. */
    noise?: NoiseBus;
  }
}
