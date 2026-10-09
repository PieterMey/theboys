// Owner: track (c) Monsters (v1.3 F1). Unit (no server): the Listener's wake gate + the contract-end hearing line.
//  - at its wake time it wakes only with a line to act on (meaningful or a taunt, heard <= wakeLineMaxAgeSec ago);
//    else it stays dormant (logged once), still listening, until its first meaningful line (it then wakes at once and
//    acts on that line), at most wakeHoldMaxSec (90 s) more; wakeHoldMaxSec 0 = the old fixed wake time
//  - small talk (no callsign / name / digits / plan word) never wakes it; a line older than the window does not count
//  - listenerSummary: "heard N lines (M before waking), nearest speaker D m; woke at ..." with no player names
//   node --test tests/monsters/wake.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAND } from '../../packages/shared/src/constants.ts';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { makeRt, startContract, tickRuntime } from '../../apps/server/src/monsters/runtime.ts';
import type { Rt } from '../../apps/server/src/monsters/runtime.ts';
import { listenerHeardUtterance, listenerSummary } from '../../apps/server/src/monsters/listener.ts';
import type { ListenerAgent } from '../../apps/server/src/monsters/types.ts';
import { stubCrew, stubCtx, stubPlayer } from './unit.ts';
import type { StubCtx } from './unit.ts';

const LAYOUT: LevelLayout = generateFacility({ seed: 'v13-wake', players: 1, risk: 1 });
const DT = 1 / 30;

interface World { s: StubCtx; rt: Rt; L: ListenerAgent; callsign: string; pid: string }

function world(tune: Record<string, unknown> = {}): World {
  const s = stubCtx({ flags: { director: false }, tune: { listener: tune } });
  const cab = LAYOUT.van.cab;
  // the only player sits in the sealed van cab: silent for every monster
  const p = stubPlayer('p1', cab.x + 1, cab.y + 1.5);
  const crew = stubCrew(LAYOUT, [p]);
  const cm = startContract(s.ctx, crew, { risk: 1, contractIndex: 0 });
  assert.ok(cm, 'contract runtime');
  const rt = makeRt(s.ctx, crew, cm, () => {});
  for (const a of cm.agents) if (a.kind !== 'listener') rt.retreat(a, 1e6); // only the Listener in these tests
  const L = cm.agents.find((a) => a.kind === 'listener') as ListenerAgent;
  assert.ok(L && L.dormant, 'a dormant Listener');
  const callsign = LAYOUT.spaces.find((q) => q.callsign && q.id !== LAYOUT.entrance)!.callsign!;
  return { s, rt, L, callsign, pid: p.id };
}

const tickTo = (w: World, t: number) => { while (w.rt.cm.time < t) tickRuntime(w.rt, DT); };
const say = (w: World, segId: string, text: string) => listenerHeardUtterance(w.rt, w.L, { segId, speaker: w.pid, text, room: -1, via: 'voice', band: BAND.talk, heard: true, durSec: 1.5 });

test('nothing meaningful by wake time: it stays dormant (logged once) and its first meaningful line wakes it at once', () => {
  const w = world();
  const wakeAt = w.L.wakeAt;
  assert.equal(wakeAt, 180, 'risk 1 wake time (dormantRealSecRisk1)');
  tickTo(w, wakeAt + 0.2);
  assert.equal(w.L.dormant, true, 'still dormant at its wake time with 0 lines');
  assert.equal(w.L.held, true);
  tickTo(w, wakeAt + 5);
  assert.equal(w.s.logs.filter((l) => l.includes('stays dormant')).length, 1, 'the hold is logged once');
  // small talk does not wake it
  const l1 = say(w, 's1', 'uh yeah okay');
  assert.ok(l1 && !l1.meaningful, 'small talk reaches its memory but is not meaningful');
  tickTo(w, wakeAt + 20);
  assert.equal(w.L.dormant, true, 'small talk never wakes it');
  assert.equal(w.s.events.filter((e) => e.e === 'monsters.wake').length, 0);
  // the first meaningful line: it wakes on the next tick and acts on that line
  const tLine = w.rt.cm.time;
  const l2 = say(w, 's2', `meet me in the ${w.callsign.toLowerCase()} now`);
  assert.ok(l2?.meaningful, 'callsign + plan word = meaningful');
  tickRuntime(w.rt, DT);
  assert.equal(w.L.dormant, false, 'awake right after its first meaningful line');
  assert.ok(Math.abs((w.L.wokeAt ?? -1) - tLine) < 0.1, `woke at the line (${w.L.wokeAt} vs ${tLine})`);
  assert.equal(w.s.events.filter((e) => e.e === 'monsters.wake').length, 1, 'one facility-wide wake flicker');
  const last = w.rt.cm.log[w.rt.cm.log.length - 1];
  assert.ok(last && last.action === 'ambush_room' && last.line.includes(w.callsign), `it acted on that line: ${last?.line}`);
  assert.ok(w.s.logs.some((l) => /woke up \(2 lines in memory, on its first meaningful line after \d+ s more\)/.test(l)), w.s.logs.join(' | '));
});

