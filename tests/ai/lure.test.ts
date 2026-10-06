// Track (e): THE LISTENER SPEAKS (apps/server/src/ai/lure.ts + tts.ts), no network:
// line validation (PG-13, <= 12 words, grounded callsigns), template lines (EN/NL/taunt), facts from what it heard,
// the mock pipeline end to end (Haiku mock -> synthetic WAV in the cache -> 'ai.lure' + RX LED), fallbacks
// (replay miss, deadline), budgets (cooldown, session cap, char budget from the usage log) and the ElevenLabs
// request shape against a stubbed fetch (fake key, no real call).
//   node --test tests/ai/lure.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway } from '../../apps/server/src/ai/gateway.ts';
import { setCtx } from '../../apps/server/src/ai/hub.ts';
import {
  blocked, factsFor, guessLanguage, lureBlocked, lureStatus, resetLure, resetLureCooldown, speakLure, templateLine, ttsText, validateLine,
} from '../../apps/server/src/ai/lure.ts';
import type { LureRequest } from '../../apps/server/src/ai/lure.ts';
import { clipMs, mockVoiceWav, resetTts, synthesize, ttsKey } from '../../apps/server/src/ai/tts.ts';
import type { Crew, ServerContext } from '../../apps/server/src/core/types.ts';
import { addPlayer, makeCtx, quietLog } from './helpers.ts';

const DIR = mkdtempSync(join(tmpdir(), 'ai-vogen-'));
const LOG = join(DIR, 'usage.jsonl');
process.env.VO_GEN_DIR = DIR;
after(() => { rmSync(DIR, { recursive: true, force: true }); delete process.env.VO_GEN_DIR; });

const ROOMS = ['BOILER', 'CHAPEL', 'COLDROOM', 'VAULT', 'PUMPS'];
const { ctx } = makeCtx();
const bal: Record<string, unknown> = {};
(ctx.balance as Record<string, unknown>).ai = bal;
type Ev = { e: string; d: Record<string, unknown> };
let events: Ev[] = [];
(ctx as { emit: ServerContext['emit'] }).emit = ((_crew: Crew, e: string, d: unknown) => { events.push({ e, d: d as Record<string, unknown> }); }) as ServerContext['emit'];
let n = 0;

function crew(): Crew {
  const c = ctx.crews.create(`LU${++n}`);
  c.phase = 'contract';
  addPlayer(c, 'p1', 'Sam', 0, 0);
  addPlayer(c, 'p2', 'Pieter', 4, 0);
  return c;
}

function req(c: Crew, extra: Partial<LureRequest> = {}): LureRequest {
  return {
    crew: c, victim: 'p1', viaWalkie: true, room: 'BOILER', knownRooms: ROOMS,
    heard: [
      { text: 'lol', speaker: 'Pieter', speakerId: 'p2', room: 'CHAPEL', agoSec: 30 },
      { text: 'Sam meet me in the boiler room, I have the core', speaker: 'Pieter', speakerId: 'p2', room: 'CHAPEL', agoSec: 6 },
    ],
    ...extra,
  };
}

function mode(m: 'mock' | 'replay' | 'live'): void {
  resetGateway();
  configureGateway({ mode: m, flags: ctx.flags as Record<string, boolean>, bal: () => bal, budgetUsd: () => 3, log: quietLog, usageLog: LOG, fixturesDir: join(DIR, 'fixtures') });
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  for (const k of Object.keys(bal)) delete bal[k];
  delete (ctx.flags as Record<string, unknown>).lureHaiku;
  events = [];
  resetLure();
  resetTts();
  setCtx(ctx);
  mode('mock');
});

