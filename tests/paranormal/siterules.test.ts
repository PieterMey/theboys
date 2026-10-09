// Owner: env-paranormal (v1.3 F7 Site Rules v0). Synthetic utterances and typed lines against the site-rule core and the
// live wiring behind a fake ServerContext (no STT, no AI):
//  - bell_digits: a spoken number strikes the bell in the furnace hall that many times (1-12; other numbers once per
//    digit; capped), a 25 m 'bell' noise per strike there; whispers, the dead and the van are ignored; one ringing at
//    a time, then a rest
//  - phone_callsign: a spoken callsign rings that room's phone (its booth / switchboard / desk), 2 rings, a 25 m 'phone'
//    noise per ring; per-room and crew-wide gaps; the van never rings
//  - the live path: an STT utterance (ai/hub.ts emitUtterance, what the bridge calls) and typed proximity text
//    (players/noise.ts emitProxText) both reach it; flag siteRules off = silence; events carry no text
//   node --test tests/paranormal/siterules.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { STANCE } from '../../packages/shared/src/state.ts';
import { BAND } from '../../packages/shared/src/constants.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { SiteRuleEvent } from '../../packages/shared/src/messages/paranormal.ts';
import { SITE_RULES, siteRuleOf } from '../../packages/shared/src/messages/paranormal.ts';
import type { Utterance } from '../../packages/shared/src/messages/ai.ts';
import type { Crew, ServerContext, ServerPlayer, ServerSystem } from '../../apps/server/src/core/types.ts';
import { resolveBalance } from '../../apps/server/src/paranormal/balance.ts';
import { bellSpot, bellStrikes, dueNoises, newRuleState, phoneSpot, reactToLine } from '../../apps/server/src/paranormal/siterules.ts';
import type { RuleLine } from '../../apps/server/src/paranormal/siterules.ts';
import { indoor, nearVan, spaceAtXZ } from '../../apps/server/src/paranormal/gates.ts';
import { install } from '../../apps/server/src/paranormal/index.ts';
import { emitUtterance } from '../../apps/server/src/ai/hub.ts';
import { emitProxText, onNoise } from '../../apps/server/src/players/noise.ts';
import type { NoiseEvent } from '../../apps/server/src/players/noise.ts';

const B = resolveBalance({});
const FOUNDRY = generateFacility({ seed: 'varga-1', players: 2, risk: 1, theme: 'industry' } as never) as LevelLayout;
const EXCHANGE = generateFacility({ seed: 'exch-1', players: 2, risk: 1, theme: 'comms' } as never) as LevelLayout;

/** a cell inside an indoor room (not the van, not near it) of a layout */
function spot(L: LevelLayout, avoid: number[] = []): { x: number; z: number; space: number } {
  for (const s of L.spaces) {
    if (!indoor(L, s.id) || s.kind === 'corridor' || avoid.includes(s.id)) continue;
    const x = Math.floor(s.rect.x + s.rect.w / 2) + 0.5, z = Math.floor(s.rect.y + s.rect.h / 2) + 0.5;
    if (spaceAtXZ(L, x, z) === s.id && !nearVan(L, x, z, 3)) return { x, z, space: s.id };
  }
  throw new Error('no room');
}

const line = (o: Partial<RuleLine>): RuleLine => ({ speaker: 'p0', alive: true, kind: 'voice', band: BAND.talk, x: 0, z: 0, digits: [], callsigns: [], ...o });

test('the bell counts like a clock: 1-12 that many times, any other number once per digit, capped at 12', () => {
  assert.equal(bellStrikes([], 12), 0);
  assert.equal(bellStrikes(['3'], 12), 3);
  assert.equal(bellStrikes(['12'], 12), 12);
  assert.equal(bellStrikes(['13'], 12), 2);
  assert.equal(bellStrikes(['0'], 12), 1);
  assert.equal(bellStrikes(['4719'], 12), 4);
  assert.equal(bellStrikes(['3', '2'], 12), 5);
  assert.equal(bellStrikes(['9', '8'], 12), 12, 'capped');
  assert.equal(bellStrikes(['x1'], 12), 0, 'digit runs only');
});

