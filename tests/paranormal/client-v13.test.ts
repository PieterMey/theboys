// Owner: env-paranormal (v1.3). The client effects of dead pokes and site rules on a fake Env (no browser):
//  - a dead poke knock sounds like any knock (count from the event, rattleDoor on its door)
//  - a dead poke flicker pulses the room's fixtures ('pulse', 40 ms stagger; one slow 'brown' with reduce flicker), with a
//    relay tink; a late event (reconnect) does nothing
//  - the bell: yoke groan 0.7 s before, then one pitched-down clock_chime per strike at server time at + i * everyMs
//    (45 m), a dust puff each; a late join plays only what is still to come
//  - the phone: relay tink before, then phone_bell (ringMs) per ring
//   node --test tests/paranormal/client-v13.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParanormalEvent, SiteRuleEvent } from '../../packages/shared/src/messages/paranormal.ts';
import type { Env } from '../../apps/client/src/paranormal/env.ts';
import { Knock } from '../../apps/client/src/paranormal/ambient.ts';
import { PokeFlicker } from '../../apps/client/src/paranormal/pokes.ts';
import { SiteRuleSound } from '../../apps/client/src/paranormal/siterules.ts';

interface Rec { synth: { kind: string; pos: number[] | null; opts: Record<string, unknown> }[]; curves: { idx: number[]; curve: string; start: number; step?: number }[]; puffs: string[]; rattles: number[]; fear: number[] }

function fakeEnv(o: { reduce?: boolean; cam?: [number, number, number]; spectating?: boolean } = {}): { env: Env; rec: Rec } {
  const rec: Rec = { synth: [], curves: [], puffs: [], rattles: [], fear: [] };
  const fixtures = [
    { space: 3, pos: [1, 2.8, 1] as [number, number, number], id: 'light:1' },
    { space: 3, pos: [3, 2.8, 1] as [number, number, number], id: 'light:2' },
    { space: 4, pos: [9, 2.8, 9] as [number, number, number], id: 'light:9' },
  ];
  const layout = { W: 12, H: 12, owner: new Array(144).fill(3) } as never;
  const env = {
    ctx: {} as never,
    render: () => ({
      fixtureCurve: (idx: readonly number[], curve: string, start: number, step?: number) => { rec.curves.push({ idx: [...idx], curve, start, step }); },
      puff: (_p: unknown, kind: string) => { rec.puffs.push(kind); },
    }),
    level: () => ({ layout, grid: null, version: 1, fixtures, rattleDoor: (id: number) => { rec.rattles.push(id); } }),
    sfx: () => undefined,
    players: () => ({ cameraPos: () => o.cam ?? [2, 1.6, 2], spectating: () => !!o.spectating }),
    three: () => undefined,
    settings: () => ({ mode: 'full' as const }),
    reduceFlicker: () => !!o.reduce,
    me: () => 'p1',
    serverNow: () => 0,
    local: (ms: number) => ms + 0.5,
    seen: () => {},
    synth: (kind: string, pos: number[] | null, opts: Record<string, unknown>) => { rec.synth.push({ kind, pos, opts }); },
    fear: (v: number) => { rec.fear.push(v); },
    fixtureIndex: (id: string) => fixtures.findIndex((f) => f.id === id),
    log: () => {},
  } as unknown as Env;
  return { env, rec };
}

const poke = (data: ParanormalEvent['data'], at = 10_000, ms = 2400): ParanormalEvent => ({ id: 7, kind: 'dead_poke', tier: 0, at, ms, seed: 42, space: 3, p: [2, 1.15, 0.3], data });

test('a dead poke knock sounds like any knock: count, pattern, its door rattles', () => {
  const { env, rec } = fakeEnv();
  const k = new Knock(env, poke({ poke: 'knock', door: 5, pattern: 'metal', count: 2, amp: 0.85 }, 10_000, 1420));
  assert.equal(k.update(9_999), true);
  assert.equal(rec.synth.length, 0);
  k.update(10_010);
  assert.equal(rec.synth.length, 1);
  assert.equal(rec.synth[0].kind, 'knock');
  assert.equal(rec.synth[0].opts.count, 2);
  assert.equal(rec.synth[0].opts.pattern, 'metal');
  assert.deepEqual(rec.rattles, [5]);
  assert.ok(rec.fear.length === 1, 'heard close by: a heartbeat bump');
  // a wall knock (door -1) rattles nothing
  const w = fakeEnv();
  new Knock(w.env, poke({ poke: 'knock', door: -1, pattern: 'wood', count: 1, amp: 0.85 })).update(10_000);
  assert.deepEqual(w.rec.rattles, []);
  assert.equal(w.rec.synth[0].opts.count, 1);
});

