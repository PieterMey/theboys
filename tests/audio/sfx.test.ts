// env-audio (v1.2): sfx.ts on the fake Web Audio graph over a real fixture layout.
// - occlusion gain + reverb send ONLY when requested (opts.occlude === true, or audio.json occludeMonsters);
// - monster / item / UI sound levels unchanged from v1.1 (gain = volume, the v1.1 lowpass, no reverb send);
// - synth voices through the same chain clean up after themselves.
//   node --test tests/audio/sfx.test.ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeBiquad, FakeBufferSource, FakeContext, FakeGain, FakePanner, installFakeAudio } from './fakeaudio.ts';
import type { FakeNode } from './fakeaudio.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { buildEdgeGrid } from '../../packages/shared/src/nav/index.ts';
import { ASSET_MANIFEST_URL } from '../../packages/shared/src/assets.ts';
import type { ClientContext } from '../../apps/client/src/core/context.ts';
import { getGraph } from '../../apps/client/src/audio/graph.ts';
import type { AudioGraph, V3 } from '../../apps/client/src/audio/graph.ts';
import { SfxEngine } from '../../apps/client/src/audio/sfx.ts';
import type { SfxPlayOpts } from '../../apps/client/src/audio/sfx.ts';
import { readAudioCfg } from '../../apps/client/src/audio/config.ts';
import type { AudioCfg } from '../../apps/client/src/audio/config.ts';
import { occlusionParams, wallCrossings } from '../../apps/client/src/audio/occlusion.ts';
import { reverbSend, roomInfo, spaceAt } from '../../apps/client/src/audio/acoustics.ts';
import { planSynth, playPlan } from '../../apps/client/src/audio/synth.ts';

installFakeAudio();
const ROOT = join(import.meta.dirname, '../..');
const L = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/layouts/facility_s1_p2.json'), 'utf8')) as LevelLayout;
const BASE_CFG = readAudioCfg(JSON.parse(readFileSync(join(ROOT, 'config/balance/audio.json'), 'utf8')));
const V11_LOWPASS = [20000, 2400, 1200, 700, 450];

// a listener in one room and sources 0 and >= 2 walls away (doors of unknown state, like the client fallback grid)
const grid = buildEdgeGrid(L);
const centre = (id: number): V3 => { const r = L.spaces[id].rect; return [r.x + r.w / 2, 1.6, r.y + r.h / 2]; };
const rooms = L.spaces.filter((s) => s.kind === 'room' && s.rect.w >= 3 && s.rect.h >= 3);
let pair: { ear: V3; far: V3; walls: number } | null = null;
for (const a of rooms) for (const b of rooms) {
  if (a.id === b.id || pair) continue;
  const ea = centre(a.id), fb = centre(b.id);
  const w = wallCrossings(grid, ea[0], ea[2], fb[0], fb[2], null);
  if (w >= 2 && Math.hypot(ea[0] - fb[0], ea[2] - fb[2]) < 14) pair = { ear: ea, far: fb, walls: w };
}
assert.ok(pair, 'fixture has two rooms >= 2 walls apart');
const EAR = pair!.ear, FAR = pair!.far;
const NEAR: V3 = [EAR[0] + 0.8, 1.2, EAR[2] + 0.6];

function rig(cfgOver: Partial<AudioCfg> = {}) {
  const ac = new FakeContext();
  const g = getGraph(ac as unknown as AudioContext) as AudioGraph;
  const services = new Map<string, unknown>([['three', { camera: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, EAR[0], EAR[1], EAR[2], 1] } } }]]);
  const ctx = {
    params: new URLSearchParams(),
    services: { use: (n: string) => services.get(n), provide: (n: string, v: unknown) => services.set(n, v) },
    world: { layout: L, me: null, players: new Map(), samplePlayer: () => null, phase: 'contract' },
  } as unknown as ClientContext;
  const cfg: AudioCfg = { ...BASE_CFG, ...cfgOver };
  const engine = new SfxEngine(ctx, () => g, () => cfg);
  return { ac, g, engine, cfg };
}

const manifest = { v: 1, base: '/assets/', files: { 'sfx.creature_breath': { url: 'sfx/breath.ogg' }, 'sfx.hound_growl_low': { url: 'sfx/growl.ogg' }, 'sfx.door_creak': { url: 'sfx/creak.ogg' } } };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) => (String(url) === ASSET_MANIFEST_URL
  ? { ok: true, json: async () => manifest }
  : { ok: true, arrayBuffer: async () => new ArrayBuffer(16) })) as unknown as typeof fetch;
