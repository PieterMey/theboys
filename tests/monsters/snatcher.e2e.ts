// Owner: track (c) Monsters. v1.1 THE SNATCHER with ws bots (no browser):
//  - spawn rules: none at risk 1 / 1st + 2nd contract, present at risk 2 or (v1.3) from the 3rd contract, dormant for
//    the first 2 minutes
//  - snatch -> rescue: a player alone >= 8 s near a grate is stalked (rattle + dust + soft clicks first), dropped on,
//    dragged into the grate; a teammate holding E (pull heartbeat) for 2 s at the grate frees them; it retreats
//  - buddy system: a teammate arriving within 10 m during the stalk makes it pull back (no snatch)
//  - snatch -> death: nobody pulls; struggling (mashing E) slows it past 20 s; death cause 'took you while you were alone'
//   node tests/monsters/snatcher.e2e.ts        (starts its own dev server on PORT or 3013)
import { Bot, sleep, startServer, waitFor } from './bot.ts';
import type { EventRec } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3013);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = '') => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};

interface GrateDump { id: string; x: number; z: number; n: [number, number]; front: [number, number]; space: number }
interface AgentDump { id: string; kind: string; x: number; z: number; state: string; active: boolean; readyAt?: number; grates?: GrateDump[]; victim?: string | null; progress?: number; alone?: Record<string, number> }
interface StateDump { mode: string; time: number; agents: AgentDump[]; poses: { id: string; p: number[]; alive: boolean }[] }
interface SnatchD { id: string; victim: string; state: string; phase?: string; p: number[]; grate?: { id: string; p: number[]; n: [number, number]; front: number[] }; progress?: number; pull?: number; by?: string; eta?: number }
interface CueD { cue: string; kind: string; p: number[]; radius: number }

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const a = new Bot('Ann');
const b = new Bot('Bob');
const cues = (bot: Bot, since: number, cue?: string) => bot.eventsOf('monsters.cue', since).filter((e) => (e.d as CueD).kind === 'snatcher' && (!cue || (e.d as CueD).cue === cue));
try {
  await a.connect(url, 'SNTC');
  await b.connect(url, 'SNTC');
  const dump = () => a.dbg<StateDump>('monsters.state');
  const sn = async () => (await dump()).agents.find((x) => x.kind === 'snatcher');

  // ---------------- spawn rules ----------------
  await a.dbg('monsters.start', { seed: 'snatch-r1', players: 2, risk: 1, contractIndex: 0 });
  check('risk 1, 1st contract: no Snatcher', !(await sn()));
  await a.dbg('monsters.stop');
  // v1.3: from the crew's 3rd contract (snatcher.minContractIndex 2), no longer the 2nd
  await a.dbg('monsters.start', { seed: 'snatch-r1b', players: 2, risk: 1, contractIndex: 1 });
  check('risk 1, 2nd contract: no Snatcher (v1.3: from the 3rd)', !(await sn()));
  await a.dbg('monsters.stop');
  await a.dbg('monsters.start', { seed: 'snatch-r1b', players: 2, risk: 1, contractIndex: 2 });
  check('risk 1, 3rd contract: Snatcher present', !!(await sn()));
  await a.dbg('monsters.stop');
  await a.dbg('monsters.start', { seed: 'snatch-1', players: 2, risk: 2, contractIndex: 0 });
  const s0 = await sn();
  check('risk 2: exactly one Snatcher, dormant, not before 2 minutes', !!s0 && (await dump()).agents.filter((x) => x.kind === 'snatcher').length === 1 && s0.state === 'dormant' && (s0.readyAt ?? 0) >= 120 && !s0.active, `${s0?.state} readyAt ${s0?.readyAt}`);
  const grates = s0?.grates ?? [];
  check('layout has vent grates for it', grates.length >= 2, `${grates.length} grates`);
  // everything else out of the way
  for (const id of ['hound0', 'listener0', 'mannequin0', 'hound1']) await a.dbg('monsters.place', { id, outSec: 9999 }).catch(() => null);
  await a.dbg('monsters.snatcher', { op: 'ready' });
  check('dbg ready -> it lurks in the ducts (inactive = invisible)', (await sn())?.state === 'lurk' && (await sn())?.active === false);

  const g = grates[0];
  // victim spot: 1.2 m in front of the grate's rescue spot; the teammate >= 14 m away (straight line) and not in the van
  const vx = g.front[0] + g.n[0] * 1.0, vz = g.front[1] + g.n[1] * 1.0;
  const far = grates.slice(1).map((q) => [q.front[0] + q.n[0], q.front[1] + q.n[1]] as [number, number]).find((q) => Math.hypot(q[0] - vx, q[1] - vz) >= 14)
    ?? [vx + (vx > 20 ? -16 : 16), vz] as [number, number];
  const putApart = async () => {
    await a.dbg('monsters.tp', { id: a.id, x: vx, z: vz });
    await b.dbg('monsters.tp', { id: b.id, x: far[0], z: far[1] });
  };

  // ---------------- 1. snatch -> rescue ----------------
  let t0 = performance.now();
  await putApart();
  const start = await waitFor(() => a.eventsOf('monsters.snatch', t0).find((e) => (e.d as SnatchD).state === 'start'), 20_000, 'snatch start');
  const sd = start.d as SnatchD;
  const aloneFor = (start.at - t0) / 1000;
  check('lone player (no teammate within 10 m) is snatched only after >= 8 s alone', sd.victim === a.id && aloneFor >= 8, `${aloneFor.toFixed(1)} s, victim ${sd.victim === a.id ? 'Ann' : sd.victim}`);
  const pre = (cue: string) => cues(a, t0, cue).filter((e) => e.at <= start.at);
  const tick = pre('tick').pop();
  check('tells before the drop: grate rattle + dust + soft clicking', pre('rattle').length > 0 && pre('dust').length > 0 && !!tick, `rattle ${pre('rattle').length}, dust ${pre('dust').length}, tick ${tick ? `${((start.at - tick.at) / 1000).toFixed(2)} s before` : 'none'}`);
  check('soft clicking comes >= 1 s before the drop', !!tick && start.at - tick.at >= 1000);
  check('drop cue + drag route to the right grate', cues(a, t0, 'snatch').length > 0 && !!sd.grate && sd.grate.id === g.id && (sd.p.length === 3), `grate ${sd.grate?.id}`);
  // the victim is dragged along the floor to the grate, then into the duct (stance hidden)
  const duct = await waitFor(() => a.eventsOf('monsters.snatch', start.at).find((e) => (e.d as SnatchD).phase === 'duct'), 12_000, 'duct phase');
  // the 'duct' event can arrive one snapshot before the pose that shows it (under load): wait up to 500 ms for it
  const inDuct = () => a.snap?.players.find((p) => p.id === a.id && p.stance === 3);
  await waitFor(inDuct, 500, 'hidden pose').catch(() => undefined);
  const posA = a.snap?.players.find((p) => p.id === a.id);
  const dG = posA ? Math.hypot(posA.p[0] - g.front[0], posA.p[2] - g.front[1]) : 99;
  check('victim dragged to the grate, then into the duct (hidden)', dG < 0.6 && posA?.stance === 3, `${dG.toFixed(2)} m from the grate front, stance ${posA?.stance}, ${((duct.at - start.at) / 1000).toFixed(1)} s`);
  // a short pull does nothing; a 2 s hold at the grate frees them
  await b.dbg('monsters.tp', { id: b.id, x: g.front[0] + g.n[0] * 0.6, z: g.front[1] + g.n[1] * 0.6 });
  const pullT0 = performance.now();
  let freed: EventRec | undefined;
  for (let i = 0; i < 40 && !freed; i++) {
    await b.req('monsters.pull', { on: true });
    await sleep(120);
    freed = a.eventsOf('monsters.snatch', start.at).find((e) => (e.d as SnatchD).state === 'freed');
  }
  const held = freed ? (freed.at - pullT0) / 1000 : 0;
  check('teammate holding E at the grate pulls them out (after ~2 s, not before)', !!freed && (freed.d as SnatchD).by === b.id && held >= 1.8 && held <= 3.2, `held ${held.toFixed(2)} s`);
  const afterRescue = await sn();
  const aliveA = (await dump()).poses.find((p) => p.id === a.id)?.alive;
  check('victim alive, released in front of the grate; it retreats into the ducts', aliveA === true && afterRescue?.state === 'out' && afterRescue.active === false, `alive ${aliveA}, snatcher ${afterRescue?.state}`);
  check('it shrieks as it flees', cues(a, start.at, 'shriek').length > 0);

  // ---------------- 2. buddy system: a teammate arriving during the stalk -> it pulls back ----------------
  await a.dbg('monsters.snatcher', { op: 'ready' });
  t0 = performance.now();
  await putApart();
  const stalkRattle = await waitFor(() => cues(a, t0, 'rattle').find((e) => (e.d as CueD).radius >= 18), 20_000, 'stalk rattle');
  await b.dbg('monsters.tp', { id: b.id, x: vx + g.n[0] * 2.5, z: vz + g.n[1] * 2.5 });
  await sleep(4500);
  const noSnatch = !a.eventsOf('monsters.snatch', t0).some((e) => (e.d as SnatchD).state === 'start');
  check('buddy within 10 m during the stalk: no snatch (it pulls back)', noSnatch && (await sn())?.state === 'lurk', `stalk at +${((stalkRattle.at - t0) / 1000).toFixed(1)} s, state ${(await sn())?.state}`);

  // ---------------- 3. snatch -> death (struggling slows it) ----------------
  await a.dbg('monsters.snatcher', { op: 'ready' });
  t0 = performance.now();
  await putApart();
  const start2 = await waitFor(() => a.eventsOf('monsters.snatch', t0).find((e) => (e.d as SnatchD).state === 'start'), 20_000, 'snatch start (2)');
  const eta0 = (start2.d as SnatchD).eta ?? 0;
  // mash E for 8 s (~9 presses/s)
  const mashEnd = performance.now() + 8000;
  let lastStruggle = 0;
  while (performance.now() < mashEnd) {
    const r = await a.req<{ ok: boolean; struggle: number }>('monsters.struggle', {});
    lastStruggle = r.struggle;
    await sleep(110);
  }
  const ticks = a.eventsOf('monsters.snatch', start2.at).filter((e) => (e.d as SnatchD).state === 'tick');
  const eta1 = (ticks.pop()?.d as SnatchD | undefined)?.eta ?? 0;
  check('mashing E fills the struggle meter and pushes the deadline back', lastStruggle > 0.5 && eta1 - eta0 > 1500, `struggle ${lastStruggle.toFixed(2)}, eta +${((eta1 - eta0) / 1000).toFixed(1)} s`);
  const killed = await waitFor(() => a.eventsOf('monsters.snatch', start2.at).find((e) => (e.d as SnatchD).state === 'killed'), 40_000, 'snatch killed');
  const dur = (killed.at - start2.at) / 1000;
  check('nobody pulled: death at the end of the drag (> 20 s thanks to struggling)', dur > 20.5 && dur < 40, `${dur.toFixed(1)} s`);
  const kill = a.eventsOf('monsters.kill', start2.at).find((e) => (e.d as { victim: string }).victim === a.id)?.d as { killer: string; reason: string; detail?: string } | undefined;
  check("death card: killer 'snatcher', 'took you while you were alone'", kill?.killer === 'snatcher' && kill.reason === 'took you while you were alone' && /alone \d+ s/.test(kill.detail ?? ''), `${kill?.killer}: ${kill?.reason} (${kill?.detail})`);
  const st3 = await dump();
  check('victim dead; the Snatcher retreats after the kill', st3.poses.find((p) => p.id === a.id)?.alive === false && st3.agents.find((x) => x.kind === 'snatcher')?.state === 'out');
  const errs = srv.log().split('\n').filter((l) => /error|threw|TypeError|ReferenceError/i.test(l) && /monsters|snatch|director/i.test(l));
  check('no server errors from monsters/director', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  a.close();
  b.close();
  await srv.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\nSnatcher: ${failed.length ? 'FAILED' : 'PASSED'} ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
