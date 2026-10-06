// Owned by track ① Net. Crew/lobby/connection events.
import type { CrewPublic, Phase, FullState, Vec3 } from '../state.ts';
import type { Profile } from '../profile.ts';
import type { LevelLayout } from '../layout.ts';

/** v1.1 client performance report ('net.telemetry' perf). The server validates and clamps every field. */
export interface NetPerfReport {
  fps: number; p50: number; p95: number; long: number; gpuMs: number | null; preset: string;
  res: [number, number]; dpr: number; scale: number; backend: string; rtt: number; hidden: boolean;
  heapMB: number | null; screen: string; phase: string;
}
/** v1.1 the client's view of its last dropped socket, sent once after it reconnected */
export interface NetDropReport { code: number; reason?: string; wasClean?: boolean; openSec?: number; downSec?: number; hidden?: boolean; online?: boolean; lastFrameAgoMs?: number }

export interface NetEvents {
  /** crew roster / readiness / leader changed */
  'crew': CrewPublic;
  /** phase transition; carries the full state for the new phase (layout, orders, slices) */
  'phase': { phase: Phase; state: FullState };
  /** a toast/system line for everyone, e.g. "Sam joined" */
  'notice': { text: string; kind?: 'info' | 'warn' | 'error' };
  /**
   * Sent ONLY to the player whose pose was rejected (too fast, through a wall, teleport):
   * the authoritative position to snap the local controller back to. Rate-limited (~3/s).
   */
  'net.correct': { p: Vec3; yaw: number; reason: 'speed' | 'wall' | 'solid' | 'grid'; seq: number };
  /** v1.1: during the drive, the names still building the facility layout `hash` (drive screen "HOLDING FOR") */
  'net.loading': { hash: string; waiting: string[] };
}

export interface NetReqs {
  'crew.ready': { args: { ready: boolean }; result: { ok: true } };
  'crew.kick': { args: { id: string }; result: { ok: true } };
  'profile.set': { args: { profile: Profile }; result: { ok: true } };
  'consent.set': { args: { transcribe: boolean; mimic: boolean }; result: { ok: true } };
  'claim': { args: { name: string; pin: string }; result: { ok: boolean; level?: number } };
  'admin.createCrew': { args: { code?: string; password?: string }; result: { code: string } };
  /** invite link for this crew: https://<quick tunnel>/#CODE, or null when no tunnel is running */
  'net.invite': { args: Record<string, never>; result: { url: string | null; base: string | null } };
  /**
   * Dev/test only (NODE_ENV=development or test): move this player on the server so the next poses validate
   * from there. The client calls it automatically when the test API teleports.
   */
  /** v1.1 (every ~10 s per client): render perf + new client errors + the last socket drop; logged server side */
  'net.telemetry': { args: { perf?: Partial<NetPerfReport>; errors?: string[]; drop?: NetDropReport }; result: { ok: true } };
  /** v1.1 host only (admin token, or anyone in dev): the latest telemetry report of every player in the crew */
  'net.perf': { args: Record<string, never>; result: { players: { id: string; name: string; at: number; report: NetPerfReport }[] } };
  /** v1.1 (drive phase): the facility layout prepared for this drive, so the client builds it behind the drive screen */
  'net.preload': { args: Record<string, never>; result: { layout: LevelLayout | null; hash: string | null } };
  /** v1.1: the client built and warmed the preloaded layout; the van waits for every preloading player */
  'net.loaded': { args: { hash: string; ok: boolean; ms: number }; result: { ok: boolean; waiting?: string[] } };
  'dbg.net.teleport': { args: { x: number; z: number; y?: number; yaw?: number }; result: { ok: true } };
}
