// env-audio (v1.2, plan check #13): fear(source, v, ms?) takes the maximum over sources.
//   node --test tests/audio/fear.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FearMix, smoothFear } from '../../apps/client/src/audio/fear.ts';

test('the heartbeat follows the maximum over live sources', () => {
  const f = new FearMix();
  assert.equal(f.value(0), 0);
  f.set('spotted', 0.9, undefined, 0);
  f.set('paranormal', 0.4, undefined, 0);
  assert.equal(f.value(10), 0.9);
  f.set('spotted', 0.2, undefined, 20);
  assert.equal(f.value(30), 0.4, 'lowering one source never hides a higher one');
  f.set('default', 0.6, undefined, 30);
  assert.equal(f.value(40), 0.6);
  assert.deepEqual(f.sources(40), { spotted: 0.2, paranormal: 0.4, default: 0.6 });
});

test('v 0 clears a source; ms clears it after ms; setFear(v) = fear("default", v)', () => {
  const f = new FearMix();
  f.set('spotted', 1, 4000, 1000);
  f.set('paranormal', 0.5, undefined, 1000);
  assert.equal(f.value(4999), 1);
  assert.equal(f.value(5000), 0.5, 'spotted expired at 1000 + 4000');
  f.set('paranormal', 0, undefined, 6000);
  assert.equal(f.value(6000), 0);
  assert.deepEqual(f.sources(6000), {});
  // re-arming a source with a new ms extends it
  f.set('spotted', 0.7, 1000, 7000);
  f.set('spotted', 0.7, 3000, 7500);
  assert.equal(f.value(9000), 0.7);
  assert.equal(f.value(10500), 0);
  // the default source (setFear)
  f.set('', 0.3, undefined, 0);
  assert.deepEqual(f.sources(0), { default: 0.3 });
});

test('bad values are clamped or clear the source', () => {
  const f = new FearMix();
  f.set('a', 5, undefined, 0);
  assert.equal(f.value(0), 1);
  f.set('a', Number.NaN, undefined, 0);
  assert.equal(f.value(0), 0);
  f.set('b', -1, undefined, 0);
  assert.equal(f.value(0), 0);
  f.set('c', 0.5, Number.NaN, 0);
  assert.equal(f.value(1e12), 0.5, 'a non-finite ms means "until cleared"');
  f.clear();
  assert.equal(f.value(0), 0);
});

test('smoothFear: quick to rise, slow to calm, finite', () => {
  let v = 0;
  for (let i = 0; i < 25; i++) v = smoothFear(v, 1, 0.04, 0.3, 2.2); // 1 s
  assert.ok(v > 0.9, `rises within a second (${v.toFixed(2)})`);
  for (let i = 0; i < 25; i++) v = smoothFear(v, 0, 0.04, 0.3, 2.2);
  assert.ok(v > 0.5, `calms slowly (${v.toFixed(2)} after 1 s)`);
  for (let i = 0; i < 500; i++) v = smoothFear(v, 0, 0.04, 0.3, 2.2);
  assert.equal(v, 0);
  assert.equal(smoothFear(Number.NaN, 0.5, 0.04, 0.3, 2), smoothFear(0, 0.5, 0.04, 0.3, 2));
  assert.equal(smoothFear(0.4, 0.5, Number.NaN, 0.3, 2), 0.4);
});