test('site rule of an order: template site name, an AI-renamed order by theme + chip, a meta tag; others none', () => {
  assert.equal(siteRuleOf({ siteName: 'Varga Brothers Foundry' }), 'bell_digits');
  assert.equal(siteRuleOf({ siteName: 'Old Quarry Road Telephone Exchange' }), 'phone_callsign');
  assert.equal(siteRuleOf({ siteName: 'Hollow Creek Foundry Works', siteTheme: 'industry', modifiers: ['HEAVY SALVAGE', 'MANNEQUIN'] }), 'bell_digits');
  assert.equal(siteRuleOf({ siteName: 'Line Nine', siteTheme: 'comms', modifiers: ['RADIO HEAVY'] }), 'phone_callsign');
  assert.equal(siteRuleOf({ siteName: 'Dunmore Radio Relay Station', siteTheme: 'comms', modifiers: ['LISTENER ACTIVE'] }), null);
  assert.equal(siteRuleOf({ siteName: 'Corrigan Shoe Factory', siteTheme: 'industry', modifiers: ['HARD FLOORS'] }), null);
  assert.equal(siteRuleOf({ siteName: 'Anything', siteRule: 'phone_callsign' }), 'phone_callsign');
  assert.equal(siteRuleOf(null), null);
  assert.deepEqual(SITE_RULES.map((r) => r.id), ['bell_digits', 'phone_callsign']);
});

test('bell_digits: strikes at the bell in the furnace hall, a 25 m noise per strike; whispers, the dead, the van ignored', () => {
  const L = FOUNDRY;
  const bell = bellSpot(L)!;
  assert.ok(bell, 'a bell spot');
  const want = ['FURNACE', 'FOUNDRY', 'BOILER', 'PIT'].find((cs) => L.spaces.some((s) => s.callsign === cs));
  assert.equal(L.spaces[bell.space].callsign, want, 'the furnace hall first');
  const me = spot(L, [bell.space]);
  const rs = newRuleState('t1');
  const now = 1_000_000;
  assert.equal(reactToLine(rs, L, B, 'bell_digits', line({ x: me.x, z: me.z, digits: ['4'], band: BAND.whisper }), now), null, 'a whisper passes');
  assert.equal(reactToLine(rs, L, B, 'bell_digits', line({ x: me.x, z: me.z, digits: ['4'], alive: false }), now), null, 'the dead are not heard');
  const vanX = L.van.cab.x + L.van.cab.w / 2, vanZ = L.van.cab.y + L.van.cab.h / 2;
  assert.equal(reactToLine(rs, L, B, 'bell_digits', line({ x: vanX, z: vanZ, digits: ['4'] }), now), null, 'the sealed van');
  assert.equal(reactToLine(rs, L, B, 'bell_digits', line({ x: me.x, z: me.z, callsigns: ['BOILER'] }), now), null, 'no number, no bell');
  const r = reactToLine(rs, L, B, 'bell_digits', line({ x: me.x, z: me.z, digits: ['4719'] }), now);
  assert.ok(r, 'a code rings the bell');
  assert.equal(r!.ev.rule, 'bell_digits');
  assert.equal(r!.ev.data.strikes, 4);
  assert.equal(r!.ev.data.everyMs, 2200);
  assert.ok(r!.ev.at >= now + 900, 'after the wind-up lead');
  assert.equal(r!.ev.space, bell.space);
  assert.deepEqual([r!.ev.p[0], r!.ev.p[2]], [bell.x, bell.z]);
  assert.ok(!('text' in r!.ev.data), 'no text in the event');
  assert.deepEqual(r!.noises.map((n) => n.at - r!.ev.at), [0, 2200, 4400, 6600]);
  assert.ok(r!.noises.every((n) => n.kind === 'bell' && n.radiusM === 25 && n.x === bell.x && n.z === bell.z));
  // while it rings (and its 3 s rest) another number passes; then it rings again
  assert.equal(reactToLine(rs, L, B, 'bell_digits', line({ x: me.x, z: me.z, digits: ['2'] }), now + 5000), null);
  const lastStrike = r!.ev.at + 3 * 2200;
  assert.equal(reactToLine(rs, L, B, 'bell_digits', line({ x: me.x, z: me.z, digits: ['2'] }), lastStrike + 2999), null, 'resting');
  const r2 = reactToLine(rs, L, B, 'bell_digits', line({ x: me.x, z: me.z, digits: ['2'], kind: 'text', band: 0 }), lastStrike + 3000);
  assert.ok(r2, 'typed text counts as talk');
  assert.equal(r2!.ev.data.strikes, 2);
  // the noises come due in order
  assert.equal(dueNoises(rs, r!.ev.at - 1).length, 0);
  assert.equal(dueNoises(rs, r!.ev.at + 2200).length, 2);
  assert.equal(dueNoises(rs, Infinity).length, 4);
  assert.equal(rs.pending.length, 0);
  assert.deepEqual([rs.stats.bells, rs.stats.strikes], [2, 6]);
});

