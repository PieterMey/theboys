// Owner: env-paranormal (v1.2). The haunt scheduler on simulated crews (tests/paranormal/sim.ts):
// cadence ±35% per H band over 40-min 6p contracts, guarantees, blocks, budgets, novelty, exclusions, same seed -> same
// plan, dark-walk kills/revives, witness validation, perf.  Run: node --test tests/paranormal/plan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorsOf } from '../../packages/shared/src/procgen/mirrors.ts';
import { DEFAULTS } from '../../apps/server/src/paranormal/balance.ts';
import { drawGapSec, hauntLevel, meanGapSec, tierCap } from '../../apps/server/src/paranormal/haunt.ts';
import { firePara, seenPara, syncPara } from '../../apps/server/src/paranormal/plan.ts';
import { groupOf } from '../../apps/server/src/paranormal/kinds.ts';
import { dist2, doorCenter, fixturesOf, indoor, itemById, spaceAtXZ, switchSpaces } from '../../apps/server/src/paranormal/gates.ts';
import { Sim } from './sim.ts';
import type { Emitted, SimMonster } from './sim.ts';

const B = DEFAULTS;
const BUDGET_GROUPS = Object.keys(B.budgets);

test('haunt level, tiers and gaps follow the formula', () => {
  assert.equal(hauntLevel(B, { clockMin: 0, tensionEma: 0, blackout: false, coreLifted: false, themeHaunt: 0 }), 0.15);
  const h = hauntLevel(B, { clockMin: 180, tensionEma: 0.4, blackout: true, coreLifted: true, themeHaunt: 0.05 });
  assert.ok(Math.abs(h - (0.15 + 0.225 + 0.1 + 0.15 + 0.1 + 0.05)) < 1e-9, `H ${h}`);
  assert.equal(hauntLevel(B, { clockMin: 360, tensionEma: 1, blackout: true, coreLifted: true, themeHaunt: 0.15 }), 1);
  assert.equal(tierCap(B, 0.24, 'build'), 0);
  assert.equal(tierCap(B, 0.25, 'build'), 1);
  assert.equal(tierCap(B, 0.4, 'build'), 2);
  assert.equal(tierCap(B, 0.9, 'relax'), 1, 'T2 only in build');
  assert.equal(meanGapSec(B, 0), 75);
  assert.equal(meanGapSec(B, 1), 28);
  for (const H of [0, 0.3, 0.7, 1]) {
    const m = meanGapSec(B, H);
    assert.ok(Math.abs(drawGapSec(B, H, 'build', 0) - m * 0.65) < 1e-9);
    assert.ok(Math.abs(drawGapSec(B, H, 'build', 1) - m * 1.35) < 1e-9);
    assert.ok(Math.abs(drawGapSec(B, H, 'relax', 0.5) - m * 1.6) < 1e-9, 'x1.6 in relax');
  }
});

/** 40-min (2400 s) 6-player contracts, a few seeds */
const LONG: Sim[] = [];
function longSims(): Sim[] {
  if (LONG.length) return LONG;
  for (const seed of ['cad-a', 'cad-b', 'cad-c', 'cad-d']) {
    LONG.push(new Sim({ seed, players: 6, realSec: 2400, movables: true, lore: true, chaseEvery: 180, wakeSec: 300 }).run(2400));
  }
  return LONG;
}

test('cadence: drawn gaps are lerp(75, 28, H) ±35% (x1.6 in relax) in every H band', () => {
  const bands: Record<string, number[]> = { '0.15-0.3': [], '0.3-0.45': [], '0.45-0.6': [], '0.6-1': [] };
  const bandOf = (H: number) => (H < 0.3 ? '0.15-0.3' : H < 0.45 ? '0.3-0.45' : H < 0.6 ? '0.45-0.6' : '0.6-1');
  let n = 0;
  for (const s of longSims()) {
    for (const tr of s.st.trace) {
      if (tr.outcome === 'fail' || tr.gapSec === 0) continue;
      const ratio = tr.gapSec / (tr.phase === 'relax' ? B.relaxMult : 1) / meanGapSec(B, tr.H);
      assert.ok(ratio >= 0.65 - 1e-9 && ratio <= 1.35 + 1e-9, `gap ratio ${ratio} at H ${tr.H}`);
      bands[bandOf(tr.H)].push(ratio);
      n++;
    }
  }
  assert.ok(n >= 60, `enough slots (${n})`);
  for (const [band, r] of Object.entries(bands)) {
    if (r.length < 8) continue;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    // uniform jitter: the band mean of gap/mean(H) stays close to 1 (well inside ±35%)
    assert.ok(mean > 0.82 && mean < 1.18, `band ${band}: mean ratio ${mean.toFixed(3)} over ${r.length}`);
  }
});

