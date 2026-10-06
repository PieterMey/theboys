// Owner: track (c) Monsters. Listener + Mannequin e2e with ws bots (G3-style, no browser, no AI):
//  - a line spoken at talk level 8 m (path) from the Listener reaches its memory; at 15 m it does not
//  - wake-up -> facility flicker + immediate decision on what it overheard (rule brain), telegraphed
//    (room flicker, INTERCEPT console line), logged ('it heard "..." -> ambushed BOILER') and acted on
//  - AI brain intents are validated (an unheard room degrades), valid ones are executed
//  - grab of a lone player: 3 s window, teammate shove frees it (Listener retreats), else death with the quote
//  - Mannequin: frozen while watched (fake 'monsters.see' reports) and lit; moves when unwatched; visor blink
//    breaks a single watcher's gaze, two watchers keep it frozen; kills on touch
//   node tests/monsters/listener.e2e.ts
import { BAND } from '../../packages/shared/src/constants.ts';
import { buildEdgeGrid, initialDoorOpen, los, soundFlood } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { Bot, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3013);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = '') => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};
interface Ag { id: string; kind: string; x: number; z: number; state: string; active: boolean; intent?: string; targetSpace?: number; targetPlayer?: string | null; dormant?: boolean; grabVictim?: string | null; memory?: { text: string; meaningful: boolean }[]; spawned?: boolean; observed?: boolean }
interface Dump { agents: Ag[]; log: { line: string; action: string; target: string | null; source: string; valid: boolean }[] }

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const layoutOf = (b: Bot) => waitFor(() => (b.eventsOf('phase').pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 3000, 'layout');

const A = new Bot('Ann'), B = new Bot('Bob'), C = new Bot('Cas');
const M1 = new Bot('Mia'), M2 = new Bot('Max');
try {
  // ======================= LISTENER =======================
  await A.connect(url, 'LSTN');
  await B.connect(url, 'LSTN');
  await C.connect(url, 'LSTN');
  await A.dbg('monsters.start', { seed: 'g3-listener', players: 3, risk: 1 });
  const L = await layoutOf(A);
  const g = buildEdgeGrid(L);
  const doorOpen = initialDoorOpen(L);
  const dump = () => A.dbg<Dump>('monsters.state');
  const lis = async () => (await dump()).agents.find((a) => a.kind === 'listener')!;
  await A.dbg('monsters.place', { id: 'hound0', outSec: 600 }); // keep the hound out of this test
  const l0 = await lis();
  check('Listener starts dormant (risk 1: 3 real minutes)', !!l0 && l0.dormant === true && l0.active === false, l0 ? `${l0.state} at ${l0.x},${l0.z}` : 'none');
  const cab = L.van.cab;
  for (const bot of [A, B, C]) await bot.dbg('monsters.tp', { x: cab.x + 1, z: cab.y + 1.5 }); // sealed van: silent for it
  const f = soundFlood(g, l0.x, l0.z, 40, doorOpen);
  const cellAt = (lo: number, hi: number): [number, number] | null => {
    for (let c = 0; c < f.length; c++) if (f[c] >= lo && f[c] <= hi && g.owner[c] >= 0 && L.spaces[g.owner[c]].kind !== 'outside') return [(c % g.W) + 0.5, Math.floor(c / g.W) + 0.5];
    return null;
  };
  const p8 = cellAt(7.5, 8.5)!, p15 = cellAt(14.5, 15.5)!;
  const here = g.owner[Math.floor(l0.z) * g.W + Math.floor(l0.x)];
  const cs = L.spaces.find((s) => s.callsign && s.callsign !== 'VAN' && s.callsign !== 'LOBBY' && s.id !== here)!;
  const callsign = cs.callsign!;
  // 8 m: talk then the transcript arrives (no hearers flag -> our own who-heard-what record)
  await A.dbg('monsters.tp', { x: p8[0], z: p8[1] });
  A.loud(BAND.talk);
  await sleep(900);
  A.loud(BAND.silent);
  const r8 = await A.dbg<{ ok: boolean }>('monsters.utter', { segId: 's8', text: `ok meet in the ${callsign.toLowerCase()} now` });
  check('talk 8 m from the Listener -> line reaches its memory', r8.ok, `${callsign} at ${p8}`);
  await A.dbg('monsters.tp', { x: cab.x + 1, z: cab.y + 1.5 });
  await B.dbg('monsters.tp', { x: p15[0], z: p15[1] });
  B.loud(BAND.talk);
  await sleep(900);
  B.loud(BAND.silent);
  const r15 = await B.dbg<{ ok: boolean }>('monsters.utter', { segId: 's15', text: 'the code is four seven one nine' });
  check('talk 15 m away -> NOT heard (not in memory)', !r15.ok);
  const rT = await B.dbg<{ ok: boolean }>('monsters.utter', { segId: 'sT', text: 'hearers flag false', listener: false });
  check('hearers.listener=false (AI track) is respected', !rT.ok);
  await B.dbg('monsters.tp', { x: cab.x + 1, z: cab.y + 1.5 });
  const mem = (await lis()).memory ?? [];
  check('memory holds exactly the overheard line', mem.length === 1 && mem[0].meaningful, JSON.stringify(mem.map((m) => m.text)));

  // wake-up: flicker + immediate act on what it overheard
  const tw = performance.now();
  await A.dbg('monsters.wake');
  const wake = await waitFor(() => A.eventsOf('monsters.wake', tw)[0], 1000, 'wake event').catch(() => null);
  check('wake: facility-wide flicker event', !!wake);
  const tel = await waitFor(() => A.eventsOf('monsters.telegraph', tw)[0], 1500, 'telegraph').catch(() => null);
  const td = tel?.d as { space: number; ms: number } | undefined;
  check('telegraph: target room flickers 1.2 s', !!td && td.space === cs.id && td.ms === 1200, td ? `space ${td.space} (${callsign} = ${cs.id})` : 'none');
  const ic = A.eventsOf('monsters.intercept', tw)[0]?.d as { text: string } | undefined;
  check('console INTERCEPT line names the room', !!ic && ic.text.includes(callsign), ic?.text ?? 'none');
  const d1 = await dump();
  const last = d1.log[d1.log.length - 1];
  check('decision logged: heard -> ambushed <ROOM>', !!last && last.action === 'ambush_room' && last.line.includes(`ambushed ${callsign}`), last ? `${last.line} [${last.source}]` : 'none');
  const lw = d1.agents.find((a) => a.kind === 'listener')!;
  check('and acted on: ambushing the room', lw.active && lw.intent === 'ambush_room' && lw.targetSpace === cs.id && (lw.state === 'ambush' || lw.state === 'vent'), `${lw.state}/${lw.intent}`);

  // AI brain validation: an unheard room degrades; a heard speaker is a valid stalk target
  const other = L.spaces.find((s) => s.callsign && s.id !== cs.id && s.callsign !== 'VAN')!;
  await A.dbg('monsters.fakeBrain', { intent: { action: 'ambush_room', room: other.callsign } });
  await sleep(3100);
  const lp = await lis();
  const fa = soundFlood(g, lp.x, lp.z, 9, doorOpen);
  let near: [number, number] | null = null;
  for (let c = 0; c < fa.length && !near; c++) if (fa[c] >= 4 && fa[c] <= 7 && g.owner[c] >= 0) near = [(c % g.W) + 0.5, Math.floor(c / g.W) + 0.5];
  await A.dbg('monsters.tp', { x: near![0], z: near![1] });
  A.loud(BAND.talk);
  await sleep(600);
  A.loud(BAND.silent);
  const n1 = (await dump()).log.length;
  await A.dbg('monsters.utter', { segId: 'v1', text: 'wait here, I hear something' });
  const d2 = await waitFor(async () => { const d = await dump(); return d.log.length > n1 ? d : null; }, 8000, 'decision on v1').catch(() => dump());
  const e2 = d2.log[d2.log.length - 1];
  check('AI intent with an unheard room is rejected + degraded', !!e2 && e2.source === 'fake' && e2.valid === false && e2.action !== 'ambush_room', e2 ? `${e2.action} valid=${e2.valid}: ${e2.line}` : 'none');
  await A.dbg('monsters.fakeBrain', { intent: { action: 'stalk_player', player: A.id } });
  await sleep(3100);
  A.loud(BAND.talk);
  await sleep(500);
  A.loud(BAND.silent);
  const n2 = (await dump()).log.length;
  await A.dbg('monsters.utter', { segId: 'v2', text: 'come on, follow me' });
  const d3 = await waitFor(async () => { const d = await dump(); return d.log.length > n2 ? d : null; }, 8000, 'decision on v2').catch(() => dump());
  const e3 = d3.log[d3.log.length - 1];
  const l3 = d3.agents.find((a) => a.kind === 'listener')!;
  check('valid AI intent (stalk the speaker it heard) is executed', !!e3 && e3.valid && e3.action === 'stalk_player' && l3.targetPlayer === A.id, e3 ? `${e3.line} -> ${l3.state}` : 'none');
  await A.dbg('monsters.fakeBrain', { off: true });

  // grab: lone player -> 3 s -> death with the quote
  const lg = await lis();
  await A.dbg('monsters.place', { id: 'listener0', x: near![0] + 0.6, z: near![1], state: 'patrol', active: true });
  const tg = performance.now();
  const grab = await waitFor(() => A.eventsOf('monsters.grab', tg).find((e) => (e.d as { state: string }).state === 'start'), 1500, 'grab').catch(() => null);
  check('touching a lone player -> GRAB (3 s rescue window)', !!grab && (grab.d as { victim: string }).victim === A.id, lg.state);
  const kill = await waitFor(() => A.eventsOf('monsters.kill', tg).find((e) => (e.d as { victim: string }).victim === A.id), 4500, 'grab kill').catch(() => null);
  const kd = kill?.d as { killer: string; reason: string; detail: string } | undefined;
  const dt = kill ? kill.at - (grab?.at ?? tg) : 0;
  check('no rescue -> death after ~3 s, cause quotes what it heard', !!kd && kd.killer === 'listener' && kd.reason.startsWith('heard "') && /s ago$/.test(kd.detail) && dt > 2500, kd ? `${Math.round(dt)} ms: ${kd.reason} (${kd.detail})` : 'none');
  const after = await lis();
  check('after the kill the Listener retreats out of play', after.state === 'out' && !after.active, after.state);

  // rescue: Bob shoves it off Cas
  await A.dbg('monsters.place', { id: 'listener0', x: near![0] + 0.6, z: near![1], state: 'patrol', active: true });
  await C.dbg('monsters.tp', { x: near![0], z: near![1] });
  const tr = performance.now();
  const grab2 = await waitFor(() => C.eventsOf('monsters.grab', tr).find((e) => (e.d as { state: string; victim: string }).state === 'start' && (e.d as { victim: string }).victim === C.id), 1500, 'grab 2').catch(() => null);
  check('second grab (Cas alone)', !!grab2);
  await B.dbg('monsters.tp', { x: near![0] - 0.8, z: near![1] });
  const sh = await B.req<{ ok: boolean; freed: boolean }>('monsters.shove', { kind: 'shove' });
  const freedEv = await waitFor(() => C.eventsOf('monsters.grab', tr).find((e) => (e.d as { state: string }).state === 'freed'), 800, 'freed').catch(() => null);
  const l4 = await lis();
  check('teammate E-shove frees the victim; Listener retreats 20 s', sh.freed && !!freedEv && l4.state === 'out', `${JSON.stringify(sh)} ${l4.state}`);
  const cAlive = !C.eventsOf('monsters.kill', tr).length;
  check('rescued player survives', cAlive);
  A.close(); B.close(); C.close();

  // ======================= MANNEQUIN =======================
  await M1.connect(url, 'MANQ');
  await M2.connect(url, 'MANQ');
  const ms = await M1.dbg<{ agents: Ag[] }>('monsters.start', { seed: 'g3-mannequin', players: 2, risk: 2 });
  check('risk 2: mannequin in the contract (not spawned before 23:30 / Core lift)', ms.agents.some((a) => a.kind === 'mannequin' && a.spawned === false));
  const ML = await layoutOf(M1);
  const mg = buildEdgeGrid(ML);
  const mdoor = initialDoorOpen(ML);
  // a long lit space: watcher at one end, mannequin ~9 m away with LOS
  let pw: [number, number] | null = null, pm: [number, number] | null = null;
  for (const s of ML.spaces) {
    if (pw || (s.kind !== 'hall' && s.kind !== 'corridor' && s.kind !== 'room')) continue;
    const r = s.rect;
    if (r.w >= 10) { pw = [r.x + 0.5, r.y + r.h / 2]; pm = [r.x + 9.5, r.y + r.h / 2]; }
    else if (r.h >= 10) { pw = [r.x + r.w / 2, r.y + 0.5]; pm = [r.x + r.w / 2, r.y + 9.5]; }
    if (pw && pm && !los(mg, pw[0], pw[1], pm[0], pm[1], mdoor)) pw = pm = null;
  }
  check('found a 9 m sightline for the watch test', !!pw && !!pm, `${pw} -> ${pm}`);
  const yaw = Math.atan2(pm![0] - pw![0], pm![1] - pw![1]);
  await M1.dbg('monsters.tp', { x: pw![0], z: pw![1], yaw, light: 1 });
  await M2.dbg('monsters.tp', { x: ML.van.cab.x + 1, z: ML.van.cab.y + 1.5 });
  const mann = async () => (await M1.dbg<Dump>('monsters.state')).agents.find((a) => a.kind === 'mannequin')!;
  let watching1 = true, watching2 = false;
  const reporter = setInterval(() => {
    if (watching1) void M1.req('monsters.see', { s: { mannequin0: true } }).catch(() => null);
    if (watching2) void M2.req('monsters.see', { s: { mannequin0: true } }).catch(() => null);
  }, 100);
  await M1.dbg('monsters.place', { id: 'hound0', outSec: 600 });
  await M1.dbg('monsters.spawnMannequin', { x: pm![0], z: pm![1], blinkIn: 60 });
  for (let i = 0; i < 3; i++) await M1.req('monsters.see', { s: { mannequin0: true } });
  await sleep(1500);
  const m0 = await mann();
  check('watched + lit (flashlight) -> frozen in place', m0.state === 'frozen' && Math.hypot(m0.x - pm![0], m0.z - pm![1]) < 0.05, `${m0.state} ${m0.x},${m0.z}`);
  watching1 = false;
  await sleep(600);
  const m1 = await mann();
  const moved = Math.hypot(m1.x - pm![0], m1.z - pm![1]);
  check('unwatched -> moves toward the player (7 m/s)', m1.state === 'move' && moved > 0.8, `${m1.state} moved ${moved.toFixed(2)} m`);
  watching1 = true;
  await sleep(500);
  const m2 = await mann();
  await sleep(400);
  const m3 = await mann();
  check('watched again -> freezes', m3.state === 'frozen' && Math.hypot(m3.x - m2.x, m3.z - m2.z) < 0.05, `${m3.state}`);
  // blink: the single watcher's visor blinks -> it moves during the blink
  const tb = performance.now();
  await M1.dbg('monsters.blink', { id: M1.id, inSec: 1 });
  const blink = await waitFor(() => M1.eventsOf('monsters.blink', tb)[0], 1500, 'blink event').catch(() => null);
  const bd = blink?.d as { at: number; ms: number } | undefined;
  check('server tells the client its visor blink (0.35 s) ahead of time', !!bd && bd.ms === 350 && bd.at > (blink?.t ?? 0), bd ? `lead ${Math.round(bd.at - (blink?.t ?? 0))} ms` : 'none');
  const before = await mann();
  await sleep(1100);
  const during = await mann();
  check('one watcher blinking -> it moves during the blink', Math.hypot(during.x - before.x, during.z - before.z) > 0.5, `moved ${Math.hypot(during.x - before.x, during.z - before.z).toFixed(2)} m`);
  // two watchers: blink of one is covered by the other
  await M2.dbg('monsters.tp', { x: pw![0], z: pw![1] + 0.01, yaw, light: 1 });
  watching2 = true;
  await sleep(400);
  const tb2 = performance.now();
  await M1.dbg('monsters.blink', { id: M1.id, inSec: 0.5 });
  const b4 = await mann();
  await sleep(1200);
  const b5 = await mann();
  check('two watchers -> stays frozen through one visor blink', Math.hypot(b5.x - b4.x, b5.z - b4.z) < 0.05 && M1.eventsOf('monsters.blink', tb2).length > 0, `moved ${Math.hypot(b5.x - b4.x, b5.z - b4.z).toFixed(2)} m`);
  // nobody watching -> touch kill
  await M2.dbg('monsters.tp', { x: ML.van.cab.x + 1, z: ML.van.cab.y + 1.5 });
  watching1 = watching2 = false;
  const tk = performance.now();
  const mk = await waitFor(() => M1.eventsOf('monsters.kill', tk).find((e) => (e.d as { victim: string }).victim === M1.id), 4000, 'mannequin kill').catch(() => null);
  const mkd = mk?.d as { killer: string; reason: string; detail: string } | undefined;
  check('unwatched mannequin reaches the player -> kill on touch', !!mkd && mkd.killer === 'mannequin', mkd ? `${mkd.reason} (${mkd.detail})` : 'none');
  clearInterval(reporter);
} catch (e) {
  check('test run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  for (const b of [A, B, C, M1, M2]) b.close();
  await srv.stop();
}
const failed = results.filter((r) => !r.pass);
if (failed.length) console.log(srv.log().split('\n').filter((l) => /monsters|error|warn/i.test(l)).slice(-30).join('\n'));
console.log(`\nListener + Mannequin: ${failed.length ? 'FAILED' : 'PASSED'} ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
