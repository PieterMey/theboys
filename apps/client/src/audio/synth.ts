// Owner: env-audio (v1.2). Procedural sounds without assets: services.sfx.synth(kind, pos?, opts?).
// planSynth(kind, opts) is a PURE, seeded description (makeRng, never Math.random): the same opts.seed gives the same
// plan on every client. playPlan() schedules a plan on any BaseAudioContext (live or offline) and returns every node
// it made, so the caller disconnects them once the last source ended. No ScriptProcessorNode, no assets.
// Never breath or a whisper (breath is the Listener's retreat cue, plan check #14), never the Mannequin's scrape loop.
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import type { KnockPattern, SynthKind, SynthOpts } from './api.ts';
import { makeupFor } from './dsp.ts';
import type { FiltType, Wave } from './dsp.ts';
import { makeNoise } from './graph.ts';

/** every SynthKind synth() builds (all of the contract's MUST + SHOULD kinds) */
export const SYNTH_KINDS: readonly SynthKind[] = [
  'knock', 'handle_rattle', 'chair_scrape', 'glass_creak', 'glass_squeak', 'glass_crack', 'frost', 'relay_tink', 'filament_pop', 'wet_step',
  'music_box', 'phone_bell', 'radio_sweep', 'tv_static', 'clock_chime', 'pipe_groan',
];
/** internal one-shots of the theme beds (beds.ts): not part of the public contract */
export type BedKind = 'drip' | 'creak' | 'paper' | 'selector' | 'thump' | 'clank' | 'rattle' | 'compressor_on' | 'compressor_off';
export const BED_KINDS: readonly BedKind[] = ['drip', 'creak', 'paper', 'selector', 'thump', 'clank', 'rattle', 'compressor_on', 'compressor_off'];
export type PlanKind = SynthKind | BedKind;

export interface OscSrc { t: 'osc'; wave: Wave; f: number; f1?: number; glide?: number; vib?: { rate: number; depth: number } }
export interface NoiseSrc { t: 'noise'; rate: number; offset: number }
/** sparse decaying noise bursts rendered into a buffer (crackle, spreading cracks, relay selectors) */
export interface TickSrc { t: 'ticks'; times: number[]; amps: number[]; ring: number; seed: number }
export type Src = OscSrc | NoiseSrc | TickSrc;
export interface Filt { type: FiltType; f: number; q: number; f1?: number; sweep?: number }
/** linear attack a, hold h, exponential decay d (s); peak = loudness of a sine of that amplitude (dsp.makeupFor) */
export interface Env { a: number; h: number; d: number; peak: number }
/** amplitude modulation: gain swings between 1 - depth and 1 (stick-slip chatter, bell trill) */
export interface Am { rate: number; depth: number; wave: Wave; delay?: number }
export interface Voice { at: number; src: Src; filters: Filt[]; env: Env; am?: Am }
export interface SynthPlan {
  kind: PlanKind;
  seed: number;
  /** seconds until the last voice has decayed */
  dur: number;
  /** plan output trim (x opts.volume) */
  gain: number;
  /** spatial falloff radius (m) */
  radius: number;
  voices: Voice[];
}

export const SYNTH_LIMITS = { maxDur: 16, minHz: 20, maxHz: 18000, maxQ: 30, maxVoices: 160, maxPeak: 1 } as const;

interface NOpts { pattern: KnockPattern; count: number | null; ms: number | null }
interface B { r: Rng; v: Voice[]; o: NOpts }

const R = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r.next();
const jit = (r: Rng, v: number, k: number): number => v * (1 + (r.next() * 2 - 1) * k);
const clampN = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const E = (a: number, h: number, d: number, peak: number): Env => ({ a, h, d, peak });
const osc = (wave: Wave, f: number, f1?: number, glide?: number): OscSrc =>
  f1 !== undefined ? { t: 'osc', wave, f, f1, glide: glide ?? 0.05 } : { t: 'osc', wave, f };
const sine = (f: number, f1?: number, glide?: number): OscSrc => osc('sine', f, f1, glide);
const noise = (b: B, rate = 1): NoiseSrc => ({ t: 'noise', rate, offset: b.r.next() * 1.8 });
const bp = (f: number, q: number, f1?: number, sweep?: number): Filt => (f1 !== undefined ? { type: 'bandpass', f, q, f1, sweep: sweep ?? 0.1 } : { type: 'bandpass', f, q });
const lp = (f: number, q = 0.7): Filt => ({ type: 'lowpass', f, q });
const hp = (f: number, q = 0.7): Filt => ({ type: 'highpass', f, q });
function add(b: B, at: number, src: Src, filters: Filt[], env: Env, am?: Am): void {
  b.v.push(am ? { at, src, filters, env, am } : { at, src, filters, env });
}
/** sorted burst times over [t0, t1] (density skew > 1 packs them late, < 1 early) and their amplitudes */
function ticks(b: B, n: number, t0: number, t1: number, skew: number, ampLo: number, ampHi: number, ring: number, fade = false): TickSrc {
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push(t0 + (t1 - t0) * Math.pow(b.r.next(), skew));
  times.sort((x, y) => x - y);
  const amps = times.map((t) => R(b.r, ampLo, ampHi) * (fade ? 1 - 0.7 * ((t - t0) / Math.max(1e-3, t1 - t0)) : 1));
  return { t: 'ticks', times, amps, ring, seed: b.r.int(1, 0x7fffffff) };
}

