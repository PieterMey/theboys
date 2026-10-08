// Owner: env-audio (v1.2). Theme beds: a quiet continuous layer set per site theme plus seeded, client-only one-shots
// (drips, creaks, paper settling, relay selectors, pump thumps...). They play in the contract phase on facility layouts;
// the lot wind plays wherever the listener stands outside. mod:machine adds a machine bed, mod:damp extra drips
// (mod:echoes is the reverb's job: acoustics.ts). Undressed themes resolve through ThemeDef.base; facility has no bed
// (v1.1 parity). Client-only and never synced, so a bed sound is never a tell (no knocks, no breath, no scrapes).
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import { THEMES, isSiteTheme } from '@dead-air/shared/procgen/themes.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { BedKind } from './synth.ts';
import type { BedsCfg } from './config.ts';
import type { AudioGraph, V3 } from './graph.ts';
import { makeNoise, targetTo } from './graph.ts';
import { noiseRms, oscRms } from './dsp.ts';
import type { FiltSpec, Wave } from './dsp.ts';

export type LayerKind = 'air' | 'vent' | 'rumble' | 'water' | 'equipment' | 'compressor' | 'wind' | 'machine';
export interface BedLayer { kind: LayerKind; level: number }
export type Where = 'ceiling' | 'floor' | 'near' | 'far';
export interface BedEvent { kind: BedKind; meanSec: number; level: number; where: Where; periodic?: boolean }
export interface BedDef { layers: BedLayer[]; events: BedEvent[] }

/** bed per dressed theme + the lot, mod:machine and mod:damp */
export const BEDS: Readonly<Record<string, BedDef>> = {
  waterworks: {
    layers: [{ kind: 'water', level: 0.5 }, { kind: 'air', level: 0.2 }],
    events: [{ kind: 'drip', meanSec: 2.6, level: 0.5, where: 'ceiling' }, { kind: 'thump', meanSec: 1.8, level: 0.3, where: 'far', periodic: true }],
  },
  industry: {
    layers: [{ kind: 'rumble', level: 0.6 }, { kind: 'air', level: 0.15 }],
    events: [{ kind: 'clank', meanSec: 9, level: 0.3, where: 'far' }],
  },
  comms: {
    layers: [{ kind: 'equipment', level: 0.45 }, { kind: 'air', level: 0.15 }],
    events: [{ kind: 'selector', meanSec: 5, level: 0.32, where: 'near' }],
  },
  records: {
    layers: [{ kind: 'air', level: 0.25 }],
    events: [{ kind: 'paper', meanSec: 7, level: 0.3, where: 'near' }, { kind: 'creak', meanSec: 18, level: 0.22, where: 'floor' }],
  },
  cold_storage: {
    // the compressor layer cycles on / off itself (compressor_on / compressor_off one-shots)
    layers: [{ kind: 'compressor', level: 0.55 }, { kind: 'air', level: 0.2 }],
    events: [],
  },
  hospital: {
    layers: [{ kind: 'vent', level: 0.5 }],
    events: [{ kind: 'clank', meanSec: 22, level: 0.14, where: 'far' }],
  },
  hospitality: {
    layers: [{ kind: 'air', level: 0.15 }],
    events: [{ kind: 'creak', meanSec: 6, level: 0.32, where: 'floor' }],
  },
  lot: {
    layers: [{ kind: 'wind', level: 0.6 }],
    events: [{ kind: 'rattle', meanSec: 12, level: 0.28, where: 'far' }],
  },
  machine: {
    layers: [{ kind: 'machine', level: 0.5 }],
    events: [{ kind: 'clank', meanSec: 1.15, level: 0.2, where: 'far', periodic: true }],
  },
  damp: { layers: [], events: [{ kind: 'drip', meanSec: 6, level: 0.4, where: 'ceiling' }] },
};

const SPECIAL = new Set(['lot', 'machine', 'damp']);

