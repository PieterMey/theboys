// Owner: track (c) Monsters (v1.2 G2). The Listener at a doorway it only heard a sound through, and the regression for the
// 2026-10-08 live freeze. A sound from behind a door the Listener cannot open (locked / security / vault / exit) made it
// path to the door CENTRE: a goal on the closed door's edge (a 2-cell door's centre is even a grid vertex). follow()
// replanned to the same blocked segment forever and the server tick never returned. Now follow() replans at most once per
// call, and the perceived doorway (geo perceive) is a point PERCEIVED_DOOR_BACK_M (0.4 m) off the door line inside a door
// cell: past the line on the sound's side when the door is open or it can open it, on its own side when it cannot.
// ws bot on its own dev server (no browser, no AI), geometry searched per layout, /healthz probed throughout:
//  1. one sprint step behind a locked door (the Listener stands diagonally in front of it, facing away): it investigates
//     the doorway from its own side (goal 0.4 m short of the door line, it gets there), searches, then moves on (patrol)
//  2. the same through a hunt (the original freeze stack: follow <- step <- hunt): it notices the player, who is then
//     heard sprinting behind the locked door; it hunts to the near side of the doorway and waits there while it hears
//     them, then investigates, searches and moves on. No grab, the server keeps answering throughout
//  3. one sprint step behind a closed hand door (the player is long gone): it walks up, waits its door pause, opens the
//     door itself (a door event with no player) and steps in, 0.4 m past the line, within about 3 s; searches, moves on
//  4. the same door, now open: it walks into the doorway (0.4 m past the line, no further), searches there, moves on
//   node tests/monsters/hang.e2e.ts         (own dev server on PORT, default 3802)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { astar, cellOf, soundFlood, walkClear } from '../../packages/shared/src/nav/index.ts';
import type { LayoutDoor, LevelLayout } from '../../packages/shared/src/layout.ts';
import { monsterCanOpen, perceive } from '../../apps/server/src/monsters/geo.ts';
import type { CrewMonsters } from '../../apps/server/src/monsters/types.ts';
import { Bot, REPO, sleep, startServer, waitFor } from './bot.ts';
import type { EventRec } from './bot.ts';
import { cabSpot, check, contract, freeOfSolids, grabEvents, lis, park, r2, segClear, serverErrors, summary, tp, worldOf } from './fairlib.ts';
import type { Ag, World } from './fairlib.ts';

const PORT = Number(process.env.PORT ?? 3802);
/** the investigator's seed (locked door 5, 2 cells, centre on a grid vertex) first; more in case the layouts changed */
const SEEDS = ['ls-solo-3', 'g2-hang-1', 'g2-hang-2', 'g2-hang-3', 'g2-hang-4', 'g2-hang-5'];
const BACK_M = 0.4;
const LOCKED = new Set(['locked', 'security', 'vault', 'exit']);
const HAND = new Set(['door', 'fire']);
const LB = (JSON.parse(readFileSync(join(REPO, 'config/balance/monsters.json'), 'utf8')) as { listener: Record<string, number> }).listener;
const DOOR_PAUSE = LB.huntDoorPauseSec ?? 1.4;
/** case 3: from the sound to standing 0.4 m past the line (walk up + door pause + step in) */
const STEP_IN_MAX_SEC = 3.2;

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const S = new Bot('Solo');

// ---------------- /healthz prober (the freeze symptom: no reply while the tick spins) ----------------
const health = { n: 0, fail: 0, maxMs: 0 };
let probing = true;
async function healthy(ms: number): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return (await fetch(`${srv.base}/healthz`, { signal: ctl.signal })).ok; } catch { return false; } finally { clearTimeout(timer); }
}
const prober = (async () => {
  while (probing) {
    const t0 = performance.now();
    const ok = await healthy(1500);
    health.n++;
    if (!ok) health.fail++;
    health.maxMs = Math.max(health.maxMs, performance.now() - t0);
    await sleep(200);
  }
})();

/** the Listener, or null when the server does not answer within ms (a hung tick) */
const lisT = (ms = 2000): Promise<Ag | null> => Promise.race([lis(S).catch(() => null), sleep(ms).then(() => null)]);

