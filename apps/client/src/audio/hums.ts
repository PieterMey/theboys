// Owner: env-audio (v1.2). Power-aware fixture hums. A fixture's level comes from render.fixtureLevels() (env-render)
// when it lines up with level.fixtures, else from fallbackLevel(): generated state x the room's light (interaction
// lightOn = switch + power + blackout; battery kinds ignore it) x the flicker map. So switches, blackouts, brownouts
// and dark walks are audible: the hum follows the light down to exactly 0 (cutSec after a space loses power).
// Voices per fixture kind: tube hum (fluorescent), highbay buzz, sodium buzz (lamp / wall / flood), an emergency tick;
// bulbs, sconces, candles, LED strips, headlights and the van light are silent.
import type { AudioGraph, V3 } from './graph.ts';
import { setPannerPos } from './graph.ts';
import type { HumCfg } from './config.ts';

export type HumVoice = 'tube' | 'highbay' | 'buzz' | 'tick';

/** hum voice of a fixture kind (null = silent); unknown kinds hum like tubes (render draws them as tubes) */
export function humVoiceOf(kind: string | null | undefined): HumVoice | null {
  switch (kind ?? 'tube') {
    case 'tube': return 'tube';
    case 'highbay': return 'highbay';
    case 'lamp': case 'wall': case 'flood': return 'buzz';
    case 'emergency': return 'tick';
    case 'bulb': case 'sconce': case 'candle': case 'led_strip': case 'headlight': case 'van': return null;
    default: return 'tube';
  }
}

export interface HumFixture { space: number; pos: V3; state: string; kind?: string; battery?: boolean }

/** fixture level 0..~1.2 -> hum gain (0 below a dead threshold), x the voice kind's gain */
export function humGain(level: number, kindGain: number): number {
  if (!Number.isFinite(level) || !(level > 0.02)) return 0;
  return Math.max(0, Number.isFinite(kindGain) ? kindGain : 1) * Math.pow(Math.min(1.2, level), 1.3);
}

const hash = (n: number): number => (((n | 0) * 2654435761) >>> 0) / 4294967296;
/** bursts of buzzing dropouts separated by calm stretches (the look of render's flicker state) */
export function flickerLevel(i: number, t: number): number {
  const burst = hash(Math.floor(t * 0.7) + i * 389) < 0.45;
  if (!burst) return hash(Math.floor(t * 2) + i * 59) < 0.06 ? 0.15 : 0.92;
  const h = hash(Math.floor(t * 16) + i * 17);
  return h < 0.32 ? 0.03 : h < 0.5 ? 0.45 : 1;
}
/** the Listener telegraph (sfx.flicker / render.flickerSpace) */
export function strobeLevel(i: number, t: number): number {
  const h = hash(Math.floor(t * 22) + i * 131);
  return h < 0.5 ? 0.02 : h < 0.7 ? 0.35 : 1.15;
}
/** level without render.fixtureLevels: state x power x flicker map (t in seconds) */
export function fallbackLevel(f: HumFixture, i: number, t: number, powered: boolean, strobe: boolean): number {
  if (!powered || f.state === 'off' || f.state === 'broken') return 0;
  if (strobe) return strobeLevel(i, t);
  if (f.state === 'flicker') return flickerLevel(i, t);
  return 1;
}

export interface HumEvent {
  kind: 'off' | 'on' | 'tick';
  space: number;
  /** nearest fixture of the group */
  pos: V3;
  /** fixtures of that space that switched together this update */
  count: number;
  voice: HumVoice;
}

interface Hum {
  i: number;
  fx: HumFixture;
  voice: HumVoice;
  nodes: AudioNode[];
  oscs: OscillatorNode[];
  g: GainNode | null;
  tone: BiquadFilterNode | null;
  panner: PannerNode | null;
  target: number;
  toneF: number;
  occ: number;
  occAt: number;
  nextTick: number;
}
interface Track { stable: 'on' | 'off'; pending: 'on' | 'off' | null; since: number }
interface Dying { nodes: AudioNode[]; oscs: OscillatorNode[]; at: number }