test('cadence: realized intervals between slots track the drawn gap (blocks only delay a slot by seconds)', () => {
  for (const s of longSims()) {
    const tr = s.st.trace;
    for (let i = 1; i < tr.length; i++) {
      const prev = tr[i - 1];
      if (prev.gapSec === 0) continue;
      const dt = (tr[i].at - prev.at) / 1000;
      if (tr[i].gapSec === 0) continue; // a guarantee event in between
      // never early; late only by block waits (<= peak+fade 10 s, director 8 s, chase 10 s, spacing 10 s) + the 0.25 s check
      assert.ok(dt >= prev.gapSec - 0.3, `slot early: ${dt} < ${prev.gapSec}`);
      assert.ok(dt <= prev.gapSec + 45, `slot late: ${dt} vs ${prev.gapSec}`);
    }
  }
});

function checkInvariants(s: Sim, label: string): void {
  const evs = s.events();
  const lastByTarget = new Map<string, number>();
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const why = `${label} #${i} ${e.ev.kind} @${e.t.toFixed(1)}s`;
    assert.ok(e.ev.at - (s.t0 + e.t * 1000) >= 250, `${why}: at >= now + 250`);
    assert.notEqual(e.phase, 'peak', `${why}: not in peak`);
    assert.notEqual(e.phase, 'fade', `${why}: not in fade`);
    assert.ok(!e.chase, `${why}: not during a chase`);
    assert.ok(e.sinceWake >= 15, `${why}: >= 15 s after wake (${e.sinceWake})`);
    assert.ok(e.sinceDirector >= 8, `${why}: >= 8 s after a director event (${e.sinceDirector})`);
    assert.ok(e.t >= 40 - 1e-6, `${why}: not during the first 40 s`);
    if (i > 0) assert.ok(e.t - evs[i - 1].t >= 10 - 1e-6, `${why}: >= 10 s crew-wide spacing`);
    if (e.ev.tier === 2) assert.equal(e.phase, 'build', `${why}: T2 in build only`);
    const rec = s.records.find((r) => r.id === e.ev.id);
    const target = rec?.target ?? null;
    if (target) {
      const prev = lastByTarget.get(target);
      if (prev !== undefined) assert.ok(e.t - prev >= 45 - 1e-6, `${why}: >= 45 s per player (${(e.t - prev).toFixed(1)})`);
      lastByTarget.set(target, e.t);
      const tp = e.players.find((p) => p.id === target)!;
      assert.ok(!tp.inVan && !tp.hidden && !tp.grabbed && tp.alive, `${why}: eligible target`);
      if (tp.core) assert.ok(e.ev.tier <= 1, `${why}: Core carriers get T0/T1 only`);
    }
    // novelty: not either of the last 2 groups
    const g = groupOf(e.ev.kind);
    const recent = evs.slice(Math.max(0, i - 2), i).map((x) => groupOf(x.ev.kind));
    assert.ok(!recent.includes(g), `${why}: novelty (${recent.join(',')})`);
    // gates on the event position
    const mons = e.monsters.filter((m) => m.active && !['out', 'dormant', 'vent', 'duct'].includes(m.state));
    const pts: [number, number][] = [];
    if (e.ev.kind === 'dark_walk') {
      const ids = new Set((e.ev.data?.lights as string[]) ?? []);
      for (const f of fixturesOf(s.L)) if (ids.has(f.id)) pts.push([f.x, f.z]);
      assert.ok(!e.blackout, `${why}: no dark walk in a blackout`);
      assert.ok(ids.size >= 4, `${why}: >= 4 lit fixtures`);
      for (const [x, z] of pts) for (const m of mons) if (m.kind === 'mannequin') assert.ok(dist2(x, z, m.x, m.z) >= 25, `${why}: 25 m from a Mannequin`);
    } else if (e.ev.kind === 'footprints') {
      for (const q of (e.ev.data?.pts as number[][]) ?? []) pts.push([q[0], q[1]]);
    } else if (e.ev.p) pts.push([e.ev.p[0], e.ev.p[2]]);
    for (const [x, z] of pts.slice(0, 40)) {
      const sp = spaceAtXZ(s.L, x, z);
      assert.ok(sp >= 0 && indoor(s.L, sp), `${why}: inside the building`);
      if (e.ev.kind !== 'dark_walk') for (const m of mons) assert.ok(dist2(x, z, m.x, m.z) >= 6 - 1e-6, `${why}: >= 6 m from ${m.kind}`);
    }
    if (e.ev.kind === 'knock' || e.ev.kind === 'handle_rattle') {
      const hiddenSpaces = new Set(e.players.filter((p) => p.hidden).map((p) => itemById(s.L, p.hidden!)?.space ?? -1));
      const door = Number(e.ev.data?.door ?? -1);
      if (door >= 0) {
        const d = s.L.doors[door];
        assert.ok(!hiddenSpaces.has(d.a) && !hiddenSpaces.has(d.b), `${why}: not a door a hidden player is behind`);
      }
    }
  }
  // budgets per contract
  const used: Record<string, number> = {};
  for (const e of evs) used[groupOf(e.ev.kind)] = (used[groupOf(e.ev.kind)] ?? 0) + 1;
  for (const g of BUDGET_GROUPS) assert.ok((used[g] ?? 0) <= (B.budgets[g] ?? 0), `${label}: budget ${g} ${used[g]} <= ${B.budgets[g]}`);
  // dark walks: <= 3 per contract, >= 120 s apart
  const dws = evs.filter((e) => e.ev.kind === 'dark_walk');
  assert.ok(dws.length <= 3);
  for (let i = 1; i < dws.length; i++) assert.ok(dws[i].t - dws[i - 1].t >= 120 - 1e-6, `${label}: dark walks >= 120 s apart`);
}