process.on('exit', () => { globalThis.fetch = realFetch; });

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/** play a buffer sound and return its chain: source -> ... -> out -> bus */
async function playChain(r: ReturnType<typeof rig>, key: string, pos: V3 | null, opts: SfxPlayOpts) {
  await r.engine.loadManifest();
  const before = new Set(r.ac.nodes);
  const h = r.engine.play(key, pos, opts);
  assert.ok(h, 'handle');
  await flush();
  const src = [...r.ac.nodes].find((n) => !before.has(n) && n instanceof FakeBufferSource) as FakeBufferSource;
  assert.ok(src, 'buffer source created');
  const fresh = [...r.ac.nodes].filter((n) => !before.has(n));
  return { h, src, fresh };
}
const outs = (n: FakeNode) => [...n.outputs] as FakeNode[];

test('monster sound levels unchanged: gain = volume, the v1.1 lowpass, no occlusion gain, no reverb send', async () => {
  for (const pos of [NEAR, FAR]) {
    const r = rig();
    const { src, fresh } = await playChain(r, 'sfx.creature_breath', pos, { volume: 0.7, radius: 20 });
    const [lp] = outs(src);
    assert.ok(lp instanceof FakeBiquad && lp.type === 'lowpass');
    assert.equal(lp.outputs.size, 1, 'no reverb send');
    const [panner] = outs(lp);
    assert.ok(panner instanceof FakePanner, 'lowpass -> panner directly (no occlusion gain)');
    assert.equal(panner.refDistance, 1.5);
    assert.equal(panner.rolloffFactor, 1.2);
    assert.equal(panner.maxDistance, 20);
    const [out] = outs(panner);
    assert.ok(out instanceof FakeGain);
    assert.equal(out.gain.value, 0.7, 'gain = volume');
    assert.ok(out.outputs.has(r.g.sfxBus as unknown as FakeNode));
    const walls = wallCrossings(grid, EAR[0], EAR[2], pos[0], pos[2], null);
    const want = occlusionParams(walls, V11_LOWPASS, -6).freq;
    assert.ok(Math.abs(lp.frequency.valueAt(r.ac.currentTime + 2) - want) < 1, `lowpass ${lp.frequency.valueAt(r.ac.currentTime + 2)} vs v1.1 ${want}`);
    assert.equal((r.g.reverb as unknown as FakeNode).ins.size, 0, 'nothing sends to the reverb');
    assert.equal(fresh.filter((n) => n instanceof FakeGain).length, 1, 'one gain node (out) in the chain');
  }
});

test('occlusion only when requested: occlude:true adds the wall gain + a per-sound reverb send', async () => {
  const r = rig();
  const { src } = await playChain(r, 'sfx.door_creak', FAR, { volume: 0.8, occlude: true });
  const lp = outs(src)[0] as FakeBiquad;
  assert.ok(lp instanceof FakeBiquad);
  assert.equal(lp.outputs.size, 2, 'lowpass -> occlusion gain + reverb send');
  const occ = outs(lp).find((n) => n instanceof FakeGain && outs(n).some((o) => o instanceof FakePanner)) as FakeGain;
  const send = outs(lp).find((n) => n instanceof FakeGain && n.outputs.has(r.g.reverb as unknown as FakeNode)) as FakeGain;
  assert.ok(occ && send);
  const walls = wallCrossings(grid, EAR[0], EAR[2], FAR[0], FAR[2], null, r.cfg.closedDoorWallFrac);
  const wantGain = Math.pow(10, (-6 * walls) / 20);
  assert.ok(Math.abs(occ.gain.value - wantGain) < 1e-6, `occlusion gain ${occ.gain.value} vs ${wantGain} (${walls} walls)`);
  assert.ok(occ.gain.value < 0.5, 'two walls cost >= 12 dB');
  const room = roomInfo(L, spaceAt(L, FAR[0], FAR[2]))!;
  const d = Math.hypot(EAR[0] - FAR[0], EAR[1] - FAR[1], EAR[2] - FAR[2]);
  assert.ok(Math.abs(send.gain.value - 0.8 * reverbSend(room, d, wantGain, r.cfg.reverb)) < 1e-6);
  assert.ok(send.gain.value > 0);
  // the attack is already behind the wall: values are set before the source starts, not ramped
  assert.ok(Math.abs(lp.frequency.valueAt(r.ac.currentTime) - occlusionParams(walls, r.cfg.occlusionLowpassHz, -6).freq) < 1);
  // and the same sound in the listener's room: no wall loss, still a (room) send
  const r2 = rig();
  const near = await playChain(r2, 'sfx.door_creak', NEAR, { occlude: true });
  const occ2 = outs(outs(near.src)[0]).find((n) => outs(n).some((o) => o instanceof FakePanner)) as FakeGain;
  assert.equal(occ2.gain.value, 1);
});