// ---------------------------------------------------------------- recipes

function knockHit(b: B, pat: KnockPattern, t: number, vel: number): void {
  const r = b.r;
  if (pat === 'metal') {
    const f0 = R(r, 170, 240);
    const ratio = [1, 2.32, 4.25, 6.63], dec = [0.6, 0.38, 0.22, 0.12], pk = [0.3, 0.2, 0.12, 0.07];
    for (let k = 0; k < 4; k++) add(b, t, sine(jit(r, f0 * ratio[k], 0.02)), [], E(0.0008, 0, jit(r, dec[k], 0.1), pk[k] * vel));
    add(b, t, noise(b), [bp(R(r, 700, 1100), 1.1)], E(0.0005, 0.002, 0.03, 0.55 * vel));
    add(b, t, sine(70, 52, 0.05), [], E(0.001, 0, 0.09, 0.4 * vel));
  } else if (pat === 'locker') {
    const f0 = R(r, 300, 400);
    const ratio = [1, 1.71, 2.94, 4.4], dec = [0.24, 0.17, 0.11, 0.08], pk = [0.22, 0.18, 0.13, 0.08];
    for (let k = 0; k < 4; k++) add(b, t, sine(jit(r, f0 * ratio[k], 0.02)), [], E(0.0008, 0, jit(r, dec[k], 0.1), pk[k] * vel));
    add(b, t, noise(b), [bp(R(r, 2200, 2800), 2.5)], E(0.001, 0.01, 0.07, 0.25 * vel), { rate: R(r, 38, 55), depth: 0.85, wave: 'square' });
    add(b, t, noise(b), [bp(R(r, 500, 700), 1.3)], E(0.0005, 0.002, 0.03, 0.55 * vel));
  } else {
    // wood: a dull door panel "bonk" (two falling modes) + knuckle + a short ring + the click of the knuckle
    const f = R(r, 100, 130);
    add(b, t, sine(f, f * 0.72, 0.04), [], E(0.0015, 0, 0.11, 0.5 * vel));
    const p = R(r, 210, 260);
    add(b, t, sine(p, p * 0.9, 0.06), [], E(0.001, 0, 0.07, 0.3 * vel));
    add(b, t, noise(b), [bp(R(r, 900, 1300), 0.9)], E(0.0008, 0.002, 0.03, 0.45 * vel));
    add(b, t, noise(b), [bp(R(r, 480, 650), 6)], E(0.001, 0, 0.06, 0.3 * vel));
    add(b, t, noise(b), [hp(2500)], E(0.0005, 0, 0.008, 0.2 * vel));
  }
}

function knock(b: B): void {
  const r = b.r, pat = b.o.pattern;
  const n = Math.round(clampN(b.o.count ?? (pat === 'metal' ? r.int(2, 3) : r.int(2, 4)), 1, 8));
  const gap = pat === 'locker' ? R(r, 0.16, 0.24) : R(r, 0.2, 0.32);
  // 0: even, 1: a pause before the last knock, 2: a pause after the first
  const shape = r.int(0, 2);
  let t = 0.01;
  for (let i = 0; i < n; i++) {
    knockHit(b, pat, t, i === 0 ? 1 : R(r, 0.72, 0.95));
    let g = jit(r, gap, 0.12);
    if (shape === 1 && i === n - 2) g *= 1.9;
    if (shape === 2 && i === 0 && n > 2) g *= 1.9;
    t += g;
  }
}

function handleRattle(b: B): void {
  const r = b.r;
  add(b, 0.01, noise(b), [bp(R(r, 260, 340), 3)], E(0.001, 0.005, 0.05, 0.5));
  add(b, 0.01, sine(140, 110, 0.04), [], E(0.001, 0, 0.05, 0.2));
  const n = Math.round(clampN(b.o.count ?? r.int(5, 9), 2, 16));
  let t = 0.09;
  for (let i = 0; i < n; i++) {
    add(b, t, noise(b), [bp(R(r, 2600, 3800), 5)], E(0.0005, 0.001, 0.025, R(r, 0.3, 0.5)));
    if (i % 2 === 0) add(b, t + 0.004, noise(b), [bp(R(r, 900, 1300), 4)], E(0.0008, 0.002, 0.03, 0.35));
    t += R(r, 0.045, 0.11);
  }
  add(b, t + 0.06, noise(b), [bp(R(r, 240, 300), 3)], E(0.001, 0.005, 0.06, 0.45));
}

