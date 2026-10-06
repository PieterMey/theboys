// P3 QA soak: 4 Chrome players (separate processes, fake mics talk_en / whisper / shout / silence) + 2 ws bots go
// through the REAL lobby flow (meta.pick -> meta.ready -> drive -> contract) with monsters ON:
//   contract 1: real speed (dbg.meta.contractSec, default 300 s), ends by the 04:00 departure
//   contract 2: shorter, everyone back in the van, the bot pulls the leave-now lever
//   contract 3: dbg shortcuts -> shift end -> HR memo (template) -> next shift (promoted) or fired
// Watches: server log trouble lines, client __game.errors(), snapshot rate (client diag + server dbg.stats),
// server working set + client JS heaps, voice peers (__voiceDebug.peers()), results -> hub transitions.
// Run against YOUR OWN dev server (never :3000):
//   PORT=3096 NET_SESSION=0 SAVES_DIR=<tmp> AI_MODE=mock node apps/server/src/index.ts --dev > server.log
//   BASE_URL=http://127.0.0.1:3096 node tests/qa/soak.e2e.ts --log <server.log> [--sec 300] [--sec2 120] [--crew QABC]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetaState } from '../../packages/shared/src/messages/meta.ts';
import type { WorkOrder } from '../../packages/shared/src/workorder.ts';
import {
  BASE, OUT, WS_URL, botAlive, botShift, connectBot, dbg, gcHeapMB, gpuRes, log, probe, procMB, qaPlayer, randomCrew, req, serverPid, serverTrouble,
  shot, sleep, st, vanInside, waitPhase,
} from './lib.ts';
import type { Bot, PageProbe, QaPlayer } from './lib.ts';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const CREW = arg('crew') ?? randomCrew();
const LOG_FILE = arg('log') ?? process.env.QA_SERVER_LOG ?? '';
const SEC1 = Number(arg('sec', '300'));
const SEC2 = Number(arg('sec2', '120'));
const SKIP1 = process.argv.includes('--quick'); // contract 1 shortened as well (smoke run of the script)

interface Sample { t: number; phase: string; server: { tickHz: number; snapHz: number; snapSkipped: number; mb: number }; pages: PageProbe[]; bots: { name: string; alive: boolean; corrections: number }[] }
const samples: Sample[] = [];
const problems: string[] = [];
const leak: { at: string; pages: { name: string; heapMB: number; geometries: number; textures: number; objects: number }[] }[] = [];
const notes: string[] = [];
const players: QaPlayer[] = [];
const bots: Bot[] = [];
let logOffset = 0;
const pid = serverPid();
let lastStats: { snaps: number; ticks: number; at: number; skipped: number } | null = null;

const problem = (s: string) => { problems.push(s); log(`PROBLEM: ${s}`); };
const note = (s: string) => { notes.push(s); log(s); };

async function sample(label: string): Promise<Sample> {
  const lead = players[0];
  const stats = await dbg<{ ticks: number; snaps: number; snapSkipped: number; tickHz: number; snapHz: number }>(lead.page, 'stats').catch(() => null);
  const now = performance.now();
  let tickHz = 0, snapHz = 0, skipped = 0;
  if (stats && lastStats) {
    const dt = (now - lastStats.at) / 1000;
    tickHz = Math.round(((stats.ticks - lastStats.ticks) / dt) * 10) / 10;
    snapHz = Math.round(((stats.snaps - lastStats.snaps) / dt) * 10) / 10;
    skipped = stats.snapSkipped - lastStats.skipped;
  }
  if (stats) lastStats = { snaps: stats.snaps, ticks: stats.ticks, at: now, skipped: stats.snapSkipped };
  const pages = await Promise.all(players.map((p) => probe(p).catch((e) => ({ name: p.name, phase: 'ERR', net: String(e).slice(0, 60) } as unknown as PageProbe))));
  const s: Sample = {
    t: Math.round(now / 1000), phase: pages[0]?.phase ?? '?', server: { tickHz, snapHz, snapSkipped: skipped, mb: procMB(pid) }, pages,
    bots: bots.map((b) => ({ name: b.name, alive: botAlive(b), corrections: b.corrections })),
  };
  samples.push(s);
  const tr = serverTrouble(LOG_FILE, logOffset);
  logOffset = tr.size;
  for (const l of tr.lines) problem(`server: ${l.slice(0, 300)}`);
  log(`[${label}] ${s.phase} server tick ${tickHz} Hz snap ${snapHz} Hz skip ${skipped} ${s.server.mb} MB | ` +
    pages.map((p) => `${p.name}:${p.phase}/${p.alive ? 'A' : 'D'} ${p.fps}fps snap ${p.snapHz} rtt ${p.rtt} err ${p.errors} heap ${p.heapMB} voice ${p.voice?.connected}/${p.voice?.peers}`).join(' | ') +
    ` | bots ${s.bots.map((b) => `${b.name}:${b.alive ? 'A' : 'D'}`).join(' ')}`);
  return s;
}

