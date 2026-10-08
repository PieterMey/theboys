// Owner: track (c) Monsters (v1.2 G2). Listener fairness with ws bots (modelled on hound-fair; no browser, no AI):
//  - the 'notice' cue (and the victim-only 'monsters.spotted') comes >= noticeSec before any grab; the first grab per
//    player only knocks down (no death)
//  - a later grab can be escaped by struggling (5 presses/s); a solo crew's bot always escapes (3 presses/s)
//  - an unwarned touch from behind never grabs (it recoils and notices)
//  - a sprinter starting 6 m away (0.8 s reaction) gains distance; hunt speed 4.6 m/s
//  - a buddy within grabAloneM turns the hunt into a stalk
//  - a slammed door, a locker, a flare and a crowbar each break the hunt
//  - with listenerFairV12 off: the v1.1 behaviour (instant hunt + click, touch = grab, no knockdown, lunge 5.0 / 2.5)
//   node tests/monsters/listener-fair.e2e.ts         (own dev server on PORT, default 3802)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { astar } from '../../packages/shared/src/nav/index.ts';
import { Bot, REPO, sleep, startServer, waitFor } from './bot.ts';
import { cabSpot, check, contract, cueEvents, findDoor, findLine, findLocker, findRun, grabEvents, lis, park, placeListener, r1, r2, serverErrors, summary, tp, untilL } from './fairlib.ts';
import type { Ag, World } from './fairlib.ts';

const PORT = Number(process.env.PORT ?? 3802);
const BAL = JSON.parse(readFileSync(join(REPO, 'config/balance/monsters.json'), 'utf8')) as { listener: Record<string, number | boolean> };
const LB = BAL.listener as Record<string, number>;
const NOTICE_MS = Number(LB.noticeSec ?? 1.2) * 1000;

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann'), B = new Bot('Bob'), S1 = new Bot('Sol');

const dist = (a: { x: number; z: number }, x: number, z: number) => Math.hypot(a.x - x, a.z - z);

/** wait for the spotted tell to `b` (since t0), then for the hunt; returns the Listener at hunt start */
async function huntStarts(b: Bot, t0: number): Promise<{ spotAt: number; L: Ag } | null> {
  const sp = await waitFor(() => b.eventsOf('monsters.spotted', t0)[0], 1600, 'spotted').catch(() => null);
  if (!sp) return null;
  const L = await untilL(b, (l) => l.state === 'hunt', 2600, 'hunt', 15);
  return L ? { spotAt: sp.at, L } : null;
}

/** mash 'monsters.struggle' at `hz` presses/s until escaped (or ms); returns ms to escape or null */
async function mash(b: Bot, hz: number, ms: number): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const r = await b.req<{ ok: boolean; struggle: number; escaped?: boolean }>('monsters.struggle', {}).catch(() => null);
    if (r?.escaped) return performance.now() - t0;
    await sleep(1000 / hz);
  }
  return null;
}

/** give `b` an item and make it the active slot */
async function hold(b: Bot, type: string): Promise<boolean> {
  const it = await b.dbg<{ id: string } | null>('interaction.give', { type, pid: b.id });
  if (!it) return false;
  const st = await b.dbg<{ inventories: Record<string, (string | null)[]> }>('interaction.state');
  const slot = (st.inventories[b.id] ?? []).indexOf(it.id);
  if (slot < 0) return false;
  await b.req('interaction.slot', { slot });
  return true;
}

