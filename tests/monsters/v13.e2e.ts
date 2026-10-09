// Owner: track (c) Monsters (v1.3). ws-bot e2e on a dev server (no browser, no AI): the night's monster items through
// the real request / noise / snapshot paths.
//  F1  the Listener's wake gate: past its wake time with nothing meaningful heard it stays dormant (logged); its first
//      meaningful line wakes it at once and it acts on that line; the contract-end log line "heard N lines (M before
//      waking), nearest speaker D m" carries no names
//  F2  contract index 1 has no Snatcher, index 2 does (dbg.monsters.start, a site with vents)
//  F3  a 'lure' noise on the real noise bus sends the Hound to it like a bottle
//  F6  (flag earwigs, flipped on in memory) ears in the snapshot's dyn list; a line the Listener did not hear
//      (hearers.listener = false) is relayed by the ear its speaker talked at: the memory line sits at the ear, a tick
//      cue goes out; a flashlight on the ear deafens it (no relay) for 6 s, then it relays again
// Servers: PORT (default 3802) with NODE_ENV=development AI_MODE=mock; SAVES_DIR / SESSION_FILE from the environment.
//   node tests/monsters/v13.e2e.ts
import { BAND } from '../../packages/shared/src/constants.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { Bot, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3802);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = '') => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};
interface EarD { id: string; space: number; callsign: string | null; x: number; z: number; wx: number; wz: number; y: number; nx: number; nz: number; deaf: boolean; relays: number; samples: number }
interface MemD { text: string; ear: string | null; room: number; px: number; pz: number; meaningful: boolean }
interface Ag { id: string; kind: string; x: number; z: number; state: string; active: boolean; dormant?: boolean; held?: boolean; wokeAt?: number | null; memory?: MemD[]; earLines?: number; summary?: string; tx?: number; tz?: number }
interface Dump { time: number; agents: Ag[]; ears: EarD[]; log: { line: string; action: string }[] }

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann'), B = new Bot('Bob');
const layoutOf = (b: Bot, since: number) => waitFor(() => (b.events.filter((e) => e.e === 'phase' && e.at >= since).pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 4000, 'layout');
try {
  await A.connect(url, 'V13M');
  await B.connect(url, 'V13M');
  const dump = () => A.dbg<Dump>('monsters.state');
  const lis = async () => (await dump()).agents.find((a) => a.kind === 'listener')!;
  await A.dbg('monsters.flag', { name: 'director', on: false });

  // ---------------- F2: the Snatcher from contract index 2 ----------------
  let f2 = '';
  for (const seed of ['v13-roster-a', 'v13-roster-b', 'v13-roster-c', 'v13-roster-d']) {
    const t0 = performance.now();
    const s1 = await A.dbg<{ agents: { kind: string }[] }>('monsters.start', { seed, players: 2, risk: 1, contractIndex: 1 });
    const L1 = await layoutOf(A, t0);
    const vents = L1.items.filter((i) => i.kind === 'vent').length;
    if (!vents) continue;
    const s2 = await A.dbg<{ agents: { kind: string }[] }>('monsters.start', { seed: `${seed}`, players: 2, risk: 1, contractIndex: 2 });
    f2 = `${seed} (${vents} vents): index 1 [${s1.agents.map((a) => a.kind).join(',')}], index 2 [${s2.agents.map((a) => a.kind).join(',')}]`;
    check('F2 contract index 1 (risk 1): no Snatcher', !s1.agents.some((a) => a.kind === 'snatcher'), f2);
    check('F2 contract index 2 (risk 1): the Snatcher', s2.agents.some((a) => a.kind === 'snatcher'), f2);
    break;
  }
  check('F2 found a site with vents', !!f2);

  // ---------------- F6 + F1 + F3 on one contract ----------------
  await A.dbg('monsters.flag', { name: 'earwigs', on: true });
  await A.dbg('monsters.tune', { section: 'listener', set: { dormantRealSecRisk1: 5 } });
  const t0 = performance.now();
  await A.dbg('monsters.start', { seed: 'v13-e2e-ears', players: 2, risk: 1, contractIndex: 0 });
  const L = await layoutOf(A, t0);
  const cab = L.van.cab;
  for (const b of [A, B]) await b.dbg('monsters.tp', { x: cab.x + 1, z: cab.y + 1.5 + (b === B ? 1 : 0), light: 0 });
  await A.dbg('monsters.place', { id: 'hound0', outSec: 600 }); // the Hound stays out until the F3 check
  let d0 = await dump();
  check('F6 2 players: 2 ears placed', d0.ears.length === 2, d0.ears.map((e) => `${e.id} ${e.callsign ?? 'corridor'} @${e.x},${e.z}`).join(' | '));
  const dyn = await waitFor(() => { const d = A.snap?.dyn.filter((x) => x.id.startsWith('ear:')) ?? []; return d.length ? d : null; }, 2000, 'dyn').catch(() => []);
  check('F6 the ears ride in the snapshot dyn list (id, mount point + height, wall normal)', dyn.length === 2 && dyn.every((d) => d0.ears.some((e) => e.id === d.id && Math.abs(e.y - d.p[1]) < 0.01 && Math.abs(Math.atan2(e.nx, e.nz) - d.yaw) < 0.01)), JSON.stringify(dyn));

  // F1: past its wake time with 0 lines: it holds
  await waitFor(async () => ((await dump()).time > 6 ? true : null), 9000, 'past wake time');
  const l1 = await lis();
  check('F1 past its wake time with nothing meaningful heard: still dormant (held)', l1.dormant === true && l1.held === true, `${l1.state} held=${l1.held}`);
  check('F1 the hold is logged', /the Listener stays dormant: nothing meaningful heard yet/.test(srv.log()));

  // F6 relay: Ann talks at ear 0 (the Listener cannot hear her: hearers.listener = false); the ear relays the line
  const ear = d0.ears[0];
  const at = { x: ear.x + ear.nx * 0.7, z: ear.z + ear.nz * 0.7 };
  const face = Math.atan2(ear.wx - at.x, ear.wz - at.z);
  await A.dbg('monsters.tp', { x: at.x, z: at.z, yaw: face, light: 0 });
  const cs = L.spaces.find((s) => s.callsign && s.id !== L.entrance && s.id !== ear.space && s.kind !== 'vault')!.callsign!;
  const tr = performance.now();
  A.loud(BAND.talk);
  await sleep(1200);
  A.loud(BAND.silent);
  const r1 = await A.dbg<{ ok: boolean }>('monsters.utter', { segId: 'ear-1', text: `meet me in the ${cs.toLowerCase()}`, listener: false });
  check('F6 a line the Listener did not hear is relayed by the ear', r1.ok);
  const tick = await waitFor(() => A.eventsOf('monsters.cue', tr).find((e) => (e.d as { id: string; cue: string }).id === ear.id && (e.d as { cue: string }).cue === 'tick'), 1500, 'tick').catch(() => null);
  check('F6 the ear ticks (cue tick, id = the ear, 4 m)', !!tick && (tick.d as { radius: number }).radius === 4, tick ? JSON.stringify(tick.d) : 'none');
  const l2 = await waitFor(async () => { const x = await lis(); return x.dormant === false ? x : null; }, 1500, 'woke').catch(() => lis());
  const mem = (l2.memory ?? []).find((m) => m.text.includes(cs.toLowerCase()));
  check('F6 the memory line sits at the ear (room + position = the ear\'s, never the speaker\'s)', !!mem && mem.ear === ear.id && mem.room === ear.space && Math.abs(mem.px - ear.x) < 0.01 && Math.abs(mem.pz - ear.z) < 0.01, JSON.stringify(mem));
  check('F1 its first meaningful line woke it at once', l2.dormant === false, `${l2.state}`);
  // the decision (AI brain in mock mode, or the rule brain) is based on that line: 'it heard "..." through an ear -> ...'
  const dec = await waitFor(async () => (await dump()).log.find((e) => e.line.includes('through an ear')) ?? null, 5000, 'decision').catch(() => null);
  check('F1 and it acted on that line (decision through an ear)', !!dec, dec?.line ?? 'none');
  check('F1 the wake is logged as on its first meaningful line', /woke up \(\d+ lines in memory, on its first meaningful line after \d+ s more\)/.test(srv.log()));
  await A.dbg('monsters.place', { id: 'listener0', outSec: 600 }); // out of the way (ears still relay into its memory)

  // F6 deafen: Ann's flashlight on the ear
  await A.dbg('monsters.tp', { x: at.x, z: at.z, yaw: face, light: 1 });
  await sleep(600);
  const e1 = (await dump()).ears.find((e) => e.id === ear.id)!;
  check('F6 a flashlight on the ear makes it deaf', e1.deaf === true);
  A.loud(BAND.talk);
  await sleep(1200);
  A.loud(BAND.silent);
  const r2 = await A.dbg<{ ok: boolean }>('monsters.utter', { segId: 'ear-2', text: 'the code is four seven one nine', listener: false });
  check('F6 a deaf ear relays nothing', !r2.ok);
  await A.dbg('monsters.tp', { x: at.x, z: at.z, yaw: face, light: 0 });
  await sleep(4000);
  const e2 = (await dump()).ears.find((e) => e.id === ear.id)!;
  check('F6 still deaf 4 s after the light went off', e2.deaf === true);
  await sleep(2700);
  const e3 = (await dump()).ears.find((e) => e.id === ear.id)!;
  check('F6 hears again ~6 s after', e3.deaf === false);
  A.loud(BAND.talk);
  await sleep(1200);
  A.loud(BAND.silent);
  const r3 = await A.dbg<{ ok: boolean }>('monsters.utter', { segId: 'ear-3', text: 'regroup at the levers', listener: false });
  check('F6 and relays again', r3.ok);

  // F3: a 'lure' noise on the real noise bus: the Hound goes for it like a bottle
  const hs = L.spaces.find((s) => s.kind === 'room' && s.id !== L.entrance && s.rect.w >= 4 && s.rect.h >= 3)!;
  const hx = hs.rect.x + 1.5, hz = hs.rect.y + 1.5;
  await A.dbg('monsters.place', { id: 'hound0', x: hx, z: hz, state: 'idle', active: true });
  await A.dbg('monsters.noise', { x: hx + 2, z: hz + 1, radiusM: 12, kind: 'lure', source: '' });
  const h = await waitFor(async () => { const x = (await dump()).agents.find((a) => a.kind === 'hound'); return x && (x.state === 'bottle' || x.state === 'sniff') ? x : null; }, 1500, 'hound bottle').catch(() => null);
  check('F3 the Hound goes for a lure noise like a bottle', !!h, h ? `${h.state} -> ${h.tx},${h.tz}` : 'no');
  await A.dbg('monsters.place', { id: 'hound0', outSec: 600 });

  // F1: the contract-end line
  const lsum = (await lis()).summary ?? '';
  await A.dbg('monsters.stop');
  await sleep(300);
  const endLine = srv.log().split('\n').filter((l) => l.includes('contract end: the Listener heard')).pop() ?? '';
  check('F1 contract-end log line: heard N lines (M before waking), nearest speaker D m', /contract end: the Listener heard \d+ lines \(\d+ before waking, \d+ through ears\), nearest speaker [\d.]+ m; woke at \d+ s/.test(endLine), endLine.trim() || lsum);
  check('F1 ... and it carries no names', !!endLine && !/Ann|Bob/.test(endLine));
} finally {
  A.close(); B.close();
  await srv.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(`FAILED:\n${failed.map((f) => `  ${f.name} ${f.info}`).join('\n')}`);
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