/** bed key of a theme: its own bed, else the first dressed ancestor (ThemeDef.base); facility (and unknown) = none */
export function bedThemeOf(theme: string | null | undefined): string | null {
  let t: string = isSiteTheme(theme) ? theme : 'facility';
  for (let i = 0; i < 8; i++) {
    if (BEDS[t] && !SPECIAL.has(t)) return t;
    const base: string | null = isSiteTheme(t) ? THEMES[t].base : null;
    if (!base) return null;
    t = base;
  }
  return null;
}

/** the beds that should play now (pure) */
export function activeBeds(L: Pick<LevelLayout, 'kind' | 'theme' | 'metrics'> | null, phase: string, outside: boolean, siteThemes = true): string[] {
  const out: string[] = [];
  if (!L) return out;
  if (L.kind === 'facility' && phase === 'contract') {
    const t = bedThemeOf(siteThemes ? L.theme : 'facility');
    if (t) out.push(t);
    if ((L.metrics?.['mod:machine'] ?? 0) > 0) out.push('machine');
    if ((L.metrics?.['mod:damp'] ?? 0) > 0) out.push('damp');
  }
  if (outside && phase !== 'drive') out.push('lot');
  return out;
}

/** seconds to the next one-shot: periodic +-4 %, else exponential around the mean, bounded to [0.3, 3] x mean */
export function nextGap(rng: Rng, meanSec: number, periodic = false): number {
  const m = Math.max(0.2, Number.isFinite(meanSec) ? meanSec : 5);
  if (periodic) return m * (0.96 + 0.08 * rng.next());
  const u = Math.min(0.999, rng.next());
  return Math.min(m * 3, Math.max(m * 0.3, -m * Math.log(1 - u)));
}

// ---------------------------------------------------------------- layers

interface NoisePart { t: 'noise'; rate: number; filters: FiltSpec[]; rms: number; sweep?: { rate: number; depth: number }; am?: { rate: number; depth: number } }
interface TonePart { t: 'tone'; wave: Wave; f: number; rms: number; filters?: FiltSpec[]; am?: { rate: number; depth: number } }
type Part = NoisePart | TonePart;

/** target RMS at level 1 (before the bed level and the ambience bus) */
export const LAYERS: Readonly<Record<LayerKind, readonly Part[]>> = {
  air: [{ t: 'noise', rate: 1, filters: [{ type: 'lowpass', f: 1100, q: 0.5 }, { type: 'highpass', f: 60, q: 0.5 }], rms: 0.012 }],
  vent: [
    { t: 'noise', rate: 1, filters: [{ type: 'lowpass', f: 1500, q: 0.4 }], rms: 0.016 },
    { t: 'tone', wave: 'sine', f: 85, rms: 0.004 },
    { t: 'tone', wave: 'sine', f: 170, rms: 0.0015 },
  ],
  rumble: [
    { t: 'noise', rate: 0.25, filters: [{ type: 'lowpass', f: 110, q: 0.7 }], rms: 0.022 },
    { t: 'tone', wave: 'sine', f: 34, rms: 0.008, am: { rate: 0.07, depth: 0.5 } },
  ],
  water: [
    { t: 'noise', rate: 0.8, filters: [{ type: 'bandpass', f: 700, q: 0.9 }], rms: 0.012, sweep: { rate: 0.11, depth: 250 } },
    { t: 'noise', rate: 1.3, filters: [{ type: 'highpass', f: 2500, q: 0.5 }], rms: 0.003, am: { rate: 0.37, depth: 0.6 } },
  ],
  equipment: [
    { t: 'tone', wave: 'sine', f: 50, rms: 0.006 },
    { t: 'tone', wave: 'sine', f: 100, rms: 0.004 },
    { t: 'tone', wave: 'sine', f: 150, rms: 0.002 },
    { t: 'tone', wave: 'sine', f: 2900, rms: 0.0009, am: { rate: 0.3, depth: 0.6 } },
  ],
  compressor: [
    { t: 'tone', wave: 'sawtooth', f: 50, rms: 0.012, filters: [{ type: 'lowpass', f: 260, q: 0.7 }] },
    { t: 'tone', wave: 'sine', f: 100, rms: 0.005 },
    { t: 'tone', wave: 'sine', f: 310, rms: 0.0016 },
  ],
  wind: [{ t: 'noise', rate: 0.6, filters: [{ type: 'bandpass', f: 450, q: 0.7 }], rms: 0.02, sweep: { rate: 0.13, depth: 180 }, am: { rate: 0.07, depth: 0.8 } }],
  machine: [
    { t: 'tone', wave: 'sawtooth', f: 75, rms: 0.006, filters: [{ type: 'bandpass', f: 620, q: 3 }] },
    { t: 'noise', rate: 0.3, filters: [{ type: 'lowpass', f: 180, q: 0.7 }], rms: 0.012 },
  ],
};

