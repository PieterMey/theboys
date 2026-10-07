// Owner: track ④ Voice (audio). The menu's radio-static crackle must be sparse and irregular (it used to tick
// ~1.7 times per second on a fixed rhythm), and dense only at full static.
//   node --test tests/voice/crackle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crackleMeanGap, crackleRng, crackleStep } from '../../apps/client/src/audio/crackle.ts';

function simulate(level: number, seconds: number, seed = 1) {
  const rnd = crackleRng(seed);
  const gaps: number[] = [];
  for (let t = 0; t < seconds;) {
    const s = crackleStep(level, rnd);
    assert.ok(s.dur >= 0.008 && s.dur <= 0.038, `pop length ${s.dur}`);
    assert.ok(s.amp >= 0.35 && s.amp <= 1, `pop amp ${s.amp}`);
    assert.ok(s.wait > s.dur, 'pops never overlap');
    gaps.push(s.wait);
    t += s.wait;
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  return { rate: gaps.length / seconds, mean, sd, min: Math.min(...gaps) };
}

test('menu bed (0.35): about one pop every few seconds, never two within 0.75 s', () => {
  const r = simulate(0.35, 600);
  assert.ok(r.rate > 0.2 && r.rate < 0.6, `rate ${r.rate.toFixed(2)}/s`);
  assert.ok(r.min >= 0.75, `min gap ${r.min.toFixed(2)} s`);
});

test('irregular: gaps vary a lot (not a fixed rhythm)', () => {
  for (const level of [0.35, 0.6, 1]) {
    const r = simulate(level, 600, 7);
    assert.ok(r.sd / r.mean > 0.3, `level ${level}: coefficient of variation ${(r.sd / r.mean).toFixed(2)}`);
  }
});

test('density rises with the static level; full static crackles several times a second', () => {
  assert.ok(crackleMeanGap(0.35) > crackleMeanGap(0.6) && crackleMeanGap(0.6) > crackleMeanGap(1));
  const full = simulate(1, 300, 3);
  assert.ok(full.rate > 2 && full.rate < 6, `full static ${full.rate.toFixed(2)}/s`);
  assert.ok(full.min >= 0.12, `full static min gap ${full.min.toFixed(3)} s`);
});

test('deterministic per seed', () => {
  const a = crackleRng(42), b = crackleRng(42);
  for (let i = 0; i < 20; i++) assert.deepEqual(crackleStep(0.5, a), crackleStep(0.5, b));
});
