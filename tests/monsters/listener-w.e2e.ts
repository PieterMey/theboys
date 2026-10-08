// Owner: track (c) Monsters (v1.2 G2). The reader map's Listener worst cases W1-W7 re-measured on the live server
// (ws bots, flag listenerFairV12 on). Prints the escape-timing table for the report and asserts that none of them is
// certain death any more:
//  W1 lit, the player freezes (6 m sight, so 5.8 m; at 8 m it does not see you at all)
//  W2 lit, 5.8 m, 0.8 s reaction, sprint       W3 the escape window: later reactions
//  W4 dark (3 m sight): freeze / react + sprint W5 ambush beside a door: stepping through the doorway
//  W6 brushing past it from behind (unwarned)  W7 solo: knockdown, then a struggle-able grab
//   node tests/monsters/listener-w.e2e.ts       (own dev server on PORT, default 3802)
import { Bot, sleep, startServer, waitFor } from './bot.ts';
import { cabSpot, check, contract, findLine, findRun, freeOfSolids, grabEvents, lis, park, placeListener, r1, serverErrors, summary, tp } from './fairlib.ts';
import type { World } from './fairlib.ts';

const PORT = Number(process.env.PORT ?? 3802);
const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann'), B = new Bot('Bob'), S1 = new Bot('Sol');
const rows: string[][] = [];
const row = (...c: string[]) => { rows.push(c); };
const s = (ms: number | null | undefined) => (ms === null || ms === undefined ? '-' : `${r1(ms / 1000)} s`);

interface Trial { seen: boolean; noticeToGrab: number | null; grab: string | null; huntGap: number | null; endGap: number | null; endT: number }

/** mash E at hz until escaped; true if escaped */
async function escape(b: Bot, hz = 8, ms = 7000): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const r = await b.req<{ escaped?: boolean }>('monsters.struggle', {}).catch(() => null);
    if (r?.escaped) return performance.now() - t0;
    await sleep(1000 / hz);
  }
  return null;
}

const runs = new Map<number, ReturnType<typeof findRun>>();
function runFor(w: World, gap: number) {
  if (!runs.has(gap)) runs.set(gap, findRun(w, gap, 24));
  return runs.get(gap)!;
}

/** one chase on a run: the player at `gap`, the Listener watching them; react (s after the 'spotted' tell, null =
 *  freeze) then move along the path at `speed` with footstep noise */
async function trial(b: Bot, w: World, o: { gap: number; lit: boolean; react: number | null; speed: number; step: 'sprintStep' | 'walkStep' | null; maxSec: number }): Promise<Trial | null> {
  const run = runFor(w, o.gap);
  if (!run) return null;
  await b.dbg('monsters.forget', { id: b.id });
  await b.dbg('interaction.setLights', { space: 'all', on: o.lit });
  await park(b);
  const P0 = run.path[0];
  await tp(b, P0[0], P0[1], { light: o.lit ? 1 : 0, stance: 0, yaw: Math.atan2(P0[0] - run.S[0], P0[1] - run.S[1]) });
  await sleep(200);
  const t0 = performance.now();
  await placeListener(b, run.S[0], run.S[1], P0[0], P0[1]);
  const sp = await waitFor(() => b.eventsOf('monsters.spotted', t0)[0], 2000, 'spotted').catch(() => null);
  if (!sp) { await park(b); return { seen: false, noticeToGrab: null, grab: null, huntGap: null, endGap: null, endT: 0 }; }
  let huntGap: number | null = null, endGap: number | null = null, endT = 0;
  const grabbed = () => grabEvents(b, t0).find((e) => ['knockdown', 'start'].includes((e.d as { state: string }).state));
  if (o.react === null) {
    await waitFor(() => grabbed(), o.maxSec * 1000, 'grab (frozen)').catch(() => null);
  } else {
    await sleep(Math.max(0, sp.at + o.react * 1000 - performance.now()));
    const tRun = performance.now();
    let lastNoise = 0, lastSample = 0;
    while (performance.now() - tRun < o.maxSec * 1000 && !grabbed()) {
      const el = (performance.now() - tRun) / 1000;
      const idx = Math.min(run.path.length - 1, Math.max(0, Math.round(((el - 0.083) * o.speed) / 0.1)));
      const [x, z] = run.path[idx];
      const nx = run.path[Math.min(run.path.length - 1, idx + 3)];
      await tp(b, x, z, { light: o.lit ? 1 : 0, stance: o.speed > 4 ? 2 : 0, yaw: Math.atan2(nx[0] - x, nx[1] - z) });
      if (o.step && performance.now() - lastNoise > (o.step === 'sprintStep' ? 210 : 260)) {
        lastNoise = performance.now();
        void b.dbg('monsters.noise', { x, z, radiusM: o.step === 'sprintStep' ? 12 : 5, kind: o.step, source: b.id });
      }
      if (performance.now() - lastSample > 200) {
        lastSample = performance.now();
        const l = await lis(b);
        const gap = Math.hypot(l.x - x, l.z - z);
        if (huntGap === null && l.state === 'hunt') huntGap = gap;
        endGap = gap;
        endT = el;
      }
      if (idx >= run.path.length - 1) break;
      await sleep(40);
    }
  }
  const g = grabbed();
  const st = g ? (g.d as { state: string }).state : null;
  if (st === 'start') await escape(b); // clean up a real grab
  await park(b);
  await b.dbg('interaction.setLights', { space: 'all', on: true });
  return { seen: true, noticeToGrab: g ? g.at - sp.at : null, grab: st, huntGap, endGap, endT };
}

