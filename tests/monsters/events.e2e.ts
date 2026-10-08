// Owner: track (c) Monsters (v1.2 G2). The monster event bus (api.onMonsterEvent, read here through the dev-only
// dbg.monsters.events log) with ws bots:
//  - 'wake' (no victim) when the Listener wakes
//  - 'seen': a monster in the player's view cone, LOS, lit or within 3 m (victim = the player who saw it); deduped 30 s
//  - 'heard': the player was inside a monster cue's radius; players outside it hear nothing
//  - Hound 'alert' and 'charge' with victim = the player whose noise caused them
//  - Listener 'notice', 'grab' + 'knockdown', 'grab' + 'escaped', 'kill' with the right victim
//  - Listener 'flinch' (by the player) from a real flashbulb item use event (SHOULD), then it retreats
//  - ListenerDecision.speakerId = the player id of the speaker it heard
//   node tests/monsters/events.e2e.ts         (own dev server on PORT, default 3802)
import { Bot, sleep, startServer, waitFor } from './bot.ts';
import { cabSpot, check, contract, findLine, park, placeListener, serverErrors, summary, tp } from './fairlib.ts';

const PORT = Number(process.env.PORT ?? 3802);
const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann'), B = new Bot('Bob');

interface Ev { n: number; monster: string; id: string; event: string; victim?: string; by?: string; at: number }
interface Dec { n: number; action: string; speaker: string | null; speakerId: string | null; valid: boolean; line: string }
const evs = async (since = 0) => (await A.dbg<{ events: Ev[]; decisions: Dec[] }>('monsters.events', { since }));
const lastN = async () => { const e = await evs(); return Math.max(0, ...e.events.map((x) => x.n), ...e.decisions.map((x) => x.n)); };
const find = async (since: number, f: (e: Ev) => boolean, ms: number) => waitFor(async () => (await evs(since)).events.find(f) ?? null, ms, 'event').catch(() => null);

