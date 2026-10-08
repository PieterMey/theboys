// env-audio (v1.2): synth.ts plans + playPlan on a fake Web Audio graph + offline-rendered levels.
//   node --test tests/audio/synth.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeContext, FakeGain, asAudio, installFakeAudio } from './fakeaudio.ts';
import { renderPlan, holdRms } from './render.ts';
import { BED_KINDS, SYNTH_KINDS, SYNTH_LIMITS, isPlanKind, planSynth, playPlan, voiceEnd } from '../../apps/client/src/audio/synth.ts';
import type { PlanKind, SynthPlan, Voice } from '../../apps/client/src/audio/synth.ts';
import { MAX_MAKEUP } from '../../apps/client/src/audio/dsp.ts';
import type { SynthOpts } from '../../apps/client/src/audio/api.ts';

installFakeAudio();
const ROOT = join(import.meta.dirname, '../..');
const ALL: PlanKind[] = [...SYNTH_KINDS, ...BED_KINDS];
const SEEDS = Array.from({ length: 30 }, (_, i) => (i * 7919 + 13) >>> 0);
const VARIANTS: SynthOpts[] = [{}, { ms: 1 }, { ms: 1e9 }, { count: 0 }, { count: 99 }, { count: -3 }, { rate: 2 }, { rate: 0.5 }, { rate: 99 },
  { pattern: 'metal' }, { pattern: 'locker' }, { pattern: 'metal', count: 8 }, { ms: Number.NaN, count: Number.NaN, rate: Number.NaN, seed: Number.NaN }];

const sourceKinds = (api: string): string[] => {
  const m = api.replace(/\/\/[^\n]*/g, '').match(/export type SynthKind =([\s\S]*?);/);
  assert.ok(m, 'SynthKind union in api.ts');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
};

test('every contract SynthKind is built; bed kinds stay internal', () => {
  const kinds = sourceKinds(readFileSync(join(ROOT, 'apps/client/src/audio/api.ts'), 'utf8'));
  assert.deepEqual([...kinds].sort(), [...SYNTH_KINDS].sort());
  for (const k of kinds) assert.ok(planSynth(k as PlanKind, { seed: 1 })?.voices.length, k);
  for (const k of BED_KINDS) assert.ok(!kinds.includes(k), `${k} is internal`);
  assert.equal(planSynth('nope' as PlanKind), null);
  assert.equal(isPlanKind('breath'), false);
});

test('no breath or whisper synth (plan check #14), never a scrape loop', () => {
  for (const k of ALL) assert.ok(!/breath|whisper|mannequin/i.test(k), k);
  for (const seed of SEEDS) {
    const p = planSynth('chair_scrape', { seed })!;
    assert.ok(p.dur < 1.2, `chair scrape is one short movement (${p.dur.toFixed(2)} s)`);
  }
});

