// Owner: env-audio (v1.2; was track ④ Voice/audio). The shared Web Audio graph on the ONE AudioContext (ctx.audio):
//   voiceBus -> voiceComp (DynamicsCompressor) -> master -> destination
//   sfxBus -> master;  ambBus -> master
//   reverb (send here) -> hall IR + small dry room IR (generated, cross-faded by the listener's room) -> wet -> master
// Plus the listener updater (camera / local player pose) and small deterministic noise helpers (no Math.random).
// Voice, AI lures and the menu import these exports: keep every name and signature (additive changes only).
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
  /** v1.2: hall vs small-dry-room IR blend 0..1 (1 = the v1.1 hall, the default), equal power, smoothed over tc s */
  setReverbMix?(hall: number, tc?: number): void;
  /** v1.2: reverb return level (1 = the v1.1 level) */
  setReverbWet?(k: number, tc?: number): void;
  /** v1.2: the current blend / return targets */
  reverbState?(): { mix: number; wet: number };
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

/** small dry room: a handful of early reflections (first ~25 ms) and a short, dark, steep tail */
function makeRoomImpulse(ac: AudioContext, sec: number): AudioBuffer {
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(sr * sec));
  const buf = ac.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const rnd = makeNoise(0x7654321 + c * 104729);
    // early reflections: walls 1.5-4 m away
    for (let k = 0; k < 9; k++) {
      const at = Math.floor(sr * (0.002 + 0.023 * ((rnd() + 1) / 2)));
      if (at < len) d[at] += (0.55 - k * 0.04) * (rnd() > 0 ? 1 : -1);
    }
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (rnd() - lp) * (0.4 - 0.3 * t);
      d[i] += lp * Math.pow(1 - t, 5.5) * (i < sr * 0.003 ? 0.3 : 1);
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
  // v1.2: a second (small dry room) IR, cross-faded with the hall by the listener's room (index.ts / acoustics.ts)
  const roomConv = ac.createConvolver();
  roomConv.buffer = makeRoomImpulse(ac, 0.5);
  const hallG = ac.createGain();
  hallG.gain.value = 1;
  const roomG = ac.createGain();
  roomG.gain.value = 0;
  const wet = ac.createGain();
  wet.gain.value = 0.8;
  reverb.connect(conv).connect(hallG).connect(wet);
  reverb.connect(roomConv).connect(roomG).connect(wet);
  wet.connect(master);
  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const nd = noise.getChannelData(0);
  const rnd = makeNoise(0xdeadbeef);
  for (let i = 0; i < nd.length; i++) nd[i] = rnd();
  const rv = { mix: 1, wet: 1 };
  const clamp01 = (v: number, hi = 1) => Math.max(0, Math.min(hi, v));
  graph = {
    ac, master, voiceBus, voiceComp, sfxBus, ambBus, reverb, noise,
    setReverbMix(hall: number, tc = 0.6) {
      if (!Number.isFinite(hall)) return;
      rv.mix = clamp01(hall);
      const t = ac.currentTime;
      targetTo(hallG.gain, Math.sqrt(rv.mix), t, tc);
      targetTo(roomG.gain, Math.sqrt(1 - rv.mix), t, tc);
    },
    setReverbWet(k: number, tc = 0.6) {
      if (!Number.isFinite(k)) return;
      rv.wet = clamp01(k, 2);
      targetTo(wet.gain, 0.8 * rv.wet, ac.currentTime, tc);
    },
    reverbState: () => ({ mix: rv.mix, wet: rv.wet }),
  };
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
