// Owner: env-paranormal (v1.3 F4 dead pokes). Two raw ws bots against a real dev server (no browser, no AI):
//  - flag deadPokes (dbg.setFlags) gates paranormal.poke; the living are refused; the dead knock / flicker
//  - Bob (dead, his pose = his spectator camera) knocks twice by the door in front of Ann: both get the same
//    'paranormal.event' kind dead_poke (knock, count 2), which never names him; a 4 m 'deadStatic' noise goes out
//  - knock 8 s / flicker 20 s cooldowns server-side (an early second knock is refused with the time left)
//  - the flicker pulses the lit room the camera watches; server light state is unchanged
//  - a Hound 2 m beyond the door hears the knock (alert / investigate / growl), then the monsters freeze again
//   node tests/paranormal/pokes.e2e.ts   (PORT default 3814; PARA_SCRATCH = scratch dir for saves/session)
import { join } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ParanormalEvent } from '../../packages/shared/src/messages/paranormal.ts';
import { buildEdgeGrid, fieldAt, initialDoorOpen, soundFlood } from '../../packages/shared/src/nav/index.ts';
import { doorCenter, doorNormal, fixturesBySpace, glowing, indoor, nearVan, spaceAtXZ } from '../../apps/server/src/paranormal/gates.ts';
import { Bot, SCRATCH, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3814);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = ''): boolean => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};

