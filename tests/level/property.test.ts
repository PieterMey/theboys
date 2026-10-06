// Track ② Level: 1000 seeds x {2,4,6} players. Invariants: no throw, valid (solvable, levers, vault, loops,
// hiding coverage, unique callsigns...), room counts per crew size (v1.1: bigger sites, 15-28 rooms), determinism,
// median generation time < 20 ms.
// Run: node --test tests/level/property.test.ts   (SEEDS=200 for a quick run)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility, validateLayout } from '../../packages/shared/src/procgen/index.ts';
import { DEFAULT_LEVEL_TUNING, footprintFor, roomRangeFor } from '../../packages/shared/src/procgen/tuning.ts';

const SEEDS = Number(process.env.SEEDS ?? 1000);
const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];

for (const players of [2, 4, 6]) {
  test(`facility property: ${SEEDS} seeds at ${players} players`, () => {
    const times: number[] = [];
    const rooms: number[] = [];
    const loops: number[] = [];
    const deadEnds: number[] = [];
    const lever: number[] = [];
    let retried = 0, locked = 0;
    const [roomsLo, roomsHi] = roomRangeFor(players, DEFAULT_LEVEL_TUNING);
    const props: number[] = [];
    const [fw, fh] = footprintFor(players);
    const failures: string[] = [];
    // warm the JIT so the first samples don't dominate
    for (let i = 0; i < 20; i++) generateFacility({ seed: `warm${i}`, players, risk: 1 });
    for (let i = 0; i < SEEDS; i++) {
      const risk = 1 + (i % 3);
      const seed = `p${players}-${i}`;
      const t0 = performance.now();
      let L;
      try { L = generateFacility({ seed, players, risk }); } catch (e) { failures.push(`${seed}: throw ${(e as Error).message}`); continue; }
      times.push(performance.now() - t0);
      const v = validateLayout(L);
      if (v.errors.length) failures.push(`${seed} r${risk}: ${v.errors.slice(0, 3).join('; ')}`);
      rooms.push(L.metrics.rooms);
      loops.push(v.loops);
      deadEnds.push(L.metrics.deadEnds);
      lever.push(v.leverPathM);
      if (L.metrics.attempt > 0) retried++;
      if (L.metrics.locks) locked++;
      if (L.metrics.rooms < roomsLo || L.metrics.rooms > roomsHi) failures.push(`${seed}: rooms ${L.metrics.rooms}`);
      if (L.W !== fw || L.H - L.metrics.lotDepth !== fh) failures.push(`${seed}: footprint ${L.W}x${L.H - L.metrics.lotDepth}`);
      props.push(Number(L.metrics.props));
      if (i < 25) {
        const again = generateFacility({ seed, players, risk });
        if (again.hash !== L.hash || JSON.stringify(again) !== JSON.stringify(L)) failures.push(`${seed}: nondeterministic`);
      }
    }
    const stats = {
      players, n: SEEDS, failures: failures.length, retried, locked,
      ms_p50: +q(times, 0.5).toFixed(2), ms_p90: +q(times, 0.9).toFixed(2), ms_max: +q(times, 1).toFixed(1),
      rooms_p5: q(rooms, 0.05), rooms_p50: q(rooms, 0.5), rooms_p95: q(rooms, 0.95),
      loops_min: q(loops, 0), loops_p50: q(loops, 0.5), deadEnds_p50: q(deadEnds, 0.5), deadEnds_p90: q(deadEnds, 0.9),
      lever_min: +q(lever, 0).toFixed(1), lever_p50: +q(lever, 0.5).toFixed(1), props_p5: q(props, 0.05), props_p50: q(props, 0.5),
    };
    console.log(JSON.stringify(stats));
    assert.deepEqual(failures.slice(0, 10), []);
    assert.ok(stats.ms_p50 < 20, `median generation ${stats.ms_p50} ms >= 20 ms`);
    // denser furnishing: at least ~6 pieces per room on average
    assert.ok(stats.props_p5 >= stats.rooms_p5 * 6, `only ${stats.props_p5} props (p5) for ${stats.rooms_p5} rooms`);
    assert.ok(locked > SEEDS * 0.9, `only ${locked}/${SEEDS} layouts got their keycard lock`);
  });
}
