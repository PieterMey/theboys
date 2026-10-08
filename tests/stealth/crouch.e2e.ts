// players-stealth (v1.2) e2e with ws bots (no browser, no GPU): honest server footsteps.
//   - a crouch claim at 3.5 m/s becomes walk steps (after crouchOverSpeedSec); at 5.5 m/s it is a sprint at once
//   - creeping at 1.5 m/s (steady and bunched like the tunnel) gives only crouch steps <= 2.1 m
//   - walking radii on metal / tile / carpet (a themed layout if env-layout provides one, else a dev floor override)
//   - overshoes walk at 4 m; a fake hidden stance makes normal steps; no steps while grabbed
//   - stealthStance() for the monsters package; a dead-stance claim from a living player cannot cross a wall
//   - flag stealthV12 off (per-crew dev override) = the v1.1 footsteps
// Run: PORT=3801 (a dev server there, else the test starts one) node tests/stealth/crouch.e2e.ts
import { STANCE } from '../../packages/shared/src/state.ts';
import { Bot, assert, circleStart, crewCode, ensureServer, idle, noises, sleep, walk } from './bot.ts';
import type { NoiseRec } from './bot.ts';

interface SurfaceSpot { space: number; kind: string; type: string; surface: string; x: number; z: number }
interface StealthProbe { stance: number; speed: number; overSec: number; surface: string; soles: boolean; v12: boolean; hidden: boolean; grabbed: boolean }

