// Owned by track ② Level. Level generator CLI + dependency-free top-down PNG map renderer.
//   node tools/gen-cli.ts --seed X --players 4 --risk 1 --png out.png [--json out.json] [--scale 14]
//   node tools/gen-cli.ts --hub --png hub.png
//   node tools/gen-cli.ts --seed X --players 4 --theme hospital --modifiers "DARK WARDS,MAZE" --png out.png   (v1.2)
//   node tools/gen-cli.ts --themes <dir> [--seed X --players 4]   (one PNG per site theme into <dir>)
//   node tools/gen-cli.ts --fixtures            (rewrites tests/fixtures/layouts/*.json; integrator only)
// v1.2 map overlay: stations (white squares), containers (orange, with a tick to the front cell), lore holders (yellow
// diamonds), mirrors (cyan bars), emergency lights (red); the second legend line names the theme, modifiers and counts.
// Without --png/--json it prints a one-line summary + metrics (G0 boot check).
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateFacility, generateHub, resolveTuning, validateLayout } from '../packages/shared/src/procgen/index.ts';
import type { LevelTuning } from '../packages/shared/src/procgen/index.ts';
import type { LevelLayout } from '../packages/shared/src/layout.ts';
import { SITE_THEMES, THEMES, modifierSlugs, themeOf } from '../packages/shared/src/procgen/themes.ts';
import { stationsOf } from '../packages/shared/src/procgen/van.ts';
import { containersOf } from '../packages/shared/src/procgen/containers.ts';
import { loreSpotsOf } from '../packages/shared/src/procgen/lore.ts';
import { mirrorsOf } from '../packages/shared/src/procgen/mirrors.ts';
import { normalOfYaw } from '../packages/shared/src/procgen/common.ts';

// ---------------- PNG encoding ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function encodePNG(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------- 5x7 bitmap font (A-Z 0-9 and a few symbols) ----------------
const FONT: Record<string, string> = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110', '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110', '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000', '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100', '-': '00000000000000011111000000000000000', '#': '01010010101111101010111110101001010',
  ':': '00000001000010000000001000010000000', '.': '00000000000000000000000000110001100', ' ': '00000000000000000000000000000000000',
};

type RGB = readonly [number, number, number];

export class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  constructor(w: number, h: number, bg: RGB) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 4);
    this.rect(0, 0, w, h, bg);
  }
  set(x: number, y: number, c: RGB, a = 1): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.px[i] = Math.round(this.px[i] * (1 - a) + c[0] * a);
    this.px[i + 1] = Math.round(this.px[i + 1] * (1 - a) + c[1] * a);
    this.px[i + 2] = Math.round(this.px[i + 2] * (1 - a) + c[2] * a);
    this.px[i + 3] = 255;
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) this.set(x, y, c, a);
  }
  disc(cx: number, cy: number, r: number, c: RGB): void {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + 0.5) this.set(cx + x, cy + y, c);
  }
  ring(cx: number, cy: number, r: number, c: RGB): void {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) { const d = x * x + y * y; if (d <= r * r + 0.5 && d >= (r - 1.2) * (r - 1.2)) this.set(cx + x, cy + y, c); }
  }
  text(s: string, x: number, y: number, c: RGB, scale = 1, shadow: RGB | null = [0, 0, 0]): void {
    const draw = (ox: number, oy: number, col: RGB) => {
      let cx = ox;
      for (const ch of s.toUpperCase()) {
        const g = FONT[ch] ?? FONT[' '];
        for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r * 5 + k] === '1') this.rect(cx + k * scale, oy + r * scale, cx + (k + 1) * scale, oy + (r + 1) * scale, col);
        cx += 6 * scale;
      }
    };
    if (shadow) draw(x + 1, y + 1, shadow);
    draw(x, y, c);
  }
  static textWidth(s: string, scale = 1): number { return s.length * 6 * scale - scale; }
  png(): Buffer { return encodePNG(this.w, this.h, this.px); }
}