test('validateLine: short grounded PG-13 lines pass; long, numeric, meta, profane or invented callsigns fail', () => {
  const f = { known: ROOMS };
  assert.equal(validateLine("Sam, it's me. Come to BOILER, I found the Core.", f), "Sam, it's me. Come to BOILER, I found the Core.");
  assert.equal(validateLine('(whispers) Sam... come to CHAPEL. *static*', f), 'Sam... come to CHAPEL.');
  assert.equal(validateLine("I'm entering the CHAPEL now, come alone.", f), "I'm entering the CHAPEL now, come alone.", 'no false positive on "entering"');
  assert.equal(validateLine('Sam come to BOILER now please hurry it is so dark here I am scared', f), null, '> 12 words');
  assert.equal(validateLine('The code is 4719, come to VAULT', f), null, 'digits');
  assert.equal(validateLine('I am an AI language model', f), null, 'meta talk');
  assert.equal(validateLine('This is just a game, Sam', f), null, 'fourth wall');
  assert.equal(validateLine('Come to the f*cking BOILER you idiot', f), null);
  assert.equal(validateLine('Kom naar de BOILER, kanker', f), null, 'Dutch curse');
  assert.equal(validateLine('Come to KITCHEN, quick', f), null, 'callsign not in this layout');
  assert.equal(validateLine('', f), null);
  assert.equal(validateLine(42, f), null);
  assert.equal(blocked('de lichten flikkeren'), false, 'the Dutch verb "flicker" is fine');
  assert.equal(blocked('what a crisis'), false);
});

test('ttsText: callsigns are Title case so TTS says the word', () => {
  assert.equal(ttsText('Sam, come to COLDROOM. VAULT is open.'), 'Sam, come to Coldroom. Vault is open.');
});

test('facts: rooms, names and plan words it heard; Dutch and taunts are detected', () => {
  const c = crew();
  const f = factsFor(req(c));
  assert.equal(f.target, 'Sam');
  assert.deepEqual(f.teammates, ['Pieter']);
  assert.equal(f.lureRoom, 'BOILER');
  assert.ok(f.roomsHeard.includes('BOILER') && f.roomsHeard.includes('CHAPEL'));
  assert.ok(f.planWords.includes('core') && f.planWords.includes('meet'));
  assert.equal(f.language, 'en');
  assert.equal(f.taunted, false);
  assert.equal(f.heard[f.heard.length - 1], 'Sam meet me in the boiler room, I have the core');
  const nl = factsFor(req(c, { heard: [{ text: 'we gaan naar de kapel, ik heb de kern', speaker: 'Pieter', room: 'PUMPS', agoSec: 3 }] }));
  assert.equal(nl.language, 'nl');
  assert.ok(nl.roomsHeard.includes('CHAPEL'), 'kapel -> CHAPEL');
  const t = factsFor(req(c, { heard: [{ text: 'come and get me stupid monster', speaker: 'Sam', speakerId: 'p1', agoSec: 1 }] }));
  assert.equal(t.taunted, true);
  assert.deepEqual(t.heard, [], 'taunt lines never reach the model');
  assert.equal(guessLanguage(['okay meet me there']), 'en');
});

test('template lines: name + room + object, Dutch when the crew speaks Dutch, menace for taunts; always valid', () => {
  const c = crew();
  const en = templateLine(factsFor(req(c)));
  assert.equal(en.lang, 'en');
  assert.ok(en.line.includes('BOILER') && en.line.includes('Sam'), en.line);
  const f = factsFor(req(c, { heard: [{ text: 'we gaan naar de kapel, ik heb de kern', speaker: 'Pieter', room: 'PUMPS', agoSec: 3 }], room: 'CHAPEL' }));
  const nl = templateLine(f);
  assert.equal(nl.lang, 'nl');
  assert.ok(/\b(Kom|ik|Ik|hoor)\b/.test(nl.line) && nl.line.includes('CHAPEL'), nl.line);
  const t = templateLine(factsFor(req(c, { heard: [{ text: 'come and get me', speaker: 'Sam', speakerId: 'p1', agoSec: 1 }] })));
  assert.ok(/hear you|keep talking/.test(t.line), t.line);
  for (const l of [en, nl, t]) assert.ok(validateLine(l.line, { known: ROOMS }), `template must validate: ${l.line}`);
});