/** random walk with the flashlight on until stop() (players also talk through their fake mics) */
function wander(p: QaPlayer, seed: number): { stop(): void } {
  let on = true;
  let k = seed;
  const rnd = () => { k = (k * 16807) % 2147483647; return k / 2147483647; };
  void (async () => {
    await p.page.evaluate(() => window.__game!.setInput({ flashlight: true })).catch(() => {});
    while (on) {
      const yaw = rnd() * Math.PI * 2;
      await p.page.evaluate(([y, fw, sp]) => { window.__game!.look(y, 0); window.__game!.setInput({ forward: fw, right: 0, sprint: sp, crouch: false }); }, [yaw, rnd() < 0.85 ? 1 : 0, rnd() < 0.15] as const).catch(() => {});
      await sleep(1800 + rnd() * 2500);
    }
    await p.page.evaluate(() => window.__game!.setInput({ forward: 0, right: 0, sprint: false })).catch(() => {});
  })();
  return { stop: () => { on = false; } };
}

async function leakPoint(at: string): Promise<void> {
  const pages = await Promise.all(players.map(async (p) => ({ name: p.name, heapMB: await gcHeapMB(p.page).catch(() => -1), ...(await gpuRes(p.page).catch(() => ({ geometries: -1, textures: -1, objects: -1, programs: -1 }))) })));
  leak.push({ at, pages });
  log(`[leak ${at}] ` + pages.map((x) => `${x.name}: heap ${x.heapMB} MB geo ${x.geometries} tex ${x.textures} obj ${x.objects}`).join(' | '));
}

async function metaState(p: QaPlayer): Promise<{ meta: MetaState; workOrders: WorkOrder[]; activeOrder: WorkOrder | null }> {
  return req(p.page, 'meta.state');
}

async function lobbyToContract(label: string): Promise<WorkOrder> {
  const lead = players[0];
  const ms = await metaState(lead);
  const order = ms.workOrders.find((o) => o.available)!;
  const pk = await req<{ ok: boolean; reason?: string }>(lead.page, 'meta.pick', { orderId: order.id });
  if (!pk.ok) problem(`${label}: meta.pick failed: ${pk.reason}`);
  log(`${label}: leader picked ${order.siteName} (risk ${order.risk}, ${order.id})`);
  await Promise.all([...players.map((p) => req(p.page, 'meta.ready', { ready: true })), ...bots.map((b) => b.req('meta.ready', { ready: true }))]);
  await Promise.all(players.map((p) => waitPhase(p.page, 'drive', 15_000)));
  log(`${label}: everyone ready -> drive`);
  await Promise.all(players.map((p) => waitPhase(p.page, 'contract', 30_000)));
  await Promise.all(bots.map((b) => b.waitFor(() => b.full?.phase === 'contract' && !!b.obj?.active && !!b.layout, 15_000, 'contract')));
  log(`${label}: contract started (${(await st(lead.page)).layout?.seed})`);
  return order;
}