// ---------------- geometry ----------------
const isWalk = (w: World, x: number, z: number) => {
  const c = cellOf(w.g, x, z);
  if (c < 0 || w.g.owner[c] < 0) return false;
  const sp = w.L.spaces[w.g.owner[c]];
  return !!sp && sp.kind !== 'outside' && sp.type !== 'van' && sp.callsign !== 'VAN';
};

interface Pick { seed: string; door: LayoutDoor; c: [number, number]; L0: [number, number]; N: [number, number]; side: number }

/** the walking path from L0 to the doorway point it perceives for a sound at N goes through door d itself (the sound
 *  comes through d, and no other entrance of that room is shorter for its feet) */
function walksThrough(w: World, d: LayoutDoor, L0: [number, number], N: [number, number]): boolean {
  const canOpen = monsterCanOpen(w.L);
  const cm = { grid: w.g, doorOpen: w.open, layout: w.L, time: 0 } as unknown as CrewMonsters;
  const per = perceive(cm, soundFlood(w.g, N[0], N[1], 12, w.open), L0[0], L0[1], N[0], N[1], canOpen);
  if (per.door !== d.id) return false;
  const r = astar(w.g, L0[0], L0[1], per.x, per.z, { mode: 'walk', doorOpen: w.open, canOpen, maxCost: 400 });
  if (!r) return false;
  const W = w.g.W;
  for (let i = 1; i < r.cells.length; i++) {
    const ax = r.cells[i - 1] % W, ay = Math.floor(r.cells[i - 1] / W), bx = r.cells[i] % W, by = Math.floor(r.cells[i] / W);
    const across = d.dir === 'v'
      ? ay === by && Math.abs(ax - bx) === 1 && Math.max(ax, bx) === d.x && ay >= d.y && ay < d.y + d.len
      : ax === bx && Math.abs(ay - by) === 1 && Math.max(ay, by) === d.y && ax >= d.x && ax < d.x + d.len;
    if (across) return true;
  }
  return false;
}

/** a closed door of `kinds` with a free spot diagonally in front of its centre on the side the centre's cell lies
 *  (cellOf rounds down: 'h' doors +z, 'v' doors +x) and a free spot 1.5 m behind it; 2-cell doors first. through: the
 *  Listener's own way to the doorway point it hears must lead through this door (hand doors) */
function findPick(w: World, seed: string, kinds: ReadonlySet<string>, through = false): Pick | null {
  const cands: Pick[] = [];
  for (const d of w.L.doors) {
    if (!kinds.has(d.kind) || d.a < 0 || d.b < 0 || w.open(d.id)) continue;
    const c: [number, number] = d.dir === 'v' ? [d.x, d.y + d.len / 2] : [d.x + d.len / 2, d.y];
    const Ls: [number, number][] = d.dir === 'h' ? [[c[0] - 0.5, c[1] + 1.5], [c[0] + 0.5, c[1] + 1.5]] : [[c[0] + 1.5, c[1] - 0.5], [c[0] + 1.5, c[1] + 0.5]];
    const N: [number, number] = d.dir === 'h' ? [c[0], c[1] - 1.5] : [c[0] - 1.5, c[1]];
    if (!isWalk(w, N[0], N[1]) || !freeOfSolids(w, N[0], N[1], 0.3)) continue;
    for (const L0 of Ls) {
      if (!isWalk(w, L0[0], L0[1]) || !freeOfSolids(w, L0[0], L0[1], 0.4)) continue;
      // it can walk straight up to the door on its own side
      const tx = c[0] + (d.dir === 'v' ? 0.01 : 0), tz = c[1] + (d.dir === 'h' ? 0.01 : 0);
      if (!walkClear(w.g, L0[0], L0[1], tx, tz, w.open)) continue;
      if (through && !walksThrough(w, d, L0, N)) continue;
      cands.push({ seed, door: d, c, L0, N, side: 1 });
      break;
    }
  }
  const p = cands.find((q) => q.door.len % 2 === 0) ?? cands[0] ?? null;
  if (p) p.side = Math.sign(offLine({ ...p, side: 1 }, p.L0[0], p.L0[1])) || 1;
  return p;
}

