import { generate } from './gen.ts';
const L = generate({ seed: 'demo', W: 64, H: 48, difficulty: 0.5, locks: 2 });
const cc = L.doors.filter(d => d.a >= 0 && L.spaces[d.a].kind === 'corridor' && L.spaces[d.b].kind === 'corridor');
const by: Record<string, number> = {}; for (const d of cc) by[d.kind] = (by[d.kind] ?? 0) + 1;
console.log('corridor-corridor doors by kind', by, 'seed used', L.seed);