test('mock pipeline: Haiku mock line -> synthetic WAV in the cache -> ai.lure to the victim + RX LED', async () => {
  const c = crew();
  let garbled = 0;
  assert.equal(speakLure(req(c), () => { garbled++; }), true);
  await settle();
  assert.equal(garbled, 0);
  const lure = events.find((x) => x.e === 'ai.lure');
  assert.ok(lure, `ai.lure expected, got ${events.map((x) => x.e).join(',')}`);
  assert.deepEqual(lure.d.to, ['p1']);
  assert.match(String(lure.d.url), /^\/assets\/vo-gen\/mock-lure-[0-9a-f]{16}\.wav$/);
  assert.ok(Number(lure.d.ms) >= 900, `clip ms ${lure.d.ms}`);
  assert.equal(lure.d.text, undefined, 'the line never goes to clients as text');
  const led = events.find((x) => x.e === 'monsters.led');
  assert.deepEqual(led?.d.to, ['p1']);
  assert.ok(existsSync(join(DIR, String(lure.d.url).split('/').pop()!)));
  const st = lureStatus();
  assert.equal(st.voiced, 1);
  assert.equal(st.haiku, 1);
});

test('intercom lure: no walkie -> ai.lure with the intercom position for everyone in range', async () => {
  const c = crew();
  assert.equal(speakLure(req(c, { viaWalkie: false, victim: null, intercom: { id: 'ic1', p: [3, 1.6, 4] } }), () => {}), true);
  await settle();
  const lure = events.find((x) => x.e === 'ai.lure');
  assert.deepEqual(lure?.d.to, []);
  assert.deepEqual(lure?.d.p, [3, 1.6, 4]);
  assert.equal(lure?.d.intercom, 'ic1');
  assert.equal(events.some((x) => x.e === 'monsters.led'), false);
});

test('budgets: per-crew cooldown, session cap, not outside a contract, flag off', async () => {
  const c = crew();
  assert.equal(speakLure(req(c), () => {}), true);
  assert.equal(speakLure(req(c), () => {}), false, 'second lure inside 60 s');
  assert.equal(lureBlocked(req(c)), 'cooldown');
  bal.lureMaxPerSession = 1;
  resetLureCooldown(c.code);
  assert.equal(lureBlocked(req(c)), 'session cap');
  bal.lureMaxPerSession = 40;
  const hub = crew();
  hub.phase = 'hub';
  assert.equal(lureBlocked(req(hub)), 'not in a contract');
  (ctx.flags as Record<string, boolean>).listenerVoice = false;
  assert.equal(lureBlocked(req(crew())), 'flag off');
  delete (ctx.flags as Record<string, unknown>).listenerVoice;
  await settle();
});

test('fallbacks: a TTS miss (replay, no cached audio) and a missed deadline play the garbled clip instead', async () => {
  mode('replay');
  const c = crew();
  let garbled = 0;
  assert.equal(speakLure(req(c), () => { garbled++; }), true);
  await settle();
  assert.equal(garbled, 1, 'replay miss -> garbled');
  assert.equal(events.some((x) => x.e === 'ai.lure'), false);
  mode('mock');
  bal.lureDeadlineMs = 100;
  bal.lureTtsReserveMs = 0;
  const c2 = crew();
  let g2 = 0;
  assert.equal(speakLure(req(c2), () => { g2++; }), true);
  await settle(200);
  assert.equal(g2, 1, 'no time left for TTS -> garbled');
  assert.equal(lureStatus().fallback, 2);
});

