// Owner: env-paranormal (v1.3 F4 dead pokes). The pure poke core (pokes.ts) on a generated facility, and the
// paranormal.poke request behind a fake ServerContext:
//  - only the dead poke, and only near a living teammate; knock 8 s / flicker 20 s cooldowns per dead player, a crew-wide
//    gap, per-contract caps; a refused poke changes nothing and reports the time left
//  - knock: the closed door of the camera's space (far side, 0.3 m beyond the leaf), else a wall within 3 m; never by a
//    hidden player; count 1-3; a 4 m 'deadStatic' noise with no player source (monsters drop the dead's own noises)
//  - flicker: the lit room the camera watches, glowing fixtures only, no server light change
//  - flag deadPokes off (or missing) = refused 'off'; the event never names the poker; living hearers witness the knock
//   node --test tests/paranormal/pokes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { EDGE, buildEdgeGrid, initialDoorOpen } from '../../packages/shared/src/nav/index.ts';
import type { DoorOpenFn } from '../../packages/shared/src/nav/index.ts';
import { STANCE } from '../../packages/shared/src/state.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ParanormalEvent } from '../../packages/shared/src/messages/paranormal.ts';
import type { Crew, ServerContext, ServerPlayer, ServerSystem } from '../../apps/server/src/core/types.ts';
import { resolveBalance } from '../../apps/server/src/paranormal/balance.ts';
import { flickerRoom, knockSpot, newPokeState, pokeCooldowns, pokeOnce } from '../../apps/server/src/paranormal/pokes.ts';
import { doorCenter, doorNormal, fixturesBySpace, glowing, indoor, nearVan, spaceAtXZ } from '../../apps/server/src/paranormal/gates.ts';
import type { ParaPlayer, ParaWorld } from '../../apps/server/src/paranormal/types.ts';
import { install } from '../../apps/server/src/paranormal/index.ts';
import { onPhenomenon } from '../../apps/server/src/paranormal/api.ts';
import type { PhenomenonRecord } from '../../apps/server/src/paranormal/api.ts';
import { onNoise } from '../../apps/server/src/players/noise.ts';
import type { NoiseEvent } from '../../apps/server/src/players/noise.ts';

const L = generateFacility({ seed: 'pokes-1', players: 2, risk: 1 });
const grid = buildEdgeGrid(L);
const B = resolveBalance({});

const P = (id: string, x: number, z: number, o: Partial<ParaPlayer> = {}): ParaPlayer =>
  ({ id, name: id, x, z, yaw: 0, light: true, alive: true, inVan: false, hidden: null, core: false, grabbed: false, ...o });

interface TestWorld extends ParaWorld { setCalls: number; t: number; list: ParaPlayer[] }
function world(players: ParaPlayer[], o: { doorOpen?: DoorOpenFn; lights?: (s: number) => boolean } = {}): TestWorld {
  const doorOpen = o.doorOpen ?? initialDoorOpen(L);
  const w: TestWorld = {
    setCalls: 0, t: 1_000_000, list: players,
    layout: L, grid, doorOpen,
    now: () => w.t,
    players: () => w.list,
    monsters: () => [],
    director: () => null,
    clockMin: () => 60,
    contractRealSec: () => 900,
    blackout: () => false,
    coreLifted: () => false,
    lightsOn: o.lights ?? ((s) => L.spaces[s]?.light !== 'off' && L.spaces[s]?.light !== 'broken'),
    setLights: () => { w.setCalls++; },
    mirrors: () => [],
    movables: () => [],
    loreSpots: () => [],
    themeHaunt: () => 0,
    snatcherLurking: () => false,
  };
  return w;
}

