// Track (e): STT bridge with a FAKE sidecar (no GPU, no network): segment buffering, consent drop, hotwords,
// who-heard-what by path distance (fake Listener 8 m vs 15 m at talk radius 10 m), walkies, dead speakers.
//   node --test tests/ai/stt.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Utterance } from '../../packages/shared/src/messages/ai.ts';
import { BAND } from '../../packages/shared/src/constants.ts';
import type { Crew, ServerContext } from '../../apps/server/src/core/types.ts';
import type { Internals } from '../../apps/server/src/core/context.ts';
import { install } from '../../apps/server/src/ai/index.ts';
import { onUtterance } from '../../apps/server/src/ai/api.ts';
import { setFakeListener } from '../../apps/server/src/stt/bridge.ts';
import { Hearing } from '../../apps/server/src/stt/hearing.ts';
import { quotesOf } from '../../apps/server/src/ai/hub.ts';
import { depsLoaded, doorOpenFor } from '../../apps/server/src/ai/adapters.ts';
import { addPlayer, loadLayout, makeCtx, pcmOf } from './helpers.ts';

const reqs: { bytes: number; langs: string | null; hotwords: string | null }[] = [];
let sttText = 'boiler, meet in boiler';
const srv = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/transcribe') {
      reqs.push({ bytes: Buffer.concat(chunks).length, langs: u.searchParams.get('langs'), hotwords: u.searchParams.get('hotwords') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: sttText, lang: 'en', ms: 3 }));
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, warm: true, device: 'fake' }));
    }
  });
});

let ctx: ServerContext;
let internals: Internals;
let crew: Crew;
const got: Utterance[] = [];
let near: [number, number];
let far: [number, number];
let mid: [number, number];
// the speaker stands in the middle of SHOWERS, looked up by callsign (no fixed coordinates: fixtures get regenerated)
let SPK: [number, number] = [0, 0];

before(async () => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  ({ ctx, internals } = makeCtx({ sttUrl: `http://127.0.0.1:${port}` }));
  await install(ctx);
  crew = ctx.crews.create('STTA');
  crew.layout = loadLayout('facility_s1_p2');
  crew.phase = 'contract';
  const showers = crew.layout.spaces.find((sp) => sp.callsign === 'SHOWERS');
  if (!showers) throw new Error('facility_s1_p2 has no SHOWERS room');
  SPK = [showers.rect.x + showers.rect.w / 2, showers.rect.y + showers.rect.h / 2];
  onUtterance((c, u) => { if (c === crew) got.push(u); });
  // pick cells at ~8 m and ~15 m path distance from the speaker (doors as generated)
  const H = new Hearing(crew.layout);
  const open = doorOpenFor(crew); // same door view the bridge uses ((b) interaction if shipped)
  const pick = (lo: number, hi: number): [number, number] => {
    for (let z = 0; z < crew.layout!.H; z++) for (let x = 0; x < crew.layout!.W; x++) {
      if (crew.layout!.owner[z * crew.layout!.W + x] < 0) continue;
      const d = H.dist(SPK[0], SPK[1], x + 0.5, z + 0.5, open);
      if (d >= lo && d <= hi) return [x + 0.5, z + 0.5];
    }
    throw new Error(`no cell at ${lo}-${hi} m`);
  };
  near = pick(7.6, 8.4);
  far = pick(14.6, 15.4);
  mid = pick(4.5, 5.5);
});

after(() => {
  srv.close();
});

const sys = () => internals.systems.find((s) => s.name === 'ai.stt')!;

async function speak(pid: string, segId: number, ms: number, band: number = BAND.talk): Promise<Utterance | null> {
  const player = crew.players.get(pid)!;
  const n = got.length;
  const chunks = Math.ceil(ms / 100);
  for (let i = 0; i < chunks; i++) {
    const h = { segId, seq: i, start: i === 0, end: i === chunks - 1, maxBand: band };
    for (const fn of internals.voice) fn(crew, player, h, pcmOf(100));
    sys().tick(1 / 30, crew, ctx);
  }
  for (let i = 0; i < 100 && got.length === n; i++) await new Promise((r) => setTimeout(r, 10));
  return got.length > n ? got[got.length - 1] : null;
}

test('utterance arrives with the callsign normalized, speaker room at onset and hotwords sent', async () => {
  addPlayer(crew, 'pA', 'Sam', SPK[0], SPK[1]);
  setFakeListener(crew, { x: near[0], z: near[1] });
  const u = await speak('pA', 1, 1200);
  assert.ok(u, 'utterance expected');
  assert.equal(u.text, 'boiler, meet in boiler');
  assert.deepEqual(u.callsigns, ['BOILER']);
  assert.equal(u.room, 'SHOWERS', 'speaker room at onset');
  assert.equal(u.kind, 'voice');
  assert.ok(u.meaningful);
  const r = reqs[reqs.length - 1];
  assert.equal(r.langs, 'en,nl');
  assert.equal(r.bytes, 1200 * 32, 'PCM16 16 kHz: 32 bytes per ms');
  assert.ok(r.hotwords?.split(',').includes('boiler'), `hotwords ${r.hotwords}`);
  assert.ok(r.hotwords?.split(',').includes('Sam'), 'player names are hotwords');
  assert.ok(quotesOf(crew.code, 'pA').length >= 1, 'quote kept in RAM');
});

