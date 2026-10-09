// Owner: track (c) Monsters (v1.3 F6, flag earwigs). Unit (no server): the Earwigs.
//  - placement on generated layouts (1-6 players): 2 ears up to 2 players, 3 for 3-4, 4 for 5-6; >= 10 m apart; never
//    in the lobby (entrance), the vault, outside or the van cab; on a plain wall of its own room at 1.25-1.75 m;
//    deterministic; route coverage (speech within 10 m path) before the Listener wakes: >= 45 % with 2 ears on average
//    (concepts-monsters TOP-1 asks >= 45 %), versus ~0-2 % for the dormant Listener's own spot
//  - the flag gates everything (no ears, no dyn entries, no relays) and works as a kill switch mid-contract
//  - an ear hears what a teammate standing there would (voice within the band radius by path), relays a transcript the
//    Listener did not hear itself as a line placed AT THE EAR (room + position = the ear's, never the speaker's), ticks
//  - a flashlight on it (in range, in the beam cone, line of sight) makes it deaf for 6 s: no records, no relays
//  - the loudness reaches an awake idle Listener as "a voice near the ear": it investigates the ear's room
//   node --test tests/monsters/earwigs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAND } from '../../packages/shared/src/constants.ts';
import { EDGE, buildEdgeGrid, edgeCode } from '../../packages/shared/src/nav/index.ts';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import type { Snapshot } from '../../packages/shared/src/state.ts';
import { inCab } from '../../apps/server/src/monsters/geo.ts';
import { HALF_T } from '../../packages/shared/src/procgen/place.ts';
import { EAR_WALL_OFF, earCount, earDeaf, earForUtterance, earOpts, earRelayed, earRoute, earsSnapshot, placeEars, routeCoverage } from '../../apps/server/src/monsters/earwigs.ts';
import { listenerHeardUtterance } from '../../apps/server/src/monsters/listener.ts';
import { makeRt, startContract, tickRuntime } from '../../apps/server/src/monsters/runtime.ts';
import type { Rt } from '../../apps/server/src/monsters/runtime.ts';
import type { Ear, ListenerAgent } from '../../apps/server/src/monsters/types.ts';
import { REPO, stubCrew, stubCtx, stubPlayer } from './unit.ts';
import type { StubCtx } from './unit.ts';

const B = (JSON.parse(readFileSync(join(REPO, 'config/balance/monsters.json'), 'utf8')) as { earwigs: Record<string, number> }).earwigs;
const DT = 1 / 30;