// ---------------- map renderer ----------------
const ZONE_COL: RGB[] = [[58, 84, 64], [70, 72, 112], [112, 66, 66]];
const DOOR_COL: Record<string, RGB | null> = {
  open: null, door: [214, 150, 70], fire: [235, 90, 40], security: [250, 210, 40], locked: [255, 40, 40],
  blocked: [90, 80, 70], exit: [80, 255, 120], vault: [0, 230, 255],
};
const ITEM_GLYPH: Record<string, { c: RGB; r: number; ring?: boolean }> = {
  loot: { c: [212, 178, 70], r: 1 }, lever: { c: [255, 120, 255], r: 4 }, keypad: { c: [0, 255, 255], r: 3 }, core: { c: [0, 255, 255], r: 5, ring: true },
  keycard: { c: [255, 40, 40], r: 4, ring: true }, hiding: { c: [70, 150, 255], r: 3 }, note: { c: [255, 255, 255], r: 2 },
  vent: { c: [180, 80, 255], r: 3, ring: true }, intercom: { c: [255, 160, 0], r: 2 }, switch: { c: [255, 255, 160], r: 1 },
  console: { c: [0, 255, 140], r: 3 }, spawn_player: { c: [120, 255, 120], r: 2, ring: true }, spawn_hound: { c: [255, 60, 0], r: 4, ring: true },
  spawn_listener: { c: [255, 0, 140], r: 4, ring: true }, spawn_mannequin: { c: [240, 240, 240], r: 4, ring: true },
  kennel: { c: [255, 140, 0], r: 3 }, mirror: { c: [200, 200, 255], r: 3 }, board: { c: [255, 255, 255], r: 3 }, shop: { c: [0, 200, 120], r: 3 },
  leave_lever: { c: [255, 80, 80], r: 2 }, deposit: { c: [212, 178, 70], r: 3, ring: true }, prop: { c: [160, 160, 160], r: 2 },
};

