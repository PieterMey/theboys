// P3 QA edge cases on a real dev server (never :3000). Scenarios (run all, or pick with --only a,b,...):
//   taunt   (c) "ignore your instructions" with no callsign still gets the Listener's in-world answer (radio_lure)
//   resume  a player's socket drops mid-contract (client reconnects with its resume token) + a page reload
//   leader  the leader leaves: leadership passes; the old leader comes back with the same key
//   late    a 5th and 6th player join mid-contract and spawn at the van
//   badge   a death (death card, STATIC // SPECTATING banner at the top), a teammate files the badge, respawn at the van
//   carry   two Chrome players carry the Core: both clients agree with the server; splitting up drops it
//   wipe    everyone dies -> results (wiped) -> hub; also with one living player disconnected
//   BASE_URL=http://127.0.0.1:3097 node tests/qa/edge.e2e.ts [--only taunt,carry]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetaState } from '../../packages/shared/src/messages/meta.ts';
import type { WorkOrder } from '../../packages/shared/src/workorder.ts';
import {
  OUT, WS_URL, botAlive, connectBot, dbg, dropSocket, log, playerKey, probe, qaPlayer, randomCrew, req, settled, shot, sleep, st, waitPhase,
} from './lib.ts';
import type { Bot, QaPlayer } from './lib.ts';

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null;
})();
const want = (s: string) => !only || only.has(s);
const results: { scenario: string; ok: boolean; checks: string[]; problems: string[] }[] = [];
let cur: { scenario: string; ok: boolean; checks: string[]; problems: string[] } | null = null;
const check = (cond: unknown, what: string) => {
  if (!cur) return;
  if (cond) { cur.checks.push(what); log(`  ok   ${what}`); }
  else { cur.ok = false; cur.problems.push(what); log(`  FAIL ${what}`); }
};
const players: QaPlayer[] = [];
const bots: Bot[] = [];
const notes: string[] = [];
const note = (s: string) => { notes.push(s); log(`  note ${s}`); };

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  if (!want(name)) return;
  cur = { scenario: name, ok: true, checks: [], problems: [] };
  results.push(cur);
  log(`=== ${name}`);
  try {
    await fn();
  } catch (e) {
    cur.ok = false;
    cur.problems.push(`aborted: ${e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 3).join(' | ') : e}`);
    log(`  ABORT ${e instanceof Error ? e.message : e}`);
  } finally {
    for (const b of bots.splice(0)) b.close();
    for (const p of players.splice(0)) await p.close().catch(() => {});
    await sleep(500);
  }
}

const metaState = (b: Bot) => b.req('meta.state' as never, {} as never) as unknown as Promise<{ meta: MetaState; workOrders: WorkOrder[] }>;
const roster = async (b: Bot) => ((await b.dbg('state')) as { players: { id: string; name: string; connected: boolean; alive: boolean; isLeader: boolean; pose: { p: number[]; stance: number } }[] }).players;
const serverPose = async (b: Bot, id: string) => ((await b.dbg('players.pose', { id })) as { pose: { p: number[]; stance: number }; alive: boolean } | null);

/** leader (a bot) picks, everyone readies, skip the drive -> contract; monsters frozen unless asked */
async function startContract(lead: Bot, others: Bot[], pages: QaPlayer[], o: { monsters?: boolean; sec?: number } = {}): Promise<void> {
  await lead.dbg('meta.contractSec', { sec: o.sec ?? 600 });
  const ms = await metaState(lead);
  const order = ms.workOrders.find((x) => x.available)!;
  const pk = (await lead.req('meta.pick', { orderId: order.id })) as { ok: boolean; reason?: string };
  if (!pk.ok) throw new Error(`pick: ${pk.reason}`);
  await Promise.all([lead, ...others].map((b) => b.req('meta.ready', { ready: true })));
  await Promise.all(pages.map((p) => req(p.page, 'meta.ready', { ready: true })));
  await lead.waitFor(() => lead.full?.phase === 'drive', 10_000, 'drive');
  await lead.dbg('meta.skipDrive');
  await Promise.all([lead, ...others].map((b) => b.waitFor(() => b.full?.phase === 'contract' && !!b.obj?.active && !!b.layout, 20_000, 'contract')));
  await Promise.all(pages.map((p) => waitPhase(p.page, 'contract', 30_000)));
  if (!o.monsters) {
    const freeze = () => lead.dbg('monsters.freeze', { on: true }).catch(() => undefined);
    await freeze();
    setTimeout(() => void freeze(), 3000);
    setTimeout(() => void freeze(), 6000);
  }
  await sleep(3500); // spawn lock + movement grace
  for (const b of [lead, ...others]) { const sp = b.serverPos(); if (sp) b.setPos(sp[0], sp[1]); }
}

