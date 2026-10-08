// env-audio (v1.2): audio/index.ts wiring with the real client bus + services, fake providers (three camera, level
// fixtures, interaction lights, render.fixtureLevels) and the fake Web Audio graph. Drives the 'audio' system frame
// by frame like the client loop.
//   node --test tests/audio/install.test.ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeContext, installFakeAudio } from './fakeaudio.ts';
import { createBus } from '../../apps/client/src/core/bus.ts';
import { createServices } from '../../apps/client/src/core/services.ts';
import type { ClientContext } from '../../apps/client/src/core/context.ts';
import type { ClientSystem } from '../../apps/client/src/core/loop.ts';
import type { SfxService } from '../../apps/client/src/core/services.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { install } from '../../apps/client/src/audio/index.ts';
import { SYNTH_KINDS } from '../../apps/client/src/audio/synth.ts';
import { irBlend, roomInfo } from '../../apps/client/src/audio/acoustics.ts';
import { readAudioCfg } from '../../apps/client/src/audio/config.ts';
import type { V3 } from '../../apps/client/src/audio/graph.ts';

installFakeAudio();
const G = globalThis as unknown as { window: unknown; __audioDebug: Dbg };
G.window = globalThis;
globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;

const ROOT = join(import.meta.dirname, '../..');
const AUDIO_JSON = JSON.parse(readFileSync(join(ROOT, 'config/balance/audio.json'), 'utf8'));
const L0 = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/layouts/facility_s1_p2.json'), 'utf8')) as LevelLayout;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface HumRow { i: number; space: number; kind: string; voice: string; target: number; gain: number }
interface Dbg {
  hums(): HumRow[];
  nodes(): { sfx: number; live: number; hums: number; beds: number; total: number };
  levelSource(): string;
  fearState(): { value: number; target: number; sources: Record<string, number> };
  reverb(): { mix: number; wet: number; room: { space: number } | null };
  beds(): { active: string[]; layers: string[]; nodes: number } | null;
  synthAll(pos?: V3 | null): { kind: string; ok: boolean; err?: string }[];
  kinds(): string[];
  fixtures(): { i: number; space: number; voice: string | null; level: number }[];
}

// the lit room with the most tube fixtures
const tubes = L0.items.filter((i) => i.kind === 'light' && String(i.data?.kind ?? 'tube') === 'tube' && String(i.data?.state ?? 'on') === 'on');
const bySpace = new Map<number, number>();
for (const t of tubes) bySpace.set(t.space, (bySpace.get(t.space) ?? 0) + 1);
const S = [...bySpace.entries()].filter(([s]) => L0.spaces[s].kind !== 'outside').sort((a, b) => b[1] - a[1])[0][0];
const first = tubes.find((t) => t.space === S)!;
const EAR: V3 = [first.x + 0.3, 1.6, first.z + 0.3];

function boot(L: LevelLayout = L0, o: { levels?: Float32Array } = {}) {
  const ac = new FakeContext();
  const errors: string[] = [];
  const bus = createBus((m) => errors.push(m));
  const services = createServices();
  const systems: ClientSystem[] = [];
  const lights: Record<number, boolean> = Object.fromEntries(L.spaces.map((s) => [s.id, true]));
  const fixtures = L.items.filter((i) => i.kind === 'light').map((i) => ({
    space: i.space, pos: [i.x, i.y ?? L.wallH - 0.04, i.z] as V3, state: String(i.data?.state ?? 'on'), id: i.id, kind: String(i.data?.kind ?? 'tube'),
  }));
  const put = (n: string, v: unknown) => (services.provide as (n: string, v: unknown) => void)(n, v);
  put('three', { camera: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, EAR[0], EAR[1], EAR[2], 1] } } });
  put('level', { fixtures });
  put('interaction', { state: () => ({ lights }) });
  if (o.levels) { const lv = o.levels; put('render', { fixtureLevels: () => lv }); }
  const ctx = {
    flags: { siteThemes: true }, balance: { core: {}, audio: AUDIO_JSON }, testMode: true, params: new URLSearchParams(), build: 'test',
    world: { phase: 'contract', layout: L, me: null, players: new Map(), samplePlayer: () => null, full: null },
    bus, services, ui: null, audio: { ctx: ac, unlock: () => ac },
    registerSystem: (s: ClientSystem) => { systems.push(s); }, reportError: (m: string) => errors.push(m), errors: () => errors, diag: {},
  } as unknown as ClientContext;
  install(ctx);
  bus.emit('audio:unlocked', { ctx: ac as unknown as AudioContext });
  const sys = systems.find((s) => s.name === 'audio')!;
  const step = (sec: number, fps = 60) => { for (let i = 0; i < Math.round(sec * fps); i++) { ac.advance(1 / fps); sys.update(1 / fps, ctx); } };
  const sfx = services.use('sfx') as SfxService;
  return { ac, ctx, step, dbg: G.__audioDebug, lights, fixtures, sfx, errors };
}

