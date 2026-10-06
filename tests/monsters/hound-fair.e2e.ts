// Owner: track (c) Monsters. v1.1 Hound fairness (tonight's 'HOUND killed X: heard your FOOTSTEPS (1 m)'):
//  - crouch-walking right past an idle hound (1 m, creep speed, crouch steps) never alerts it
//  - no wind-up on a player its growl has not reached: a "second" noise from an unwarned player re-alerts it with a growl
//    that reaches that player; only their next distinct noise (>= 1 s later) starts the wind-up
//   node tests/monsters/hound-fair.e2e.ts       (starts its own dev server on PORT or 3013)
import { buildEdgeGrid, fieldAt, initialDoorOpen, soundFlood } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { Bot, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3013);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = '') => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};
interface AgentDump { id: string; kind: string; x: number; z: number; state: string }
interface StateDump { agents: AgentDump[]; poses: { id: string; alive: boolean }[] }

const srv = await startServer(PORT);
const url = `ws://127.0.0.1:${PORT}/ws`;
const a = new Bot('Ann');
const b = new Bot('Bob');
try {
  await a.connect(url, 'HFAIR');
  await b.connect(url, 'HFAIR');
  await a.dbg('monsters.start', { seed: 'g2b-hound', players: 2, risk: 1 });
  const L = await waitFor(() => (a.eventsOf('phase').pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 3000, 'layout');
  const g = buildEdgeGrid(L);
  const open = initialDoorOpen(L);
  for (const id of ['listener0', 'mannequin0', 'snatcher0']) await a.dbg('monsters.place', { id, outSec: 9999 }).catch(() => null);
  const dump = () => a.dbg<StateDump>('monsters.state');
  const hound = async () => (await dump()).agents.find((x) => x.id === 'hound0')!;
  await b.dbg('monsters.tp', { id: b.id, x: L.van.cab.x + 1, z: L.van.cab.y + 1.5 });
  const h0 = await hound();
  await a.dbg('monsters.place', { id: 'hound0', x: h0.x, z: h0.z, state: 'idle' });

  // ---------------- 1. crouch-walk past an idle hound at ~1 m ----------------
  const t1 = performance.now();
  const walk = (k: number) => [h0.x - 2 + k * 4, h0.z + 1.0] as const;
  for (let i = 0; i <= 54; i++) {
    const [x, z] = walk(i / 54);
    await a.dbg('monsters.tp', { id: a.id, x, z, stance: 1 });
    if (i % 8 === 0) await a.dbg('monsters.noise', { x, z, radiusM: 1.5, kind: 'crouchStep', source: a.id });
    await sleep(50);
  }
  const hs = await hound();
  const growled = a.eventsOf('monsters.cue', t1).some((e) => (e.d as { cue: string; id: string }).id === 'hound0');
  check('crouch-walking past an idle hound at 1 m: stays idle, no growl, alive', hs.state === 'idle' && !growled && (await dump()).poses.find((p) => p.id === a.id)?.alive === true, `${hs.state}, cues ${growled}`);

  // ---------------- 2. unwarned player's "second" noise -> re-alert growl that reaches them ----------------
  // a hound spot with B ~6 m away and A just outside the 10 m growl but inside the 12 m charge range (sound path)
  let spotB: [number, number] | null = null, spotA: [number, number] | null = null, hx = h0.x, hz = h0.z;
  const vanSp = new Set(L.spaces.filter((q) => q.type === 'van' || q.kind === 'outside').map((q) => q.id));
  for (let hc = 0; hc < g.W * g.H && (!spotA || !spotB); hc += 3) {
    if (g.owner[hc] < 0 || vanSp.has(g.owner[hc])) continue;
    hx = (hc % g.W) + 0.5; hz = Math.floor(hc / g.W) + 0.5;
    const f = soundFlood(g, hx, hz, 30, open);
    spotA = spotB = null;
    for (let c = 0; c < g.W * g.H && (!spotA || !spotB); c++) {
      if (g.owner[c] < 0 || vanSp.has(g.owner[c])) continue;
      const x = (c % g.W) + 0.5, z = Math.floor(c / g.W) + 0.5;
      const pd = fieldAt(g, f, x, z), sd = Math.hypot(x - hx, z - hz);
      if (!spotB && sd >= 5 && sd <= 7 && pd <= 8) spotB = [x, z];
      if (!spotA && sd >= 10.6 && sd <= 11.6 && pd <= 11.8) spotA = [x, z];
    }
  }
  h0.x = hx;
  h0.z = hz;
  check('found spots: B ~6 m, A ~11 m from the hound (inside charge range, outside the 10 m growl)', !!spotA && !!spotB, `A ${spotA} B ${spotB}`);
  if (spotA && spotB) {
    await a.dbg('monsters.place', { id: 'hound0', x: h0.x, z: h0.z, state: 'idle' });
    await a.dbg('monsters.tp', { id: a.id, x: spotA[0], z: spotA[1], stance: 0 });
    await b.dbg('monsters.tp', { id: b.id, x: spotB[0], z: spotB[1] });
    await sleep(300);
    const t2 = performance.now();
    await b.dbg('monsters.noise', { x: spotB[0], z: spotB[1], radiusM: 12, kind: 'voice', source: b.id });
    await waitFor(async () => (await hound()).state === 'alert', 2000, 'alert on B');
    const g1 = a.eventsOf('monsters.cue', t2).find((e) => (e.d as { cue: string }).cue === 'growl');
    const r1 = (g1?.d as { radius: number } | undefined)?.radius ?? 0;
    check("B's noise: alert growl reaches B, not A", !!g1 && r1 >= 6 && r1 < Math.hypot(spotA[0] - h0.x, spotA[1] - h0.z), `radius ${r1}`);
    await sleep(1200);
    const t3 = performance.now();
    await a.dbg('monsters.noise', { x: spotA[0], z: spotA[1], radiusM: 14, kind: 'walkStep', source: a.id });
    await sleep(150);
    const st3 = (await hound()).state;
    const g2 = a.eventsOf('monsters.cue', t3).find((e) => (e.d as { cue: string }).cue === 'growl');
    const r2 = (g2?.d as { radius: number; p: number[] } | undefined);
    const hNow = await hound();
    const dA = Math.hypot(spotA[0] - hNow.x, spotA[1] - hNow.z);
    check("unwarned A's noise: re-alert (no wind-up) with a growl that reaches A", st3 === 'alert' && !!r2 && r2.radius >= dA, `state ${st3}, growl ${r2?.radius ?? 'none'} vs ${dA.toFixed(1)} m`);
    await sleep(1300);
    await a.dbg('monsters.noise', { x: spotA[0], z: spotA[1], radiusM: 14, kind: 'walkStep', source: a.id });
    const wu = await waitFor(async () => { const s = (await hound()).state; return s === 'windup' || s === 'charge' ? s : null; }, 1500, 'windup after warning').catch(() => null);
    check("A's next distinct noise (warned >= 1 s ago): wind-up (fair)", !!wu, `${wu}`);
  }
  const errs = srv.log().split('\n').filter((l) => /error|threw|TypeError|ReferenceError/i.test(l) && /monsters|hound/i.test(l));
  check('no server errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  a.close();
  b.close();
  await srv.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\nHound fairness: ${failed.length ? 'FAILED' : 'PASSED'} ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();

