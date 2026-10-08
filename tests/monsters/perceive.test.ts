// Owner: track (c) Monsters (v1.2 G2). Unit (no server): the perceived doorway of a sound (geo perceive) is a reachable
// movement goal inside a door cell, never ON the door edge (the 2026-10-08 live freeze: a goal on a closed door's edge,
// follow() replanning forever), on the side the door decides:
//  - open door or doorless gap: PERCEIVED_DOOR_BACK_M past the line on the sound's side (it steps into the doorway);
//  - closed door the monster can open: the same point; following it pauses at the door, opens it and steps in (unless
//    its own path is shorter through another, open entrance of that room: then it never walks through the closed one);
//  - closed door it cannot open (locked / security / vault / exit, rubble): PERCEIVED_DOOR_BACK_M back on its own side,
//    and it never opens or crosses it.
// Every door of several generated facilities (plus two small layouts with a doorless room entrance), from both sides:
// the monster stands diagonally in front of a door cell (the shape that froze), a sprint step sounds 1.5 m behind the
// door; hunt-like following (replans every 0.35 s, the Listener's door pause) always returns and reaches the point. The
// door id never depends on canOpen (the Hound reads only the id), and without canOpen a closed door always stops it.
// The simulation runs in a child process with a time limit, so a regression to an endless loop fails instead of hanging.
//   node --test tests/monsters/perceive.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { buildEdgeGrid, cellOf, doorStateArray, soundFlood } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { PERCEIVED_DOOR_BACK_M, follow, inCab, monsterCanOpen, perceive, planTo } from '../../apps/server/src/monsters/geo.ts';
import type { Agent, CrewMonsters } from '../../apps/server/src/monsters/types.ts';

const SEEDS = ['ls-solo-3', 'ls-solo-4', 'g2-fair-1', 'g2-fair-solo', 'g3-listener', 'g2-warn-1'];
/** the Listener's huntDoorPauseSec (config/balance/monsters.json) */
const DOOR_PAUSE_SEC = 1.4;
const TICK = 0.05, TICKS = 90;

type Case = 'open' | 'opens' | 'stops';
interface SimResult {
  tested: number; reached: number; unreachable: number; locked2: number;
  /** 'open' approaches through a doorless gap (kind 'open') */
  gaps: number;
  byCase: Record<Case, number>;
  /** 'opens' approaches where it opened that door / reached the point through another entrance instead */
  opened: number; around: number;
  failures: string[];
}

/** 12 x 6 m: room 0 (x 0..5) | room 1 (x 6..11) joined by a doorless entrance (kind 'open') of `len` cells on x = 6
 *  (the generated sites' only significant gap is the van's, a sanctuary: no monster stands or paths there) */
function gapRooms(len: number): LevelLayout {
  const W = 12, H = 6;
  const owner: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) owner.push(x < 6 ? 0 : 1);
  const space = (id: number, x: number) => ({ id, kind: 'room', rect: { x, y: 0, w: 6, h: 6 }, zone: 0, type: 'office', callsign: null, dist: 0, light: 'on', open: false, powerZone: 0 });
  return {
    genVersion: 1, kind: 'facility', seed: `gap-${len}`, hash: `gap-${len}`, W, H, owner,
    spaces: [space(0, 0), space(1, 6)],
    doors: [{ id: 0, a: 0, b: 1, x: 6, y: 2, dir: 'v', len, kind: 'open', lock: 0, initiallyOpen: true }],
    items: [], entrance: 0, van: { x: 40, z: 40, yaw: 0, cab: { x: 40, y: 40, w: 2, h: 4 } }, zones: 1, wallH: 3, metrics: {},
  } as unknown as LevelLayout;
}