test('phone_callsign: the named room\'s phone rings twice (booth, switchboard or desk), per-room and crew-wide gaps', () => {
  const L = EXCHANGE;
  const booth = L.items.find((i) => i.kind === 'prop' && i.data?.prop === 'phone_booth' && indoor(L, i.space) && !!L.spaces[i.space].callsign)!;
  assert.ok(booth, 'the exchange has phone booths');
  const room = L.spaces[booth.space];
  const me = spot(L, [room.id]);
  const rs = newRuleState('t2');
  const now = 2_000_000;
  const r = reactToLine(rs, L, B, 'phone_callsign', line({ x: me.x, z: me.z, callsigns: [room.callsign!] }), now);
  assert.ok(r, 'a callsign rings its phone');
  assert.equal(r!.ev.space, room.id);
  assert.equal(r!.ev.data.callsign, room.callsign);
  const ps = phoneSpot(L, room.id);
  assert.deepEqual([r!.ev.p[0], r!.ev.p[2]], [ps.x, ps.z]);
  const boothsHere = L.items.filter((i) => i.kind === 'prop' && i.space === room.id && i.data?.prop === 'phone_booth');
  assert.ok(boothsHere.some((b2) => Math.abs(b2.x - ps.x) < 0.01 && Math.abs(b2.z - ps.z) < 0.01), 'at its phone booth');
  assert.deepEqual([r!.ev.data.rings, r!.ev.data.everyMs, r!.ev.data.ringMs], [2, 4000, 2000]);
  assert.deepEqual(r!.noises.map((n) => [n.at - r!.ev.at, n.kind, n.radiusM]), [[0, 'phone', 25], [4000, 'phone', 25]]);
  // crew-wide gap 3 s, the same room rests 12 s after its last ring
  const other = L.spaces.find((s) => s.callsign && s.id !== room.id && indoor(L, s.id) && s.type !== 'van')!;
  assert.equal(reactToLine(rs, L, B, 'phone_callsign', line({ x: me.x, z: me.z, callsigns: [other.callsign!] }), now + 2999), null, 'crew gap');
  const r2 = reactToLine(rs, L, B, 'phone_callsign', line({ x: me.x, z: me.z, callsigns: [room.callsign!, other.callsign!] }), now + 3000);
  assert.ok(r2, 'the next named room rings when the first is still busy');
  assert.equal(r2!.ev.space, other.id);
  const busyUntil = r!.ev.at + 4000 + 2000 + 12_000;
  assert.equal(reactToLine(rs, L, B, 'phone_callsign', line({ x: me.x, z: me.z, callsigns: [room.callsign!] }), busyUntil - 1), null, 'the room rests');
  assert.ok(reactToLine(rs, L, B, 'phone_callsign', line({ x: me.x, z: me.z, callsigns: [room.callsign!] }), busyUntil), 'then rings again');
  // the van never rings; a room without any phone prop rings at its centre
  assert.equal(reactToLine(newRuleState('t3'), L, B, 'phone_callsign', line({ x: me.x, z: me.z, callsigns: ['VAN'] }), now), null);
  const bare = L.spaces.find((s) => s.callsign && indoor(L, s.id) && !L.items.some((i) => i.kind === 'prop' && i.space === s.id && ['phone_booth', 'switchboard', 'desk'].includes(String(i.data?.prop))));
  if (bare) {
    const c = phoneSpot(L, bare.id);
    assert.equal(spaceAtXZ(L, c.x, c.z), bare.id, 'the centre of a room without phones');
  }
});

