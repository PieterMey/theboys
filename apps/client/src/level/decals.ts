// Owner: env-world (v1.2). Decals from env-layout's atlas (clutter kind 'decal': leak streaks, hand prints, footprints,
// rust / mould / algae stains, warning signs, hazard tape). Each decal is a world-space quad 4 mm off its wall or
// 3 mm over the floor; the level merges them per space (ONE draw per space, material 'decal', no shadows), with
// polygon offset. Quads are clipped to their straight wall run (never across a doorway, never through a corner) and,
// on floors, to the space's own cells (a footprint trail stops short of walls and door openings); UVs are clipped
// with them, so nothing stretches. The atlas is mostly soft alpha (leaks and stains sit at 5-40 % opacity), which an
// alpha cut-out would erase, so the material blends like the v1.1 stain / puddle decals (no depth write) and drops
// near-zero fragments with a small alpha test. Until (or without) the staged atlas, a procedural CanvasTexture with
// the same cell layout stands in; the KTX2 atlas swaps into the same texture node (no recompile).
import * as THREE from 'three/webgpu';
import { float, floor, texture, uniform, uv, vec4 } from 'three/tsl';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { ClutterItem } from '@dead-air/shared/procgen/clutter.ts';
import { EDGE, edgeCode } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import { assetUrl, getAssetManifest, hasAsset, loadAssetManifest } from '@dead-air/shared/assets.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import type { Part } from './setpieces.ts';

/** one atlas cell: uv = [u0, v0, u1, v1] of the visible content, v counted from the TOP image row (no flip);
 *  aspect = width / height of that content */
export interface DecalCell { uv: readonly [number, number, number, number]; aspect: number }

/** the staged decal.index (spec ab5353c7eca5), used until / unless the live index loads */
export const DEFAULT_DECAL_CELLS: readonly DecalCell[] = [
  { uv: [0.0078, 0.0664, 0.2422, 0.1836], aspect: 2 }, { uv: [0.3457, 0.0078, 0.4043, 0.2422], aspect: 0.25 },
  { uv: [0.5078, 0.0078, 0.7422, 0.2422], aspect: 1 }, { uv: [0.7578, 0.0078, 0.9922, 0.2422], aspect: 1 },
  { uv: [0.0078, 0.2578, 0.2422, 0.4922], aspect: 1 }, { uv: [0.2578, 0.2578, 0.4922, 0.4922], aspect: 1 },
  { uv: [0.5957, 0.2578, 0.6543, 0.4922], aspect: 0.25 }, { uv: [0.8457, 0.2578, 0.9043, 0.4922], aspect: 0.25 },
  { uv: [0.0078, 0.5078, 0.2422, 0.7422], aspect: 1 }, { uv: [0.2578, 0.5078, 0.4922, 0.7422], aspect: 1 },
  { uv: [0.5078, 0.5078, 0.7422, 0.7422], aspect: 1 }, { uv: [0.7578, 0.5078, 0.9922, 0.7422], aspect: 1 },
  { uv: [0.0078, 0.7578, 0.2422, 0.9922], aspect: 1 }, { uv: [0.2578, 0.7578, 0.4922, 0.9922], aspect: 1 },
  { uv: [0.5078, 0.7578, 0.7422, 0.9922], aspect: 1 }, { uv: [0.8604, 0.7578, 0.8896, 0.9922], aspect: 0.125 },
];

let cells: readonly DecalCell[] = DEFAULT_DECAL_CELLS;
let indexLoad: Promise<void> | null = null;

/** current cell table (the live decal.index once loaded; later layouts pick it up) */
export function decalCells(): readonly DecalCell[] { return cells; }

function parseIndex(j: unknown): DecalCell[] | null {
  const list = (j as { cells?: unknown })?.cells;
  if (!Array.isArray(list) || list.length < DEFAULT_DECAL_CELLS.length) return null;
  const out: DecalCell[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list.find((e: { idx?: number }) => e?.idx === i) as { uv?: number[]; aspect?: number } | undefined;
    const uv = c?.uv;
    if (!uv || uv.length !== 4 || !uv.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || !(Number(c.aspect) > 0)) return null;
    out.push({ uv: [uv[0], uv[1], uv[2], uv[3]], aspect: Number(c.aspect) });
  }
  return out;
}