function simulate(): SimResult {
  const out: SimResult = { tested: 0, reached: 0, unreachable: 0, locked2: 0, gaps: 0, byCase: { open: 0, opens: 0, stops: 0 }, opened: 0, around: 0, failures: [] };
  const layouts = [...SEEDS.map((seed) => generateFacility({ seed, players: 1, risk: 1 })), gapRooms(1), gapRooms(2)];
  for (const layout of layouts) {
    const seed = layout.seed;
    const grid = buildEdgeGrid(layout);
    const canOpen = monsterCanOpen(layout);
    // indoor cells, never the sealed van cab (noises there are never heard, monsters never path in)
    const walkable = (x: number, z: number) => {
      const c = cellOf(grid, x, z);
      return c >= 0 && grid.owner[c] >= 0 && layout.spaces[grid.owner[c]]?.kind !== 'outside' && !inCab(layout, x, z);
    };
    for (const d of layout.doors) {
      if (d.a < 0 || d.b < 0) continue;
      for (const sgn of [1, -1]) {
        for (let k = 0; k < d.len; k++) {
          // the near-side door cell centre, the monster one cell further out and one cell along (diagonal), the noise
          // 1.5 m behind the door
          const t = (d.dir === 'h' ? d.x : d.y) + k + 0.5;
          const nearN = (d.dir === 'h' ? d.y : d.x) + sgn * 0.5;
          for (const along of [-1, 1]) {
            const mN = nearN + sgn, mT = t + along;
            const [mx, mz] = d.dir === 'h' ? [mT, mN] : [mN, mT];
            const [sx, sz] = d.dir === 'h' ? [t, (d.y) - sgn * 1.5] : [(d.x) - sgn * 1.5, t];
            if (!walkable(mx, mz) || !walkable(sx, sz)) continue;
            // every approach starts from the generated door states (a door it opened stays open only for that approach)
            const ds = doorStateArray(layout);
            const cm = { grid, doorOpen: ds.open, layout, time: 0 } as unknown as CrewMonsters;
            const field = soundFlood(grid, sx, sz, 12, ds.open);
            const per = perceive(cm, field, mx, mz, sx, sz, canOpen);
            if (per.door !== d.id) continue; // another doorway came first, or it heard it directly
            out.tested++;
            const open = d.kind === 'open' || ds.open(d.id);
            const kase: Case = open ? 'open' : canOpen(d.id) ? 'opens' : 'stops';
            out.byCase[kase]++;
            if (kase === 'stops' && d.len % 2 === 0) out.locked2++;
            if (d.kind === 'open') out.gaps++;
            const where = `${seed} door ${d.id} (${d.kind}${open ? ', open' : ''}, ${d.dir}, len ${d.len}) side ${sgn} cell ${k} from ${mx},${mz} [${kase}]`;
            // signed distance from the door line, positive on the monster's side; along = inside the door's span
            const offOf = (x: number, z: number) => (d.dir === 'h' ? z - d.y : x - d.x) * sgn;
            const off = offOf(per.x, per.z);
            const span = d.dir === 'h' ? per.x - d.x : per.z - d.y;
            const want = kase === 'stops' ? PERCEIVED_DOOR_BACK_M : -PERCEIVED_DOOR_BACK_M;
            if (Math.abs(off - want) > 1e-6 || span <= 0 || span >= d.len) { out.failures.push(`${where}: perceived ${per.x},${per.z} (off ${off}, want ${want}, along ${span})`); continue; }
            // without canOpen it opens nothing: a closed door always stops it; the door id is the same either way
            const bare = perceive(cm, field, mx, mz, sx, sz);
            const bareWant = open ? -PERCEIVED_DOOR_BACK_M : PERCEIVED_DOOR_BACK_M;
            if (bare.door !== per.door || Math.abs(offOf(bare.x, bare.z) - bareWant) > 1e-6) { out.failures.push(`${where}: without canOpen door ${bare.door}, off ${offOf(bare.x, bare.z)} (want ${per.door}, ${bareWant})`); continue; }
            // hunt-like following: replan every 0.35 s, ticks of 50 ms at the hunt speed, the Listener's door pause
            const a = { x: mx, z: mz, yaw: 0, path: null, pathI: 0, goalX: 0, goalZ: 0, planAt: -1, stuck: 0, lastX: mx, lastZ: mz, doorWait: 0, pendingDoor: -1, speed: 0 } as unknown as Agent;
            const opened: number[] = [];
            const openDoor = (id: number) => { ds.state[id] = 1; opened.push(id); };
            let reached = false, planned = false, minOff = Infinity, throughClosed = false;
            for (let i = 0; i < TICKS && !reached; i++) {
              (cm as { time: number }).time = i * TICK;
              if (!a.path || cm.time - a.planAt > 0.35) planned = planTo(cm, a, per.x, per.z, canOpen) || planned;
              const ox = a.x, oz = a.z, shut = !ds.open(d.id);
              follow(cm, a, TICK, 4.6, canOpen, DOOR_PAUSE_SEC, openDoor);
              // this tick's step crossed the door line inside the door's span while the door was closed
              const o0 = offOf(ox, oz), o1 = offOf(a.x, a.z);
              if (shut && o0 > 0 && o1 <= 0) {
                const k = o0 / (o0 - o1), sAt = d.dir === 'h' ? ox + (a.x - ox) * k - d.x : oz + (a.z - oz) * k - d.y;
                if (sAt > -0.01 && sAt < d.len + 0.01) throughClosed = true;
              }
              minOff = Math.min(minOff, o1);
              reached = Math.hypot(a.x - per.x, a.z - per.z) < 0.05;
            }
            if (reached) out.reached++;
            else if (!planned) { out.unreachable++; continue; } // e.g. a fence between (sound crosses it, feet do not): no path, no loop
            else { out.failures.push(`${where}: never reached ${per.x},${per.z} (at ${a.x.toFixed(2)},${a.z.toFixed(2)})`); continue; }
            if (throughClosed) out.failures.push(`${where}: walked through the closed door`);
            if (kase === 'opens') {
              if (opened.includes(d.id)) out.opened++;
              else out.around++; // its own path into that room is shorter through an open entrance next to it
            }
            if (kase === 'stops' && (opened.includes(d.id) || minOff <= 0)) out.failures.push(`${where}: crossed or opened a door it cannot open (opened ${opened.join(',') || 'none'}, closest ${minOff.toFixed(2)} m)`);
          }
        }
      }
    }
  }
  return out;
}