/** a closed wooden door between two indoor spaces: the camera 1.4 m in front of it, a living teammate 2.2 m out */
function doorScene(): { d: LevelLayout['doors'][number]; cam: { x: number; z: number }; live: { x: number; z: number }; space: number; sgn: number } {
  const open0 = initialDoorOpen(L);
  for (const d of L.doors) {
    if (d.kind !== 'door' || d.a < 0 || d.b < 0 || open0(d.id) || !indoor(L, d.a) || !indoor(L, d.b)) continue;
    const [cx, cz] = doorCenter(d);
    const [nx, nz] = doorNormal(d);
    for (const sgn of [1, -1]) {
      const cam = { x: cx + nx * sgn * 1.4, z: cz + nz * sgn * 1.4 };
      const live = { x: cx + nx * sgn * 2.2, z: cz + nz * sgn * 2.2 };
      const s = spaceAtXZ(L, cam.x, cam.z);
      if (s < 0 || (s !== d.a && s !== d.b) || spaceAtXZ(L, live.x, live.z) !== s || nearVan(L, cam.x, cam.z, 3)) continue;
      return { d, cam, live, space: s, sgn };
    }
  }
  throw new Error('no closed door scene in this layout');
}

/** a lit room with glowing fixtures: a cell inside it for the camera and one for the teammate */
function litRoom(): { space: number; cam: { x: number; z: number }; live: { x: number; z: number } } {
  for (const s of L.spaces) {
    if (!indoor(L, s.id) || s.kind === 'corridor' || s.light === 'off' || s.light === 'broken') continue;
    if (!(fixturesBySpace(L).get(s.id) ?? []).some(glowing)) continue;
    const cam = { x: s.rect.x + s.rect.w / 2 + 0.25, z: s.rect.y + s.rect.h / 2 + 0.25 };
    const live = { x: cam.x + 0.8, z: cam.z };
    if (spaceAtXZ(L, cam.x, cam.z) !== s.id || spaceAtXZ(L, live.x, live.z) !== s.id || nearVan(L, cam.x, cam.z, 3)) continue;
    return { space: s.id, cam, live };
  }
  throw new Error('no lit room');
}

test('knock: only the dead, near the living; the closed door of the camera space, far side; count 1-3; a 4 m noise', () => {
  const sc = doorScene();
  const dead = P('d1', sc.cam.x, sc.cam.z, { alive: false });
  const ann = P('ann', sc.live.x, sc.live.z);
  const w = world([dead, ann]);
  const ps = newPokeState('k1');
  // the living cannot poke
  assert.equal(pokeOnce(ps, w, B, 'ann', 'knock', 1, w.t).reason, 'alive');
  const r = pokeOnce(ps, w, B, 'd1', 'knock', 7, w.t);
  assert.equal(r.ok, true, `knock accepted (${r.reason})`);
  const data = r.built!.ev.data!;
  assert.equal(r.built!.kind, 'dead_poke');
  assert.equal(data.poke, 'knock');
  assert.equal(data.count, 3, 'count clamped to 3');
  assert.ok(!('from' in data) && !('pid' in data) && r.built!.target === null, 'never names the poker');
  const door = L.doors[Number(data.door)];
  assert.ok(door && (door.a === sc.space || door.b === sc.space), 'a door of the camera space');
  assert.equal(w.doorOpen(door.id), false, 'a closed door');
  const [cx, cz] = doorCenter(door);
  const [nx, nz] = doorNormal(door);
  assert.ok(Math.hypot(cx - sc.cam.x, cz - sc.cam.z) <= B.poke.knockM, 'within knockM of the camera');
  const [kx, , kz] = r.built!.ev.p!;
  const camSide = Math.sign((sc.cam.x - cx) * nx + (sc.cam.z - cz) * nz);
  const knockSide = Math.sign((kx - cx) * nx + (kz - cz) * nz);
  assert.equal(knockSide, -camSide, 'knocks from the far side');
  assert.ok(Math.abs(Math.abs((kx - cx) * nx + (kz - cz) * nz) - 0.3) < 0.02, '0.3 m beyond the leaf');
  assert.deepEqual(r.noise, { x: r.noise!.x, z: r.noise!.z, radiusM: 4 });
  assert.equal(r.cooldownMs, 8000);
  // count 0 / NaN -> 1
  w.t += 8001;
  assert.equal(pokeOnce(ps, w, B, 'd1', 'knock', 0, w.t).built!.ev.data!.count, 1);
  w.t += 8001;
  assert.equal(pokeOnce(ps, w, B, 'd1', 'knock', Number.NaN, w.t).built!.ev.data!.count, 1);
  assert.equal(w.setCalls, 0, 'no server light change');
});