test('placement on generated layouts: count by crew size, >= 10 m apart, allowed rooms, on a wall, deterministic, coverage', () => {
  const cov: Record<number, { ears: number[]; listener: number[] }> = {};
  let layouts = 0;
  for (const players of [1, 2, 3, 4, 5, 6]) {
    for (let s = 0; s < (players === 2 || players === 4 ? 24 : 8); s++) {
      const L = generateFacility({ seed: `v13-ears-${players}-${s}`, players, risk: 1 + (s % 2) });
      const g = buildEdgeGrid(L);
      const o = earOpts(B, players);
      const route = earRoute(L, g, o.stepM, o.preShare);
      const ears = placeEars(L, g, o, route);
      layouts++;
      const want = players <= 2 ? 2 : players <= 4 ? 3 : 4;
      assert.equal(o.count, want, `count for ${players} players`);
      assert.equal(ears.length, want, `${L.seed}: ${ears.length}/${want} ears`);
      const maxD = Math.max(...L.spaces.map((q) => q.dist));
      for (const e of ears) {
        const sp = L.spaces[e.space];
        assert.ok(e.space !== L.entrance && sp.kind !== 'vault' && sp.kind !== 'outside' && sp.type !== 'lobby', `${L.seed} ${e.id}: in ${sp.kind}/${sp.type}`);
        assert.ok(!inCab(L, e.x, e.z), `${L.seed} ${e.id}: in the van cab`);
        assert.equal(g.owner[Math.floor(e.z) * g.W + Math.floor(e.x)], e.space, `${e.id}: hearing cell in its room`);
        assert.ok(e.y >= B.heightMin - 1e-9 && e.y <= B.heightMax + 1e-9, `${e.id}: height ${e.y}`);
        // the mount sits on a wall edge of its hearing cell, the normal pointing into the room
        const cx = Math.floor(e.x), cz = Math.floor(e.z);
        const dir = e.nx === -1 ? 0 : e.nx === 1 ? 1 : e.nz === -1 ? 2 : 3;
        assert.equal(edgeCode(g, cx, cz, dir), EDGE.wall, `${L.seed} ${e.id}: on a plain wall`);
        assert.ok(Math.hypot(e.wx - e.nx * EAR_WALL_OFF - (cx + 0.5 + (e.nx === 0 ? 0 : -e.nx * 0.5)), e.wz - e.nz * EAR_WALL_OFF - (cz + 0.5 + (e.nz === 0 ? 0 : -e.nz * 0.5))) < 1e-6, `${e.id}: mount = edge midpoint, on the visible wall face`);
        assert.ok(EAR_WALL_OFF > HALF_T, 'in front of the visible wall face (the mesher draws walls HALF_T into the room)');
        assert.ok(sp.dist / maxD <= 1 && sp.dist / maxD >= 0, 'depth');
      }
      for (let i = 0; i < ears.length; i++) for (let j = i + 1; j < ears.length; j++) {
        const d = Math.hypot(ears[i].x - ears[j].x, ears[i].z - ears[j].z);
        assert.ok(d >= B.minSepM - 1e-9, `${L.seed}: ${ears[i].id}-${ears[j].id} ${d.toFixed(1)} m apart`);
      }
      // deterministic
      const again = placeEars(L, g, o, earRoute(L, g, o.stepM, o.preShare));
      assert.deepEqual(again.map((e) => [e.x, e.z, e.wx, e.wz, e.y]), ears.map((e) => [e.x, e.z, e.wx, e.wz, e.y]), `${L.seed}: deterministic`);
      const c = (cov[players] ??= { ears: [], listener: [] });
      c.ears.push(routeCoverage(L, g, ears, route, B.talkM).pre);
      const lis = L.items.find((i) => i.kind === 'spawn_listener');
      if (lis) c.listener.push(routeCoverage(L, g, [{ x: lis.x, z: lis.z }], route, B.talkM).pre);
    }
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const report = Object.entries(cov).map(([p, c]) => `${p}p ears ${(mean(c.ears) * 100).toFixed(0)}% vs listener ${(mean(c.listener) * 100).toFixed(1)}%`).join(', ');
  console.log(`pre-wake route coverage over ${layouts} layouts: ${report}`);
  for (const p of [2, 4]) {
    assert.ok(mean(cov[p].ears) >= 0.45, `${p} players: pre-wake coverage ${(mean(cov[p].ears) * 100).toFixed(1)}% >= 45%`);
    assert.ok(mean(cov[p].ears) > mean(cov[p].listener) + 0.3, `${p} players: ears beat the dormant Listener's own spot`);
  }
  assert.equal(earCount(B, 2), 2);
  assert.equal(earCount(B, 3), 3);
  assert.equal(earCount(B, 6), 4);
});

// ------------------------------------------------------------------ runtime

interface World { s: StubCtx; rt: Rt; L: ListenerAgent; ear: Ear; p: ReturnType<typeof stubPlayer>; q: ReturnType<typeof stubPlayer> }

const LAYOUT = generateFacility({ seed: 'v13-ears-rt', players: 2, risk: 1 });

function world(on = true): World {
  const s = stubCtx({ flags: { director: false, earwigs: on } });
  const cab = LAYOUT.van.cab;
  const p = stubPlayer('p1', cab.x + 1, cab.y + 1.5);
  const q = stubPlayer('p2', cab.x + 1, cab.y + 2.5);
  const crew = stubCrew(LAYOUT, [p, q]);
  const cm = startContract(s.ctx, crew, { risk: 1, contractIndex: 0 })!;
  const rt = makeRt(s.ctx, crew, cm, () => {});
  for (const a of cm.agents) if (a.kind !== 'listener') rt.retreat(a, 1e6);
  const L = cm.agents.find((a) => a.kind === 'listener') as ListenerAgent;
  // the ear farthest from the Listener (it must not hear the talk itself)
  const ear = [...(cm.ears ?? [])].sort((a, b) => Math.hypot(b.x - L.x, b.z - L.z) - Math.hypot(a.x - L.x, a.z - L.z))[0];
  return { s, rt, L, ear, p, q };
}

const ticks = (w: World, sec: number) => { const end = w.rt.cm.time + sec; while (w.rt.cm.time < end) tickRuntime(w.rt, DT); };
/** stand at the ear (1.2 m in front of it, facing it or away) */
const standAt = (w: World, light: 0 | 1, facing: boolean) => {
  const e = w.ear;
  const x = e.x + e.nx * 0.7, z = e.z + e.nz * 0.7;
  const yaw = Math.atan2(e.wx - x, e.wz - z) + (facing ? 0 : Math.PI);
  w.p.pose = { ...w.p.pose, p: [x, 0, z], yaw, pitch: 0, light } as typeof w.p.pose;
};
const talk = (w: World, sec: number) => { w.p.band = BAND.talk; ticks(w, sec); w.p.band = BAND.silent; };
/** the index.ts heard() path: the Listener first, then an ear */
const transcript = (w: World, segId: string, text: string) => {
  const seg = { segId, speaker: w.p.id, text, room: -1, via: 'voice' as const, band: BAND.talk, heard: false, durSec: 1.5 };
  if (listenerHeardUtterance(w.rt, w.L, seg)) return 'listener';
  const ear = earForUtterance(w.rt, w.p.id, seg.durSec);
  if (!ear) return null;
  const line = listenerHeardUtterance(w.rt, w.L, { ...seg, ear: { id: ear.id, space: ear.space, x: ear.x, z: ear.z } });
  if (!line) return null;
  earRelayed(w.rt, ear);
  return line;
};
const ticksAt = (w: World, since: number) => w.s.events.filter((e, i) => i >= since && e.e === 'monsters.cue' && (e.d as { id: string; cue: string }).id === w.ear.id && (e.d as { cue: string }).cue === 'tick');

test('flag off: no ears, no dyn entries; on: ears + dyn entries; switching it off mid-contract stops them', () => {
  const off = world(false);
  assert.equal(off.rt.cm.ears?.length ?? 0, 0, 'no ears with the flag off');
  const snap = { dyn: [] } as unknown as Snapshot;
  earsSnapshot(off.rt, snap);
  assert.equal(snap.dyn.length, 0);
  const on = world(true);
  assert.equal(on.rt.cm.ears?.length, 2, '2 players: 2 ears');
  assert.ok(on.s.logs.some((l) => /2 earwigs on the route/.test(l)), on.s.logs.join(' | '));
  const snap2 = { dyn: [] } as unknown as Snapshot;
  earsSnapshot(on.rt, snap2);
  assert.deepEqual(snap2.dyn.map((d) => d.id), ['ear:0', 'ear:1']);
  const d0 = snap2.dyn[0], e0 = on.rt.cm.ears![0];
  assert.ok(Math.abs(d0.p[1] - e0.y) < 1e-9 && Math.abs(d0.yaw - Math.atan2(e0.nx, e0.nz)) < 1e-3, 'p[1] = height, yaw = wall normal');
  on.s.ctx.flags.earwigs = false;
  const snap3 = { dyn: [] } as unknown as Snapshot;
  earsSnapshot(on.rt, snap3);
  assert.equal(snap3.dyn.length, 0, 'kill switch: no dyn entries');
  standAt(on, 0, true);
  talk(on, 1);
  assert.equal(on.ear.samples, 0, 'kill switch: the ear hears nothing');
});

test('an ear relays a line the dormant Listener did not hear, placed at the ear; it ticks', () => {
  const w = world();
  // the Listener sleeps in the sealed van cab here: it can never hear the talk itself
  const cab = w.rt.cm.layout.van.cab;
  w.L.x = w.L.lastX = cab.x + 0.5;
  w.L.z = w.L.lastZ = cab.y + 0.5;
  standAt(w, 0, true);
  const n0 = w.s.events.length;
  talk(w, 1.2);
  assert.ok(w.ear.samples > 0 && (w.ear.heard.get(w.p.id)?.length ?? 0) > 0, 'the ear heard the voice');
  assert.equal(w.L.voiceHeard.get(w.p.id)?.length ?? 0, 0, 'the Listener itself did not');
  assert.equal(ticksAt(w, n0).length, 1, 'one tick while it passes the voice on (<= every tickEverySec)');
  const n1 = w.s.events.length;
  const line = transcript(w, 'e1', 'meet at the levers');
  assert.ok(line && line !== 'listener', 'relayed through the ear');
  const l = line as Exclude<typeof line, string | null>;
  assert.equal(l.ear, w.ear.id);
  assert.equal(l.room, w.ear.space, 'room = the ear\'s room');
  assert.ok(l.px === w.ear.x && l.pz === w.ear.z, 'position = the ear, never the speaker');
  assert.equal(w.L.dormant, true, 'still dormant: it only remembers');
  const k = w.L.known.get(w.p.id);
  assert.ok(k && k.x === w.ear.x && k.z === w.ear.z, 'it knows "a voice near the ear"');
  assert.equal(ticksAt(w, n1).length, 1, 'a tick on the relayed line');
  const tk = ticksAt(w, n1)[0].d as { p: number[]; radius: number; kind: string };
  assert.ok(tk.radius === B.tickRadiusM && tk.kind === 'listener' && Math.abs(tk.p[1] - w.ear.y) < 1e-9, 'tick at the ear, 4 m');
  assert.equal(w.L.earLines, 1);
  assert.equal(w.ear.relays, 1);
  // a whisper at 3 m path radius does not reach an ear 4+ m away
  const w2 = world();
  const e = w2.ear;
  w2.p.pose = { ...w2.p.pose, p: [e.x + e.nx * 4.5, 0, e.z + e.nz * 4.5] };
  w2.p.band = BAND.whisper;
  ticks(w2, 1);
  w2.p.band = BAND.silent;
  assert.equal(w2.ear.samples, 0, 'a whisper 4.5 m away: nothing');
});

test('a flashlight on the ear makes it deaf for 6 s (no records, no relays); facing away does not', () => {
  const w = world();
  standAt(w, 1, false);
  ticks(w, 0.5);
  assert.equal(earDeaf(w.rt, w.ear), false, 'light on but facing away: not deaf');
  standAt(w, 1, true);
  ticks(w, 0.5);
  assert.equal(earDeaf(w.rt, w.ear), true, 'lit: deaf');
  talk(w, 1.2);
  assert.equal(w.ear.samples, 0, 'deaf: it heard nothing');
  assert.equal(transcript(w, 'd1', 'the code is four seven one nine'), null, 'deaf: no relay');
  // light off: still deaf for 6 s after the beam left
  standAt(w, 0, true);
  ticks(w, 4);
  assert.equal(earDeaf(w.rt, w.ear), true, 'deaf 4 s after the light went off');
  ticks(w, 2.5);
  assert.equal(earDeaf(w.rt, w.ear), false, 'hears again ~6 s after');
  talk(w, 1.2);
  assert.ok(w.ear.samples > 0, 'it hears again');
  const line = transcript(w, 'd2', 'the code is four seven one nine');
  assert.ok(line && line !== 'listener' && line.ear === w.ear.id, 'and relays again');
  // lit right after the talk: a lit ear relays nothing, even a line it heard before
  standAt(w, 0, true);
  talk(w, 1.2);
  standAt(w, 1, true);
  ticks(w, 0.3);
  assert.equal(transcript(w, 'd3', 'regroup at the van'), null, 'lit before the transcript arrived: no relay');
});

test('an awake idle Listener goes to the ear that passed a voice on (never to the speaker)', () => {
  const w = world();
  w.L.wakeAt = 0;
  w.L.memory.push({ id: 99, t: 0, segId: 'seed', speaker: null, speakerName: null, text: 'go', room: -1, via: 'voice', band: 2, callsigns: [], names: [], plan: ['go'], digits: [], meaningful: true, px: w.L.x, pz: w.L.z, pdoor: -1, used: true });
  ticks(w, 0.2);
  assert.equal(w.L.dormant, false, 'awake');
  w.L.intent = 'patrol';
  w.L.state = 'patrol';
  w.L.path = null;
  standAt(w, 0, true);
  talk(w, 0.4);
  assert.equal(w.L.intent, 'investigate_room', `intent ${w.L.intent}`);
  assert.equal(w.L.targetSpace, w.ear.space, 'the ear\'s room');
  assert.ok(Math.hypot(w.L.goalX - w.ear.x, w.L.goalZ - w.ear.z) < 1.5 || !!w.L.ventFrom, `goal at the ear (${w.L.goalX},${w.L.goalZ} vs ${w.ear.x},${w.ear.z})`);
});