/** one short wooden chair scrape (stick-slip chatter through the chair's body resonance), never a loop */
function chairScrape(b: B): void {
  const r = b.r;
  const D = R(r, 0.35, 0.65);
  const f = R(r, 34, 46), f1 = f * R(r, 1.15, 1.4);
  const body = R(r, 330, 420);
  add(b, 0.01, osc('sawtooth', f, f1, D), [bp(body, 4, body * 1.25, D)], E(0.035, D * 0.55, D * 0.35, 0.45));
  add(b, 0.01, osc('sawtooth', f, f1, D), [bp(R(r, 850, 1100), 7)], E(0.05, D * 0.5, D * 0.3, 0.16));
  add(b, 0.01, noise(b), [bp(R(r, 1400, 1900), 1.5)], E(0.03, D * 0.6, D * 0.3, 0.12), { rate: f, depth: 0.8, wave: 'sawtooth' });
  add(b, 0.01 + D, sine(95, 70, 0.05), [], E(0.001, 0, 0.07, 0.28));
  add(b, 0.01 + D, noise(b), [bp(300, 2)], E(0.001, 0, 0.04, 0.25));
}

function glassCreak(b: B): void {
  const r = b.r;
  const D = R(r, 0.7, 1.3);
  const f = R(r, 90, 150);
  const fc = R(r, 2200, 3200);
  add(b, 0.01, osc('sawtooth', f, f * R(r, 0.8, 1.25), D), [hp(1100), bp(fc, 9, fc * R(r, 0.9, 1.15), D)], E(D * 0.2, D * 0.45, D * 0.35, 0.3),
    { rate: R(r, 7, 12), depth: 0.6, wave: 'triangle' });
  const n = r.int(3, 6);
  for (let i = 0; i < n; i++) add(b, R(r, 0.05, D), noise(b), [bp(R(r, 4500, 6500), 8)], E(0.0005, 0, 0.012, R(r, 0.12, 0.22)));
}

function glassSqueak(b: B): void {
  const r = b.r;
  const k = Math.round(clampN(b.o.count ?? r.int(1, 3), 1, 6));
  let t = 0.01;
  for (let i = 0; i < k; i++) {
    const D = R(r, 0.18, 0.45);
    const f = R(r, 950, 1500);
    const src: OscSrc = { t: 'osc', wave: 'triangle', f, f1: f * R(r, 0.8, 1.3), glide: D, vib: { rate: R(r, 6, 9), depth: R(r, 15, 35) } };
    add(b, t, src, [bp(f, 3)], E(0.025, D * 0.6, D * 0.3, 0.55), { rate: R(r, 55, 90), depth: 0.45, wave: 'sawtooth' });
    t += D + R(r, 0.08, 0.25);
  }
}

function glassCrack(b: B): void {
  const r = b.r;
  const D = R(r, 0.6, 1.0);
  add(b, 0.01, noise(b), [hp(2500)], E(0.0004, 0.002, 0.035, 0.7));
  add(b, 0.01, sine(R(r, 150, 190), 130, 0.03), [], E(0.001, 0, 0.05, 0.25));
  const fs = [R(r, 3100, 4200), R(r, 5200, 6800), R(r, 7400, 8800)];
  const ds = [R(r, 0.12, 0.2), R(r, 0.08, 0.14), R(r, 0.05, 0.1)];
  const ps = [0.16, 0.11, 0.07];
  for (let i = 0; i < 3; i++) add(b, 0.012, sine(fs[i]), [], E(0.0005, 0, ds[i], ps[i]));
  add(b, 0.04, ticks(b, r.int(12, 28), 0, D - 0.05, 0.8, 0.3, 1, 0.004, true), [hp(3000)], E(0.001, D - 0.12, 0.1, 0.35));
}

function frost(b: B): void {
  const r = b.r;
  const D = clampN((b.o.ms ?? 3500) / 1000, 0.8, 12);
  const n = Math.round(D * R(r, 14, 22));
  add(b, 0, ticks(b, n, 0.05, D - 0.1, 0.7, 0.2, 1, 0.003), [bp(R(r, 3800, 5200), 0.8)], E(0.25, Math.max(0.05, D - 0.75), 0.5, 0.3));
  add(b, 0, noise(b), [hp(6500)], E(0.4, Math.max(0.05, D - 0.9), 0.5, 0.05));
  const w = R(r, 220, 300);
  add(b, 0, noise(b, 0.5), [lp(420), bp(w, 1.2, w * R(r, 1.4, 1.8), D)], E(D * 0.3, D * 0.3, D * 0.4, 0.3),
    { rate: R(r, 0.15, 0.3), depth: 0.5, wave: 'sine' });
}

function relayTink(b: B): void {
  const r = b.r;
  add(b, 0.005, noise(b), [hp(3000)], E(0.0003, 0, 0.005, 0.6));
  add(b, 0.005, sine(R(r, 3200, 4100)), [], E(0.0005, 0, 0.05, 0.14));
  add(b, 0.005, sine(R(r, 5300, 6200)), [], E(0.0005, 0, 0.03, 0.08));
  add(b, 0.005, noise(b), [bp(R(r, 170, 230), 2)], E(0.0008, 0, 0.025, 0.35));
  if (r.chance(0.6)) add(b, 0.005 + R(r, 0.008, 0.018), noise(b), [hp(3000)], E(0.0003, 0, 0.004, 0.3));
}