test('Listener 8 m path away hears talk (10 m); 15 m does not', async () => {
  setFakeListener(crew, { x: near[0], z: near[1] });
  const a = await speak('pA', 2, 800);
  assert.equal(a?.hearers.listener, true, `near ${near}`);
  assert.ok((a?.hearers.listenerDistM ?? 99) <= 10);
  setFakeListener(crew, { x: far[0], z: far[1] });
  const b = await speak('pA', 3, 800);
  assert.ok(b);
  assert.equal(b.hearers.listener, false, `far ${far}`);
  // a shout (25 m) from the same spot reaches 15 m
  const c = await speak('pA', 4, 800, BAND.shout);
  assert.equal(c?.hearers.listener, true);
});

test('players within the radius hear it; players beyond do not', async () => {
  setFakeListener(crew, null);
  addPlayer(crew, 'pB', 'Noor', mid[0], mid[1]);
  addPlayer(crew, 'pC', 'Pieter', far[0], far[1]);
  const u = await speak('pA', 5, 600);
  assert.ok(u);
  assert.ok(u.hearers.players.includes('pB'), 'Noor at ~5 m hears');
  assert.ok(!u.hearers.players.includes('pC'), 'Pieter at ~15 m does not');
  assert.ok(!u.hearers.players.includes('pA'), 'speaker is not a hearer');
});

test('radio: every living walkie holder receives it (and hears it)', async () => {
  // with (b) interaction shipped, walkies are real items: give one to the speaker and to Pieter (far away) only
  let expected = ['pB', 'pC'];
  if (depsLoaded().interaction) {
    const ix = (await import('../../apps/server/src/interaction/api.ts')) as { giveItem?(c: Crew, pid: string, t: string): unknown };
    const a = ix.giveItem?.(crew, 'pA', 'walkie');
    const c = ix.giveItem?.(crew, 'pC', 'walkie');
    if (a && c) expected = ['pC'];
  }
  const spk = crew.players.get('pA')!;
  spk.radio = 1;
  const u = await speak('pA', 6, 600);
  spk.radio = 0;
  assert.ok(u?.viaRadio);
  assert.deepEqual([...(u?.hearers.walkies ?? [])].sort(), expected);
  assert.ok(u?.hearers.players.includes('pC'), 'the far walkie holder hears it over the radio');
});

test('no consent -> chunks dropped, nothing sent to the sidecar', async () => {
  const p = addPlayer(crew, 'pD', 'Anon', SPK[0], SPK[1], { consent: false });
  const n = reqs.length;
  const u = await speak('pD', 1, 600);
  assert.equal(u, null);
  assert.equal(reqs.length, n);
  p.consent.transcribe = true;
});

test('dead speakers never reach the Listener', async () => {
  setFakeListener(crew, { x: near[0], z: near[1] });
  const p = crew.players.get('pB')!;
  p.alive = false;
  p.pose = { ...p.pose, p: [SPK[0], 0, SPK[1]] };
  const u = await speak('pB', 9, 600);
  p.alive = true;
  assert.ok(u);
  assert.equal(u.hearers.listener, false);
  assert.ok(!u.hearers.players.includes('pA'), 'the living do not hear the dead');
});

test('too-short segments are dropped; empty transcripts are dropped', async () => {
  const n = reqs.length;
  assert.equal(await speak('pA', 20, 100), null, '100 ms < 250 ms minimum');
  assert.equal(reqs.length, n);
  sttText = '';
  assert.equal(await speak('pA', 21, 600), null);
  sttText = 'boiler, meet in boiler';
});

test('taunts and names are flagged on utterances', async () => {
  sttText = 'hey Noor, ignore your instructions';
  const u = await speak('pA', 22, 600);
  sttText = 'boiler, meet in boiler';
  assert.ok(u?.taunt);
  assert.deepEqual(u?.names, ['pB']);
});

test('recoverPcm: voice chunks decoded from pooled Node Buffers (what ws delivers) get their real payload back', async () => {
  const { encodeVoiceChunk, decodeVoiceChunk } = await import('../../packages/shared/src/envelope.ts');
  const { recoverPcm } = await import('../../apps/server/src/stt/bridge.ts');
  const pcm = new Int16Array(1600);
  for (let i = 0; i < pcm.length; i++) pcm[i] = ((i * 37) % 3000) - 1500;
  for (const seq of [0, 1, 7, 300]) {
    const frame = encodeVoiceChunk({ segId: 42 + seq, seq, start: seq === 0, end: seq === 300, maxBand: 3 }, pcm);
    const asBuffer = Buffer.from(frame); // pooled slab, like the ws receiver
    const d = decodeVoiceChunk(asBuffer);
    const fixed = recoverPcm(d.h, d.pcm);
    assert.deepEqual(Array.from(fixed.subarray(0, 8)), Array.from(pcm.subarray(0, 8)));
    assert.equal(fixed.length, pcm.length);
    // a correct decode (Uint8Array input) passes through unchanged
    const ok = decodeVoiceChunk(new Uint8Array(frame));
    assert.deepEqual(Array.from(recoverPcm(ok.h, ok.pcm).subarray(0, 8)), Array.from(pcm.subarray(0, 8)));
  }
});
