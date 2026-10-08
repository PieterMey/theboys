// Owner: track (c) Monsters (v1.2 G2). The Listener's 'warn first' after the 2026-10-08 solo playtest findings (ws bots on
// its own dev server, no browser, no AI; geometry searched per layout):
//  1. losing you ends your warning: it notices you at 5 m and you vanish before the notice ends (it goes to investigate
//     where it saw you); 8 s after the notice it touches you from behind: it recoils and notices you again (a fresh tell),
//     no silent knockdown (before: warned 8 s ago = fair game for warnValidSec 15 s)
//  2. a door slammed in its face that drops its target ends that target's warning
//  3. the end of a stalk (following at a distance, then 10 s without a trace of them) ends the warning
//  4. warnGraceSec = noticeSec: out of a vent 1 m from a lone player (wall behind the grate, so no room to recoil), its
//     knockdown comes no earlier than noticeSec after the notice (with warnGraceSec 1.0 it came after 1.0 s)
//   node tests/monsters/listener-warn.e2e.ts         (own dev server on PORT, default 3802)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellOf, floodCells, los, walkClear } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { Bot, REPO, sleep, startServer, waitFor } from './bot.ts';
import { cabSpot, check, contract, cueEvents, findDoor, findLine, freeOfSolids, grabEvents, lis, park, placeListener, r2, serverErrors, summary, tp, untilL, worldOf } from './fairlib.ts';
import type { Ag, World } from './fairlib.ts';

const PORT = Number(process.env.PORT ?? 3802);
const LB = (JSON.parse(readFileSync(join(REPO, 'config/balance/monsters.json'), 'utf8')) as { listener: Record<string, number> }).listener;
const NOTICE_MS = (LB.noticeSec ?? 1.2) * 1000;
const KNOCK_MS = (LB.knockdownSec ?? 2) * 1000;
const VENT_SEEDS = ['ls-solo-4', 'g2-fair-solo', 'g2-vent-1', 'g2-vent-2', 'g2-vent-3'];

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann'), B = new Bot('Bob'), C = new Bot('Cid');

const dist = (a: { x: number; z: number }, p: readonly number[]) => Math.hypot(a.x - p[0], a.z - p[1]);
const warnedOf = (l: Ag | null, pid: string) => l?.warned?.[pid];
const isWalk = (w: World, x: number, z: number) => {
  const c = cellOf(w.g, x, z);
  if (c < 0 || w.g.owner[c] < 0) return false;
  const sp = w.L.spaces[w.g.owner[c]];
  return !!sp && sp.kind !== 'outside' && sp.type !== 'van' && sp.callsign !== 'VAN';
};

/** wait for the spotted tell to `b` (since t0), then for the hunt */
async function huntStarts(b: Bot, t0: number): Promise<Ag | null> {
  const sp = await waitFor(() => b.eventsOf('monsters.spotted', t0)[0], 1600, 'spotted').catch(() => null);
  if (!sp) return null;
  return untilL(b, (l) => l.state === 'hunt', 2600, 'hunt', 15);
}

/** the Listener walking from L0 (next to an entry grate) to the centre of `space` takes a vent (the direct walk is >= 18 m
 *  or impossible and the duct saves >= 8 m: geo ventRoute's rule) */