export function renderMap(L: LevelLayout, S = 14): Canvas {
  const legendH = 30;
  const cv = new Canvas(L.W * S + 1, L.H * S + 1 + legendH, [12, 12, 15]);
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= L.W || y >= L.H ? -1 : L.owner[y * L.W + x]);
  // floors
  for (let y = 0; y < L.H; y++) for (let x = 0; x < L.W; x++) {
    const s = own(x, y);
    if (s < 0) { cv.rect(x * S, y * S, (x + 1) * S, (y + 1) * S, [24, 24, 28]); continue; }
    const sp = L.spaces[s];
    let c: RGB = sp.kind === 'corridor' ? [128, 128, 132] : ZONE_COL[Math.max(0, sp.zone) % ZONE_COL.length];
    if (sp.kind === 'outside') c = sp.type === 'kennel' ? [70, 56, 36] : [40, 42, 46];
    if (sp.type === 'van') c = [190, 190, 200];
    if (sp.type === 'lobby') c = [60, 120, 70];
    if (sp.kind === 'vault') c = [20, 90, 110];
    if (sp.kind === 'hall') c = [Math.min(255, c[0] + 14), Math.min(255, c[1] + 14), Math.min(255, c[2] + 14)];
    cv.rect(x * S, y * S, (x + 1) * S, (y + 1) * S, c);
    if (sp.powerZone === 1 && !sp.open) for (let k = 0; k < S; k += 4) cv.set(x * S + k, y * S + ((k + 2) % S), [255, 255, 0], 0.25);
  }
  // walls (fences dotted)
  const wallPx = (x0: number, y0: number, horiz: boolean, fence: boolean) => {
    for (let k = 0; k <= S; k++) {
      if (fence && k % 3 === 0) continue;
      const c: RGB = fence ? [150, 150, 120] : [0, 0, 0];
      if (horiz) { cv.set(x0 + k, y0, c); cv.set(x0 + k, y0 + 1, c); } else { cv.set(x0, y0 + k, c); cv.set(x0 + 1, y0 + k, c); }
    }
  };
  const isOpenSp = (s: number) => s >= 0 && L.spaces[s].open;
  for (let y = 0; y < L.H; y++) for (let x = 0; x <= L.W; x++) {
    const a = own(x - 1, y), b = own(x, y);
    if (a !== b) wallPx(x * S, y * S, false, (isOpenSp(a) && isOpenSp(b)) || (isOpenSp(a) && x === L.W) || (isOpenSp(b) && x === 0));
  }
  for (let y = 0; y <= L.H; y++) for (let x = 0; x < L.W; x++) {
    const a = own(x, y - 1), b = own(x, y);
    if (a !== b) wallPx(x * S, y * S, true, (isOpenSp(a) && isOpenSp(b)) || (isOpenSp(a) && y === L.H) || (isOpenSp(b) && y === 0));
  }
  // doors
  for (const d of L.doors) {
    const c0 = DOOR_COL[d.kind];
    const c: RGB = c0 ?? (L.spaces[Math.max(0, d.a)].kind === 'corridor' ? [128, 128, 132] : [100, 100, 100]);
    for (let i = 0; i < d.len; i++) for (let k = 2; k <= S - 2; k++) for (let t = -1; t <= 2; t++) {
      if (d.dir === 'v') cv.set(d.x * S + t, (d.y + i) * S + k, c); else cv.set((d.x + i) * S + k, d.y * S + t, c);
    }
    if (!d.initiallyOpen && d.kind !== 'open' && d.kind !== 'blocked') {
      // closed doors: dark tick in the middle
      const mx = d.dir === 'v' ? d.x * S : (d.x + d.len / 2) * S, my = d.dir === 'v' ? (d.y + d.len / 2) * S : d.y * S;
      cv.rect(mx - 1, my - 1, mx + 2, my + 2, [0, 0, 0]);
    }
  }
  // items
  for (const it of L.items) {
    if (it.kind === 'light') {
      const st = String(it.data?.state ?? 'on');
      const c: RGB = st === 'on' ? [255, 250, 210] : st === 'flicker' ? [255, 170, 60] : st === 'off' ? [90, 90, 90] : [150, 30, 30];
      cv.rect(it.x * S - 1, it.z * S - 1, it.x * S + 1, it.z * S + 1, c);
      continue;
    }
    const gl = ITEM_GLYPH[it.kind];
    if (!gl) continue;
    if (gl.ring) cv.ring(it.x * S, it.z * S, gl.r, gl.c); else cv.disc(it.x * S, it.z * S, gl.r, gl.c);
  }
  // v1.2 overlay: containers (+ front cell tick), lore holders, mirrors, stations, emergency lights
  const conts = containersOf(L), lore = loreSpotsOf(L), mirrors = mirrorsOf(L), stations = stationsOf(L).filter((st) => !st.virtual);
  for (const c of conts) {
    cv.rect(c.x * S - 2, c.z * S - 2, c.x * S + 3, c.z * S + 3, [255, 150, 30]);
    const fx = (c.front[0] + 0.5) * S, fz = (c.front[1] + 0.5) * S;
    for (let k = 0; k <= 8; k++) cv.set(c.x * S + ((fx - c.x * S) * k) / 8, c.z * S + ((fz - c.z * S) * k) / 8, [255, 150, 30], 0.7);
  }
  for (const sp of lore) {
    if (sp.style === 'drawer') { cv.ring(sp.x * S, sp.z * S, 4, [255, 230, 60]); continue; }
    for (let d = -3; d <= 3; d++) for (let e = -(3 - Math.abs(d)); e <= 3 - Math.abs(d); e++) cv.set(sp.x * S + d, sp.z * S + e, [255, 230, 60]);
  }
  for (const m of mirrors) {
    const [nx, nz] = normalOfYaw(m.rot);
    const tx = -nz, tz = nx, half = (m.w / 2) * S;
    for (let k = -half; k <= half; k++) for (const o of [0, 1]) cv.set(m.x * S + tx * k + nx * o, m.z * S + tz * k + nz * o, [80, 240, 255]);
  }
  for (const st of stations) cv.ring(st.x * S, st.z * S, 2, [255, 255, 255]);
  for (const it of L.items) if (it.kind === 'light' && it.data?.kind === 'emergency') cv.rect(it.x * S - 2, it.z * S - 2, it.x * S + 2, it.z * S + 2, [255, 30, 30]);
  // van outline
  const v = L.van;
  for (let k = 0; k <= v.cab.w * S; k++) { cv.set(v.cab.x * S + k, v.cab.y * S + 2, [255, 255, 255], 0.5); }
  // callsigns
  for (const s of L.spaces) {
    if (!s.callsign) continue;
    const label = s.callsign;
    const sc = S >= 12 && Canvas.textWidth(label, 1) < s.rect.w * S - 2 ? 1 : 1;
    const tw = Canvas.textWidth(label, sc);
    const x = Math.round((s.rect.x + s.rect.w / 2) * S - tw / 2), y = Math.round((s.rect.y + s.rect.h / 2) * S - 3.5 * sc);
    cv.text(label, x, y, s.kind === 'vault' ? [120, 255, 255] : [255, 255, 255], sc);
  }
  // legend
  const ly = L.H * S + 4;
  const m = L.metrics;
  const leg = L.kind === 'hub' ? `HUB ${L.W}X${L.H}` : `SEED ${L.seed} P${m.players} R${m.risk} ${L.W}X${L.H} ROOMS ${m.rooms} LOOPS ${m.loops} DE ${m.deadEnds} LOCK ${m.locks} SEC ${m.security} LEV ${m.leverPathM}M #${L.hash}`;
  cv.text(leg, 4, ly, [220, 220, 220], 1);
  const mods = Object.keys(m).filter((k) => k.startsWith('mod:')).map((k) => k.slice(4).toUpperCase());
  const leg2 = `${L.kind === 'hub' ? 'HUB' : THEMES[themeOf(L)].label}${mods.length ? ` MODS ${mods.join(' ')}` : ''} STATIONS ${stations.length} CONTAINERS ${conts.length} LORE ${lore.length} MIRRORS ${mirrors.length}`;
  cv.text(leg2, 4, ly + 12, [255, 220, 150], 1);
  return cv;
}