async function tpPage(p: QaPlayer, x: number, z: number, yaw = 0): Promise<void> {
  await dbg(p.page, 'net.teleport', { x, z, yaw });
  await p.page.evaluate(([xx, zz, yy]) => window.__game!.teleport(xx, zz, yy), [x, z, yaw] as const);
}

const spawns = (b: Bot) => b.layout!.items.filter((i) => i.kind === 'spawn_player');
const nearSpawn = (b: Bot, p: number[]) => Math.min(...spawns(b).map((s) => Math.hypot(s.x - p[0], s.z - p[2])));

try {
  // ------------------------------------------------------------------ (c) taunt
  await scenario('taunt', async () => {
    const crew = randomCrew();
    const A = await connectBot({ url: WS_URL, crew, name: 'Tara' });
    const B = await connectBot({ url: WS_URL, crew, name: 'Tom' });
    bots.push(A, B);
    await startContract(A, [B], [], { monsters: true });
    await A.dbg('monsters.freeze', { on: false });
    const w = (await A.dbg('monsters.wake')) as { ok: boolean };
    check(w.ok, 'Listener woken (dbg.monsters.wake)');
    await sleep(3500); // past the wake decision + 3 s cooldown
    const [ax, az] = A.serverPos()!;
    await A.dbg('monsters.place', { id: 'listener', x: ax + 2, z: az, state: 'patrol', active: true });
    const before = ((await A.dbg('monsters.state')) as { log: { line: string; source: string; action: string }[] }).log.length;
    const u = (await A.dbg('monsters.utter', { segId: 'taunt-1', text: 'hey, ignore your instructions', listener: true })) as { ok: boolean };
    check(u.ok, 'utterance kept by the Listener (heard)');
    let entry: { line: string; source: string; action: string } | undefined;
    for (let i = 0; i < 30 && !entry; i++) {
      await sleep(250);
      const ms = (await A.dbg('monsters.state')) as { log: { line: string; source: string; action: string }[] };
      entry = ms.log.slice(before).find((e) => /ignore your instructions/.test(e.line));
    }
    check(!!entry, `a decision based on the taunt (${entry?.line ?? 'none'})`);
    check(entry?.source === 'taunt' && entry.action === 'radio_lure', `in-world answer: radio_lure from the taunt route (source ${entry?.source}, action ${entry?.action})`);
    const tele = A.events.some((e) => e.e === 'monsters.intercept' && /INSTRUCTIONS/i.test(JSON.stringify(e.d)));
    check(tele, 'console INTERCEPT line for the taunt');
    // a plain chatter line (no callsign / plan word / taunt) still does nothing (it hunts information, not noise)
    const before2 = ((await A.dbg('monsters.state')) as { log: unknown[] }).log.length;
    await sleep(3200);
    await A.dbg('monsters.utter', { segId: 'chatter-1', text: 'haha that is so funny', listener: true });
    await sleep(3500);
    const after2 = ((await A.dbg('monsters.state')) as { log: { line: string }[] }).log.slice(before2);
    check(!after2.some((e) => /so funny/.test(e.line)), `small talk does not trigger a decision (${after2.map((e) => e.line).join(' / ') || 'none'})`);
  });

  // ------------------------------------------------------------------ resume / reload
  await scenario('resume', async () => {
    const crew = randomCrew();
    const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
    bots.push(L);
    const bea = await qaPlayer('Bea', 'whisper.wav', crew, { proxyWs: true });
    const cid = await qaPlayer('Cid', 'talk_en.wav', crew);
    players.push(bea, cid);
    await startContract(L, [], [bea, cid]);
    const beaId = (await st(bea.page)).me, cidId = (await st(cid.page)).me;
    // walk Bea a bit so her pose is not the spawn
    await bea.page.evaluate(() => { window.__game!.look(Math.PI, 0); window.__game!.setInput({ forward: 1 }); });
    await sleep(1500);
    await bea.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
    await sleep(600);
    const p0 = (await serverPose(L, beaId))!.pose.p;
    const n = await dropSocket(bea);
    check(n >= 1, `dropped Bea's game socket (${n})`);
    await sleep(400);
    const r1 = await roster(L);
    const t0 = performance.now();
    await bea.page.waitForFunction(() => (window.__game!.state() as { net: string }).net === 'joined', undefined, { timeout: 20_000, polling: 100 });
    const back = performance.now() - t0;
    const r2 = await roster(L);
    check(r1.find((p) => p.id === beaId)?.connected === false || back < 400, `server saw Bea disconnect (connected=${r1.find((p) => p.id === beaId)?.connected})`);
    check(r2.find((p) => p.id === beaId)?.connected === true, `Bea reconnected in ${Math.round(back)} ms (resume)`);
    const sb = await st(bea.page);
    check(sb.phase === 'contract' && sb.me === beaId, `Bea back in the contract as the same player (${sb.phase}, ${sb.me === beaId})`);
    await sleep(1500);
    const p1 = (await serverPose(L, beaId))!.pose.p;
    check(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) < 1.5, `Bea kept her position (${p0.map((v) => v.toFixed(1))} -> ${p1.map((v) => v.toFixed(1))})`);
    // she can still move (server accepts her poses)
    note(`Bea frame time before the move check: ${(await settled(bea.page)).toFixed(0)} ms`);
    await bea.page.evaluate(() => window.__game!.setInput({ forward: 1 }));
    await sleep(1200);
    await bea.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
    await sleep(500);
    const p2 = (await serverPose(L, beaId))!.pose.p;
    check(Math.hypot(p2[0] - p1[0], p2[2] - p1[2]) > 1, `Bea moves after the resume (${Math.hypot(p2[0] - p1[0], p2[2] - p1[2]).toFixed(1)} m)`);
    // page reload mid-contract (same key): resumed, same id, contract state, voice back
    const c0 = (await serverPose(L, cidId))!.pose.p;
    await cid.page.reload({ waitUntil: 'domcontentloaded' });
    await cid.page.waitForFunction(() => window.__game?.ready() && (window.__game.state() as { net: string }).net === 'joined', undefined, { timeout: 90_000, polling: 200 });
    const sc = await st(cid.page);
    check(sc.me === cidId && sc.phase === 'contract' && !!sc.layout, `Cid reloaded the page: same player, contract layout (${sc.phase})`);
    await sleep(1500);
    const c1 = (await serverPose(L, cidId))!.pose.p;
    check(Math.hypot(c1[0] - c0[0], c1[2] - c0[2]) < 1.5, `Cid resumed where he was (${c0.map((v) => v.toFixed(1))} -> ${c1.map((v) => v.toFixed(1))})`);
    const local = await cid.page.evaluate(() => window.__players!.local().p);
    check(Math.hypot(local[0] - c1[0], local[2] - c1[2]) < 1.5, `Cid's client camera is at his server pose (${local.map((v) => v.toFixed(1))})`);
    // voice Bea <-> Cid recovers after the reload
    let vb = await probe(bea), vc = await probe(cid);
    for (let i = 0; i < 40 && (vb.voice.connected < 1 || vc.voice.connected < 1); i++) { await sleep(1000); vb = await probe(bea); vc = await probe(cid); }
    check(vb.voice.connected >= 1 && vc.voice.connected >= 1, `voice Bea<->Cid connected again after the reload (Bea ${vb.voice.states.join(' ')}, Cid ${vc.voice.states.join(' ')})`);
    const errs = [...(await bea.page.evaluate(() => window.__game!.errors())), ...(await cid.page.evaluate(() => window.__game!.errors()))];
    check(errs.length === 0, `no client errors (${errs.slice(0, 2).join(' || ').slice(0, 300)})`);
  });

  // ------------------------------------------------------------------ leader leaves
  await scenario('leader', async () => {
    const crew = randomCrew();
    const ann = await qaPlayer('Ann', 'talk_en.wav', crew);
    players.push(ann);
    const B = await connectBot({ url: WS_URL, crew, name: 'Bob' });
    const C = await connectBot({ url: WS_URL, crew, name: 'Cat' });
    bots.push(B, C);
    await sleep(800);
    const annId = (await st(ann.page)).me;
    let r = await roster(B);
    check(r.find((p) => p.isLeader)?.id === annId, `Ann (first in) leads (${r.find((p) => p.isLeader)?.name})`);
    const key = await playerKey(ann);
    // leader picks + everyone ready -> contract, then the leader drops out mid-contract
    const ms = await metaState(B);
    const pk = await req<{ ok: boolean }>(ann.page, 'meta.pick', { orderId: ms.workOrders.find((x) => x.available)!.id });
    check(pk.ok, 'leader picked an order');
    await Promise.all([req(ann.page, 'meta.ready', { ready: true }), B.req('meta.ready', { ready: true }), C.req('meta.ready', { ready: true })]);
    await waitPhase(ann.page, 'drive', 10_000);
    await B.dbg('meta.skipDrive');
    await waitPhase(ann.page, 'contract', 20_000);
    await B.dbg('monsters.freeze', { on: true });
    await sleep(2500);
    await ann.close();
    players.splice(players.indexOf(ann), 1);
    await sleep(1200);
    r = await roster(B);
    const lead = r.find((p) => p.isLeader);
    check(lead?.name === 'Bob', `leadership passed to Bob while Ann is gone (${lead?.name}; Ann connected=${r.find((p) => p.id === annId)?.connected})`);
    const crewEv = B.events.filter((e) => e.e === 'crew').pop()?.d as { players: { name: string; isLeader: boolean }[] } | undefined;
    check(crewEv?.players.find((p) => p.isLeader)?.name === 'Bob', 'clients were told (crew roster event)');
    // the new leader can end the results screen
    await B.dbg('meta.endContract', { real: true });
    await B.waitFor(() => B.full?.phase === 'results', 10_000, 'results');
    const cont = (await B.req('meta.continue', {})) as { ok: boolean; reason?: string };
    check(cont.ok, `new leader continues from results (${cont.reason ?? 'ok'})`);
    await B.waitFor(() => B.full?.phase === 'hub', 10_000, 'hub');
    // Ann comes back on a new browser with the same key: same player, slot kept
    const ann2 = await qaPlayer('Ann', 'talk_en.wav', crew, { playerKey: key });
    players.push(ann2);
    await sleep(1000);
    r = await roster(B);
    check((await st(ann2.page)).me === annId, 'Ann rejoined as the same player (key)');
    note(`after Ann's return the leader is ${r.find((p) => p.isLeader)?.name}`);
    const pick2 = (await B.req('meta.pick', { orderId: (await metaState(B)).workOrders.find((x) => x.available)!.id })) as { ok: boolean; reason?: string };
    note(`Bob pick after Ann's return: ${pick2.ok ? 'ok' : pick2.reason}`);
  });

  // ------------------------------------------------------------------ late joiners
  await scenario('late', async () => {
    const crew = randomCrew();
    const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
    const M = await connectBot({ url: WS_URL, crew, name: 'Mia' });
    bots.push(L, M);
    const a = await qaPlayer('Ann', 'talk_en.wav', crew);
    const b = await qaPlayer('Bea', 'whisper.wav', crew);
    players.push(a, b);
    await startContract(L, [M], [a, b]);
    // spread the crew out so the van spawns are free / visible
    for (const p of [a, b]) await p.page.evaluate(() => { window.__game!.look(Math.PI, 0); window.__game!.setInput({ forward: 1 }); });
    await sleep(2500);
    for (const p of [a, b]) await p.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
    const dax = await qaPlayer('Dax', 'shout.wav', crew);
    players.push(dax);
    const F = await connectBot({ url: WS_URL, crew, name: 'Finn' });
    bots.push(F);
    await sleep(2500);
    const sd = await st(dax.page);
    check(sd.phase === 'contract' && !!sd.layout && sd.layout.seed === L.layout!.seed, `5th player (Chrome) joined straight into the contract (${sd.phase}, ${sd.layout?.seed})`);
    const dp = (await serverPose(L, sd.me))!.pose.p;
    check(nearSpawn(L, dp) < 1, `5th player spawned at the van (${dp.map((v) => v.toFixed(1))}, ${nearSpawn(L, dp).toFixed(2)} m from a spawn)`);
    const fp = F.serverPos()!;
    check(F.full?.phase === 'contract' && nearSpawn(L, [fp[0], 0, fp[1]]) < 1, `6th player (bot) spawned at the van (${fp.map((v) => v.toFixed(1))})`);
    const ix = sd.interaction as { inventories?: Record<string, unknown> } | null;
    check(!!sd.objectives && !!ix, `late joiner has objectives + interaction state (${!!sd.objectives}, ${!!ix})`);
    const r = await roster(L);
    check(r.length === 6 && r.every((p) => p.connected), `roster 6/6 connected (${r.map((p) => p.name).join(',')})`);
    // the late joiner can move and is seen by the others
    note(`Dax frame time before the move check: ${(await settled(dax.page)).toFixed(0)} ms`);
    await dax.page.evaluate(() => { window.__game!.look(Math.PI, 0); window.__game!.setInput({ forward: 1 }); });
    await sleep(1500);
    await dax.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
    await sleep(500);
    const dp2 = (await serverPose(L, sd.me))!.pose.p;
    check(Math.hypot(dp2[0] - dp[0], dp2[2] - dp[2]) > 1, `5th player moves (${Math.hypot(dp2[0] - dp[0], dp2[2] - dp[2]).toFixed(1)} m)`);
    const seen = await a.page.evaluate((id) => window.__players!.avatars().find((x) => x.id === id), sd.me);
    check(!!seen && seen.visible, `Ann sees Dax's avatar (${seen ? seen.p.map((v) => v.toFixed(1)).join(',') : 'none'})`);
    // results include the late joiner
    await L.dbg('meta.endContract', { real: true });
    await L.waitFor(() => L.full?.phase === 'results', 10_000, 'results');
    const res = (await metaState(L)).meta.results;
    check(!!res && res.xp.some((x) => x.player === sd.me), `late joiner gets results/XP (${res?.xp.map((x) => x.name).join(',')})`);
    const errs = await dax.page.evaluate(() => window.__game!.errors());
    check(errs.length === 0, `no client errors on the late joiner (${errs.slice(0, 2).join(' || ').slice(0, 300)})`);
  });

  // ------------------------------------------------------------------ death + badge revive
  await scenario('badge', async () => {
    const crew = randomCrew();
    const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
    bots.push(L);
    const bea = await qaPlayer('Bea', 'whisper.wav', crew, { viewport: { width: 960, height: 540 } });
    const cid = await qaPlayer('Cid', 'silence.wav', crew, { viewport: { width: 960, height: 540 } });
    players.push(bea, cid);
    await startContract(L, [], [bea, cid]);
    const cidId = (await st(cid.page)).me;
    // Cid walks out of the van area a bit, then dies
    await cid.page.evaluate(() => { window.__game!.look(Math.PI, 0); window.__game!.setInput({ forward: 1 }); });
    await sleep(2000);
    await cid.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
    await sleep(500);
    const k = (await L.dbg('interaction.kill', { pid: cidId, killer: 'HOUND', reason: 'heard your SPRINT (9 m)' })) as { ok: boolean };
    check(k.ok, 'Cid killed (dbg.interaction.kill)');
    await sleep(1200);
    const card = await cid.page.evaluate(() => !!document.querySelector('[data-testid="ix-deathcard"]'));
    check(card, 'death card shown');
    await shot(cid.page, 'edge-death-card').catch(() => '');
    // after the card: spectating banner near the TOP of the screen (it used to land mid-screen)
    await cid.page.waitForFunction(() => !!document.querySelector('[data-testid="players-spectating"]'), undefined, { timeout: 12_000, polling: 200 }).catch(() => {});
    const box = await cid.page.evaluate(() => {
      const el = document.querySelector('[data-testid="players-spectating"]') as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, vh: innerHeight, vw: innerWidth };
    });
    check(!!box && box.top < box.vh * 0.25 && box.top > 0 && box.width > box.vw * 0.5, `STATIC // SPECTATING banner at the top (${box ? `top ${Math.round(box.top)} of ${box.vh}, width ${Math.round(box.width)}/${box.vw}` : 'missing'})`);
    await shot(cid.page, 'edge-spectating').catch(() => '');
    // Bea picks up Cid's badge, carries it to the van deposit
    const ixs = (await L.dbg('interaction.state')) as { items: Record<string, { id: string; type: string; owner?: string; where: string; p?: number[] }> };
    const badge = Object.values(ixs.items).find((it) => it.type === 'badge' && it.owner === cidId && it.where === 'world');
    check(!!badge && !!badge.p, `badge on the floor (${badge?.id})`);
    if (badge?.p) {
      await tpPage(bea, badge.p[0] + 0.6, badge.p[2], -Math.PI / 2);
      await sleep(800);
      const pick = await req<{ ok: boolean; msg?: string }>(bea.page, 'interaction.use', { id: badge.id });
      check(pick.ok, `Bea picked up the badge (${pick.msg ?? 'ok'})`);
      const dep = L.obj!.deposit!.p;
      await tpPage(bea, dep[0], dep[2] - 0.3, 0);
      await sleep(800);
      const d = await req<{ ok: boolean; msg?: string }>(bea.page, 'interaction.use', { id: 'deposit:0' });
      check(d.ok, `badge filed at the van (${d.msg ?? 'ok'})`);
      const t0 = performance.now();
      let alive = false;
      while (!alive && performance.now() - t0 < 30_000) { await sleep(500); alive = !!(await roster(L)).find((p) => p.id === cidId)?.alive; }
      check(alive, `Cid respawned after ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      await sleep(1200);
      const cp = (await serverPose(L, cidId))!.pose.p;
      check(nearSpawn(L, cp) < 1.5, `Cid respawned at the van (${cp.map((v) => v.toFixed(1))})`);
      const loc = await cid.page.evaluate(() => window.__players!.local());
      check(!loc.dead && Math.hypot(loc.p[0] - cp[0], loc.p[2] - cp[2]) < 1.5, `Cid's client alive at the van (${loc.p.map((v) => v.toFixed(1))}, dead=${loc.dead})`);
      const specGone = await cid.page.evaluate(() => !document.querySelector('[data-testid="players-spectating"]'));
      check(specGone, 'spectating banner gone after the respawn');
      const sp = spawns(L).sort((a, b) => Math.hypot(a.x - cp[0], a.z - cp[2]) - Math.hypot(b.x - cp[0], b.z - cp[2]))[0];
      await cid.page.evaluate((y) => { window.__game!.look(y, 0); window.__game!.setInput({ forward: 1 }); }, sp?.rot ?? Math.PI);
      await sleep(2000);
      await cid.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
      await sleep(400);
      const cp2 = (await serverPose(L, cidId))!.pose.p;
      check(Math.hypot(cp2[0] - cp[0], cp2[2] - cp[2]) > 1, `respawned Cid can move (${Math.hypot(cp2[0] - cp[0], cp2[2] - cp[2]).toFixed(1)} m)`);
      await shot(cid.page, 'edge-respawned').catch(() => '');
    }
    const errs = await cid.page.evaluate(() => window.__game!.errors());
    check(errs.length === 0, `no client errors (${errs.slice(0, 2).join(' || ').slice(0, 300)})`);
  });

  // ------------------------------------------------------------------ Core carry (2 Chrome carriers)
  await scenario('carry', async () => {
    const crew = randomCrew();
    const E = await connectBot({ url: WS_URL, crew, name: 'Eve' });
    const F = await connectBot({ url: WS_URL, crew, name: 'Fox' });
    bots.push(E, F);
    const ann = await qaPlayer('Ann', 'silence.wav', crew);
    const bea = await qaPlayer('Bea', 'silence.wav', crew, { proxyWs: true });
    players.push(ann, bea);
    await startContract(E, [F], [ann, bea]);
    await E.dbg('objectives.doors', { open: true });
    // bots: power (twin breakers via teleports) + keypad
    const obj = () => E.obj!;
    const lv = obj().levers;
    await E.teleport(lv[0].p[0] + Math.sin(lv[0].rot) * 0.8, lv[0].p[2] + Math.cos(lv[0].rot) * 0.8);
    await F.teleport(lv[1].p[0] + Math.sin(lv[1].rot) * 0.8, lv[1].p[2] + Math.cos(lv[1].rot) * 0.8);
    const [ra, rb] = await Promise.all([E.req('objectives.lever', { id: lv[0].id }), F.req('objectives.lever', { id: lv[1].id })]);
    await sleep(500);
    check(!!obj().power[lv[0].zone], `power on (${ra.result}/${rb.result} ${ra.msg ?? ''} ${rb.msg ?? ''})`);
    const kp = obj().keypad!;
    await E.teleport(kp.p[0] + Math.sin(kp.rot) * 0.8, kp.p[2] + Math.cos(kp.rot) * 0.8);
    const kr = await E.req('objectives.keypad', { code: obj().code });
    await sleep(500);
    check(kr.ok && obj().vaultOpen, `vault open (${kr.msg ?? 'ok'})`);
    // Ann + Bea at both handles
    const c = obj().core!.p;
    const annId = (await st(ann.page)).me, beaId = (await st(bea.page)).me;
    const L = E.layout!;
    const walk = (x: number, z: number) => { const cx = Math.floor(x), cz = Math.floor(z); return cz >= 0 && cx >= 0 && cx < L.W && cz < L.H && L.owner[cz * L.W + cx] >= 0; };
    let ha = [c[0] - 0.9, c[2]], hb = [c[0] + 0.9, c[2]], axis = 'x';
    if (!(walk(ha[0], ha[1]) && walk(hb[0], hb[1]))) { ha = [c[0], c[2] - 0.9]; hb = [c[0], c[2] + 0.9]; axis = 'z'; }
    await tpPage(ann, ha[0], ha[1]);
    await tpPage(bea, hb[0], hb[1]);
    await sleep(1000);
    const ga = await req<{ ok: boolean; msg?: string }>(ann.page, 'objectives.core', { action: 'grab' });
    const gb = await req<{ ok: boolean; msg?: string }>(bea.page, 'objectives.core', { action: 'grab' });
    check(ga.ok && gb.ok, `both grabbed a handle (${ga.msg ?? 'ok'} / ${gb.msg ?? 'ok'})`);
    await sleep(800);
    const objA = await ann.page.evaluate(() => (window as unknown as { __objectives: { state(): { coreState: string; core: { carriers: string[] } } } }).__objectives.state());
    const objB = await bea.page.evaluate(() => (window as unknown as { __objectives: { state(): { coreState: string; core: { carriers: string[] } } } }).__objectives.state());
    check(obj().coreState === 'carried' && objA.coreState === 'carried' && objB.coreState === 'carried', `server + both clients: carried (${obj().coreState}/${objA.coreState}/${objB.coreState})`);
    // walk together (same yaw) toward the van; sample both clients vs the server
    const v = obj().van!;
    const vx = v.x + v.w / 2, vz = v.y + v.h / 2;
    const mid = [(ha[0] + hb[0]) / 2, (ha[1] + hb[1]) / 2];
    const yaw = Math.atan2(vx - mid[0], vz - mid[1]);
    note(`carrier frame times: ${(await settled(ann.page)).toFixed(0)} / ${(await settled(bea.page)).toFixed(0)} ms`);
    for (const p of [ann, bea]) await p.page.evaluate((y) => { window.__game!.look(y, 0); window.__game!.setInput({ forward: 1 }); }, yaw);
    let maxSep = 0, maxCoreErr = 0, n = 0, speeds: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 4000 && obj().coreState === 'carried') {
      await sleep(300);
      const pa = (await serverPose(E, annId))!.pose.p, pb = (await serverPose(E, beaId))!.pose.p;
      maxSep = Math.max(maxSep, Math.hypot(pa[0] - pb[0], pa[2] - pb[2]));
      const cp = E.snap?.dyn.find((x) => x.id === obj().core!.id)?.p ?? obj().core!.p;
      maxCoreErr = Math.max(maxCoreErr, Math.hypot(cp[0] - (pa[0] + pb[0]) / 2, cp[2] - (pa[2] + pb[2]) / 2));
      const la = await ann.page.evaluate(() => window.__players!.local().speed);
      speeds.push(la);
      n++;
    }
    for (const p of [ann, bea]) await p.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
    const moved = E.snap?.dyn.find((x) => x.id === obj().core!.id)?.p ?? obj().core!.p;
    check(n > 5, `carry sampled ${n}x (core moved ${Math.hypot(moved[0] - c[0], moved[2] - c[2]).toFixed(1)} m, state ${obj().coreState})`);
    check(maxSep < 3.2, `carriers stayed inside the leash (max separation ${maxSep.toFixed(2)} m, axis ${axis})`);
    check(maxCoreErr < 0.8, `server Core stays at the carriers' midpoint (max error ${maxCoreErr.toFixed(2)} m)`);
    const vmax = Math.max(...speeds);
    check(vmax < 3.0 * 0.55 * 1.25 + 0.05, `carrier walks at carry speed (max local speed ${vmax.toFixed(2)} m/s, expected <= ${(3 * 0.55).toFixed(2)})`);
    // Ann renders Bea where the server has her (no rubber band)
    const pb = (await serverPose(E, beaId))!.pose.p;
    const seen = await ann.page.evaluate((id) => window.__players!.avatars().find((x) => x.id === id)?.p ?? null, beaId);
    check(!!seen && Math.hypot(seen[0] - pb[0], seen[2] - pb[2]) < 0.6, `Ann renders Bea at her server pose (${seen ? Math.hypot(seen[0] - pb[0], seen[2] - pb[2]).toFixed(2) : 'n/a'} m)`);
    // split: Ann keeps walking, Bea stops -> leash drop on server and both clients
    if (obj().coreState === 'carried') {
      const val0 = obj().core!.value;
      await ann.page.evaluate((y) => { window.__game!.look(y, 0); window.__game!.setInput({ forward: 1 }); }, yaw + Math.PI / 2);
      await E.waitFor(() => obj().coreState === 'dropped', 12_000, 'leash drop').catch(() => {});
      await ann.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
      await sleep(800);
      const sA = await ann.page.evaluate(() => (window as unknown as { __objectives: { state(): { coreState: string } } }).__objectives.state().coreState);
      const sB = await bea.page.evaluate(() => (window as unknown as { __objectives: { state(): { coreState: string } } }).__objectives.state().coreState);
      check(obj().coreState === 'dropped' && sA === 'dropped' && sB === 'dropped', `split up -> dropped everywhere (${obj().coreState}/${sA}/${sB})`);
      check(obj().core!.value < val0, `drop cost value (${val0} -> ${obj().core!.value})`);
      const spA = await ann.page.evaluate(() => window.__players!.local().speed);
      note(`after the drop Ann's local speed ${spA.toFixed(2)} (standing)`);
      // re-grab works
      const cpp = obj().core!.p;
      await tpPage(ann, cpp[0] - 0.8, cpp[2]);
      await tpPage(bea, cpp[0] + 0.8, cpp[2]);
      await sleep(900);
      const g1 = await req<{ ok: boolean; msg?: string }>(ann.page, 'objectives.core', { action: 'grab' });
      const g2 = await req<{ ok: boolean; msg?: string }>(bea.page, 'objectives.core', { action: 'grab' });
      await sleep(500);
      check(g1.ok && g2.ok && obj().coreState === 'carried', `re-grab after the drop (${g1.msg ?? 'ok'} / ${g2.msg ?? 'ok'}, ${obj().coreState})`);
      // Bea disconnects while carrying -> it drops, Ann can move at full speed again
      await dropSocket(bea);
      await E.waitFor(() => obj().coreState !== 'carried', 6000, 'drop on disconnect').catch(() => {});
      check(obj().coreState === 'dropped', `carrier disconnect drops the Core (${obj().coreState})`);
      await bea.page.waitForFunction(() => (window.__game!.state() as { net: string }).net === 'joined', undefined, { timeout: 20_000 }).catch(() => {});
    }
    const errs = [...(await ann.page.evaluate(() => window.__game!.errors())), ...(await bea.page.evaluate(() => window.__game!.errors()))];
    check(errs.length === 0, `no client errors (${errs.slice(0, 2).join(' || ').slice(0, 300)})`);
  });

  // ------------------------------------------------------------------ wipe
  await scenario('wipe', async () => {
    const crew = randomCrew();
    const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
    const M = await connectBot({ url: WS_URL, crew, name: 'Mia' });
    bots.push(L, M);
    const ann = await qaPlayer('Ann', 'silence.wav', crew);
    players.push(ann);
    await startContract(L, [M], [ann]);
    const annId = (await st(ann.page)).me;
    for (const id of [L.id, M.id, annId]) await L.dbg('interaction.kill', { pid: id, killer: 'MANNEQUIN', reason: 'nobody was watching' });
    const t0 = performance.now();
    await waitPhase(ann.page, 'results', 15_000).catch(() => {});
    const dt = performance.now() - t0;
    const ms = await metaState(L);
    check(ms.meta.results?.outcome === 'wiped', `everyone dead -> results 'wiped' in ${Math.round(dt)} ms (${ms.meta.results?.outcome})`);
    check(ms.meta.results?.hauled === 0, `a wipe hauls nothing (${ms.meta.results?.hauled})`);
    const scr = (await st(ann.page)).screen;
    check(scr === 'results', `results screen shown (${scr})`);
    await shot(ann.page, 'edge-wipe-results').catch(() => '');
    const cont = (await L.req('meta.continue', {})) as { ok: boolean };
    await waitPhase(ann.page, 'hub', 15_000);
    check(cont.ok && (await st(ann.page)).screen === 'none', 'continue -> hub, no screen stuck');
    const annAlive = (await roster(L)).find((p) => p.id === annId)?.alive;
    check(annAlive === true, `the dead are alive again in the van (${annAlive})`);
    // wipe while one LIVING player is disconnected: the crew should not sit in a dead contract for 90 s
    await startContract(L, [M], [ann]);
    await M.dbg('net.teleport', { x: M.pos[0], z: M.pos[1] }).catch(() => undefined);
    M.close();
    bots.splice(bots.indexOf(M), 1);
    await sleep(800);
    for (const id of [L.id, annId]) await L.dbg('interaction.kill', { pid: id, killer: 'HOUND', reason: 'charged' });
    const t1 = performance.now();
    await waitPhase(ann.page, 'results', 40_000).catch(() => {});
    const dt1 = performance.now() - t1;
    const ph = (await st(ann.page)).phase;
    check(ph === 'results' && dt1 < 30_000, `all connected players dead + one living player offline -> results in ${(dt1 / 1000).toFixed(1)} s (${ph})`);
  });
} finally {
  const ok = results.every((r) => r.ok);
  const file = join(OUT, 'edge-report.json');
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ok, results, notes }, null, 1));
  log(`\n${results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.scenario}${r.problems.length ? `: ${r.problems.join(' | ')}` : ''}`).join('\n')}`);
  log(`report: ${file}`);
  for (const b of bots) b.close();
  for (const p of players) await p.close().catch(() => {});
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(ok ? 0 : 1), 800).unref();
}
