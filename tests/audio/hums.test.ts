// env-audio (v1.2): power-aware fixture hums (hums.ts) on the fake Web Audio graph.
//   node --test tests/audio/hums.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeContext, FakeGain, installFakeAudio } from './fakeaudio.ts';
import type { FakeParam } from './fakeaudio.ts';
import { Hums, fallbackLevel, flickerLevel, humGain, humVoiceOf, strobeLevel } from '../../apps/client/src/audio/hums.ts';
import type { HumEvent, HumFixture } from '../../apps/client/src/audio/hums.ts';
import { AUDIO_DEFAULTS } from '../../apps/client/src/audio/config.ts';
import type { HumCfg } from '../../apps/client/src/audio/config.ts';
import { FIXTURE_KINDS } from '../../packages/shared/src/procgen/themes.ts';
import type { V3 } from '../../apps/client/src/audio/graph.ts';

installFakeAudio();

const FX: HumFixture[] = [
  { space: 0, pos: [2, 2.9, 2], state: 'on', kind: 'tube' },
  { space: 0, pos: [4, 2.9, 2], state: 'on', kind: 'tube' },
  { space: 0, pos: [3, 2.9, 4], state: 'on', kind: 'bulb' },
  { space: 1, pos: [9, 5, 3], state: 'on', kind: 'highbay' },
  { space: 1, pos: [8, 1.2, 5], state: 'on', kind: 'candle' },
  { space: 2, pos: [5, 2.9, 8], state: 'on', kind: 'emergency', battery: true },
  { space: 3, pos: [60, 6, 60], state: 'on', kind: 'lamp' },
];
const HERE: V3 = [3, 1.6, 3];

function rig(cfg: HumCfg = AUDIO_DEFAULTS.hum) {
  const ac = new FakeContext();
  const ambBus = new FakeGain(ac);
  ambBus.connect(ac.destination);
  const hums = new Hums({ ac: ac as unknown as AudioContext, ambBus: ambBus as unknown as GainNode }, cfg);
  return { ac, hums, base: ac.connectedCount() };
}

type LevelFn = (i: number, t: number) => number;
function run(r: ReturnType<typeof rig>, seconds: number, fps: number, level: LevelFn, listener: V3 | null = HERE, fx: HumFixture[] = FX, occOf?: (f: HumFixture) => number): HumEvent[] {
  const out: HumEvent[] = [];
  const steps = Math.round(seconds * fps);
  for (let k = 0; k < steps; k++) {
    r.ac.advance(1 / fps);
    const t = r.ac.currentTime;
    out.push(...r.hums.update(listener, fx, (i) => level(i, t), t, occOf));
  }
  return out;
}
const gainOf = (r: ReturnType<typeof rig>, i: number) => r.hums.gainParam(i) as unknown as FakeParam | null;

test('hum gain reaches exactly 0 within 0.3 s of a space losing power (60, 30 and 15 fps)', () => {
  for (const fps of [60, 30, 15]) {
    const r = rig();
    const OFF = 1.0;
    const lvl: LevelFn = (i, t) => (FX[i].space === 0 && t >= OFF ? 0 : 1);
    run(r, OFF - 0.001, fps, lvl);
    const g0 = gainOf(r, 0)!, g3 = gainOf(r, 3)!;
    assert.ok(g0 && g0.valueAt(r.ac.currentTime) > 0.5, `${fps} fps: the tube hums while lit (${g0?.valueAt(r.ac.currentTime)})`);
    run(r, 0.35, fps, lvl);
    assert.equal(g0.valueAt(OFF + 0.3), 0, `${fps} fps: tube 0 silent 0.3 s after the power loss`);
    assert.equal(gainOf(r, 1)!.valueAt(OFF + 0.3), 0, `${fps} fps: tube 1 silent`);
    assert.ok(g0.valueAt(OFF + 0.15 + 1 / fps) < 0.02, `${fps} fps: already near silent after 0.15 s`);
    assert.ok(g3.valueAt(OFF + 0.3) > 0.5, `${fps} fps: the highbay of the powered space keeps humming`);
  }
});

test('power back: the hum comes back up', () => {
  const r = rig();
  const lvl: LevelFn = (i, t) => (FX[i].space === 0 && t >= 1 && t < 2 ? 0 : 1);
  run(r, 2.5, 60, lvl);
  assert.ok(gainOf(r, 0)!.valueAt(r.ac.currentTime) > 0.8);
});

test('fixture kinds: tube hum, highbay buzz (louder), silent bulbs and candles, an emergency tick, nothing out of range', () => {
  const r = rig();
  const ev = run(r, 6, 30, () => 1);
  const info = r.hums.info();
  const kinds = info.map((h) => h.kind);
  assert.ok(!kinds.includes('bulb') && !kinds.includes('candle'), 'bulbs and candles are silent');
  assert.ok(!info.some((h) => h.i === 6), 'a lamp 80 m away has no voice');
  const tube = info.find((h) => h.i === 0)!, hb = info.find((h) => h.i === 3)!;
  assert.equal(tube.voice, 'tube');
  assert.equal(hb.voice, 'highbay');
  assert.ok(hb.target > tube.target, 'the high bay buzzes louder');
  const ticks = ev.filter((e) => e.kind === 'tick');
  assert.ok(ticks.length >= 2 && ticks.length <= 4, `emergency light ticks every ~2 s (${ticks.length} in 6 s)`);
  assert.ok(ticks.every((e) => e.space === 2));
  // unlit emergency light: no ticks
  const r2 = rig();
  assert.equal(run(r2, 6, 30, (i) => (i === 5 ? 0 : 1)).filter((e) => e.kind === 'tick').length, 0);
});

