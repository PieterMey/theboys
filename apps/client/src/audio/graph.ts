// Owner: track ④ Voice/audio. The shared Web Audio graph on the ONE AudioContext (ctx.audio):
//   voiceBus -> voiceComp (DynamicsCompressor) -> master -> destination
//   sfxBus -> master;  ambBus -> master;  reverb (one shared ConvolverNode, generated IR) -> master
// Plus the listener updater (camera / local player pose) and small deterministic noise helpers (no Math.random).
import type { ClientContext } from '../core/context.ts';

export type V3 = [number, number, number];

export interface AudioGraph {
  ac: AudioContext;
  master: GainNode;
  voiceBus: GainNode;
  voiceComp: DynamicsCompressorNode;
  sfxBus: GainNode;
  ambBus: GainNode;
  /** reverb input (send here) */
  reverb: GainNode;
  /** shared white-noise buffer (2 s, deterministic) */
  noise: AudioBuffer;
}

let graph: AudioGraph | null = null;

/** xorshift32 noise in [-1, 1) (audio texture only; not gameplay randomness) */
export function makeNoise(seed = 0x9e3779b9): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 2147483648 - 1;
  };
}

function makeImpulse(ac: AudioContext, sec: number, decay: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ac.sampleRate * sec));
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const rnd = makeNoise(0x1234567 + c * 7919);
    // early reflections + exponential tail, slightly darker over time
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay);
      const n = rnd();
      lp += (n - lp) * (0.6 - 0.45 * t);
      d[i] = lp * env * (i < ac.sampleRate * 0.004 ? 0 : 1);
    }
  }
  return buf;
}

export function getGraph(ac: AudioContext): AudioGraph {
  if (graph && graph.ac === ac) return graph;
  const master = ac.createGain();
  master.gain.value = 1;
  master.connect(ac.destination);
  const voiceBus = ac.createGain();
  const voiceComp = ac.createDynamicsCompressor();
  voiceComp.threshold.value = -18;
  voiceComp.knee.value = 12;
  voiceComp.ratio.value = 3;
  voiceComp.attack.value = 0.005;
  voiceComp.release.value = 0.2;
  voiceBus.connect(voiceComp).connect(master);
  const sfxBus = ac.createGain();
  sfxBus.gain.value = 0.9;
  sfxBus.connect(master);
  const ambBus = ac.createGain();
  ambBus.gain.value = 0.6;
  ambBus.connect(master);
  const reverb = ac.createGain();
  const conv = ac.createConvolver();
  conv.buffer = makeImpulse(ac, 1.9, 3.2);
  const wet = ac.createGain();
  wet.gain.value = 0.8;
  reverb.connect(conv).connect(wet).connect(master);
  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const nd = noise.getChannelData(0);
  const rnd = makeNoise(0xdeadbeef);
  for (let i = 0; i < nd.length; i++) nd[i] = rnd();
  graph = { ac, master, voiceBus, voiceComp, sfxBus, ambBus, reverb, noise };
  return graph;
}

// ---------------- listener ----------------

interface PlayersLike {
  cameraPos?(): V3;
  localId?(): string | null;
}
interface ThreeLike {
  camera?: { getWorldDirection?(v: unknown): unknown; matrixWorld?: { elements: ArrayLike<number> }; position?: { x: number; y: number; z: number } };
}

/** loose service lookup for services provided by other tracks (may be absent or still in progress) */
export function useLoose<T>(ctx: ClientContext, name: string): T | undefined {
  return (ctx.services.use as (n: string) => unknown)(name) as T | undefined;
}

export interface ListenerPose { pos: V3; fwd: V3; up: V3; src: string }

/**
 * Listener pose: three camera (render) > players.cameraPos + local yaw > server view of the local player.
 * `?voiceListener=server` forces the server pose (tests with pinned poses).
 */
export function listenerPose(ctx: ClientContext): ListenerPose | null {
  const forceServer = ctx.params.get('voiceListener') === 'server';
  if (!forceServer) {
    const three = useLoose<ThreeLike>(ctx, 'three');
    const cam = three?.camera;
    const m = cam?.matrixWorld?.elements;
    if (m && m.length >= 16 && (m[12] !== 0 || m[13] !== 0 || m[14] !== 0)) {
      // camera looks down its local -Z; up is local +Y
      return { pos: [m[12], m[13], m[14]], fwd: [-m[8], -m[9], -m[10]], up: [m[4], m[5], m[6]], src: 'camera' };
    }
    const pl = useLoose<PlayersLike>(ctx, 'players');
    if (pl?.cameraPos) {
      const pos = pl.cameraPos();
      const me = ctx.world.me ? ctx.world.samplePlayer(ctx.world.me) : null;
      const yaw = me?.yaw ?? 0;
      return { pos, fwd: [Math.sin(yaw), 0, Math.cos(yaw)], up: [0, 1, 0], src: 'players' };
    }
  }
  const id = ctx.world.me;
  if (!id) return null;
  const s = ctx.world.players.get(id)?.latest() ?? null;
  if (!s) return null;
  const yaw = s.yaw;
  return { pos: [s.p[0], s.p[1] + 1.6, s.p[2]], fwd: [Math.sin(yaw), 0, Math.cos(yaw)], up: [0, 1, 0], src: 'server' };
}

const fin3 = (v: ArrayLike<number> | null | undefined): boolean =>
  !!v && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

/** AudioParam ramps throw on non-finite values (and a throw mid-update kills the caller's frame): skip those. */
export function rampTo(p: AudioParam, v: number, t: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t)) return;
  try { p.linearRampToValueAtTime(v, t); } catch { /* ignore */ }
}
export function targetTo(p: AudioParam, v: number, t: number, tc: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t) || !Number.isFinite(tc) || tc <= 0) return;
  try { p.setTargetAtTime(v, t, tc); } catch { /* ignore */ }
}

/** Smoothly move ac.listener (AudioParam ramps, never .value jumps during playback). Non-finite poses are skipped. */
export function applyListener(ac: AudioContext, lp: ListenerPose, rampSec = 0.06): void {
  if (!fin3(lp.pos) || !fin3(lp.fwd) || !fin3(lp.up)) return;
  const L = ac.listener;
  const t = ac.currentTime + rampSec;
  if (!Number.isFinite(t)) return;
  if (L.positionX) {
    L.positionX.linearRampToValueAtTime(lp.pos[0], t);
    L.positionY.linearRampToValueAtTime(lp.pos[1], t);
    L.positionZ.linearRampToValueAtTime(lp.pos[2], t);
    L.forwardX.linearRampToValueAtTime(lp.fwd[0], t);
    L.forwardY.linearRampToValueAtTime(lp.fwd[1], t);
    L.forwardZ.linearRampToValueAtTime(lp.fwd[2], t);
    L.upX.linearRampToValueAtTime(lp.up[0], t);
    L.upY.linearRampToValueAtTime(lp.up[1], t);
    L.upZ.linearRampToValueAtTime(lp.up[2], t);
  } else {
    // very old engines only
    (L as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(lp.pos[0], lp.pos[1], lp.pos[2]);
  }
}

export function setPannerPos(p: PannerNode, ac: AudioContext, pos: V3, rampSec = 0.06): void {
  if (!fin3(pos)) return;
  const t = ac.currentTime + rampSec;
  if (!Number.isFinite(t)) return;
  p.positionX.linearRampToValueAtTime(pos[0], t);
  p.positionY.linearRampToValueAtTime(pos[1], t);
  p.positionZ.linearRampToValueAtTime(pos[2], t);
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-9, g));