/** fetch the staged decal.index once (falls back to the built-in table) */
export function loadDecalIndex(): Promise<void> {
  indexLoad ??= (async () => {
    try {
      if (!getAssetManifest()) await loadAssetManifest();
      const url = hasAsset('decal.index') ? assetUrl('decal.index') : null;
      if (!url || typeof fetch !== 'function') return;
      const res = await fetch(url);
      if (!res.ok) return;
      const parsed = parseIndex(await res.json());
      if (parsed) cells = parsed;
    } catch { /* keep the built-in table */ }
  })();
  return indexLoad;
}

// ---------------------------------------------------------------- geometry

export interface DecalClip {
  grid: EdgeGrid;
  wallH: number;
}
/** stats of the last decalParts calls (renderInfo) */
export const decalStats = { built: 0, clipped: 0, dropped: 0, moved: 0 };

/** inset from the end of a straight wall run (corner wall faces sit HALF_T in; door frames a little more) */
const RUN_INSET = 0.12;
/** floor quads keep this far from any wall / door edge of their cell */
const FLOOR_MARGIN = HALF_T + 0.04;

/** wall direction (edge dir 0 +x, 1 -x, 2 +z, 3 -z) behind a wall decal facing (nx, nz) into its room */
function wallDir(nx: number, nz: number): number { return nx > 0.5 ? 1 : nx < -0.5 ? 0 : nz > 0.5 ? 3 : 2; }

/** world extent [lo, hi] (along z for an x-facing wall, along x for a z-facing one) of the straight wall run behind
 *  cell (cx, cz): same space, a real wall edge (no door, no opening); null when the cell itself has no wall there */
export function wallRun(g: EdgeGrid, space: number, cx: number, cz: number, nx: number, nz: number): [number, number] | null {
  const dir = wallDir(nx, nz);
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < g.W && y < g.H && g.owner[y * g.W + x] === space && edgeCode(g, x, y, dir) === EDGE.wall;
  if (!ok(cx, cz)) return null;
  const alongZ = Math.abs(nx) > 0.5;
  let lo = alongZ ? cz : cx, hi = lo;
  if (alongZ) { while (ok(cx, lo - 1)) lo--; while (ok(cx, hi + 1)) hi++; } else { while (ok(lo - 1, cz)) lo--; while (ok(hi + 1, cz)) hi++; }
  return [lo + RUN_INSET, hi + 1 - RUN_INSET];
}

/** a floor point of `space` at least FLOOR_MARGIN from every non-open edge of its cell */
export function floorPointOk(g: EdgeGrid, space: number, x: number, z: number): boolean {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H || g.owner[cz * g.W + cx] !== space) return false;
  const fx = x - cx, fz = z - cz;
  if (fx < FLOOR_MARGIN && edgeCode(g, cx, cz, 1) !== EDGE.free) return false;
  if (fx > 1 - FLOOR_MARGIN && edgeCode(g, cx, cz, 0) !== EDGE.free) return false;
  if (fz < FLOOR_MARGIN && edgeCode(g, cx, cz, 3) !== EDGE.free) return false;
  if (fz > 1 - FLOOR_MARGIN && edgeCode(g, cx, cz, 2) !== EDGE.free) return false;
  return true;
}

/** one quad: centre c, right t (image +u), up w (image top), s range [s0, s1] along t, r range [r0, r1] along w,
 *  full half sizes (hw, hh) map the cell uv rect; normal n */
