// v1.1 host performance + telemetry units: internal-resolution policy, frame statistics, auto quality decisions,
// telemetry sanitising. node --test tests/render/perf.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameTimes, PERF_DEFAULTS, createAutoQuality, pixelRatioFor } from '../../apps/client/src/render/perf.ts';
import type { AutoState } from '../../apps/client/src/render/perf.ts';
import type { Preset } from '../../apps/client/src/render/presets.ts';
import { cleanText, formatReport } from '../../apps/server/src/net/telemetry.ts';

const P = (name: string, res = 1): Preset => ({ name, shadowed: 6, unshadowed: 0, shadowMap: 2048, volumetric: true, volScale: 0.5, volSteps: 16, gtao: true, aoScale: 1, res, fixtures: 32, traa: true });
const ON = { clamp: true, cap: true };

test('4K at 150 % scaling (2560x1440 CSS, DPR 1.5): DPR clamped to 1 -> 2560x1440 internal on Ultra', () => {
  const r = pixelRatioFor(2560, 1440, 1.5, P('ultra'), PERF_DEFAULTS, 1, ON);
  assert.equal(r.w, 2560);
  assert.equal(r.h, 1440);
});

test('4K at 100 % (3840x2160 CSS, DPR 1): Ultra capped to 2560x1440 internal', () => {
  const r = pixelRatioFor(3840, 2160, 1, P('ultra'), PERF_DEFAULTS, 1, ON);
  assert.equal(r.w, 2560);
  assert.equal(r.h, 1440);
});

test('3840x2160 CSS at DPR 1.5 (the 5760x3240 case) is capped too; the old behaviour without clamp/cap', () => {
  assert.equal(pixelRatioFor(3840, 2160, 1.5, P('ultra'), PERF_DEFAULTS, 1, ON).w, 2560);
  assert.equal(pixelRatioFor(3840, 2160, 1.5, P('ultra'), PERF_DEFAULTS, 1, { clamp: false, cap: false }).w, 5760);
});

test('1080p laptop at DPR 1.25 keeps its DPR on High (below the clamp width and the cap)', () => {
  const r = pixelRatioFor(1536, 864, 1.25, P('high'), PERF_DEFAULTS, 1, ON);
  assert.equal(r.w, 1920);
  assert.equal(r.h, 1080);
});

test('auto scale and the preset res multiply in; never below ~640 px wide', () => {
  assert.equal(pixelRatioFor(1920, 1080, 1, P('low', 0.75), PERF_DEFAULTS, 0.6, ON).w, 864);
  assert.ok(pixelRatioFor(800, 600, 1, P('low', 0.75), PERF_DEFAULTS, 0.1, ON).w >= 640);
});

test('FrameTimes: p50 / p95 / long frames over a time span', () => {
  const ft = new FrameTimes();
  let t = 0;
  for (let i = 0; i < 100; i++) { t += 10; ft.push(10, t); }
  t += 150; ft.push(150, t);
  const s = ft.stats(5000, t);
  assert.equal(s.n, 101);
  assert.equal(s.p50, 10);
  assert.equal(s.long, 1);
  assert.equal(s.max, 150);
  assert.equal(ft.stats(100, t).n, 1);
});

function harness(preset: string, presetFree: boolean, frameMs: number, gpu: number) {
  const ft = new FrameTimes();
  const state: AutoState = { enabled: true, presetFree, scale: 1, last: '', steps: 0 };
  const calls: string[] = [];
  let cur = preset;
  const ctl = createAutoQuality(PERF_DEFAULTS, ft, {
    preset: () => cur, presets: ['low', 'medium', 'high', 'ultra'],
    setPreset: (n) => { cur = n; calls.push(`preset ${n}`); }, setScale: (s) => calls.push(`scale ${s}`),
    gpuMs: () => gpu, steady: () => true,
  }, state);
  let t = 0;
  const run = (ms: number, f = frameMs) => { const end = t + ms; while (t < end) { t += f; ft.push(f, t); ctl.tick(t); } };
  return { run, state, calls, preset: () => cur };
}

test('auto quality: a slow machine (30 ms frames) steps the resolution scale down first', () => {
  const h = harness('high', true, 30, 25);
  h.run(3000 + 5000 + 5000 + 200);
  assert.equal(h.calls[0], 'scale 0.85');
  assert.ok(h.state.scale < 1);
  assert.equal(h.preset(), 'high');
});

test('auto quality: Ultra at 60 fps (not display-capped) drops to High; Ultra at 144 fps stays', () => {
  const slow = harness('ultra', true, 16.7, 14);
  slow.run(3000 + 5000 + 5000 + 100);
  assert.equal(slow.preset(), 'high');
  const fast = harness('ultra', true, 6.9, 4);
  fast.run(3000 + 5000 * 4);
  assert.equal(fast.preset(), 'ultra');
  assert.equal(fast.calls.length, 0);
});