test('no meaningful line for wakeHoldMaxSec: it wakes at the cap', () => {
  const w = world();
  tickTo(w, w.L.wakeAt + 89.8);
  assert.equal(w.L.dormant, true, 'still holding just before the 90 s cap');
  tickTo(w, w.L.wakeAt + 90.1);
  assert.equal(w.L.dormant, false, 'awake at wakeAt + 90 s');
  assert.ok(w.s.logs.some((l) => l.includes('hold cap reached after 90 s more')), w.s.logs.join(' | '));
});

test('a meaningful line in the last wakeLineMaxAgeSec: it wakes on time; an older one does not count', () => {
  const on = world();
  tickTo(on, on.L.wakeAt - 30);
  say(on, 'r1', `the code is four seven one nine`);
  tickTo(on, on.L.wakeAt + 0.1);
  assert.equal(on.L.dormant, false, 'woke at its wake time');
  assert.notEqual(on.L.held, true);
  assert.ok(Math.abs((on.L.wokeAt ?? 0) - on.L.wakeAt) < 0.1);
  const old = world();
  tickTo(old, old.L.wakeAt - 100);
  say(old, 'o1', `regroup in the ${old.callsign.toLowerCase()}`);
  tickTo(old, old.L.wakeAt + 1);
  assert.equal(old.L.dormant, true, 'a 100 s old line is too old to act on: it holds');
  assert.equal(old.L.held, true);
});

test('a taunt counts as a line to act on (the AI answers it in-world)', () => {
  const w = world();
  tickTo(w, w.L.wakeAt + 1);
  assert.equal(w.L.dormant, true);
  listenerHeardUtterance(w.rt, w.L, { segId: 't1', speaker: w.pid, text: 'come and get me', room: -1, via: 'voice', band: BAND.talk, heard: true, durSec: 1, taunt: true });
  tickRuntime(w.rt, DT);
  assert.equal(w.L.dormant, false, 'a taunt wakes it');
});

test('wakeHoldMaxSec 0 restores the fixed wake time', () => {
  const w = world({ wakeHoldMaxSec: 0 });
  tickTo(w, w.L.wakeAt + 0.1);
  assert.equal(w.L.dormant, false, 'woke at wakeAt with 0 lines (old behaviour)');
});

test('contract-end summary: lines, lines before waking, nearest speaker, wake time; no names', () => {
  const w = world();
  const cm = w.rt.cm;
  const p = w.rt.crew.players.get(w.pid)!;
  // a speaker 12 m (straight line) from the Listener, out of the cab, talking for a moment
  const target: [number, number] = [w.L.x + 12, w.L.z];
  p.pose = { ...p.pose, p: [target[0], 0, target[1]] };
  p.band = BAND.talk;
  tickTo(w, 2);
  p.band = BAND.silent;
  const cab = cm.layout.van.cab;
  p.pose = { ...p.pose, p: [cab.x + 1, 0, cab.y + 1.5] };
  tickTo(w, w.L.wakeAt - 10);
  say(w, 'a', 'hello there');
  say(w, 'b', `go to the ${w.callsign.toLowerCase()}`);
  tickTo(w, w.L.wakeAt + 0.5);
  assert.equal(w.L.dormant, false);
  say(w, 'c', 'run');
  const s = listenerSummary(w.L);
  assert.match(s, /^heard 3 lines \(2 before waking\), nearest speaker 12 m; woke at 180 s$/, s);
  assert.ok(!s.includes(p.name) && !s.includes(p.id), 'no names or ids');
  const fresh = world();
  assert.equal(listenerSummary(fresh.L), 'heard 0 lines (0 before waking), nearest speaker none; never woke');
});