const DEBOUNCE = 0.15;

export class Hums {
  private ac: BaseAudioContext;
  readonly bus: GainNode;
  private cfg: HumCfg;
  private hums = new Map<number, Hum>();
  private track = new Map<number, Track>();
  private list: readonly HumFixture[] | null = null;
  private dying: Dying[] = [];
  private nodeCount = 0;

  constructor(g: Pick<AudioGraph, 'ac' | 'ambBus'>, cfg: HumCfg) {
    this.ac = g.ac;
    this.cfg = cfg;
    this.bus = new GainNode(g.ac, { gain: cfg.bus });
    this.bus.connect(g.ambBus);
  }

  setCfg(cfg: HumCfg): void {
    this.cfg = cfg;
    this.bus.gain.setTargetAtTime(cfg.bus, this.ac.currentTime, 0.1);
  }

  /** live hum nodes (created and not yet disconnected) */
  nodes(): number { return this.nodeCount; }

  /**
   * listener / fixtures / levels -> hum voices. now = ac.currentTime. occOf(f) = occlusion gain of the walls between
   * the listener and a fixture (cached 0.25 s per hum). Returns switch / start / tick events for index.ts.
   */
  update(listener: V3 | null, fixtures: readonly HumFixture[] | null, levelOf: (i: number) => number, now: number,
    occOf?: (f: HumFixture) => number): HumEvent[] {
    const events: HumEvent[] = [];
    this.reap(now);
    if (fixtures !== this.list) {
      this.releaseAll(now);
      this.track.clear();
      this.list = fixtures;
    }
    if (!listener || !fixtures || !fixtures.length) {
      if (this.hums.size) this.releaseAll(now);
      return events;
    }
    const cfg = this.cfg;
    const r2 = cfg.radiusM * cfg.radiusM;
    const near: { i: number; d2: number }[] = [];
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      if (!f || !f.pos || !humVoiceOf(f.kind)) continue;
      const dx = f.pos[0] - listener[0], dz = f.pos[2] - listener[2];
      const d2 = dx * dx + dz * dz;
      if (d2 <= r2 && Number.isFinite(d2)) near.push({ i, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);
    if (near.length > cfg.max) near.length = Math.max(0, Math.floor(cfg.max));
    const keep = new Set<number>();
    const offBy = new Map<number, HumEvent>();
    const onBy = new Map<number, HumEvent>();
    for (const { i } of near) {
      const f = fixtures[i];
      const voice = humVoiceOf(f.kind)!;
      let level = levelOf(i);
      if (!Number.isFinite(level)) level = 0;
      level = Math.max(0, Math.min(1.2, level));
      keep.add(i);
      // debounced on/off (strobes and flicker never hold a state for DEBOUNCE s)
      const s: 'on' | 'off' | null = level >= 0.45 ? 'on' : level <= 0.05 ? 'off' : null;
      let tr = this.track.get(i);
      if (!tr) { tr = { stable: level >= 0.25 ? 'on' : 'off', pending: null, since: now }; this.track.set(i, tr); }
      if (s && s !== tr.stable) {
        if (tr.pending !== s) { tr.pending = s; tr.since = now; }
        else if (now - tr.since >= DEBOUNCE) {
          tr.stable = s;
          tr.pending = null;
          const by = s === 'off' ? offBy : onBy;
          const e = by.get(f.space);
          if (e) e.count++;
          else by.set(f.space, { kind: s, space: f.space, pos: f.pos, count: 1, voice });
        }
      } else if (s === tr.stable) tr.pending = null;
      let h = this.hums.get(i);
      if (voice === 'tick') {
        // the battery pack's charge relay: a quiet tick every ~2 s while the emergency light is lit
        if (!h) { h = this.blank(i, f, voice, now); this.hums.set(i, h); }
        if (level > 0.05 && now >= h.nextTick) {
          events.push({ kind: 'tick', space: f.space, pos: f.pos, count: 1, voice });
          h.nextTick = now + 1.8 + 0.6 * hash(i * 31 + Math.floor(now));
        }
        continue;
      }
      if (occOf && (!h || now - h.occAt >= 0.25)) {
        const o = occOf(f);
        if (h) { h.occ = Number.isFinite(o) ? Math.max(0, Math.min(1, o)) : 1; h.occAt = now; }
      }
      const occ = h ? h.occ : 1;
      const target = humGain(level, cfg.kinds[voice] ?? 1) * (cfg.occlude ? occ : 1);
      if (!h) {
        if (target <= 0) continue; // silent fixtures never get nodes
        h = this.build(i, f, voice, now);
        this.hums.set(i, h);
        if (occOf) { const o = occOf(f); h.occ = Number.isFinite(o) ? Math.max(0, Math.min(1, o)) : 1; h.occAt = now; }
        const t0 = humGain(level, cfg.kinds[voice] ?? 1) * (cfg.occlude ? h.occ : 1);
        h.g!.gain.setTargetAtTime(t0, now, 0.25); // first appearance: a soft fade in
        h.target = t0;
      } else if (h.g) {
        h.fx = f;
        const zero = target <= 0, wasZero = h.target <= 0;
        if (zero !== wasZero || Math.abs(target - h.target) > Math.max(0.003, 0.03 * Math.max(target, h.target))) this.setGain(h, target, now);
        if (h.panner) setPannerPos(h.panner, this.ac as AudioContext, f.pos, 0.1);
      }
      if (h.tone) {
        const tf = (voice === 'highbay' ? 900 : 380) + (voice === 'highbay' ? 900 : 950) * Math.min(1, level);
        if (Math.abs(tf - h.toneF) > 25) {
          try { h.tone.frequency.setTargetAtTime(tf, now, 0.04); } catch { /* ignore */ }
          h.toneF = tf;
        }
      }
    }
    for (const [i, h] of this.hums) if (!keep.has(i)) this.release(i, h, now, 0.15);
    for (const e of offBy.values()) events.push(e);
    for (const e of onBy.values()) events.push(e);
    return events;
  }

  /** hum state for tests / __audioDebug */
  info(): { i: number; space: number; kind: string; voice: HumVoice; target: number; gain: number }[] {
    const out: { i: number; space: number; kind: string; voice: HumVoice; target: number; gain: number }[] = [];
    for (const h of this.hums.values()) out.push({ i: h.i, space: h.fx.space, kind: h.fx.kind ?? 'tube', voice: h.voice, target: h.target, gain: h.g ? h.g.gain.value : 0 });
    return out;
  }

  /** the hum gain AudioParam of fixture i (tests) */
  gainParam(i: number): AudioParam | null { return this.hums.get(i)?.g?.gain ?? null; }

  dispose(): void {
    const now = this.ac.currentTime;
    this.releaseAll(now);
    this.reap(Infinity);
    try { this.bus.disconnect(); } catch { /* ignore */ }
  }

  private setGain(h: Hum, target: number, now: number): void {
    const p = h.g!.gain;
    try {
      p.cancelScheduledValues(now);
      if (target <= 0) {
        // power lost: fast fade, then exactly 0 (a setTarget never reaches 0 on its own)
        p.setTargetAtTime(0, now, Math.max(0.005, this.cfg.releaseSec));
        p.setValueAtTime(0, now + Math.max(0.02, this.cfg.cutSec));
      } else p.setTargetAtTime(target, now, Math.max(0.005, target > h.target ? this.cfg.attackSec : this.cfg.releaseSec));
    } catch { /* non-finite guard */ }
    h.target = target;
  }

  private blank(i: number, fx: HumFixture, voice: HumVoice, now: number): Hum {
    return { i, fx, voice, nodes: [], oscs: [], g: null, tone: null, panner: null, target: 0, toneF: 0, occ: 1, occAt: -1, nextTick: now + 0.4 + 1.6 * hash(i * 17) };
  }

  private build(i: number, fx: HumFixture, voice: HumVoice, now: number): Hum {
    const ac = this.ac;
    const h = this.blank(i, fx, voice, now);
    const g = new GainNode(ac, { gain: 0 });
    const panner = new PannerNode(ac, {
      panningModel: 'equalpower', distanceModel: 'inverse', refDistance: voice === 'highbay' ? 2 : 1, maxDistance: Math.max(2, this.cfg.radiusM),
      rolloffFactor: voice === 'buzz' ? 1.1 : 1.5, positionX: fx.pos[0], positionY: fx.pos[1], positionZ: fx.pos[2],
    });
    g.connect(panner).connect(this.bus);
    h.nodes.push(g, panner);
    // neighbouring fixtures beat slowly against each other (+-0.36 Hz)
    const det = ((((i * 7919) % 7) + 7) % 7 - 3) * 0.12;
    const part = (type: OscillatorType, f: number, gain: number, filter?: BiquadFilterNode): void => {
      const o = new OscillatorNode(ac, { type, frequency: f });
      const og = new GainNode(ac, { gain });
      if (filter) o.connect(filter).connect(og);
      else o.connect(og);
      og.connect(g);
      o.start();
      h.oscs.push(o);
      h.nodes.push(o, og);
    };
    if (voice === 'tube') {
      // magnetic-ballast fluorescent: 100 Hz buzz (dimmer = duller: the lowpass follows the level) + harmonics
      const tone = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 1330, Q: 0.6 });
      h.nodes.push(tone);
      h.tone = tone;
      h.toneF = 1330;
      part('sawtooth', 100 + det, 0.018, tone);
      part('sine', 200 + 2 * det, 0.012);
      part('sine', 300 + 3 * det, 0.005);
    } else if (voice === 'highbay') {
      // metal-halide high bay: a rougher, louder buzz with a mid-band rasp
      const tone = new BiquadFilterNode(ac, { type: 'bandpass', frequency: 1800, Q: 1.2 });
      h.nodes.push(tone);
      h.tone = tone;
      h.toneF = 1800;
      part('square', 100 + det, 0.022, tone);
      part('sine', 100 + det, 0.03);
      part('sine', 200 + 2 * det, 0.014);
    } else {
      // sodium lot lamp / wall pack / flood: a thin high ballast buzz
      const bpf = new BiquadFilterNode(ac, { type: 'bandpass', frequency: 2200, Q: 2 });
      h.nodes.push(bpf);
      part('sawtooth', 100 + det, 0.01, bpf);
      part('sine', 200 + 2 * det, 0.006);
    }
    h.g = g;
    h.panner = panner;
    this.nodeCount += h.nodes.length;
    return h;
  }

  private release(i: number, h: Hum, now: number, tc: number): void {
    this.hums.delete(i);
    if (h.g) {
      try {
        h.g.gain.cancelScheduledValues(now);
        h.g.gain.setTargetAtTime(0, now, tc);
        h.g.gain.setValueAtTime(0, now + tc * 7);
      } catch { /* ignore */ }
    }
    if (h.nodes.length) this.dying.push({ nodes: h.nodes, oscs: h.oscs, at: now + tc * 7 + 0.1 });
  }

  private releaseAll(now: number): void {
    for (const [i, h] of this.hums) this.release(i, h, now, 0.12);
  }

  private reap(now: number): void {
    if (!this.dying.length) return;
    const left: Dying[] = [];
    for (const d of this.dying) {
      if (d.at > now) { left.push(d); continue; }
      for (const o of d.oscs) { try { o.stop(); } catch { /* ignore */ } }
      for (const n of d.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
      this.nodeCount -= d.nodes.length;
    }
    this.dying = left;
  }
}