test('blocks, spacing, budgets, novelty and gates hold over long simulated contracts', () => {
  const sims = longSims();
  for (let i = 0; i < sims.length; i++) checkInvariants(sims[i], `long${i}`);
  // and with a hidden player, a Core carrier, a mid-contract blackout, small crews
  const more = [
    new Sim({ seed: 'inv-hidden', players: 4, realSec: 900, hiddenPlayer: 1, movables: true, chaseEvery: 120 }).run(900),
    new Sim({ seed: 'inv-core', players: 3, realSec: 900, coreCarrier: 0, coreFrom: 100, movables: true }).run(900),
    new Sim({ seed: 'inv-black', players: 5, realSec: 900, blackoutFrom: 450, lore: true }).run(900),
    new Sim({ seed: 'inv-solo', players: 1, realSec: 900, movables: true }).run(900),
  ];
  for (const s of more) checkInvariants(s, s.o.seed);
  const hidden = more[0];
  assert.ok(hidden.records.every((r) => r.target !== 'p1'), 'a hiding player is never a target');
  const black = more[2];
  assert.ok(black.events().every((e) => e.t < 450 || e.ev.kind !== 'dark_walk'), 'no dark walks after the blackout');
});

test('budgets bind: a tight budget table is never exceeded', () => {
  const tight = Object.fromEntries(BUDGET_GROUPS.map((g) => [g, 1]));
  const s = new Sim({ seed: 'budget-1', players: 6, realSec: 2400, movables: true, lore: true, balance: { budgets: tight, gapSlowSec: 30, gapFastSec: 20 } }).run(2400);
  const used: Record<string, number> = {};
  for (const e of s.events()) used[groupOf(e.ev.kind)] = (used[groupOf(e.ev.kind)] ?? 0) + 1;
  for (const g of BUDGET_GROUPS) assert.ok((used[g] ?? 0) <= 1, `${g}: ${used[g]}`);
  assert.ok(Object.values(used).reduce((a, b) => a + b, 0) >= 5, `several kinds still ran (${JSON.stringify(used)})`);
});

test('guarantees: a T1 by clockMin 120 and a T2 by clockMin 240, even when H would never allow them', () => {
  // tiers unreachable by H: only the guarantees can produce T1/T2
  for (const seed of ['g-1', 'g-2', 'g-3']) {
    // no mirrors (the first-mirror guarantee is its own guarantee)
    const s = new Sim({ seed, players: 4, realSec: 900, balance: { tierAt: [0, 0.99, 0.995] }, movables: true, noMirrors: true }).run(900);
    const t1 = s.events().find((e) => e.ev.tier >= 1);
    const t2 = s.events().find((e) => e.ev.tier >= 2);
    assert.ok(t1, `${seed}: a T1 happened`);
    assert.ok(t1.clockMin >= 119.9 && t1.clockMin <= 120 + 12, `${seed}: T1 at clockMin ${t1.clockMin.toFixed(1)}`);
    assert.ok(t2, `${seed}: a T2 happened`);
    assert.ok(t2.clockMin >= 239.9 && t2.clockMin <= 240 + 20, `${seed}: T2 at clockMin ${t2.clockMin.toFixed(1)}`);
  }
  // natural runs: by 120 / 240 at the latest
  for (const s of longSims()) {
    const t1 = s.events().find((e) => e.ev.tier >= 1);
    const t2 = s.events().find((e) => e.ev.tier >= 2);
    assert.ok(t1 && t1.clockMin <= 120 + 6, `T1 by 120 (${t1?.clockMin})`);
    assert.ok(t2 && t2.clockMin <= 240 + 10, `T2 by 240 (${t2?.clockMin})`);
  }
});