function filamentPop(b: B): void {
  const r = b.r;
  add(b, 0.005, sine(320, 110, 0.03), [], E(0.0008, 0, 0.045, 0.45));
  add(b, 0.005, noise(b), [bp(R(r, 1200, 1700), 1)], E(0.0005, 0.002, 0.014, 0.6));
  add(b, 0.006, noise(b), [hp(4500)], E(0.002, 0.01, 0.12, 0.12));
  add(b, 0.006, sine(R(r, 4800, 6000)), [], E(0.0005, 0, 0.07, 0.07));
}

function wetStep(b: B): void {
  const r = b.r;
  const sq = R(r, 1000, 1300);
  add(b, 0.005, noise(b), [bp(sq, 2.5, sq * 0.45, 0.08)], E(0.004, 0.01, 0.09, 0.4));
  const th = R(r, 80, 95);
  add(b, 0.005, sine(th, th * 0.72, 0.05), [], E(0.002, 0, 0.07, 0.35));
  add(b, 0.005, noise(b), [bp(R(r, 2200, 2800), 1.5)], E(0.0008, 0.002, 0.02, 0.22));
  const n = r.int(1, 3);
  for (let i = 0; i < n; i++) {
    const f = R(r, 1500, 2600);
    add(b, R(r, 0.05, 0.22), sine(f, f * R(r, 1.3, 1.6), R(r, 0.015, 0.03)), [], E(0.001, 0, R(r, 0.025, 0.04), R(r, 0.05, 0.1)));
  }
}

/** original minor lullaby phrases (semitones from the tonic; null = rest) */
const LULLABY: readonly (readonly (number | null)[])[] = [
  [0, 7, 5, 3, 2, 3, 0, null, -4, 0, 3, 2, -1, 2, -5, null],
  [0, 3, 7, 8, 7, 5, 3, 2, 3, 0, -4, -5, 0, null],
];

function musicBox(b: B): void {
  const r = b.r;
  const which = r.int(0, 2);
  const notes = which === 2 ? [...LULLABY[0], ...LULLABY[1]] : [...LULLABY[which]];
  const tonic = 880 * Math.pow(2, [-2, 0, 3][r.int(0, 2)] / 12);
  const step = R(r, 0.3, 0.38);
  const slow = R(r, 0.2, 0.7); // the spring winding down
  const maxT = clampN((b.o.ms ?? 9000) / 1000, 1.5, 13);
  let t = 0.02;
  for (let i = 0; i < notes.length; i++) {
    const s = notes[i];
    if (t > maxT - 1.2) break;
    if (s !== null) {
      const f = tonic * Math.pow(2, s / 12);
      add(b, t, sine(f), [], E(0.002, 0, R(r, 1.1, 1.5), 0.5));
      add(b, t, sine(f * 6.27), [], E(0.001, 0, 0.12, 0.1));
    }
    t += step * (1 + slow * Math.pow(i / notes.length, 2)) * jit(r, 1, 0.03);
  }
}

/** an old two-gong telephone bell: 440 + 480 Hz struck at 20 Hz; rings 2 s on / 4 s off up to opts.ms */
function phoneBell(b: B): void {
  const total = clampN((b.o.ms ?? 2000) / 1000, 0.4, 12);
  for (let at = 0.01; at < total; at += 6) {
    const L = Math.min(2, total - at);
    const am = (delay: number): Am => ({ rate: 20, depth: 0.85, wave: 'square', delay });
    add(b, at, sine(440), [], E(0.008, L, 0.35, 0.4), am(0));
    add(b, at, sine(480), [], E(0.008, L, 0.35, 0.4), am(0.025));
    add(b, at, sine(440 * 2.52), [], E(0.004, L, 0.25, 0.12), am(0));
    add(b, at, sine(480 * 2.52), [], E(0.004, L, 0.25, 0.12), am(0.025));
  }
}

/** tuning across a dead dial: swept hiss, heterodyne whistles, carrier snatches (no voices) */
function radioSweep(b: B): void {
  const r = b.r;
  const D = clampN((b.o.ms ?? 2500) / 1000, 0.6, 10);
  const f = R(r, 600, 900);
  add(b, 0.01, noise(b), [hp(300), bp(f, 2.5, f * R(r, 3, 4.5), D * 0.7)], E(0.05, Math.max(0.05, D - 0.3), 0.25, 0.3),
    { rate: R(r, 7, 13), depth: 0.35, wave: 'triangle' });
  const k = r.int(2, 4);
  for (let i = 0; i < k; i++) {
    const w = R(r, 700, 2600);
    add(b, R(r, 0, D * 0.8), sine(w, w * R(r, 0.4, 2.2), R(r, 0.15, 0.45)), [], E(0.02, R(r, 0.05, 0.2), R(r, 0.1, 0.3), R(r, 0.05, 0.1)));
  }
  const c = r.int(1, 2);
  for (let i = 0; i < c; i++) add(b, R(r, 0.1, D * 0.7), sine(R(r, 500, 900)), [], E(0.03, R(r, 0.1, 0.3), 0.15, 0.08), { rate: R(r, 3, 6), depth: 0.7, wave: 'sine' });
}

