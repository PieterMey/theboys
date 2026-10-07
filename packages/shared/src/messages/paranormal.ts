// Owner: env-paranormal (v1.2). Every effect carries a server 'at' time and a seed; residue re-sent on reconnect.
import type { Vec3 } from '../state.ts';

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
}
export interface ParanormalReqs {
  'paranormal.sync': { args: Record<string, never> | undefined; result: { residue: ParanormalEvent[]; active: ParanormalEvent[]; now: number } };
  'paranormal.seen': { args: { id: number; end?: boolean }; result: { ok: boolean } };
  /** stretch, off */
  'paranormal.poke': { args: { kind: 'knock' | 'brownout' | 'write'; callsign?: string }; result: { ok: boolean; cooldownMs?: number } };
}