/** signed distance of (x, z) from the door line, positive on the Listener's side */
function offLine(p: Pick, x: number, z: number): number {
  return (p.door.dir === 'h' ? z - p.door.y : x - p.door.x) * p.side;
}
/** along the door: inside its span */
const inSpan = (p: Pick, x: number, z: number) => {
  const a = p.door.dir === 'h' ? x - p.door.x : z - p.door.y;
  return a >= -0.01 && a <= p.door.len + 0.01;
};
/** a goal is the perceived doorway: `off` m off the door line (positive: the Listener's side), within the door's span */
const doorwayAt = (p: Pick, g: number[] | undefined, off: number) => !!g && Math.abs(offLine(p, g[0], g[1]) - off) < 0.06 && inSpan(p, g[0], g[1]);
/** its own side, BACK_M short of the line (a door it cannot open) */
const doorwayGoal = (p: Pick, g: number[] | undefined) => doorwayAt(p, g, BACK_M);
/** the sound's side, BACK_M past the line (an open door, or one it opens) */
const throughGoal = (p: Pick, g: number[] | undefined) => doorwayAt(p, g, -BACK_M);

/** the world with the server's live door states (it may have opened hand doors on patrol since the layout was made) */
async function liveWorld(a: Bot, w: World): Promise<World> {
  const ix = await a.dbg<{ doors?: Record<number, { open?: boolean }> }>('interaction.state').catch(() => null);
  const doors = ix?.doors;
  return doors ? { ...w, open: (id: number) => !!doors[id]?.open } : w;
}