try {
  const w = await contract(url, 'LEVNT', [A, B], 'g2-events-1', 2, 1);
  const cab = cabSpot(w);
  await tp(B, cab[0], cab[1]);
  const e0 = await evs();
  check("'wake' when the Listener wakes (no victim)", e0.events.some((e) => e.event === 'wake' && e.monster === 'listener' && !e.victim));

  // ---- seen: A looks at the Listener 2.6 m away (it faces away from A: no notice) ----
  const line = findLine(w, 2.6);
  if (!line) throw new Error('no sight line');
  const [Sx, Sz] = line.S, [Px, Pz] = line.P;
  await tp(A, Px, Pz, { light: 0, yaw: Math.atan2(Sx - Px, Sz - Pz) });
  let n = await lastN();
  await placeListener(A, Sx, Sz, Sx - line.dir[0] * 3, Sz - line.dir[1] * 3);
  const seen = await find(n, (e) => e.event === 'seen' && e.monster === 'listener', 1500);
  check("'seen': the Listener in A's view cone within 3 m (victim = A)", seen?.victim === A.id, seen ? `${seen.monster} by ${seen.victim}` : 'none');
  await sleep(1200);
  const again = (await evs(seen?.n ?? n)).events.filter((e) => e.event === 'seen' && e.monster === 'listener' && e.victim === A.id);
  check("'seen' is deduped per monster + player (30 s)", again.length === 0, `${again.length} repeats`);
  check("'seen': B in the van cab saw nothing", !(await evs(n)).events.some((e) => e.event === 'seen' && e.victim === B.id));
  // ---- heard: its periodic click (12 m) reaches A, not B in the cab ----
  const heard = await find(n, (e) => e.event === 'heard' && e.monster === 'listener' && e.victim === A.id, 7000);
  check("'heard': A inside the Listener's cue radius (victim = A)", !!heard);
  check("'heard': B outside every cue radius heard nothing", !(await evs(n)).events.some((e) => e.event === 'heard' && e.victim === B.id && e.monster === 'listener'));
  await park(A);

  // ---- hound alert + charge: victim = the noise source (B) ----
  const l2 = findLine(w, 5, { skip: 6 }) ?? line;
  await tp(A, cab[0], cab[1]);
  await tp(B, l2.P[0], l2.P[1], { light: 0 });
  await A.dbg('monsters.place', { id: 'hound0', x: l2.S[0], z: l2.S[1], state: 'idle', active: true });
  await sleep(200);
  n = await lastN();
  await B.dbg('monsters.noise', { x: l2.P[0], z: l2.P[1], radiusM: 10, kind: 'voice', source: B.id });
  const al = await find(n, (e) => e.monster === 'hound' && e.event === 'alert', 1500);
  check("hound 'alert' (growl): victim = the noise source", al?.victim === B.id, al ? `${al.victim}` : 'none');
  await sleep(1300);
  await B.dbg('monsters.noise', { x: l2.P[0], z: l2.P[1], radiusM: 10, kind: 'walkStep', source: B.id });
  const ch = await find(n, (e) => e.monster === 'hound' && e.event === 'charge', 1500);
  await A.dbg('monsters.place', { id: 'hound0', outSec: 9999 });
  check("hound 'charge' (wind-up): victim = the noise source", ch?.victim === B.id, ch ? `${ch.victim}` : 'none');
  check('hound growl heard by B (victim B)', (await evs(n)).events.some((e) => e.monster === 'hound' && e.event === 'heard' && e.victim === B.id));
  await tp(B, cab[0], cab[1]);

  // ---- Listener notice / grab + knockdown / grab + escaped / kill ----
  await tp(A, Px, Pz, { light: 1, yaw: Math.atan2(line.dir[0], line.dir[1]) });
  await sleep(150);
  n = await lastN();
  await placeListener(A, Sx, Sz, Px, Pz);
  const no = await find(n, (e) => e.event === 'notice', 1500);
  await park(A);
  check("Listener 'notice': victim = the player it noticed", no?.victim === A.id && no.monster === 'listener');
  n = await lastN();
  await A.dbg('monsters.grab', { id: A.id, knockdown: true });
  await sleep(150);
  const kd = (await evs(n)).events;
  check("knockdown grab: 'grab' then 'knockdown' (victim A)", kd.some((e) => e.event === 'grab' && e.victim === A.id) && kd.some((e) => e.event === 'knockdown' && e.victim === A.id),
    kd.map((e) => e.event).join(', '));
  await sleep(2400);
  n = await lastN();
  await A.dbg('monsters.grab', { id: A.id, knockdown: false });
  for (let i = 0; i < 40; i++) {
    const r = await A.req<{ escaped?: boolean }>('monsters.struggle', {});
    if (r.escaped) break;
    await sleep(150);
  }
  const es = (await evs(n)).events;
  check("struggled free: 'grab' then 'escaped' (victim A, by A)", es.some((e) => e.event === 'grab' && e.victim === A.id) && es.some((e) => e.event === 'escaped' && e.victim === A.id && e.by === A.id),
    es.map((e) => e.event).join(', '));
  await sleep(3500); // stagger + retreat
  // kill: Bob grabbed (knockdown skipped), nobody helps, no struggle
  await tp(B, Px, Pz, { light: 0 });
  await tp(A, cab[0], cab[1]);
  n = await lastN();
  await A.dbg('monsters.grab', { id: B.id, knockdown: false });
  const kill = await find(n, (e) => e.event === 'kill', 8000);
  check("'kill': victim = the player (Listener grab ran out)", kill?.victim === B.id && kill.monster === 'listener', kill ? `${kill.monster} -> ${kill.victim}` : 'none');

  // ---- flashbulb (SHOULD): the real interaction item event 'use' -> the Listener flinches + retreats ----
  await sleep(600);
  const fb = await A.dbg<{ id: string } | null>('interaction.give', { type: 'flashbulb', pid: A.id }).catch(() => null);
  const fst = await A.dbg<{ inventories: Record<string, (string | null)[]> }>('interaction.state');
  const fslot = fb ? (fst.inventories[A.id] ?? []).indexOf(fb.id) : -1;
  if (fslot >= 0) await A.req('interaction.slot', { slot: fslot });
  const l3 = findLine(w, 6, { skip: 3 }) ?? line;
  const [fSx, fSz] = l3.S, [fPx, fPz] = l3.P;
  await tp(A, fPx, fPz, { light: 0, yaw: Math.atan2(fSx - fPx, fSz - fPz) });
  await placeListener(A, fSx, fSz, fSx - l3.dir[0] * 3, fSz - l3.dir[1] * 3); // it faces away from A
  await sleep(300);
  n = await lastN();
  const fd = Math.hypot(fSx - fPx, fSz - fPz);
  const fire = await A.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [(fSx - fPx) / fd, 0, (fSz - fPz) / fd], eye: [fPx, 1.6, fPz] }).catch(() => ({ ok: false }));
  const fl = await find(n, (e) => e.event === 'flinch' && e.monster === 'listener', 1200);
  const fout = await waitFor(async () => {
    const l = (await A.dbg<{ agents: { kind: string; state: string }[] }>('monsters.state')).agents.find((x) => x.kind === 'listener');
    return l?.state === 'out' ? l : null;
  }, 1500, 'retreat').catch(() => null);
  check("flashbulb fired at the Listener (6 m, in the cone, LOS): 'flinch' (by A) and it retreats",
    fslot >= 0 && fire.ok && fl?.by === A.id && !!fout, `slot ${fslot}, fire ${fire.ok}${'msg' in fire && fire.msg ? ` ${fire.msg}` : ''}, flinch ${fl ? fl.by : 'none'}, retreat ${!!fout}`);
  await park(A);

  // ---- ListenerDecision.speakerId ----
  const cs = w.L.spaces.find((s) => s.callsign && s.callsign !== 'VAN' && s.callsign !== 'LOBBY')!.callsign!;
  await sleep(500);
  await A.dbg('monsters.place', { id: 'listener0', x: cab[0], z: cab[1] - 12, state: 'patrol', active: true }).catch(() => null);
  await sleep(3200); // decision cooldown
  n = await lastN();
  await A.dbg('monsters.utter', { segId: 'ev-1', text: `ok everyone meet in the ${cs.toLowerCase()} now`, listener: true });
  const dec = await waitFor(async () => (await evs(n)).decisions.find((d) => !!d.speaker) ?? null, 6000, 'decision').catch(() => null);
  check('ListenerDecision.speakerId = the speaker it heard', dec?.speakerId === A.id, dec ? `${dec.line} (speaker ${dec.speaker}, id ${dec.speakerId})` : 'no decision');
  const errs = serverErrors(srv.log());
  check('no server errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  A.close();
  B.close();
  await srv.stop();
}
process.exitCode = summary('Monster event bus');
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