async function resultsToHub(label: string, expectContract: number): Promise<MetaState> {
  const lead = players[0];
  const ms = await metaState(lead);
  const r = ms.meta.results;
  if (!r) problem(`${label}: no results in phase ${(await st(lead.page)).phase}`);
  else note(`${label} results: outcome ${r.outcome}, hauled ${r.hauled}/${r.lootTotal}, core ${r.coreExtracted}, survivors ${r.survivors.length}, deaths ${r.deaths.map((d) => `${d.name}:${d.killer}`).join(',') || '-'}, xp ${r.xp.length}, shift ${r.shiftHauled}/${r.quota}, shiftEnd ${r.shiftEnd}${ms.meta.review ? `, review ${ms.meta.review.verdict}` : ''}`);
  for (const p of players) {
    const s = await st(p.page);
    if (s.screen !== 'results' && s.screen !== 'memo') problem(`${label}: ${p.name} screen '${s.screen}' in results`);
  }
  await shot(lead.page, `soak-${label}-results`).catch(() => '');
  const cont = await req<{ ok: boolean; reason?: string }>(lead.page, 'meta.continue');
  if (!cont.ok) problem(`${label}: meta.continue: ${cont.reason}`);
  await Promise.all(players.map((p) => waitPhase(p.page, 'hub', 20_000)));
  await Promise.all(bots.map((b) => b.waitFor(() => b.full?.phase === 'hub', 10_000, 'hub')));
  await sleep(1500);
  const hub = (await metaState(lead)).meta;
  log(`${label}: back in the van: shift ${hub.shift.index} contract ${hub.shift.contract}, hauled ${hub.shift.hauled}/${hub.shift.quota}, balance ${hub.shift.balance}`);
  if (hub.shift.contract !== expectContract) problem(`${label}: shift.contract ${hub.shift.contract} != ${expectContract}`);
  for (const p of players) {
    const s = await st(p.page);
    if (s.screen !== 'none') problem(`${label}: ${p.name} still on screen '${s.screen}' in the hub`);
  }
  return hub;
}