test('live TTS request shape (stubbed fetch, fake key): flash model, language, voice, format; chars budgeted + logged; cache hit costs nothing', async () => {
  mode('live');
  (ctx.flags as Record<string, boolean>).lureHaiku = false; // template only: no Claude call in this test
  const realFetch = globalThis.fetch;
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(new Uint8Array(4000).fill(0x55), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof fetch;
  process.env.ELEVENLABS_API_KEY = 'test-key-not-real';
  try {
    const c = crew();
    assert.equal(speakLure(req(c), () => assert.fail('no fallback expected')), true);
    await settle(150);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.match(call.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/[A-Za-z0-9]+\?output_format=mp3_22050_32$/);
    assert.equal(call.headers['xi-api-key'], 'test-key-not-real');
    assert.equal(call.body.model_id, 'eleven_flash_v2_5');
    assert.equal(call.body.language_code, 'en');
    assert.ok(typeof call.body.text === 'string' && (call.body.text as string).includes('Boiler'), 'callsign Title-cased for TTS');
    const lure = events.find((x) => x.e === 'ai.lure');
    assert.match(String(lure?.d.url), /^\/assets\/vo-gen\/lure-[0-9a-f]{16}\.mp3$/);
    assert.equal(Number(lure?.d.ms), 1000, '4000 bytes at 32 kbps');
    const chars = lureStatus().chars;
    assert.equal(chars, (call.body.text as string).length);
    const row = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { route: string; chars: number }).filter((r) => r.route === 'lure.tts');
    assert.equal(row.length, 1);
    assert.equal(row[0].chars, chars, 'usage log: characters only');
    assert.ok(!readFileSync(LOG, 'utf8').includes('Sam'), 'usage log never contains the text');
    // same line again -> cache hit, no request, no chars
    resetLureCooldown(c.code);
    events = [];
    assert.equal(speakLure(req(c), () => assert.fail('no fallback expected')), true);
    await settle(100);
    // the template choice depends on the attempt count; force the same text through synthesize directly too
    const again = await synthesize({ text: String(call.body.text), voice: { id: call.url.split('/').pop()!.split('?')[0] }, lang: 'en', model: 'eleven_flash_v2_5', format: 'mp3_22050_32', settings: call.body.voice_settings as Record<string, number>, timeoutMs: 500, dir: DIR, urlBase: '/assets/vo-gen/', mode: 'live' });
    assert.ok(again.ok && again.cached && again.chars === 0, 'cache hit');
    // restart: the char budget comes back from the usage log
    const before = lureStatus().chars;
    resetLure();
    bal.lureTtsCharBudget = 10;
    assert.equal(lureBlocked(req(crew())), 'char budget');
    assert.ok(lureStatus().chars >= before - 1);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ELEVENLABS_API_KEY;
    delete (ctx.flags as Record<string, unknown>).lureHaiku;
  }
});

test('TTS 401 turns TTS off for the process (garbled from then on)', async () => {
  mode('live');
  (ctx.flags as Record<string, boolean>).lureHaiku = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 })) as typeof fetch;
  process.env.ELEVENLABS_API_KEY = 'test-key-not-real';
  try {
    let garbled = 0;
    const c = crew();
    assert.equal(lureBlocked(req(c)), null);
    const before = lureStatus().chars;
    assert.equal(speakLure(req(c), () => { garbled++; }), true);
    await settle(100);
    assert.equal(garbled, 1);
    assert.match(String(lureStatus().down), /401/);
    assert.match(String(lureBlocked(req(crew()))), /^tts /);
    assert.equal(lureStatus().chars, before, 'an HTTP error is not billed');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ELEVENLABS_API_KEY;
    delete (ctx.flags as Record<string, unknown>).lureHaiku;
  }
});

test('mock WAV + cache key helpers', () => {
  const w = mockVoiceWav('Sam, come to BOILER');
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 22050);
  const k1 = ttsKey({ text: 'a', voice: { id: 'v' }, lang: 'en', model: 'm', format: 'f', settings: { a: 1, b: 2 } });
  const k2 = ttsKey({ text: 'a', voice: { id: 'v' }, lang: 'en', model: 'm', format: 'f', settings: { b: 2, a: 1 } });
  assert.equal(k1, k2, 'settings order does not matter');
  assert.notEqual(k1, ttsKey({ text: 'b', voice: { id: 'v' }, lang: 'en', model: 'm', format: 'f', settings: { a: 1, b: 2 } }));
  assert.equal(clipMs(join(DIR, 'missing.mp3'), 'mp3_22050_32'), 0);
});
