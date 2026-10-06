import { generate } from './gen.ts';
const L = generate({ seed: 'demo', W: 64, H: 48, difficulty: 0.5, locks: 2 });
const wire = { v: 1, seed: L.seed, W: L.W, H: L.H, spaces: L.spaces.map(s => [s.kind === 'room' ? 1 : 0, s.rect.x, s.rect.y, s.rect.w, s.rect.h, s.zone, s.type]), doors: L.doors.map(d => [d.a, d.b, d.x, d.y, d.dir, d.len, d.kind, d.lock]), items: L.items.map(i => [i.kind, i.space, i.x, i.y]) };
const json = JSON.stringify(wire);
const { gzipSync } = await import('node:zlib');
console.log('json bytes', json.length, 'gzip bytes', gzipSync(json).length, 'items', L.items.length);