test('cooldowns: knock 8 s and flicker 20 s per dead player, independent; refusals report the time left and change nothing', () => {
  const room = litRoom();
  const w = world([P('d1', room.cam.x, room.cam.z, { alive: false }), P('ann', room.live.x, room.live.z)]);
  const ps = newPokeState('k2');
  const t0 = w.t;
  assert.equal(pokeOnce(ps, w, B, 'd1', 'knock', 2, t0).ok, true);
  const again = pokeOnce(ps, w, B, 'd1', 'knock', 2, t0 + 1000);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'cooldown');
  assert.equal(again.cooldownMs, 7000);
  // the flicker has its own cooldown (after the crew-wide 1.2 s gap)
  const f1 = pokeOnce(ps, w, B, 'd1', 'flicker', 1, t0 + 1500);
  assert.equal(f1.ok, true, `flicker (${f1.reason})`);
  assert.equal(f1.cooldownMs, 20_000);
  const f2 = pokeOnce(ps, w, B, 'd1', 'flicker', 1, t0 + 3000);
  assert.equal(f2.reason, 'cooldown');
  assert.equal(f2.cooldownMs, 18_500);
  assert.deepEqual(pokeCooldowns(ps, B, 'd1', t0 + 3000), { knockMs: 5000, flickerMs: 18_500 });
  assert.equal(pokeOnce(ps, w, B, 'd1', 'knock', 1, t0 + 7999).reason, 'cooldown');
  assert.equal(pokeOnce(ps, w, B, 'd1', 'knock', 1, t0 + 8000).ok, true, 'ready again at 8 s');
  assert.equal(pokeOnce(ps, w, B, 'd1', 'flicker', 1, t0 + 21_499).reason, 'cooldown');
  assert.equal(pokeOnce(ps, w, B, 'd1', 'flicker', 1, t0 + 21_500).ok, true, 'ready again at 20 s');
  assert.equal(ps.stats.knocks, 2);
  assert.equal(ps.stats.flickers, 2);
  assert.equal(ps.stats.refused.cooldown, 4);
});

test('crew-wide gap between two dead players, per-contract caps', () => {
  const room = litRoom();
  const w = world([P('d1', room.cam.x, room.cam.z, { alive: false }), P('d2', room.cam.x, room.cam.z + 0.3, { alive: false }), P('ann', room.live.x, room.live.z)]);
  const ps = newPokeState('k3');
  const t0 = w.t;
  assert.equal(pokeOnce(ps, w, B, 'd1', 'knock', 1, t0).ok, true);
  const busy = pokeOnce(ps, w, B, 'd2', 'knock', 1, t0 + 500);
  assert.equal(busy.reason, 'busy');
  assert.equal(busy.cooldownMs, 700);
  assert.equal(pokeOnce(ps, w, B, 'd2', 'knock', 1, t0 + 1200).ok, true, 'after the gap');
  const tight = resolveBalance({ poke: { knockMax: 2 } });
  const ps2 = newPokeState('k3b');
  assert.equal(pokeOnce(ps2, w, tight, 'd1', 'knock', 1, t0).ok, true);
  assert.equal(pokeOnce(ps2, w, tight, 'd1', 'knock', 1, t0 + 9000).ok, true);
  assert.equal(pokeOnce(ps2, w, tight, 'd1', 'knock', 1, t0 + 18_000).reason, 'budget');
});