test('switch events: a room going dark together = one off event (count 2); strobes never switch', () => {
  const r = rig();
  run(r, 1, 60, () => 1);
  const off = run(r, 0.5, 60, (i, t) => (FX[i].space === 0 ? 0 : (Math.floor(t * 60) % 2 ? 1.1 : 0.02)));
  const offs = off.filter((e) => e.kind === 'off');
  assert.equal(offs.length, 1, JSON.stringify(off));
  assert.equal(offs[0].space, 0);
  assert.equal(offs[0].count, 2);
  assert.ok(!off.some((e) => e.space === 1 && e.kind !== 'tick'), 'the strobing highbay never switches');
  const on = run(r, 0.5, 60, () => 1).filter((e) => e.kind === 'on');
  assert.equal(on.length, 1);
  assert.equal(on[0].count, 2);
});

test('occlusion gain scales the hum (walls between fixture and listener)', () => {
  const a = rig(), b = rig();
  run(a, 1, 30, () => 1);
  run(b, 1, 30, () => 1, HERE, FX, (f) => (f.space === 1 ? 0.25 : 1));
  const ta = a.hums.info().find((h) => h.i === 3)!.target, tb = b.hums.info().find((h) => h.i === 3)!.target;
  assert.ok(Math.abs(tb - ta * 0.25) < 1e-9, `${ta} -> ${tb}`);
  const off = rig({ ...AUDIO_DEFAULTS.hum, occlude: false });
  run(off, 1, 30, () => 1, HERE, FX, () => 0.25);
  assert.equal(off.hums.info().find((h) => h.i === 3)!.target, ta);
});

test('nodes are cleaned up: walking away and a level rebuild release every hum', () => {
  const r = rig();
  run(r, 1, 30, () => 1);
  assert.ok(r.hums.nodes() > 0 && r.ac.connectedCount() > r.base);
  run(r, 2, 30, () => 1, [500, 1.6, 500]);
  assert.equal(r.hums.info().filter((h) => h.voice !== 'tick').length, 0);
  assert.equal(r.hums.nodes(), 0);
  assert.equal(r.ac.connectedCount(), r.base, 'every hum node disconnected');
  // a new fixture list (level rebuild) drops the old voices
  run(r, 1, 30, () => 1);
  assert.ok(r.hums.nodes() > 0);
  run(r, 2, 30, () => 1, HERE, FX.map((f) => ({ ...f, pos: [f.pos[0] + 200, f.pos[1], f.pos[2]] as V3 })));
  assert.equal(r.hums.nodes(), 0);
  // no listener / no fixtures: silence, no throw
  assert.deepEqual(r.hums.update(null, FX, () => 1, r.ac.currentTime), []);
  assert.deepEqual(r.hums.update(HERE, null, () => 1, r.ac.currentTime), []);
  r.hums.dispose();
  assert.equal(r.ac.connectedCount(), r.base - 1, 'dispose also unplugs the hum bus');
});

test('bad levels never reach an AudioParam', () => {
  const r = rig();
  run(r, 1, 30, (i) => [Number.NaN, Infinity, -5, 1e9][i % 4]);
  for (const p of r.ac.allParams()) for (const v of p.history) assert.ok(Number.isFinite(v), `${p.name} ${v}`);
});

test('pure mappings: voices per FIXTURE_KINDS, gain curve, fallback levels', () => {
  const want: Record<string, string | null> = {
    tube: 'tube', highbay: 'highbay', lamp: 'buzz', wall: 'buzz', flood: 'buzz', emergency: 'tick',
    bulb: null, sconce: null, candle: null, led_strip: null, headlight: null, van: null,
  };
  for (const k of FIXTURE_KINDS) assert.equal(humVoiceOf(k), want[k], k);
  assert.equal(humVoiceOf(undefined), 'tube');
  assert.equal(humVoiceOf('mystery'), 'tube', 'render draws unknown kinds as tubes');
  assert.equal(humGain(0, 1), 0);
  assert.equal(humGain(0.02, 1), 0);
  assert.equal(humGain(Number.NaN, 1), 0);
  assert.ok(humGain(0.5, 1) < humGain(1, 1) && humGain(1, 1) === 1 && humGain(1, 1.6) === 1.6);
  assert.ok(humGain(5, 1) <= Math.pow(1.2, 1.3) + 1e-9);
  const f: HumFixture = { space: 0, pos: [0, 0, 0], state: 'on' };
  assert.equal(fallbackLevel(f, 0, 1, true, false), 1);
  assert.equal(fallbackLevel(f, 0, 1, false, false), 0, 'unpowered (switch / blackout)');
  assert.equal(fallbackLevel({ ...f, state: 'off' }, 0, 1, true, false), 0);
  assert.equal(fallbackLevel({ ...f, state: 'broken' }, 0, 1, true, false), 0);
  for (let t = 0; t < 20; t += 0.013) {
    const fl = flickerLevel(3, t), st = strobeLevel(3, t);
    assert.ok(fl >= 0 && fl <= 1 && st >= 0 && st <= 1.15);
  }
  let lo = 0;
  for (let t = 0; t < 20; t += 0.01) if (fallbackLevel({ ...f, state: 'flicker' }, 1, t, true, false) < 0.1) lo++;
  assert.ok(lo > 50, 'a flickering tube drops out audibly');
});