let code = 0;
const tStart = performance.now();
try {
  log(`QA soak against ${BASE} crew ${CREW} (server pid ${pid}, log ${LOG_FILE || 'none'})`);
  if (LOG_FILE) logOffset = serverTrouble(LOG_FILE, 0).size;
  // ---------- join: 4 browsers (Ann = leader) + 2 bots
  const roster: [string, string][] = [['Ann', 'talk_en.wav'], ['Bea', 'whisper.wav'], ['Cid', 'shout.wav'], ['Dax', 'silence.wav']];
  for (const [i, [name, wav]] of roster.entries()) {
    const t0 = performance.now();
    players.push(await qaPlayer(name, wav, CREW, { viewport: i === 0 ? { width: 640, height: 360 } : { width: 320, height: 180 }, query: i === 0 ? {} : { preset: 'high' } }));
    log(`${name} joined (${wav}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  for (const name of ['Bot-E', 'Bot-F']) bots.push(await connectBot({ url: WS_URL, crew: CREW, name }));
  await sleep(4000);
  const s0 = await st(players[0].page);
  const leader = s0.crew?.players.find((p) => p.isLeader);
  log(`crew ${s0.crew?.code}: ${s0.crew?.players.length} players, leader ${leader?.name}`);
  if (s0.crew?.players.length !== 6) problem(`roster has ${s0.crew?.players.length} players, expected 6`);
  if (leader?.name !== 'Ann') problem(`leader is ${leader?.name}, expected Ann`);
  await sample('hub');
  await leakPoint('hub0');
  await shot(players[0].page, 'soak-hub').catch(() => '');

  // ---------- contract 1: real speed
  const sec1 = SKIP1 ? 60 : SEC1;
  await dbg(players[0].page, 'meta.contractSec', { sec: sec1 });
  const o1 = await lobbyToContract('c1');
  await sleep(3000);
  await sample('c1-start');
  const w1 = players.map((p, i) => wander(p, 1000 + i * 77));
  const deadline1 = performance.now() + sec1 * 1000 - 25_000;
  const work1 = botShift(bots[0], bots[1], { deadlineMs: deadline1 }).then((d) => { note(`c1 bots did: ${d.join(', ') || 'nothing'}`); return d; });
  let shots = 0;
  const end1 = performance.now() + (sec1 + 120) * 1000;
  while (performance.now() < end1) {
    await sleep(15_000);
    const s = await sample('c1');
    if (shots < 3 && s.phase === 'contract') await shot(players[0].page, `soak-c1-${shots++}`).catch(() => '');
    if (s.pages.every((p) => p.phase === 'results')) break;
  }
  for (const w of w1) w.stop();
  await work1.catch(() => undefined);
  await Promise.all(players.map((p) => waitPhase(p.page, 'results', 30_000))).catch((e) => problem(`c1 did not reach results: ${e}`));
  await sleep(2000);
  await sample('c1-results');
  // voice: every Chrome pair connected at least once during the contract
  for (const s of samples.filter((x) => x.phase === 'contract')) {
    for (const p of s.pages) if (p.voice && p.voice.peers >= 3 && p.voice.connected < 3) { problem(`c1 voice: ${p.name} ${p.voice.connected}/${p.voice.peers} peers connected at t=${s.t} (${p.voice.states.join(' ')})`); break; }
  }
  const hub1 = await resultsToHub('c1', 1);
  await leakPoint('hub1');
  void o1;

  // ---------- contract 2: same crew, state carried, leave-now lever
  await dbg(players[0].page, 'meta.contractSec', { sec: SEC2 });
  const o2 = await lobbyToContract('c2');
  void o2;
  await sleep(2500);
  const w2 = players.map((p, i) => wander(p, 5000 + i * 31));
  const deadline2 = performance.now() + (SEC2 - 35) * 1000;
  const work2 = botShift(bots[0], bots[1], { deadlineMs: deadline2 }).then((d) => { note(`c2 bots did: ${d.join(', ') || 'nothing'}`); return d; });
  while (performance.now() < deadline2) {
    await sleep(15_000);
    const s = await sample('c2');
    if (s.pages.every((p) => p.phase === 'results')) break;
  }
  for (const w of w2) w.stop();
  await work2.catch(() => undefined);
  if ((await st(players[0].page)).phase === 'contract') {
    // everyone into the van (living players only), then the bot pulls the leave-now lever
    const [vx, vz] = vanInside(bots[0]);
    for (const [i, p] of players.entries()) {
      const x = vx + (i % 2 ? 0.45 : -0.45), z = vz + (i < 2 ? -0.6 : 0.4);
      await dbg(p.page, 'net.teleport', { x, z, yaw: 0 }).catch(() => undefined);
      await p.page.evaluate(([xx, zz]) => window.__game!.teleport(xx, zz, 0), [x, z] as const).catch(() => {});
    }
    for (const b of bots) if (botAlive(b)) await b.teleport(vx, vz, 0);
    await sleep(1500);
    const puller = bots.find(botAlive);
    let left = { ok: false, msg: 'no living bot' } as { ok: boolean; msg?: string };
    for (let i = 0; i < 4 && !left.ok; i++) {
      left = puller ? await puller.req('objectives.leave', {}) : await req<{ ok: boolean; msg?: string }>(players.find((p) => p)!.page, 'objectives.leave', {});
      if (!left.ok) { log(`c2 leave: ${left.msg}`); await sleep(1500); }
    }
    if (!left.ok) problem(`c2: leave-now lever refused: ${left.msg}`);
  }
  await Promise.all(players.map((p) => waitPhase(p.page, 'results', 40_000))).catch((e) => problem(`c2 did not reach results: ${e}`));
  await sleep(1500);
  await sample('c2-results');
  const hub2 = await resultsToHub('c2', 2);
  await leakPoint('hub2');
  if (hub2.shift.hauled < hub1.shift.hauled) problem(`c2: shift hauled went down (${hub1.shift.hauled} -> ${hub2.shift.hauled})`);
  if (hub2.shift.quota !== hub1.shift.quota) problem(`c2: quota changed mid-shift (${hub1.shift.quota} -> ${hub2.shift.quota})`);

  // ---------- contract 3 via dbg shortcuts -> shift end -> HR memo
  await req(players[0].page, 'meta.pick', { orderId: (await metaState(players[0])).workOrders.find((o) => o.available)!.id });
  await Promise.all([...players.map((p) => req(p.page, 'meta.ready', { ready: true })), ...bots.map((b) => b.req('meta.ready', { ready: true }))]);
  await waitPhase(players[0].page, 'drive', 15_000);
  await dbg(players[0].page, 'meta.skipDrive');
  await Promise.all(players.map((p) => waitPhase(p.page, 'contract', 30_000)));
  await sleep(3000);
  const end3 = await dbg<{ ok: boolean; phase: string }>(players[0].page, 'meta.endContract', { real: true });
  if (!end3.ok) problem(`c3: dbg.meta.endContract -> ${JSON.stringify(end3)}`);
  await Promise.all(players.map((p) => waitPhase(p.page, 'results', 20_000)));
  await sleep(1500);
  const ms3 = await metaState(players[0]);
  const rev = ms3.meta.review;
  if (!ms3.meta.results?.shiftEnd || !rev) problem(`c3: no shift-end review (shiftEnd ${ms3.meta.results?.shiftEnd})`);
  else note(`c3 shift review: ${rev.verdict}, hauled ${rev.hauled}/${rev.quota}, memos ${rev.memos.length}, letter ${rev.letter ? rev.letter.length : 0} chars`);
  for (const p of players) {
    const s = await st(p.page);
    if (s.screen !== 'memo' && s.screen !== 'results') problem(`c3: ${p.name} sees '${s.screen}' at shift end`);
  }
  await shot(players[0].page, 'soak-c3-memo').catch(() => '');
  const cont3 = await req<{ ok: boolean; reason?: string }>(players[0].page, 'meta.continue');
  if (!cont3.ok) problem(`c3 continue: ${cont3.reason}`);
  await Promise.all(players.map((p) => waitPhase(p.page, 'hub', 20_000)));
  await sleep(1500);
  const hub3 = (await metaState(players[0])).meta;
  note(`after shift: index ${hub3.shift.index}, contract ${hub3.shift.contract}, quota ${hub3.shift.quota}, balance ${hub3.shift.balance}, quotasMet ${hub3.shift.quotasMet}`);
  if (rev?.verdict === 'promoted' && hub3.shift.index !== 1) problem(`promoted but shift index ${hub3.shift.index}`);
  if (rev?.verdict === 'fired' && (hub3.shift.index !== 0 || hub3.shift.hauled !== 0)) problem(`fired but shift ${JSON.stringify(hub3.shift)}`);
  await sample('end');
  await leakPoint('hub3');
  const first = leak[0], last = leak[leak.length - 1];
  for (const [i, p] of last.pages.entries()) {
    const a = first.pages[i];
    if (a && p.heapMB > a.heapMB * 1.5 + 40) problem(`client heap after GC grew ${a.heapMB} -> ${p.heapMB} MB over 3 contracts (${p.name})`);
    if (a && a.geometries > 0 && p.geometries > a.geometries * 1.3 + 50) problem(`GPU geometries grew ${a.geometries} -> ${p.geometries} over 3 contracts (${p.name})`);
    if (a && a.textures > 0 && p.textures > a.textures * 1.3 + 20) problem(`GPU textures grew ${a.textures} -> ${p.textures} over 3 contracts (${p.name})`);
  }

  // ---------- client errors over the whole run
  for (const p of players) {
    const errs = await p.page.evaluate(() => window.__game!.errors()).catch(() => [] as string[]);
    const pageErrs = p.errors.filter((e) => !/favicon|ERR_ABORTED/.test(e));
    if (errs.length) problem(`${p.name} __game.errors(): ${errs.length}: ${errs.slice(0, 5).join(' || ').slice(0, 600)}`);
    if (pageErrs.length) problem(`${p.name} console/page/http errors: ${pageErrs.length}: ${pageErrs.slice(0, 5).join(' || ').slice(0, 600)}`);
  }
  // ---------- rates + memory
  const contractSamples = samples.filter((s) => s.phase === 'contract' && s.server.snapHz > 0);
  const minServerSnap = Math.min(...contractSamples.map((s) => s.server.snapHz));
  const minClientSnap = Math.min(...contractSamples.flatMap((s) => s.pages.filter((p) => p.phase === 'contract').map((p) => p.snapHz)));
  note(`snapshot rate during contracts: server min ${minServerSnap} Hz, client min ${minClientSnap} Hz over ${contractSamples.length} samples`);
  if (minServerSnap < 18 || minClientSnap < 18) problem(`snapshot rate below 18 Hz (server ${minServerSnap}, client ${minClientSnap})`);
  const mb = samples.map((s) => s.server.mb).filter((x) => x > 0);
  note(`server working set: first ${mb[0]} MB, max ${Math.max(...mb)} MB, last ${mb[mb.length - 1]} MB`);
  const heaps = players.map((p, i) => { const h = samples.map((s) => s.pages[i]?.heapMB ?? 0).filter((x) => x > 0); return `${p.name} ${h[0]}->${h[h.length - 1]} (max ${Math.max(...h)})`; });
  note(`client JS heaps MB: ${heaps.join(', ')}`);
} catch (e) {
  code = 1;
  problem(`soak aborted: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  for (const p of players) await shot(p.page, `soak-abort-${p.name}`).catch(() => '');
} finally {
  const file = join(OUT, `soak-${CREW}.json`);
  writeFileSync(file, JSON.stringify({ crew: CREW, base: BASE, minutes: Math.round((performance.now() - tStart) / 600) / 100, problems, notes, leak, samples, console: Object.fromEntries(players.map((p) => [p.name, p.console.filter((l) => l.includes('[voice]') || / error: /.test(l)).slice(-400)])) }, null, 1));
  log(`report: ${file}`);
  log(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  for (const b of bots) b.close();
  for (const p of players) await p.close().catch(() => {});
  if (problems.length) code = 1;
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}