function tvStatic(b: B): void {
  const r = b.r;
  const D = clampN((b.o.ms ?? 3000) / 1000, 0.5, 15);
  const H = Math.max(0.05, D - 0.3);
  add(b, 0.01, noise(b), [hp(150), lp(8500)], E(0.04, H, 0.25, 0.3));
  add(b, 0.01, sine(15734), [], E(0.1, Math.max(0.05, D - 0.4), 0.2, 0.01));
  add(b, 0.01, osc('sawtooth', 60), [lp(420)], E(0.05, Math.max(0.05, D - 0.35), 0.25, 0.06));
  add(b, 0.01, ticks(b, r.int(4, 10), 0.05, D - 0.1, 1, 0.4, 1, 0.002), [hp(1500)], E(0.01, Math.max(0.05, D - 0.1), 0.08, 0.25));
}

/** a mantel clock striking: bell partials (hum, prime, tierce, quint, nominal...) */
function clockChime(b: B): void {
  const r = b.r;
  const n = Math.round(clampN(b.o.count ?? r.int(2, 4), 1, 12));
  const f0 = R(r, 250, 320);
  const ratio = [0.5, 1, 1.183, 1.506, 2.0, 2.514, 2.662];
  const dec = [3.2, 2.4, 1.6, 1.2, 1.4, 0.8, 0.6];
  const pk = [0.13, 0.22, 0.13, 0.065, 0.16, 0.065, 0.05];
  const parts = n > 4 ? 5 : 7;
  for (let i = 0; i < n; i++) {
    const t = 0.01 + i * 1.6;
    for (let k = 0; k < parts; k++) add(b, t, sine(f0 * ratio[k]), [], E(0.002, 0, dec[k], pk[k]));
    add(b, t, noise(b), [bp(2200, 1.5)], E(0.0005, 0.001, 0.012, 0.2));
  }
}

function pipeGroan(b: B): void {
  const r = b.r;
  const D = clampN((b.o.ms ?? 2600) / 1000, 0.8, 9);
  const f = R(r, 48, 66), f1 = f * R(r, 0.85, 1.15);
  const vib = { rate: R(r, 0.3, 0.7), depth: 1.5 };
  const fc = R(r, 180, 260);
  add(b, 0.01, { t: 'osc', wave: 'sawtooth', f, f1, glide: D, vib }, [bp(fc, 9, fc * R(r, 1.2, 1.5), D)], E(D * 0.25, D * 0.45, D * 0.3, 0.4),
    { rate: R(r, 9, 14), depth: 0.45, wave: 'triangle' });
  add(b, 0.01, { t: 'osc', wave: 'sawtooth', f, f1, glide: D, vib }, [bp(R(r, 420, 520), 12)], E(D * 0.3, D * 0.4, D * 0.3, 0.14));
  add(b, 0.01, noise(b, 0.3), [lp(140)], E(D * 0.3, D * 0.4, D * 0.3, 0.2));
  if (r.chance(0.5)) {
    add(b, D * 0.95, sine(140), [], E(0.001, 0, 0.18, 0.25));
    add(b, D * 0.95, noise(b), [bp(700, 1.5)], E(0.0005, 0.001, 0.03, 0.35));
  }
}

// ---- bed one-shots (beds.ts)

function drip(b: B): void {
  const r = b.r;
  const f = R(r, 900, 1700);
  add(b, 0.005, sine(f, f * R(r, 1.5, 2.2), R(r, 0.012, 0.025)), [], E(0.0008, 0, R(r, 0.05, 0.09), 0.7));
  add(b, 0.005, noise(b), [bp(3200, 2)], E(0.0005, 0, 0.015, 0.05));
  if (r.chance(0.3)) {
    const f2 = f * R(r, 1.1, 1.3);
    add(b, R(r, 0.08, 0.2), sine(f2, f2 * 1.6, 0.015), [], E(0.0008, 0, 0.05, 0.12));
  }
}

/** a building creak (old joists, a settling frame): slower and lower than the chair scrape */
function creak(b: B): void {
  const r = b.r;
  const D = R(r, 0.4, 1.0);
  const f = R(r, 70, 140);
  add(b, 0.01, osc('sawtooth', f, f * R(r, 0.75, 1.3), D), [bp(R(r, 550, 900), 6)], E(D * 0.2, D * 0.4, D * 0.4, 0.25),
    { rate: R(r, 12, 20), depth: 0.6, wave: 'sawtooth' });
}

function paper(b: B): void {
  const r = b.r;
  const n = r.int(2, 4);
  for (let i = 0; i < n; i++) add(b, R(r, 0, 0.35), noise(b), [bp(R(r, 2500, 5000), 1.2), hp(1200)], E(0.01, R(r, 0.01, 0.05), R(r, 0.04, 0.12), R(r, 0.1, 0.2)));
}

/** telephone-exchange stepping selector: a burst of relay ticks at ~10 per second */
function selector(b: B): void {
  const r = b.r;
  const n = r.int(4, 10);
  const step = R(r, 0.085, 0.11);
  const times: number[] = [];
  const amps: number[] = [];
  for (let i = 0; i < n; i++) { times.push(i * step + R(r, -0.005, 0.005) + 0.006); amps.push(R(r, 0.6, 1)); }
  const len = times[times.length - 1] + 0.02;
  add(b, 0.005, { t: 'ticks', times, amps, ring: 0.003, seed: r.int(1, 0x7fffffff) }, [bp(R(r, 2400, 3200), 3)], E(0.001, len, 0.02, 0.6));
  add(b, 0.005, noise(b), [bp(220, 2)], E(0.001, 0, 0.02, 0.18));
}