if (process.argv.includes('--sim')) {
  process.stdout.write(JSON.stringify(simulate()));
} else {
  test('perceived doorways: through open and openable doors, in front of locked ones; reachable, and following always returns', () => {
    const r = spawnSync(process.execPath, [import.meta.filename, '--sim'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.signal, null, `the simulation was killed after ${60} s (${r.signal}): follow() never returned`);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const res = JSON.parse(r.stdout) as SimResult;
    const c = res.byCase;
    console.log(`  ${res.tested} door approaches: ${c.open} open (it steps into the doorway; ${res.gaps} of them doorless gaps), ${c.opens} closed that it can open (opened ${res.opened}, through another entrance ${res.around}), ${c.stops} closed that it cannot open (${res.locked2} at 2-cell doors); ${res.reached} reached, ${res.unreachable} without a walking path`);
    assert.deepEqual(res.failures, []);
    assert.ok(res.tested >= 30, `enough door approaches (${res.tested})`);
    assert.ok(c.open >= 5 && c.opens >= 5 && c.stops >= 5, `every kind of door is covered (open ${c.open}, opens ${c.opens}, stops ${c.stops})`);
    assert.ok(res.opened >= c.opens * 0.9, `it opens the closed door it heard the sound through (${res.opened}/${c.opens}; ${res.around} through another entrance)`);
    assert.ok(res.locked2 >= 1, 'at least one 2-cell door it cannot open (the shape that froze the server)');
    assert.ok(res.gaps >= 1, `at least one doorless gap (${res.gaps})`);
    assert.ok(res.reached >= res.tested * 0.9, `nearly every perceived doorway is reached (${res.reached}/${res.tested})`);
  });
}