// ---------------- CLI ----------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const ROOT = resolve(import.meta.dirname, '..');

export const FIXTURES: readonly { file: string; seed: string; players: number; risk: number }[] = [
  { file: 'facility_s1_p2.json', seed: 's1', players: 2, risk: 1 },
  { file: 'facility_s2_p4.json', seed: 's2', players: 4, risk: 1 },
  { file: 'facility_s3_p6.json', seed: 's3', players: 6, risk: 1 },
  { file: 'facility_s4_p4_risk2.json', seed: 's4', players: 4, risk: 2 },
];

export function loadTuning(): LevelTuning {
  try { return resolveTuning(JSON.parse(readFileSync(resolve(ROOT, 'config/balance/level.json'), 'utf8'))); }
  catch { return resolveTuning(null); }
}

function writeOut(file: string, data: string | Buffer): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, data);
}

function main(): void {
  const tuning = loadTuning();
  if (has('fixtures')) {
    const dir = resolve(ROOT, 'tests/fixtures/layouts');
    for (const f of FIXTURES) {
      const L = generateFacility({ seed: f.seed, players: f.players, risk: f.risk }, tuning);
      const v = validateLayout(L);
      writeOut(resolve(dir, f.file), JSON.stringify(L));
      console.log(f.file, L.hash, v.errors.length ? v.errors : 'ok');
    }
    const hub = generateHub();
    writeOut(resolve(dir, 'hub.json'), JSON.stringify(hub));
    console.log('hub.json', hub.hash, validateLayout(hub).errors);
    return;
  }
  const theme = arg('theme');
  const modifiers = arg('modifiers')?.split(',').map((m) => m.trim()).filter(Boolean);
  const themesDir = arg('themes');
  if (themesDir) {
    // one map per site theme (same seed / crew size), for review
    for (const th of SITE_THEMES) {
      const t1 = performance.now();
      const L = generateFacility({ seed: arg('seed') ?? '1', players: Number(arg('players') ?? 4), risk: Number(arg('risk') ?? 1), theme: th, modifiers }, tuning);
      const v = validateLayout(L);
      writeOut(resolve(themesDir, `theme_${th}.png`), renderMap(L, Number(arg('scale') ?? 14)).png());
      console.log(`${th.padEnd(12)} hash=${L.hash} gen=${(performance.now() - t1).toFixed(1)}ms valid=${v.errors.length === 0 ? 'yes' : v.errors.join('; ')}`);
      if (v.errors.length) process.exitCode = 1;
    }
    return;
  }
  const t0 = performance.now();
  const L = has('hub') ? generateHub() : generateFacility({ seed: arg('seed') ?? '1', players: Number(arg('players') ?? 4), risk: Number(arg('risk') ?? 1), theme, modifiers }, tuning);
  const ms = performance.now() - t0;
  const v = validateLayout(L);
  const png = arg('png'), json = arg('json');
  if (png) writeOut(png, renderMap(L, Number(arg('scale') ?? 14)).png());
  if (json) writeOut(json, JSON.stringify(L));
  console.log(`${L.kind} seed=${L.seed} theme=${L.theme}${modifiers?.length ? ` mods=${modifierSlugs(modifiers).join('+')}` : ''} ${L.W}x${L.H} hash=${L.hash} gen=${ms.toFixed(1)}ms valid=${v.errors.length === 0 ? 'yes' : v.errors.join('; ')}`);
  console.log(JSON.stringify(L.metrics));
  if (v.errors.length) process.exitCode = 1;
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main();