const srv = await ensureServer();
const b = new Bot('Creeper');
const results: Record<string, unknown> = {};
const stubs: string[] = [];
let failed = false;
try {
  await b.connect(srv.ws, crewCode('STL'));
  // a themed facility when env-layout's generator takes a theme (records/hospitality floors carry carpet), else v1.1
  let gen: unknown = null;
  try { gen = await b.dbg('level.generate', { seed: 'stealth-e2e', players: 1, risk: 1, theme: 'hospitality' }); } catch { gen = null; }
  if (!gen) gen = await b.dbg('players.testLevel', { seed: 'stealth-e2e', players: 1, risk: 1 });
  results.level = gen;
  // the contract phase starts the monsters (objectives): freeze them so nothing hunts the bot while it measures
  results.monstersFrozen = await b.dbg('monsters.freeze', { on: true }).catch(() => 'n/a');
  await sleep(2800); // spawn lock (2.5 s) + the net track's join grace
  const spots = await b.dbg<SurfaceSpot[]>('players.surfaces');
  const bySurface = new Map<string, SurfaceSpot>();
  for (const s of spots) if (!bySurface.has(s.surface) || s.kind === 'room') bySurface.set(s.surface, s);
  results.surfaces = [...new Set(spots.map((s) => s.surface))].sort();
  const neutral = spots.find((s) => s.surface === 'lino' && s.kind === 'corridor') ?? spots.find((s) => ['lino', 'concrete', 'asphalt'].includes(s.surface));
  assert(neutral, 'a neutral floor to walk on');

  const probe = () => b.dbg<StealthProbe>('players.stealth');
  const stepsSince = async (t0: number): Promise<NoiseRec[]> => (await noises(b)).filter((n) => n.source === b.id && n.t > t0 && /Step$/.test(n.kind));
  const lastT = async () => Math.max(0, ...(await noises(b)).map((n) => n.t));
  /** teleport (server + bot), settle, then walk; returns this bot's steps during the walk and a mid-walk probe */
  const run = async (spot: { x: number; z: number }, stance: number, speed: number, seconds: number, extra: { bunch?: number; stepMs?: number } = {}) => {
    const [sx, sz] = circleStart(spot.x, spot.z);
    await b.dbg('net.teleport', { x: sx, z: sz });
    await idle(b, sx, sz, 700, stance);
    const t0 = await lastT();
    let mid: StealthProbe | null = null;
    const w = walk(b, spot.x, spot.z, { speed, seconds, stance, ...extra });
    await sleep(Math.min(seconds * 1000 - 200, 1600));
    mid = await probe();
    const [ex, ez] = await w;
    await idle(b, ex, ez, 300, stance); // stop where the walk ended (a hop back to the start would read as a sprint)
    return { steps: await stepsSince(t0), mid };
  };
  const kinds = (st: NoiseRec[]) => st.map((s) => s.kind.replace('Step', ''));
  const check = (cond: unknown, msg: string) => {
    if (!cond) { failed = true; console.log(`FAIL: ${msg}`); }
  };

  // ---- 1. creeping: steady and bunched ----
  const creep = await run(neutral, STANCE.crouch, 1.5, 3);
  results.creep = { kinds: kinds(creep.steps), radii: creep.steps.map((s) => s.radiusM), mid: creep.mid };
  check(creep.steps.length >= 3, `creep made steps (${creep.steps.length})`);
  check(creep.steps.every((s) => s.kind === 'crouchStep' && s.radiusM <= 2.1), `creep: crouch steps <= 2.1 m only (${kinds(creep.steps)})`);
  check(creep.mid?.stance === STANCE.crouch, `stealthStance while creeping = crouch (${creep.mid?.stance})`);
  for (const bunch of [3, 5]) {
    const bc = await run(neutral, STANCE.crouch, 1.5, 3, { bunch });
    results[`creepBunched${bunch}`] = { kinds: kinds(bc.steps), radii: bc.steps.map((s) => s.radiusM), mid: bc.mid };
    check(bc.steps.length >= 3 && bc.steps.every((s) => s.kind === 'crouchStep' && s.radiusM <= 2.1), `bunched x${bunch} creep: crouch steps only (${kinds(bc.steps)})`);
    check(bc.mid?.stance === STANCE.crouch, `bunched x${bunch}: stealthStance crouch (${bc.mid?.stance}, speed ${bc.mid?.speed})`);
  }
  // a slow client: one pose per 125 ms (8 fps) creeping
  const slow = await run(neutral, STANCE.crouch, 1.5, 3, { stepMs: 125 });
  results.creepSlowClient = { kinds: kinds(slow.steps), mid: slow.mid };
  check(slow.steps.length >= 2 && slow.steps.every((s) => s.kind === 'crouchStep'), `8 fps creep: crouch steps only (${kinds(slow.steps)})`);

  // ---- 2. a crouch claim at walking speed walks, at sprint speed sprints (plan check #6) ----
  const fast = await run(neutral, STANCE.crouch, 3.5, 3);
  const fk = kinds(fast.steps);
  results.crouchClaim35 = { kinds: fk, radii: fast.steps.map((s) => s.radiusM), mid: fast.mid };
  check(fast.steps.filter((s) => s.kind === 'walkStep').length >= 3, `3.5 m/s crouch claim gives walk steps (${fk})`);
  check(fk.lastIndexOf('crouch') < fk.indexOf('walk') || !fk.includes('crouch'), `crouch steps only before the demotion (${fk})`);
  check(fast.steps.slice(-4).every((s) => s.kind === 'walkStep'), `the last steps walk (${fk})`);
  check(fast.mid?.stance === STANCE.stand, `stealthStance of a 3.5 m/s crouch claim = stand (${fast.mid?.stance}, speed ${fast.mid?.speed})`);
  const sprint = await run(neutral, STANCE.crouch, 5.5, 2.4);
  results.crouchClaim55 = { kinds: kinds(sprint.steps), mid: sprint.mid };
  check(sprint.steps.length >= 2 && sprint.steps.slice(1).every((s) => s.kind === 'sprintStep'), `5.5 m/s crouch claim sprints (${kinds(sprint.steps)})`);
  check(sprint.mid?.stance === STANCE.sprint, `stealthStance at 5.5 m/s = sprint (${sprint.mid?.stance})`);

  // ---- 3. walking radii per floor ----
  const radii: Record<string, unknown> = {};
  for (const [surface, want] of [['metal', 6.5], ['tile', 5.5], ['carpet', 4.25], ['grate', 7], ['lino', 5]] as const) {
    let spot: { x: number; z: number } | undefined = bySurface.get(surface);
    let via = 'layout';
    if (!spot) {
      // env-layout's themed floors not in this layout (yet): the dev floor override on a neutral floor
      await b.dbg('players.stealth', { surface });
      spot = neutral;
      via = 'override';
      stubs.push(`${surface} floor via dbg override`);
    }
    const r = await run(spot, STANCE.stand, 3.0, 2.2);
    await b.dbg('players.stealth', { surface: null });
    const walks = r.steps.filter((s) => s.kind === 'walkStep');
    radii[surface] = { via, radii: [...new Set(walks.map((s) => s.radiusM))], probe: r.mid?.surface };
    check(walks.length >= 2 && walks.every((s) => Math.abs(s.radiusM - want) < 1e-6), `walk on ${surface} = ${want} m (${walks.map((s) => s.radiusM)} via ${via})`);
  }
  results.walkRadii = radii;

  // ---- 4. a fake hidden stance makes normal steps (no locker) ----
  const fakeHidden = await run(neutral, STANCE.hidden, 3.0, 2.2);
  results.fakeHidden = { kinds: kinds(fakeHidden.steps), mid: fakeHidden.mid };
  check(fakeHidden.steps.filter((s) => s.kind === 'walkStep').length >= 2, `a claimed hidden stance walks (${kinds(fakeHidden.steps)})`);
  check(fakeHidden.mid?.stance === STANCE.stand && fakeHidden.mid?.hidden === false, `stealthStance of a fake hidden claim = stand (${fakeHidden.mid?.stance})`);

  // ---- 5. no steps while grabbed ----
  // a) a real Listener grab (monsters package, frozen so the grab holds): the victim's poses are pinned and it never steps
  const grab: Record<string, unknown> = {};
  const [gx, gz] = circleStart(neutral.x, neutral.z);
  await b.dbg('net.teleport', { x: gx, z: gz });
  await idle(b, gx, gz, 400);
  const g = await b.dbg<{ ok?: boolean }>('monsters.grab', { id: b.id, knockdown: false }).catch((e: Error) => ({ ok: false, err: e.message }));
  grab.real = g.ok === true;
  if (g.ok) {
    const gt0 = await lastT();
    const w = walk(b, neutral.x, neutral.z, { speed: 3.0, seconds: 1.6, stance: STANCE.stand });
    await sleep(700);
    grab.probe = (await probe()).grabbed;
    await w;
    const st = await stepsSince(gt0);
    grab.realSteps = st.length;
    check(grab.probe === true, 'isGrabbed reads the Listener grab');
    check(st.length === 0, `no steps in a Listener grab (${kinds(st)})`);
    await b.dbg('monsters.stop').catch(() => null); // ends the grab (and the frozen monsters)
  } else stubs.push('real grab unavailable (monsters.grab not ok)');
  // b) the isGrabbed gate itself while the poses keep moving (a Snatcher drag moves its victim): dev stand-in
  await b.dbg('players.stealth', { fakeGrab: true });
  const held = await run(neutral, STANCE.stand, 3.0, 2);
  await b.dbg('players.stealth', { fakeGrab: false });
  grab.fakeSteps = held.steps.length;
  grab.fakeProbe = held.mid?.grabbed;
  results.grabbed = grab;
  check(held.mid?.grabbed === true && held.steps.length === 0, `no steps while grabbed and moving (${kinds(held.steps)})`);

  // ---- 6. a dead-stance claim from a living player cannot cross a wall (plan check #7) ----
  const wall = await b.dbg<{ a: [number, number]; b: [number, number] } | null>('players.wallProbe');
  assert(wall, 'a wall to probe');
  await b.dbg('net.teleport', { x: wall.a[0], z: wall.a[1] });
  await idle(b, wall.a[0], wall.a[1], 2500); // past the net grace
  for (let i = 0; i < 20; i++) {
    b.pose(wall.b[0], wall.b[1], i % 2 ? STANCE.stand : STANCE.dead);
    await sleep(50);
  }
  const after = await b.serverPos();
  const pose = await b.dbg<{ pose: { stance: number } }>('players.pose');
  results.deadClaim = { wall, server: after, storedStance: pose.pose.stance };
  check(Math.abs(after[0] - wall.a[0]) < 0.6 && Math.abs(after[2] - wall.a[1]) < 0.6, `alternating dead/stand claims stayed on its side of the wall (${after})`);
  check(pose.pose.stance !== STANCE.dead, `a living player never stores the dead stance (${pose.pose.stance})`);
  // and a living player's dead claim walking normally is validated (accepted) like stand
  await idle(b, wall.a[0], wall.a[1], 1600);
  for (let i = 1; i <= 6; i++) { b.pose(wall.a[0] - 0.05 * i, wall.a[1], STANCE.dead); await sleep(50); }
  const moved = await b.serverPos();
  check(Math.abs(moved[0] - (wall.a[0] - 0.3)) < 0.06, `a dead claim walking in the open is accepted like stand (${moved[0]})`);

  // ---- 7. overshoes: walking at 4 m on a neutral floor ----
  const give = await b.dbg<{ type?: string } | null>('interaction.give', { type: 'soles' }).catch(() => null);
  const soles = await run(neutral, STANCE.stand, 3.0, 2.2);
  const sw = soles.steps.filter((s) => s.kind === 'walkStep');
  results.soles = { given: give?.type ?? null, radii: [...new Set(sw.map((s) => s.radiusM))], probe: soles.mid?.soles };
  check(soles.mid?.soles === true && sw.length >= 2 && sw.every((s) => Math.abs(s.radiusM - 4) < 1e-6), `overshoes walk at 4 m (${sw.map((s) => s.radiusM)})`);

  // ---- 8. flag stealthV12 off = v1.1 (the claimed crouch, flat radii) ----
  await b.dbg('players.stealth', { v12: false });
  const v11 = await run(neutral, STANCE.crouch, 3.5, 2.4);
  await b.dbg('players.stealth', { v12: null });
  results.flagOff = { kinds: kinds(v11.steps), radii: [...new Set(v11.steps.map((s) => s.radiusM))], stance: v11.mid?.stance };
  check(v11.steps.length >= 2 && v11.steps.every((s) => s.kind === 'crouchStep' && s.radiusM === 1.5), `flag off: v1.1 crouch steps (${kinds(v11.steps)})`);
  check(v11.mid?.stance === STANCE.crouch, 'flag off: stealthStance = the claim');

  results.stubs = stubs;
  console.log(JSON.stringify(results, null, 1));
  if (failed) throw new Error('stealth/crouch: failures above');
  console.log('PASS stealth/crouch');
} finally {
  b.close();
  await srv.stop();
}