function quad(c: THREE.Vector3, t: THREE.Vector3, w: THREE.Vector3, n: THREE.Vector3, hw: number, hh: number, s0: number, s1: number, r0: number, r1: number, uv: DecalCell['uv']): THREE.BufferGeometry {
  const [u0, v0, u1, v1] = uv;
  const U = (s: number) => u0 + ((s + hw) / (2 * hw)) * (u1 - u0);
  const V = (r: number) => v0 + ((hh - r) / (2 * hh)) * (v1 - v0); // v from the top row
  const P = (s: number, r: number) => [c.x + t.x * s + w.x * r, c.y + t.y * s + w.y * r, c.z + t.z * s + w.z * r];
  const corners: [number, number][] = [[s0, r0], [s1, r0], [s1, r1], [s0, r0], [s1, r1], [s0, r1]];
  const pos = new Float32Array(18), nor = new Float32Array(18), uvs = new Float32Array(12);
  corners.forEach(([s, r], i) => {
    pos.set(P(s, r), i * 3);
    nor.set([n.x, n.y, n.z], i * 3);
    uvs.set([U(s), V(r)], i * 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return g;
}

const _c = new THREE.Vector3(), _t = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3();

/** Parts (world space, material 'decal') of one decal clutter item, clipped to its wall run / floor; [] = dropped. */
export function decalParts(ci: ClutterItem, clip: DecalClip | null): Part[] {
  const table = cells;
  const cell = table[Math.max(0, Math.min(table.length - 1, Math.round(ci.a)))];
  const width = Math.max(0.05, ci.b);
  const height = width / cell.aspect;
  const hw = width / 2, hh = height / 2;
  const sin = Math.sin(ci.rot), cos = Math.cos(ci.rot);
  _c.set(ci.x, ci.y, ci.z);
  _t.set(cos, 0, -sin);
  let s0 = -hw, s1 = hw, r0 = -hh, r1 = hh;
  if (ci.tip === 1) {
    // floor: image top = local -Z turned by rot
    _w.set(-sin, 0, -cos);
    _n.set(0, 1, 0);
    _c.y = Math.max(0.002, ci.y);
    if (clip) {
      const g = clip.grid;
      const ok = (s: number, r: number) => floorPointOk(g, ci.space, ci.x + _t.x * s + _w.x * r, ci.z + _t.z * s + _w.z * r);
      const line = (r: number) => ok(0, r) && ok(-hw, r) && ok(hw, r);
      if (!line(0)) { decalStats.dropped++; return []; }
      const step = 0.05;
      let hi = 0, lo = 0;
      while (hi + step <= hh && line(hi + step)) hi += step;
      while (lo - step >= -hh && line(lo - step)) lo -= step;
      if (hi + step > hh && line(hh)) hi = hh;
      if (lo - step < -hh && line(-hh)) lo = -hh;
      if (hi - lo < Math.min(0.25, height)) { decalStats.dropped++; return []; }
      if (hi < hh || lo > -hh) decalStats.clipped++;
      r0 = lo; r1 = hi;
    }
  } else {
    _w.set(0, 1, 0);
    _n.set(sin, 0, cos);
    if (clip) {
      const nx = Math.round(sin), nz = Math.round(cos);
      // the wall cell: the decal sits 0.084 m in front of its wall, inside the cell it belongs to
      const cx = Math.floor(ci.x), cz = Math.floor(ci.z);
      const alongZ = Math.abs(nx) > 0.5;
      let run = wallRun(clip.grid, ci.space, cx, cz, nx, nz);
      let cAxis = alongZ ? ci.z : ci.x;
      if (!run) {
        // env-layout puts hand prints (and some streaks) on a door cell's own edge, i.e. in the doorway: slide the
        // decal onto the nearest real wall beside it, hugging the side toward the opening (a print by the frame)
        const cell0 = alongZ ? cz : cx;
        const order = cAxis - cell0 >= 0.5 ? [1, -1, 2, -2] : [-1, 1, -2, 2];
        for (const k of order) {
          const r2 = wallRun(clip.grid, ci.space, alongZ ? cx : cx + k, alongZ ? cz + k : cz, nx, nz);
          if (!r2) continue;
          run = r2;
          const edge = k > 0 ? cell0 + k : cell0 + k + 1;
          const into = RUN_INSET + 0.04 + hw;
          cAxis = k > 0 ? edge + into : edge - into;
          if (alongZ) _c.z = cAxis; else _c.x = cAxis;
          decalStats.moved++;
          break;
        }
        if (!run) { decalStats.dropped++; return []; }
      }
      const tAxis = alongZ ? _t.z : _t.x;
      const a = (run[0] - cAxis) * tAxis, b = (run[1] - cAxis) * tAxis;
      const lo = Math.max(-hw, Math.min(a, b)), hi = Math.min(hw, Math.max(a, b));
      const y0 = Math.max(-hh, 0.1 - ci.y), y1 = Math.min(hh, clip.wallH - 0.04 - ci.y);
      if (hi - lo < Math.min(0.12, width * 0.5) || y1 - y0 < Math.min(0.1, height * 0.5)) { decalStats.dropped++; return []; }
      if (lo > -hw || hi < hw || y0 > -hh || y1 < hh) decalStats.clipped++;
      s0 = lo; s1 = hi; r0 = y0; r1 = y1;
    }
  }
  decalStats.built++;
  return [{ mat: 'decal', geo: quad(_c, _t, _w, _n, hw, hh, s0, s1, r0, r1, cell.uv) }];
}

/** every decal of a layout through decalParts (tests / tools) */
export function layoutDecals(L: LevelLayout, items: readonly ClutterItem[], grid: EdgeGrid): { space: number; part: Part }[] {
  const out: { space: number; part: Part }[] = [];
  for (const ci of items) if (ci.kind === 'decal') for (const p of decalParts(ci, { grid, wallH: L.wallH })) out.push({ space: ci.space, part: p });
  return out;
}

// ---------------------------------------------------------------- material + atlas

let decalMat: THREE.MeshStandardNodeMaterial | null = null;
let atlasNode: { value: THREE.Texture } | null = null;
let atlasLoad: Promise<boolean> | null = null;
let atlasLoader: ((key: string) => Promise<THREE.Texture | null>) | null = null;
/** which atlas the decals show: 'fallback' (procedural) | 'staged' */
export let decalAtlasSource: 'fallback' | 'staged' = 'fallback';

/** the level's texture loader (materials.ts KTX2 + webp fallback); starts the staged atlas + index loads */
export function setDecalLoader(load: (key: string) => Promise<THREE.Texture | null>): void {
  atlasLoader = load;
  void loadDecalIndex();
  if (decalMat) void loadAtlas();
}

function loadAtlas(): Promise<boolean> {
  if (!atlasLoader) return Promise.resolve(false);
  atlasLoad ??= (async () => {
    try {
      if (!getAssetManifest()) await loadAssetManifest();
      if (!hasAsset('decal.atlas')) return false;
      const t = await atlasLoader!('decal.atlas');
      if (!t || !atlasNode) return false;
      // the atlas counts v from its top row: compressed textures are never flipped; an image fallback must not be
      if (!(t as THREE.CompressedTexture).isCompressedTexture && t.flipY) { t.flipY = false; t.needsUpdate = true; }
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      atlasNode.value = t;
      decalAtlasSource = 'staged';
      return true;
    } catch { return false; }
  })();
  return atlasLoad;
}

/** the shared decal material (created once, kept across layouts) */
export function decalMaterial(): THREE.Material {
  if (decalMat) return decalMat;
  const fallback = fallbackAtlas();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tex: any = texture(fallback);
  atlasNode = tex as { value: THREE.Texture };
  const gain = uniform(1);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
  m.name = 'level.decal';
  // straight alpha, lifted per atlas row (measured on the staged atlas: leak and stain rows average 1-18 % opacity,
  // hands / footprints 12-18 %, signs and tape are solid) and clamped so nothing turns into a painted-on sheet
  const row = floor(uv().y.mul(4));
  const lift = row.lessThan(1).select(float(2.4), row.lessThan(2).select(float(1.6), row.lessThan(3).select(float(2.8), float(1))));
  m.colorNode = vec4(tex.rgb, tex.a.mul(lift).mul(gain).clamp(0, float(0.9)));
  m.transparent = true;
  m.depthWrite = false;
  m.alphaTest = 0.02;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -3;
  m.polygonOffsetUnits = -3;
  decalMat = m;
  void loadAtlas();
  return m;
}

// ---------------------------------------------------------------- procedural fallback atlas

/** a 512 px stand-in with the default cell layout (same uv rects as the staged atlas; top row first, no flip) */
function fallbackAtlas(): THREE.Texture {
  if (typeof document === 'undefined') {
    const t = new THREE.DataTexture(new Uint8Array([60, 50, 40, 90]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  if (g) {
    const rng = makeRng('decal-fallback', 'level:decal-atlas');
    DEFAULT_DECAL_CELLS.forEach((cell, i) => {
      const [u0, v0, u1, v1] = cell.uv;
      drawCell(g, i, u0 * S, v0 * S, (u1 - u0) * S, (v1 - v0) * S, rng);
    });
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

type G2 = CanvasRenderingContext2D;
function streaks(g: G2, x: number, y: number, w: number, h: number, rgb: string, n: number, a: number, rng: Rng): void {
  for (let i = 0; i < n; i++) {
    const sx = x + rng.next() * w, len = h * (0.3 + rng.next() * 0.68), lw = Math.max(1, w * (0.01 + rng.next() * 0.05));
    const top = y + rng.next() * h * 0.15;
    const gr = g.createLinearGradient(0, top, 0, top + len);
    gr.addColorStop(0, `rgba(${rgb},${a})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(sx - lw / 2, top, lw, len);
  }
}
function blob(g: G2, x: number, y: number, r: number, rgb: string, a: number): void {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, `rgba(${rgb},${a})`);
  gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
function ellipse(g: G2, x: number, y: number, rx: number, ry: number, rot = 0): void {
  g.beginPath(); g.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, Math.PI * 2); g.fill();
}
function sign(g: G2, x: number, y: number, w: number, h: number, kind: number): void {
  const m = w * 0.08;
  g.fillStyle = 'rgba(214,180,24,1)';
  g.fillRect(x + m, y + m, w - 2 * m, h - 2 * m);
  g.strokeStyle = 'rgba(20,18,12,1)';
  g.lineWidth = Math.max(2, w * 0.04);
  g.strokeRect(x + m * 1.6, y + m * 1.6, w - 3.2 * m, h - 3.2 * m);
  g.fillStyle = 'rgba(20,18,12,1)';
  // warning triangle
  const cx = x + w / 2, ty = y + h * 0.18, by = y + h * 0.58, hw = w * 0.24;
  g.beginPath(); g.moveTo(cx, ty); g.lineTo(cx + hw, by); g.lineTo(cx - hw, by); g.closePath(); g.fill();
  g.fillStyle = 'rgba(214,180,24,1)';
  g.fillRect(cx - w * 0.02, ty + h * 0.12, w * 0.04, h * 0.17);
  g.fillRect(cx - w * 0.02, by - h * 0.08, w * 0.04, h * 0.04);
  g.fillStyle = 'rgba(20,18,12,1)';
  g.font = `900 ${Math.round(h * 0.13)}px Impact, 'Arial Black', sans-serif`;
  g.textAlign = 'center';
  g.fillText(kind === 12 ? 'WET FLOOR' : kind === 13 ? '-18Â°C' : 'DANGER', cx, y + h * 0.8, w * 0.8);
}
function drawCell(g: G2, i: number, x: number, y: number, w: number, h: number, rng: Rng): void {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  switch (i) {
    case 0: // seep: a damp band with short drips
      for (let k = 0; k < 14; k++) blob(g, x + rng.next() * w, y + h * (0.15 + rng.next() * 0.3), h * (0.15 + rng.next() * 0.25), '46,44,30', 0.55);
      streaks(g, x, y + h * 0.3, w, h * 0.7, '46,44,30', 18, 0.5, rng);
      break;
    case 1: streaks(g, x + w * 0.3, y, w * 0.4, h, '120,104,70', 3, 0.85, rng); break;
    case 2: case 3: streaks(g, x, y, w, h, '44,38,30', 26, 0.5, rng); break;
    case 4: { // hand print
      g.fillStyle = 'rgba(70,60,50,0.75)';
      const cx = x + w / 2, cy = y + h * 0.62;
      ellipse(g, cx, cy, w * 0.17, h * 0.2);
      [-0.13, -0.045, 0.045, 0.13].forEach((dx, k) => ellipse(g, cx + dx * w, cy - h * (0.27 + (k === 1 || k === 2 ? 0.05 : 0)), w * 0.035, h * 0.12, dx * 0.6));
      ellipse(g, cx - w * 0.22, cy - h * 0.02, w * 0.035, h * 0.1, -0.9);
      break;
    }
    case 5: for (let k = 0; k < 9; k++) blob(g, x + w * (0.2 + rng.next() * 0.6), y + h * (0.2 + rng.next() * 0.6), w * (0.08 + rng.next() * 0.14), '45,45,40', 0.45); break;
    case 6: case 7: { // a trail of shoe prints, bottom to top
      g.fillStyle = 'rgba(56,44,32,0.7)';
      for (let k = 0; k < 6; k++) {
        const px = x + w * (k % 2 ? 0.68 : 0.32), py = y + h * (0.92 - k * 0.16);
        ellipse(g, px, py - h * 0.035, w * 0.17, h * 0.035);
        ellipse(g, px, py + h * 0.03, w * 0.13, h * 0.02);
      }
      break;
    }
    case 8: streaks(g, x, y, w, h, '120,64,26', 22, 0.55, rng); break;
    case 9: streaks(g, x, y, w, h, '26,34,22', 22, 0.55, rng); break;
    case 10: streaks(g, x, y, w, h, '40,58,26', 22, 0.5, rng); break;
    case 11: streaks(g, x, y, w, h, '34,30,28', 16, 0.35, rng); break;
    case 12: case 13: case 14: sign(g, x, y, w, h, i); break;
    case 15: { // hazard tape: diagonal stripes
      g.fillStyle = 'rgba(214,180,24,0.95)';
      g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(18,16,12,0.95)';
      for (let k = -2; k < h / w + 2; k += 2) {
        g.beginPath(); g.moveTo(x, y + k * w); g.lineTo(x + w, y + (k - 1) * w); g.lineTo(x + w, y + k * w); g.lineTo(x, y + (k + 1) * w); g.closePath(); g.fill();
      }
      break;
    }
    default: break;
  }
  g.restore();
}
