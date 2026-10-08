// Owner: track (c) Monsters (v1.2 G2). The hub kennel Hound as a crouch tutorial, ws bots only:
//  - a crouchStep right outside the fence is ignored
//  - a walkStep within 6 m (path) makes it turn and growl
//  - a sprintStep within 10 m makes it lunge at the fence (it never kills); a sprintStep further away is ignored
//  - the event bus reports the kennel growl as 'alert' and the lunge as 'charge' (victim = the noise source)
//   node tests/monsters/kennel.e2e.ts          (own dev server on PORT, default 3802)
import { buildEdgeGrid, initialDoorOpen, soundFlood } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { Bot, sleep, startServer, waitFor } from './bot.ts';
import { check, r1, serverErrors, summary } from './fairlib.ts';

const PORT = Number(process.env.PORT ?? 3802);
const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann');

interface Ag { id: string; x: number; z: number; state: string }
const kennel = async () => (await A.dbg<{ agents: Ag[] }>('monsters.state')).agents.find((x) => x.id === 'kennel')!;
const cues = (since: number, cue: string) => A.eventsOf('monsters.cue', since).filter((e) => (e.d as { id: string; cue: string }).id === 'kennel' && (e.d as { cue: string }).cue === cue);

/** send `n` footsteps of kind at (x, z) like a walking player (one per stride) */
async function steps(x: number, z: number, kind: string, radiusM: number, n = 4, everyMs = 260): Promise<void> {
  for (let i = 0; i < n; i++) {
    await A.dbg('monsters.noise', { x, z, radiusM, kind, source: A.id });
    await sleep(everyMs);
  }
}

async function calm(): Promise<void> {
  await waitFor(async () => { const k = await kennel(); return k.state !== 'alert' && k.state !== 'lunge' ? k : null; }, 9000, 'kennel calm').catch(() => null);
}