test('occlude:true on a 2D / UI sound does nothing; occlude:false always wins; occludeMonsters signs everything off', async () => {
  const r = rig();
  const ui = await playChain(r, 'sfx.door_creak', FAR, { ui: true, occlude: true });
  assert.ok(outs(ui.src)[0] instanceof FakeGain, 'UI: source -> out (2D)');
  const r2 = rig({ occludeMonsters: true });
  const m = await playChain(r2, 'sfx.hound_growl_low', FAR, {});
  assert.equal(outs(m.src)[0].outputs.size, 2, 'occludeMonsters: monsters get the occlusion path');
  const m2 = await playChain(r2, 'sfx.hound_growl_low', FAR, { occlude: false });
  assert.equal(outs(m2.src)[0].outputs.size, 1, 'occlude:false keeps the v1.1 chain');
});

test('occluded loops follow the listener: the wall gain is re-evaluated by update()', async () => {
  const r = rig();
  const { src } = await playChain(r, 'sfx.door_creak', FAR, { occlude: true, loop: true });
  const occ = outs(outs(src)[0]).find((n) => outs(n).some((o) => o instanceof FakePanner)) as FakeGain;
  const behind = occ.gain.value;
  // the listener walks into the source's room
  const cam = (r.engine as unknown as { ctx: ClientContext }).ctx.services.use('three' as never) as unknown as { camera: { matrixWorld: { elements: number[] } } };
  cam.camera.matrixWorld.elements[12] = FAR[0] + 0.5;
  cam.camera.matrixWorld.elements[14] = FAR[2] + 0.5;
  r.engine.update();
  assert.ok(occ.gain.valueAt(r.ac.currentTime + 1) > behind * 2, 'louder once in the same room');
});

test('synth voices through the engine: occluded by default chain, cleaned up when they end; stop() works', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig();
    const base = r.ac.connectedCount();
    const plan = planSynth('knock', { seed: 7, pattern: 'metal', count: 3 })!;
    const h = r.engine.playVoice((ac, input, when, noise) => playPlan(ac, plan, input, noise, when, 1), FAR, { occlude: true, volume: 0.9, radius: plan.radius });
    assert.ok(h);
    assert.ok(r.engine.nodes() > 10 && r.engine.liveCount() === 1);
    assert.ok((r.g.reverb as unknown as FakeNode).ins.size === 1, 'the knock sends to the reverb');
    r.ac.advance(plan.dur + 0.2);
    assert.equal(r.engine.liveCount(), 0, 'ended -> cleaned');
    assert.equal(r.engine.nodes(), 0);
    assert.equal(r.ac.connectedCount(), base, 'node count back to the baseline');
    // stop(): fades, then stops every source
    const long = planSynth('frost', { seed: 2, ms: 6000 })!;
    const h2 = r.engine.playVoice((ac, input, when, noise) => playPlan(ac, long, input, noise, when, 1), NEAR, { occlude: true })!;
    r.ac.advance(0.5);
    h2.stop();
    mock.timers.tick(200);
    r.ac.advance(0.1);
    assert.equal(r.engine.liveCount(), 0);
    assert.equal(r.ac.connectedCount(), base);
    // a build that throws leaves nothing behind
    assert.throws(() => r.engine.playVoice(() => { throw new Error('boom'); }, NEAR, {}));
    assert.equal(r.ac.connectedCount(), base);
    assert.equal(r.engine.playVoice(() => null, NEAR, {}), null);
    assert.equal(r.ac.connectedCount(), base);
  } finally {
    mock.timers.reset();
  }
});

test('the reverb return: hall + small room IRs, v1.1 hall by default, blend clamped', () => {
  const r = rig();
  const g = r.g;
  assert.deepEqual(g.reverbState!(), { mix: 1, wet: 1 });
  const rev = g.reverb as unknown as FakeNode;
  assert.equal(rev.outputs.size, 2, 'reverb input feeds two convolvers');
  g.setReverbMix!(0);
  g.setReverbMix!(Number.NaN);
  assert.equal(g.reverbState!().mix, 0);
  g.setReverbMix!(7);
  assert.equal(g.reverbState!().mix, 1);
  g.setReverbWet!(1.35);
  assert.equal(g.reverbState!().wet, 1.35);
  for (const p of r.ac.allParams()) for (const v of p.history) assert.ok(Number.isFinite(v));
});