function thump(b: B): void {
  const r = b.r;
  const f = R(r, 42, 50);
  add(b, 0.005, sine(f, f * 0.75, 0.15), [], E(0.01, 0.02, 0.28, 0.5));
  add(b, 0.005, noise(b, 0.4), [lp(160)], E(0.005, 0.01, 0.15, 0.35));
}

function clank(b: B): void {
  const r = b.r;
  const f0 = R(r, 120, 200);
  const ratio = [1, 2.32, 4.25], dec = [0.5, 0.3, 0.18], pk = [0.22, 0.14, 0.08];
  for (let k = 0; k < 3; k++) add(b, 0.005, sine(jit(r, f0 * ratio[k], 0.02)), [], E(0.0008, 0, dec[k], pk[k]));
  add(b, 0.005, noise(b), [bp(R(r, 500, 900), 1.2)], E(0.0005, 0.002, 0.03, 0.4));
}

function rattle(b: B): void {
  const r = b.r;
  const D = R(r, 0.3, 0.6);
  add(b, 0.005, ticks(b, r.int(8, 18), 0, D, 1, 0.3, 1, 0.004), [bp(R(r, 1500, 2200), 2)], E(0.01, D, 0.05, 0.7));
}

function compressor(b: B, on: boolean): void {
  if (on) {
    add(b, 0.005, sine(60, 45, 0.2), [], E(0.005, 0, 0.2, 0.4));
    add(b, 0.005, noise(b), [hp(3000)], E(0.0003, 0, 0.005, 0.3));
  } else add(b, 0.005, sine(50, 30, 0.4), [], E(0.01, 0.05, 0.5, 0.5));
}

const RECIPES: Record<PlanKind, { fn: (b: B) => void; gain: number; radius: number }> = {
  knock: { fn: knock, gain: 0.58, radius: 18 },
  handle_rattle: { fn: handleRattle, gain: 0.7, radius: 12 },
  chair_scrape: { fn: chairScrape, gain: 0.36, radius: 14 },
  glass_creak: { fn: glassCreak, gain: 0.45, radius: 10 },
  glass_squeak: { fn: glassSqueak, gain: 0.6, radius: 10 },
  glass_crack: { fn: glassCrack, gain: 0.7, radius: 16 },
  frost: { fn: frost, gain: 0.65, radius: 8 },
  relay_tink: { fn: relayTink, gain: 0.6, radius: 8 },
  filament_pop: { fn: filamentPop, gain: 0.52, radius: 10 },
  wet_step: { fn: wetStep, gain: 0.46, radius: 10 },
  music_box: { fn: musicBox, gain: 0.6, radius: 14 },
  phone_bell: { fn: phoneBell, gain: 0.6, radius: 25 },
  radio_sweep: { fn: radioSweep, gain: 0.5, radius: 14 },
  tv_static: { fn: tvStatic, gain: 0.5, radius: 14 },
  clock_chime: { fn: clockChime, gain: 0.6, radius: 25 },
  pipe_groan: { fn: pipeGroan, gain: 0.48, radius: 22 },
  drip: { fn: drip, gain: 0.6, radius: 10 },
  creak: { fn: creak, gain: 0.78, radius: 12 },
  paper: { fn: paper, gain: 0.75, radius: 8 },
  selector: { fn: selector, gain: 0.6, radius: 12 },
  thump: { fn: thump, gain: 0.6, radius: 20 },
  clank: { fn: clank, gain: 0.55, radius: 25 },
  rattle: { fn: rattle, gain: 0.6, radius: 16 },
  compressor_on: { fn: (b) => compressor(b, true), gain: 0.8, radius: 18 },
  compressor_off: { fn: (b) => compressor(b, false), gain: 0.6, radius: 18 },
};

export function isPlanKind(k: unknown): k is PlanKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(RECIPES, k);
}

let autoSeed = 0x2f6b;

/** seeded plan for a kind (null for unknown kinds). Same kind + opts (incl. seed) -> deep-equal plans. */
export function planSynth(kind: PlanKind, opts: SynthOpts = {}): SynthPlan | null {
  const rec = isPlanKind(kind) ? RECIPES[kind] : null;
  if (!rec) return null;
  const seed = Number.isFinite(opts.seed) ? Math.trunc(opts.seed as number) : (autoSeed = (autoSeed * 1103515245 + 12345) >>> 0);
  const o: NOpts = {
    pattern: opts.pattern === 'metal' || opts.pattern === 'locker' ? opts.pattern : 'wood',
    count: Number.isFinite(opts.count) ? (opts.count as number) : null,
    ms: Number.isFinite(opts.ms) && (opts.ms as number) > 0 ? (opts.ms as number) : null,
  };
  const b: B = { r: makeRng(seed, `synth:${kind}`), v: [], o };
  rec.fn(b);
  const rate = Number.isFinite(opts.rate) && (opts.rate as number) > 0 ? clampN(opts.rate as number, 0.5, 2) : 1;
  const voices = b.v.slice(0, SYNTH_LIMITS.maxVoices).map((v) => sanitize(rate === 1 ? v : scale(v, rate))).filter(fits);
  let dur = 0;
  for (const v of voices) dur = Math.max(dur, voiceEnd(v));
  return { kind, seed, dur: Math.min(SYNTH_LIMITS.maxDur, dur + 0.05), gain: rec.gain, radius: rec.radius, voices };
}