test('hums follow the room light (fallback: interaction lights): switch off -> exactly silent within 0.3 s, on -> back', () => {
  const b = boot();
  b.step(1.2);
  assert.equal(b.dbg.levelSource(), 'fallback');
  const lit = b.dbg.hums().filter((h) => h.space === S && h.voice === 'tube');
  assert.ok(lit.length >= 1 && lit.every((h) => h.target > 0.5 && h.gain > 0.3), JSON.stringify(lit));
  b.lights[S] = false;
  b.step(0.3);
  const dark = b.dbg.hums().filter((h) => h.space === S);
  assert.ok(dark.length >= 1 && dark.every((h) => h.target === 0 && h.gain === 0), `switched-off room silent: ${JSON.stringify(dark)}`);
  b.lights[S] = true;
  b.step(1.2);
  assert.ok(b.dbg.hums().filter((h) => h.space === S).every((h) => h.gain > 0.3));
  // a blackout (every space unpowered) silences every hum
  for (const k of Object.keys(b.lights)) b.lights[Number(k)] = false;
  b.step(0.3);
  assert.ok(b.dbg.hums().every((h) => h.gain === 0));
  assert.deepEqual(b.errors, []);
});

test('render.fixtureLevels drives the hums when it lines up with level.fixtures (brownout sag, dark walk)', () => {
  const n = L0.items.filter((i) => i.kind === 'light').length;
  const levels = new Float32Array(n).fill(1);
  const b = boot(L0, { levels });
  b.step(1.2);
  assert.equal(b.dbg.levelSource(), 'render.fixtureLevels');
  const mine = b.fixtures.map((f, i) => ({ f, i })).filter((x) => x.f.space === S).map((x) => x.i);
  const full = b.dbg.hums().find((h) => h.i === mine[0])!.target;
  for (const i of mine) levels[i] = 0.35;
  b.step(0.5);
  const sag = b.dbg.hums().find((h) => h.i === mine[0])!.target;
  assert.ok(sag > 0 && sag < full * 0.5, `brownout sags the hum (${full} -> ${sag})`);
  // the dark walk takes one fixture: only that hum dies
  levels[mine[0]] = 0;
  b.step(0.3);
  assert.equal(b.dbg.hums().find((h) => h.i === mine[0])!.gain, 0);
  if (mine.length > 1) assert.ok(b.dbg.hums().find((h) => h.i === mine[1])!.gain > 0);
  // the interaction light state is ignored while render levels are live (render already folds it in)
  b.lights[S] = false;
  levels.fill(1);
  b.step(1);
  assert.ok(b.dbg.hums().find((h) => h.i === mine[0])!.gain > 0.3);
});

test('watchdog: with the frame loop stalled (GPU compile, hidden tab) a room that loses power still goes silent', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const D = globalThis as unknown as { document?: unknown };
  D.document = {}; // the watchdog only runs in a browser
  try {
    const n = L0.items.filter((i) => i.kind === 'light').length;
    const levels = new Float32Array(n).fill(1); // render's levels, frozen at "on" while it draws nothing
    const b = boot(L0, { levels });
    b.step(1.2);
    assert.ok(b.dbg.hums().filter((h) => h.space === S).every((h) => h.gain > 0.3));
    // the loop stalls: no more frames; > 150 ms of real time pass
    const t = performance.now();
    while (performance.now() - t < 200) { /* stall */ }
    b.lights[S] = false;
    for (let i = 0; i < 7; i++) { b.ac.advance(0.05); mock.timers.tick(50); }
    const dark = b.dbg.hums().filter((h) => h.space === S);
    assert.ok(dark.length >= 1 && dark.every((h) => h.target === 0), `watchdog darkened the room: ${JSON.stringify(dark)}`);
    b.ac.advance(0.05);
    assert.ok(b.dbg.hums().filter((h) => h.space === S).every((h) => h.gain === 0), 'exactly silent within 0.3 s');
    // other rooms keep render's (frozen) level: the live light state only ever darkens
    assert.ok(b.dbg.hums().some((h) => h.space !== S && h.gain > 0.3) || b.dbg.hums().every((h) => h.space === S));
    assert.deepEqual(b.errors, []);
  } finally {
    delete D.document;
    mock.timers.reset();
  }
});