try {
  await A.connect(url, 'KENL');
  const t0 = performance.now();
  const hub = await A.dbg<{ ok: boolean; agents: Ag[] }>('monsters.hub');
  check('hub: kennel hound', hub.ok && hub.agents.some((x) => x.id === 'kennel'));
  // a fresh crew already sits in the hub (no phase event): re-enter it to get the layout
  if (!A.eventsOf('phase', t0).length) await A.dbg('setPhase', { phase: 'hub' });
  const H = await waitFor(() => (A.eventsOf('phase', t0).pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 4000, 'hub layout');
  const g = buildEdgeGrid(H);
  const k0 = await kennel();
  const pen = H.spaces[H.owner[Math.floor(k0.z) * H.W + Math.floor(k0.x)]]?.rect;
  const field = soundFlood(g, k0.x, k0.z, 14, initialDoorOpen(H));
  const outside = (x: number, z: number) => !pen || x < pen.x - 0.2 || x > pen.x + pen.w + 0.2 || z < pen.y - 0.2 || z > pen.y + pen.h + 0.2;
  const spot = (lo: number, hi: number): [number, number, number] | null => {
    let best: [number, number, number] | null = null;
    for (let c = 0; c < field.length; c++) {
      const d = field[c];
      if (!(d >= lo && d <= hi) || g.owner[c] < 0) continue;
      const x = (c % g.W) + 0.5, z = Math.floor(c / g.W) + 0.5;
      if (!outside(x, z)) continue;
      if (!best || Math.abs(d - (lo + hi) / 2) < Math.abs(best[2] - (lo + hi) / 2)) best = [x, z, d];
    }
    return best;
  };
  const near = spot(0.8, 2.5), walk = spot(3, 4.6), sprint = spot(8, 9.5), farS = spot(10.6, 11.6);
  check('found spots outside the pen (crouch ~1.5 m, walk ~4 m, sprint ~9 m, sprint ~11 m path)', !!near && !!walk && !!sprint && !!farS,
    [near, walk, sprint, farS].map((s) => (s ? `${r1(s[2])} m` : '-')).join(', '));
  if (near && walk && sprint && farS) {
    // crouching right past the fence: ignored
    await A.dbg('monsters.tp', { x: near[0], z: near[1], stance: 1 });
    await calm();
    const t1 = performance.now();
    await steps(near[0], near[1], 'crouchStep', 1.5, 5);
    const k1 = await kennel();
    check('crouchStep at the fence: ignored (no growl, no lunge)', k1.state !== 'alert' && k1.state !== 'lunge' && !cues(t1, 'growl').length && !cues(t1, 'lunge').length, k1.state);
    // walking within 6 m: turns + growls
    await A.dbg('monsters.tp', { x: walk[0], z: walk[1], stance: 0 });
    const t2 = performance.now();
    await steps(walk[0], walk[1], 'walkStep', 5, 3);
    const k2 = await waitFor(async () => { const k = await kennel(); return k.state === 'alert' ? k : null; }, 1500, 'kennel alert (walk)').catch(() => null);
    check(`walkStep at ${r1(walk[2])} m: it turns and growls`, !!k2 && cues(t2, 'growl').length > 0, k2?.state ?? (await kennel()).state);
    check('walkStep: no lunge', !cues(t2, 'lunge').length);
    // sprinting within 10 m: lunges at the fence, never kills
    await calm();
    await A.dbg('monsters.tp', { x: sprint[0], z: sprint[1], stance: 2 });
    const t3 = performance.now();
    await steps(sprint[0], sprint[1], 'sprintStep', 12, 3, 210);
    const k3 = await waitFor(async () => { const k = await kennel(); return k.state === 'lunge' ? k : null; }, 1500, 'kennel lunge (sprint)').catch(() => null);
    check(`sprintStep at ${r1(sprint[2])} m: it lunges at the fence`, !!k3 && cues(t3, 'lunge').length > 0, k3?.state ?? (await kennel()).state);
    // sprinting further than 10 m: ignored (measured from where it stands now; it holds still for 3 s once placed idle)
    await sleep(2400);
    await calm();
    const kNow = await kennel();
    await A.dbg('monsters.place', { id: 'kennel', x: kNow.x, z: kNow.z, state: 'idle' });
    const f2 = soundFlood(g, kNow.x, kNow.z, 14, initialDoorOpen(H));
    let far2: [number, number, number] | null = null;
    for (let c = 0; c < f2.length; c++) {
      const d = f2[c];
      if (!(d >= 10.8 && d <= 11.8) || g.owner[c] < 0) continue;
      const x = (c % g.W) + 0.5, z = Math.floor(c / g.W) + 0.5;
      if (outside(x, z)) { far2 = [x, z, d]; break; }
    }
    const fs = far2 ?? farS;
    await A.dbg('monsters.tp', { x: fs[0], z: fs[1], stance: 2 });
    const t4 = performance.now();
    await steps(fs[0], fs[1], 'sprintStep', 12, 3, 210);
    await sleep(300);
    const k4 = await kennel();
    check(`sprintStep at ${r1(fs[2])} m (beyond 10 m): ignored`, k4.state !== 'lunge' && !cues(t4, 'lunge').length, k4.state);
    const kills = A.eventsOf('monsters.kill', t0);
    const inPen = (k: Ag) => !pen || (k.x >= pen.x && k.x <= pen.x + pen.w && k.z >= pen.y && k.z <= pen.y + pen.h);
    check('it never kills and never leaves its pen', !kills.length && inPen(await kennel()));
    const ev = (await A.dbg<{ events: { monster: string; event: string; victim?: string; id: string }[] }>('monsters.events')).events.filter((e) => e.id === 'kennel');
    check("event bus: kennel growl = 'alert', lunge = 'charge' (victim = the noise source)", ev.some((e) => e.event === 'alert' && e.victim === A.id) && ev.some((e) => e.event === 'charge' && e.victim === A.id),
      [...new Set(ev.map((e) => e.event))].join(', '));
  }
  const errs = serverErrors(srv.log());
  check('no server errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  A.close();
  await srv.stop();
}
process.exitCode = summary('Kennel crouch tutorial');
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