// ---------------------------------------------------------------- live wiring behind a fake ServerContext

interface Fake {
  ctx: ServerContext;
  systems: ServerSystem[];
  reqs: Map<string, (crew: Crew, p: ServerPlayer, a: unknown) => unknown>;
  emits: { e: string; d: unknown; to?: string[] }[];
  now: { t: number };
  flags: Record<string, boolean>;
}

function fakeCtx(flags: Record<string, boolean>): Fake {
  const reqs = new Map<string, (crew: Crew, p: ServerPlayer, a: unknown) => unknown>();
  const emits: Fake['emits'] = [];
  const now = { t: 9_000_000 };
  const systems: ServerSystem[] = [];
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const ctx = {
    cfg: {} as never, flags, balance: { core: { contractRealSec: 900 }, paranormal: {} }, env: { dev: true } as never,
    log: () => logger, crews: {} as never,
    registerSystem: (s: ServerSystem) => { systems.push(s); },
    registerReq: (n: string, h: (crew: Crew, p: ServerPlayer, a: unknown) => unknown) => { reqs.set(n, h); },
    registerDbg: (n: string, h: (crew: Crew, p: ServerPlayer, a: unknown) => unknown) => { reqs.set(n.startsWith('dbg.') ? n : `dbg.${n}`, h); },
    onVoiceChunk: noop,
    emit: (_crew: Crew, e: string, d: unknown, opts?: { to?: string[] }) => { emits.push({ e, d, to: opts?.to }); },
    send: noop, sendSig: noop, notice: noop,
    hooks: { join: [], leave: [], phase: [], pose: [], loud: [], crewSnapshot: [], snapshot: [], fullState: [], welcome: [], config: [] },
    setPhase: noop, buildFullState: noop as never,
    now: () => now.t,
    reloadConfig: noop,
  } as unknown as ServerContext;
  install(ctx);
  return { ctx, systems, reqs, emits, now, flags };
}

function crewOn(L: LevelLayout, code: string, at: { x: number; z: number }): Crew {
  const players = new Map<string, ServerPlayer>();
  players.set('p0', {
    id: 'p0', key: 'k0', name: 'Ann', profile: {} as never, connected: true, ready: true, alive: true, consent: { transcribe: true, mimic: false },
    level: 1, pose: { seq: 1, p: [at.x, 0, at.z], yaw: 0, pitch: 0, stance: STANCE.stand, anim: 0, light: 1 } as never, poseAt: 0, band: 0, radio: 0,
    socket: null, resume: '', joinedAt: 0, isLeader: true, disconnectedAt: 0, slices: {},
  });
  return { code, phase: 'contract', players, layout: L, slices: {}, createdAt: 0, tick: 0, emptySince: 0 };
}

const utter = (crew: Crew, o: Partial<Utterance>): Utterance => ({
  segId: 1, crew: crew.code, speaker: 'p0', speakerName: 'Ann', text: 'x', norm: 'x', lang: 'en', band: BAND.talk, room: null, roomId: -1,
  pos: [0, 0], startedAt: 0, endedAt: 0, viaRadio: false, kind: 'voice', via: 'voice', callsigns: [], names: [], digits: [], meaningful: true,
  taunt: false, hearers: { players: [], listener: false, walkies: [] }, sttMs: 50, ...o,
});