const srv = await startServer(PORT, { SESSION_FILE: join(SCRATCH, 'session.json') });
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann'), B = new Bot('Bob');
type Reply = { ok: boolean; reason?: string; cooldownMs?: number; id?: number; knockMs?: number; flickerMs?: number };
try {
  await A.connect(url, 'POKE');
  await B.connect(url, 'POKE');
  await A.dbg('objectives.start', { seed: 'poke-e2e-1', players: 2, realSec: 900 });
  const L = await waitFor(() => A.eventsOf<{ state?: { layout?: LevelLayout } }>('phase').pop()?.d.state?.layout, 5000, 'layout');
  check('contract started', L.kind === 'facility', `${L.W}x${L.H}`);
  await sleep(3000); // the monsters auto-start after 2.5 s
  await A.dbg('monsters.freeze', { on: true });
  const ms0 = await A.dbg<{ agents?: { id: string; kind: string }[] }>('monsters.state');
  for (const ag of ms0.agents ?? []) await A.dbg('monsters.place', { id: ag.id, active: false, x: 0.5, z: 0.5 });
  // every zone powered, every switch on: the flicker needs a lit room
  for (let z = 0; z <= (L.zones ?? 1); z++) await A.dbg('interaction.power', { zone: z, on: true }).catch(() => null);
  await A.dbg('interaction.setLights', { space: 'all', on: true }).catch(() => null);

  // a closed wooden door between two indoor spaces, the camera's side lit with working fixtures
  const open0 = initialDoorOpen(L);
  const g = buildEdgeGrid(L);
  let scene: { door: number; cam: [number, number]; ann: [number, number]; houndAt: [number, number]; space: number } | null = null;
  for (const d of L.doors) {
    if (scene) break;
    if (d.kind !== 'door' || d.a < 0 || d.b < 0 || open0(d.id) || !indoor(L, d.a) || !indoor(L, d.b)) continue;
    const [cx, cz] = doorCenter(d);
    const [nx, nz] = doorNormal(d);
    for (const sgn of [1, -1]) {
      const cam: [number, number] = [cx + nx * sgn * 1.4, cz + nz * sgn * 1.4];
      const ann: [number, number] = [cx + nx * sgn * 2.2, cz + nz * sgn * 2.2];
      const houndAt: [number, number] = [cx - nx * sgn * 2.3, cz - nz * sgn * 2.3];
      const s = spaceAtXZ(L, cam[0], cam[1]);
      const hs = spaceAtXZ(L, houndAt[0], houndAt[1]);
      const far = s === d.a ? d.b : d.a;
      if (s < 0 || (s !== d.a && s !== d.b) || spaceAtXZ(L, ann[0], ann[1]) !== s || hs !== far || !indoor(L, hs)) continue;
      // the Hound hears the 4 m knock: <= 3 m of sound path from the knock point (0.3 m beyond the leaf) to it
      const knock: [number, number] = [cx - nx * sgn * 0.3, cz - nz * sgn * 0.3];
      if (!(fieldAt(g, soundFlood(g, knock[0], knock[1], 4, open0), houndAt[0], houndAt[1]) <= 3)) continue;
      if (nearVan(L, cam[0], cam[1], 4) || !(fixturesBySpace(L).get(s) ?? []).some(glowing)) continue;
      scene = { door: d.id, cam, ann, houndAt, space: s };
      break;
    }
  }
  if (!check('a closed door scene with a lit room', !!scene)) throw new Error('no scene');
  const sc = scene!;
  await A.dbg('interaction.pose', { pid: A.id, x: sc.ann[0], z: sc.ann[1], yaw: 0, light: 1 });

  // ---------------- gating ----------------
  await A.dbg('setFlags', { set: { deadPokes: false } });
  const r0 = await B.req<Reply>('paranormal.poke', { kind: 'knock', count: 1 });
  check('flag deadPokes off: refused (off)', !r0.ok && r0.reason === 'off', String(r0.reason));
  await A.dbg('setFlags', { set: { deadPokes: true } });
  const r1 = await B.req<Reply>('paranormal.poke', { kind: 'knock', count: 1 });
  check('the living cannot poke (alive)', !r1.ok && r1.reason === 'alive', String(r1.reason));
  await A.dbg('interaction.kill', { pid: B.id, killer: 'HOUND', reason: 'test' });
  await A.dbg('interaction.pose', { pid: B.id, x: sc.cam[0], z: sc.cam[1], yaw: 0, light: 0 });
  const dead = await waitFor(async () => {
    const st = await A.dbg<{ players: { id: string; alive: boolean }[] }>('state');
    return st.players.find((p) => p.id === B.id)?.alive === false;
  }, 3000, 'Bob dead');
  check('Bob is dead (interaction.kill)', dead);

  // ---------------- knock ----------------
  const before = (await A.dbg<{ kind: string; radiusM: number; source: string; x: number; z: number }[]>('players.noise')).length;
  const k1 = await B.req<Reply>('paranormal.poke', { kind: 'knock', count: 2 });
  const kReadyAt = performance.now() + (k1.knockMs ?? 8000);
  check('a dead player knocks (ok, 8 s cooldown)', k1.ok && k1.cooldownMs === 8000 && k1.knockMs === 8000, JSON.stringify(k1));
  const evs = await waitFor(() => {
    const ea = A.eventsOf<ParanormalEvent>('paranormal.event').find((e) => e.d.id === k1.id);
    const eb = B.eventsOf<ParanormalEvent>('paranormal.event').find((e) => e.d.id === k1.id);
    return ea && eb ? [ea, eb] : null;
  }, 3000, 'knock delivered').catch(() => null);
  if (check('the knock reaches the living and the dead', !!evs)) {
    const [ea, eb] = evs!;
    const ev = ea.d;
    check('dead_poke knock x2, identical for both, at >= now + 250', ev.kind === 'dead_poke' && ev.data?.poke === 'knock' && ev.data?.count === 2
      && JSON.stringify(ea.d) === JSON.stringify(eb.d) && ev.at - ea.t >= 250, `door ${String(ev.data?.door)} lead ${Math.round(ev.at - ea.t)} ms`);
    check('the event never names the poker', !JSON.stringify(ev).includes(B.id) && !JSON.stringify(ev).includes('Bob'));
    check('knocks on the scene door from the far side', ev.data?.door === sc.door && spaceAtXZ(L, ev.p![0], ev.p![2]) !== sc.space, `p ${ev.p!.map((v) => v.toFixed(2)).join(',')}`);
  }
  const noises = (await A.dbg<{ kind: string; radiusM: number; source: string }[]>('players.noise')).slice(before);
  const nz = noises.find((n) => n.kind === 'deadStatic');
  check('a 4 m deadStatic noise with no player source', !!nz && nz.radiusM === 4 && nz.source === '', nz ? JSON.stringify(nz) : `noises ${noises.map((n) => n.kind).join(',')}`);
  const k2 = await B.req<Reply>('paranormal.poke', { kind: 'knock', count: 1 });
  check('an early second knock is refused with the time left', !k2.ok && k2.reason === 'cooldown' && (k2.cooldownMs ?? 0) > 6000 && (k2.cooldownMs ?? 0) <= 8000, JSON.stringify(k2));

  // ---------------- flicker ----------------
  await sleep(1300); // crew-wide gap
  const lightsOf = async () => JSON.stringify((await A.dbg<{ lights?: unknown; switches?: unknown }>('interaction.state')).lights ?? null);
  const lightsBefore = await lightsOf();
  const f1 = await B.req<Reply>('paranormal.poke', { kind: 'flicker' });
  check('the dead flicker the watched room (ok, 20 s cooldown)', f1.ok && f1.cooldownMs === 20_000, JSON.stringify(f1));
  const fev = await waitFor(() => A.eventsOf<ParanormalEvent>('paranormal.event').find((e) => e.d.id === f1.id), 3000, 'flicker delivered').catch(() => null);
  if (check('the flicker reaches the living', !!fev)) {
    const want = (fixturesBySpace(L).get(sc.space) ?? []).filter(glowing).map((f) => f.id);
    const got = (fev!.d.data?.lights as string[] | undefined) ?? [];
    check('flicker: the camera room, its glowing fixtures', fev!.d.space === sc.space && got.length > 0 && got.every((id) => want.includes(id)), `${got.length} lights`);
  }
  const f2 = await B.req<Reply>('paranormal.poke', { kind: 'brownout' });
  check("an early second flicker ('brownout' alias) is refused", !f2.ok && f2.reason === 'cooldown' && (f2.cooldownMs ?? 0) > 17_000, JSON.stringify(f2));
  const lightsAfter = await lightsOf();
  check('server light state unchanged by the flicker', lightsBefore === lightsAfter);
  const a1 = await A.req<Reply>('paranormal.poke', { kind: 'flicker' });
  check('Ann (alive) still refused', !a1.ok && a1.reason === 'alive');

  // ---------------- the Hound hears it ----------------
  const hound = (ms0.agents ?? []).find((a) => a.kind === 'hound');
  if (hound) {
    // wait out the knock cooldown with the monsters frozen (an idle Hound wanders off), then place it and knock at once
    await sleep(Math.max(0, kReadyAt - performance.now()) + 50);
    await A.dbg('monsters.place', { id: hound.id, active: true, x: sc.houndAt[0], z: sc.houndAt[1], state: 'idle' });
    await A.dbg('monsters.freeze', { on: false });
    const cueBefore = A.eventsOf('monsters.cue').length;
    const st0 = (await A.dbg<{ agents: { id: string; state: string }[] }>('monsters.state')).agents.find((a) => a.id === hound.id)?.state;
    const k3 = await B.req<Reply>('paranormal.poke', { kind: 'knock', count: 1 });
    check('the knock is ready again after 8 s', k3.ok, JSON.stringify(k3));
    const reacted = await waitFor(async () => {
      const s = (await A.dbg<{ agents: { id: string; state: string }[] }>('monsters.state')).agents.find((a) => a.id === hound.id)?.state;
      const cues = A.eventsOf<{ cue?: string; id?: string }>('monsters.cue').slice(cueBefore).filter((c) => c.d.cue === 'growl');
      return s && s !== st0 && s !== 'idle' ? `${st0} -> ${s}${cues.length ? ', growl' : ''}` : cues.length ? `growl (${s})` : null;
    }, 2500, 'hound reaction').catch(() => null);
    const hd = (await A.dbg<{ agents: Record<string, unknown>[] }>('monsters.state')).agents.find((a) => a.id === hound.id);
    check('a Hound 2 m beyond the door hears the knock', !!reacted, reacted ?? `still ${st0}: ${JSON.stringify(hd)}`);
    await A.dbg('monsters.freeze', { on: true });
  } else console.log('info  no hound in this layout: skipped the hearing check');

  // ---------------- kill switch ----------------
  await A.dbg('setFlags', { set: { deadPokes: false } });
  await sleep(1300);
  const r9 = await B.req<Reply>('paranormal.poke', { kind: 'flicker' });
  check('flag flipped off at runtime: refused at once', !r9.ok && r9.reason === 'off');
  const st = await A.dbg<{ pokes?: { on: boolean; stats: { knocks: number; flickers: number } | null } }>('paranormal.state');
  check('dbg state counts the pokes', !!st.pokes?.stats && st.pokes.stats.knocks >= 1 && st.pokes.stats.flickers === 1, JSON.stringify(st.pokes));
  const errs = srv.log().split('\n').filter((l) => /\[paranormal\].*(error|threw|failed)/i.test(l));
  check('no paranormal errors in the server log', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.message : String(e));
} finally {
  await A.close().catch(() => null);
  await B.close().catch(() => null);
  await srv.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
