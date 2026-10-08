// v1.2 shared medium + fixture curves (env-render): the closed forms the fog shader uses match a brute-force march,
// the noise volume is deterministic, fixture curves never strobe, die / surge_die end dark, brown / pulse recover.
//   node --test tests/render/medium.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuDensity, cpuRampAvg, cpuSphereChord } from '../../apps/client/src/render/fog.ts';
import { generateNoise3D, sampleNoise } from '../../apps/client/src/render/noise3d.ts';
import { brownEnvelope, curveValue } from '../../apps/client/src/render/fixtures.ts';
import type { FixtureCurveName } from '../../apps/client/src/render/fixtures.ts';

const march = (f: (s: number) => number, len: number, n = 4000) => { let a = 0; for (let i = 0; i < n; i++) a += f((i + 0.5) / n * len); return (a * len) / n; };

test('ground-mist ramp: closed-form average equals a brute-force march', () => {
  const top = 1.1, soft = 0.6;
  const ramp = (y: number) => Math.max(0, Math.min(1, (top - y) / soft));
  for (const [y0, y1] of [[1.6, 0], [1.6, 2.9], [0.2, 0.9], [1.6, 1.6], [0.3, 0.3], [2.5, 0.05], [0.9, 1.3]]) {
    const len = 7;
    const brute = march((s) => ramp(y0 + (y1 - y0) * (s / len)), len) / len;
    assert.ok(Math.abs(cpuRampAvg(y0, y1, top, soft) - brute) < 2e-3, `${y0}->${y1}: ${cpuRampAvg(y0, y1, top, soft)} vs ${brute}`);
  }
});

test('local fog volume: closed-form chord integral equals a brute-force march (clipped segments too)', () => {
  const c: [number, number, number] = [3, 0.8, -2];
  const r = 2.2;
  const prof = (p: number[]) => Math.max(0, 1 - ((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2) / (r * r));
  const cases: { A: [number, number, number]; d: [number, number, number]; len: number }[] = [
    { A: [0, 1.6, 0], d: [0.83, -0.18, -0.53], len: 12 },
    { A: [0, 1.6, 0], d: [0.83, -0.18, -0.53], len: 3.1 },
    { A: [3, 0.8, -2], d: [0, 0, 1], len: 5 },
    { A: [-5, 1.6, 4], d: [0, 0, 1], len: 10 },
  ];
  for (const k of cases) {
    const n = Math.hypot(...k.d);
    const d = k.d.map((v) => v / n) as [number, number, number];
    const brute = march((s) => prof([k.A[0] + d[0] * s, k.A[1] + d[1] * s, k.A[2] + d[2] * s]), k.len);
    assert.ok(Math.abs(cpuSphereChord(k.A, d, k.len, c, r) - brute) < 2e-3, `${cpuSphereChord(k.A, d, k.len, c, r)} vs ${brute}`);
  }
});

test('point density: haze decays with height, ground mist below the top, volumes add', () => {
  const cfg = { haze: 0.05, hazeHeight: 6, mist: 0.07, mistTop: 1.15, mistSoft: 0.6 };
  assert.ok(cpuDensity(cfg, 0, 0.2, 0, []) > cpuDensity(cfg, 0, 1.6, 0, []));
  assert.ok(cpuDensity(cfg, 0, 2.8, 0, []) < cpuDensity(cfg, 0, 1.6, 0, []));
  const vol = [{ p: [0, 0.6, 0] as [number, number, number], r: 2, density: 0.3, ground: true }];
  assert.ok(cpuDensity(cfg, 0, 0.6, 0, vol) > cpuDensity(cfg, 0, 0.6, 0, []) + 0.2);
  assert.ok(cpuDensity(cfg, 0, 0.6, 0, vol, { mist: 3, haze: 1 }) > cpuDensity(cfg, 0, 0.6, 0, vol));
});

test('noise volume: deterministic, tileable, full range', () => {
  const a = generateNoise3D(32, 7, [4, 8]);
  const b = generateNoise3D(32, 7, [4, 8]);
  assert.deepEqual(Array.from(a.slice(0, 2000)), Array.from(b.slice(0, 2000)));
  assert.notDeepEqual(Array.from(generateNoise3D(32, 8, [4, 8]).slice(0, 200)), Array.from(a.slice(0, 200)), 'seeded');
  let mn = 255, mx = 0;
  for (const v of a) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  assert.ok(mn < 40 && mx > 215);
  // tileable: sampling at u and u + 1 gives the same value
  assert.ok(Math.abs(sampleNoise(a, 0.3, 0.6, 0.1, 32) - sampleNoise(a, 1.3, 0.6, 1.1, 32)) < 1e-9);
});

test('fixture curves: smooth (no strobe), die/surge_die end dark, brown/pulse/revive end lit', () => {
  const curves: FixtureCurveName[] = ['die', 'surge_die', 'brown', 'pulse', 'revive'];
  for (const c of curves) {
    let prev = curveValue(c, 0, 0.3);
    let maxStep = 0;
    // 60 Hz frames over a 500 ms curve
    for (let i = 1; i <= 36; i++) { const v = curveValue(c, i / 30, 0.3); maxStep = Math.max(maxStep, Math.abs(v - prev)); prev = v; }
    assert.ok(maxStep < 0.45, `${c}: largest frame-to-frame step ${maxStep.toFixed(2)}`);
  }
  assert.equal(curveValue('die', 1.01, 0.3), 0);
  assert.equal(curveValue('surge_die', 1.5, 0.3), 0);
  assert.ok(curveValue('surge_die', 0.25, 0.3) > 1.2, 'surges first');
  assert.equal(curveValue('brown', 1.2, 0.3), 1);
  assert.ok(curveValue('brown', 0.45, 0.3) < 0.5, 'sags');
  assert.equal(curveValue('pulse', 1.2, 0.3), 1);
  assert.equal(curveValue('revive', 1.0, 0.3), 1);
  assert.ok(curveValue('revive', 0.05, 0.3) < 0.1, 'starts dark');
  assert.equal(brownEnvelope(0), 0);
  assert.equal(brownEnvelope(1), 0);
  assert.ok(brownEnvelope(0.5) > 0.95);
});