async function restart(a: Bot, seed: string): Promise<World> {
  const t0 = performance.now();
  await a.dbg('monsters.start', { seed, players: 1, risk: 1 });
  const L = await waitFor(() => (a.eventsOf('phase', t0).pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 4000, 'layout');
  for (const id of ['hound0', 'hound1', 'mannequin0', 'snatcher0']) await a.dbg('monsters.place', { id, outSec: 9999 }).catch(() => null);
  await a.dbg('monsters.wake');
  await park(a);
  return worldOf(L);
}

interface Sample { t: number; state: string; x: number; z: number; goal: number[] | undefined }
const fmtSeq = (ss: Sample[]) => {
  const out: string[] = [];
  for (const s of ss) if (!out.length || !out[out.length - 1].startsWith(`${s.state}@`)) out.push(`${s.state}@${r2(s.t)}s`);
  return out.join(' > ');
};
const goalOf = (l: Ag) => (l as Ag & { goal?: number[] }).goal;

/** stand the Listener at p.L0 facing (fx, fz), awake, in `state` */
const placeAt = (p: Pick, state: string, fx: number, fz: number) => S.dbg('monsters.place', { id: 'listener0', x: p.L0[0], z: p.L0[1], yaw: Math.atan2(fx - p.L0[0], fz - p.L0[1]), state, active: true, holdSec: 60 });
/** one sprint step at p.N, the player's (wherever they are) */
const noiseAt = (p: Pick) => S.dbg('monsters.noise', { x: p.N[0], z: p.N[1], radiusM: 12, kind: 'sprintStep', source: S.id });
/** the spot one step further from the door than L0 (it faces that way: it hears the step, it does not see) */
const awayOf = (p: Pick): [number, number] => (p.door.dir === 'h' ? [p.L0[0], p.L0[1] + p.side] : [p.L0[0] + p.side, p.L0[1]]);
/** interaction door events for door `id` since t0 (pid set = a player's hand) */
const doorEvents = (id: number, t0: number): EventRec[] => S.eventsOf('interaction.fx', t0).filter((e) => {
  const d = e.d as { kind?: string; door?: number };
  return (d.kind === 'door' || d.kind === 'security') && d.door === id;
});

interface Watch { s: Sample[]; noReply: number; reachAt: number; inAt: number; patrolAt: number }
/** after the sound at t0: poll the Listener until it patrols again (+1.2 s) or ms pass. reachAt: within 0.15 m of a goal
 *  `off` m off the line; inAt: first poll past the line (on the sound's side) */
async function watch(p: Pick, t0: number, ms: number, off: number): Promise<Watch> {
  const w: Watch = { s: [], noReply: 0, reachAt: -1, inAt: -1, patrolAt: -1 };
  while (performance.now() - t0 < ms) {
    const l = await lisT();
    const el = (performance.now() - t0) / 1000;
    if (!l) { w.noReply++; if (w.noReply >= 2) break; continue; }
    const g = goalOf(l);
    w.s.push({ t: el, state: l.state, x: l.x, z: l.z, goal: g });
    if (w.inAt < 0 && offLine(p, l.x, l.z) < 0) w.inAt = el;
    if (w.reachAt < 0 && doorwayAt(p, g, off) && Math.hypot(l.x - g![0], l.z - g![1]) <= 0.15) w.reachAt = el;
    if (w.reachAt >= 0 && w.patrolAt < 0 && l.state === 'patrol') w.patrolAt = el;
    if (w.patrolAt >= 0 && el - w.patrolAt > 1.2) break;
    await sleep(80);
  }
  return w;
}

let w!: World;
try {
  w = await contract(url, 'LHANG', [S], SEEDS[0], 1, 1);
  let seedNow = SEEDS[0];
  let pick = findPick(w, SEEDS[0], LOCKED);
  for (const seed of SEEDS.slice(1)) {
    if (pick) break;
    w = await restart(S, seed);
    seedNow = seed;
    pick = findPick(w, seed, LOCKED);
  }
  check('found a door it cannot open, with room on both sides', !!pick, pick ? `${pick.seed}: door ${pick.door.id} (${pick.door.kind}, ${pick.door.dir}, len ${pick.door.len}), L at ${pick.L0}, noise at ${pick.N}` : '');
  if (!pick) throw new Error('no pick');
  const p = pick;
  const away = awayOf(p);
  const noise = () => noiseAt(p);

  // ---------------- 1. one sprint step behind the locked door ----------------
  await tp(S, p.N[0], p.N[1], { light: 0, stance: 0 });
  await sleep(150);
  await placeAt(p, 'search', away[0], away[1]); // facing away from the door: it hears, it does not see
  await sleep(200);
  const h1 = { ...health };
  const t1 = performance.now();
  await noise();
  const s1: Sample[] = [];
  let noReply1 = 0, reachAt1 = -1, onAt1 = -1;
  while (performance.now() - t1 < 12_000) {
    const l = await lisT();
    const el = (performance.now() - t1) / 1000;
    if (!l) { noReply1++; if (noReply1 >= 2) break; continue; }
    s1.push({ t: el, state: l.state, x: l.x, z: l.z, goal: goalOf(l) });
    const g = goalOf(l);
    if (reachAt1 < 0 && doorwayGoal(p, g) && Math.hypot(l.x - g![0], l.z - g![1]) <= 0.15) reachAt1 = el;
    if (reachAt1 >= 0 && onAt1 < 0 && l.state === 'patrol') onAt1 = el;
    if (onAt1 >= 0 && el - onAt1 > 1.2) break;
    await sleep(80);
  }
  const inv1 = s1.filter((s) => s.state === 'investigate');
  const last1 = s1[s1.length - 1];
  console.log(`  1: ${fmtSeq(s1)}; goal ${inv1[0]?.goal?.join(',') ?? '-'} (door line ${p.door.dir === 'h' ? `z=${p.door.y}` : `x=${p.door.x}`})`);
  check('1: the server keeps answering (/healthz + every state poll)', noReply1 === 0 && health.fail === h1.fail && health.n - h1.n >= 5,
    `${health.n - h1.n} probes, ${health.fail - h1.fail} failed, slowest ${Math.round(health.maxMs)} ms; ${noReply1} unanswered polls`);
  check(`1: it investigates the doorway from its own side (goal ${BACK_M} m off the door line, never the centre)`,
    inv1.length > 0 && inv1.every((s) => doorwayGoal(p, s.goal)), inv1.length ? `off ${r2(offLine(p, inv1[0].goal![0], inv1[0].goal![1]))} m` : 'never investigated');
  check('1: and gets there (it does not stand stuck where it heard it)', reachAt1 >= 0, reachAt1 >= 0 ? `${r2(reachAt1)} s` : `closest ${r2(Math.min(...s1.map((s) => (s.goal ? Math.hypot(s.x - s.goal[0], s.z - s.goal[1]) : 99))))} m`);
  check('1: then it searches and moves on (patrol), never through the door', onAt1 >= 0 && s1.some((s) => s.state === 'search' && s.t > reachAt1 - 0.2) && s1.every((s) => s.state === 'patrol' || offLine(p, s.x, s.z) > 0),
    onAt1 >= 0 ? `patrol at ${r2(onAt1)} s, then ${r2(Math.hypot(last1.x - p.c[0], last1.z - p.c[1]))} m from the door` : `still ${last1?.state}`);

  // ---------------- 2. the hunt: noticed, then heard sprinting behind the locked door ----------------
  await S.dbg('monsters.forget', {});
  await park(S);
  // a lit spot on its side in front of it (2.5-4 m along the door normal), clear line of sight
  const n: [number, number] = p.door.dir === 'h' ? [0, p.side] : [p.side, 0];
  let P: [number, number] | null = null;
  for (const k of [3, 3.5, 2.5, 4]) {
    const q: [number, number] = [p.L0[0] + n[0] * k, p.L0[1] + n[1] * k];
    if (isWalk(w, q[0], q[1]) && freeOfSolids(w, q[0], q[1], 0.35) && walkClear(w.g, p.L0[0], p.L0[1], q[0], q[1], w.open) && segClear(w, p.L0, q, 0.25)) { P = q; break; }
  }
  check('2: found a spot in front of it on its side', !!P, P ? `${P}` : '');
  if (P) {
    await sleep(500);
    await tp(S, P[0], P[1], { light: 1, stance: 0, yaw: Math.atan2(p.L0[0] - P[0], p.L0[1] - P[1]) });
    await sleep(150);
    const h2 = { ...health };
    const t2 = performance.now();
    await placeAt(p, 'ambush', P[0], P[1]);
    const sp = await waitFor(() => S.eventsOf('monsters.spotted', t2)[0], 1600, 'spotted').catch(() => null);
    check('2: it notices the player', !!sp);
    // gone behind the locked door before the notice ends, sprinting there for 3.5 s
    await tp(S, p.N[0], p.N[1], { light: 0, stance: 2 });
    let noising = true;
    const noiser = (async () => { while (noising) { void noise().catch(() => null); await sleep(200); } })();
    const s2: Sample[] = [];
    let noReply2 = 0, reachAt2 = -1, quietAt = -1, offAt = -1, onAt2 = -1;
    const tq = performance.now();
    while (performance.now() - tq < 14_000) {
      const el = (performance.now() - tq) / 1000;
      if (noising && el >= 3.5) { noising = false; await noiser; quietAt = (performance.now() - tq) / 1000; }
      const l = await lisT();
      if (!l) { noReply2++; if (noReply2 >= 2) break; continue; }
      const t = (performance.now() - tq) / 1000;
      s2.push({ t, state: l.state, x: l.x, z: l.z, goal: goalOf(l) });
      const g = goalOf(l);
      if (reachAt2 < 0 && l.state === 'hunt' && doorwayGoal(p, g) && Math.hypot(l.x - g![0], l.z - g![1]) <= 0.2) reachAt2 = t;
      if (quietAt >= 0 && offAt < 0 && l.state !== 'hunt') offAt = t;
      if (offAt >= 0 && onAt2 < 0 && l.state === 'patrol') onAt2 = t;
      if (onAt2 >= 0 && t - onAt2 > 1) break;
      await sleep(80);
    }
    noising = false;
    await noiser;
    // (the very first 'hunt' poll can land between the notice ending and the hunt's first plan: the goal is stale there)
    const hunt2 = s2.filter((s, i, a) => s.state === 'hunt' && i > 0 && a[i - 1].state === 'hunt');
    console.log(`  2: ${fmtSeq(s2)}; hunt goal ${hunt2.find((s) => s.goal)?.goal?.join(',') ?? '-'}, quiet at ${r2(quietAt)} s`);
    check('2: the server keeps answering through the hunt', noReply2 === 0 && health.fail === h2.fail, `${health.n - h2.n} probes, ${health.fail - h2.fail} failed; ${noReply2} unanswered polls`);
    check('2: it hunts what it hears to the near side of the doorway (never the door centre) and gets there',
      hunt2.length > 0 && reachAt2 >= 0 && hunt2.every((s) => doorwayGoal(p, s.goal)),
      hunt2.length ? `reached at ${r2(reachAt2)} s, goals ${[...new Set(hunt2.map((s) => s.goal?.join(',')))].join(' | ')}` : 'no hunt');
    check('2: once it stops hearing them it gives up the hunt, searches and moves on (patrol)',
      offAt >= 0 && offAt - quietAt <= 1.6 && onAt2 >= 0, `hunt ended ${r2(offAt - quietAt)} s after the last step, patrol at ${r2(onAt2)} s`);
    check('2: no grab (it never got through the door to the player)', !grabEvents(S, t2).length && s2.every((s) => s.state === 'patrol' || offLine(p, s.x, s.z) > 0));
  }

  // ---------------- 3. one sprint step behind a closed hand door: it opens it and steps in ----------------
  await S.dbg('monsters.forget', {});
  await park(S);
  let hp = findPick(await liveWorld(S, w), seedNow, HAND, true);
  for (const seed of SEEDS) {
    if (hp) break;
    if (seed === seedNow) continue;
    w = await restart(S, seed);
    seedNow = seed;
    hp = findPick(await liveWorld(S, w), seed, HAND, true);
  }
  check('3: found a closed hand door it hears through and walks through, with room on both sides', !!hp,
    hp ? `${hp.seed}: door ${hp.door.id} (${hp.door.kind}, ${hp.door.dir}, len ${hp.door.len}), L at ${hp.L0}, noise at ${hp.N}` : '');
  if (hp) {
    const q = hp;
    const qa = awayOf(q);
    // the player is long gone (the sealed van cab): it only ever hears that one step
    const cab = cabSpot(w);
    await tp(S, cab[0], cab[1], { light: 0, stance: 0 });
    await sleep(300);
    await placeAt(q, 'search', qa[0], qa[1]);
    await sleep(200);
    const h3 = { ...health };
    const t3 = performance.now();
    await noiseAt(q);
    const w3 = await watch(q, t3, 12_000, -BACK_M);
    const inv3 = w3.s.filter((s) => s.state === 'investigate');
    const opened3 = doorEvents(q.door.id, t3).find((e) => (e.d as { open?: boolean }).open === true);
    const openAt3 = opened3 ? (opened3.at - t3) / 1000 : -1;
    const by3 = opened3 ? (opened3.d as { pid?: string | null }).pid ?? null : null;
    const last3 = w3.s[w3.s.length - 1];
    console.log(`  3: ${fmtSeq(w3.s)}; goal ${inv3[0]?.goal?.join(',') ?? '-'} (door line ${q.door.dir === 'h' ? `z=${q.door.y}` : `x=${q.door.x}`}); door opened at ${r2(openAt3)} s, past the line at ${r2(w3.inAt)} s, at the goal at ${r2(w3.reachAt)} s`);
    check('3: the server keeps answering (/healthz + every state poll)', w3.noReply === 0 && health.fail === h3.fail && health.n - h3.n >= 5,
      `${health.n - h3.n} probes, ${health.fail - h3.fail} failed; ${w3.noReply} unanswered polls`);
    check(`3: it investigates through the closed door: its goal is ${BACK_M} m past the door line, on the sound's side`,
      inv3.length > 0 && inv3.every((s) => throughGoal(q, s.goal)), inv3.length ? `off ${r2(offLine(q, inv3[0].goal![0], inv3[0].goal![1]))} m` : 'never investigated');
    check(`3: it opens the door itself after its door pause (${DOOR_PAUSE} s): a door event with no player`,
      !!opened3 && !by3 && openAt3 >= DOOR_PAUSE * 0.8 && openAt3 <= STEP_IN_MAX_SEC, opened3 ? `opened at ${r2(openAt3)} s${by3 ? ` by ${by3}` : ''}` : 'never opened');
    check(`3: and steps in, ${BACK_M} m past the line, within about 3 s of the sound`,
      w3.reachAt >= 0 && w3.reachAt <= STEP_IN_MAX_SEC && w3.inAt >= openAt3 - 0.05, `past the line at ${r2(w3.inAt)} s, at the goal at ${r2(w3.reachAt)} s`);
    check('3: then it searches there and moves on (patrol)', w3.patrolAt >= 0 && w3.s.some((s) => s.state === 'search' && s.t >= w3.reachAt - 0.2),
      w3.patrolAt >= 0 ? `patrol at ${r2(w3.patrolAt)} s` : `still ${last3?.state}`);

    // ---------------- 4. the same door, open: it steps into the doorway and looks in ----------------
    await S.dbg('monsters.forget', {});
    await park(S);
    await sleep(300);
    const ix = await S.dbg<{ doors: Record<number, { open?: boolean }> }>('interaction.state');
    if (!ix.doors[q.door.id]?.open) {
      // (it should still be open from 3; if not, the player opens it by hand while it is out of play)
      await tp(S, q.N[0], q.N[1], { light: 0, stance: 0 });
      await S.req('interaction.use', { id: `door:${q.door.id}` }).catch(() => null);
      await tp(S, cab[0], cab[1], { light: 0, stance: 0 });
      await sleep(300);
    }
    const ix4 = await S.dbg<{ doors: Record<number, { open?: boolean }> }>('interaction.state');
    check('4: the door is open', !!ix4.doors[q.door.id]?.open, ix.doors[q.door.id]?.open ? 'still open from 3' : 'opened by hand');
    await placeAt(q, 'search', qa[0], qa[1]);
    await sleep(200);
    const h4 = { ...health };
    const t4 = performance.now();
    await noiseAt(q);
    const w4 = await watch(q, t4, 10_000, -BACK_M);
    const inv4 = w4.s.filter((s) => s.state === 'investigate');
    const before4 = w4.s.filter((s) => w4.patrolAt < 0 || s.t < w4.patrolAt);
    const deepest4 = Math.min(...before4.map((s) => offLine(q, s.x, s.z)));
    const doors4 = doorEvents(q.door.id, t4);
    console.log(`  4: ${fmtSeq(w4.s)}; goal ${inv4[0]?.goal?.join(',') ?? '-'}; at the goal at ${r2(w4.reachAt)} s, deepest ${r2(-deepest4)} m past the line`);
    check('4: the server keeps answering', w4.noReply === 0 && health.fail === h4.fail, `${health.n - h4.n} probes, ${health.fail - h4.fail} failed; ${w4.noReply} unanswered polls`);
    check(`4: through the open door: its goal is ${BACK_M} m past the door line, on the sound's side`,
      inv4.length > 0 && inv4.every((s) => throughGoal(q, s.goal)), inv4.length ? `off ${r2(offLine(q, inv4[0].goal![0], inv4[0].goal![1]))} m` : 'never investigated');
    check('4: it walks straight into the doorway (no door pause, no door event) and stands there, no further in',
      w4.reachAt >= 0 && w4.reachAt < DOOR_PAUSE && doors4.length === 0 && deepest4 >= -(BACK_M + 0.15),
      `at the goal at ${r2(w4.reachAt)} s, ${doors4.length} door events, deepest ${r2(-deepest4)} m past the line`);
    check('4: it searches there, then moves on (patrol)', w4.patrolAt >= 0 && w4.s.some((s) => s.state === 'search' && s.t >= w4.reachAt - 0.2),
      w4.patrolAt >= 0 ? `patrol at ${r2(w4.patrolAt)} s` : `still ${w4.s[w4.s.length - 1]?.state}`);
  }

  check('the server answered every /healthz probe', health.n >= 20 && health.fail === 0, `${health.n} probes, ${health.fail} failed, slowest ${Math.round(health.maxMs)} ms`);
  const errs = serverErrors(srv.log());
  check('no server errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  probing = false;
  await prober;
  S.close();
  await srv.stop();
}
process.exitCode = summary('Listener doorways + freeze regression');
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
