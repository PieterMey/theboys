// Owner: env-paranormal (v1.2). Paranormal sync over a real dev server with 4 raw ws clients (no browser, no AI):
//  - every MUST kind (and the SHOULD kinds that fit) fires via dbg.paranormal.fire and reaches every client with an
//    identical id / at / seed / data, at >= server time + 250; 'to' events (the mirror figure) reach only their player
//  - a reconnecting client gets residue + active from paranormal.sync
//  - seen{end} ends a presence for everyone (paranormal.end), the first witness of a writing broadcasts paranormal.reveal
//  - the dark walk kills each space in step order (interaction lights), corridors revive with a 'revive' event, rooms
//    revive when their switch comes back on
//  - server cost per crew tick (dbg.paranormal.state avgTickMs)
//   node tests/paranormal/sync.e2e.ts   (PORT default 3814; PARA_SCRATCH = scratch dir for saves/session)
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ParanormalEvent } from '../../packages/shared/src/messages/paranormal.ts';
import { mirrorsOf } from '../../packages/shared/src/procgen/mirrors.ts';
import { fixturesOf, indoor, switchSpaces } from '../../apps/server/src/paranormal/gates.ts';
import { Bot, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3814);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = ''): boolean => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const CREW = 'PARA';
const A = new Bot('Ann'), B = new Bot('Bob'), C = new Bot('Cas'), D = new Bot('Dee');
const bots = [A, B, C, D];
let fail = false;
try {
  for (const b of bots) await b.connect(url, CREW);
  const st = await A.dbg<{ seed: string }>('objectives.start', { seed: 'para-e2e-1', players: 4, realSec: 900 });
  const L = await waitFor(() => (A.eventsOf<{ state?: { layout?: LevelLayout } }>('phase').pop()?.d.state?.layout), 5000, 'layout');
  check('contract started', !!L && L.kind === 'facility', `${st.seed} ${L.W}x${L.H}`);
  // monsters: wait for the auto start, then freeze them out of play (they would gate or kill the bots)
  await sleep(3000);
  await A.dbg('monsters.freeze', { on: true }).catch(() => null);
  const mstate = await A.dbg<{ agents?: { id: string }[] }>('monsters.state').catch(() => ({ agents: [] }));
  for (const ag of mstate.agents ?? []) await A.dbg('monsters.place', { id: ag.id, active: false }).catch(() => null);

  const tp = async (b: Bot, x: number, z: number, yaw = 0, light: 0 | 1 = 1) => {
    try { await A.dbg('interaction.pose', { pid: b.id, x, z, yaw, light }); } catch { await b.dbg('monsters.tp', { x, z, yaw, light }); }
  };
  const cells: [number, number][] = [];
  for (let c = 0; c < L.owner.length; c++) {
    const s = L.owner[c];
    if (s >= 0 && indoor(L, s)) cells.push([(c % L.W) + 0.5, Math.floor(c / L.W) + 0.5]);
  }
  // park the others far apart (lone targets), away from the van
  const park = async (except: Bot) => {
    let k = 0;
    for (const b of bots) {
      if (b === except) continue;
      const [x, z] = cells[(k++ * 997 + 13) % cells.length];
      await tp(b, x, z, 0, 0);
    }
  };

  /** teleport A around until dbg.paranormal.fire places `kind` for it */
  const fire = async (kind: string, spots: [number, number, number][], others = true, patch?: Record<string, unknown>): Promise<ParanormalEvent | null> => {
    if (others) await park(A);
    for (const [x, z, yaw] of spots) {
      await tp(A, x, z, yaw);
      await A.dbg('paranormal.tune', { lastAgoSec: 60, clearBudgets: true });
      const r = await A.dbg<{ ok: boolean; ev?: ParanormalEvent; reason?: string }>('paranormal.fire', { kind, target: A.id, force: true, patch });
      if (r.ok && r.ev) return r.ev;
    }
    return null;
  };
  const yaws = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const spotsAll = (stride: number): [number, number, number][] => {
    const out: [number, number, number][] = [];
    for (let i = 0; i < cells.length; i += stride) out.push([cells[i][0], cells[i][1], yaws[i % 4]]);
    return out;
  };
  const ms = mirrorsOf(L).filter((m) => m.kind !== 'van' && indoor(L, m.space));
  const mirrorSpots = (dist: number): [number, number, number][] => ms.flatMap((m) => [1, 0.6, 1.4].map((k) => [m.x + Math.sin(m.rot) * dist * k, m.z + Math.cos(m.rot) * dist * k, m.rot] as [number, number, number]));

  /** every bot (or the `to` set) got the same event; at >= envelope time + 250 */
  const same = async (ev: ParanormalEvent, label: string) => {
    const aud = ev.to ? bots.filter((b) => ev.to!.includes(b.id)) : bots;
    const got = await waitFor(() => {
      const recs = aud.map((b) => b.eventsOf<ParanormalEvent>('paranormal.event').find((e) => e.d.id === ev.id));
      return recs.every(Boolean) ? recs : null;
    }, 3000, `${label} delivered`).catch(() => null);
    if (!got) return check(`${label}: delivered to ${aud.length} clients`, false);
    const j = got.map((r) => JSON.stringify(r!.d));
    const lead = Math.min(...got.map((r) => r!.d.at - r!.t));
    const others = bots.filter((b) => !aud.includes(b)).filter((b) => b.eventsOf<ParanormalEvent>('paranormal.event').some((e) => e.d.id === ev.id));
    return check(`${label}: identical id/at/seed/data on ${aud.length} clients, at >= now + 250`, j.every((x) => x === j[0]) && lead >= 250 && others.length === 0,
      `lead ${lead.toFixed(0)} ms${ev.to ? `, to ${ev.to.length}` : ''}`);
  };

  // ---------------- MUST kinds ----------------
  const fired: Record<string, ParanormalEvent | null> = {};
  fired.knock = await fire('knock', spotsAll(7));
  fired.handle_rattle = await fire('handle_rattle', spotsAll(11));
  fired.dark_walk = await fire('dark_walk', spotsAll(5));
  fired.mirror_writing = ms.length ? await fire('mirror_writing', mirrorSpots(3)) : null;
  fired.mirror_figure = ms.length ? await fire('mirror_figure', mirrorSpots(4)) : null;
  fired.presence = await fire('presence', spotsAll(3));
  fired.silhouette = await fire('silhouette', spotsAll(1));
  // ---------------- SHOULD kinds ----------------
  fired.footprints = await fire('footprints', spotsAll(9));
  fired.cold_spot = await fire('cold_spot', spotsAll(13));
  fired.brownout_breath = await fire('brownout_breath', spotsAll(3));
  fired.poltergeist = await fire('poltergeist', spotsAll(17));
  fired.object_fall = await fire('object_fall', spotsAll(19));
  for (const k of ['knock', 'handle_rattle', 'dark_walk', 'mirror_writing', 'mirror_figure', 'presence', 'silhouette']) {
    const ev = fired[k];
    if (!check(`MUST ${k} fires`, !!ev, ev ? `id ${ev.id} tier ${ev.tier}` : ms.length ? 'no placement found' : 'layout has no mirrors')) continue;
    await same(ev!, k);
  }
  for (const k of ['footprints', 'cold_spot', 'brownout_breath', 'poltergeist', 'object_fall']) {
    const ev = fired[k];
    console.log(`info  SHOULD ${k}: ${ev ? `fired (id ${ev.id})` : 'no placement (movableRefsOf may still be a stub)'}`);
    if (ev) await same(ev, k);
  }
  if (fired.mirror_figure) check('mirror figure is armed for its player only', fired.mirror_figure.to?.length === 1 && fired.mirror_figure.to[0] === A.id);
  if (fired.mirror_writing) {
    const t = String(fired.mirror_writing.data?.text ?? '');
    const names = bots.map((b) => b.name.toUpperCase());
    const cs = L.spaces.map((s) => s.callsign).filter(Boolean);
    check('mirror text is a callsign, a roster name or a fixed phrase', ['IT HEARS', 'NOT ALONE', 'COUNT AGAIN', ...names, ...cs].includes(t), t);
  }

  // ---------------- seen{end} ends a presence for everyone ----------------
  // patched so neither a beam (litMs) nor an approach can end it first: only the seen{end} report does
  const pres = await fire('presence', spotsAll(3), true, { litMs: 60_000, approachM: 0.3 });
  if (check('a second presence for the seen{end} test', !!pres)) {
    await waitFor(async () => (await A.dbg<{ pong: number }>('ping')).pong >= pres!.at, 3000, 'presence started');
    const r = await A.req<{ ok: boolean }>('paranormal.seen', { id: pres!.id, end: true });
    const ends = await waitFor(() => {
      const e = bots.map((b) => b.eventsOf<{ id: number; reason: string }>('paranormal.end').filter((x) => x.d.id === pres!.id));
      return e.every((x) => x.length >= 1) ? e : null;
    }, 3000, 'paranormal.end everywhere').catch(() => null);
    check('seen{end} -> paranormal.end (reason seen) for every client, exactly once', r.ok && !!ends && ends.every((x) => x.length === 1 && x[0].d.reason === 'seen'), ends ? `reason ${ends[0][0].d.reason}, seen ok ${r.ok}` : 'missing');
  }

  // ---------------- writing reveal on the first witness ----------------
  if (fired.mirror_writing) {
    const w = fired.mirror_writing;
    const m = ms.find((q) => q.id === w.ref)!;
    await tp(A, m.x + Math.sin(m.rot) * 2, m.z + Math.cos(m.rot) * 2, m.rot + Math.PI);
    const r = await A.req<{ ok: boolean }>('paranormal.seen', { id: w.id });
    const rev = await waitFor(() => {
      const e = bots.map((b) => b.eventsOf<{ id: number; at: number }>('paranormal.reveal').find((x) => x.d.id === w.id));
      return e.every(Boolean) ? e : null;
    }, 3000, 'reveal').catch(() => null);
    check('first witness -> paranormal.reveal to everyone (at >= now + 250)', !!rev && r.ok && rev.every((e) => e!.d.at - e!.t >= 250 && e!.d.at === rev[0]!.d.at),
      rev ? `lead ${(rev[0]!.d.at - rev[0]!.t).toFixed(0)} ms` : 'none');
    await A.req('paranormal.seen', { id: w.id });
    await sleep(300);
    check('reveal only once', bots.every((b) => b.eventsOf<{ id: number }>('paranormal.reveal').filter((x) => x.d.id === w.id).length === 1));
  }

  // ---------------- dark walk: step order, kills, revive ----------------
  const dw = fired.dark_walk;
  if (dw) {
    const lights = dw.data!.lights as string[];
    const spaces = dw.data!.spaces as number[];
    const killAt = dw.data!.killAt as number[];
    const fixtures = new Map(fixturesOf(L).map((f) => [f.id, f]));
    check('dark walk: >= 4 lit fixtures, 380-600 ms steps', lights.length >= 4 && Number(dw.data!.stepMs) >= 380 && Number(dw.data!.stepMs) <= 600, `${lights.length} fixtures, ${dw.data!.stepMs} ms`);
    check('dark walk: every fixture belongs to an entered space', lights.every((id) => spaces.includes(fixtures.get(id)?.space ?? -1)));
    // kills: the interaction lights of each space go off near at + killAt[i]
    const offAt = new Map<number, number>();
    await waitFor(() => {
      for (const e of A.eventsOf<{ lights?: Record<string, boolean> }>('interaction.patch')) {
        for (const [k, on] of Object.entries(e.d.lights ?? {})) {
          const sp = Number(k);
          if (!on && spaces.includes(sp) && !offAt.has(sp) && e.t >= dw.at - 50) offAt.set(sp, e.t);
        }
      }
      return offAt.size >= spaces.length;
    }, Math.max(...killAt) + 4000, 'all spaces dark').catch(() => null);
    const okTimes = spaces.every((sp, i) => offAt.has(sp) && Math.abs(offAt.get(sp)! - (dw.at + killAt[i])) <= 200);
    const inOrder = spaces.every((sp, i) => i === 0 || (offAt.get(sp) ?? 0) >= (offAt.get(spaces[i - 1]) ?? 0) - 40);
    check('dark walk: each space goes dark when its last fixture dies, in step order', okTimes && inOrder,
      spaces.map((sp, i) => `${sp}:${offAt.has(sp) ? (offAt.get(sp)! - dw.at - killAt[i]).toFixed(0) : 'never'}`).join(' '));
    // reconnect: residue (dark walk with dead spaces, the writing) + active
    const cold = await fire('cold_spot', spotsAll(13));
    await D.close();
    await sleep(300);
    await D.connect(url, CREW);
    const sync = await D.req<{ residue: ParanormalEvent[]; active: ParanormalEvent[]; now: number }>('paranormal.sync', {});
    const resIds = sync.residue.map((e) => e.id);
    const dwRes = sync.residue.find((e) => e.id === dw.id);
    check('reconnect: residue has the dark walk with its dead spaces', !!dwRes && ((dwRes.data?.dead as number[]) ?? []).length === spaces.length, dwRes ? `dead ${(dwRes.data?.dead as number[]).join(',')}` : `residue ${resIds.join(',')}`);
    if (fired.mirror_writing) check('reconnect: residue has the revealed writing', sync.residue.some((e) => e.id === fired.mirror_writing!.id && typeof e.data?.revealAt === 'number'));
    if (cold) check('reconnect: active has the running cold spot', sync.active.some((e) => e.id === cold.id), `active ${sync.active.map((e) => e.kind).join(',')}`);
    check('reconnect: the mirror figure (to A) is not sent to D', !sync.active.some((e) => e.kind === 'mirror_figure') && !sync.residue.some((e) => e.kind === 'mirror_figure'));
    // revive: corridors after the timer (shortened), rooms when their switch is back on
    const sw = switchSpaces(L);
    await A.dbg('paranormal.tune', { reviveInSec: 1 });
    const corr = spaces.filter((s) => !sw.has(s));
    const rooms = spaces.filter((s) => sw.has(s));
    for (const s of rooms) await A.dbg('interaction.setLights', { space: s, on: true });
    const revived = await waitFor(() => {
      const r = A.eventsOf<ParanormalEvent>('paranormal.event').filter((e) => e.d.kind === 'revive').map((e) => e.d.space);
      return spaces.every((s) => r.includes(s)) ? r : null;
    }, 6000, 'revives').catch(() => null);
    check('revive: every space revives (corridors on the timer, rooms on their switch)', !!revived, `corridors ${corr.join(',') || '-'} rooms ${rooms.join(',') || '-'}`);
    const sync2 = await D.req<{ residue: ParanormalEvent[] }>('paranormal.sync', {});
    check('revive: the dark walk leaves the residue once every space is back', !sync2.residue.some((e) => e.id === dw.id));
  }

  // ---------------- cost ----------------
  const ps = await A.dbg<{ avgTickMs: number; stats: { planMax: number } }>('paranormal.state');
  check('server cost: <= 0.2 ms per crew tick on average', ps.avgTickMs <= 0.2, `${ps.avgTickMs} ms, plan max ${ps.stats.planMax.toFixed(2)} ms`);
} catch (e) {
  fail = true;
  console.error(e);
  console.error(srv.log().slice(-3000));
} finally {
  for (const b of bots) await b.close().catch(() => null);
  await srv.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(fail || failed.length ? 1 : 0);
