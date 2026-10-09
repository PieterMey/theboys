// v1.3 F3 (G3) bot test against a full dev server (every track): the noise lure and the field receiver end to end.
// - flags noiseLure / fieldReceiver (dbg.setFlags, in memory): on = the van workbench offers both recipes, off = it hides
//   them again (v1.2: 15/17);
// - crafted at the bench (tier II receiver with the Soldering station), into the gear pool, handed out at contract start;
// - a lure thrown near the Hound: 3 rattles (players' noise bus: kind 'lure', 12 m, source = the lure) and the Hound
//   goes for it (G2 treats a lure like a bottle) with its target at the lure, not at the thrower;
// - the receiver: a 6 s listen (one charge), ear to a closed door = the room behind it; the monster cues the bot
//   receives while listening are classified the way the client does it (on the air: 2.5x radius and 30 m by path).
// Needs a dev server: PORT=3803 NODE_ENV=development AI_MODE=mock SAVES_DIR=<scratch>/saves SESSION_FILE=<scratch>/session.json
//   node apps/server/src/index.ts --dev        then   node tests/interaction/f3.e2e.ts [port]
import { Bot } from './bot.ts';
import type { Ev } from './bot.ts';
import { reporter, sleep, waitFor } from './v12lib.ts';
import type { LevelLayout, LayoutDoor } from '../../packages/shared/src/layout.ts';
import type { ItemState } from '../../packages/shared/src/messages/interaction.ts';
import { AirField, onAir } from '../../apps/client/src/interaction/receiver.ts';

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 3803);
if ([3000, 3100].includes(port)) throw new Error('refusing the live ports');
const url = `ws://127.0.0.1:${port}/ws`;
const { ok, fails } = reporter();
const t0 = Date.now();
const step = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}`);
type XZ = [number, number];
interface Station { x: number; z: number; p: [number, number, number] }
interface Noise { x: number; z: number; radiusM: number; kind: string; source: string; t: number }
interface Hound { id: string; kind: string; x: number; z: number; state: string; tx?: number; tz?: number; lastNoiseKind?: string; active: boolean }

const waitPhase = (b: Bot, phase: string, ms: number): Promise<unknown> =>
  b.full?.phase === phase ? Promise.resolve() : b.waitEvent('phase', (d: { phase: string }) => d.phase === phase, ms);
const inv = (b: Bot): ItemState[] => (b.ix.inventories[b.me] ?? []).filter(Boolean).map((id) => b.ix.items[id!]!).filter(Boolean);
const place = (b: Bot, x: number, z: number, yaw = 0) => b.dbg('interaction.pose', { x, z, yaw });
const spaceAt = (L: LevelLayout, x: number, z: number): number => {
  const cx = Math.floor(x), cz = Math.floor(z);
  return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : (L.owner[cz * L.W + cx] ?? -1);
};
async function activate(b: Bot, type: string): Promise<ItemState | null> {
  const slots = b.ix.inventories[b.me] ?? [];
  const i = slots.findIndex((id) => !!id && b.ix.items[id]?.type === type);
  if (i < 0) return null;
  await b.req('interaction.slot', { slot: i });
  await b.settle(60);
  return b.ix.items[slots[i]!] ?? null;
}

const a = new Bot('Lure');
const crew = `F3E${Date.now() % 100000}`;
try {
  await a.connect(url, crew);
  await a.settle(400);
  step(`joined ${crew} as ${a.me}, phase ${a.full?.phase}`);
  // ---------------- flags -> the workbench
  await a.dbg('setFlags', { set: { noiseLure: false, fieldReceiver: false } });
  let ws = await a.dbg<{ recipes: string[]; hidden: string[]; workbench: Station | null }>('workshop.state');
  ok(ws.hidden.includes('lures') && ws.hidden.includes('receiver'), `flags off: the bench hides lures + receiver (${ws.recipes.length}/${ws.recipes.length + ws.hidden.length} offered)`);
  await a.dbg('setFlags', { set: { noiseLure: true, fieldReceiver: true } });
  ws = await a.dbg('workshop.state');
  ok(ws.recipes.includes('lures') && ws.recipes.includes('receiver') && !ws.hidden.length, `flags on: the bench offers every recipe (${ws.recipes.length}/${ws.recipes.length + ws.hidden.length})`);
  // ---------------- craft both
  const wb = ws.workbench!;
  const dx = wb.p[0] - wb.x, dz = wb.p[2] - wb.z, dl = Math.hypot(dx, dz) || 1;
  await place(a, wb.x + (dx / dl) * 0.9, wb.z + (dz / dl) * 0.9);
  await a.dbg('workshop.give', { mats: { 'mat.scrap': 10, 'mat.wiring': 10, 'mat.cells': 6, 'mat.relic': 2 } });
  await a.dbg('workshop.unlock', { id: 'bench_tools' });
  const c1 = await a.req<{ ok: boolean; reason?: string }>('meta.craft', { recipe: 'lures' });
  const c2 = await a.req<{ ok: boolean; reason?: string; bench?: { pool?: Record<string, number> } }>('meta.craft', { recipe: 'receiver' });
  ok(c1.ok && c2.ok, `crafted Noise lures x2 and a Field receiver (5) (${c1.reason ?? 'ok'} / ${c2.reason ?? 'ok'})`);
  ok((c2.bench?.pool?.lure ?? 0) >= 2 && (c2.bench?.pool?.receiver ?? 0) >= 5, `into the gear pool: ${JSON.stringify(c2.bench?.pool ?? {})}`);
  // ---------------- contract: the hand-out
  const order = a.full?.workOrders?.find((o) => o.available) ?? a.full?.workOrders?.[0];
  if (!order) throw new Error('no work order on the board');
  await a.req('meta.pick', { orderId: order.id });
  const drive = waitPhase(a, 'drive', 15_000);
  await a.req('meta.ready', { ready: true });
  await drive;
  await sleep(200);
  const contract = waitPhase(a, 'contract', 60_000);
  await a.dbg('meta.skipDrive');
  await contract;
  await a.settle(1200);
  const L = a.full!.layout as LevelLayout;
  const lure = inv(a).find((it) => it.type === 'lure'), rcv = inv(a).find((it) => it.type === 'receiver');
  ok(!!lure && (lure.count ?? 0) >= 2, `handed out: lure x${lure?.count ?? 0}`);
  ok(!!rcv && (rcv.count ?? 0) >= 5, `handed out: receiver (${rcv?.count ?? 0} charges)`);
  if (!lure) await a.dbg('interaction.give', { type: 'lure', count: 2 });
  if (!rcv) await a.dbg('interaction.give', { type: 'receiver', count: 5 });
  await a.settle(100);
  step(`contract ${L.seed} (${L.W}x${L.H})`);
  // ---------------- the lure vs the Hound
  const ms = await a.dbg<{ agents: Hound[]; mode: string }>('monsters.state');
  const hound = ms.agents.find((x) => x.kind === 'hound');
  // the longest room or corridor: the bot at one end, the Hound near the far end, the lure thrown between them
  const run = [...L.spaces].filter((s) => s.kind !== 'outside' && s.type !== 'van').sort((p, q) => Math.max(q.rect.w, q.rect.h) - Math.max(p.rect.w, p.rect.h))[0];
  const runLen = run ? Math.max(run.rect.w, run.rect.h) : 0;
  step(`hound ${hound ? `${hound.id} (${hound.state}, active ${hound.active})` : 'none'}; longest run ${runLen} m (${run?.kind} ${run?.type})`);
  if (!hound || !run || runLen < 10) {
    ok(false, `no Hound (${ms.mode}, ${ms.agents.map((x) => x.kind).join(',')}) or no 10 m run in this layout`);
  } else {
    const r = run.rect, alongX = r.w >= r.h;
    const from: XZ = alongX ? [r.x + 1.2, r.y + r.h / 2] : [r.x + r.w / 2, r.y + 1.2];
    const axis: XZ = alongX ? [1, 0] : [0, 1];
    const at = (k: number): XZ => [from[0] + axis[0] * k, from[1] + axis[1] * k];
    const houndAt = Math.min(15, runLen - 2.2);
    await a.dbg('monsters.place', { id: hound.id, x: at(houndAt)[0], z: at(houndAt)[1], state: 'idle', active: true });
    await place(a, from[0], from[1], Math.atan2(axis[0], axis[1]));
    const lu = await activate(a, 'lure');
    ok(!!lu, 'lure in hand');
    const tNoise = Math.max(a.lastSnap?.t ?? 0, ...a.events.map((e) => e.t));
    a.clearEvents();
    const thrown = await a.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [axis[0], 0.18, axis[1]], eye: [from[0], 1.62, from[1]], fuse: 0 });
    ok(thrown.ok, 'thrown (fuse: on landing)');
    const land = await a.waitEvent('interaction.fx', (d: { kind: string; item?: string }) => d.kind === 'drop' && d.item === 'lure', 4000).catch(() => null);
    const lp = (land?.d as { p?: [number, number, number]; id?: string } | undefined)?.p;
    const lid = (land?.d as { id?: string } | undefined)?.id;
    ok(!!lp && !!lid, `landed at ${lp ? `${lp[0].toFixed(1)}, ${lp[2].toFixed(1)}` : '?'} (${lp ? Math.hypot(lp[0] - from[0], lp[2] - from[1]).toFixed(1) : '?'} m out)`);
    // the Hound: it goes for the lure (bait like a bottle), its target at the lure
    let went: Hound | null = null;
    const states = new Set<string>();
    await waitFor(async () => {
      const h = (await a.dbg<{ agents: Hound[] }>('monsters.state')).agents.find((x) => x.id === hound.id);
      if (h) states.add(h.state);
      if (h && lp && h.tx !== undefined && h.tz !== undefined && h.state !== 'idle' && Math.hypot(h.tx - lp[0], h.tz! - lp[2]) < 1.5) went = h;
      return !!went;
    }, 9000, 150);
    const w = went as Hound | null;
    ok(!!w, `the Hound went for the lure (states ${[...states].join(' > ')}${w ? `, target ${w.tx}, ${w.tz}, heard '${w.lastNoiseKind}'` : ''})`);
    // three rattles on the players' noise bus, 12 m, at the lure, source = the lure (never the thrower)
    await waitFor(async () => ((await a.dbg<Noise[]>('players.noise')) ?? []).filter((n) => n.kind === 'lure' && n.t > tNoise).length >= 3, 11_000, 250);
    const rattles = ((await a.dbg<Noise[]>('players.noise')) ?? []).filter((n) => n.kind === 'lure' && n.t > tNoise);
    ok(rattles.length === 3, `${rattles.length} rattles (want 3)`);
    ok(rattles.every((n) => n.radiusM === 12 && n.source === lid), `12 m each, source = the lure ${lid}`);
    const gaps = rattles.slice(1).map((n, i) => n.t - rattles[i]!.t);
    ok(gaps.length === 2 && gaps.every((g) => Math.abs(g - 4000) < 250), `4 s apart (${gaps.map((g) => Math.round(g)).join(', ')} ms)`);
    const fx = a.events.filter((e) => e.e === 'interaction.fx' && (e.d as { kind: string }).kind === 'lure').map((e) => (e.d as { count: number }).count);
    ok(fx.join() === '1,2,3', `fx 'lure' 1, 2, 3 to the crew (${fx.join()})`);
    await a.settle(200);
    ok(!!lid && a.ix.items[lid] === undefined, 'used up by the last rattle');
    // ---------------- the receiver: a listen, the cues on the air
    await a.dbg('monsters.place', { id: hound.id, x: at(houndAt)[0], z: at(houndAt)[1], state: 'idle', active: true });
    await activate(a, 'receiver');
    const charges0 = inv(a).find((it) => it.type === 'receiver')?.count ?? 0;
    a.clearEvents();
    const g = await a.req<{ ok: boolean; msg?: string; listen?: { ms: number; door?: number; space?: number } }>('interaction.act', { dir: [axis[0], 0, axis[1]] });
    ok(g.ok && g.listen?.ms === 6000, `listen: ${g.msg}`);
    await a.settle(80);
    ok((inv(a).find((it) => it.type === 'receiver')?.count ?? 0) === charges0 - 1, 'one charge spent');
    // a second lure 12 m out, near the Hound: it growls / huffs; classify what the bot hears the way the client does
    const lu2 = await activate(a, 'lure');
    await sleep(450); // LMB cooldown (400 ms) since the listen
    const t2 = await a.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [axis[0], 0.3, axis[1]], eye: [from[0], 1.62, from[1]], fuse: 0 });
    ok(!!lu2 && t2.ok, `a second lure thrown while listening (${t2.msg ?? 'ok'})`);
    await sleep(3000);
    const h2 = (await a.dbg<{ agents: Hound[] }>('monsters.state')).agents.find((x) => x.id === hound.id);
    console.log(`  hound after: ${JSON.stringify(h2)}; events: ${JSON.stringify([...new Set(a.events.map((e) => e.e))])}`);
    const air = new AirField();
    const door = (id: number) => !!a.ix.doors[id]?.open;
    air.update(L, from[0], from[1], 30, door);
    const cues = a.events.filter((e) => e.e === 'monsters.cue') as (Ev & { d: { cue: string; kind: string; p: [number, number, number]; radius: number } })[];
    const judged = cues.map((e) => {
      const d = Math.hypot(e.d.p[0] - from[0], e.d.p[2] - from[1]);
      return { cue: e.d.cue, d: +d.toFixed(1), r: e.d.radius, path: +air.at(e.d.p[0], e.d.p[2]).toFixed(1), air: onAir(d, e.d.radius, air.at(e.d.p[0], e.d.p[2]), { mult: 2.5, maxPath: 30 }) };
    });
    console.log('  cues while listening:', JSON.stringify(judged));
    ok(cues.length > 0, `the Hound made ${cues.length} cue(s) while the bot listened`);
    const beyond = judged.filter((j) => j.air && j.d > j.r);
    console.log(`  ${judged.filter((j) => j.air).length} on the air, ${beyond.length} of them beyond their own radius (only the receiver hears those)`);
  }
  // ---------------- ear to a closed door
  const closed = L.doors.find((d: LayoutDoor) => d.kind === 'door' && !a.ix.doors[d.id]?.open && d.a !== d.b);
  if (closed) {
    const cx = closed.dir === 'v' ? closed.x : closed.x + closed.len / 2, cz = closed.dir === 'v' ? closed.y + closed.len / 2 : closed.y;
    const nx = closed.dir === 'v' ? 1 : 0, nz = 1 - nx;
    const stand: XZ = spaceAt(L, cx - nx * 0.6, cz - nz * 0.6) >= 0 ? [cx - nx * 0.6, cz - nz * 0.6] : [cx + nx * 0.6, cz + nz * 0.6];
    await place(a, stand[0], stand[1]);
    await activate(a, 'receiver');
    // the plain listen has to end first (one at a time)
    let g = await a.req<{ ok: boolean; msg?: string; listen?: { door?: number; space?: number } }>('interaction.act', { dir: [0, 0, 1], door: closed.id });
    for (let i = 0; i < 8 && !g.ok && g.msg === 'Still listening'; i++) {
      await sleep(800);
      g = await a.req('interaction.act', { dir: [0, 0, 1], door: closed.id });
    }
    ok(g.ok && g.listen?.door === closed.id, `ear to door ${closed.id}: ${g.msg}`);
    const mine = spaceAt(L, stand[0], stand[1]);
    ok(g.listen?.space !== undefined && g.listen.space !== mine && [closed.a, closed.b].includes(g.listen.space), `the room behind it: space ${g.listen?.space} (standing in ${mine})`);
  } else ok(false, 'no closed door to listen through');
} catch (e) {
  ok(false, `crashed: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  try { await a.dbg('setFlags', { set: { noiseLure: false, fieldReceiver: false } }); } catch { /* gone */ }
  a.close();
}
console.log(fails() ? `FAILED (${fails()})` : 'ALL PASS');
setTimeout(() => process.exit(fails() ? 1 : 0), 100);
