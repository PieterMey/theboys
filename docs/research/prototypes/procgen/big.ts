import { generate } from './gen.ts';
for (const [W, H] of [[40, 30], [64, 48], [96, 72], [128, 96]]) {
  const ts: number[] = []; let m: Record<string, number> = {};
  for (let i = 0; i < 30; i++) { const L = generate({ seed: 'b' + i, W, H, difficulty: 0.6, locks: 3 }); ts.push(L.metrics.ms); m = L.metrics; }
  ts.sort((a, b) => a - b);
  console.log(`${W}x${H}: p50 ${ts[15].toFixed(1)} ms, max ${ts[29].toFixed(1)} ms, rooms ${m.rooms}, zones ${m.zones}, cyclomatic ${m.cyclomatic}, maxDist ${m.maxDistM} m`);
}