interface LayerInst {
  key: string;
  kind: LayerKind;
  level: number;
  gain: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  /** compressor cycle */
  on: boolean;
  until: number;
}

export interface BedHost {
  /** play a bed one-shot (positional + occluded at pos, 2D without) */
  play(kind: BedKind, pos: V3 | null, level: number, seed: number): void;
}

export interface BedView {
  layout: LevelLayout | null;
  phase: string;
  listener: V3 | null;
  siteThemes: boolean;
  /** audio clock (s) */
  now: number;
}

export class Beds {
  private ac: BaseAudioContext;
  private cfg: BedsCfg;
  private host: BedHost;
  readonly bus: GainNode;
  private noise: AudioBuffer | null = null;
  private layers = new Map<string, LayerInst>();
  private dying: { nodes: AudioNode[]; sources: AudioScheduledSourceNode[]; at: number }[] = [];
  private nextAt = new Map<string, number>();
  private rng: Rng | null = null;
  private rngKey = '';
  private active: string[] = [];
  private override: string | null | undefined = undefined;
  private nodeCount = 0;

  constructor(g: Pick<AudioGraph, 'ac' | 'ambBus'>, cfg: BedsCfg, host: BedHost) {
    this.ac = g.ac;
    this.cfg = cfg;
    this.host = host;
    this.bus = new GainNode(g.ac, { gain: Math.max(0, cfg.level) });
    this.bus.connect(g.ambBus);
  }

  setCfg(cfg: BedsCfg): void {
    this.cfg = cfg;
    targetTo(this.bus.gain, Math.max(0, cfg.level), this.ac.currentTime, 0.3);
  }

  /** test hook: force a bed theme (undefined = follow the layout, null = none) */
  forceTheme(theme: string | null | undefined): void { this.override = theme; }

  nodes(): number { return this.nodeCount; }
  info(): { active: string[]; layers: string[]; nodes: number } {
    return { active: this.active.slice(), layers: [...this.layers.keys()], nodes: this.nodeCount };
  }

  update(v: BedView): void {
    const now = v.now;
    this.reap(now);
    const L = v.layout;
    const sp = L && v.listener ? spaceOf(L, v.listener[0], v.listener[2]) : -1;
    const outside = !!L && sp >= 0 && (!!L.spaces[sp]?.open || L.spaces[sp]?.kind === 'outside');
    let want = activeBeds(L, v.phase, outside, v.siteThemes);
    if (this.override !== undefined) {
      want = want.filter((k) => SPECIAL.has(k));
      if (this.override && BEDS[this.override]) want.unshift(this.override);
    }
    if (this.cfg.level <= 0) want = [];
    this.active = want;
    // layers: build what is wanted, fade out what is not
    const wantLayers = new Map<string, { kind: LayerKind; level: number }>();
    for (const b of want) for (const l of BEDS[b]?.layers ?? []) wantLayers.set(`${b}:${l.kind}`, { kind: l.kind, level: l.level });
    for (const [key, w] of wantLayers) {
      let inst = this.layers.get(key);
      if (!inst) {
        inst = this.build(key, w.kind, w.level, now);
        this.layers.set(key, inst);
      }
      if (inst.kind === 'compressor') this.cycle(inst, L, v.listener, now);
    }
    for (const [key, inst] of this.layers) if (!wantLayers.has(key)) this.release(key, inst, now);
    // one-shots
    if (!L || !v.listener) return;
    const rk = `${L.seed}|${L.hash}`;
    if (rk !== this.rngKey) { this.rngKey = rk; this.rng = makeRng(rk, 'audio:beds'); this.nextAt.clear(); }
    const rng = this.rng!;
    for (const b of want) {
      const def = BEDS[b];
      if (!def) continue;
      def.events.forEach((e, idx) => {
        const key = `${b}:${idx}`;
        let at = this.nextAt.get(key);
        if (at === undefined) { at = now + nextGap(rng, e.meanSec, e.periodic) * (e.periodic ? 1 : 0.5); this.nextAt.set(key, at); }
        if (now < at) return;
        // late (tab was hidden, a long frame): skip ahead instead of firing a burst
        this.nextAt.set(key, Math.max(now, at) + nextGap(rng, e.meanSec, e.periodic));
        if (now - at > 2) return;
        const pos = eventPos(L, v.listener!, sp, e.where, this.cfg.eventRadiusM, rng);
        this.host.play(e.kind, pos, e.level, rng.int(1, 0x7fffffff));
      });
    }
    for (const key of [...this.nextAt.keys()]) if (!want.includes(key.slice(0, key.lastIndexOf(':')))) this.nextAt.delete(key);
  }

