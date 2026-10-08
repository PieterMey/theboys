// Owner: env-audio (v1.2). Small pure DSP helpers for the synth's level calibration (no Web Audio needed): the Web
// Audio spec's BiquadFilterNode coefficients (lowpass / highpass Q in dB, bandpass Q linear) and their magnitude
// responses, used by voiceMakeup() so a synth voice's env peak means "as loud (RMS) as a sine of that amplitude"
// whatever filters it runs through. Unit-tested against an offline render in tests/audio/synth.test.ts.

export type FiltType = 'lowpass' | 'highpass' | 'bandpass';
export interface FiltSpec { type: FiltType; f: number; q: number; f1?: number }
export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';

/** normalized biquad (a0 = 1) */
export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** Web Audio BiquadFilterNode coefficients (spec "Filters characteristics") */
export function biquad(type: FiltType, f: number, q: number, sr: number): Biquad {
  const nyq = sr / 2;
  const fc = Math.max(1, Math.min(nyq * 0.999, Number.isFinite(f) ? f : 1000));
  const w0 = (2 * Math.PI * fc) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  let b0: number, b1: number, b2: number;
  let alpha: number;
  if (type === 'bandpass') {
    alpha = sw / (2 * Math.max(1e-4, q));
    b0 = alpha; b1 = 0; b2 = -alpha;
  } else {
    // lowpass / highpass: Q is in dB
    alpha = sw / (2 * Math.pow(10, (Number.isFinite(q) ? q : 0) / 20));
    if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  }
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** |H(f)|^2 of one biquad */
export function biquadMag2(c: Biquad, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  const den = dr * dr + di * di;
  return den > 1e-30 ? (nr * nr + ni * ni) / den : 0;
}

/** filters at their mid-sweep frequency (geometric mean of f and f1) */
function coeffs(filters: readonly FiltSpec[], sr: number): Biquad[] {
  return filters.map((x) => biquad(x.type, x.f1 !== undefined ? Math.sqrt(x.f * x.f1) : x.f, x.q, sr));
}
const chain2 = (cs: readonly Biquad[], f: number, sr: number): number => {
  let m = 1;
  for (const c of cs) m *= biquadMag2(c, f, sr);
  return m;
};

/** Fourier amplitude of harmonic n of a peak-1 wave */
export function harmonic(wave: Wave, n: number): number {
  if (wave === 'sine') return n === 1 ? 1 : 0;
  if (wave === 'sawtooth') return 2 / (Math.PI * n);
  if (n % 2 === 0) return 0;
  return wave === 'square' ? 4 / (Math.PI * n) : 8 / (Math.PI * Math.PI * n * n);
}

/** steady-state RMS of a peak-1 oscillator at f through filters (band-limited like OscillatorNode) */
export function oscRms(wave: Wave, f: number, filters: readonly FiltSpec[], sr: number): number {
  const nyq = sr / 2;
  const cs = coeffs(filters, sr);
  let e = 0;
  for (let n = 1; n <= 96 && n * f < nyq; n++) {
    const a = harmonic(wave, n);
    if (a === 0) continue;
    e += (a * a * chain2(cs, n * f, sr)) / 2;
  }
  return Math.sqrt(e);
}

/** RMS of uniform white noise in [-1, 1] (played at playbackRate `rate`) through filters */
export function noiseRms(filters: readonly FiltSpec[], sr: number, rate = 1): number {
  const band = (sr / 2) * Math.min(1, Math.max(0.05, rate));
  const cs = coeffs(filters, sr);
  // integrate |H|^2 over [0, band] on a log grid (filters are narrow-ish: log spacing resolves them)
  const N = 160, lo = 10;
  let acc = 0;
  let pf = 0, pm = chain2(cs, lo, sr);
  acc += pm * lo; // [0, lo] ~ flat
  for (let i = 1; i <= N; i++) {
    const f = lo * Math.pow(band / lo, i / N);
    const m = chain2(cs, f, sr);
    acc += ((m + pm) / 2) * (f - (pf || lo));
    pf = f;
    pm = m;
  }
  const frac = Math.max(0, acc / band);
  return Math.sqrt(frac / 3); // uniform noise power = 1/3
}

/**
 * gain that makes a voice (env peak 1) as loud as a sine of amplitude 1 (RMS 0.707): oscillators via their harmonics
 * through the filters, noise via the filters' noise bandwidth, tick bursts like noise. Clamped to [0.25, MAX_MAKEUP].
 */
export const MAX_MAKEUP = 24;
export function makeupFor(src: { t: 'osc'; wave: Wave; f: number; f1?: number } | { t: 'noise'; rate: number } | { t: 'ticks' },
  filters: readonly FiltSpec[], sr: number): number {
  let rms: number;
  if (src.t === 'osc') {
    if (!filters.length && src.wave === 'sine') return 1;
    const f = src.f1 !== undefined ? Math.sqrt(src.f * src.f1) : src.f;
    rms = oscRms(src.wave, f, filters, sr);
  } else if (src.t === 'noise') rms = noiseRms(filters, sr, src.rate);
  else rms = noiseRms(filters, sr, 1) * 1.6; // bursts: keep their bite (unfiltered ticks stay ~as authored)
  if (!(rms > 1e-6) || !Number.isFinite(rms)) return MAX_MAKEUP;
  return Math.max(0.25, Math.min(MAX_MAKEUP, 0.7071 / rms));
}