test('a dead poke flicker pulses the room\'s fixtures with a relay tink; reduce flicker = one slow sag; late = nothing', () => {
  const { env, rec } = fakeEnv();
  const f = new PokeFlicker(env, poke({ poke: 'flicker', lights: ['light:1', 'light:2', 'light:404'], curve: 'pulse' }));
  assert.equal(f.update(9_000), true);
  assert.equal(rec.curves.length, 0);
  assert.equal(f.update(10_050), true);
  assert.deepEqual(rec.curves, [{ idx: [0, 1], curve: 'pulse', start: 10_000.5, step: 40 }]);
  assert.equal(rec.synth[0].kind, 'relay_tink');
  assert.equal(rec.fear.length, 1, 'the living in that room feel it');
  assert.equal(f.update(12_000), true);
  assert.equal(f.update(12_800), false, 'done after ms + 300');
  assert.equal(rec.curves.length, 1, 'once');
  const r = fakeEnv({ reduce: true, spectating: true });
  new PokeFlicker(r.env, poke({ poke: 'flicker', lights: ['light:1'] })).update(10_000);
  assert.deepEqual(r.rec.curves.map((c) => [c.curve, c.step]), [['brown', 0]]);
  assert.equal(r.rec.fear.length, 0, 'the dead feel nothing');
  const late = fakeEnv();
  assert.equal(new PokeFlicker(late.env, poke({ poke: 'flicker', lights: ['light:1'] })).update(12_000), false);
  assert.equal(late.rec.curves.length, 0);
});

const rule = (o: Partial<SiteRuleEvent>): SiteRuleEvent => ({ id: 3, rule: 'bell_digits', at: 10_000, seed: 9, space: 2, p: [5, 2.7, 5], data: { strikes: 3, everyMs: 2200 }, ...o });

test('the bell: yoke groan before, one deep strike per strike at at + i * everyMs (45 m), dust each; late joins skip the past', () => {
  const { env, rec } = fakeEnv({ cam: [5, 1.6, 6] });
  const s = new SiteRuleSound(env, rule({}));
  s.update(9_200);
  assert.equal(rec.synth.length, 0);
  s.update(9_400);
  assert.deepEqual(rec.synth.map((x) => x.kind), ['pipe_groan'], 'the wind-up');
  s.update(10_000);
  s.update(12_250);
  assert.equal(s.update(14_450), true);
  const strikes = rec.synth.filter((x) => x.kind === 'clock_chime');
  assert.equal(strikes.length, 3);
  assert.ok(strikes.every((x) => x.opts.count === 1 && (x.opts.rate as number) < 1 && x.opts.radius === 45), 'pitched down, 45 m');
  assert.equal(new Set(strikes.map((x) => x.opts.seed)).size, 3, 'each strike its own seed');
  assert.equal(rec.puffs.filter((k) => k === 'dust').length, 3);
  assert.equal(rec.fear.length, 1, 'near the bell: one heartbeat bump');
  assert.equal(s.update(10_000 + 2 * 2200 + 4499), true);
  assert.equal(s.update(10_000 + 2 * 2200 + 4500), false, 'finished after the last strike rings out');
  // a late join (first frame at 13 s): strikes at 10 s and 12.2 s are over, 14.4 s still plays; no wind-up
  const late = fakeEnv();
  const l = new SiteRuleSound(late.env, rule({}));
  l.update(13_000);
  l.update(14_500);
  assert.deepEqual(late.rec.synth.map((x) => x.kind), ['clock_chime']);
});

test('the phone: relay tink before, then phone_bell (ringMs) per ring', () => {
  const { env, rec } = fakeEnv();
  const s = new SiteRuleSound(env, rule({ rule: 'phone_callsign', data: { callsign: 'OFFICE', rings: 2, everyMs: 4000, ringMs: 2000 } }));
  s.update(9_350);
  s.update(10_000);
  s.update(14_000);
  assert.deepEqual(rec.synth.map((x) => x.kind), ['relay_tink', 'phone_bell', 'phone_bell']);
  assert.ok(rec.synth.filter((x) => x.kind === 'phone_bell').every((x) => x.opts.ms === 2000));
  assert.equal(s.update(16_499), true);
  assert.equal(s.update(16_500), false);
});