test('only near a living teammate; a wall when no closed door is in reach; never by a hidden player', () => {
  const sc = doorScene();
  // nobody alive near the camera
  const far = world([P('d1', sc.cam.x, sc.cam.z, { alive: false }), P('ann', sc.cam.x + 40, sc.cam.z + 40)]);
  assert.equal(pokeOnce(newPokeState('f'), far, B, 'd1', 'knock', 1, far.t).reason, 'far');
  // every door open: the nearest wall of the camera's space, 0.12 m in front of it
  const open = world([P('d1', sc.cam.x, sc.cam.z, { alive: false }), P('ann', sc.live.x, sc.live.z)], { doorOpen: () => true });
  const spot = knockSpot(open, B, sc.cam, open.list);
  assert.ok(spot, 'a wall spot');
  assert.equal(spot!.door, -1);
  assert.equal(spot!.space, sc.space, 'a wall of the camera space');
  assert.ok(Math.hypot(spot!.x - sc.cam.x, spot!.z - sc.cam.z) <= B.poke.wallM + 1e-6, 'within wallM');
  const cx = Math.floor(spot!.x), cz = Math.floor(spot!.z);
  const fx = spot!.x - cx, fz = spot!.z - cz;
  const nearEdge = Math.min(Math.abs(fx - 0.12), Math.abs(fx - 0.88), Math.abs(fz - 0.12), Math.abs(fz - 0.88)) < 1e-6;
  assert.ok(nearEdge, '0.12 m in front of a cell edge');
  // which edge: a wall
  const edges = [grid.v[cz * (grid.W + 1) + cx], grid.v[cz * (grid.W + 1) + cx + 1], grid.h[cz * grid.W + cx], grid.h[(cz + 1) * grid.W + cx]];
  assert.ok(edges.includes(EDGE.wall), 'that edge is a wall');
  // a hidden (living) teammate right at the door: not that door
  const r0 = pokeOnce(newPokeState('h0'), world([P('d1', sc.cam.x, sc.cam.z, { alive: false }), P('ann', sc.live.x, sc.live.z)]), B, 'd1', 'knock', 1, 0);
  const [kx, , kz] = r0.built!.ev.p!;
  const hid = world([P('d1', sc.cam.x, sc.cam.z, { alive: false }), P('ann', sc.live.x, sc.live.z), P('bob', kx, kz, { hidden: 'hiding:1' })]);
  const r1 = pokeOnce(newPokeState('h1'), hid, B, 'd1', 'knock', 1, 0);
  if (r1.ok) {
    const [x1, , z1] = r1.built!.ev.p!;
    assert.ok(Math.hypot(x1 - kx, z1 - kz) >= B.poke.hiddenM, `not within ${B.poke.hiddenM} m of the hidden player`);
  } else assert.equal(r1.reason, 'nothing');
});

test('flicker: the lit room the camera watches, glowing fixtures only; dark rooms refused; no server light change', () => {
  const room = litRoom();
  const w = world([P('d1', room.cam.x, room.cam.z, { alive: false }), P('ann', room.live.x, room.live.z)]);
  const fr = flickerRoom(w, B, room.cam, w.list, 'd1');
  assert.ok(fr);
  assert.equal(fr!.space, room.space);
  const want = (fixturesBySpace(L).get(room.space) ?? []).filter(glowing).map((f) => f.id);
  assert.deepEqual(fr!.lights, want);
  const r = pokeOnce(newPokeState('fl'), w, B, 'd1', 'flicker', 1, w.t);
  assert.equal(r.ok, true);
  assert.equal(r.built!.ev.data!.poke, 'flicker');
  assert.equal(r.built!.ev.data!.curve, 'pulse');
  assert.equal(r.built!.ev.ms, 2400);
  assert.equal(r.noise, undefined, 'a flicker makes no noise');
  assert.equal(w.setCalls, 0);
  const dark = world([P('d1', room.cam.x, room.cam.z, { alive: false }), P('ann', room.live.x, room.live.z)], { lights: () => false });
  assert.equal(pokeOnce(newPokeState('dk'), dark, B, 'd1', 'flicker', 1, dark.t).reason, 'dark');
});