function walkNumbers(o: unknown, path: string, out: [string, number][]): void {
  if (typeof o === 'number') { out.push([path, o]); return; }
  if (Array.isArray(o)) { o.forEach((x, i) => walkNumbers(x, `${path}[${i}]`, out)); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walkNumbers(v, `${path}.${k}`, out);
}

function checkVoice(kind: string, v: Voice): void {
  const nums: [string, number][] = [];
  walkNumbers(v, kind, nums);
  for (const [p, x] of nums) assert.ok(Number.isFinite(x), `${p} = ${x}`);
  assert.ok(v.at >= 0 && voiceEnd(v) <= SYNTH_LIMITS.maxDur + 1e-9, `${kind} voice end ${voiceEnd(v)}`);
  assert.ok(v.env.a > 0 && v.env.h >= 0 && v.env.d > 0, `${kind} env times`);
  assert.ok(v.env.peak >= 0 && v.env.peak <= SYNTH_LIMITS.maxPeak, `${kind} env peak ${v.env.peak}`);
  if (v.src.t === 'osc') {
    for (const f of [v.src.f, v.src.f1 ?? v.src.f]) assert.ok(f >= SYNTH_LIMITS.minHz && f <= SYNTH_LIMITS.maxHz, `${kind} osc ${f} Hz`);
    if (v.src.vib) assert.ok(v.src.vib.depth < v.src.f, `${kind} vibrato never crosses 0 Hz`);
  }
  if (v.src.t === 'ticks') {
    assert.equal(v.src.times.length, v.src.amps.length);
    for (const a of v.src.amps) assert.ok(a >= 0 && a <= 1);
  }
  for (const f of v.filters) {
    assert.ok(f.f >= SYNTH_LIMITS.minHz && f.f <= SYNTH_LIMITS.maxHz && (f.f1 ?? f.f) >= SYNTH_LIMITS.minHz && (f.f1 ?? f.f) <= SYNTH_LIMITS.maxHz, `${kind} filter ${f.f}`);
    assert.ok(f.q >= 0.1 && f.q <= SYNTH_LIMITS.maxQ, `${kind} Q ${f.q}`);
  }
  if (v.am) assert.ok(v.am.depth >= 0 && v.am.depth <= 1 && v.am.rate > 0);
}

test('every envelope finite and bounded (all kinds x seeds x odd options)', () => {
  let n = 0;
  for (const kind of ALL) for (const seed of SEEDS) for (const o of VARIANTS) {
    const p = planSynth(kind, { seed, ...o });
    assert.ok(p, kind);
    assert.ok(p.voices.length > 0 && p.voices.length <= SYNTH_LIMITS.maxVoices, `${kind} voices ${p.voices.length}`);
    assert.ok(Number.isFinite(p.dur) && p.dur > 0 && p.dur <= SYNTH_LIMITS.maxDur, `${kind} dur ${p.dur}`);
    assert.ok(p.gain > 0 && p.gain <= 1 && p.radius > 0);
    for (const v of p.voices) checkVoice(kind, v);
    n++;
  }
  assert.ok(n > 1000);
});

test('seeded output repeatable: same seed -> same plan and samples; other seeds vary', () => {
  for (const kind of ALL) {
    const a = planSynth(kind, { seed: 42, pattern: 'locker' })!, b = planSynth(kind, { seed: 42, pattern: 'locker' })!;
    assert.deepEqual(a, b, kind);
    const ra = renderPlan(a), rb = renderPlan(b);
    assert.equal(ra.data.length, rb.data.length);
    let same = true;
    for (let i = 0; i < ra.data.length; i += 7) if (ra.data[i] !== rb.data[i]) { same = false; break; }
    assert.ok(same, `${kind}: same seed renders the same samples`);
    // kinds with random parameters differ between seeds (the phone bell and compressor clunks are fixed sounds)
    if (!['phone_bell', 'compressor_on', 'compressor_off'].includes(kind)) {
      const c = planSynth(kind, { seed: 43, pattern: 'locker' })!;
      assert.notDeepEqual(a.voices, c.voices, `${kind}: seed 43 differs from 42`);
    }
  }
});

test('offline render: every kind audible, never clipping, finite (worst seed and pattern)', () => {
  const rows: string[] = [];
  for (const kind of ALL) {
    let max = 0, min = Infinity;
    const opts: SynthOpts[] = kind === 'knock' ? [{}, { pattern: 'metal' }, { pattern: 'locker' }, { pattern: 'metal', count: 8 }] : [{}];
    for (const seed of [1, 2, 3, 4, 5, 6]) for (const o of opts) {
      const r = renderPlan(planSynth(kind, { seed, ...o })!);
      assert.equal(r.bad, 0, `${kind}: non-finite samples`);
      max = Math.max(max, r.peak);
      min = Math.min(min, r.peak);
    }
    rows.push(`${kind} ${min.toFixed(2)}-${max.toFixed(2)}`);
    assert.ok(max < 0.95, `${kind} clips: peak ${max.toFixed(3)}`);
    assert.ok(min > 0.12, `${kind} too quiet: peak ${min.toFixed(3)}`);
  }
  console.log(`peaks at volume 1: ${rows.join(', ')}`);
});

test('voiceMakeup: an env peak means "as loud as a sine of that amplitude" through any filters', () => {
  const E = (peak: number) => ({ a: 0.01, h: 0.6, d: 0.05, peak });
  const cases: Voice[] = [
    { at: 0, src: { t: 'osc', wave: 'sine', f: 440 }, filters: [], env: E(0.5) },
    { at: 0, src: { t: 'noise', rate: 1, offset: 0.3 }, filters: [{ type: 'lowpass', f: 1100, q: 0.7 }], env: E(0.5) },
    { at: 0, src: { t: 'noise', rate: 0.5, offset: 0.7 }, filters: [{ type: 'lowpass', f: 420, q: 0.7 }, { type: 'bandpass', f: 260, q: 1.2 }], env: E(0.5) },
    { at: 0, src: { t: 'osc', wave: 'sawtooth', f: 40 }, filters: [{ type: 'bandpass', f: 360, q: 4 }], env: E(0.5) },
    { at: 0, src: { t: 'osc', wave: 'square', f: 100 }, filters: [{ type: 'bandpass', f: 1500, q: 1.2 }], env: E(0.5) },
    { at: 0, src: { t: 'osc', wave: 'triangle', f: 1200 }, filters: [{ type: 'bandpass', f: 1200, q: 3 }], env: E(0.5) },
  ];
  for (const v of cases) {
    const ratio = holdRms(v) / (0.7071 * v.env.peak);
    assert.ok(ratio > 0.75 && ratio < 1.25, `${JSON.stringify(v.src)} ${JSON.stringify(v.filters)}: ratio ${ratio.toFixed(2)}`);
  }
});

function playOnFake(plan: SynthPlan): { ac: FakeContext; out: FakeGain; played: ReturnType<typeof playPlan>; base: number } {
  const ac = new FakeContext();
  const out = new FakeGain(ac);
  out.connect(ac.destination);
  const noise = ac.createBuffer(1, 96000, 48000);
  const base = ac.connectedCount();
  const played = playPlan(asAudio(ac), plan, out as unknown as AudioNode, noise as unknown as AudioBuffer, 0.01, 1);
  return { ac, out, played, base };
}

test('playPlan: every AudioParam value finite and bounded, envelopes end at exactly 0', () => {
  for (const kind of ALL) for (const seed of [1, 9, 77]) {
    const plan = planSynth(kind, { seed })!;
    const { ac, played } = playOnFake(plan);
    assert.ok(played.sources.length > 0 && played.last, kind);
    for (const p of ac.allParams()) for (const v of p.history) assert.ok(Number.isFinite(v), `${kind} ${p.name} ${v}`);
    for (const n of ac.nodes) {
      // audio-path gains (not the LFO depth gains that drive an AudioParam in Hz)
      const modulator = [...n.outputs].some((o) => !(o instanceof FakeGain) && !('outputs' in o));
      if (n instanceof FakeGain && !modulator) for (const v of n.gain.history) assert.ok(Math.abs(v) <= MAX_MAKEUP * SYNTH_LIMITS.maxPeak + 1e-9, `${kind} gain ${v}`);
      for (const p of n.params) if (p.name.endsWith('frequency')) for (const v of p.history) assert.ok(v > 0 && v <= 24000, `${kind} ${p.name} ${v}`);
    }
    // every envelope gain is back to 0 once the plan is over
    const t = played.end + 0.01;
    for (const n of played.nodes) {
      const g = (n as unknown as { gain?: { valueAt(t: number): number; name: string } }).gain;
      if (g && n !== (played.bus as unknown as typeof n) && (n as unknown as { outputs: Set<unknown> }).outputs.has(played.bus)) assert.equal(g.valueAt(t), 0, `${kind} env not closed`);
    }
  }
});

test('playPlan: all sources end and the node count returns to baseline after cleanup', () => {
  for (const kind of ALL) {
    const plan = planSynth(kind, { seed: 5, ms: 1500 })!;
    const { ac, played, base } = playOnFake(plan);
    let done = false;
    played.last!.onended = () => { for (const n of played.nodes) n.disconnect(); done = true; };
    assert.ok(ac.connectedCount() > base, `${kind} connected while playing`);
    ac.advance(plan.dur + 0.5);
    assert.ok(done, `${kind}: the last source ended`);
    assert.equal(ac.sources.size, 0, `${kind}: every source ended`);
    assert.equal(ac.connectedCount(), base, `${kind}: nodes disconnected`);
  }
});

test('rate scales pitch and time like a playbackRate', () => {
  const a = planSynth('relay_tink', { seed: 3 })!, b = planSynth('relay_tink', { seed: 3, rate: 2 })!;
  assert.ok(Math.abs(b.dur - 0.05 - (a.dur - 0.05) / 2) < 0.01);
  const fa = a.voices.find((v) => v.src.t === 'osc')!.src as { f: number };
  const fb = b.voices.find((v) => v.src.t === 'osc')!.src as { f: number };
  assert.ok(Math.abs(fb.f - Math.min(18000, fa.f * 2)) < 1e-6);
});

test('options: knock count + pattern, sustained ms, clock strikes', () => {
  const hits = (p: SynthPlan) => new Set(p.voices.map((v) => v.at.toFixed(4))).size;
  assert.equal(hits(planSynth('knock', { seed: 1, count: 3 })!), 3);
  assert.equal(hits(planSynth('knock', { seed: 1, count: 1, pattern: 'metal' })!), 1);
  const wood = planSynth('knock', { seed: 1, count: 2 })!, metal = planSynth('knock', { seed: 1, count: 2, pattern: 'metal' })!;
  assert.notDeepEqual(wood.voices.map((v) => v.src.t), metal.voices.map((v) => v.src.t));
  assert.ok(Math.abs(planSynth('frost', { seed: 1, ms: 6000 })!.dur - 6.05) < 0.1);
  assert.ok(planSynth('tv_static', { seed: 1, ms: 1000 })!.dur < 1.2);
  assert.equal(new Set(planSynth('clock_chime', { seed: 1, count: 5 })!.voices.map((v) => v.at.toFixed(3))).size, 5);
  const ring = planSynth('phone_bell', { ms: 8000 })!;
  assert.equal(new Set(ring.voices.map((v) => v.at)).size, 2, 'rings 2 s on / 4 s off: two rings in 8 s');
});