test('flicker(space, ms) stutters the fallback hums of that space (wall-clock, like render.flickerSpace)', async () => {
  const b = boot();
  b.step(1);
  b.sfx.flicker(S, 900);
  const seen: number[] = [];
  for (let i = 0; i < 30; i++) {
    await sleep(20); // the stutter pattern runs on performance.now(): let real time pass
    b.step(1 / 60);
    seen.push(...b.dbg.hums().filter((h) => h.space === S).map((h) => h.target));
  }
  assert.ok(Math.min(...seen) < 0.2 && Math.max(...seen) > 0.8, `stutter ${Math.min(...seen)}..${Math.max(...seen)}`);
  await sleep(400);
  b.step(1);
  assert.ok(b.dbg.hums().filter((h) => h.space === S).every((h) => h.target > 0.8), 'steady again after the flicker');
});

test('services.sfx.synth: every kind plays (positional + 2D) and the node count returns to baseline', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const b = boot();
    b.step(0.5);
    const base = b.dbg.nodes().sfx;
    for (const k of SYNTH_KINDS) {
      assert.ok(b.sfx.synth?.(k, [EAR[0] + 3, 1.2, EAR[2]], { seed: 11 }), `${k} positional`);
      assert.ok(b.sfx.synth?.(k, undefined, { seed: 12, ui: true }), `${k} 2D`);
    }
    assert.ok(b.dbg.nodes().sfx > base + 100 && b.dbg.nodes().live === SYNTH_KINDS.length * 2);
    const rows = b.dbg.synthAll([EAR[0], 1.2, EAR[2]]);
    assert.ok(rows.every((r) => r.ok), JSON.stringify(rows.filter((r) => !r.ok)));
    b.step(17, 20);
    assert.equal(b.dbg.nodes().live, 0);
    assert.equal(b.dbg.nodes().sfx, base, 'every synth node released');
    assert.equal(b.sfx.synth?.('breath' as never, EAR), null, 'no breath synth');
    assert.deepEqual(b.errors, []);
  } finally {
    mock.timers.reset();
  }
});

test('fear(source, v, ms): the heartbeat follows the max over sources; setFear = default; phase change clears', async () => {
  const b = boot();
  b.sfx.fear?.('spotted', 1, 250);
  b.sfx.setFear(0.3);
  b.step(1);
  assert.ok(b.dbg.fearState().value > 0.9);
  assert.deepEqual(b.dbg.fearState().sources, { spotted: 1, default: 0.3 });
  await sleep(300);
  b.step(0.1);
  assert.equal(b.dbg.fearState().target, 0.3, 'spotted expired: back to the default source');
  b.step(6);
  assert.ok(b.dbg.fearState().value < 0.36 && b.dbg.fearState().value > 0.29, `calms toward 0.3: ${b.dbg.fearState().value}`);
  b.ctx.bus.emit('world:phase', { from: 'contract', to: 'results' });
  assert.deepEqual(b.dbg.fearState().sources, {});
});

test('the reverb follows the listener room; themed contracts start their bed', () => {
  const b = boot({ ...L0, theme: 'waterworks' });
  b.step(3);
  const cfg = readAudioCfg(AUDIO_JSON);
  const rv = b.dbg.reverb();
  assert.equal(rv.room?.space, S);
  assert.ok(Math.abs(rv.mix - irBlend(roomInfo({ ...L0, theme: 'waterworks' }, S), cfg.reverb)) < 1e-9);
  const beds = b.dbg.beds()!;
  assert.deepEqual(beds.active, ['waterworks']);
  assert.ok(beds.layers.includes('waterworks:water') && beds.nodes > 0);
  // the facility (v1.1) has no theme bed
  const f = boot();
  f.step(2);
  assert.deepEqual(f.dbg.beds()!.active, []);
});