// ---------------------------------------------------------------- the request behind a fake ServerContext

interface Fake {
  ctx: ServerContext;
  sys: ServerSystem;
  reqs: Map<string, (crew: Crew, p: ServerPlayer, a: unknown) => unknown>;
  emits: { e: string; d: unknown; to?: string[] }[];
  now: { t: number };
  flags: Record<string, boolean>;
}

function fakeCtx(flags: Record<string, boolean>): Fake {
  const reqs = new Map<string, (crew: Crew, p: ServerPlayer, a: unknown) => unknown>();
  const emits: Fake['emits'] = [];
  const now = { t: 5_000_000 };
  let sys: ServerSystem | null = null;
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const ctx = {
    cfg: {} as never, flags, balance: { core: { contractRealSec: 900 }, paranormal: {} }, env: { dev: true } as never,
    log: () => logger,
    crews: {} as never,
    registerSystem: (s: ServerSystem) => { if (s.name === 'paranormal') sys = s; },
    registerReq: (n: string, h: (crew: Crew, p: ServerPlayer, a: unknown) => unknown) => { reqs.set(n, h); },
    registerDbg: (n: string, h: (crew: Crew, p: ServerPlayer, a: unknown) => unknown) => { reqs.set(n.startsWith('dbg.') ? n : `dbg.${n}`, h); },
    onVoiceChunk: noop,
    emit: (_crew: Crew, e: string, d: unknown, opts?: { to?: string[] }) => { emits.push({ e, d, to: opts?.to }); },
    send: noop, sendSig: noop, notice: noop,
    hooks: { join: [], leave: [], phase: [], pose: [], loud: [], crewSnapshot: [], snapshot: [], fullState: [], welcome: [], config: [] },
    setPhase: noop, buildFullState: noop as never,
    now: () => now.t,
    reloadConfig: noop,
  } as unknown as ServerContext;
  install(ctx);
  return { ctx, sys: sys!, reqs, emits, now, flags };
}

function crewAt(alive: { x: number; z: number }, dead: { x: number; z: number }): Crew {
  const players = new Map<string, ServerPlayer>();
  const mk = (id: string, name: string, p: { x: number; z: number }, isAlive: boolean): ServerPlayer => ({
    id, key: `k${id}`, name, profile: {} as never, connected: true, ready: true, alive: isAlive, consent: { transcribe: true, mimic: false },
    level: 1, pose: { seq: 1, p: [p.x, isAlive ? 0 : 1.7, p.z], yaw: 0, pitch: 0, stance: isAlive ? STANCE.stand : STANCE.dead, anim: 0, light: 0 } as never,
    poseAt: 0, band: 0, radio: 0, socket: null, resume: '', joinedAt: 0, isLeader: id === 'p0', disconnectedAt: 0, slices: {},
  });
  players.set('p0', mk('p0', 'Ann', alive, true));
  players.set('p1', mk('p1', 'Bob', dead, false));
  return { code: 'POKE', phase: 'contract', players, layout: L, slices: {}, createdAt: 0, tick: 0, emptySince: 0 };
}