test('live: transcripts and typed text reach the rule; flag siteRules gates it; noises come due on the 78 system', () => {
  const noises: NoiseEvent[] = [];
  const off = onNoise((_c, n) => { if (n.kind === 'bell' || n.kind === 'phone') noises.push(n); });
  try {
    const f = fakeCtx({ paranormal: true });
    const me = spot(FOUNDRY, [bellSpot(FOUNDRY)!.space]);
    const crew = crewOn(FOUNDRY, 'SRL1', me);
    const p0 = crew.players.get('p0')!;
    const sys = f.systems.find((s) => s.name === 'siterules')!;
    assert.equal(sys.order, 78);
    const rules = () => f.emits.filter((e) => e.e === 'paranormal.rule').map((e) => e.d as SiteRuleEvent);
    // no rule for this crew yet (no meta order): nothing, even with the flag on
    f.flags.siteRules = true;
    emitUtterance(crew, utter(crew, { digits: ['3'], pos: [me.x, me.z] }));
    assert.equal(rules().length, 0, 'no site rule, no reaction');
    const st = f.reqs.get('dbg.paranormal.siteRule')!(crew, p0, { rule: 'bell_digits' }) as { rule: string; on: boolean };
    assert.deepEqual([st.rule, st.on], ['bell_digits', true]);
    // flag off: silence
    f.flags.siteRules = false;
    emitUtterance(crew, utter(crew, { digits: ['3'], pos: [me.x, me.z] }));
    assert.equal(rules().length, 0, 'flag off');
    f.flags.siteRules = true;
    // an STT transcript (what stt/bridge.ts publishes)
    emitUtterance(crew, utter(crew, { digits: ['3'], pos: [me.x, me.z], text: 'three', norm: '3' }));
    assert.equal(rules().length, 1, 'the bell answers a transcript');
    const ev = rules()[0];
    assert.equal(ev.data.strikes, 3);
    assert.ok(ev.at >= f.now.t + 900);
    assert.ok(!JSON.stringify(ev).includes('three') && !JSON.stringify(ev).includes('Ann'), 'no text, no name');
    assert.equal(f.emits.find((e) => e.e === 'paranormal.rule')!.to, undefined, 'to the whole crew');
    // the strikes' noises: none before `at`, then one per strike
    sys.tick(1 / 30, crew, f.ctx);
    assert.equal(noises.length, 0);
    f.now.t = ev.at + 1;
    sys.tick(1 / 30, crew, f.ctx);
    assert.equal(noises.length, 1);
    f.now.t = ev.at + 2 * 2200 + 1;
    sys.tick(1 / 30, crew, f.ctx);
    assert.equal(noises.length, 3);
    assert.ok(noises.every((n) => n.kind === 'bell' && n.radiusM === 25 && n.source === ''));
    // typed proximity text, Dutch number words: after the rest
    f.now.t += 3001;
    emitProxText(crew, { player: p0, text: 'de code is vier zeven', x: me.x, z: me.z, radiusM: 10, heardBy: [], t: f.now.t });
    assert.equal(rules().length, 2, 'typed text rings it too');
    assert.equal(rules()[1].data.strikes, 2, '"vier zeven" is the code 47: once per digit');
    // dbg say + a phase change drops what was still to come
    const pend = (f.reqs.get('dbg.paranormal.siteRule')!(crew, p0, {}) as { pending: number }).pending;
    assert.equal(pend, 2);
    crew.phase = 'results';
    for (const h of f.ctx.hooks.phase) h(crew, 'contract', 'results');
    assert.equal((f.reqs.get('dbg.paranormal.siteRule')!(crew, p0, {}) as { pending: number }).pending, 0);
    // the exchange: a callsign over dbg.say rings that room
    const ex = crewOn(EXCHANGE, 'SRL2', spot(EXCHANGE));
    const q0 = ex.players.get('p0')!;
    f.reqs.get('dbg.paranormal.siteRule')!(ex, q0, { rule: 'phone_callsign' });
    const target = EXCHANGE.spaces.find((s) => s.callsign && indoor(EXCHANGE, s.id) && s.type !== 'van' && s.id !== spaceAtXZ(EXCHANGE, q0.pose.p[0], q0.pose.p[2]))!;
    const say = f.reqs.get('dbg.paranormal.say')!(ex, q0, { text: `meet me in the ${target.callsign!.toLowerCase()}` }) as { heard: boolean };
    assert.equal(say.heard, true);
    const last = rules().at(-1)!;
    assert.equal(last.rule, 'phone_callsign');
    assert.equal(last.space, target.id);
    // 'auto' hands the rule back to meta (none without a meta order)
    assert.equal((f.reqs.get('dbg.paranormal.siteRule')!(ex, q0, { rule: 'auto' }) as { rule: string | null }).rule, null);
  } finally {
    off();
  }
});