  dispose(): void {
    const now = this.ac.currentTime;
    for (const [key, inst] of this.layers) this.release(key, inst, now);
    this.reap(Infinity);
    try { this.bus.disconnect(); } catch { /* ignore */ }
  }

  private bedNoise(): AudioBuffer {
    if (this.noise) return this.noise;
    // 7.3 s (not a round period): the longer loop keeps wind / water from audibly repeating
    const sr = this.ac.sampleRate;
    const buf = this.ac.createBuffer(1, Math.floor(sr * 7.3), sr);
    const d = buf.getChannelData(0);
    const rnd = makeNoise(0xbedbed);
    for (let i = 0; i < d.length; i++) d[i] = rnd();
    this.noise = buf;
    return buf;
  }

  private build(key: string, kind: LayerKind, level: number, now: number): LayerInst {
    const ac = this.ac;
    const sr = ac.sampleRate;
    const gain = new GainNode(ac, { gain: 0 });
    gain.connect(this.bus);
    const nodes: AudioNode[] = [gain];
    const sources: AudioScheduledSourceNode[] = [];
    let k = 0;
    for (const p of LAYERS[kind]) {
      k++;
      let head: AudioScheduledSourceNode;
      let node: AudioNode;
      let rms: number;
      if (p.t === 'noise') {
        const s = new AudioBufferSourceNode(ac, { buffer: this.bedNoise(), loop: true, playbackRate: p.rate });
        s.start(now, (k * 1.37) % 7);
        head = s;
        rms = noiseRms(p.filters, sr, p.rate);
      } else {
        const o = new OscillatorNode(ac, { type: p.wave, frequency: p.f });
        o.start(now);
        head = o;
        rms = p.filters?.length ? oscRms(p.wave, p.f, p.filters, sr) : p.wave === 'sine' ? 0.7071 : oscRms(p.wave, p.f, [], sr);
      }
      nodes.push(head);
      sources.push(head);
      node = head;
      const filters: BiquadFilterNode[] = [];
      for (const f of p.filters ?? []) {
        const bq = new BiquadFilterNode(ac, { type: f.type, frequency: f.f, Q: f.q });
        node.connect(bq);
        node = bq;
        nodes.push(bq);
        filters.push(bq);
      }
      if (p.t === 'noise' && p.sweep && filters[0]) {
        const lfo = new OscillatorNode(ac, { type: 'sine', frequency: p.sweep.rate });
        const lg = new GainNode(ac, { gain: p.sweep.depth });
        lfo.connect(lg).connect(filters[0].frequency);
        lfo.start(now);
        nodes.push(lfo, lg);
        sources.push(lfo);
      }
      if (p.am) {
        const amg = new GainNode(ac, { gain: 1 - p.am.depth / 2 });
        const lfo = new OscillatorNode(ac, { type: 'sine', frequency: p.am.rate });
        const lg = new GainNode(ac, { gain: -p.am.depth / 2 });
        lfo.connect(lg).connect(amg.gain);
        lfo.start(now);
        node.connect(amg);
        node = amg;
        nodes.push(amg, lfo, lg);
        sources.push(lfo);
      }
      const pg = new GainNode(ac, { gain: rms > 1e-6 ? Math.min(40, p.rms / rms) : 0 });
      node.connect(pg).connect(gain);
      nodes.push(pg);
    }
    const inst: LayerInst = { key, kind, level, gain, nodes, sources, on: true, until: 0 };
    if (kind === 'compressor') { inst.on = false; inst.until = now + 2; }
    else targetTo(gain.gain, level, now, Math.max(0.05, this.cfg.fadeSec / 3));
    this.nodeCount += nodes.length;
    return inst;
  }

