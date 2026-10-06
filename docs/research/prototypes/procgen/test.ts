import { generate, type Level } from './gen.ts';
function hashLevel(L: Level): string {
  let h = 2166136261 >>> 0;
  const mix = (n: number) => { h = Math.imul(h ^ (n | 0), 16777619) >>> 0; };
  for (const v of L.owner) mix(v);
  for (const d of L.doors) { mix(d.a); mix(d.b); mix(d.x); mix(d.y); mix(d.len); mix(d.kind.length); mix(d.lock); }
  for (const it of L.items) { mix(it.space); mix(Math.round(it.x * 2)); mix(Math.round(it.y * 2)); mix(it.kind.length); }
  return h.toString(16);
}
const N = 1000; let bad = 0, fewerZones = 0, noFire = 0; const times: number[] = []; const cyc: number[] = []; const loops0: number[] = []; const rooms: number[] = [];
for (let i = 0; i < N; i++) {
  const p = { seed: 's' + i, W: 64, H: 48, difficulty: (i % 5) / 4, locks: 2 };
  let L: Level;
  try { L = generate(p); } catch (e) { bad++; if (bad < 5) console.log('THROW', p.seed, (e as Error).message); continue; }
  const m = L.metrics;
  if (m.unreachable > 0) { bad++; if (bad < 5) console.log('UNREACHABLE', p.seed, m.unreachable); }
  if (m.zones < 2) fewerZones++;
  if (!m.fireExit) noFire++;
  times.push(m.ms); cyc.push(m.cyclomatic); loops0.push(m.loopsZone0); rooms.push(m.rooms);
  if (i < 20) { const L2 = generate(p); if (hashLevel(L) !== hashLevel(L2)) console.log('NONDETERMINISTIC', p.seed); }
}
const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];
console.log({ N, bad, fewerZones, noFire, ms_p50: q(times, 0.5), ms_p99: q(times, 0.99), cyc_p10: q(cyc, 0.1), cyc_p50: q(cyc, 0.5), loopsZone0_p10: q(loops0, 0.1), loopsZone0_min: q(loops0, 0), rooms_p50: q(rooms, 0.5) });
console.log('hash s0', hashLevel(generate({ seed: 's0', W: 64, H: 48, difficulty: 0, locks: 2 })));