try {
  const w = await contract(url, 'LWORST', [A, B], 'g2-fair-1', 2, 1);
  const cab = cabSpot(w);
  await tp(B, cab[0], cab[1], { light: 0 });

  // W1: lit, frozen
  const w1 = await trial(A, w, { gap: 5.8, lit: true, react: null, speed: 0, step: null, maxSec: 6 });
  row('W1', 'lit, 5.8 m, freezes', w1 ? `notice ${s(0)} -> grab ${s(w1.noticeToGrab)} after the tell: ${w1.grab ?? 'none'} (first grab = knockdown, no death)` : 'no run');
  check('W1: the first grab comes >= noticeSec after the tell and only knocks down', !!w1?.seen && (w1.noticeToGrab ?? 0) >= 1150 && w1.grab === 'knockdown', `${s(w1?.noticeToGrab)} ${w1?.grab}`);
  // W1 at the old 8 m
  const line8 = findLine(w, 8);
  if (line8) {
    await A.dbg('monsters.forget', { id: A.id });
    await tp(A, line8.P[0], line8.P[1], { light: 1, stance: 0 });
    await sleep(150);
    const t8 = performance.now();
    await placeListener(A, line8.S[0], line8.S[1], line8.P[0], line8.P[1]);
    await sleep(1800);
    const seen8 = A.eventsOf('monsters.spotted', t8).length > 0;
    await park(A);
    row('W1b', 'lit, 8 m (the map\'s case)', seen8 ? 'SEEN' : 'not seen (lit sight 6 m)');
    check('W1b: lit at 8 m it does not see you (6 m)', !seen8);
  }
  await sleep(500);
  // W2: lit, 5.8 m, 0.8 s reaction, sprint
  const w2 = await trial(A, w, { gap: 5.8, lit: true, react: 0.8, speed: 5.5, step: 'sprintStep', maxSec: 6 });
  row('W2', 'lit, 5.8 m, 0.8 s reaction, sprint', w2 ? (w2.grab ? `grabbed ${s(w2.noticeToGrab)} after the tell` : `ESCAPES: gap ${r1(w2.huntGap ?? 0)} m at hunt start -> ${r1(w2.endGap ?? 0)} m at ${r1(w2.endT)} s`) : 'no run');
  check('W2: a 0.8 s reaction + sprint escapes', !!w2 && !w2.grab && (w2.endGap ?? 0) > (w2.huntGap ?? 99), w2 ? `${r1(w2.huntGap ?? 0)} -> ${r1(w2.endGap ?? 0)} m` : '');
  // W3: later reactions
  for (const react of [1.4, 2.0, 2.6]) {
    await sleep(3200);
    const r = await trial(A, w, { gap: 5.8, lit: true, react, speed: 5.5, step: 'sprintStep', maxSec: 6 });
    row('W3', `lit, 5.8 m, ${react} s reaction, sprint`, r ? (r.grab ? `grabbed ${s(r.noticeToGrab)} after the tell (${r.grab})` : `ESCAPES: gap ${r1(r.huntGap ?? 0)} -> ${r1(r.endGap ?? 0)} m`) : 'no run');
    if (react === 1.4) check('W3: even a 1.4 s reaction (above human average) escapes', !!r && !r.grab, r?.grab ?? 'escaped');
  }
  // W4: dark, 3 m sight
  await sleep(3200);
  const w4a = await trial(A, w, { gap: 2.8, lit: false, react: null, speed: 0, step: null, maxSec: 6 });
  row('W4a', 'dark, 2.8 m, freezes', w4a ? (w4a.seen ? `grab ${s(w4a.noticeToGrab)} after the tell (${w4a.grab ?? 'none'})` : 'not seen') : 'no run');
  await sleep(3200);
  const w4b = await trial(A, w, { gap: 2.8, lit: false, react: 0.8, speed: 5.5, step: 'sprintStep', maxSec: 6 });
  row('W4b', 'dark, 2.8 m, 0.8 s reaction, sprint', w4b ? (w4b.seen ? (w4b.grab ? `grabbed ${s(w4b.noticeToGrab)} (${w4b.grab})` : `ESCAPES: gap ${r1(w4b.huntGap ?? 0)} -> ${r1(w4b.endGap ?? 0)} m`) : 'not seen') : 'no run');
  check('W4: in the dark at 2.8 m a 0.8 s reaction + sprint escapes', !!w4b && (!w4b.seen || !w4b.grab), w4b?.grab ?? 'escaped');
  check('W4: frozen in the dark: still >= noticeSec of warning', !w4a?.seen || (w4a.noticeToGrab ?? 9e9) >= 1150, s(w4a?.noticeToGrab));

  // W5: ambush beside a door: where it waits, and stepping out through that doorway
  const room = w.L.spaces.find((sp) => sp.kind === 'room' && sp.callsign && w.L.doors.some((d) => (d.a === sp.id || d.b === sp.id) && d.kind === 'door' && d.a >= 0 && d.b >= 0));
  if (room) {
    await A.dbg('monsters.forget', {});
    await tp(A, cab[0], cab[1]);
    const d = w.L.doors.find((q) => (q.a === room.id || q.b === room.id) && q.kind === 'door' && q.a >= 0 && q.b >= 0)!;
    const c: [number, number] = d.dir === 'v' ? [d.x, d.y + d.len / 2] : [d.x + d.len / 2, d.y];
    // stand it where it would ambush this room (beside its nearest entrance) and keep it there watching
    await A.dbg('monsters.place', { id: 'listener0', x: c[0] + (d.dir === 'v' ? 3 : 0.5), z: c[1] + (d.dir === 'h' ? 3 : 0.5), state: 'patrol', active: true });
    const probe = await A.dbg<{ p: [number, number] | null }>('monsters.ambushProbe', { space: room.id });
    const ap = probe.p;
    if (ap) {
      const doorAt = w.L.doors.filter((q) => (q.a === room.id || q.b === room.id) && q.kind !== 'blocked' && q.a >= 0 && q.b >= 0)
        .map((q) => ({ q, c: (q.dir === 'v' ? [q.x, q.y + q.len / 2] : [q.x + q.len / 2, q.y]) as [number, number] }))
        .sort((a, b) => Math.hypot(a.c[0] - ap[0], a.c[1] - ap[1]) - Math.hypot(b.c[0] - ap[0], b.c[1] - ap[1]))[0];
      const off = doorAt.q.dir === 'v' ? Math.abs(ap[1] - doorAt.c[1]) : Math.abs(ap[0] - doorAt.c[0]);
      // the player walks out of the room through that doorway, 2 m in, 2 m out, along the doorway line
      const n: [number, number] = doorAt.q.dir === 'v' ? [Math.sign(ap[0] - doorAt.c[0]) || 1, 0] : [0, Math.sign(ap[1] - doorAt.c[1]) || 1];
      const facing: [number, number] = doorAt.c; // it faces the room centre in ambush; facing the door is the worst case
      await placeListener(A, ap[0], ap[1], facing[0], facing[1]);
      let minD = Infinity;
      const t5 = performance.now();
      for (let k = -2; k <= 2.001; k += 0.15) {
        const x = doorAt.c[0] + n[0] * k, z = doorAt.c[1] + n[1] * k;
        if (!freeOfSolids(w, x, z, 0.2)) continue;
        await tp(A, x, z, { light: 0, yaw: Math.atan2(n[0], n[1]) });
        const l = await lis(A);
        minD = Math.min(minD, Math.hypot(l.x - x, l.z - z));
        await sleep(50); // 3 m/s
      }
      await sleep(300);
      const g5 = grabEvents(A, t5).filter((e) => ['start', 'knockdown'].includes((e.d as { state: string }).state));
      const n5 = A.eventsOf('monsters.spotted', t5)[0];
      await park(A);
      row('W5', 'ambush beside a door, walk out through it', `waits ${r1(off)} m off the doorway line; closest ${r1(minD)} m while stepping through; ${n5 ? `spotted (tell) at ${s(n5.at - t5)}` : 'not spotted'}; touch grabs: ${g5.length}`);
      check('W5: the ambush point is >= ambushMinOffsetM (2.5) from the doorway line; stepping through never touch-grabs', off >= 2.45 && g5.length === 0 && minD > 1.2, `${r1(off)} m, closest ${r1(minD)} m`);
    }
  }

  // W6: brushing past it from behind (unwarned)
  const line6 = findLine(w, 6, { skip: 3 });
  if (line6) {
    await sleep(3200);
    await A.dbg('monsters.forget', {});
    const [x0, z0] = line6.S;
    const dir = line6.dir;
    // it stands facing along the line; Ann walks up from behind it and brushes past at 0.8 m, then keeps walking
    await placeListener(A, x0, z0, x0 + dir[0] * 4, z0 + dir[1] * 4);
    const side: [number, number] = [-dir[1] * 0.8, dir[0] * 0.8];
    const t6 = performance.now();
    let lastNoise = 0;
    for (let k = -2; k <= 5.5; k += 0.15) {
      const x = x0 + dir[0] * k + side[0], z = z0 + dir[1] * k + side[1];
      await tp(A, x, z, { light: 0, stance: 0, yaw: Math.atan2(dir[0], dir[1]) });
      if (performance.now() - lastNoise > 260) { lastNoise = performance.now(); void A.dbg('monsters.noise', { x, z, radiusM: 5, kind: 'walkStep', source: A.id }); }
      await sleep(50);
    }
    const n6 = A.eventsOf('monsters.spotted', t6)[0];
    const g6 = grabEvents(A, t6).find((e) => ['start', 'knockdown'].includes((e.d as { state: string }).state));
    await park(A);
    row('W6', 'brushing past it from behind (unwarned)', `${n6 ? `noticed: tell at ${s(n6.at - t6)}` : 'not noticed'}; ${g6 ? `grab ${s(g6.at - (n6?.at ?? t6))} after the tell (${(g6.d as { state: string }).state})` : 'no grab while walking past and away'}`);
    check('W6: brushing past from behind never grabs without the tell first (>= noticeSec)', !g6 || (!!n6 && g6.at - n6.at >= 1150), g6 ? s(g6.at - (n6?.at ?? t6)) : 'no grab');
  }

  // W7: solo
  const ws = await contract(url, 'LWSOLO', [S1], 'g2-fair-solo', 1, 1);
  const w7 = await trial(S1, ws, { gap: 4.5, lit: true, react: null, speed: 0, step: null, maxSec: 6 });
  await sleep(2400);
  const ls = findLine(ws, 3);
  let esc: number | null = null, death: number | null = null;
  if (ls) {
    await tp(S1, ls.P[0], ls.P[1], { light: 1, stance: 0 });
    const t7 = performance.now();
    await S1.dbg('monsters.grab', { id: S1.id, knockdown: false });
    esc = await escape(S1, 3, 7000);
    await sleep(3500);
    await S1.dbg('monsters.forget', {});
    const t7b = performance.now();
    const g7 = await S1.dbg<{ ok: boolean }>('monsters.grab', { id: S1.id, knockdown: false });
    if (!g7.ok) console.log('  (W7 second grab refused: Listener', (await lis(S1)).state, ')');
    const k = await waitFor(() => S1.eventsOf('monsters.kill', t7b)[0], 8000, 'solo death').catch(() => null);
    death = k ? k.at - t7b : null;
    void t7;
  }
  row('W7', 'solo crew', `first contact: ${w7?.grab ?? 'none'} (${s(w7?.noticeToGrab)} after the tell); later grabs: struggle at 3 presses/s frees you in ${s(esc)}; doing nothing: death after ${s(death)}`);
  check('W7: solo: the first contact only knocks down; a later grab is escaped at 3 presses/s', w7?.grab === 'knockdown' && esc !== null, `${w7?.grab}, ${s(esc)}`);

  console.log('\n| case | situation | v1.2 result (measured) |\n|---|---|---|');
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  const errs = serverErrors(srv.log());
  check('no server errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  for (const b of [A, B, S1]) b.close();
  await srv.stop();
}
process.exitCode = summary('Listener W1-W7');
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