test('guarantee: a mirror event when a player first stands within 5 m of a mirror', () => {
  // no regular slots (huge gaps): only the guarantee can fire
  const s = new Sim({ seed: 'mirror-g', players: 2, realSec: 900, monsters: null, directorEvery: 0, director: () => 'build', balance: { noopChance: 1, firstDelaySec: 40 } });
  const ms = mirrorsOf(s.L).filter((m) => m.kind !== 'van' && indoor(s.L, m.space));
  assert.ok(ms.length > 0, 'the facility has mirrors');
  // keep both players far from every mirror for the warm-up
  const far = (x: number, z: number) => ms.every((m) => dist2(m.x, m.z, x, z) > 12);
  let spot: [number, number] | null = null;
  for (let c = 0; c < s.L.owner.length && !spot; c++) {
    const sp = s.L.owner[c];
    const x = (c % s.L.W) + 0.5, z = Math.floor(c / s.L.W) + 0.5;
    if (sp >= 0 && indoor(s.L, sp) && far(x, z)) spot = [x, z];
  }
  s.place(0, spot![0], spot![1]);
  s.place(1, spot![0], spot![1]);
  s.run(60);
  const before = s.events().length;
  // walk player 0 to 2 m in front of the mirror, facing away from it
  const m = ms[0];
  const nx = Math.sin(m.rot), nz = Math.cos(m.rot);
  s.place(0, m.x + nx * 2, m.z + nz * 2, m.rot);
  const tArrive = s.tSec();
  s.run(3);
  const got = s.events().slice(before).find((e) => (e.ev.kind === 'mirror_figure' || e.ev.kind === 'mirror_writing'));
  assert.ok(got, 'a mirror event followed');
  assert.ok(got.t - tArrive <= 1.5, `within the next check (${(got.t - tArrive).toFixed(2)} s)`);
  if (got.ev.kind === 'mirror_figure') assert.deepEqual(got.ev.to, ['p0'], 'the figure is armed for that player only');
  // only once per player
  s.place(0, spot![0], spot![1]);
  s.run(70);
  s.place(0, m.x + nx * 2, m.z + nz * 2, m.rot);
  s.run(3);
  const again = s.events().filter((e) => (e.ev.kind === 'mirror_figure' || e.ev.kind === 'mirror_writing') && e.t > got.t && e.t - s.tSec() > -3.5);
  assert.equal(again.length, 0, 'the guarantee fires once per player');
});