test('auto quality: Ultra on a 60 Hz display with GPU headroom is kept (display-capped)', () => {
  const h = harness('ultra', true, 16.67, 4);
  h.run(3000 + 5000 * 3);
  assert.equal(h.preset(), 'ultra');
});

test('auto quality: a URL-forced preset only changes the scale', () => {
  const h = harness('ultra', false, 45, 40);
  h.run(3000 + 5000 * 8);
  assert.equal(h.preset(), 'ultra');
  assert.ok(h.state.scale <= 0.72);
});

test('auto quality: one-off long frames do not step down, sustained ones do', () => {
  const h = harness('high', true, 8, 3);
  h.run(3000 + 5000);
  // one window with 2 long frames, then a clean one: no step
  h.run(2000); h.run(120, 120); h.run(120, 120); h.run(3000);
  h.run(5100);
  assert.equal(h.calls.filter((c) => c.startsWith('scale 0')).length, 0);
});

test('telemetry: tokens and admin links are redacted; the log line is compact', () => {
  const s = cleanText('boom at http://x/#admin=641de1ab10ad637c58e7bd20 key=abc resume=zz 0123456789abcdef0123456789abcdef', 300);
  assert.ok(!s.includes('641de1ab10ad637c58e7bd20'));
  assert.ok(!s.includes('0123456789abcdef0123456789abcdef'));
  assert.match(s, /admin=<redacted>/);
  const line = formatReport('Ann', { fps: 58.2, p50: 16.7, p95: 21, long: 0, gpuMs: 6.1, preset: 'ultra', res: [2560, 1440], dpr: 1.5, scale: 1, backend: 'webgpu', rtt: 3, hidden: false, heapMB: 412, screen: 'none', phase: 'contract' });
  assert.match(line, /^Ann: 58fps p50 16\.7 p95 21\.0ms long 0 gpu 6\.1ms \| ultra 2560x1440 dpr 1\.50/);
  assert.ok(line.length < 200);
});

// ---- v1.2 auto quality feature ladder (env-render): live mirror, then mist steps, before resolution / preset; back
// into Ultra once frames recover.
function harness12(preset: string, frameMs: () => number, gpu: () => number) {
  const ft = new FrameTimes();
  const state: AutoState = { enabled: true, presetFree: true, scale: 1, last: '', steps: 0 };
  const calls: string[] = [];
  let cur = preset;
  let level = 0;
  const ctl = createAutoQuality(PERF_DEFAULTS, ft, {
    preset: () => cur, presets: ['low', 'medium', 'high', 'ultra'],
    setPreset: (n) => { cur = n; calls.push(`preset ${n}`); }, setScale: (s) => calls.push(`scale ${s}`),
    gpuMs: gpu, steady: () => true,
    features: { level: () => level, max: () => 2, set: (n) => { level = n; calls.push(`features ${n}`); } },
  }, state);
  let t = 0;
  const run = (ms: number) => { const end = t + ms; while (t < end) { const f = frameMs(); t += f; ft.push(f, t); ctl.tick(t); } };
  return { run, state, calls, preset: () => cur, level: () => level };
}

test('auto quality v1.2: features drop first (live mirror, then mist steps), then resolution / preset', () => {
  const h = harness12('high', () => 30, () => 25);
  h.run(3000 + 5000 * 4 + 200);
  assert.deepEqual(h.calls.slice(0, 2), ['features 1', 'features 2']);
  assert.ok(h.calls.slice(2).some((c) => c.startsWith('scale')), `then the resolution: ${h.calls.join(', ')}`);
  assert.equal(h.preset(), 'high');
});

test('auto quality v1.2: Ultra below 90 fps drops a feature before leaving Ultra; recovers back into Ultra', () => {
  let slow = true;
  const h = harness12('ultra', () => (slow ? 16.7 : 6.9), () => (slow ? 14 : 4));
  h.run(3000 + 5000 + 200);
  assert.equal(h.calls[0], 'features 1', 'the live mirror goes first');
  assert.equal(h.preset(), 'ultra');
  h.run(5000 * 2);
  assert.ok(h.preset() !== 'ultra' || h.level() === 2, `${h.calls.join(', ')}`);
  // frames recover: climbs back (resolution, preset into Ultra after 3 fast windows, then the features)
  slow = false;
  h.run(65_000 + 5000 * 14);
  assert.equal(h.preset(), 'ultra', `${h.calls.join(', ')}`);
  assert.equal(h.level(), 0, 'every feature back');
  assert.equal(h.state.scale, 1);
});