  /** cold storage: the compressor runs 25-45 s, rests 15-30 s; a clunk on start, a wind-down on stop */
  private cycle(inst: LayerInst, L: LevelLayout | null, listener: V3 | null, now: number): void {
    if (now < inst.until) return;
    const rng = this.rng ?? makeRng('beds', 'audio:compressor');
    inst.on = !inst.on;
    inst.until = now + (inst.on ? 25 + 20 * rng.next() : 15 + 15 * rng.next());
    targetTo(inst.gain.gain, inst.on ? inst.level : 0, now, inst.on ? 0.5 : 0.8);
    if (L && listener) this.host.play(inst.on ? 'compressor_on' : 'compressor_off', eventPos(L, listener, spaceOf(L, listener[0], listener[2]), 'far', this.cfg.eventRadiusM, rng), 0.35, rng.int(1, 0x7fffffff));
  }

  private release(key: string, inst: LayerInst, now: number): void {
    this.layers.delete(key);
    const tc = Math.max(0.05, this.cfg.fadeSec / 3);
    try {
      inst.gain.gain.cancelScheduledValues(now);
      inst.gain.gain.setTargetAtTime(0, now, tc);
    } catch { /* ignore */ }
    this.dying.push({ nodes: inst.nodes, sources: inst.sources, at: now + tc * 6 });
  }

  private reap(now: number): void {
    if (!this.dying.length) return;
    const left: { nodes: AudioNode[]; sources: AudioScheduledSourceNode[]; at: number }[] = [];
    for (const d of this.dying) {
      if (d.at > now) { left.push(d); continue; }
      for (const s of d.sources) { try { s.stop(); } catch { /* ignore */ } }
      for (const n of d.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
      this.nodeCount -= d.nodes.length;
    }
    this.dying = left;
  }
}

function spaceOf(L: Pick<LevelLayout, 'W' | 'H' | 'owner'>, x: number, z: number): number {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (!Number.isFinite(cx) || !Number.isFinite(cz) || cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return -1;
  return L.owner[cz * L.W + cx] ?? -1;
}

/** where a bed one-shot happens: in the listener's room (or a neighbour within radius), or 10-18 m away ('far') */
export function eventPos(L: LevelLayout, listener: V3, sp: number, where: Where, radius: number, rng: Rng): V3 | null {
  if (where === 'far') {
    const a = rng.next() * Math.PI * 2;
    const d = 10 + 8 * rng.next();
    const x = Math.max(0.5, Math.min(L.W - 0.5, listener[0] + Math.cos(a) * d));
    const z = Math.max(0.5, Math.min(L.H - 0.5, listener[2] + Math.sin(a) * d));
    return [x, 1.5, z];
  }
  let s = sp >= 0 ? L.spaces[sp] : undefined;
  if (!s || rng.next() < 0.35) {
    const r2 = radius * radius;
    const near = L.spaces.filter((q) => {
      const cx = q.rect.x + q.rect.w / 2, cz = q.rect.y + q.rect.h / 2;
      return (cx - listener[0]) ** 2 + (cz - listener[2]) ** 2 <= r2;
    });
    if (near.length) s = near[Math.floor(rng.next() * near.length)];
  }
  if (!s) return null;
  const x = s.rect.x + 0.4 + Math.max(0, s.rect.w - 0.8) * rng.next();
  const z = s.rect.y + 0.4 + Math.max(0, s.rect.h - 0.8) * rng.next();
  const y = where === 'ceiling' ? Math.max(1.8, (L.wallH || 3) - 0.2) : where === 'floor' ? 0.15 : 1.2;
  return [x, y, z];
}