test('paranormal.poke request: flag deadPokes gates it; event + noise + cooldown reply; living hearers witness the knock', () => {
  const sc = doorScene();
  const noises: NoiseEvent[] = [];
  const offNoise = onNoise((_c, n) => { noises.push(n); });
  const recs: PhenomenonRecord[] = [];
  const offRec = onPhenomenon((_c, r) => { recs.push(r); });
  try {
    // flag missing = off
    const off = fakeCtx({ paranormal: true });
    const crew0 = crewAt(sc.live, sc.cam);
    off.sys.tick(1 / 30, crew0, off.ctx);
    assert.deepEqual(off.reqs.get('paranormal.poke')!(crew0, crew0.players.get('p1')!, { kind: 'knock', count: 1 }), { ok: false, reason: 'off' });
    const f = fakeCtx({ paranormal: true, deadPokes: true });
    const crew = crewAt(sc.live, sc.cam);
    f.sys.tick(1 / 30, crew, f.ctx);
    const poke = f.reqs.get('paranormal.poke')!;
    // 'write' stays off; the living cannot poke
    assert.equal((poke(crew, crew.players.get('p1')!, { kind: 'write' }) as { reason: string }).reason, 'off');
    assert.equal((poke(crew, crew.players.get('p0')!, { kind: 'knock' }) as { reason: string }).reason, 'alive');
    const r = poke(crew, crew.players.get('p1')!, { kind: 'knock', count: 2 }) as { ok: boolean; id: number; cooldownMs: number; knockMs: number; flickerMs: number };
    assert.equal(r.ok, true);
    assert.equal(r.cooldownMs, 8000);
    assert.equal(r.knockMs, 8000);
    assert.equal(r.flickerMs, 0);
    const ev = f.emits.find((e) => e.e === 'paranormal.event' && (e.d as ParanormalEvent).id === r.id)?.d as ParanormalEvent | undefined;
    assert.ok(ev, 'paranormal.event sent');
    assert.equal(ev!.kind, 'dead_poke');
    assert.equal(ev!.data?.poke, 'knock');
    assert.equal(ev!.data?.count, 2);
    assert.equal(f.emits.find((e) => e.d === ev)?.to, undefined, 'to the whole crew');
    assert.ok(!JSON.stringify(ev).includes('p1') && !JSON.stringify(ev).includes('Bob'), 'the event never names the poker');
    assert.ok(ev!.at >= f.now.t + 250, 'at >= now + 250');
    const n = noises.find((x) => x.kind === 'deadStatic');
    assert.ok(n, 'a deadStatic noise');
    assert.equal(n!.radiusM, 4);
    assert.equal(n!.source, '', 'no player source (monsters drop noises from dead players)');
    const again = poke(crew, crew.players.get('p1')!, { kind: 'knock', count: 1 }) as { ok: boolean; reason: string; cooldownMs: number };
    assert.deepEqual([again.ok, again.reason, again.cooldownMs], [false, 'cooldown', 8000]);
    // 'brownout' is the flicker; the dbg state shows the counts
    const st = f.reqs.get('dbg.paranormal.state')!(crew, crew.players.get('p0')!, {}) as { pokes: { on: boolean; stats: { knocks: number } } };
    assert.equal(st.pokes.on, true);
    assert.equal(st.pokes.stats.knocks, 1);
    // run past the knock's end: Ann (alive, within hearM) witnessed it, Bob (dead) did not
    for (let i = 0; i < 30 * 4; i++) { f.now.t += 1000 / 30; f.sys.tick(1 / 30, crew, f.ctx); }
    const rec = recs.find((x) => x.id === r.id);
    assert.ok(rec, 'a phenomenon record at its end');
    assert.equal(rec!.kind, 'dead_poke');
    assert.deepEqual(rec!.witnesses, ['p0']);
    f.now.t += 8000;
    assert.equal((poke(crew, crew.players.get('p1')!, { kind: 'knock', count: 3 }) as { ok: boolean }).ok, true, 'ready again after 8 s');
    // flipping the flag off refuses at once
    f.flags.deadPokes = false;
    f.now.t += 30_000;
    assert.equal((poke(crew, crew.players.get('p1')!, { kind: 'knock' }) as { reason: string }).reason, 'off');
    // outside a contract
    f.flags.deadPokes = true;
    crew.phase = 'results';
    assert.equal((poke(crew, crew.players.get('p1')!, { kind: 'knock' }) as { reason: string }).reason, 'phase');
  } finally {
    offNoise();
    offRec();
  }
});
