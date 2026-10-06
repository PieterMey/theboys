// Minimal dependency-free top-down PNG renderer for generated levels (agents can Read the PNG to review layouts).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { generate, type Level } from './gen.ts';

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf: Uint8Array) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function encodePNG(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function renderPNG(L: Level, file: string, S = 10) {
  const w = L.W * S + 1, h = L.H * S + 1; const px = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255; };
  const rect = (x0: number, y0: number, x1: number, y1: number, c: number[]) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c); };
  const zoneCol = [[70, 90, 70], [60, 70, 105], [105, 65, 65], [100, 90, 50]];
  rect(0, 0, w, h, [15, 15, 18]);
  for (const s of L.spaces) {
    const c = s.kind === 'corridor' ? [150, 150, 150] : zoneCol[Math.max(0, s.zone) % 4];
    rect(s.rect.x * S, s.rect.y * S, (s.rect.x + s.rect.w) * S, (s.rect.y + s.rect.h) * S, s.type === 'lobby' ? [60, 140, 60] : c);
  }
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= L.W || y >= L.H ? -1 : L.owner[y * L.W + x]);
  for (let y = 0; y < L.H; y++) for (let x = 0; x <= L.W; x++) if (own(x - 1, y) !== own(x, y)) for (let k = 0; k <= S; k++) { set(x * S, y * S + k, [0, 0, 0]); set(x * S + 1, y * S + k, [0, 0, 0]); }
  for (let y = 0; y <= L.H; y++) for (let x = 0; x < L.W; x++) if (own(x, y - 1) !== own(x, y)) for (let k = 0; k <= S; k++) { set(x * S + k, y * S, [0, 0, 0]); set(x * S + k, y * S + 1, [0, 0, 0]); }
  const dc: Record<string, number[] | null> = { open: null, door: [200, 140, 60], locked: [255, 30, 30], blocked: [40, 40, 40], exit: [60, 255, 60] };
  for (const d of L.doors) {
    const c = d.kind === 'open' ? (L.spaces[Math.max(0, d.a)].kind === 'corridor' ? [150, 150, 150] : [120, 120, 120]) : dc[d.kind]!;
    for (let i = 0; i < d.len; i++) for (let k = 2; k <= S - 2; k++) for (let t = -1; t <= 2; t++) {
      if (d.dir === 'v') set(d.x * S + t, (d.y + i) * S + k, c); else set((d.x + i) * S + k, d.y * S + t, c);
    }
  }
  const ic: Record<string, number[]> = { keycard: [255, 230, 0], loot: [200, 170, 60], 'hide:locker': [60, 160, 255], 'spawn:vent': [255, 0, 255], 'switch:A': [0, 255, 200], 'switch:B': [0, 255, 200], 'light:on': [255, 255, 220], 'light:flicker': [255, 200, 120], 'light:off': [60, 60, 60] };
  for (const it of L.items) {
    const c = it.kind.startsWith('objective') ? [0, 220, 255] : ic[it.kind]; if (!c) continue;
    const r = it.kind.startsWith('light') ? 1 : it.kind === 'loot' ? 1 : 3;
    const X = Math.round(it.x * S), Y = Math.round(it.y * S);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) set(X + dx, Y + dy, c);
  }
  writeFileSync(file, encodePNG(w, h, px));
}
const seed = process.argv[2] ?? 'demo';
const L = generate({ seed, W: 64, H: 48, difficulty: 0.5, locks: 2 });
renderPNG(L, `map_${seed}.png`);
console.log('wrote', `map_${seed}.png`, L.metrics);
