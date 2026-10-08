// Owner: env-audio (v1.2). Offline renderer for synth plans (tests only): mirrors synth.playPlan's semantics in plain
// JS (band-limited additive oscillators, the graph's noise buffer, tick buffers, Web Audio biquads from dsp.ts, AM,
// linear attack / hold / exponential decay) so the tests can measure each kind's real peak and RMS without a browser.
import { biquad } from '../../apps/client/src/audio/dsp.ts';
import type { Biquad, Wave } from '../../apps/client/src/audio/dsp.ts';
import { fillTicks, ticksLength, voiceMakeup } from '../../apps/client/src/audio/synth.ts';
import type { SynthPlan, Voice } from '../../apps/client/src/audio/synth.ts';
import { makeNoise } from '../../apps/client/src/audio/graph.ts';

const TAU = Math.PI * 2;

/** the graph's shared noise buffer (graph.ts getGraph: 2 s, makeNoise(0xdeadbeef)) */
export function graphNoise(sr: number): Float32Array {
  const n = new Float32Array(sr * 2);
  const rnd = makeNoise(0xdeadbeef);
  for (let i = 0; i < n.length; i++) n[i] = rnd();
  return n;
}

function waveAt(w: Wave, ph: number): number {
  const x = ph - Math.floor(ph);
  if (w === 'sine') return Math.sin(TAU * x);
  if (w === 'square') return x < 0.5 ? 1 : -1;
  if (w === 'sawtooth') return 2 * x - 1;
  return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
}

/** band-limited oscillator sample: harmonics below nyquist (max 64), peak ~1 like OscillatorNode */
function blOsc(w: Wave, ph: number, f: number, sr: number): number {
  if (w === 'sine') return Math.sin(TAU * ph);
  const nyq = sr / 2;
  let s = 0;
  for (let n = 1; n <= 64 && n * f < nyq; n++) {
    if (w === 'sawtooth') s += (2 / (Math.PI * n)) * Math.sin(TAU * n * ph) * (n % 2 ? 1 : -1);
    else if (n % 2 === 1) s += w === 'square' ? (4 / (Math.PI * n)) * Math.sin(TAU * n * ph) : (8 / (Math.PI * Math.PI * n * n)) * Math.sin(TAU * n * ph) * ((n - 1) / 2 % 2 ? -1 : 1);
  }
  return s;
}

class Bq {
  private c: Biquad;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(c: Biquad) { this.c = c; }
  set(c: Biquad): void { this.c = c; }
  run(x: number): number {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** render one voice (env peak x makeup) into out at sample rate sr */
export function renderVoice(v: Voice, out: Float32Array, sr: number, noise: Float32Array): void {
  const peak = v.env.peak * voiceMakeup(v, sr);
  if (!(peak > 0)) return;
  const a = Math.max(0.0003, v.env.a), h = Math.max(0, v.env.h), d = Math.max(0.003, v.env.d);
  const i0 = Math.round(v.at * sr);
  const n = Math.ceil((a + h + d) * sr);
  const filters = v.filters.map((f) => new Bq(biquad(f.type, f.f, f.q, sr)));
  let ticks: Float32Array | null = null;
  if (v.src.t === 'ticks') { ticks = new Float32Array(ticksLength(v.src, sr)); fillTicks(ticks, sr, v.src); }
  let ph = 0, lfoPh = 0, amPh = 0;
  let npos = v.src.t === 'noise' ? v.src.offset * sr : 0;
  const decayK = Math.log(1e-4) / (d * sr);
  for (let j = 0; j < n && i0 + j < out.length; j++) {
    const t = j / sr;
    // filter sweeps: exponential from f to f1 over sweep, every 32 samples
    if ((j & 31) === 0) v.filters.forEach((f, k) => {
      if (f.f1 === undefined) return;
      const s = Math.max(0.001, f.sweep ?? a + h + d);
      const fc = t >= s ? f.f1 : f.f * Math.pow(f.f1 / f.f, t / s);
      filters[k].set(biquad(f.type, fc, f.q, sr));
    });
    let x: number;
    if (v.src.t === 'osc') {
      const s = v.src;
      let f = s.f1 !== undefined ? (t >= (s.glide ?? 0.05) ? s.f1 : s.f * Math.pow(s.f1 / s.f, t / (s.glide ?? 0.05))) : s.f;
      if (s.vib) { f += s.vib.depth * Math.sin(TAU * lfoPh); lfoPh += s.vib.rate / sr; }
      x = blOsc(s.wave, ph, f, sr);
      ph += f / sr;
    } else if (v.src.t === 'noise') {
      const k = Math.floor(npos) % noise.length;
      const fr = npos - Math.floor(npos);
      x = noise[k] * (1 - fr) + noise[(k + 1) % noise.length] * fr;
      npos += v.src.rate;
    } else x = ticks && j < ticks.length ? ticks[j] : 0;
    for (const bq of filters) x = bq.run(x);
    if (v.am && v.am.depth > 0) {
      const started = t >= (v.am.delay ?? 0);
      const l = started ? waveAt(v.am.wave, amPh) : 0;
      if (started) amPh += v.am.rate / sr;
      x *= (1 - v.am.depth / 2) - (v.am.depth / 2) * l;
    }
    const e = t < a ? (peak * t) / a : t < a + h ? peak : peak * Math.exp(decayK * (j - (a + h) * sr));
    out[i0 + j] += x * e;
  }
}

export interface Rendered { data: Float32Array; peak: number; rmsDb: number; activeRmsDb: number; bad: number }

/** render a whole plan (mono) and measure it */
export function renderPlan(plan: SynthPlan, sr = 48000, volume = 1): Rendered {
  const data = new Float32Array(Math.ceil((plan.dur + 0.05) * sr));
  const noise = graphNoise(sr);
  for (const v of plan.voices) renderVoice(v, data, sr, noise);
  let peak = 0, sum = 0, bad = 0, act = 0, actN = 0;
  const g = plan.gain * volume;
  for (let i = 0; i < data.length; i++) {
    const x = data[i] * g;
    data[i] = x;
    if (!Number.isFinite(x)) { bad++; continue; }
    const ax = Math.abs(x);
    if (ax > peak) peak = ax;
    sum += x * x;
  }
  // "active" RMS: over the samples within 40 dB of the peak (ignores silent gaps)
  const floor = peak * 0.01;
  for (let i = 0; i < data.length; i++) { const x = data[i]; if (Math.abs(x) > floor) { act += x * x; actN++; } }
  const db = (p: number) => 10 * Math.log10(p + 1e-20);
  return { data, peak, rmsDb: db(sum / data.length), activeRmsDb: db(actN ? act / actN : 0), bad };
}

/** steady-state RMS of one voice in its hold window (makeup check) */
export function holdRms(v: Voice, sr = 48000): number {
  const one: Voice = { ...v, at: 0 };
  const buf = new Float32Array(Math.ceil((one.env.a + one.env.h + one.env.d + 0.01) * sr));
  renderVoice(one, buf, sr, graphNoise(sr));
  const s = Math.floor((one.env.a + one.env.h * 0.3) * sr), e = Math.floor((one.env.a + one.env.h * 0.95) * sr);
  let acc = 0;
  for (let i = s; i < e; i++) acc += buf[i] * buf[i];
  return Math.sqrt(acc / Math.max(1, e - s));
}