/** end time of a voice (s from the plan start) */
export function voiceEnd(v: Voice): number {
  return v.at + v.env.a + v.env.h + v.env.d;
}

/** keep a voice inside maxDur: shorten its hold, then its decay; drop it when even its attack would not fit */
function fits(v: Voice): boolean {
  const max = SYNTH_LIMITS.maxDur;
  if (v.at + v.env.a + 0.003 > max) return false;
  if (voiceEnd(v) > max) v.env.h = Math.max(0, Math.min(v.env.h, max - v.at - v.env.a - v.env.d));
  if (voiceEnd(v) > max) v.env.d = Math.max(0.003, max - v.at - v.env.a - v.env.h);
  return voiceEnd(v) <= max + 1e-9;
}

/** rate > 1: higher and faster (like playbackRate) */
function scale(v: Voice, rate: number): Voice {
  const src: Src = v.src.t === 'osc'
    ? { ...v.src, f: v.src.f * rate, ...(v.src.f1 !== undefined ? { f1: v.src.f1 * rate, glide: (v.src.glide ?? 0.05) / rate } : {}) }
    : v.src.t === 'noise' ? { ...v.src, rate: v.src.rate * rate }
      : { ...v.src, times: v.src.times.map((t) => t / rate) };
  return {
    at: v.at / rate, src,
    filters: v.filters.map((f) => ({ ...f, f: f.f * rate, ...(f.f1 !== undefined ? { f1: f.f1 * rate, sweep: (f.sweep ?? 0.1) / rate } : {}) })),
    env: { a: v.env.a / rate, h: v.env.h / rate, d: v.env.d / rate, peak: v.env.peak },
    ...(v.am ? { am: { ...v.am, rate: v.am.rate * rate } } : {}),
  };
}

const hz = (f: number): number => clampN(Number.isFinite(f) ? f : 440, SYNTH_LIMITS.minHz, SYNTH_LIMITS.maxHz);
const sec = (t: number, lo = 0): number => clampN(Number.isFinite(t) ? t : lo, lo, SYNTH_LIMITS.maxDur);

/** clamp every number into its legal range (no NaN / Infinity reaches an AudioParam) */
function sanitize(v: Voice): Voice {
  const s = v.src;
  const src: Src = s.t === 'osc'
    ? {
      t: 'osc', wave: s.wave, f: hz(s.f),
      ...(s.f1 !== undefined ? { f1: hz(s.f1), glide: sec(s.glide ?? 0.05, 0.001) } : {}),
      ...(s.vib ? { vib: { rate: clampN(s.vib.rate, 0.05, 40), depth: clampN(s.vib.depth, 0, 200) } } : {}),
    }
    : s.t === 'noise' ? { t: 'noise', rate: clampN(Number.isFinite(s.rate) ? s.rate : 1, 0.05, 4), offset: clampN(s.offset, 0, 1.9) }
      : { t: 'ticks', times: s.times.map((t) => sec(t)), amps: s.amps.map((a) => clampN(Number.isFinite(a) ? a : 0, 0, 1)), ring: clampN(s.ring, 0.0005, 0.05), seed: s.seed >>> 0 || 1 };
  return {
    at: sec(v.at), src,
    filters: v.filters.map((f) => ({
      type: f.type, f: hz(f.f), q: clampN(Number.isFinite(f.q) ? f.q : 1, 0.1, SYNTH_LIMITS.maxQ),
      ...(f.f1 !== undefined ? { f1: hz(f.f1), sweep: sec(f.sweep ?? 0.1, 0.001) } : {}),
    })),
    env: { a: sec(v.env.a, 0.0003), h: sec(v.env.h), d: sec(v.env.d, 0.003), peak: clampN(Number.isFinite(v.env.peak) ? v.env.peak : 0, 0, SYNTH_LIMITS.maxPeak) },
    ...(v.am ? { am: { rate: clampN(v.am.rate, 0.05, 60), depth: clampN(v.am.depth, 0, 1), wave: v.am.wave, ...(v.am.delay ? { delay: sec(v.am.delay) } : {}) } } : {}),
  };
}

/** sample count of a ticks buffer */
export function ticksLength(src: TickSrc, sr: number): number {
  let last = 0;
  for (const t of src.times) last = Math.max(last, t);
  return Math.max(1, Math.ceil((last + src.ring) * sr) + 2);
}