let w!: World;
try {
  w = await contract(url, 'LFAIR', [A, B], 'g2-fair-1', 2, 1);
  const cab = cabSpot(w);
  await tp(B, cab[0], cab[1]);
  const line = findLine(w, 4.5);
  if (!line) throw new Error('no 4.5 m sight line');
  const [Px, Pz] = line.P, [Sx, Sz] = line.S;
  const faceAway = Math.atan2(line.dir[0], line.dir[1]); // P looks away from S

  // ---------------- 1. notice >= noticeSec before the grab; the first grab only knocks down ----------------
  await tp(A, Px, Pz, { light: 1, stance: 0, yaw: faceAway });
  await sleep(100);
  const t1 = performance.now();
  await placeListener(A, Sx, Sz, Px, Pz);
  const notice = await waitFor(() => cueEvents(A, t1, 'notice')[0], 1500, 'notice cue').catch(() => null);
  const spotted = A.eventsOf('monsters.spotted', t1)[0];
  const g1 = await waitFor(() => grabEvents(A, t1).find((e) => ['knockdown', 'start'].includes((e.d as { state: string }).state)), 6000, 'first grab').catch(() => null);
  const gap1 = notice && g1 ? g1.at - notice.at : -1;
  check('notice cue + victim-only monsters.spotted when it first sees a lone player', !!notice && !!spotted && B.eventsOf('monsters.spotted', t1).length === 0, `cue radius ${(notice?.d as { radius?: number } | undefined)?.radius}`);
  check(`the notice comes >= noticeSec (${NOTICE_MS} ms) before any grab`, !!g1 && gap1 >= NOTICE_MS - 40, `${Math.round(gap1)} ms`);
  const g1d = g1?.d as { state: string; victim: string; until: number; lightOffMs?: number } | undefined;
  check('the first grab of the contract only KNOCKS DOWN (frozen, flashlight off), no grab hold', g1d?.state === 'knockdown' && g1d.victim === A.id && (g1d.lightOffMs ?? 0) > 0, `${g1d?.state} light off ${g1d?.lightOffMs} ms`);
  await sleep(2400);
  const alive1 = !A.eventsOf('monsters.kill', t1).length;
  const lk = await lis(A);
  check('knocked-down player survives; the Listener retreats', alive1 && (lk.state === 'out' || lk.state === 'knock'), lk.state);

  // ---------------- 2. a later grab: struggling free at 5 presses/s ----------------
  const t2 = performance.now();
  await A.dbg('monsters.place', { id: 'listener0', x: Px + line.dir[0] * 0.9, z: Pz + line.dir[1] * 0.9, yaw: faceAway + Math.PI, state: 'ambush', active: true });
  const g2 = await waitFor(() => grabEvents(A, t2, 'start')[0], 1500, 'second grab').catch(() => null);
  const g2d = g2?.d as { until: number; step?: number; decay?: number; solo?: boolean; room?: string | null } | undefined;
  check('second grab (warned player): a real grab with a struggle meter', !!g2d && typeof g2d.step === 'number' && g2d.solo === false, g2d ? `step ${g2d.step} decay ${g2d.decay} room ${g2d.room}` : 'none');
  const esc2 = g2 ? await mash(A, 5, 5200) : null;
  const e2 = grabEvents(A, t2, 'escaped')[0];
  check('mashing E at 5/s frees the victim before the timer (no death)', esc2 !== null && !!e2 && !A.eventsOf('monsters.kill', t2).length, esc2 !== null ? `${Math.round(esc2)} ms` : 'not escaped');
  const ls2 = await untilL(A, (l) => l.state === 'stagger', 400, 'stagger after escape');
  check('after the escape it staggers, then retreats', !!ls2 && !!(await untilL(A, (l) => l.state === 'out', 4500, 'out after stagger')));

  // ---------------- 3. an unwarned touch from behind never grabs ----------------
  await tp(A, cab[0], cab[1]);
  await tp(B, Px, Pz, { light: 0, stance: 0, yaw: faceAway });
  await sleep(150);
  const t3 = performance.now();
  // right behind Bob (0.6 m), facing his back
  await A.dbg('monsters.place', { id: 'listener0', x: Px - line.dir[0] * 0.6, z: Pz - line.dir[1] * 0.6, yaw: faceAway, state: 'patrol', active: true });
  await sleep(900);
  const l3 = await lis(A);
  const g3 = grabEvents(B, t3);
  const n3 = cueEvents(B, t3, 'notice')[0];
  check('unwarned touch from behind: no grab; it recoils (~1 m) and notices instead', g3.length === 0 && !!n3 && dist(l3, Px, Pz) >= 1.3, `grabs ${g3.length}, notice ${!!n3}, now ${r2(dist(l3, Px, Pz))} m away (${l3.state})`);
  await park(A);
  await tp(B, cab[0], cab[1]);

  // ---------------- 4. a sprinter starting ~6 m away gains distance ----------------
  const run = findRun(w, 5.8, 26);
  check('found a run: 5.8 m sight line + >= 26 m open path away from it', !!run, run ? `${run.path.length / 10} m` : '');
  if (run) {
    const P0 = run.path[0];
    await sleep(600);
    await tp(A, P0[0], P0[1], { light: 1, stance: 0, yaw: Math.atan2(P0[0] - run.S[0], P0[1] - run.S[1]) });
    await sleep(100);
    const t4 = performance.now();
    await placeListener(A, run.S[0], run.S[1], P0[0], P0[1]);
    const sp4 = await waitFor(() => A.eventsOf('monsters.spotted', t4)[0], 1600, 'spotted (run)').catch(() => null);
    check('runner: spotted tell', !!sp4);
    if (sp4) {
      await sleep(Math.max(0, 800 - (performance.now() - sp4.at))); // a 0.8 s reaction
      const tRun = performance.now();
      let lastNoise = 0, lastSample = 0, sIdx = 0;
      const samples: { t: number; gap: number; state: string; speed: number; pounce: boolean }[] = [];
      while (performance.now() - tRun < 6500) {
        const el = (performance.now() - tRun) / 1000;
        // 5.5 m/s sprint with the ~83 ms acceleration lag (0.46 m)
        sIdx = Math.min(run.path.length - 1, Math.max(0, Math.round(((el - 0.083) * 5.5) / 0.1)));
        const [x, z] = run.path[sIdx];
        const nx = run.path[Math.min(run.path.length - 1, sIdx + 3)];
        await tp(A, x, z, { light: 1, stance: 2, yaw: Math.atan2(nx[0] - x, nx[1] - z) });
        if (performance.now() - lastNoise > 210) {
          lastNoise = performance.now();
          void A.dbg('monsters.noise', { x, z, radiusM: 12, kind: 'sprintStep', source: A.id });
        }
        if (performance.now() - lastSample > 240) {
          lastSample = performance.now();
          const l = await lis(A);
          const r = astar(w.g, l.x, l.z, x, z, { mode: 'walk', doorOpen: w.open, maxCost: 80 });
          samples.push({ t: el, gap: r ? r.cost : Math.hypot(l.x - x, l.z - z), state: l.state, speed: l.speed ?? 0, pounce: l.pouncing === true });
        }
        if (sIdx >= run.path.length - 1) break;
        await sleep(40);
      }
      const hunt = samples.filter((s) => s.state === 'hunt');
      const first = hunt[0], last = samples[samples.length - 1];
      console.log(`  run: ${samples.map((s) => `${r1(s.t)}s ${r1(s.gap)}m ${s.state}`).join(' | ')}`);
      check('runner: it hunts (after the notice)', hunt.length > 0, `${hunt.length} hunt samples`);
      check('runner: the sprinter GAINS distance (gap grows while hunted)', !!first && last.gap > first.gap + 1.2 && !grabEvents(A, t4).length, first ? `${r1(first.gap)} m at hunt start -> ${r1(last.gap)} m at ${r1(last.t)} s` : 'no hunt');
      const hs = hunt.filter((s) => !s.pounce && s.speed > 0).map((s) => s.speed);
      check('hunt speed 4.6 m/s (between walk 3.0 and sprint 5.5)', hs.length > 0 && hs.every((v) => Math.abs(v - Number(LB.huntSpeed ?? 4.6)) < 0.05), hs.slice(0, 4).join(', '));
    }
    await park(A);
  }

  // ---------------- 5. a buddy within grabAloneM turns the hunt into a stalk ----------------
  await sleep(3200);
  await tp(A, Px, Pz, { light: 1, stance: 0, yaw: faceAway });
  await sleep(100);
  const t5 = performance.now();
  await placeListener(A, Sx, Sz, Px, Pz);
  const h5 = await huntStarts(A, t5);
  if (h5) await tp(B, Px + line.dir[0] * 1.2, Pz + line.dir[1] * 1.2, { light: 0 });
  const st5 = h5 ? await untilL(A, (l) => l.state === 'stalk', 600, 'stalk', 15) : null;
  await sleep(1500);
  check('a buddy arriving within grabAloneM turns the hunt into a stalk (no grab)', !!h5 && !!st5 && !grabEvents(A, t5).length, `${h5 ? 'hunted' : 'no hunt'} -> ${st5?.state ?? (await lis(A)).state}`);
  await park(A);
  await tp(B, cab[0], cab[1]);

  // ---------------- 6. a door slammed in its face ----------------
  const dr = findDoor(w, 2.0, 1.6);
  check('found a hand door with room on both sides', !!dr, dr ? `door ${dr.door.id} (${dr.door.kind})` : '');
  if (dr) {
    await sleep(3200);
    await tp(A, dr.B[0], dr.B[1], { light: 1, stance: 0 });
    const ix = await A.dbg<{ doors: Record<number, { open?: boolean }> }>('interaction.state');
    if (!ix.doors[dr.door.id]?.open) await A.req('interaction.use', { id: `door:${dr.door.id}` });
    const ix2 = await A.dbg<{ doors: Record<number, { open?: boolean }> }>('interaction.state');
    await sleep(200);
    const t6 = performance.now();
    await placeListener(A, dr.A[0], dr.A[1], dr.B[0], dr.B[1]);
    const h6 = await huntStarts(A, t6);
    await A.dbg('monsters.freeze', { on: true });
    const lAt = await lis(A);
    const close = await A.req<{ ok: boolean; msg?: string }>('interaction.use', { id: `door:${dr.door.id}` });
    await A.dbg('monsters.freeze', { on: false });
    const st6 = await untilL(A, (l) => l.state === 'stun', 300, 'stun', 15);
    await sleep(1700);
    const after6 = await lis(A);
    check('a door slammed by the player within 2 m in front of it: stunned, target dropped, hunt broken',
      !!h6 && close.ok && !!st6 && after6.state !== 'hunt' && !grabEvents(A, t6).length,
      `open ${!!ix2.doors[dr.door.id]?.open}, hunt ${!!h6}, ${r2(dist(lAt, dr.c[0], dr.c[1]))} m from the door, close ${close.ok}${close.msg ? ` (${close.msg})` : ''}, stun ${!!st6}, then ${after6.state}`);
    await park(A);
  }

  // ---------------- 7. a locker ----------------
  const lkr = findLocker(w, 4.5);
  check('found a locker with a 4.5 m sight line to its front', !!lkr, lkr?.id ?? '');
  if (lkr) {
    await sleep(3200);
    await tp(A, lkr.P[0], lkr.P[1], { light: 1, stance: 0 });
    await sleep(100);
    const t7 = performance.now();
    await placeListener(A, lkr.S[0], lkr.S[1], lkr.P[0], lkr.P[1]);
    const h7 = await huntStarts(A, t7);
    const hid = await A.req<{ ok: boolean; msg?: string }>('interaction.use', { id: lkr.id });
    const off7 = await untilL(A, (l) => l.state !== 'hunt', 1500, 'hunt ends (locker)');
    await sleep(2500);
    const ix7 = await A.dbg<{ hidden: Record<string, string> }>('interaction.state');
    check('hiding in a locker breaks the hunt (no grab, still hidden)', !!h7 && hid.ok && !!off7 && !grabEvents(A, t7).length && ix7.hidden[A.id] === lkr.id,
      `hunt ${!!h7}, hide ${hid.ok}${hid.msg ? ` (${hid.msg})` : ''}, then ${off7?.state}`);
    await A.req('interaction.use', { id: lkr.id }).catch(() => null); // out again
    await park(A);
  }

  // ---------------- 8. a flare ----------------
  const R = Number(LB.flareRepelM ?? 3);
  const lineF = findLine(w, 5.5, { skip: 2 }) ?? line;
  const hasFlare = await hold(A, 'flare');
  check('the player holds a flare', hasFlare);
  if (hasFlare) {
    await sleep(3200);
    const [fx, fz] = [lineF.S[0] + lineF.dir[0] * Math.min(5.5, Math.hypot(lineF.P[0] - lineF.S[0], lineF.P[1] - lineF.S[1])), lineF.S[1] + lineF.dir[1] * Math.min(5.5, Math.hypot(lineF.P[0] - lineF.S[0], lineF.P[1] - lineF.S[1]))];
    await tp(A, fx, fz, { light: 1, stance: 0 });
    await sleep(100);
    const t8 = performance.now();
    await placeListener(A, lineF.S[0], lineF.S[1], fx, fz);
    const h8 = await huntStarts(A, t8);
    const thr = await A.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, -1, 0], eye: [fx, 1.5, fz] });
    const fl = await waitFor(async () => {
      const s = await A.dbg<{ flares?: Record<string, { p: number[] }> }>('interaction.state');
      return Object.values(s.flares ?? {})[0] ?? null;
    }, 1500, 'flare burning').catch(() => null);
    const st8 = await untilL(A, (l) => l.state === 'stalk', 900, 'stalk (flare)', 15);
    let minD = Infinity;
    const tw = performance.now();
    while (performance.now() - tw < 3000) {
      const l = await lis(A);
      if (fl) minD = Math.min(minD, Math.hypot(l.x - fl.p[0], l.z - fl.p[2]));
      await sleep(60);
    }
    check('a burning flare between it and the target ends the hunt (it stalks), never within flareRepelM, no grab',
      !!h8 && thr.ok && !!fl && !!st8 && minD >= R - 0.15 && !grabEvents(A, t8).length,
      `hunt ${!!h8}, throw ${thr.ok}, flare ${!!fl}, stalk ${!!st8}, closest ${r2(minD)} m (repel ${R} m)`);
    await park(A);
  }

  // ---------------- 9. a crowbar hit ----------------
  const hasBar = await hold(A, 'crowbar');
  check('the player holds a crowbar', hasBar);
  if (hasBar) {
    await sleep(3200);
    // pounce off for this one (the crowbar window is what is tested), restored right after
    await A.dbg('monsters.tune', { section: 'listener', set: { pounceRangeM: 0 } });
    const [bx, bz] = [Sx + line.dir[0] * 3.6, Sz + line.dir[1] * 3.6];
    await tp(A, bx, bz, { light: 1, stance: 0, yaw: Math.atan2(Sx - bx, Sz - bz) });
    await sleep(100);
    const t9 = performance.now();
    await placeListener(A, Sx, Sz, bx, bz);
    const h9 = await huntStarts(A, t9);
    const near9 = h9 ? await untilL(A, (l) => dist(l, bx, bz) <= 2.3, 1500, 'within crowbar reach', 10) : null;
    await A.dbg('monsters.freeze', { on: true });
    const lz = await lis(A);
    const sw = await A.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [(lz.x - bx) / Math.max(0.01, dist(lz, bx, bz)), 0, (lz.z - bz) / Math.max(0.01, dist(lz, bx, bz))], eye: [bx, 1.6, bz] });
    const stg = await lis(A);
    await A.dbg('monsters.freeze', { on: false });
    await A.dbg('monsters.tune', { section: 'listener', set: { pounceRangeM: Number(LB.pounceRangeM ?? 2.2) } });
    const out9 = await untilL(A, (l) => l.state === 'out', Number(LB.staggerSec ?? 2) * 1000 + 1500, 'retreat after the stagger');
    check('a crowbar hit during the hunt staggers it, then it retreats (no grab)',
      !!h9 && !!near9 && sw.ok && sw.msg === 'Hit!' && stg.state === 'stagger' && !!out9 && !grabEvents(A, t9).length,
      `hunt ${!!h9}, ${r2(dist(lz, bx, bz))} m, swing ${sw.msg ?? sw.ok}, ${stg.state} -> ${out9?.state}`);
    await park(A);
  }

  // ---------------- 10. flag off: the v1.1 Listener (hotfix balance) ----------------
  check('flag-off balance unchanged: lungeSpeed 5.0 / lungeRangeM 2.5 (v1.2 uses pounce*)', LB.lungeSpeed === 5 && LB.lungeRangeM === 2.5 && LB.pounceSpeed === 7 && LB.pounceRangeM === 2.2, `${LB.lungeSpeed}/${LB.lungeRangeM}`);
  await A.dbg('monsters.flag', { name: 'listenerFairV12', on: false });
  await sleep(500);
  await tp(A, Px, Pz, { light: 1, stance: 0, yaw: faceAway });
  await tp(B, Px + line.dir[0] * 7.5, Pz + line.dir[1] * 7.5, { light: 0 });
  await sleep(100);
  const t10 = performance.now();
  await placeListener(A, Sx, Sz, Px, Pz);
  const h10 = await untilL(A, (l) => l.state === 'hunt', 400, 'v1.1 instant hunt', 10);
  const h10ms = Math.round(performance.now() - t10);
  const click10 = cueEvents(A, t10, 'click').length > 0;
  let lungeV = 0;
  const g10 = await waitFor(async () => {
    const l = await lis(A);
    if (dist(l, Px, Pz) <= 2.5 && l.state === 'hunt' && (l.speed ?? 0) > 0) lungeV = l.speed ?? 0;
    return grabEvents(A, t10).find((e) => (e.d as { state: string }).state === 'start') ?? null;
  }, 3000, 'v1.1 grab').catch(() => null);
  check('flag off: instant hunt on sight with the click (no notice, no spotted)', !!h10 && click10 && !cueEvents(A, t10, 'notice').length && !A.eventsOf('monsters.spotted', t10).length, `${h10?.state ?? 'no hunt'} within ${h10ms} ms`);
  check('flag off: lunge at 5.0 m/s within 2.5 m, touch = immediate grab (no knockdown)', !!g10 && !grabEvents(A, t10, 'knockdown').length && Math.abs(lungeV - 5) < 0.05, `lunge ${lungeV}, grab ${!!g10}`);
  if (g10) {
    await tp(B, Px + line.dir[0] * 1.0, Pz + line.dir[1] * 1.0);
    const sh = await B.req<{ ok: boolean; freed: boolean }>('monsters.shove', { kind: 'shove' });
    check('flag off: a teammate shove still frees the victim', sh.freed && !A.eventsOf('monsters.kill', t10).length);
  }
  await A.dbg('monsters.flag', { name: 'listenerFairV12', on: true });
  await park(A);

  // ---------------- 11. a solo crew always struggles free ----------------
  const ws = await contract(url, 'LSOLO', [S1], 'g2-fair-solo', 1, 1);
  const ls = findLine(ws, 4.5);
  if (!ls) throw new Error('solo: no sight line');
  await tp(S1, ls.P[0], ls.P[1], { light: 1, stance: 0, yaw: Math.atan2(ls.dir[0], ls.dir[1]) });
  await sleep(100);
  const t11 = performance.now();
  await placeListener(S1, ls.S[0], ls.S[1], ls.P[0], ls.P[1]);
  const k11 = await waitFor(() => grabEvents(S1, t11, 'knockdown')[0], 6000, 'solo knockdown').catch(() => null);
  check('solo: the first grab is a knockdown', !!k11);
  await sleep(2400);
  const t11b = performance.now();
  await S1.dbg('monsters.place', { id: 'listener0', x: ls.P[0] + ls.dir[0] * 0.9, z: ls.P[1] + ls.dir[1] * 0.9, yaw: Math.atan2(-ls.dir[0], -ls.dir[1]), state: 'ambush', active: true });
  const g11 = await waitFor(() => grabEvents(S1, t11b, 'start')[0], 1500, 'solo grab').catch(() => null);
  const g11d = g11?.d as { solo?: boolean; until: number; step?: number; decay?: number } | undefined;
  const esc11 = g11 ? await mash(S1, 3, 6500) : null;
  check('solo: soloGrabSec + solo struggle step: mashing at only 3/s still escapes before the timer', !!g11d?.solo && esc11 !== null && !S1.eventsOf('monsters.kill', t11b).length,
    g11d ? `solo ${g11d.solo}, step ${g11d.step}, decay ${g11d.decay}, escaped after ${esc11 !== null ? Math.round(esc11) : '-'} ms` : 'no grab');

  const errs = serverErrors(srv.log());
  check('no server errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  for (const b of [A, B, S1]) b.close();
  await srv.stop();
}
process.exitCode = summary('Listener fairness (v1.2)');
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