function findVentTrip(w: World): { entry: string; exit: string; L0: [number, number]; space: number; via: number } | null {
  const canOpen = (id: number) => { const d = w.L.doors.find((q) => q.id === id); return !!d && (d.kind === 'door' || d.kind === 'fire'); };
  const field = (x: number, z: number) => floodCells(w.g, [cellOf(w.g, x, z)], { mode: 'walk', doorOpen: w.open, canOpen, budget: 260 });
  let best: { entry: string; exit: string; L0: [number, number]; space: number; via: number } | null = null;
  for (const v of w.L.items) {
    const to = (v.data as { to?: unknown } | undefined)?.to;
    if (v.kind !== 'vent' || typeof to !== 'string') continue;
    const pr = w.L.items.find((i) => i.id === to);
    if (!pr) continue;
    const fv = field(v.x, v.z);
    let L0: [number, number] | null = null, area = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      const x = v.x + dx, z = v.z + dz;
      if (!isWalk(w, x, z) || !freeOfSolids(w, x, z, 0.4) || !(fv[cellOf(w.g, x, z)] <= 1.6)) continue;
      let n = 0;
      for (const q of field(x, z)) if (q <= 12) n++;
      if (n > area) { area = n; L0 = [x, z]; }
    }
    if (!L0) continue;
    const space = w.g.owner[cellOf(w.g, pr.x, pr.z)];
    const sp = w.L.spaces[space];
    if (!sp || sp.kind === 'outside') continue;
    const cx = sp.rect.x + sp.rect.w / 2, cz = sp.rect.y + sp.rect.h / 2;
    if (w.g.owner[cellOf(w.g, cx, cz)] !== space) continue;
    const fL = field(L0[0], L0[1]), fG = field(cx, cz);
    const direct = fL[cellOf(w.g, cx, cz)];
    const travel = Math.min(7, Math.max(2, Math.hypot(v.x - pr.x, v.z - pr.z) / 3)) * 4;
    const via = fL[cellOf(w.g, v.x, v.z)] + travel + fG[cellOf(w.g, pr.x, pr.z)];
    if (!(direct >= 18) || !(via < direct - 8) || !Number.isFinite(via)) continue;
    if (!best || via < best.via) best = { entry: v.id, exit: pr.id, L0, space, via };
  }
  return best;
}

/** a free spot 1 m from where it comes out of the duct; first choice: the recoil (away from that spot) hits a wall */
function exitSpot(w: World, x: number, z: number): { p: [number, number]; blocked: boolean } | null {
  let fallback: { p: [number, number]; blocked: boolean } | null = null;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const p: [number, number] = [x + dx, z + dz];
    if (!isWalk(w, p[0], p[1]) || !freeOfSolids(w, p[0], p[1], 0.35) || !los(w.g, x, z, p[0], p[1], w.open) || !walkClear(w.g, x, z, p[0], p[1], w.open)) continue;
    const blocked = !walkClear(w.g, x, z, x - dx * 0.3, z - dz * 0.3, w.open);
    if (blocked) return { p, blocked };
    fallback ??= { p, blocked };
  }
  return fallback;
}

