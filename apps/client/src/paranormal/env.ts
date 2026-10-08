// Owner: env-paranormal (v1.2) client. Shared environment for the effect modules: §13 service views (all optional,
// structural, called with ?.), server-time conversion, settings, small seeded helpers.
import type * as THREE from 'three/webgpu';
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import type { EdgeGrid, DoorOpenFn } from '@dead-air/shared/nav/index.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import type { ClientContext } from '../core/context.ts';
import type { FixtureCurve, FogVolume, MirrorHandle, RenderLayers, BeamInfo } from '../render/api.ts';
import type { PropHandle } from '../level/api.ts';
import type { SynthKind, SynthOpts } from '../audio/api.ts';
import type { ParanormalSettings } from './settings.ts';

export type V3 = [number, number, number];

/** render service as E4 uses it (RenderServiceV12 members are optional until E2 lands them) */
export interface RenderView {
  layers?: RenderLayers;
  brownout?(space: number, ms: number, depth?: number): void;
  fixtureCurve?(indices: readonly number[], curve: FixtureCurve, startMs: number, stepMs?: number): void;
  mirrors?: { list(): readonly MirrorHandle[] };
  setFogVolumes?(list: readonly FogVolume[]): void;
  puff?(pos: V3, kind: 'breath' | 'steam' | 'dust' | 'frost', strength?: number): void;
  beams?(): readonly BeamInfo[];
  beamInterference?(who: string, ms: number, depth?: number): void;
  coverMode?(): string;
}

export interface FixtureView { space: number; pos: V3; id?: string; state?: string; kind?: string }
export interface LevelView {
  readonly layout: LevelLayout | null;
  readonly grid: EdgeGrid | null;
  readonly version: number;
  readonly root?: THREE.Group;
  readonly fixtures: readonly FixtureView[];
  readonly doorOpen?: DoorOpenFn;
  spaceGroup?(space: number): THREE.Group | null;
  onRebuild?(fn: (layout: LevelLayout) => void): () => void;
  rattleDoor?(id: number, ms: number, amp?: number): void;
  propHandle?(ref: string, at?: { key: string; x: number; z: number }): PropHandle | null;
  mirrorOf?(itemId: string): MirrorHandle | null;
}

export interface SfxView {
  play(id: string, pos?: Vec3, opts?: { volume?: number; rate?: number; radius?: number; occlude?: boolean }): unknown;
  synth?(kind: SynthKind, pos?: Vec3, opts?: SynthOpts): unknown;
  fear?(source: string, v: number, ms?: number): void;
}

export interface PlayersView {
  localId?(): string | null;
  cameraPos?(): V3;
  flashlightOn?(): boolean;
  setFlashlight?(on: boolean): void;
  spectating?(): boolean;
}

export interface Env {
  ctx: ClientContext;
  render(): RenderView | undefined;
  level(): LevelView | undefined;
  sfx(): SfxView | undefined;
  players(): PlayersView | undefined;
  three(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera } | undefined;
  settings(): ParanormalSettings;
  /** accessibility (render 'reduce flicker'): slow fades only */
  reduceFlicker(): boolean;
  me(): string | null;
  /** estimated server clock (ms) */
  serverNow(): number;
  /** performance.now() time of a server time */
  local(serverMs: number): number;
  /** a witness report (rate-limited by witness.ts) */
  seen(id: number, end?: boolean): void;
  /** play a seeded synth sound (asset fallback when E5's synth is missing) */
  synth(kind: SynthKind, pos: V3 | null, opts: SynthOpts, fallback?: { key: string; volume?: number; rate?: number }): void;
  /** heartbeat bump from something the local player perceived */
  fear(v: number, ms: number): void;
  /** fixture id -> index into level.fixtures (rebuilt with the level) */
  fixtureIndex(id: string): number;
  log(msg: string): void;
}

/** an effect instance driven by one ParanormalEvent */
export interface Effect {
  readonly ev: ParanormalEvent;
  /** per frame; `now` = server ms estimate. Return false when finished (the manager disposes it). */
  update(now: number, dt: number): boolean;
  /** server said it ended */
  end(reason: string): void;
  /** mirror writing: reveal strokes from server time `at` */
  reveal?(at: number): void;
  /** witness anchor while armed (null = nothing to report) */
  witness?(): WitnessSpec | null;
  /** the witness tracker saw it for >= 0.25 s */
  onSeen?(): void;
  dispose(): void;
}

export interface WitnessSpec {
  points: readonly V3[];
  maxM: number;
  /** report with end:true */
  end?: boolean;
  /** seconds of continuous visibility before reporting (default 0.25) */
  holdSec?: number;
  /** only visible from this side (unit normal, e.g. writing on glass) */
  facing?: V3;
}

/** deterministic [0,1) stream from an event seed (clients must agree: no Math.random) */
export function seeded(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const smooth01 = (x: number): number => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

export const dist2d = (a: V3 | readonly number[], b: V3 | readonly number[]): number => Math.hypot(a[0] - b[0], a[2] - b[2]);