/** render the bursts of a ticks source into out (deterministic: seeded noise) */
export function fillTicks(out: Float32Array, sr: number, src: TickSrc): void {
  const ring = Math.max(1, Math.round(src.ring * sr));
  const rnd = makeNoise(src.seed);
  for (let k = 0; k < src.times.length; k++) {
    const i0 = Math.round(src.times[k] * sr);
    const a = src.amps[k] ?? 0;
    for (let j = 0; j < ring && i0 + j < out.length; j++) {
      const e = 1 - j / ring;
      out[i0 + j] += a * rnd() * e * e;
    }
  }
}

/** gain that makes a voice's env peak mean "as loud as a sine of that amplitude" (dsp.makeupFor) */
export function voiceMakeup(v: Voice, sr: number): number {
  return makeupFor(v.src, v.filters, sr);
}

export interface PlayedPlan {
  /** every node created (disconnect them all when done) */
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  /** the source that stops last (its onended = the plan is over) */
  last: AudioScheduledSourceNode | null;
  /** context time when the last source stops */
  end: number;
  /** plan output (gain = plan.gain x volume) */
  bus: GainNode;
}

/**
 * schedule a plan on ac at `when` into `out`. noise = a looping white-noise buffer (graph.noise). Every AudioParam
 * automation value is finite (sanitized plan); the envelopes end at exactly 0.
 */
export function playPlan(ac: BaseAudioContext, plan: SynthPlan, out: AudioNode, noise: AudioBuffer, when: number, volume = 1): PlayedPlan {
  const sr = ac.sampleRate;
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  const vol = Number.isFinite(volume) ? Math.max(0, Math.min(4, volume)) : 1;
  const bus = new GainNode(ac, { gain: plan.gain * vol });
  bus.connect(out);
  nodes.push(bus);
  let last: AudioScheduledSourceNode | null = null;
  let end = when;
  for (const v of plan.voices) {
    const peak = v.env.peak * voiceMakeup(v, sr);
    if (!(peak > 1e-6) || !Number.isFinite(peak)) continue;
    const t0 = when + v.at;
    const a = Math.max(0.0003, v.env.a), h = Math.max(0, v.env.h), d = Math.max(0.003, v.env.d);
    const tEnd = t0 + a + h + d;
    const stopAt = tEnd + 0.01;
    let src: AudioScheduledSourceNode;
    let buffered: AudioBufferSourceNode | null = null;
    let offset = 0;
    if (v.src.t === 'osc') {
      const s = v.src;
      const o = new OscillatorNode(ac, { type: s.wave, frequency: s.f });
      if (s.f1 !== undefined) {
        o.frequency.setValueAtTime(s.f, t0);
        o.frequency.exponentialRampToValueAtTime(s.f1, t0 + Math.max(0.001, s.glide ?? 0.05));
      }
      if (s.vib) {
        const lfo = new OscillatorNode(ac, { type: 'sine', frequency: s.vib.rate });
        const lg = new GainNode(ac, { gain: s.vib.depth });
        lfo.connect(lg).connect(o.frequency);
        lfo.start(t0);
        lfo.stop(stopAt);
        nodes.push(lfo, lg);
        sources.push(lfo);
      }
      src = o;
    } else if (v.src.t === 'noise') {
      src = buffered = new AudioBufferSourceNode(ac, { buffer: noise, loop: true, playbackRate: v.src.rate });
      offset = noise.duration > 0 ? v.src.offset % noise.duration : 0;
    } else {
      const buf = ac.createBuffer(1, ticksLength(v.src, sr), sr);
      fillTicks(buf.getChannelData(0), sr, v.src);
      src = buffered = new AudioBufferSourceNode(ac, { buffer: buf });
    }
    nodes.push(src);
    let node: AudioNode = src;
    for (const f of v.filters) {
      const bq = new BiquadFilterNode(ac, { type: f.type, frequency: f.f, Q: f.q });
      if (f.f1 !== undefined) {
        bq.frequency.setValueAtTime(f.f, t0);
        bq.frequency.exponentialRampToValueAtTime(f.f1, t0 + Math.max(0.001, f.sweep ?? tEnd - t0));
      }
      node.connect(bq);
      node = bq;
      nodes.push(bq);
    }
    if (v.am && v.am.depth > 0) {
      const amg = new GainNode(ac, { gain: 1 - v.am.depth / 2 });
      const lfo = new OscillatorNode(ac, { type: v.am.wave, frequency: v.am.rate });
      const lg = new GainNode(ac, { gain: -v.am.depth / 2 });
      lfo.connect(lg).connect(amg.gain);
      node.connect(amg);
      node = amg;
      lfo.start(t0 + (v.am.delay ?? 0));
      lfo.stop(stopAt);
      nodes.push(amg, lfo, lg);
      sources.push(lfo);
    }
    const env = new GainNode(ac, { gain: 0 });
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + a);
    if (h > 0) env.gain.setValueAtTime(peak, t0 + a + h);
    env.gain.exponentialRampToValueAtTime(peak * 1e-4, tEnd);
    env.gain.setValueAtTime(0, tEnd + 0.002);
    node.connect(env).connect(bus);
    nodes.push(env);
    if (buffered) buffered.start(t0, offset);
    else src.start(t0);
    src.stop(stopAt);
    sources.push(src);
    if (stopAt >= end) { end = stopAt; last = src; }
  }
  return { nodes, sources, last, end, bus };
}
