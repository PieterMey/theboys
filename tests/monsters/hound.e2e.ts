// Owner: track (c) Monsters. Gate G2b with ws bots (no browser): a shout within 25 m path of the Hound puts it on
// alert, then investigating the correct doorway, within 1 s; a whisper does not; a second noise -> charge -> kill;
// bottles override; the chained kennel hound in the hub: whisper ignored, talk -> alert/growl, shout -> lunge.
//   node tests/monsters/hound.e2e.ts            (starts its own dev server on PORT or 3013)
import { BAND, BAND_RADIUS_M } from '../../packages/shared/src/constants.ts';
import { EDGE, buildEdgeGrid, cellOf, edgeCode, edgeDoor, initialDoorOpen, soundFlood } from '../../packages/shared/src/nav/index.ts';
import type { EdgeGrid } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { Bot, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3013);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = '') => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};

interface AgentDump { id: string; kind: string; x: number; z: number; state: string; active: boolean; tx?: number; tz?: number; tdoor?: number; goal?: [number, number] }
interface StateDump { mode: string; agents: AgentDump[] }

/** independent re-statement of the rule: descend the sound field from the monster; first significant doorway */
function expectedDoor(L: LevelLayout, g: EdgeGrid, field: Float32Array, mx: number, mz: number): number {
  const W = g.W;
  const roomish = (s: number) => ['room', 'hall', 'vault'].includes(L.spaces[s]?.kind ?? '');
  let c = cellOf(g, mx, mz);
  for (let i = 0; i < 400 && field[c] > 0.01; i++) {
    const x = c % W, y = (c - x) / W;
    let best = -1, bd = field[c], door = -1;
    const D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let dir = 0; dir < 4; dir++) {
      const nx = x + D[dir][0], ny = y + D[dir][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= g.H || edgeCode(g, x, y, dir) === EDGE.wall) continue;
      const n = ny * W + nx;
      if (field[n] < bd - 1e-4) { best = n; bd = field[n]; door = edgeDoor(g, x, y, dir); }
    }
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= g.H) continue;
      const n = ny * W + nx;
      if (!(field[n] < bd - 1e-4)) continue;
      const ex = dx > 0 ? 0 : 1, ey = dy > 0 ? 2 : 3;
      if (edgeCode(g, x, y, ex) || edgeCode(g, x, y, ey) || edgeCode(g, x + dx, y, ey) || edgeCode(g, x, y + dy, ex)) continue;
      best = n; bd = field[n]; door = -1;
    }
    if (best < 0) return -1;
    if (door >= 0) {
      const d = L.doors.find((q) => q.id === door)!;
      if (d.kind !== 'open' || roomish(d.a) || roomish(d.b)) return door;
    }
    c = best;
  }
  return -1;
}

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const a = new Bot('Ann');
const b = new Bot('Bob');
try {
  await a.connect(url, 'HNDT');
  await b.connect(url, 'HNDT');
  const st0 = await a.dbg<{ ok: boolean; seed: string }>('monsters.start', { seed: 'g2b-hound', players: 2, risk: 1 });
  check('dbg.monsters.start starts a contract with a hound', st0.ok);
  const L = await waitFor(() => (a.eventsOf('phase').pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 3000, 'phase event with layout');
  const g = buildEdgeGrid(L);
  const doorOpen = initialDoorOpen(L);
  const dump = () => a.dbg<StateDump>('monsters.state');
  const hound = async () => (await dump()).agents.find((x) => x.id === 'hound0')!;
  // park bob far away (in the van cab = sealed) so he never interferes
  await b.dbg('monsters.tp', { x: L.van.cab.x + 1, z: L.van.cab.y + 1.5 });

  // ---------------- 1. shout through a doorway -> alert + correct doorway within 1 s ----------------
  const h0 = await hound();
  check('hound0 exists and is idle', !!h0 && h0.state === 'idle', `${h0?.state} at ${h0?.x},${h0?.z}`);
  // pick a source 10-22 m (sound path) away whose sound reaches the hound through a doorway
  const fromHound = soundFlood(g, h0.x, h0.z, BAND_RADIUS_M[BAND.shout], doorOpen);
  let src: [number, number] | null = null, want = -1;
  for (let c = 0; c < fromHound.length && !src; c++) {
    const d = fromHound[c];
    if (!(d >= 10 && d <= 22) || g.owner[c] < 0) continue;
    const sx = (c % g.W) + 0.5, sz = Math.floor(c / g.W) + 0.5;
    if (L.spaces[g.owner[c]]?.kind === 'outside') continue;
    const f = soundFlood(g, sx, sz, BAND_RADIUS_M[BAND.shout], doorOpen);
    const door = expectedDoor(L, g, f, h0.x, h0.z);
    if (door >= 0) { src = [sx, sz]; want = door; }
  }
  check('found a shout source 10-22 m away through a doorway', !!src, src ? `src ${src} door ${want}` : '');
  if (src) {
    await a.dbg('monsters.place', { id: 'hound0', x: h0.x, z: h0.z, state: 'idle' }); // stands still ~3 s
    await a.dbg('monsters.tp', { x: src[0], z: src[1] });
    const t0 = performance.now();
    a.loud(BAND.shout);
    const alert = await waitFor(async () => { const h = await hound(); return h.state === 'alert' ? h : null; }, 1500, 'hound alert').catch(() => null);
    const dt = performance.now() - t0;
    a.loud(BAND.silent);
    check('shout -> hound ALERT within 1 s', !!alert && dt <= 1000, `${Math.round(dt)} ms`);
    const door = L.doors.find((q) => q.id === want)!;
    const dc = door.dir === 'v' ? [door.x, door.y + door.len / 2] : [door.x + door.len / 2, door.y];
    const off = alert ? Math.hypot((alert.tx ?? 0) - dc[0], (alert.tz ?? 0) - dc[1]) : 99;
    check('perceives the correct doorway (door id)', alert?.tdoor === want, `got ${alert?.tdoor}, want ${want} (${door.kind})`);
    check('investigate target is at that doorway (< 1.2 m)', off < 1.2, `${off.toFixed(2)} m`);
    const growl = a.eventsOf('monsters.cue').find((e) => (e.d as { cue: string }).cue === 'growl' && e.at >= t0);
    check('growl cue emitted (audible 10 m)', !!growl && (growl.d as { radius: number }).radius === 10);
    const inv = await waitFor(async () => { const h = await hound(); return h.state === 'investigate' ? h : null; }, 2500, 'investigate').catch(() => null);
    check('then INVESTIGATE toward the doorway', !!inv && Math.hypot((inv.goal?.[0] ?? 0) - (alert?.tx ?? 0), (inv.goal?.[1] ?? 0) - (alert?.tz ?? 0)) < 0.5, inv ? `goal ${inv.goal}` : 'no');
    const snapM = a.monster('hound0');
    check('snapshot carries the hound (kind/state/active)', !!snapM && snapM.kind === 'hound' && snapM.active === true, snapM ? `${snapM.state} anim ${snapM.anim}` : 'missing');
  }

  // ---------------- 2. whisper (and crouch steps) are ignored ----------------
  {
    const h = await hound();
    // a free cell 2 m from the hound in its own space
    let near: [number, number] | null = null;
    const f = soundFlood(g, h.x, h.z, 3, doorOpen);
    for (let c = 0; c < f.length && !near; c++) if (f[c] >= 1.6 && f[c] <= 2.6) near = [(c % g.W) + 0.5, Math.floor(c / g.W) + 0.5];
    await a.dbg('monsters.place', { id: 'hound0', x: h.x, z: h.z, state: 'idle' });
    await sleep(100);
    await a.dbg('monsters.tp', { x: near![0], z: near![1] });
    const t0 = performance.now();
    a.loud(BAND.whisper);
    await a.dbg('monsters.noise', { x: near![0], z: near![1], radiusM: 1.5, kind: 'crouchStep' });
    await sleep(1600);
    a.loud(BAND.silent);
    const hw = await hound();
    const growls = a.eventsOf('monsters.cue', t0).filter((e) => (e.d as { cue: string }).cue === 'growl');
    check('whisper at 2 m + crouch step: hound stays calm', hw.state === 'idle' && growls.length === 0, `${hw.state}, ${growls.length} growls`);

    // ---------------- 3. talk -> alert; second noise within 6 s & 12 m -> wind-up -> charge -> kill ----------------
    let mid: [number, number] | null = null;
    const f6 = soundFlood(g, hw.x, hw.z, 10, doorOpen);
    for (let c = 0; c < f6.length && !mid; c++) if (f6[c] >= 5.5 && f6[c] <= 7.5 && g.owner[c] >= 0) mid = [(c % g.W) + 0.5, Math.floor(c / g.W) + 0.5];
    await a.dbg('monsters.place', { id: 'hound0', x: hw.x, z: hw.z, state: 'idle' });
    await a.dbg('monsters.tp', { x: mid![0], z: mid![1] });
    const t1 = performance.now();
    a.loud(BAND.talk);
    await sleep(250);
    a.loud(BAND.silent);
    const al = await waitFor(async () => { const x = await hound(); return x.state === 'alert' ? x : null; }, 1000, 'alert on talk').catch(() => null);
    check('talk at ~6 m -> ALERT', !!al, `${Math.round(performance.now() - t1)} ms`);
    await sleep(1150);
    const t2 = performance.now();
    a.loud(BAND.talk);
    await sleep(250);
    a.loud(BAND.silent);
    const ch = await waitFor(async () => { const x = await hound(); return x.state === 'windup' || x.state === 'charge' ? x : null; }, 1000, 'charge').catch(() => null);
    check('second noise within 6 s & 12 m -> wind-up/CHARGE', !!ch, ch ? `${ch.state} after ${Math.round(performance.now() - t2)} ms` : 'no');
    const bark = a.eventsOf('monsters.cue', t2).find((e) => (e.d as { cue: string }).cue === 'bark');
    check('charge is telegraphed (bark cue)', !!bark);
    const kill = await waitFor(() => a.eventsOf('monsters.kill', t2).find((e) => (e.d as { victim: string }).victim === a.id), 4000, 'kill').catch(() => null);
    const kd = kill?.d as { killer: string; reason: string; detail: string } | undefined;
    check('charge kills on contact (cause: hound, heard your <kind>, <n> m)', !!kd && kd.killer === 'hound' && /^heard your /.test(kd.reason) && / m$/.test(kd.detail), kd ? `${kd.reason}, ${kd.detail}` : 'no kill');
    const eat = await hound();
    check('after the kill the hound eats (then retreats out of play)', eat.state === 'eat' || eat.state === 'out', eat.state);
  }

  // ---------------- 4. bottles override everything ----------------
  {
    await a.dbg('monsters.stop');
    await a.dbg('monsters.start', { risk: 1 });
    await sleep(200);
    const h = await hound();
    await a.dbg('monsters.place', { id: 'hound0', x: h.x, z: h.z, state: 'idle' });
    let bp: [number, number] | null = null;
    const f = soundFlood(g, h.x, h.z, 15, doorOpen);
    for (let c = 0; c < f.length && !bp; c++) if (f[c] >= 7 && f[c] <= 11 && g.owner[c] >= 0) bp = [(c % g.W) + 0.5, Math.floor(c / g.W) + 0.5];
    await b.dbg('monsters.noise', { x: bp![0], z: bp![1], radiusM: 15, kind: 'bottle', source: 'item:bottle' });
    const hb = await waitFor(async () => { const x = await hound(); return x.state === 'bottle' ? x : null; }, 800, 'bottle').catch(() => null);
    check('bottle -> goes to the impact point', !!hb && Math.hypot((hb.goal?.[0] ?? 0) - bp![0], (hb.goal?.[1] ?? 0) - bp![1]) < 0.8, hb ? `goal ${hb.goal}` : 'no');
    await b.dbg('monsters.noise', { x: h.x + 1, z: h.z, radiusM: 25, kind: 'walkStep' });
    await sleep(300);
    const hb2 = await hound();
    check('other noises are ignored while it goes for the bottle', hb2.state === 'bottle' || hb2.state === 'sniff', hb2.state);
    await waitFor(async () => (await hound()).state === 'sniff', 6000, 'sniff at the bottle').then(() => check('sniffs at the impact point', true), () => check('sniffs at the impact point', false));
  }

  // ---------------- 5. hub: chained kennel hound (calibration) ----------------
  {
    const hubRes = await a.dbg<{ ok: boolean; agents: AgentDump[] }>('monsters.hub');
    check('hub: chained kennel hound spawned', hubRes.ok && hubRes.agents.some((x) => x.id === 'kennel'));
    const H = await waitFor(() => (a.eventsOf('phase').pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 3000, 'hub layout');
    const kennelItem = H.items.find((i) => i.kind === 'kennel')!;
    const pen = H.spaces[Number(kennelItem.data?.pen ?? 1)].rect;
    // revive Ann (she died to the hound) via players' dbg if present, else via our tp only (hub ignores alive for hearing? no: dead are silent)
    await a.dbg('players.kill', { id: a.id, alive: true }).catch(() => null);
    const kn = async () => (await dump()).agents.find((x) => x.id === 'kennel')!;
    await a.dbg('monsters.tp', { x: pen.x + pen.w / 2, z: pen.y - 2.5 }); // 2.5 m outside the fence
    await sleep(200);
    const tw = performance.now();
    a.loud(BAND.whisper);
    await sleep(900);
    a.loud(BAND.silent);
    check('kennel: whisper -> ignores', (await kn()).state !== 'alert' && (await kn()).state !== 'lunge', (await kn()).state);
    a.loud(BAND.talk);
    const ka = await waitFor(async () => { const k = await kn(); return k.state === 'alert' ? k : null; }, 1000, 'kennel alert').catch(() => null);
    a.loud(BAND.silent);
    check('kennel: talk -> turns + growls', !!ka && a.eventsOf('monsters.cue', tw).some((e) => (e.d as { cue: string }).cue === 'growl'));
    await sleep(500);
    a.loud(BAND.shout);
    const kl = await waitFor(async () => { const k = await kn(); return k.state === 'lunge' ? k : null; }, 1000, 'kennel lunge').catch(() => null);
    a.loud(BAND.silent);
    check('kennel: shout -> lunges at the fence', !!kl);
    await sleep(1200);
    const kAfter = await kn();
    const inside = kAfter.x >= pen.x && kAfter.x <= pen.x + pen.w && kAfter.z >= pen.y && kAfter.z <= pen.y + pen.h;
    check('kennel hound never leaves its pen', inside, `${kAfter.x},${kAfter.z} pen ${JSON.stringify(pen)}`);
  }
} catch (e) {
  check('test run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  a.close();
  b.close();
  await srv.stop();
}
const failed = results.filter((r) => !r.pass);
if (failed.length) console.log(srv.log().split('\n').filter((l) => /monsters|error|warn/i.test(l)).slice(-30).join('\n'));
console.log(`\nG2b hound: ${failed.length ? 'FAILED' : 'PASSED'} ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