test('same seed -> same plan; another seed -> another plan', () => {
  const run = (seed: string) => new Sim({ seed, players: 6, realSec: 900, movables: true, lore: true, chaseEvery: 150 }).run(900)
    .events().map((e) => ({ kind: e.ev.kind, tier: e.ev.tier, at: e.ev.at, seed: e.ev.seed, space: e.ev.space, p: e.ev.p, data: e.ev.data, to: e.ev.to }));
  const a = run('det-1'), b = run('det-1'), c = run('det-2');
  assert.ok(a.length > 4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('dark walk: every fixture of each space it enters, kills in step order, corridors revive, rooms need the switch', () => {
  const s = new Sim({ seed: 'dw-1', players: 2, realSec: 900, monsters: null, directorEvery: 0, director: () => 'build', powerFrom: 0 });
  s.run(41);
  let ev = null;
  for (let i = 0; i < 40 && !ev; i++) {
    ev = firePara(s.st, s.w, s.b, s.out, 'dark_walk', { force: true });
    if (!ev) s.run(2);
  }
  assert.ok(ev, 'a dark walk fits');
  const d = ev.data!;
  const lights = d.lights as string[];
  const spaces = d.spaces as number[];
  const killAt = d.killAt as number[];
  const stepMs = Number(d.stepMs);
  assert.ok(stepMs >= 380 && stepMs <= 600, `stepMs ${stepMs}`);
  assert.ok(lights.length >= 4);
  assert.ok(ev.at >= s.now + 250, 'at >= now + 250');
  // every glowing fixture of every entered space, each space killed after its own last fixture
  const fx = fixturesOf(s.L);
  for (let i = 0; i < spaces.length; i++) {
    const own = fx.filter((f) => f.space === spaces[i] && (f.state === 'on' || f.state === 'flicker'));
    for (const f of own) assert.ok(lights.includes(f.id), `space ${spaces[i]}: ${f.id} included`);
    const last = Math.max(...own.map((f) => lights.indexOf(f.id)));
    assert.equal(killAt[i], last * stepMs + Number(d.dieMs));
    if (i > 0) assert.ok(killAt[i] >= killAt[i - 1], 'kill order follows the walk');
  }
  const end = ev.at + Math.max(...killAt) + 200;
  while (s.now < end) s.step(50);
  for (const sp of spaces) assert.equal(s.lightsOn(sp), false, `space ${sp} dark after its last fixture`);
  const sw = switchSpaces(s.L);
  // corridors (no switch) revive after 45-90 s with a 'revive' event; switch rooms stay dark
  s.run(95);
  for (const sp of spaces) {
    if (sw.has(sp)) assert.equal(s.lightsOn(sp), false, `room ${sp} waits for its switch`);
    else {
      assert.equal(s.lightsOn(sp), true, `corridor ${sp} revived`);
      assert.ok(s.emitted.some((e) => e.ev.kind === 'revive' && e.ev.space === sp), `revive event for ${sp}`);
    }
  }
  const rooms = spaces.filter((sp) => sw.has(sp));
  for (const sp of rooms) s.switches.set(sp, true); // a player flips it back on
  s.run(1);
  for (const sp of rooms) assert.ok(s.emitted.some((e) => e.ev.kind === 'revive' && e.ev.space === sp), `room ${sp} revives on its switch`);
  // residue is gone once every space is back
  const sync = syncPara(s.st, 'p0');
  assert.ok(!sync.residue.some((r) => r.id === ev!.id), 'no dark-walk residue after every revive');
});

test('seen: validated, rate-limited to 10/s, first witness reveals a writing, end ends a presence for everyone', () => {
  const s = new Sim({ seed: 'seen-1', players: 3, realSec: 900, monsters: null, directorEvery: 0, director: () => 'build' });
  s.run(41);
  // writing near a player
  let w = null;
  for (let i = 0; i < 60 && !w; i++) {
    const ms = mirrorsOf(s.L).filter((m) => m.kind !== 'van');
    const m = ms[i % ms.length];
    s.place(0, m.x + Math.sin(m.rot) * 3, m.z + Math.cos(m.rot) * 3, m.rot); // 3 m in front, facing away
    w = firePara(s.st, s.w, s.b, s.out, 'mirror_writing', { force: true, target: 'p0' });
  }
  assert.ok(w, 'a writing fits');
  assert.ok(['IT HEARS', 'NOT ALONE', 'COUNT AGAIN', 'ANN', 'BOB', 'CAS'].includes(String(w.data!.text)), `text ${w.data!.text}`);
  while (s.now < w.at) s.step(50);
  // too far (> 25 m): rejected
  const wp = w.p!;
  let farCell = -1;
  for (let c = 0; c < s.L.owner.length; c++) {
    if (s.L.owner[c] < 0 || !indoor(s.L, s.L.owner[c])) continue;
    if (dist2((c % s.L.W) + 0.5, Math.floor(c / s.L.W) + 0.5, wp[0], wp[2]) > 30) { farCell = c; break; }
  }
  assert.ok(farCell >= 0);
  s.place(2, (farCell % s.L.W) + 0.5, Math.floor(farCell / s.L.W) + 0.5);
  assert.equal(seenPara(s.st, s.w, s.b, s.out, 'p2', w.id, false), false, 'a witness 25+ m away is rejected');
  assert.equal(s.reveals.length, 0);
  // near: accepted, reveals once
  assert.equal(seenPara(s.st, s.w, s.b, s.out, 'p0', w.id, false), true);
  assert.equal(s.reveals.length, 1);
  assert.ok(s.reveals[0].at >= s.now + 250, 'reveal from server time >= now + 250');
  seenPara(s.st, s.w, s.b, s.out, 'p0', w.id, false);
  assert.equal(s.reveals.length, 1, 'reveal only on the first witness');
  // rate limit: a burst of 30 requests in one tick gets at most 10 through
  s.run(1.1);
  let pass = 0;
  for (let i = 0; i < 30; i++) if (seenPara(s.st, s.w, s.b, s.out, 'p0', w.id, false)) pass++;
  assert.ok(pass >= 9 && pass <= 10, `burst passes ${pass}`);
  s.run(1.1);
  let unknown = 0;
  for (let i = 0; i < 5; i++) if (seenPara(s.st, s.w, s.b, s.out, 'p0', -1, false)) unknown++;
  assert.equal(unknown, 0, 'unknown ids rejected');
  // presence: end=true ends it (paranormal.end) once
  s.run(1.2);
  let p = null;
  for (let i = 0; i < 80 && !p; i++) {
    const c = s.L.owner.findIndex((o, k) => o >= 0 && indoor(s.L, o) && !s.lightsOn(o) && k % 7 === i % 7);
    if (c >= 0) s.place(1, (c % s.L.W) + 0.5, Math.floor(c / s.L.W) + 0.5, (i * 0.7) % 6.28);
    p = firePara(s.st, s.w, s.b, s.out, 'presence', { force: true, target: 'p1' });
    if (!p) s.run(0.2);
  }
  assert.ok(p, 'a presence fits somewhere dark');
  while (s.now < p.at) s.step(50);
  s.st.buckets.delete('p1'); // fresh bucket
  const endsBefore = s.ends.filter((e) => e.id === p!.id).length;
  assert.equal(seenPara(s.st, s.w, s.b, s.out, 'p1', p.id, true), true);
  assert.equal(s.ends.filter((e) => e.id === p!.id).length, endsBefore + 1, 'one paranormal.end');
  assert.equal(seenPara(s.st, s.w, s.b, s.out, 'p1', p.id, true), false, 'already over');
  const rec = s.records.find((r) => r.id === p!.id)!;
  assert.ok(rec.witnesses.includes('p1'), 'witness recorded');
});

test('mirror text whitelist: the Listener callsign (fresh, valid), else a roster name, else a phrase; never transcripts', () => {
  const s = new Sim({ seed: 'text-1', players: 3, realSec: 900, monsters: null, directorEvery: 0, director: () => 'build' });
  s.run(41);
  const callsigns = new Set(s.L.spaces.map((x) => x.callsign).filter(Boolean) as string[]);
  const names = new Set(['ANN', 'BOB', 'CAS']);
  const phrases = new Set(['IT HEARS', 'NOT ALONE', 'COUNT AGAIN']);
  const transcript = 'meet me in the boiler the code is 4719';
  const room = s.L.spaces.find((x) => x.callsign && indoor(s.L, x.id))!;
  const texts: string[] = [];
  const ms = mirrorsOf(s.L).filter((m) => m.kind !== 'van');
  for (let i = 0; i < 24; i++) {
    s.st.residue.clear();
    s.st.active.clear();
    s.st.room = i % 2 ? { callsign: room.callsign!, space: room.id, at: s.now - 30_000 } : null;
    if (i % 4 === 3) s.st.room = { callsign: room.callsign!, space: room.id, at: s.now - 120_000 }; // stale (> 90 s)
    const m = ms[i % ms.length];
    s.place(0, m.x + Math.sin(m.rot) * 3, m.z + Math.cos(m.rot) * 3, m.rot);
    const ev = firePara(s.st, s.w, s.b, s.out, 'mirror_writing', { force: true, target: 'p0' });
    if (!ev) continue;
    const text = String(ev.data!.text);
    texts.push(text);
    assert.ok(callsigns.has(text) || names.has(text) || phrases.has(text), `whitelist: ${text}`);
    assert.ok(!transcript.toUpperCase().includes(text) || callsigns.has(text), 'never transcript words');
    if (i % 4 === 1) assert.equal(text, room.callsign, 'fresh valid room decision -> its callsign');
    else assert.notEqual(text, room.callsign, 'no (or a stale > 90 s) decision -> never the callsign');
  }
  assert.ok(texts.length >= 8, `writings fired (${texts.length})`);
  // the van mirror is never written on
  for (const e of s.events()) if (e.ev.kind === 'mirror_writing') assert.notEqual(mirrorsOf(s.L).find((m) => m.id === e.ev.ref)?.kind, 'van');
});

test('exclusions: no events within 6 m of a monster parked next to the crew; the Mannequin blocks light kills', () => {
  // every monster sits 3 m from player 0; a Mannequin roams near player 1
  const s = new Sim({
    seed: 'excl-1', players: 4, realSec: 900, movables: true, directorEvery: 0, director: () => 'build',
    monsters: (_t, sim): SimMonster[] => {
      const a = sim.walkers[0], b = sim.walkers[1];
      return [
        { id: 'hound0', kind: 'hound', x: a.x + 3, z: a.z, active: true, state: 'idle' },
        { id: 'mannequin0', kind: 'mannequin', x: b.x, z: b.z + 2, active: true, state: 'frozen' },
      ];
    },
  }).run(900);
  checkInvariants(s, 'excl');
  for (const e of s.events()) {
    if (e.ev.kind === 'dark_walk' || e.ev.kind === 'brownout_breath') {
      const mq = e.monsters.find((m) => m.kind === 'mannequin')!;
      const ids = new Set((e.ev.data?.lights as string[]) ?? []);
      for (const f of fixturesOf(s.L)) if (ids.has(f.id)) assert.ok(dist2(f.x, f.z, mq.x, mq.z) >= 25);
      if (e.ev.p) assert.ok(dist2(e.ev.p[0], e.ev.p[2], mq.x, mq.z) >= 25 || e.ev.kind === 'dark_walk');
    }
  }
});

test('knocks come from the far side, 0.3 m beyond the leaf of a closed door', () => {
  const s = new Sim({ seed: 'knock-1', players: 2, realSec: 900, monsters: null, directorEvery: 0, director: () => 'build' });
  s.run(41);
  let n = 0;
  for (let i = 0; i < 60; i++) {
    s.st.perPlayer.clear();
    const ev = firePara(s.st, s.w, s.b, s.out, i % 2 ? 'handle_rattle' : 'knock', { force: true });
    s.run(0.5);
    if (!ev || Number(ev.data?.door ?? -1) < 0) continue;
    const d = s.L.doors[Number(ev.data!.door)];
    const [cx, cz] = doorCenter(d);
    const off = d.dir === 'v' ? Math.abs(ev.p![0] - cx) : Math.abs(ev.p![2] - cz);
    assert.ok(Math.abs(off - 0.3) < 0.02, `0.3 m beyond the leaf (${off})`);
    assert.equal(s.doorOpen(d.id), false, 'the logical door state never changes');
    const tgt = s.records.find((r) => r.id === ev.id)?.target ?? s.st.active.get(ev.id)?.rec.target;
    // where the target stood when the knock was planned
    const tp = s.emitted.find((e) => e.ev.id === ev.id)?.players.find((p) => p.id === tgt);
    if (tp) {
      const side = (q: [number, number]) => (d.dir === 'v' ? Math.sign(q[0] - cx) : Math.sign(q[1] - cz));
      assert.notEqual(side([ev.p![0], ev.p![2]]), side([tp.x, tp.z]), 'far side from the target');
    }
    n++;
  }
  assert.ok(n >= 10, `knocks fired (${n})`);
});

test('perf: <= 0.2 ms per crew tick on average, planning <= 2 ms per slot', () => {
  for (const s of longSims()) {
    const avgTick = s.st.stats.tickMs / s.st.stats.ticks;
    const avgPlan = s.st.stats.planMs / Math.max(1, s.st.stats.planned);
    assert.ok(avgTick <= 0.2, `avg tick ${avgTick.toFixed(4)} ms`);
    assert.ok(avgPlan <= 2, `avg plan ${avgPlan.toFixed(3)} ms`);
  }
});

export type { Emitted };

test('presence: ends when a beam holds it for 0.4 s (lit) or when approached; T2 carries beam interference', () => {
  const s = new Sim({ seed: 'pres-1', players: 2, realSec: 900, monsters: null, directorEvery: 0, director: () => 'build', balance: { gapSlowSec: 9000, gapFastSec: 9000 } });
  s.run(41);
  // a dark spot: the sim gives players in dark spaces their flashlight
  let p = null;
  for (let i = 0; i < 200 && !p; i++) {
    const c = (i * 97) % s.L.owner.length;
    const o = s.L.owner[c];
    if (o < 0 || !indoor(s.L, o) || s.lightsOn(o)) continue;
    s.place(0, (c % s.L.W) + 0.5, Math.floor(c / s.L.W) + 0.5, (i * 0.9) % 6.28);
    s.st.perPlayer.clear();
    p = firePara(s.st, s.w, s.b, s.out, 'presence', { force: true, target: 'p0' });
  }
  assert.ok(p, 'a presence fits');
  assert.equal(p.data!.interf, p.tier === 2);
  const lit = s.w.players()[0].light;
  const dd = dist2(p.p![0], p.p![2], s.w.players()[0].x, s.w.players()[0].z);
  assert.ok(dd >= 3.5 && dd <= 9.8, `4-9 m ahead (${dd.toFixed(2)})`);
  s.run(0.3 + 0.35);
  const ended = s.ends.find((e) => e.id === p!.id);
  if (lit) {
    // the beam is on it from the start: >= 0.4 s later it ends 'lit' with the beam owner as witness
    s.run(0.2);
    const e2 = s.ends.find((e) => e.id === p!.id);
    assert.ok(e2 && e2.reason === 'lit', `ended lit (${e2?.reason})`);
    assert.ok(s.records.find((r) => r.id === p!.id)!.witnesses.includes('p0'));
  } else assert.ok(!ended || ended.reason !== 'lit');
});

test('silhouette: backlit at a corridor end 8-22 m ahead, inside the view cone, and it fits on generated facilities', () => {
  let fits = 0;
  for (const seed of ['sil-a', 'sil-b', 'sil-c', 'para-shots-2']) {
    const s = new Sim({ seed, players: 2, realSec: 900, monsters: null, directorEvery: 0, director: () => 'build', balance: { gapSlowSec: 9000, gapFastSec: 9000 } });
    s.run(41);
    const L = s.L;
    // stand in corridors, facing along each axis
    let ev = null;
    for (let i = 0; i < 400 && !ev; i++) {
      const c = (i * 131 + 7) % L.owner.length;
      const o = L.owner[c];
      if (o < 0 || L.spaces[o].kind !== 'corridor' || !indoor(L, o)) continue;
      s.place(0, (c % L.W) + 0.5, Math.floor(c / L.W) + 0.5, (i % 4) * (Math.PI / 2));
      s.st.perPlayer.clear();
      ev = firePara(s.st, s.w, s.b, s.out, 'silhouette', { force: true, target: 'p0' });
    }
    if (!ev) continue;
    fits++;
    const me = s.w.players()[0];
    const [x, , z] = ev.p!;
    const dd = dist2(x, z, me.x, me.z);
    assert.ok(dd >= B.silhouette.minM && dd <= B.silhouette.maxM, `${seed}: 8-22 m ahead (${dd.toFixed(1)})`);
    const ang = Math.acos((Math.sin(me.yaw) * (x - me.x) + Math.cos(me.yaw) * (z - me.z)) / dd);
    assert.ok(ang <= (B.silhouette.coneDeg * Math.PI) / 180 + 1e-6, `${seed}: in the view cone`);
    assert.equal(L.spaces[spaceAtXZ(L, x, z)].kind, 'corridor', `${seed}: stands in a corridor`);
    const room = Number(ev.data!.room);
    assert.ok(s.lightsOn(room), `${seed}: backlit by a lit space`);
    const back = fixturesOf(L).filter((f) => f.space === room && (f.state === 'on' || f.state === 'flicker') && dist2(f.x, f.z, x, z) <= B.silhouette.backM);
    assert.ok(back.length > 0, `${seed}: a glowing fixture within ${B.silhouette.backM} m behind it`);
    assert.ok(back.some((f) => dist2(f.x, f.z, me.x, me.z) >= dd - 0.75), `${seed}: the light is behind it, not in front`);
  }
  assert.ok(fits >= 3, `fits on most layouts (${fits}/4)`);
});

test('guarantee: a mirror event already aimed at the player answers it (no second one at the glass)', () => {
  const s = new Sim({ seed: 'mirror-g', players: 2, realSec: 900, monsters: null, directorEvery: 0, director: () => 'build', balance: { noopChance: 1, firstDelaySec: 40 } });
  const ms = mirrorsOf(s.L).filter((m) => m.kind !== 'van' && indoor(s.L, m.space));
  const m = ms[0];
  const nx = Math.sin(m.rot), nz = Math.cos(m.rot);
  // 7 m out: inside the figure's 15 m arming range, outside the guarantee's 5 m
  s.place(0, m.x + nx * 7, m.z + nz * 7, m.rot);
  s.place(1, m.x + nx * 7, m.z + nz * 7, m.rot);
  s.run(45);
  const fig = firePara(s.st, s.w, s.b, s.out, 'mirror_figure', { force: true, target: 'p0' });
  assert.ok(fig, 'a figure is armed for p0');
  const before = s.events().length;
  s.st.perPlayer.clear();
  s.st.recent = [];
  s.st.lastAt = -Infinity;
  s.place(0, m.x + nx * 2, m.z + nz * 2, m.rot);
  s.run(4);
  const extra = s.events().slice(before).filter((e) => e.ev.kind === 'mirror_figure' || e.ev.kind === 'mirror_writing');
  assert.equal(extra.length, 0, 'no second mirror event for p0');
});