let w!: World;
try {
  w = await contract(url, 'LWARN', [A, B], 'g2-warn-1', 2, 1);
  const cab = cabSpot(w);
  await tp(B, cab[0] + 0.6, cab[1]);
  await tp(A, cab[0], cab[1]);
  const ln = findLine(w, 7) ?? findLine(w, 6.6);
  check('found a 7 m sight line (notice at 5 m, touch at 6 m, room to recoil)', !!ln, ln ? `${ln.S} -> ${ln.P}` : '');
  if (!ln) throw new Error('no sight line');
  const at = (k: number): [number, number] => [ln.S[0] + ln.dir[0] * k, ln.S[1] + ln.dir[1] * k];
  const Q = at(5), T = at(6);
  const faceS = Math.atan2(-ln.dir[0], -ln.dir[1]); // Ann faces where the Listener stands
  const faceAway = Math.atan2(ln.dir[0], ln.dir[1]);

  // ---------------- 1. losing you ends your warning: the 8 s touch from behind ----------------
  await tp(A, Q[0], Q[1], { light: 1, stance: 0, yaw: faceS });
  await sleep(150);
  const t1 = performance.now();
  await placeListener(A, ln.S[0], ln.S[1], Q[0], Q[1]);
  const sp1 = await waitFor(() => A.eventsOf('monsters.spotted', t1)[0], 1600, 'spotted').catch(() => null);
  await tp(A, cab[0], cab[1], { light: 0 }); // gone (the sealed van cab: it neither sees nor hears her)
  const lost = sp1 ? await untilL(A, (l) => l.state !== 'notice', 2500, 'notice ends', 20) : null;
  check('1: noticed at 5 m, she vanishes before the notice ends: it investigates where it saw her, her warning is gone',
    !!sp1 && lost?.state === 'investigate' && warnedOf(lost, A.id) === undefined, `${lost?.state ?? '-'}, warned ${warnedOf(lost, A.id) ?? 'none'}`);
  await park(A);
  if (sp1) await sleep(Math.max(0, 8000 - (performance.now() - sp1.at)));
  await tp(A, Q[0], Q[1], { light: 0, stance: 0, yaw: faceS });
  await sleep(100);
  const wn1 = await A.dbg<{ warn: string }>('monsters.warn', { id: A.id });
  const t1b = performance.now();
  // 8 s after the notice it turns up 1 m behind her, facing away (no sight: only the touch)
  await A.dbg('monsters.place', { id: 'listener0', x: T[0], z: T[1], yaw: faceAway, state: 'patrol', active: true });
  await sleep(900);
  const l1 = await lis(A);
  const g1 = grabEvents(A, t1b), n1 = cueEvents(A, t1b, 'notice')[0], s1b = A.eventsOf('monsters.spotted', t1b)[0];
  check('1: 8 s after the notice, a touch from behind: no knockdown; it recoils and notices her again (a fresh tell)',
    !!sp1 && wn1.warn === 'no' && g1.length === 0 && !!n1 && !!s1b && dist(l1, Q) >= 1.25,
    `${sp1 ? r2((t1b - sp1.at) / 1000) : '-'} s after the notice: warn '${wn1.warn}', grabs ${g1.length}, notice ${!!n1}, spotted ${!!s1b}, now ${r2(dist(l1, Q))} m away (${l1.state})`);
  await park(A);
  await tp(A, cab[0], cab[1]);

  // ---------------- 2. a slammed door that drops the target ends its warning ----------------
  await A.dbg('monsters.forget', {});
  const dr = findDoor(w, 2.0, 1.6);
  check('2: found a hand door with room on both sides', !!dr, dr ? `door ${dr.door.id} (${dr.door.kind})` : '');
  if (dr) {
    await sleep(300);
    await tp(A, dr.B[0], dr.B[1], { light: 1, stance: 0 });
    const ix = await A.dbg<{ doors: Record<number, { open?: boolean }> }>('interaction.state');
    if (!ix.doors[dr.door.id]?.open) await A.req('interaction.use', { id: `door:${dr.door.id}` });
    await sleep(200);
    const t2 = performance.now();
    await placeListener(A, dr.A[0], dr.A[1], dr.B[0], dr.B[1]);
    const h2 = await huntStarts(A, t2);
    await A.dbg('monsters.freeze', { on: true });
    const before2 = warnedOf(await lis(A), A.id);
    const close = await A.req<{ ok: boolean; msg?: string }>('interaction.use', { id: `door:${dr.door.id}` });
    await A.dbg('monsters.freeze', { on: false });
    const st2 = await untilL(A, (l) => l.state === 'stun', 400, 'stun', 15);
    check('2: a door slammed in its face drops its target, and with it that target\'s warning',
      !!h2 && close.ok && !!st2 && before2 !== undefined && warnedOf(st2, A.id) === undefined && !grabEvents(A, t2).length,
      `hunt ${!!h2}, warned ${before2 ?? 'none'} s before the slam, close ${close.ok}${close.msg ? ` (${close.msg})` : ''}, stun ${!!st2}, warned after ${warnedOf(st2, A.id) ?? 'none'}`);
    await park(A);
    await tp(A, cab[0], cab[1]);
  }

  // ---------------- 3. the end of a stalk ends the warning ----------------
  await A.dbg('monsters.forget', {});
  await sleep(300);
  await tp(A, Q[0], Q[1], { light: 1, stance: 0, yaw: faceS });
  await sleep(150);
  const t3 = performance.now();
  await placeListener(A, ln.S[0], ln.S[1], Q[0], Q[1]);
  const sp3 = await waitFor(() => A.eventsOf('monsters.spotted', t3)[0], 1600, 'spotted').catch(() => null);
  await tp(B, T[0], T[1], { light: 0, stance: 0 }); // Bob joins her: not alone, so it follows at a distance instead
  const st3 = sp3 ? await untilL(A, (l) => l.state === 'stalk', 2500, 'stalk', 20) : null;
  const during3 = warnedOf(st3, A.id);
  await tp(A, cab[0], cab[1], { light: 0 });
  await tp(B, cab[0] + 0.6, cab[1], { light: 0 });
  const end3 = st3 ? await untilL(A, (l) => l.state !== 'stalk', 13_000, 'stalk ends', 100) : null;
  check('3: following at a distance keeps the warning; when the stalk ends (10 s without a trace) it is gone',
    !!st3 && during3 !== undefined && !!end3 && warnedOf(end3, A.id) === undefined,
    `stalk ${!!st3} (warned ${during3 ?? 'none'} s ago), then ${end3?.state ?? '-'} after ${r2((performance.now() - t3) / 1000)} s, warned ${warnedOf(end3, A.id) ?? 'none'}`);
  await park(A);

  // ---------------- 4. out of a vent 1 m away: no knockdown before noticeSec ----------------
  let wv = await contract(url, 'LVENT', [C], VENT_SEEDS[0], 1, 1);
  let trip = findVentTrip(wv), seed = VENT_SEEDS[0];
  for (const s of VENT_SEEDS.slice(1)) {
    if (trip) break;
    const t0 = performance.now();
    await C.dbg('monsters.start', { seed: s, players: 1, risk: 1 });
    const L = await waitFor(() => (C.eventsOf('phase', t0).pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 4000, 'layout');
    for (const id of ['hound0', 'hound1', 'mannequin0', 'snatcher0']) await C.dbg('monsters.place', { id, outSec: 9999 }).catch(() => null);
    await C.dbg('monsters.wake');
    await park(C);
    wv = worldOf(L);
    trip = findVentTrip(wv);
    seed = s;
  }
  check('4: found a vent the Listener takes (the walk is >= 18 m or impossible)', !!trip, trip ? `${seed}: ${trip.entry} -> ${trip.exit}, from ${trip.L0}` : '');
  if (trip) {
    const cabV = cabSpot(wv);
    await tp(C, cabV[0], cabV[1], { light: 0 });
    await C.dbg('monsters.place', { id: 'listener0', x: trip.L0[0], z: trip.L0[1], yaw: 0, state: 'search', active: true, holdSec: 60 });
    const t4 = performance.now();
    await C.dbg('monsters.intent', { action: 'investigate_room', space: trip.space, player: null });
    const ve = await waitFor(() => C.eventsOf('monsters.vent', t4)[0], 6000, 'vent').catch(() => null);
    const vd = ve?.d as { to: number[]; ms: number } | undefined;
    const spot = vd ? exitSpot(wv, vd.to[0], vd.to[2]) : null;
    if (vd && spot) await tp(C, spot.p[0], spot.p[1], { light: 1, stance: 0, yaw: Math.atan2(vd.to[0] - spot.p[0], vd.to[2] - spot.p[1]) });
    const sp4 = vd && spot ? await waitFor(() => C.eventsOf('monsters.spotted', t4)[0], vd.ms + 3000, 'spotted').catch(() => null) : null;
    const l4 = sp4 ? await lis(C) : null;
    const g4 = sp4 ? await waitFor(() => grabEvents(C, t4).find((e) => ['knockdown', 'start'].includes((e.d as { state: string }).state)), 4000, 'grab').catch(() => null) : null;
    const gd = g4?.d as { state: string; until: number } | undefined;
    // server ms from the crew clock (rt.serverMs): the notice's 'until' is notice + noticeSec, the knockdown's is + knockdownSec
    const noticeAt = sp4 ? (sp4.d as { until: number }).until - NOTICE_MS : NaN;
    const grabAt = gd ? gd.until - (gd.state === 'knockdown' ? KNOCK_MS : (LB.soloGrabSec ?? 6) * 1000) : NaN;
    const gap = grabAt - noticeAt;
    check(`4: out of the vent 1 m from her: noticed, and knocked down no earlier than noticeSec (${NOTICE_MS} ms) after the notice`,
      !!vd && !!spot && !!sp4 && !!gd && gap >= NOTICE_MS - 2,
      `${vd ? `duct ${vd.ms} ms` : 'no vent trip'}, spot ${spot ? `${spot.p} (${spot.blocked ? 'wall behind it: no room to recoil' : 'room to recoil'})` : '-'}, ${l4 ? `${r2(dist(l4, spot!.p))} m from her at the notice` : 'no notice'}, ${gd ? `${gd.state} ${Math.round(gap)} ms after the notice` : 'no grab'}`);
    await park(C);
  }

  const errs = serverErrors(srv.log());
  check('no server errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  for (const b of [A, B, C]) b.close();
  await srv.stop();
}
process.exitCode = summary('Listener warnings (v1.2 solo fixes)');
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
