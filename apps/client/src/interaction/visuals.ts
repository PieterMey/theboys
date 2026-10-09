// Owner: track (b) Interaction / v1.2 G3 interaction-gear. Item meshes (world items, held view model, thrown
// bottles), lit glowstick markers (emissive only + a floor halo, no lights), revive rings at fresh bodies, the target
// glint, burning flares (+ FLARE_LIGHTS pooled unshadowed SpotLights created once at start-up, so the light-type set
// never changes mid-game), armed motion sensors (blinking LED), the v1.2 gear and field-note page models, crafting
// materials + dropped pouches (one global InstancedMesh per type: 7 draws at most, no shadows, compacted to the visible
// spaces), one pooled unshadowed flashbulb SpotLight, and the view model on render.layers.firstPerson when render has it.
// v1.3 (4b): a parked flare / flashbulb light is invisible once the warm-up is over (out of the batched per-pixel loop).
// v1.3 (F3): the noise lure (in flight; armed in the world with a blinking LED) and the field receiver, procedural on the
// shared item material (no new assets, no new pipeline).
// v1.2 item models (client flag itemModels; off = the v1.2.0 procedural models, boxes for salvage):
// - every item has a visual key: salvage by name (the safe's bearer bonds too), curios by name, otherwise its type;
// - real models where one exists: the Poly Haven GLBs staged as prop.item_* (matched by their manifest source) and the
//   shipped crowbar, medkit, gas mask and fuse box, loaded through the level's loader as soon as a layout arrives
//   (counted by propsPending, so the loading screen waits for them). They are PLAIN meshes sharing the template's
//   geometry and material: every InstancedMesh compiles its own program, plain meshes of one material layout share one.
//   Rest poses (lying flat, the crowbar on its side, the gas mask face up without its hose) apply before grounding;
// - everything else is an improved procedural model (lathe / extrude / tube / rounded-box parts) on the shared item
//   material, which samples one runtime canvas print atlas (labels, card faces, wraps, wood / metal / cloth swatches);
//   unknown salvage names fall back to a generic tier shape (a bundle, a sack, a drum), never a box;
// - drawer contents shrink to fit the open part (s = min(1, (w - 0.04)/sx, (travel - 0.02)/sz, hMax/sy)), sitting side by
//   side across its width; tiny salvage grows to a 0.10 m longest side; only models 0.30 m or more tall cast;
// - the warm-up re-arms with every new material layout (double-sided metal on / off, a shadow caster) when the item
//   templates arrive, so the first sight of an item adds no pipeline.
// v1.2 draw budget (gate P):
// - every procedural model is ONE merged geometry per pass: per-vertex colour, roughness / metalness and emissive radiance
//   are read by two shared node materials (opaque + clear), so a world item costs 1 draw (2 with glass) and every item,
//   LED, glint, revive ring and material instance shares one pipeline; a real model is 1 draw (one material per GLB);
// - only items of 0.3 m or more in height cast shadows, and every item mesh sits on render.layers.detail when render
//   provides it (every view draws it, only your own beam shadows it; layer 0 without it);
// - world items, lit glowsticks and burning flares in spaces the camera cannot see (level.visibleSpaces) are hidden, the
//   same test the material instances use, and the pooled flare lights only go to visible flares;
// - the pre-warm is one microscopic mesh per pipeline / material layout and ends after 3 drawn frames AND 0.5 s;
// - the per-frame path allocates nothing while nothing changes: structure re-syncs on the interaction state version,
//   the layout, a new visible-space set or a newly loaded item model.
import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec4 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MATERIAL_COLOR, itemDef } from '@dead-air/shared/interactables.ts';
import { CURIO_TYPE, MATERIAL_TYPES, POUCH_TYPE } from '@dead-air/shared/catalog.ts';
import { getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
import { containersOf } from '@dead-air/shared/procgen/containers.ts';
import type { ContainerInfo, ContainerPart } from '@dead-air/shared/procgen/containers.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { InteractionState, ItemState } from '@dead-air/shared/messages/interaction.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;
type V3 = [number, number, number];
const H = Math.PI / 2;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- the print atlas (v1.2 item models)

const ATLAS = 1024;
const APAD = 6;
/** a region of the atlas in uv space (v up, half a texel inside its edges) */
export interface ARect { u: number; v: number; w: number; h: number }
/** region name, width, height (canvas px); shelf-packed tallest first */
const REGIONS: [string, number, number][] = [
  ['white', 20, 20],
  ['brushed', 128, 128], ['grain', 128, 128], ['speckle', 128, 128], ['weave', 128, 128], ['leather', 128, 128], ['rust', 128, 128], ['paper', 128, 128],
  ['label.bottle', 256, 96], ['wrap.battery', 256, 64], ['wrap.cell', 128, 32], ['wrap.flare', 48, 256], ['label.airhorn', 160, 80],
  ['card.key', 256, 160], ['card.master', 256, 160], ['card.badge', 160, 224], ['bonds.cert', 256, 176], ['paper.typed', 128, 160],
  ['decal.typewriter', 128, 32], ['cross.medical', 128, 128], ['lid.tin', 128, 128], ['tag.dog', 128, 64], ['plate.deposit', 128, 64],
  ['label.cryo', 256, 96], ['panel.blade', 48, 256], ['dial.watch', 128, 128], ['page.notes', 128, 176], ['cover.manual', 128, 176],
  ['plaque.employee', 128, 96], ['label.wax', 128, 48], ['face.cassette', 128, 80], ['face.dashcam', 128, 80], ['pcb', 128, 128],
  ['dial.radio', 128, 64], ['grill', 64, 64], ['label.hazard', 96, 64], ['face.snowglobe', 96, 32],
];
/** content rects in canvas pixels: x, y (from the top-left), w, h */
const ATLAS_PX = new Map<string, [number, number, number, number]>();
{
  const order = REGIONS.map((r, i) => ({ r, i })).sort((a, b) => b.r[2] - a.r[2] || a.i - b.i);
  let x = 0, y = 0, sh = 0;
  for (const { r: [name, w, h] } of order) {
    const cw = w + APAD * 2, ch = h + APAD * 2;
    if (x + cw > ATLAS) { x = 0; y += sh; sh = 0; }
    ATLAS_PX.set(name, [x + APAD, y + APAD, w, h]);
    x += cw;
    sh = Math.max(sh, ch);
  }
}
/** uv rect of an atlas region (the white region for an unknown name); CanvasTexture flipY: canvas top = v 1 */
export function atlasRect(name: string): ARect {
  const [x, y, w, h] = ATLAS_PX.get(name) ?? ATLAS_PX.get('white')!;
  return { u: (x + 1) / ATLAS, v: 1 - (y + h - 1) / ATLAS, w: (w - 2) / ATLAS, h: (h - 2) / ATLAS };
}
const WHITE_UV = ((): [number, number] => {
  const [x, y, w, h] = ATLAS_PX.get('white')!;
  return [(x + w / 2) / ATLAS, 1 - (y + h / 2) / ATLAS];
})();

/** visual-only deterministic noise for the swatches (never gameplay: no makeRng stream needed, never Math.random) */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** smooth value noise over a gw x gh lattice; u, v in 0..1 */
function valueNoise(rnd: () => number, gw: number, gh: number): (u: number, v: number) => number {
  const lat = new Float32Array((gw + 1) * (gh + 1));
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  return (u, v) => {
    const x = Math.min(gw - 1e-6, Math.max(0, u * gw)), y = Math.min(gh - 1e-6, Math.max(0, v * gh));
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lat[j * (gw + 1) + i]!, b = lat[j * (gw + 1) + i + 1]!, c = lat[(j + 1) * (gw + 1) + i]!, d = lat[(j + 1) * (gw + 1) + i + 1]!;
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
type RGB = [number, number, number];
function pixels(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, f: (u: number, v: number, i: number, j: number) => RGB): void {
  const img = c.createImageData(w, h);
  const d = img.data;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const [r, gg, b] = f(i / w, j / h, i, j);
    const k = (j * w + i) * 4;
    d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 255;
  }
  c.putImageData(img, x, y);
}
const grey = (v: number): RGB => [v, v, v];
function rrect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function txt(c: CanvasRenderingContext2D, s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'center'): void {
  c.font = font;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}
function bars(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rnd: () => number): void {
  c.fillStyle = '#151515';
  for (let px = x; px < x + w;) {
    const bw = 1 + Math.floor(rnd() * 3);
    if (rnd() > 0.35) c.fillRect(px, y, bw, h);
    px += bw + 1;
  }
}
/** padding colour per region (mip bleed stays the region's own colour) */
const ATLAS_BG: Record<string, string> = {
  brushed: '#dcdcdc', grain: '#c4c4c4', speckle: '#cdcdcd', weave: '#cfcfcf', leather: '#d6d6d6', rust: '#8a5a3c', paper: '#e6dcc2',
  'label.bottle': '#e3d6b0', 'wrap.battery': '#c9a332', 'wrap.cell': '#3f9a3a', 'wrap.flare': '#c8241b', 'label.airhorn': '#d4362b',
  'card.key': '#f2c230', 'card.master': '#ff8f3a', 'card.badge': '#e8eaec', 'bonds.cert': '#e9e4cf', 'paper.typed': '#f2efe6',
  'decal.typewriter': '#141414', 'cross.medical': '#f4f4f2', 'lid.tin': '#8a2a22', 'tag.dog': '#b9bec3', 'plate.deposit': '#c9a24a',
  'label.cryo': '#eef2f5', 'panel.blade': '#2b2f33', 'dial.watch': '#f3efe4', 'page.notes': '#e8dfc6', 'cover.manual': '#e2b52a',
  'plaque.employee': '#c9a24a', 'label.wax': '#a8865a', 'face.cassette': '#1a1a1a', 'face.dashcam': '#1a1a1a', pcb: '#1f5d34',
  'dial.radio': '#3b4030', grill: '#202326', 'label.hazard': '#f2c230', 'face.snowglobe': '#141414',
};
type Painter = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rnd: () => number) => void;
const PAINT: Record<string, Painter> = {
  white: (c, x, y, w, h) => { c.fillStyle = '#ffffff'; c.fillRect(x, y, w, h); },
  // ---- greyscale swatches (multiplied by the part colour)
  brushed: (c, x, y, w, h, rnd) => {
    const n = valueNoise(rnd, 3, 48), m = valueNoise(rnd, 2, 6);
    pixels(c, x, y, w, h, (u, v) => grey(206 + 30 * n(u, v) + 14 * m(u, v) + (rnd() - 0.5) * 12));
  },
  grain: (c, x, y, w, h, rnd) => {
    const n = valueNoise(rnd, 4, 5), f = valueNoise(rnd, 2, 70);
    pixels(c, x, y, w, h, (u, v) => {
      const t = v * 9 + n(u, v) * 2.4;
      const ring = Math.abs((t - Math.floor(t)) - 0.5) * 2;
      return grey(138 + 92 * Math.pow(ring, 0.55) + 24 * (f(u, v) - 0.5) + (rnd() - 0.5) * 8);
    });
  },
  speckle: (c, x, y, w, h, rnd) => {
    const a = valueNoise(rnd, 6, 6), b = valueNoise(rnd, 18, 18), d = valueNoise(rnd, 52, 52);
    pixels(c, x, y, w, h, (u, v) => grey(140 + 112 * (0.5 * a(u, v) + 0.3 * b(u, v) + 0.2 * d(u, v)) - (rnd() < 0.035 ? 55 : 0)));
  },
  weave: (c, x, y, w, h, rnd) => {
    const n = valueNoise(rnd, 8, 8);
    pixels(c, x, y, w, h, (u, v, i, j) => {
      const over = (Math.floor(i / 4) + Math.floor(j / 4)) % 2 === 0;
      const f = over ? (j % 4) / 3 : (i % 4) / 3;
      return grey(170 + 64 * (1 - Math.abs(f - 0.5) * 1.1) + 32 * (n(u, v) - 0.5) + (rnd() - 0.5) * 18);
    });
  },
  leather: (c, x, y, w, h, rnd) => {
    const a = valueNoise(rnd, 26, 26), b = valueNoise(rnd, 5, 5);
    pixels(c, x, y, w, h, (u, v) => { const p = a(u, v); return grey(178 + 58 * Math.min(1, p / 0.55) + 26 * (b(u, v) - 0.5) - (p < 0.18 ? 30 : 0)); });
  },
  // ---- coloured swatches (used with a white part colour)
  rust: (c, x, y, w, h, rnd) => {
    const a = valueNoise(rnd, 5, 5), b = valueNoise(rnd, 16, 16), d = valueNoise(rnd, 44, 44);
    pixels(c, x, y, w, h, (u, v) => {
      const k = 0.55 * a(u, v) + 0.3 * b(u, v) + 0.15 * d(u, v);
      const r = Math.min(1, Math.max(0, (k - 0.36) / 0.24));
      const base = 132 + 34 * d(u, v);
      return [base * (1 - r) + (128 + 52 * b(u, v)) * r, base * (1 - r) + (62 + 26 * b(u, v)) * r, base * (1 - r) + (30 + 16 * d(u, v)) * r];
    });
  },
  paper: (c, x, y, w, h, rnd) => {
    const a = valueNoise(rnd, 4, 4), b = valueNoise(rnd, 22, 22);
    pixels(c, x, y, w, h, (u, v) => { const k = 0.9 + 0.07 * a(u, v) + 0.03 * b(u, v); return [238 * k, 228 * k, 202 * k]; });
  },
  // ---- prints
  'label.bottle': (c, x, y, w, h) => {
    c.fillStyle = '#e3d6b0'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#5a3b1c'; c.lineWidth = 3; c.strokeRect(x + 7, y + 7, w - 14, h - 14);
    c.lineWidth = 1; c.strokeRect(x + 12, y + 12, w - 24, h - 24);
    txt(c, 'DISTILLED IN BOND', x + w / 2, y + 22, '700 10px serif', '#5a3b1c');
    txt(c, 'RYE WHISKEY', x + w / 2, y + 46, '700 27px serif', '#3a2410');
    txt(c, 'AGED 8 YEARS  ·  90 PROOF', x + w / 2, y + 72, '700 11px serif', '#5a3b1c');
  },
  'wrap.battery': (c, x, y, w, h) => {
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#e6c24a'); g.addColorStop(0.5, '#c99f2c'); g.addColorStop(1, '#a8841e');
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.fillStyle = '#141414'; c.fillRect(x, y + 20, w, 26);
    txt(c, 'HEAVY DUTY  ·  D  ·  1.5V', x + w / 2, y + 33, '800 14px sans-serif', '#e6c24a');
    txt(c, '+', x + 20, y + 10, '800 14px sans-serif', '#141414');
    txt(c, 'VOLTEK', x + w / 2, y + 56, '800 11px sans-serif', '#3a2c08');
  },
  'wrap.cell': (c, x, y, w, h) => {
    c.fillStyle = '#3f9a3a'; c.fillRect(x, y, w, h);
    c.fillStyle = '#151515'; c.fillRect(x, y, 24, h);
    txt(c, 'AA  1.5V', x + w / 2 + 10, y + h / 2, '800 13px sans-serif', '#f2f2f2');
  },
  'wrap.flare': (c, x, y, w, h) => {
    c.fillStyle = '#c8241b'; c.fillRect(x, y, w, h);
    c.fillStyle = '#f2f2f2'; c.fillRect(x, y + 10, w, 4); c.fillRect(x, y + h - 14, w, 4);
    c.save();
    c.translate(x + w / 2, y + h / 2);
    c.rotate(-Math.PI / 2);
    txt(c, 'ROAD FLARE · 30 MIN', 0, -6, '800 15px sans-serif', '#ffffff');
    txt(c, 'STRIKE CAP · KEEP DRY', 0, 12, '700 10px sans-serif', '#ffd8d0');
    c.restore();
  },
  'label.airhorn': (c, x, y, w, h) => {
    c.fillStyle = '#d4362b'; c.fillRect(x, y, w, h);
    c.fillStyle = '#f4f1e8'; c.fillRect(x, y + 16, w, 34);
    txt(c, 'AIR HORN', x + w / 2, y + 34, '900 24px sans-serif', '#141414');
    txt(c, 'MARINE · 120 dB', x + w / 2, y + 64, '700 11px sans-serif', '#ffffff');
  },
  'card.key': (c, x, y, w, h, rnd) => {
    c.fillStyle = '#f2c230'; c.fillRect(x, y, w, h);
    c.fillStyle = '#1b1b1b'; c.fillRect(x, y + 14, w, 18);
    txt(c, 'SECURITY', x + 16, y + 52, '900 26px sans-serif', '#1b1b1b', 'left');
    txt(c, 'AUTHORISED PERSONNEL ONLY', x + 16, y + 76, '700 10px sans-serif', '#4a3a08', 'left');
    c.fillStyle = '#d8b04a'; rrect(c, x + 18, y + 94, 44, 34, 5); c.fill();
    c.strokeStyle = '#8a6a1a'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x + 18, y + 111); c.lineTo(x + 62, y + 111); c.moveTo(x + 40, y + 94); c.lineTo(x + 40, y + 128); c.stroke();
    bars(c, x + 132, y + 104, 104, 32, rnd);
  },
  'card.master': (c, x, y, w, h, rnd) => {
    c.fillStyle = '#ff8f3a'; c.fillRect(x, y, w, h);
    c.fillStyle = '#1b1b1b'; c.fillRect(x, y + 14, w, 18);
    txt(c, 'MASTER', x + 16, y + 54, '900 32px sans-serif', '#2a1200', 'left');
    txt(c, 'FACILITIES · ALL ACCESS', x + 16, y + 80, '700 11px sans-serif', '#4a2200', 'left');
    c.fillStyle = '#e0b84e'; rrect(c, x + 18, y + 96, 44, 34, 5); c.fill();
    c.strokeStyle = '#8a6a1a'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x + 18, y + 113); c.lineTo(x + 62, y + 113); c.moveTo(x + 40, y + 96); c.lineTo(x + 40, y + 130); c.stroke();
    txt(c, 'M', x + 196, y + 112, '900 46px sans-serif', '#2a1200');
    bars(c, x + 90, y + 136, 90, 14, rnd);
  },
  'card.badge': (c, x, y, w, h, rnd) => {
    c.fillStyle = '#e8eaec'; c.fillRect(x, y, w, h);
    c.fillStyle = '#3f7fb3'; c.fillRect(x, y, w, 48);
    c.fillStyle = '#e8eaec'; rrect(c, x + w / 2 - 18, y + 8, 36, 8, 4); c.fill();
    txt(c, 'CONTRACTOR', x + w / 2, y + 32, '900 17px sans-serif', '#ffffff');
    c.fillStyle = '#9aa6b0'; c.fillRect(x + 40, y + 60, 80, 92);
    c.fillStyle = '#5d6872'; c.beginPath(); c.arc(x + 80, y + 92, 18, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(x + 80, y + 150, 34, 28, 0, Math.PI, TAU); c.fill();
    c.fillStyle = '#30363c'; c.fillRect(x + 24, y + 166, 112, 9); c.fillRect(x + 40, y + 182, 80, 7);
    bars(c, x + 24, y + 198, 112, 18, rnd);
  },
  'bonds.cert': (c, x, y, w, h) => {
    c.fillStyle = '#e9e4cf'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#2f6b4a';
    for (let k = 0; k < 4; k++) { c.lineWidth = k === 0 ? 3 : 1; c.strokeRect(x + 6 + k * 3, y + 6 + k * 3, w - 12 - k * 6, h - 12 - k * 6); }
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i <= 60; i++) { const px = x + 22 + (i / 60) * (w - 44); const py = y + 30 + Math.sin(i * 0.9) * 3; if (i === 0) c.moveTo(px, py); else c.lineTo(px, py); }
    c.stroke();
    txt(c, 'BEARER BOND', x + w / 2, y + 50, '700 24px serif', '#1e4a33');
    txt(c, 'THE COMPANY PROMISES TO PAY THE BEARER', x + w / 2, y + 74, '700 9px serif', '#2f6b4a');
    txt(c, 'ONE THOUSAND DOLLARS', x + w / 2, y + 88, '700 12px serif', '#1e4a33');
    txt(c, '$1000', x + 26, y + 130, '700 26px serif', '#1e4a33', 'left');
    c.fillStyle = '#9a2a22'; c.beginPath(); c.arc(x + w - 46, y + 128, 20, 0, TAU); c.fill();
    c.strokeStyle = '#e9d0a0'; c.lineWidth = 2; c.beginPath(); c.arc(x + w - 46, y + 128, 14, 0, TAU); c.stroke();
    txt(c, 'No. 0451-7', x + w / 2, y + h - 22, '700 10px monospace', '#2f6b4a');
  },
  'paper.typed': (c, x, y, w, h) => {
    c.fillStyle = '#f2efe6'; c.fillRect(x, y, w, h);
    const lines = ['MEMO  -  ALL CREWS', '', 'RE: VAN 3', 'Do not open the east', 'wing after dark. The', 'hum is not the', 'generator. If the', 'lights die, do not', 'run. It hears you.'];
    lines.forEach((s, i) => txt(c, s, x + 10, y + 16 + i * 15, '700 10px monospace', '#2a2a2a', 'left'));
  },
  'decal.typewriter': (c, x, y, w, h) => {
    c.fillStyle = '#141414'; c.fillRect(x, y, w, h);
    txt(c, 'VANGUARD', x + w / 2, y + h / 2 + 1, 'italic 700 20px serif', '#d4af37');
  },
  'cross.medical': (c, x, y, w, h) => {
    c.fillStyle = '#f4f4f2'; c.fillRect(x, y, w, h);
    c.fillStyle = '#c0201b';
    c.fillRect(x + w / 2 - 15, y + 20, 30, h - 40);
    c.fillRect(x + 20, y + h / 2 - 15, w - 40, 30);
    c.strokeStyle = '#c0201b'; c.lineWidth = 4; c.beginPath(); c.arc(x + w / 2, y + h / 2, w / 2 - 5, 0, TAU); c.stroke();
  },
  'lid.tin': (c, x, y, w, h) => {
    const cx = x + w / 2, cy = y + h / 2;
    c.fillStyle = '#8a2a22'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#d4af37'; c.lineWidth = 5; c.beginPath(); c.arc(cx, cy, w / 2 - 6, 0, TAU); c.stroke();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      c.fillStyle = i % 2 ? '#e8d7a8' : '#5f8a4a';
      c.beginPath(); c.ellipse(cx + Math.cos(a) * 42, cy + Math.sin(a) * 42, 7, 4, a, 0, TAU); c.fill();
    }
    txt(c, 'BUTTONS', cx, cy - 4, '700 18px serif', '#f2e2b8');
    txt(c, 'Haberdashery', cx, cy + 14, 'italic 700 10px serif', '#e8d7a8');
  },
  'tag.dog': (c, x, y, w, h) => {
    c.fillStyle = '#b9bec3'; c.fillRect(x, y, w, h);
    const lines = ['MORROW J T', '0451 2211', 'O POS', 'NO PREF'];
    lines.forEach((s, i) => { txt(c, s, x + 13, y + 13 + i * 13, '800 11px monospace', '#eef1f3', 'left'); txt(c, s, x + 12, y + 12 + i * 13, '800 11px monospace', '#4a4f53', 'left'); });
  },
  'plate.deposit': (c, x, y, w, h) => {
    c.fillStyle = '#c9a24a'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#6a4e18'; c.lineWidth = 3; c.strokeRect(x + 4, y + 4, w - 8, h - 8);
    txt(c, 'No 1127', x + w / 2, y + h / 2 - 6, '700 22px serif', '#3a2a10');
    for (const kx of [x + 28, x + w - 28]) { c.fillStyle = '#2a1e0a'; c.beginPath(); c.arc(kx, y + 46, 4, 0, TAU); c.fill(); c.fillRect(kx - 1.5, y + 46, 3, 8); }
  },
  'label.cryo': (c, x, y, w, h) => {
    c.fillStyle = '#eef2f5'; c.fillRect(x, y, w, h);
    c.fillStyle = '#2f5d8a'; c.fillRect(x, y, w, 34);
    txt(c, 'LN2  ·  CRYOGENIC', x + w / 2 - 20, y + 18, '900 19px sans-serif', '#ffffff');
    txt(c, '-196 °C  ·  DO NOT SEAL', x + w / 2 - 20, y + 52, '800 13px sans-serif', '#1e3c5a');
    txt(c, 'VENTED DEWAR  ·  35 L', x + w / 2 - 20, y + 72, '700 11px sans-serif', '#3a5a7a');
    c.save(); c.translate(x + w - 34, y + 60); c.rotate(Math.PI / 4);
    c.fillStyle = '#2f5d8a'; c.fillRect(-16, -16, 32, 32); c.fillStyle = '#ffffff'; c.fillRect(-11, -11, 22, 22);
    c.restore();
    txt(c, '2', x + w - 34, y + 61, '900 14px sans-serif', '#2f5d8a');
  },
  'panel.blade': (c, x, y, w, h, rnd) => {
    c.fillStyle = '#2b2f33'; c.fillRect(x, y, w, h);
    c.fillStyle = '#0d0f10';
    for (let j = 0; j < 9; j++) for (let i = 0; i < 4; i++) c.fillRect(x + 6 + i * 10, y + 10 + j * 7, 6, 3);
    for (let k = 0; k < 2; k++) { c.strokeStyle = '#7a8086'; c.lineWidth = 2; c.strokeRect(x + 6, y + 82 + k * 50, w - 12, 42); c.fillStyle = '#1a1d20'; c.fillRect(x + 8, y + 84 + k * 50, w - 16, 38); }
    const leds = ['#3ad15a', '#3ad15a', '#e0a020', '#3ad15a'];
    leds.forEach((col, i) => { c.fillStyle = rnd() > 0.25 ? col : '#2a3a2c'; c.beginPath(); c.arc(x + 10 + i * 9, y + 192, 2.5, 0, TAU); c.fill(); });
    c.fillStyle = '#9aa0a6'; c.fillRect(x + w / 2 - 4, y + 206, 8, 40);
    txt(c, '04', x + w / 2, y + 186, '800 9px monospace', '#c8ced4');
  },
  'dial.watch': (c, x, y, w, h) => {
    const cx = x + w / 2, cy = y + h / 2;
    c.fillStyle = '#f3efe4'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#2a2a2a';
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU, r0 = i % 5 ? 54 : 48;
      c.lineWidth = i % 5 ? 1 : 3;
      c.beginPath(); c.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0); c.lineTo(cx + Math.sin(a) * 58, cy - Math.cos(a) * 58); c.stroke();
    }
    [['XII', 0], ['III', 3], ['VI', 6], ['IX', 9]].forEach(([s, k]) => { const a = (Number(k) / 12) * TAU; txt(c, String(s), cx + Math.sin(a) * 38, cy - Math.cos(a) * 38, '700 13px serif', '#1e1e1e'); });
    c.strokeStyle = '#1e1e1e'; c.lineWidth = 3; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + 22, cy - 14); c.stroke();
    c.lineWidth = 2; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx - 8, cy - 40); c.stroke();
  },
  'page.notes': (c, x, y, w, h) => {
    c.fillStyle = '#e8dfc6'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#a9b6c8'; c.lineWidth = 1;
    for (let j = 0; j < 11; j++) { c.beginPath(); c.moveTo(x + 6, y + 26 + j * 14); c.lineTo(x + w - 6, y + 26 + j * 14); c.stroke(); }
    c.strokeStyle = '#c87a7a'; c.beginPath(); c.moveTo(x + 18, y); c.lineTo(x + 18, y + h); c.stroke();
    const lines = ['It hums when', 'the lights die.', 'Do not run.', 'It hears steps,', 'not breath.', 'Count to ten', 'in the dark', 'and it moves', 'on. Mostly.'];
    lines.forEach((s, i) => txt(c, s, x + 22, y + 21 + i * 14, 'italic 700 11px serif', '#2b2a48', 'left'));
  },
  'cover.manual': (c, x, y, w, h) => {
    c.fillStyle = '#e2b52a'; c.fillRect(x, y, w, h);
    c.fillStyle = '#141414';
    for (let i = -h; i < w; i += 16) { c.beginPath(); c.moveTo(x + i, y + h); c.lineTo(x + i + 8, y + h); c.lineTo(x + i + 8 + 18, y + h - 18); c.lineTo(x + i + 18, y + h - 18); c.fill(); }
    txt(c, 'SAFETY', x + w / 2, y + 30, '900 22px sans-serif', '#141414');
    txt(c, 'MANUAL', x + w / 2, y + 54, '900 22px sans-serif', '#141414');
    txt(c, 'COMPANY PROPERTY', x + w / 2, y + 76, '700 9px sans-serif', '#3a2c08');
    c.fillStyle = '#141414'; c.beginPath(); c.arc(x + w / 2, y + 108, 16, Math.PI, TAU); c.fill(); c.fillRect(x + w / 2 - 22, y + 106, 44, 5);
    c.strokeStyle = '#1d3a8a'; c.lineWidth = 2; c.beginPath(); c.moveTo(x + 20, y + 140); c.bezierCurveTo(x + 40, y + 120, x + 50, y + 156, x + 66, y + 136); c.bezierCurveTo(x + 76, y + 126, x + 90, y + 150, x + 108, y + 132); c.stroke();
  },
  'plaque.employee': (c, x, y, w, h) => {
    c.fillStyle = '#c9a24a'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#6a4e18'; c.lineWidth = 2; c.strokeRect(x + 5, y + 5, w - 10, h - 10);
    txt(c, 'EMPLOYEE', x + w / 2, y + 22, '800 14px serif', '#3a2a10');
    txt(c, 'OF THE MONTH', x + w / 2, y + 40, '800 12px serif', '#3a2a10');
    txt(c, '★', x + w / 2, y + 62, '900 22px serif', '#5a4012');
    txt(c, 'OCTOBER', x + w / 2, y + 82, '700 11px serif', '#3a2a10');
  },
  'label.wax': (c, x, y, w, h) => {
    c.fillStyle = '#a8865a'; c.fillRect(x, y, w, h);
    c.fillStyle = '#e9dfc4'; c.fillRect(x + 8, y + 6, w - 16, h - 12);
    txt(c, 'PHONO RECORD', x + w / 2, y + 18, '800 12px serif', '#3a2410');
    txt(c, 'Cylinder No. 13', x + w / 2, y + 32, 'italic 700 10px serif', '#5a3b1c');
  },
  'face.cassette': (c, x, y, w, h) => cassetteFace(c, x, y, w, h, 'C-60', '#3b3a52', 'SIDE A'),
  'face.dashcam': (c, x, y, w, h) => cassetteFace(c, x, y, w, h, 'DASHCAM VAN 3', '#b0261c', 'DO NOT ERASE'),
  pcb: (c, x, y, w, h, rnd) => {
    c.fillStyle = '#1f5d34'; c.fillRect(x, y, w, h);
    c.strokeStyle = '#c8a24a'; c.lineWidth = 1.5;
    for (let k = 0; k < 26; k++) {
      let px = x + 6 + rnd() * (w - 12), py = y + 6 + rnd() * (h - 12);
      c.beginPath(); c.moveTo(px, py);
      for (let s = 0; s < 3; s++) { if (rnd() > 0.5) px = Math.min(x + w - 4, Math.max(x + 4, px + (rnd() - 0.5) * 60)); else py = Math.min(y + h - 4, Math.max(y + 4, py + (rnd() - 0.5) * 60)); c.lineTo(px, py); }
      c.stroke();
      c.fillStyle = '#d8b45a'; c.beginPath(); c.arc(px, py, 2.4, 0, TAU); c.fill();
    }
    txt(c, 'REV B', x + w - 26, y + h - 12, '700 9px monospace', '#e8f0e8');
  },
  'dial.radio': (c, x, y, w, h) => {
    c.fillStyle = '#3b4030'; c.fillRect(x, y, w, h);
    c.fillStyle = '#e8dcb0'; c.fillRect(x + 14, y + 8, w - 28, 24);
    c.strokeStyle = '#2a2a2a'; c.lineWidth = 1;
    for (let i = 0; i <= 20; i++) { const px = x + 18 + i * ((w - 36) / 20); c.beginPath(); c.moveTo(px, y + 10); c.lineTo(px, y + (i % 5 ? 16 : 20)); c.stroke(); }
    ['2', '4', '6', '8'].forEach((s, i) => txt(c, s, x + 18 + (i + 1) * ((w - 36) / 5), y + 26, '700 8px sans-serif', '#2a2a2a'));
    c.fillStyle = '#b0261c'; c.fillRect(x + 52, y + 8, 2, 24);
    txt(c, 'TRANSCEIVER', x + w / 2, y + 46, '800 10px sans-serif', '#d8d2b0');
  },
  grill: (c, x, y, w, h) => {
    c.fillStyle = '#202326'; c.fillRect(x, y, w, h);
    c.fillStyle = '#060707';
    for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) { c.beginPath(); c.arc(x + 6 + i * 8.5, y + 6 + j * 8.5, 2.3, 0, TAU); c.fill(); }
  },
  'label.hazard': (c, x, y, w, h) => {
    c.fillStyle = '#f2c230'; c.fillRect(x, y, w, h);
    c.fillStyle = '#141414'; c.beginPath(); c.moveTo(x + 22, y + 8); c.lineTo(x + 38, y + 38); c.lineTo(x + 6, y + 38); c.closePath(); c.fill();
    c.fillStyle = '#f2c230'; c.beginPath(); c.moveTo(x + 24, y + 16); c.lineTo(x + 18, y + 27); c.lineTo(x + 23, y + 27); c.lineTo(x + 20, y + 35); c.lineTo(x + 28, y + 23); c.lineTo(x + 23, y + 23); c.closePath(); c.fill();
    txt(c, 'DANGER', x + 66, y + 18, '900 13px sans-serif', '#141414');
    txt(c, 'HIGH', x + 66, y + 32, '800 10px sans-serif', '#141414');
    txt(c, 'VOLTAGE', x + w / 2, y + 52, '900 13px sans-serif', '#141414');
  },
  'face.snowglobe': (c, x, y, w, h) => { c.fillStyle = '#141414'; c.fillRect(x, y, w, h); txt(c, 'VAN 7', x + w / 2, y + h / 2 + 1, '800 18px serif', '#d4af37'); },
};
function cassetteFace(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string, ink: string, sub: string): void {
  c.fillStyle = '#1a1a1a'; c.fillRect(x, y, w, h);
  c.fillStyle = '#e8e2c8'; rrect(c, x + 8, y + 6, w - 16, h - 22, 4); c.fill();
  c.fillStyle = '#c8402a'; c.fillRect(x + 8, y + 10, w - 16, 3);
  txt(c, title, x + w / 2, y + 22, '800 12px sans-serif', ink);
  c.fillStyle = '#2a2a2a'; rrect(c, x + 30, y + 32, w - 60, 20, 8); c.fill();
  for (const rx of [x + 44, x + w - 44]) { c.fillStyle = '#f2f2f2'; c.beginPath(); c.arc(rx, y + 42, 7, 0, TAU); c.fill(); c.fillStyle = '#2a2a2a'; c.beginPath(); c.arc(rx, y + 42, 3, 0, TAU); c.fill(); }
  txt(c, sub, x + w / 2, y + h - 8, '700 8px sans-serif', '#c8c8c8');
}

let atlasTex: THREE.Texture | null = null;
/** the print atlas, drawn once on a canvas (a 1x1 white texture where nothing can be drawn) */
function atlasTexture(): THREE.Texture {
  if (atlasTex) return atlasTex;
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = ATLAS;
    const c = canvas.getContext('2d');
    if (c) {
      c.fillStyle = '#808080';
      c.fillRect(0, 0, ATLAS, ATLAS);
      for (const [name, [x, y, w, h]] of ATLAS_PX) {
        c.fillStyle = ATLAS_BG[name] ?? '#ffffff';
        c.fillRect(x - APAD, y - APAD, w + APAD * 2, h + APAD * 2);
        c.save();
        c.beginPath();
        c.rect(x, y, w, h);
        c.clip();
        try { PAINT[name]?.(c, x, y, w, h, mulberry(hashStr(name))); } catch { /* a stub canvas (Node tests): keep the fill */ }
        c.restore();
      }
    }
  } catch {
    canvas = null;
  }
  const t: THREE.Texture = canvas ? new THREE.CanvasTexture(canvas) : new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  atlasTex = t;
  return t;
}

// ---------------------------------------------------------------- surfaces + the shared materials

/** one surface of a model: colour (sRGB hex), roughness, metalness, emissive colour x intensity, opacity (< 1 = clear
 *  pass) and an atlas region (prints / swatches: the part's own uv 0..1 maps onto it; none = the white texel) */
export interface Surf { color: number; rough?: number; metal?: number; emissive?: number; ei?: number; opacity?: number; tex?: string }

const DARK: Surf = { color: 0x222222, rough: 0.6 };
const STEEL: Surf = { color: 0x8a8f94, rough: 0.35, metal: 0.9 };
/** a print on a white part (the atlas carries the colours) */
const pr = (tex: string, rough = 0.6, metal = 0): Surf => ({ color: 0xffffff, rough, metal, tex });
const SF: Record<string, Surf> = {
  brass: { color: 0xb8924f, rough: 0.34, metal: 1, tex: 'brushed' },
  gold: { color: 0xd8b45a, rough: 0.22, metal: 1 },
  steel: { color: 0xa2a8ae, rough: 0.34, metal: 0.9, tex: 'brushed' },
  dsteel: { color: 0x3b3f43, rough: 0.45, metal: 0.7, tex: 'brushed' },
  chrome: { color: 0xdde2e6, rough: 0.14, metal: 1 },
  copper: { color: 0xc07a3c, rough: 0.3, metal: 1, tex: 'brushed' },
  black: { color: 0x161616, rough: 0.35, metal: 0.1 },
  rubber: { color: 0x1c1c1c, rough: 0.85 },
  leather: { color: 0x5a3a24, rough: 0.72, tex: 'leather' },
  walnut: { color: 0x5a3822, rough: 0.5, tex: 'grain' },
  oak: { color: 0x9a7650, rough: 0.55, tex: 'grain' },
  canvas: { color: 0xb3a27e, rough: 0.95, tex: 'weave' },
  burlap: { color: 0xa08a5c, rough: 0.97, tex: 'weave' },
  glass: { color: 0xdfe9ee, rough: 0.05, metal: 0.1, opacity: 0.28 },
  darkGlass: { color: 0x26343a, rough: 0.06, metal: 0.2 },
  velvet: { color: 0x7a1424, rough: 0.95, tex: 'leather' },
  porcelain: { color: 0xf1e8de, rough: 0.25 },
};

/** v1.2.0 behaviour: world items of 0.3 m or more (longest side) cast shadows; v1.2 item models decide by height
 *  (castsFor). The bottle (a 7 cm cylinder, 0.31 m tall) and the loot boxes under 0.3 m stay off. */
export const ITEM_CASTS: ReadonlySet<string> = new Set(['crowbar', 'medkit', 'loot.heavy', 'loot.idol']);
/** v1.2 item models: a model this tall (m) or taller casts */
export const CAST_H = 0.3;
/** v1.2 item models: tiny salvage grows to this longest side (m): it reads in the dark */
export const MIN_SALVAGE = 0.1;

let solidMat: THREE.MeshStandardNodeMaterial | null = null;
let clearMat: THREE.MeshStandardNodeMaterial | null = null;
/** The two item materials: per-vertex colour ('color': rgb, rgba on the clear pass) x the print atlas (uv), roughness +
 *  metalness ('ixs') and emissive radiance ('ixe', linear colour x intensity). Every procedural model, LED, glint,
 *  revive ring and material instance uses one of them, so they all share one pipeline (per pass). */
export function itemMaterial(clear: boolean): THREE.MeshStandardNodeMaterial {
  const have = clear ? clearMat : solidMat;
  if (have) return have;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  m.name = clear ? 'ix.items.clear' : 'ix.items';
  const print = (texture(atlasTexture(), uv()) as AnyNode).rgb;
  if (clear) {
    const c4 = attribute('color', 'vec4') as AnyNode;
    m.colorNode = vec4(c4.rgb.mul(print), c4.a) as AnyNode;
  } else m.colorNode = (attribute('color', 'vec3') as AnyNode).mul(print);
  const s = attribute('ixs', 'vec2') as AnyNode;
  m.roughnessNode = s.x;
  m.metalnessNode = s.y;
  m.emissiveNode = attribute('ixe', 'vec3') as AnyNode;
  if (clear) {
    m.transparent = true;
    m.depthWrite = false;
    clearMat = m;
  } else solidMat = m;
  return m;
}

const _col = new THREE.Color();
/** writes the surface as vertex attributes (colour in the linear working space, like a material colour) and maps the
 *  part's uv into its atlas region (or the white texel) */
function paint(gm: THREE.BufferGeometry, s: Surf, clear: boolean): THREE.BufferGeometry {
  const n = gm.attributes.position!.count;
  const k = clear ? 4 : 3;
  const col = new Float32Array(n * k), sur = new Float32Array(n * 2), emi = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
  _col.set(s.color);
  const r = _col.r, gr = _col.g, b = _col.b, a = s.opacity ?? 1;
  let er = 0, eg = 0, eb = 0;
  if (s.emissive !== undefined) {
    _col.set(s.emissive);
    const ei = s.ei ?? 1;
    er = _col.r * ei; eg = _col.g * ei; eb = _col.b * ei;
  }
  const rough = s.rough ?? 0.6, metal = s.metal ?? 0;
  const src = gm.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const rect = s.tex ? atlasRect(s.tex) : null;
  for (let i = 0; i < n; i++) {
    col[i * k] = r; col[i * k + 1] = gr; col[i * k + 2] = b;
    if (clear) col[i * k + 3] = a;
    sur[i * 2] = rough; sur[i * 2 + 1] = metal;
    emi[i * 3] = er; emi[i * 3 + 1] = eg; emi[i * 3 + 2] = eb;
    if (rect && src) {
      uvs[i * 2] = rect.u + Math.min(1, Math.max(0, src.getX(i))) * rect.w;
      uvs[i * 2 + 1] = rect.v + Math.min(1, Math.max(0, src.getY(i))) * rect.h;
    } else { uvs[i * 2] = WHITE_UV[0]; uvs[i * 2 + 1] = WHITE_UV[1]; }
  }
  gm.setAttribute('color', new THREE.BufferAttribute(col, k));
  gm.setAttribute('ixs', new THREE.BufferAttribute(sur, 2));
  gm.setAttribute('ixe', new THREE.BufferAttribute(emi, 3));
  gm.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return gm;
}

/** only position, normal and uv survive into a merged model (the surface is vertex attributes) */
function strip(gm: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const k of Object.keys(gm.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') gm.deleteAttribute(k);
  return gm;
}
/** every procedural part is non-indexed, so every merged model has one attribute layout (one node build, one program) */
const flat = (gm: THREE.BufferGeometry): THREE.BufferGeometry => (gm.index ? gm.toNonIndexed() : gm);

/** merge parts that share one attribute layout (indexed when every part is); null for none */
function mergeParts(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null;
  const indexed = list.every((x) => !!x.index);
  const src = indexed ? list : list.map((x) => (x.index ? x.toNonIndexed() : x));
  const out = src.length === 1 ? src[0]! : (mergeGeometries(src, false) ?? src[0]!);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
/** a model under construction: painted copies of cached shapes, placed like child meshes (T * R(XYZ) * S) */
class Parts {
  readonly solid: THREE.BufferGeometry[] = [];
  readonly clear: THREE.BufferGeometry[] = [];
  add(shape: THREE.BufferGeometry, s: Surf, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): void {
    const gm = flat(strip(shape.clone()));
    gm.applyMatrix4(_m4.compose(_p3.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s3.set(sx, sy, sz)));
    const clear = (s.opacity ?? 1) < 1;
    (clear ? this.clear : this.solid).push(paint(gm, s, clear));
  }
}

let haloTex: THREE.CanvasTexture | null = null;
function halo(): THREE.CanvasTexture {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g2 = c.getContext('2d')!;
  const grd = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g2.fillStyle = grd;
  g2.fillRect(0, 0, 128, 128);
  haloTex = new THREE.CanvasTexture(c);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  return haloTex;
}

let haloMatShared: THREE.MeshBasicNodeMaterial | null = null;
/** every floor halo (glowsticks, flares, the idol, armed sensors): additive, colour x opacity baked into vertex colours */
function haloMaterial(): THREE.MeshBasicNodeMaterial {
  if (haloMatShared) return haloMatShared;
  const m = new THREE.MeshBasicNodeMaterial({ map: halo(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true });
  m.name = 'ix.halo';
  haloMatShared = m;
  return m;
}

let glowMat: THREE.SpriteNodeMaterial | null = null;
/** the burning flare's upright glow */
function glowMaterial(): THREE.SpriteNodeMaterial {
  glowMat ??= new THREE.SpriteNodeMaterial({ color: 0xff4a22, map: halo(), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  return glowMat;
}

// ---------------------------------------------------------------- cached shapes

const geo = new Map<string, THREE.BufferGeometry>();
function g<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let x = geo.get(key) as T | undefined;
  if (!x) geo.set(key, (x = make()));
  return x;
}
const box = (key: string, w: number, h: number, d: number) => g(`box:${key}`, () => new THREE.BoxGeometry(w, h, d));
/** rounded box (radius clamped below half the thinnest side) */
const rbox = (key: string, w: number, h: number, d: number, r: number, seg = 2) => g(`rbox:${key}`, () => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, h, d) / 2 - 1e-4)));
const cyl = (key: string, rt: number, rb: number, h: number, segs = 12, open = false, t0 = 0, tl = TAU) =>
  g(`cyl:${key}`, () => new THREE.CylinderGeometry(rt, rb, h, segs, 1, open, t0, tl));
const sph = (key: string, r: number, ws = 12, hs = 8, p0 = 0, pl = TAU, t0 = 0, tl = Math.PI) => g(`sph:${key}`, () => new THREE.SphereGeometry(r, ws, hs, p0, pl, t0, tl));
const tor = (key: string, r: number, t: number, rs = 6, ts = 16, arc = TAU) => g(`tor:${key}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc));
const pln = (key: string, w: number, h: number) => g(`pln:${key}`, () => new THREE.PlaneGeometry(w, h));
const circ = (key: string, r: number, segs = 20) => g(`circ:${key}`, () => new THREE.CircleGeometry(r, segs));
/** a lathe from flat [r, y, r, y, ...] pairs ordered bottom to top (faces outward); inner > 0 adds an inward-facing
 *  copy that much smaller (open shells: horns, tubes) */
function lathe(key: string, pts: number[], segs = 20, inner = 0, phi0 = 0): THREE.BufferGeometry {
  return g(`lathe:${key}`, () => {
    const p: THREE.Vector2[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) p.push(new THREE.Vector2(pts[i]!, pts[i + 1]!));
    const out = new THREE.LatheGeometry(p, segs, phi0);
    if (!(inner > 0)) return out;
    const q = p.slice().reverse().map((v) => new THREE.Vector2(Math.max(0, v.x - inner), v.y));
    return mergeGeometries([out.toNonIndexed(), new THREE.LatheGeometry(q, segs, phi0).toNonIndexed()], false) ?? out;
  });
}
/** a tube through flat [x, y, z, ...] points (Catmull-Rom) */
function tube(key: string, pts: number[], r: number, segs = 32, rsegs = 5, closed = false): THREE.BufferGeometry {
  return g(`tube:${key}`, () => {
    const v: THREE.Vector3[] = [];
    for (let i = 0; i + 2 < pts.length; i += 3) v.push(new THREE.Vector3(pts[i]!, pts[i + 1]!, pts[i + 2]!));
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(v, closed), segs, r, rsegs, closed);
  });
}
/** a coil: radius R, turns, height h (bottom at y 0), wire radius r (+ dr per turn of radius growth for a flat spiral) */
class CoilCurve extends THREE.Curve<THREE.Vector3> {
  R: number; turns: number; h: number; dr: number;
  constructor(R: number, turns: number, h: number, dr: number) {
    super();
    this.R = R; this.turns = turns; this.h = h; this.dr = dr;
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * this.turns * TAU, R = this.R + this.dr * t * this.turns;
    return target.set(Math.cos(a) * R, t * this.h, Math.sin(a) * R);
  }
}
const coil = (key: string, R: number, turns: number, h: number, r: number, segsPerTurn = 24, rsegs = 6, dr = 0) =>
  g(`coil:${key}`, () => new THREE.TubeGeometry(new CoilCurve(R, turns, h, dr), Math.max(8, Math.round(turns * segsPerTurn)), r, rsegs, false));
/** uv = the XY extent of the geometry (extruded shapes: the print covers the face) */
function fitUV(gm: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = gm.attributes.position!;
  gm.computeBoundingBox();
  const b = gm.boundingBox!;
  const w = b.max.x - b.min.x || 1, hh = b.max.y - b.min.y || 1;
  const a = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { a[i * 2] = (p.getX(i) - b.min.x) / w; a[i * 2 + 1] = (p.getY(i) - b.min.y) / hh; }
  gm.setAttribute('uv', new THREE.BufferAttribute(a, 2));
  return gm;
}
/** a flat extruded shape (XY outline, depth along z, centred) with its face uv fitted */
function extrude(key: string, shape: () => THREE.Shape, depth: number): THREE.BufferGeometry {
  return g(`extr:${key}`, () => fitUV(new THREE.ExtrudeGeometry(shape(), { depth, bevelEnabled: false, curveSegments: 8 }).translate(0, 0, -depth / 2)));
}
function roundRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}

/** one or more floor halo planes (at heights relative to the halo mesh) merged into one additive draw */
interface HaloPlane { w: number; color: number; a: number; y: number }
interface HaloGeo { geo: THREE.BufferGeometry; p: V3 }
function haloGeometry(key: string, planes: HaloPlane[], p: V3): HaloGeo {
  return {
    p,
    geo: g(`halo:${key}`, () => {
      const parts = planes.map((h) => {
        const pg = new THREE.PlaneGeometry(h.w, h.w);
        pg.rotateX(-Math.PI / 2);
        pg.translate(0, h.y, 0);
        _col.set(h.color);
        const n = pg.attributes.position!.count;
        const c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { c[i * 3] = _col.r * h.a; c[i * 3 + 1] = _col.g * h.a; c[i * 3 + 2] = _col.b * h.a; }
        pg.setAttribute('color', new THREE.BufferAttribute(c, 3));
        return pg;
      });
      return mergeParts(parts)!;
    }),
  };
}

/** a single painted shape (the glint, the revive ring) */
function paintedShape(key: string, make: () => THREE.BufferGeometry, s: Surf): THREE.BufferGeometry {
  return g(`painted:${key}`, () => {
    const P = new Parts();
    P.add(make(), s);
    return mergeParts(P.solid.length ? P.solid : P.clear)!;
  });
}

// ---------------------------------------------------------------- crafting materials

function matSurf(type: string): Surf {
  const color = type === POUCH_TYPE ? 0x8a7350 : parseInt((MATERIAL_COLOR[type] ?? '#888888').slice(1), 16);
  const metal = type === 'mat.scrap' ? 0.7 : type === 'mat.wiring' ? 0.55 : type === 'mat.cells' ? 0.3 : 0.05;
  const rough = type === 'mat.optics' ? 0.12 : type === 'mat.chem' ? 0.25 : type === POUCH_TYPE ? 0.95 : 0.5;
  // a faint self-light so a material on a dark floor still reads in a flashlight's edge
  return { color, rough, metal, emissive: color, ei: matGlow(type) };
}
const matGlow = (type: string): number => (type === 'mat.relic' ? 0.5 : type === 'mat.optics' ? 0.3 : 0.12);
/** a v1.2 item-model part of a material: its own surface plus the material's faint self-light */
const glowOf = (type: string, s: Surf): Surf => ({ ...s, emissive: parseInt((MATERIAL_COLOR[type] ?? '#8a7350').slice(1), 16), ei: matGlow(type) * 0.7 });

/** v1.2.0 world materials + pouches: one merged, painted geometry per type (origin = bottom centre) */
function legacyMatGeometry(type: string): THREE.BufferGeometry {
  return g(`mat.geo:${type}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const at = (gm: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void => {
      gm.rotateX(rx); gm.rotateY(ry); gm.rotateZ(rz); gm.translate(x, y, z);
      parts.push(strip(flat(gm)));
    };
    switch (type) {
      case 'mat.scrap': // two bent offcuts of plate and a bolt
        at(new THREE.BoxGeometry(0.17, 0.012, 0.1), 0, 0.012, 0, 0, 0.3, 0.12);
        at(new THREE.BoxGeometry(0.12, 0.01, 0.08), 0.03, 0.03, 0.03, 0.5, -0.6, 0);
        at(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6), -0.05, 0.01, -0.03, 0, 0, Math.PI / 2);
        break;
      case 'mat.wiring': // a coil of cable with a plug
        at(new THREE.TorusGeometry(0.05, 0.009, 6, 18), 0, 0.01, 0, Math.PI / 2);
        at(new THREE.TorusGeometry(0.045, 0.009, 6, 18), 0.005, 0.026, 0.004, Math.PI / 2);
        at(new THREE.BoxGeometry(0.03, 0.018, 0.022), 0.07, 0.012, 0.02, 0, 0.5, 0);
        break;
      case 'mat.chem': // a stoppered reagent bottle and a small tin
        at(new THREE.CylinderGeometry(0.03, 0.034, 0.1, 12), 0, 0.05, 0);
        at(new THREE.CylinderGeometry(0.012, 0.016, 0.03, 10), 0, 0.115, 0);
        at(new THREE.CylinderGeometry(0.028, 0.028, 0.035, 12), 0.065, 0.0175, 0.02);
        break;
      case 'mat.optics': // a lens tube and a loose lens
        at(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 14), 0, 0.03, 0, Math.PI / 2);
        at(new THREE.CylinderGeometry(0.034, 0.034, 0.01, 18), 0, 0.034, 0.04, Math.PI / 2);
        at(new THREE.CylinderGeometry(0.026, 0.026, 0.008, 16), 0.06, 0.004, -0.02);
        break;
      case 'mat.cells': // three cells taped together
        for (let i = 0; i < 3; i++) at(new THREE.CylinderGeometry(0.013, 0.013, 0.05, 10), (i - 1) * 0.027, 0.013, 0, Math.PI / 2);
        at(new THREE.BoxGeometry(0.085, 0.028, 0.012), 0, 0.013, 0);
        break;
      case 'mat.relic': // a small carved figure on a plinth
        at(new THREE.CylinderGeometry(0.03, 0.036, 0.02, 8), 0, 0.01, 0);
        at(new THREE.ConeGeometry(0.022, 0.07, 7), 0, 0.055, 0);
        at(new THREE.SphereGeometry(0.016, 8, 6), 0, 0.1, 0);
        break;
      default: // the salvage pouch: a tied canvas sack
        at(new THREE.SphereGeometry(0.075, 12, 9), 0, 0.06, 0);
        at(new THREE.CylinderGeometry(0.02, 0.035, 0.04, 8), 0, 0.13, 0);
        at(new THREE.TorusGeometry(0.02, 0.006, 5, 10), 0, 0.125, 0, Math.PI / 2);
        break;
    }
    const merged = mergeGeometries(parts, false) ?? parts[0]!;
    if (type === POUCH_TYPE) merged.scale(1.15, 0.85, 1.05);
    paint(merged, matSurf(type), false);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  });
}

/** v1.2 item models: the world materials as improved models (chem / optics / relic: the real model when it loads,
 *  else their v1.2.0 shapes) */
function matGeometryV2(type: string): THREE.BufferGeometry {
  if (type === 'mat.chem' || type === 'mat.optics' || type === 'mat.relic') return legacyMatGeometry(type);
  return g(`mat.geo2:${type}`, () => {
    const P = new Parts();
    const s = (x: Surf) => glowOf(type, x);
    switch (type) {
      case 'mat.scrap': { // bent rusty offcuts, a rod and a hex bolt
        P.add(rbox('sc.p1', 0.17, 0.007, 0.1, 0.003, 1), s(pr('rust', 0.8, 0.45)), 0, 0.012, 0, 0, 0.3, 0.12);
        P.add(rbox('sc.p2', 0.12, 0.006, 0.08, 0.0028, 1), s(pr('rust', 0.82, 0.45)), 0.03, 0.032, 0.03, 0.5, -0.6, 0);
        P.add(cyl('sc.rod', 0.009, 0.009, 0.09, 10), s({ color: 0xc8c8c8, rough: 0.7, metal: 0.6, tex: 'rust' }), -0.045, 0.009, -0.04, 0, 0.7, H);
        P.add(cyl('sc.bolt', 0.0045, 0.0045, 0.045, 6), s(SF.dsteel!), 0.06, 0.006, -0.03, 0, 0, H);
        P.add(cyl('sc.head', 0.009, 0.009, 0.007, 6), s(SF.dsteel!), 0.0845, 0.009, -0.03, 0, 0, H);
        break;
      }
      case 'mat.wiring': { // a coiled cable with a plug
        P.add(coil('wr.coil', 0.03, 3, 0.012, 0.0055, 40, 6, 0.007), s({ color: 0xd0773a, rough: 0.5, metal: 0.05, tex: 'leather' }), 0, 0.006, 0);
        P.add(rbox('wr.plug', 0.022, 0.016, 0.03, 0.004, 1), s(SF.black!), 0.068, 0.009, 0.03, 0, 0.5, 0);
        for (const dx of [-0.005, 0.005]) P.add(box('wr.prong', 0.0025, 0.006, 0.014), s(SF.brass!), 0.068 + dx * 0.88 + 0.006, 0.009, 0.03 + 0.019, 0, 0.5, 0);
        break;
      }
      case 'mat.cells': { // three printed cells taped together
        for (let i = 0; i < 3; i++) {
          P.add(cyl('ce.cell', 0.013, 0.013, 0.05, 14), s({ color: 0x151515, rough: 0.4, metal: 0.3 }), (i - 1) * 0.027, 0.013, 0, H);
          P.add(cyl('ce.wrap', 0.0132, 0.0132, 0.044, 14, true), s(pr('wrap.cell', 0.4, 0.2)), (i - 1) * 0.027, 0.013, 0, H, 0, 0);
          P.add(cyl('ce.tip', 0.005, 0.005, 0.004, 8), s({ color: 0xc9cdd1, rough: 0.25, metal: 1 }), (i - 1) * 0.027, 0.013, 0.027, H);
        }
        P.add(box('ce.tape', 0.084, 0.0275, 0.014), s({ color: 0x9a8f7a, rough: 0.9, tex: 'paper' }), 0, 0.013, -0.006);
        break;
      }
      default: { // the salvage pouch: a tied canvas sack
        P.add(lathe('po.sack', [0, 0, 0.05, 0.002, 0.074, 0.018, 0.084, 0.05, 0.08, 0.085, 0.062, 0.108, 0.034, 0.122, 0.022, 0.13, 0.026, 0.148, 0.032, 0.158, 0.018, 0.163, 0, 0.164], 16), s(SF.canvas!), 0, 0, 0, 0, 0, 0, 1.12, 0.86, 1.04);
        P.add(tor('po.tie', 0.024, 0.0042, 5, 16), s({ color: 0x5b4630, rough: 0.9 }), 0, 0.111, 0, H);
        P.add(tube('po.tail', [0.022, 0.11, 0.008, 0.04, 0.09, 0.02, 0.05, 0.05, 0.03], 0.0032, 10, 4), s({ color: 0x5b4630, rough: 0.9 }));
        break;
      }
    }
    const merged = mergeParts(P.solid)!;
    return merged;
  });
}

/** the world-material instance geometry for the mode (v1.2.0 shapes or the v1.2 item models) */
function matGeometry(type: string, v2 = false): THREE.BufferGeometry {
  return v2 ? matGeometryV2(type) : legacyMatGeometry(type);
}

// ---------------------------------------------------------------- visual keys (v1.2 item models)

/** salvage flavour name -> visual key (interactables LOOT_NAMES + the safe's bonds) */
const SALVAGE_KEYS: Readonly<Record<string, string>> = {
  'Pocket watch': 's.watch', 'Brass key ring': 's.keyring', 'Old camera': 's.camera', 'Gas mask': 's.gasmask', 'Circuit board': 's.circuit',
  'Hip flask': 's.flask', 'Cassette tape': 's.cassette', 'Dog tags': 's.dogtags', 'Reading glasses': 's.glasses', 'Tin of buttons': 's.buttons',
  'Tool chest': 's.toolchest', Jerrycan: 's.jerrycan', 'Radio set': 's.radio', Typewriter: 's.typewriter', 'Medical case': 's.medcase',
  'Fuse box': 's.fusebox', 'Brass lamp': 's.lamp', 'Film projector': 's.projector', 'Company bearer bonds': 's.bonds',
  'Server blade rack': 's.blades', 'Generator coil': 's.coil', 'Safe deposit box': 's.depositbox', 'Bronze bust': 's.bust', 'Cryo canister': 's.cryo',
};
/** curio name (catalog CURIOS) -> visual key */
const CURIO_KEYS: Readonly<Record<string, string>> = {
  "Founder's fountain pen": 'c.pen', 'Employee of the Month plaque': 'c.plaque', 'Snow globe (VAN 7)': 'c.snowglobe', 'Porcelain doll': 'c.doll',
  'Music box': 'c.musicbox', 'Dashcam tape: VAN 3': 'c.dashcam', 'Gold tooth': 'c.tooth', 'Ouija planchette': 'c.planchette',
  'Signed safety manual': 'c.manual', 'Taxidermy owl': 'c.owl', 'Wax cylinder recording': 'c.wax', 'Brass diving helmet': 'c.helmet',
};
const LOOT_TYPES = new Set(['loot.small', 'loot.medium', 'loot.heavy']);
/** The visual key of an item: salvage by name, curios by name, otherwise its type (unknown names: the type, i.e. the
 *  generic tier shape). legacy = the v1.2.0 models (the type). */
export function visualKey(it: { type: string; name?: string | null }, legacy = false): string {
  if (legacy) return it.type;
  if (LOOT_TYPES.has(it.type)) return (it.name ? SALVAGE_KEYS[it.name] : undefined) ?? it.type;
  if (it.type === CURIO_TYPE) return (it.name ? CURIO_KEYS[it.name] : undefined) ?? it.type;
  return it.type;
}
const isSalvageKey = (key: string): boolean => key.startsWith('s.') || LOOT_TYPES.has(key);
/** every v1.2 visual key with an item that shows it (tests: one of each on a floor, in a drawer, in hand) */
export function itemSamples(): { key: string; type: string; name?: string }[] {
  const out: { key: string; type: string; name?: string }[] = [];
  const tierOf = (name: string): string => {
    const t = ['s.watch', 's.keyring', 's.camera', 's.gasmask', 's.circuit', 's.flask', 's.cassette', 's.dogtags', 's.glasses', 's.buttons'].includes(SALVAGE_KEYS[name]!) ? 'loot.small'
      : ['s.blades', 's.coil', 's.depositbox', 's.bust', 's.cryo'].includes(SALVAGE_KEYS[name]!) ? 'loot.heavy' : 'loot.medium';
    return t;
  };
  for (const name of Object.keys(SALVAGE_KEYS)) out.push({ key: SALVAGE_KEYS[name]!, type: tierOf(name), name });
  for (const t of LOOT_TYPES) out.push({ key: t, type: t, name: 'Unlisted salvage' });
  for (const name of Object.keys(CURIO_KEYS)) out.push({ key: CURIO_KEYS[name]!, type: CURIO_TYPE, name });
  out.push({ key: CURIO_TYPE, type: CURIO_TYPE, name: 'Unlisted curio' });
  for (const t of ['loot.idol', 'bottle', 'crowbar', 'glowstick', 'medkit', 'walkie', 'airhorn', 'keycard', 'badge', 'flashlight_pro', 'flare', 'sensor',
    'syringe', 'charm', 'battery', 'lockpick', 'masterkey', 'soles', 'nvg', 'flashbulb', 'page', 'lure', 'receiver', ...MATERIAL_TYPES, POUCH_TYPE]) out.push({ key: t, type: t });
  return out;
}

// ---------------------------------------------------------------- item models

interface ModelGeo {
  solid: THREE.BufferGeometry | null;
  clear: THREE.BufferGeometry | null;
  /** a separate blinking LED (the walkie's view model, an armed sensor) */
  led: THREE.BufferGeometry | null;
  halo: HaloGeo | null;
  /** the burning flare's upright glow */
  glow: boolean;
  /** size of the drawn model (solid + clear + LED), m */
  size: THREE.Vector3;
}
const modelGeos = new Map<string, ModelGeo>();

interface BuildOut { hg: HaloGeo | null; glow: boolean; mg: ModelGeo | null }

/** the v1.2.0 procedural models (the itemModels flag off; v1.2 keys without a new model reuse them) */
function legacyParts(type: string, lit: boolean, vm: boolean, P: Parts, LED: Parts, o: BuildOut): void {
  switch (type) {
    case 'bottle': {
      // the glass was 86 % opaque: drawn opaque (one draw), glossy dark green
      const glass: Surf = { color: 0x1f4a2a, rough: 0.06, metal: 0.1 };
      P.add(g('btl.body', () => new THREE.CylinderGeometry(0.038, 0.042, 0.19, 14)), glass, 0, 0.095, 0);
      P.add(g('btl.shoulder', () => new THREE.CylinderGeometry(0.016, 0.038, 0.05, 14)), glass, 0, 0.215, 0);
      P.add(g('btl.neck', () => new THREE.CylinderGeometry(0.014, 0.016, 0.07, 10)), glass, 0, 0.275, 0);
      P.add(g('btl.label', () => new THREE.CylinderGeometry(0.0412, 0.0412, 0.055, 14, 1, true)), { color: 0x8c7a4e, rough: 0.9 }, 0, 0.09, 0);
      break;
    }
    case 'crowbar': {
      const paintS: Surf = { color: 0x9e2a22, rough: 0.42, metal: 0.55 };
      P.add(g('cb.shaft', () => new THREE.CylinderGeometry(0.011, 0.011, 0.62, 8)), paintS, 0, 0.011, 0, H);
      P.add(g('cb.hook', () => new THREE.TorusGeometry(0.04, 0.011, 6, 12, Math.PI * 1.1)), paintS, 0, 0.051, 0.31, 0, H);
      P.add(g('cb.tip', () => new THREE.BoxGeometry(0.03, 0.008, 0.05)), STEEL, 0, 0.012, -0.33);
      break;
    }
    case 'glowstick': {
      const glowS: Surf = lit ? { color: 0x6dff8f, rough: 0.3, emissive: 0x39ff6a, ei: 7 } : { color: 0x4fae62, rough: 0.35, emissive: 0x39ff6a, ei: 0.8 };
      const n = lit ? 1 : 3;
      for (let i = 0; i < n; i++) P.add(g('gs.stick', () => new THREE.CapsuleGeometry(0.011, 0.15, 4, 8)), glowS, (i - (n - 1) / 2) * 0.03, 0.012, 0, H);
      if (lit) o.hg = haloGeometry('gs', [{ w: 2.6, color: 0x39ff6a, a: 0.32, y: 0 }, { w: 0.5, color: 0xb8ffc8, a: 0.55, y: 0.002 }], [0, 0.01, 0]);
      break;
    }
    case 'medkit': {
      const red: Surf = { color: 0xc0201b, rough: 0.5, emissive: 0x500000, ei: 0.4 };
      P.add(g('mk.box', () => new THREE.BoxGeometry(0.3, 0.11, 0.2)), { color: 0xe7e1d3, rough: 0.55 }, 0, 0.055, 0);
      P.add(g('mk.cross1', () => new THREE.BoxGeometry(0.11, 0.004, 0.035)), red, 0, 0.112, 0);
      P.add(g('mk.cross2', () => new THREE.BoxGeometry(0.035, 0.004, 0.11)), red, 0, 0.112, 0);
      P.add(g('mk.handle', () => new THREE.TorusGeometry(0.035, 0.007, 6, 10, Math.PI)), DARK, 0, 0.11, 0);
      break;
    }
    case 'walkie': {
      P.add(g('wk.body', () => new THREE.BoxGeometry(0.062, 0.15, 0.034)), { color: 0x2b2f33, rough: 0.55, metal: 0.1 }, 0, 0.075, 0);
      P.add(g('wk.ant', () => new THREE.CylinderGeometry(0.006, 0.008, 0.09, 6)), DARK, 0.018, 0.195, 0);
      P.add(g('wk.grill', () => new THREE.BoxGeometry(0.045, 0.05, 0.004)), { color: 0x15181a, rough: 0.9 }, 0, 0.105, 0.018);
      // the LED blinks in the view model only (a separate mesh there); merged into the body anywhere else
      (vm ? LED : P).add(g('wk.led', () => new THREE.SphereGeometry(0.005, 6, 4)), { color: 0x2aff6a, emissive: 0x2aff6a, ei: 4 }, -0.02, 0.147, 0.012);
      break;
    }
    case 'airhorn': {
      P.add(g('ah.can', () => new THREE.CylinderGeometry(0.03, 0.03, 0.13, 12)), { color: 0xd4362b, rough: 0.35, metal: 0.4 }, 0, 0.065, 0);
      P.add(g('ah.horn', () => new THREE.ConeGeometry(0.045, 0.1, 14, 1, true)), { color: 0xf2efe6, rough: 0.5 }, 0, 0.18, 0, Math.PI);
      break;
    }
    case 'keycard': {
      P.add(g('kc.card', () => new THREE.BoxGeometry(0.086, 0.003, 0.054)), { color: 0xf2c230, rough: 0.35, emissive: 0xffb000, ei: 0.6 }, 0, 0.002, 0);
      P.add(g('kc.strip', () => new THREE.BoxGeometry(0.086, 0.0035, 0.012)), DARK, 0, 0.0025, 0.016);
      break;
    }
    case 'badge': {
      P.add(g('bd.card', () => new THREE.BoxGeometry(0.07, 0.004, 0.1)), { color: 0x3f7fb3, rough: 0.4, emissive: 0x1c4c7a, ei: 0.8 }, 0, 0.003, 0);
      P.add(g('bd.plate', () => new THREE.BoxGeometry(0.05, 0.0045, 0.03)), { color: 0xe8e8e8, rough: 0.5 }, 0, 0.0035, -0.02);
      break;
    }
    case 'flashlight_pro': {
      P.add(g('pf.tube', () => new THREE.CylinderGeometry(0.019, 0.019, 0.17, 14)), { color: 0x1b1f24, rough: 0.35, metal: 0.7 }, 0, 0.02, -0.02, H);
      P.add(g('pf.head', () => new THREE.CylinderGeometry(0.03, 0.021, 0.06, 16)), { color: 0xb9c3cc, rough: 0.25, metal: 1 }, 0, 0.02, 0.09, H);
      P.add(g('pf.lens', () => new THREE.CircleGeometry(0.026, 16)), { color: 0xdfeeff, emissive: 0xcfe6ff, ei: 3 }, 0, 0.02, 0.1205);
      P.add(g('pf.grip', () => new THREE.BoxGeometry(0.012, 0.006, 0.05)), { color: 0x4fa3ff, emissive: 0x1a5cff, ei: 0.8 }, 0, 0.041, -0.02);
      break;
    }
    case 'flare':
    case 'flare.lit': {
      const lit2 = type === 'flare.lit';
      const red: Surf = { color: 0xc8241b, rough: 0.55 };
      const n = lit2 ? 1 : 3;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 0.038;
        P.add(g('fl.stick', () => new THREE.CylinderGeometry(0.014, 0.014, 0.21, 10)), red, x, 0.015, 0, H);
        P.add(g('fl.cap', () => new THREE.CylinderGeometry(0.015, 0.015, 0.03, 10)), DARK, x, 0.015, -0.115, H);
      }
      if (lit2) {
        P.add(g('fl.tip', () => new THREE.SphereGeometry(0.022, 10, 8)), { color: 0xffd0c0, emissive: 0xff3a1c, ei: 22 }, 0, 0.02, 0.11);
        o.hg = haloGeometry('fl', [{ w: 4.2, color: 0xff2a12, a: 0.42, y: 0 }], [0, 0.012, 0.1]);
        o.glow = true;
      }
      break;
    }
    case 'sensor':
    case 'sensor.armed': {
      const armed = type === 'sensor.armed';
      P.add(g('ms.base', () => new THREE.CylinderGeometry(0.07, 0.08, 0.03, 18)), { color: 0x2c3136, rough: 0.5, metal: 0.5 }, 0, 0.015, 0);
      P.add(g('ms.dome', () => new THREE.SphereGeometry(0.05, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)), { color: 0x9adfd2, rough: 0.15, metal: 0.1, opacity: 0.7 }, 0, 0.03, 0);
      P.add(g('ms.ant', () => new THREE.CylinderGeometry(0.003, 0.003, 0.12, 6)), DARK, 0.05, 0.09, 0);
      // an armed sensor blinks its LED (a separate mesh); a packed one has it dark, merged into the body
      (armed ? LED : P).add(g('ms.led', () => new THREE.SphereGeometry(0.009, 8, 6)), armed ? { color: 0x62ffe0, emissive: 0x30ffd0, ei: 9 } : { color: 0x1d3b35, rough: 0.5 }, 0, 0.075, 0);
      if (armed) o.hg = haloGeometry('ms', [{ w: 0.9, color: 0x30ffd0, a: 0.28, y: 0 }], [0, 0.006, 0]);
      break;
    }
    case 'syringe': {
      P.add(g('sy.barrel', () => new THREE.CylinderGeometry(0.011, 0.011, 0.11, 12)), { color: 0xdfe8ea, rough: 0.08, opacity: 0.55 }, 0, 0.012, 0, H);
      P.add(g('sy.fluid', () => new THREE.CylinderGeometry(0.0085, 0.0085, 0.08, 10)), { color: 0xffd23f, emissive: 0xffb000, ei: 1.6 }, 0, 0.012, 0.01, H);
      P.add(g('sy.needle', () => new THREE.CylinderGeometry(0.0015, 0.0015, 0.045, 6)), STEEL, 0, 0.012, 0.077, H);
      P.add(g('sy.plunger', () => new THREE.BoxGeometry(0.03, 0.03, 0.006)), DARK, 0, 0.012, -0.065);
      break;
    }
    case 'charm': {
      // a rabbit's foot on a brass ring: fuzzy pale foot + faint green luck glow
      P.add(g('ch.foot', () => new THREE.CapsuleGeometry(0.022, 0.05, 6, 10)), { color: 0xe9e1cf, rough: 1 }, 0, 0.022, 0, H);
      P.add(g('ch.ring', () => new THREE.TorusGeometry(0.018, 0.003, 6, 16)), { color: 0xb08a3e, rough: 0.3, metal: 1 }, 0, 0.022, 0.06, 0, H);
      P.add(g('ch.clover', () => new THREE.CircleGeometry(0.02, 4)), { color: 0x4fd14a, emissive: 0x2fb52a, ei: 1.5 }, 0, 0.046, 0, -H);
      break;
    }
    case 'loot.idol': {
      // squat stone figure, too-long neck, cocked head (the Listener's shape) with faint violet eyes
      const stone: Surf = { color: 0x3b3346, rough: 0.85, metal: 0.05, emissive: 0x1a0830, ei: 0.4 };
      P.add(g('id.base', () => new THREE.CylinderGeometry(0.075, 0.09, 0.05, 8)), stone, 0, 0.025, 0);
      P.add(g('id.body', () => new THREE.CylinderGeometry(0.035, 0.06, 0.16, 8)), stone, 0, 0.13, 0);
      P.add(g('id.neck', () => new THREE.CylinderGeometry(0.012, 0.016, 0.12, 6)), stone, 0, 0.27, 0);
      P.add(g('id.head', () => new THREE.SphereGeometry(0.035, 10, 8)), stone, 0.012, 0.345, 0, 0, 0, 0.5, 0.8, 1.25, 0.9);
      const eye: Surf = { color: 0xd6b8ff, emissive: 0xa060ff, ei: 10 };
      for (const ex of [-0.011, 0.011]) P.add(g('id.eye', () => new THREE.SphereGeometry(0.005, 6, 4)), eye, 0.012 + ex, 0.35 + ex * 0.5, 0.028);
      o.hg = haloGeometry('id', [{ w: 0.9, color: 0x7a3cff, a: 0.22, y: 0 }], [0, 0.008, 0]);
      break;
    }
    // ---------------------------------------------------------------- v1.2 gear
    case 'battery': {
      // two D cells: brass-yellow sleeves, a black band, copper tips
      const sleeve: Surf = { color: 0xd9b43a, rough: 0.38, metal: 0.45 };
      const band: Surf = { color: 0x16181a, rough: 0.5 };
      const tip: Surf = { color: 0xc98a4a, rough: 0.3, metal: 0.9 };
      for (const x of [-0.019, 0.019]) {
        P.add(g('bat.cell', () => new THREE.CylinderGeometry(0.017, 0.017, 0.06, 14)), sleeve, x, 0.03, 0);
        P.add(g('bat.band', () => new THREE.CylinderGeometry(0.0175, 0.0175, 0.016, 14)), band, x, 0.046, 0);
        P.add(g('bat.tip', () => new THREE.CylinderGeometry(0.006, 0.006, 0.006, 8)), tip, x, 0.063, 0);
      }
      break;
    }
    case 'lockpick': {
      // a leather roll, three steel picks fanned out of it
      P.add(g('lp.roll', () => new THREE.BoxGeometry(0.1, 0.018, 0.045)), { color: 0x4a3324, rough: 0.85 }, 0, 0.009, 0);
      P.add(g('lp.strap', () => new THREE.BoxGeometry(0.012, 0.02, 0.047)), { color: 0x2a1d14, rough: 0.8 }, 0.025, 0.01, 0);
      [-0.25, 0, 0.25].forEach((a, i) => {
        P.add(g('lp.pick', () => new THREE.CylinderGeometry(0.0016, 0.0016, 0.085, 5)), STEEL, -0.03 - Math.cos(a) * 0.035, 0.02 + i * 0.002, Math.sin(a) * 0.035, 0, a, H);
      });
      break;
    }
    case 'masterkey': {
      // the master keycard: an orange card with a gold chip and a black stripe, a faint glow
      P.add(g('mk.card', () => new THREE.BoxGeometry(0.086, 0.003, 0.054)), { color: 0xff8f3a, rough: 0.32, emissive: 0xff6a10, ei: 0.7 }, 0, 0.002, 0);
      P.add(g('kc.strip', () => new THREE.BoxGeometry(0.086, 0.0035, 0.012)), DARK, 0, 0.0025, 0.016);
      P.add(g('mk.chip', () => new THREE.BoxGeometry(0.014, 0.0038, 0.011)), { color: 0xe0b84e, rough: 0.35, metal: 0.25, emissive: 0x5a3c06, ei: 0.6 }, -0.026, 0.0028, -0.008);
      break;
    }
    case 'soles': {
      // a pair of soft grey-blue overshoes
      const cloth: Surf = { color: 0x7d93a6, rough: 0.95 };
      const sole: Surf = { color: 0x2b2f33, rough: 0.9 };
      for (const x of [-0.045, 0.045]) {
        P.add(g('so.shoe', () => new THREE.SphereGeometry(0.05, 12, 8)), cloth, x, 0.022, 0, 0, 0, 0, 0.75, 0.45, 1.6);
        P.add(g('so.sole', () => new THREE.BoxGeometry(0.07, 0.006, 0.15)), sole, x, 0.003, 0);
      }
      break;
    }
    case 'nvg': {
      // a monocular night-vision module on a head-strap ring, green-lit lens
      P.add(g('nv.tube', () => new THREE.CylinderGeometry(0.022, 0.026, 0.09, 14)), { color: 0x262b2e, rough: 0.5, metal: 0.35 }, 0, 0.026, 0, H);
      P.add(g('nv.lens', () => new THREE.CircleGeometry(0.02, 16)), { color: 0x6dff8a, emissive: 0x39ff6a, ei: 3.2 }, 0, 0.026, 0.0455);
      P.add(g('nv.eye', () => new THREE.CylinderGeometry(0.018, 0.016, 0.02, 12)), DARK, 0, 0.026, -0.053, H);
      P.add(g('nv.strap', () => new THREE.TorusGeometry(0.05, 0.005, 5, 20)), { color: 0x3b3a34, rough: 0.9 }, 0, 0.006, -0.03, H);
      break;
    }
    case 'flashbulb': {
      // a press flash gun: a polished reflector dish, a frosted bulb (was 85 % opaque: opaque now), a short grip
      P.add(g('fb.dish', () => new THREE.CylinderGeometry(0.045, 0.015, 0.035, 18, 1, true)), { color: 0xd8dde2, rough: 0.12, metal: 1 }, 0, 0.06, 0.02, H);
      P.add(g('fb.bulb', () => new THREE.SphereGeometry(0.014, 10, 8)), { color: 0xfff6d8, rough: 0.2, emissive: 0xfff0c0, ei: 1.4 }, 0, 0.06, 0.026);
      P.add(g('fb.grip', () => new THREE.CylinderGeometry(0.012, 0.012, 0.07, 10)), { color: 0x1b1d20, rough: 0.6 }, 0, 0.035, 0);
      break;
    }
    // ---------------------------------------------------------------- v1.3 gear (the same models in both modes)
    case 'lure':
    case 'lure.armed':
      lureParts(P, LED, type === 'lure.armed', o);
      break;
    case 'receiver':
      receiverParts(P);
      break;
    case 'loot.curio': {
      // a one-of-a-kind keepsake under a glass bell jar on a walnut base, a warm brass glint inside
      const brass: Surf = { color: 0xc99b45, rough: 0.28, metal: 1, emissive: 0x5a3a08, ei: 0.8 };
      P.add(g('cu.base', () => new THREE.CylinderGeometry(0.06, 0.066, 0.025, 20)), { color: 0x4a2e1c, rough: 0.55 }, 0, 0.0125, 0);
      P.add(g('cu.obj', () => new THREE.TorusKnotGeometry(0.022, 0.007, 48, 6)), brass, 0, 0.06, 0);
      P.add(g('cu.jar', () => new THREE.SphereGeometry(0.052, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)), { color: 0xdfe9ee, rough: 0.05, metal: 0.1, opacity: 0.28 }, 0, 0.025, 0, 0, 0, 0, 1, 1.5, 1);
      P.add(g('cu.knob', () => new THREE.SphereGeometry(0.008, 8, 6)), brass, 0, 0.104, 0);
      break;
    }
    case 'page': {
      // a field-note page: a curled, ruled sheet that catches a light
      P.add(pageSheet(), { color: 0xe8dfc6, rough: 0.9, emissive: 0x2a2618, ei: 0.4 }, 0, 0.004, 0, -H);
      for (let i = 0; i < 6; i++) P.add(g('pg.line', () => new THREE.PlaneGeometry(0.11, 0.0022)), { color: 0x3b3a52, rough: 0.9 }, -0.008, 0.0072, -0.07 + i * 0.025, -H);
      break;
    }
    default: {
      // crafting materials / pouches (the world draws them instanced; this one is for previews and held models)
      if (type.startsWith('mat.')) { o.mg = withSize({ solid: legacyMatGeometry(type), clear: null, led: null, halo: null, glow: false }); break; }
      // salvage (only when this track rolls loot; objectives renders its own)
      const tier = type === 'loot.heavy' ? 2 : type === 'loot.medium' ? 1 : 0;
      const s = [0.14, 0.26, 0.46][tier]!;
      P.add(g(`loot.${tier}`, () => new THREE.BoxGeometry(s, s * 0.7, s * 0.8)), { color: [0xb08d2a, 0x8d6b3a, 0x6c5a48][tier]!, rough: 0.5, metal: 0.5 }, 0, s * 0.35, 0);
      break;
    }
  }
}
const pageSheet = () => g('pg.sheet', () => {
  const pg = new THREE.PlaneGeometry(0.148, 0.21, 6, 1);
  const pos = pg.attributes.position!;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, 0.006 * (pos.getX(i) / 0.074) ** 2);
  pg.computeVertexNormals();
  return pg;
});

/** a bell jar on a walnut base (curios); h = the dome height over the base */
function bellJar(P: Parts, h = 0.078): void {
  P.add(cyl('cu.base2', 0.06, 0.066, 0.025, 22), SF.walnut!, 0, 0.0125, 0);
  P.add(sph('cu.jar2', 0.052, 20, 12, 0, TAU, 0, H), SF.glass!, 0, 0.025, 0, 0, 0, 0, 1, h / 0.052, 1);
  P.add(sph('cu.knob2', 0.008, 8, 6), SF.brass!, 0, 0.025 + h + 0.004, 0);
}
/** a faint warm self-light on a curio's centrepiece (it reads in a flashlight's edge, like the v1.2.0 brass glint) */
const curioGlow = (s: Surf): Surf => ({ ...s, emissive: 0x5a3a08, ei: 0.35 });

type V2Build = (P: Parts, LED: Parts, o: { lit: boolean; vm: boolean }, out: BuildOut) => void;
/** v1.2 item models: improved procedural models by visual key (origin = bottom centre, +Z forward) */
const V2: Record<string, V2Build> = {
  // ---------------------------------------------------------------- gear
  bottle: (P) => {
    const glass: Surf = { color: 0x1f4a2a, rough: 0.06, metal: 0.1 };
    P.add(lathe('btl2', [0, 0, 0.036, 0, 0.041, 0.006, 0.0415, 0.02, 0.0415, 0.188, 0.039, 0.203, 0.03, 0.222, 0.019, 0.24, 0.0152, 0.258, 0.0148, 0.286, 0.0168, 0.29, 0.0168, 0.3, 0.0145, 0.302], 18), glass);
    P.add(cyl('btl.label2', 0.0422, 0.0422, 0.072, 18, true, -1.25, 2.5), pr('label.bottle', 0.85), 0, 0.105, 0);
    P.add(cyl('btl.cork', 0.0142, 0.0136, 0.022, 10), { color: 0x9a7850, rough: 0.9, tex: 'speckle' }, 0, 0.311, 0);
  },
  walkie: (P, LED, o) => {
    P.add(rbox('wk.body2', 0.062, 0.15, 0.036, 0.008, 2), { color: 0x2a2e31, rough: 0.55, metal: 0.1, tex: 'leather' }, 0, 0.075, 0);
    P.add(pln('wk.grill2', 0.046, 0.052), pr('grill', 0.85), 0, 0.104, 0.0182);
    P.add(rbox('wk.screen', 0.036, 0.016, 0.003, 0.0012, 1), { color: 0x7d8c5a, rough: 0.2, metal: 0.1 }, 0, 0.058, 0.0185);
    P.add(cyl('wk.ant2', 0.0055, 0.007, 0.085, 8), SF.rubber!, 0.017, 0.192, 0);
    P.add(sph('wk.anttip', 0.0065, 8, 6), SF.rubber!, 0.017, 0.235, 0);
    P.add(cyl('wk.knob', 0.0075, 0.0075, 0.012, 10), SF.black!, -0.016, 0.156, 0);
    P.add(rbox('wk.ptt', 0.006, 0.032, 0.014, 0.0025, 1), SF.black!, -0.0335, 0.1, 0);
    P.add(rbox('wk.clip', 0.03, 0.06, 0.004, 0.0015, 1), SF.dsteel!, 0, 0.11, -0.02);
    (o.vm ? LED : P).add(sph('wk.led2', 0.0042, 6, 4), { color: 0x2aff6a, emissive: 0x2aff6a, ei: 4 }, 0.008, 0.156, 0.012);
  },
  airhorn: (P) => {
    P.add(lathe('ah.can2', [0, 0, 0.028, 0, 0.0305, 0.004, 0.0305, 0.118, 0.026, 0.128, 0.012, 0.134, 0, 0.134], 16), { color: 0xd4362b, rough: 0.35, metal: 0.4 });
    P.add(cyl('ah.label', 0.031, 0.031, 0.075, 16, true, -1.6, 3.2), pr('label.airhorn', 0.5, 0.2), 0, 0.06, 0);
    P.add(cyl('ah.valve', 0.011, 0.012, 0.022, 10), SF.black!, 0, 0.144, 0);
    P.add(lathe('ah.horn2', [0.011, 0, 0.012, 0.03, 0.018, 0.06, 0.03, 0.085, 0.045, 0.098, 0.046, 0.1], 18, 0.0015), { color: 0xf2efe6, rough: 0.5 }, 0, 0.15, 0);
  },
  keycard: (P) => {
    P.add(box('kc.card2', 0.086, 0.0024, 0.054), { color: 0xf2c230, rough: 0.35, emissive: 0xffb000, ei: 0.6 }, 0, 0.0012, 0);
    P.add(pln('kc.face', 0.084, 0.052), { ...pr('card.key', 0.35), emissive: 0x8a6000, ei: 0.3 }, 0, 0.0025, 0, -H);
  },
  masterkey: (P) => {
    P.add(box('kc.card2', 0.086, 0.0024, 0.054), { color: 0xff8f3a, rough: 0.32, emissive: 0xff6a10, ei: 0.6 }, 0, 0.0012, 0);
    P.add(pln('kc.face', 0.084, 0.052), { ...pr('card.master', 0.32), emissive: 0x8a3a08, ei: 0.3 }, 0, 0.0025, 0, -H);
  },
  badge: (P) => {
    P.add(box('bd.card2', 0.07, 0.003, 0.1), { color: 0x3f7fb3, rough: 0.4, emissive: 0x1c4c7a, ei: 0.8 }, 0, 0.0015, 0);
    P.add(pln('bd.face', 0.068, 0.098), { ...pr('card.badge', 0.4), emissive: 0x16304a, ei: 0.35 }, 0, 0.0031, 0, -H);
    P.add(rbox('bd.clip', 0.024, 0.004, 0.016, 0.0015, 1), SF.chrome!, 0, 0.004, -0.052);
  },
  battery: (P) => {
    for (const x of [-0.019, 0.019]) {
      P.add(cyl('bat.cell2', 0.017, 0.017, 0.058, 16), { color: 0x1a1a1a, rough: 0.4, metal: 0.3 }, x, 0.029, 0);
      P.add(cyl('bat.wrap', 0.0173, 0.0173, 0.054, 16, true), pr('wrap.battery', 0.42, 0.25), x, 0.029, 0, 0, x < 0 ? 0.6 : -0.5, 0);
      P.add(cyl('bat.tip2', 0.006, 0.0065, 0.005, 10), { color: 0xc9cdd1, rough: 0.25, metal: 1 }, x, 0.0605, 0);
    }
  },
  flare: (P) => flareSticks(P, 3),
  'flare.lit': (P, _L, _o, out) => {
    flareSticks(P, 1);
    P.add(g('fl.tip', () => new THREE.SphereGeometry(0.022, 10, 8)), { color: 0xffd0c0, emissive: 0xff3a1c, ei: 22 }, 0, 0.02, 0.11);
    out.hg = haloGeometry('fl', [{ w: 4.2, color: 0xff2a12, a: 0.42, y: 0 }], [0, 0.012, 0.1]);
    out.glow = true;
  },
  page: (P) => {
    P.add(pageSheet(), { ...pr('page.notes', 0.9), emissive: 0x2a2618, ei: 0.4 }, 0, 0.004, 0, -H);
  },
  lure: (P, LED, _o, out) => lureParts(P, LED, false, out),
  'lure.armed': (P, LED, _o, out) => lureParts(P, LED, true, out),
  receiver: (P) => receiverParts(P),
  'loot.idol': (P, _L, _o, out) => {
    const stone: Surf = { color: 0x6b6178, rough: 0.88, metal: 0.05, emissive: 0x1a0830, ei: 0.4, tex: 'speckle' };
    P.add(lathe('id2.base', [0, 0, 0.09, 0, 0.088, 0.02, 0.078, 0.05, 0.062, 0.056, 0.058, 0.07, 0.05, 0.12, 0.04, 0.17, 0.03, 0.2, 0.018, 0.21, 0, 0.212], 9), stone);
    P.add(cyl('id2.neck', 0.012, 0.017, 0.12, 7), stone, 0, 0.268, 0, 0.06, 0, 0);
    P.add(sph('id2.head', 0.035, 12, 9), stone, 0.012, 0.345, 0.008, 0, 0, 0.5, 0.8, 1.25, 0.9);
    for (const sx of [-1, 1]) P.add(cyl('id2.arm', 0.011, 0.014, 0.1, 6), stone, sx * 0.05, 0.13, 0.012, 0.2, 0, sx * 0.28);
    const eye: Surf = { color: 0xd6b8ff, emissive: 0xa060ff, ei: 10 };
    for (const ex of [-0.011, 0.011]) P.add(sph('id2.eye', 0.005, 6, 4), eye, 0.012 + ex, 0.35 + ex * 0.5, 0.036);
    out.hg = haloGeometry('id', [{ w: 0.9, color: 0x7a3cff, a: 0.22, y: 0 }], [0, 0.008, 0]);
  },
  // ---------------------------------------------------------------- salvage (no real model, or its fallback)
  's.watch': (P) => {
    const gold = SF.gold!;
    P.add(lathe('pw.case', [0, 0, 0.022, 0, 0.0255, 0.003, 0.0262, 0.0065, 0.0255, 0.01, 0.0236, 0.0118], 28), gold);
    P.add(circ('pw.dial', 0.0237, 28), pr('dial.watch', 0.3), 0, 0.0116, 0, -H);
    P.add(cyl('pw.crown', 0.003, 0.003, 0.006, 10), gold, 0, 0.006, 0.0285, H);
    P.add(tor('pw.bow', 0.0075, 0.0014, 6, 16), gold, 0, 0.006, 0.0372, H);
    P.add(tube('pw.chain', [0, 0.0012, 0.044, 0.018, 0.0012, 0.062, 0.042, 0.0012, 0.06, 0.058, 0.0012, 0.04, 0.06, 0.0012, 0.016], 0.0009, 32, 4), gold);
  },
  's.keyring': (P) => {
    const ring: Surf = { color: 0xc9a24a, rough: 0.3, metal: 1 };
    P.add(tor('kr.ring', 0.021, 0.0018, 6, 28), ring, 0, 0.0018, -0.012, H);
    const keys: [number, Surf][] = [[-0.6, { color: 0xc9a24a, rough: 0.32, metal: 1, tex: 'brushed' }], [0.12, { color: 0xa9aeb3, rough: 0.3, metal: 0.95, tex: 'brushed' }], [0.85, { color: 0xb08d57, rough: 0.35, metal: 1, tex: 'brushed' }]];
    for (const [a, s] of keys) {
      const dx = Math.sin(a), dz = Math.cos(a), px = Math.cos(a), pz = -Math.sin(a);
      const bx = dx * 0.028, bz = -0.012 + dz * 0.028;
      P.add(tor('kr.bow', 0.0085, 0.0022, 6, 16), s, bx, 0.0024, bz, H);
      P.add(box('kr.shaft', 0.0042, 0.0022, 0.044), s, bx + dx * 0.031, 0.0024, bz + dz * 0.031, 0, a, 0);
      for (const t of [0.04, 0.046, 0.051]) P.add(box('kr.tooth', 0.0042, 0.0022, 0.0038), s, bx + dx * t + px * 0.0035, 0.0024, bz + dz * t + pz * 0.0035, 0, a, 0);
    }
    P.add(rbox('kr.fob', 0.022, 0.004, 0.034, 0.0019, 1), SF.leather!, -0.03, 0.002, -0.04, 0, 0.5, 0);
  },
  's.camera': (P) => {
    P.add(rbox('oc.body', 0.12, 0.074, 0.05, 0.008, 2), { color: 0x1c1c1c, rough: 0.6, tex: 'leather' }, 0, 0.037, 0);
    P.add(rbox('oc.top', 0.12, 0.014, 0.05, 0.005, 1), SF.chrome!, 0, 0.081, 0);
    P.add(cyl('oc.lens', 0.024, 0.026, 0.034, 20), SF.chrome!, 0, 0.038, 0.042, H);
    P.add(cyl('oc.ring', 0.021, 0.021, 0.006, 20), SF.black!, 0, 0.038, 0.0605, H);
    P.add(circ('oc.glass', 0.017, 18), SF.darkGlass!, 0, 0.038, 0.0636);
    P.add(rbox('oc.vf', 0.03, 0.014, 0.022, 0.004, 1), SF.black!, -0.035, 0.095, 0);
    P.add(cyl('oc.btn', 0.005, 0.005, 0.006, 10), SF.chrome!, 0.04, 0.091, 0);
    P.add(cyl('oc.wind', 0.008, 0.008, 0.006, 12), SF.chrome!, 0.022, 0.091, -0.01);
  },
  's.gasmask': (P) => {
    const rub: Surf = { color: 0x2c2f2a, rough: 0.78, tex: 'leather' };
    P.add(sph('gm.face', 1, 20, 12, 0, TAU, 0, H), rub, 0, 0, 0, 0, 0, 0, 0.09, 0.055, 0.115);
    for (const sx of [-1, 1]) {
      P.add(tor('gm.eye', 0.022, 0.0055, 6, 18), { color: 0x6a6e66, rough: 0.4, metal: 0.6 }, sx * 0.036, 0.046, 0.024, -H, sx * 0.35, 0);
      P.add(circ('gm.lens', 0.0205, 18), SF.darkGlass!, sx * 0.036, 0.0475, 0.024, -H, sx * 0.35, 0);
    }
    P.add(cyl('gm.snout', 0.022, 0.03, 0.045, 14), rub, 0, 0.037, 0.098, H - 0.35);
    P.add(cyl('gm.filter', 0.037, 0.037, 0.05, 18), { color: 0x5a5f3a, rough: 0.5, metal: 0.4, tex: 'speckle' }, 0, 0.042, 0.142, H - 0.15);
    for (const a of [-0.45, 0, 0.45]) P.add(box('gm.strap', 0.012, 0.003, 0.11), SF.rubber!, Math.sin(a) * 0.07, 0.0015, -0.1 - Math.cos(a) * 0.02, 0, a, 0);
  },
  's.circuit': (P) => {
    P.add(box('cb.board', 0.2, 0.0016, 0.14), { color: 0x1f5d34, rough: 0.5 }, 0, 0.0008, 0);
    P.add(pln('cb.print', 0.198, 0.138), pr('pcb', 0.45, 0.2), 0, 0.00165, 0, -H);
    P.add(box('cb.chip', 0.03, 0.004, 0.03), SF.black!, -0.04, 0.0036, 0.01);
    for (const [x, z] of [[0.03, -0.03], [0.05, 0.02], [-0.07, -0.04], [0.0, 0.045]] as const) P.add(box('cb.chip2', 0.02, 0.0035, 0.011), SF.black!, x, 0.0034, z);
    for (const [x, z, c] of [[0.075, -0.045, 0x1f3f8a], [0.08, 0.05, 0x161616], [-0.075, 0.05, 0x1f3f8a]] as const) P.add(cyl('cb.cap', 0.0045, 0.0045, 0.012, 10), { color: c, rough: 0.4, metal: 0.2 }, x, 0.0076, z);
    P.add(box('cb.edge', 0.12, 0.0018, 0.008), { color: 0xd8b45a, rough: 0.25, metal: 1 }, 0, 0.0018, 0.066);
  },
  's.flask': (P) => {
    const pewter: Surf = { color: 0xb3b8bc, rough: 0.28, metal: 0.95, tex: 'brushed' };
    P.add(rbox('fk.body', 0.092, 0.024, 0.122, 0.011, 3), pewter, 0, 0.012, 0);
    P.add(rbox('fk.wrap', 0.094, 0.026, 0.05, 0.011, 3), SF.leather!, 0, 0.012, -0.018);
    P.add(cyl('fk.neck', 0.009, 0.01, 0.012, 12), pewter, 0, 0.012, 0.066, H);
    P.add(cyl('fk.cap', 0.0115, 0.0115, 0.012, 14), { color: 0x9da2a6, rough: 0.25, metal: 1 }, 0, 0.012, 0.078, H);
    P.add(box('fk.hinge', 0.006, 0.006, 0.01), pewter, 0.012, 0.012, 0.072);
  },
  's.cassette': (P) => cassette(P, 'face.cassette'),
  's.dogtags': (P) => {
    const tag = extrude('dt.tag', () => {
      const s = roundRectShape(0.028, 0.05, 0.007);
      s.holes.push(new THREE.Path().absarc(0, 0.019, 0.0022, 0, TAU, false));
      return s;
    }, 0.0009);
    const steel: Surf = { color: 0xffffff, rough: 0.42, metal: 0.85, tex: 'tag.dog' };
    P.add(tag, steel, -0.008, 0.00045, 0.006, -H, 0, 0.18);
    P.add(tag, steel, 0.01, 0.00135, -0.002, -H, 0, -0.26);
    P.add(tube('dt.chain', [-0.004, 0.0012, -0.012, -0.02, 0.0012, -0.04, -0.012, 0.0012, -0.075, 0.018, 0.0012, -0.082, 0.032, 0.0012, -0.05, 0.016, 0.0012, -0.016], 0.0011, 64, 4, true), { color: 0x9ea4a9, rough: 0.35, metal: 0.95 });
  },
  's.glasses': (P) => {
    const wire: Surf = { color: 0xc9a24a, rough: 0.3, metal: 1 };
    for (const sx of [-1, 1]) {
      P.add(tor('rg.rim', 0.021, 0.0016, 6, 24), wire, sx * 0.026, 0.023, 0.05);
      P.add(circ('rg.lens', 0.0205, 20), { color: 0xdfe9ee, rough: 0.04, metal: 0.1, opacity: 0.22 }, sx * 0.026, 0.023, 0.05);
      // temples run back nearly level and hook down to the floor (open glasses rest on the rims and the hook tips)
      P.add(cyl('rg.temple', 0.0012, 0.0012, 0.12, 5), wire, sx * 0.0465, 0.0215, -0.01, H - 0.025, 0, 0);
      P.add(cyl('rg.hook', 0.0012, 0.0012, 0.025, 5), wire, sx * 0.0465, 0.011, -0.079, Math.PI / 4, 0, 0);
    }
    P.add(tor('rg.bridge', 0.006, 0.0014, 5, 10, Math.PI), wire, 0, 0.03, 0.05);
  },
  's.buttons': (P) => {
    P.add(lathe('bt.tin', [0, 0, 0.043, 0, 0.045, 0.002, 0.045, 0.022, 0.0455, 0.023], 28), { color: 0x8a2a22, rough: 0.38, metal: 0.6 }, -0.012, 0, 0);
    P.add(lathe('bt.lid', [0.0462, 0.019, 0.0468, 0.02, 0.0468, 0.031, 0.046, 0.0325, 0.044, 0.033, 0, 0.033], 28), { color: 0xc9a24a, rough: 0.3, metal: 1 }, -0.012, 0, 0);
    P.add(circ('bt.print', 0.041, 28), pr('lid.tin', 0.4, 0.3), -0.012, 0.0332, 0, -H);
    const btns: [number, number, number][] = [[0.05, 0.03, 0xe8e0cc], [0.064, -0.012, 0x7a1f1f], [0.04, -0.036, 0x222222], [0.06, 0.012, 0x6b4a2a], [0.036, 0.046, 0xd8d0f0]];
    for (const [x, z, c] of btns) {
      P.add(cyl('bt.btn', 0.0095, 0.0095, 0.003, 14), { color: c, rough: 0.35, metal: 0.05 }, x, 0.0015, z);
      for (const [hx, hz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) P.add(circ('bt.hole', 0.0013, 6), { color: 0x101010, rough: 0.9 }, x + hx * 0.0026, 0.0031, z + hz * 0.0026, -H);
    }
  },
  's.toolchest': (P) => {
    const red: Surf = { color: 0xa32a22, rough: 0.45, metal: 0.6, tex: 'brushed' };
    P.add(rbox('tc.body', 0.4, 0.17, 0.2, 0.01, 2), red, 0, 0.085, 0);
    P.add(rbox('tc.lid', 0.404, 0.05, 0.204, 0.012, 2), red, 0, 0.195, 0);
    P.add(tor('tc.handle', 0.06, 0.008, 6, 16, Math.PI), SF.black!, 0, 0.222, 0);
    for (const x of [-0.15, 0.15]) P.add(rbox('tc.latch', 0.03, 0.04, 0.01, 0.004, 1), SF.chrome!, x, 0.17, 0.104);
  },
  's.jerrycan': (P) => {
    const olive: Surf = { color: 0x4b5a32, rough: 0.55, metal: 0.45, tex: 'brushed' };
    P.add(rbox('jc.body', 0.34, 0.44, 0.16, 0.02, 2), olive, 0, 0.22, 0);
    for (const z of [-0.0815, 0.0815]) for (const a of [-0.62, 0.62]) P.add(rbox('jc.x', 0.4, 0.018, 0.006, 0.0028, 1), olive, 0, 0.21, z, 0, 0, a);
    for (const x of [-0.07, 0, 0.07]) P.add(rbox('jc.grip', 0.022, 0.05, 0.03, 0.006, 1), olive, x, 0.465, 0);
    P.add(rbox('jc.bar', 0.17, 0.015, 0.03, 0.006, 1), olive, 0, 0.495, 0);
    P.add(cyl('jc.spout', 0.022, 0.025, 0.035, 14), { color: 0x3d4a28, rough: 0.5, metal: 0.45 }, 0.12, 0.455, 0);
  },
  's.radio': (P) => {
    const od: Surf = { color: 0x58603f, rough: 0.6, metal: 0.35, tex: 'brushed' };
    P.add(rbox('rd.body', 0.3, 0.14, 0.22, 0.01, 2), od, 0, 0.07, 0);
    P.add(pln('rd.panel', 0.27, 0.12), pr('dial.radio', 0.5), 0, 0.072, 0.1103);
    for (const [x, r] of [[-0.09, 0.016], [0, 0.012], [0.09, 0.016]] as const) P.add(cyl(`rd.knob${r}`, r, r, 0.016, 14), SF.black!, x, 0.035, 0.118, H);
    P.add(tor('rd.handle', 0.07, 0.007, 6, 16, Math.PI), SF.leather!, 0, 0.14, 0);
    P.add(cyl('rd.ant', 0.003, 0.004, 0.16, 6), SF.chrome!, -0.13, 0.22, -0.09);
  },
  's.typewriter': (P) => {
    const enamel: Surf = { color: 0x151515, rough: 0.22, metal: 0.25 };
    P.add(rbox('tw.base', 0.3, 0.035, 0.25, 0.01, 2), enamel, 0, 0.0175, 0);
    P.add(rbox('tw.body', 0.29, 0.075, 0.13, 0.016, 3), enamel, 0, 0.07, -0.055);
    P.add(rbox('tw.deck', 0.26, 0.02, 0.12, 0.006, 2), enamel, 0, 0.045, 0.06, 0.22, 0, 0);
    const cap: Surf = { color: 0xe9e4d4, rough: 0.4 };
    for (let r = 0; r < 4; r++) {
      const n = [9, 10, 10, 9][r]!, z = 0.108 - r * 0.026, y = 0.052 + r * 0.0065;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 0.024 + (r % 2 ? 0.006 : 0);
        P.add(cyl('tw.stem', 0.0028, 0.0028, 0.016, 5), SF.chrome!, x, y, z);
        P.add(cyl('tw.cap', 0.0085, 0.0085, 0.0045, 10), cap, x, y + 0.009, z);
      }
    }
    P.add(rbox('tw.space', 0.15, 0.007, 0.014, 0.003, 1), SF.chrome!, 0, 0.044, 0.135);
    P.add(cyl('tw.platen', 0.019, 0.019, 0.31, 18), SF.rubber!, 0, 0.124, -0.088, 0, 0, H);
    for (const x of [-0.165, 0.165]) P.add(cyl('tw.knob', 0.014, 0.014, 0.016, 14), SF.chrome!, x, 0.124, -0.088, 0, 0, H);
    P.add(box('tw.paper', 0.2, 0.15, 0.0012), pr('paper.typed', 0.9), 0, 0.2, -0.104, -0.28, 0, 0);
    P.add(cyl('tw.lever', 0.003, 0.003, 0.075, 6), SF.chrome!, -0.13, 0.152, -0.06, 0, 0, 1.1);
    for (const x of [-0.08, 0.08]) P.add(cyl('tw.spool', 0.022, 0.022, 0.008, 16), { color: 0x5a1414, rough: 0.6 }, x, 0.112, -0.035);
    P.add(pln('tw.decal', 0.09, 0.022), pr('decal.typewriter', 0.3, 0.3), 0, 0.088, 0.0106);
  },
  's.medcase': (P) => {
    const alu: Surf = { color: 0xc4c9ce, rough: 0.34, metal: 0.85, tex: 'brushed' };
    P.add(rbox('mc.body', 0.32, 0.1, 0.22, 0.012, 3), alu, 0, 0.05, 0);
    P.add(rbox('mc.rib', 0.324, 0.012, 0.224, 0.005, 2), { ...alu, color: 0x9ca2a8 }, 0, 0.062, 0);
    P.add(circ('mc.cross', 0.052, 28), pr('cross.medical', 0.5), 0, 0.1006, 0, -H);
    P.add(tor('mc.handle', 0.032, 0.006, 6, 14, Math.PI), SF.rubber!, 0, 0.058, 0.111, H);
    for (const x of [-0.1, 0.1]) P.add(rbox('mc.latch', 0.022, 0.026, 0.008, 0.003, 1), SF.chrome!, x, 0.062, 0.113);
  },
  's.fusebox': (P) => {
    const grey2: Surf = { color: 0x7b8085, rough: 0.5, metal: 0.6, tex: 'brushed' };
    P.add(rbox('fb.box', 0.3, 0.11, 0.4, 0.008, 2), grey2, 0, 0.055, 0);
    P.add(rbox('fb.door', 0.27, 0.008, 0.37, 0.003, 1), { ...grey2, color: 0x8a9095 }, 0, 0.113, 0);
    P.add(pln('fb.warn', 0.08, 0.055), pr('label.hazard', 0.5), 0, 0.1175, 0.09, -H);
    P.add(rbox('fb.handle', 0.016, 0.012, 0.05, 0.004, 1), SF.black!, 0.11, 0.122, 0);
    for (const x of [-0.08, 0.08]) P.add(cyl('fb.conduit', 0.012, 0.012, 0.04, 10), SF.dsteel!, x, 0.055, -0.215, H);
  },
  's.lamp': (P) => {
    const brass = SF.brass!;
    P.add(lathe('hl.fount', [0, 0, 0.05, 0, 0.056, 0.012, 0.058, 0.03, 0.05, 0.05, 0.032, 0.06, 0.03, 0.066, 0, 0.066], 22), brass);
    P.add(lathe('hl.globe', [0.03, 0.066, 0.042, 0.09, 0.046, 0.13, 0.04, 0.17, 0.028, 0.19], 22), SF.glass!);
    P.add(lathe('hl.cap', [0.03, 0.188, 0.045, 0.2, 0.046, 0.215, 0.03, 0.235, 0.016, 0.25, 0, 0.255], 22), brass);
    for (let i = 0; i < 4; i++) { const a = i * H + Math.PI / 4; P.add(cyl('hl.wire', 0.0018, 0.0018, 0.13, 5), brass, Math.sin(a) * 0.05, 0.13, Math.cos(a) * 0.05); }
    P.add(tor('hl.bail', 0.05, 0.0022, 5, 20, Math.PI), brass, 0, 0.255, 0);
    P.add(cyl('hl.knob', 0.006, 0.006, 0.012, 10), brass, 0.06, 0.055, 0, 0, 0, H);
  },
  's.projector': (P) => {
    const body: Surf = { color: 0x5d6252, rough: 0.5, metal: 0.4, tex: 'brushed' };
    P.add(rbox('pj.body', 0.13, 0.15, 0.26, 0.012, 2), body, 0, 0.075, 0);
    P.add(cyl('pj.lens', 0.022, 0.026, 0.07, 18), SF.chrome!, 0, 0.085, 0.165, H);
    P.add(circ('pj.glass', 0.019, 16), SF.darkGlass!, 0, 0.085, 0.2005);
    for (const z of [0.08, -0.09]) {
      P.add(cyl('pj.arm', 0.006, 0.006, 0.13, 8), SF.dsteel!, 0.045, 0.2, z * 0.6, 0.3 * Math.sign(z), 0, 0);
      P.add(cyl('pj.reel', 0.085, 0.085, 0.012, 28), { color: 0x2b2b2b, rough: 0.4, metal: 0.6 }, 0.055, 0.27, z, 0, 0, H);
      P.add(cyl('pj.hub', 0.02, 0.02, 0.02, 12), SF.chrome!, 0.055, 0.27, z, 0, 0, H);
    }
  },
  's.bonds': (P) => {
    const sheet: Surf = { color: 0xe6e1cc, rough: 0.85 };
    for (let i = 0; i < 5; i++) P.add(box('bo.sheet', 0.22, 0.0022, 0.15), sheet, ((i % 3) - 1) * 0.002, 0.0011 + i * 0.0023, ((i % 2) - 0.5) * 0.003, 0, i % 2 ? 0.02 : -0.025, 0);
    P.add(box('bo.sheet', 0.22, 0.0022, 0.15), sheet, 0, 0.0011 + 5 * 0.0023, 0);
    P.add(pln('bo.top', 0.218, 0.148), pr('bonds.cert', 0.8), 0, 0.01395, 0, -H);
    P.add(box('bo.band', 0.04, 0.0165, 0.153), { color: 0x9b7a4a, rough: 0.9, tex: 'paper' }, 0.062, 0.0072, 0);
  },
  's.blades': (P) => {
    const frame: Surf = { color: 0x2a2d30, rough: 0.5, metal: 0.65, tex: 'brushed' };
    const W = 0.46, D = 0.38, HH = 0.36;
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) P.add(box('sb.post', 0.022, HH, 0.022), frame, x * (W / 2 - 0.011), HH / 2, z * (D / 2 - 0.011));
    P.add(rbox('sb.plate', W, 0.016, D, 0.005, 1), frame, 0, 0.008, 0);
    P.add(rbox('sb.plate', W, 0.016, D, 0.005, 1), frame, 0, HH - 0.008, 0);
    const blade: Surf = { color: 0x40464c, rough: 0.45, metal: 0.55 };
    for (let i = 0; i < 9; i++) {
      const x = -0.18 + i * 0.045;
      if (i === 6) { P.add(box('sb.dark', 0.04, 0.3, 0.01), { color: 0x050505, rough: 0.9 }, x, 0.18, -0.16); continue; }
      P.add(box('sb.blade', 0.04, 0.3, D - 0.04), blade, x, 0.18, -0.005);
      P.add(pln('sb.face', 0.038, 0.296), pr('panel.blade', 0.5, 0.3), x, 0.18, (D - 0.04) / 2 - 0.005 + 0.0006);
    }
  },
  's.coil': (P) => {
    const board: Surf = { color: 0x3a2a1e, rough: 0.7, tex: 'grain' };
    P.add(cyl('gc.flange', 0.14, 0.14, 0.022, 28), board, 0, 0.011, 0);
    P.add(cyl('gc.flange', 0.14, 0.14, 0.022, 28), board, 0, 0.349, 0);
    P.add(cyl('gc.core', 0.052, 0.052, 0.4, 18), SF.dsteel!, 0, 0.2, 0);
    P.add(cyl('gc.wind', 0.1, 0.1, 0.316, 28), { color: 0xa8652e, rough: 0.35, metal: 1 }, 0, 0.18, 0);
    P.add(coil('gc.helix', 0.106, 13, 0.3, 0.0085, 22, 6), SF.copper!, 0, 0.03, 0);
    for (const x of [-0.06, 0.06]) P.add(cyl('gc.term', 0.007, 0.007, 0.03, 8), SF.brass!, x, 0.375, 0.07);
    P.add(tube('gc.lead', [0.106, 0.33, 0, 0.1, 0.36, 0.04, 0.06, 0.375, 0.07], 0.004, 12, 5), SF.copper!);
  },
  's.depositbox': (P) => {
    const st: Surf = { color: 0x8e959b, rough: 0.36, metal: 0.85, tex: 'brushed' };
    P.add(rbox('db.body', 0.26, 0.12, 0.56, 0.008, 2), st, 0, 0.06, 0);
    P.add(rbox('db.lid', 0.262, 0.014, 0.5, 0.005, 1), { ...st, color: 0x9aa1a7 }, 0, 0.126, -0.025);
    P.add(rbox('db.front', 0.258, 0.11, 0.012, 0.004, 1), { ...st, color: 0x7d848a }, 0, 0.061, 0.279);
    P.add(pln('db.plate', 0.085, 0.042), pr('plate.deposit', 0.32, 1), 0, 0.078, 0.2856);
    P.add(tor('db.pull', 0.026, 0.005, 6, 14, Math.PI), SF.chrome!, 0, 0.035, 0.2856, H);
    P.add(box('db.hinge', 0.24, 0.01, 0.012), SF.dsteel!, 0, 0.126, -0.278);
  },
  's.bust': (P) => {
    // a bronze head-and-shoulders bust on a square marble plinth
    const br: Surf = { color: 0x8c6239, rough: 0.42, metal: 1, tex: 'speckle' };
    P.add(lathe('bu.plinth', [0, 0, 0.085, 0, 0.085, 0.014, 0.072, 0.024, 0.062, 0.07, 0.07, 0.08, 0, 0.08], 4, 0, Math.PI / 4), { color: 0xd8d4cc, rough: 0.4, tex: 'speckle' });
    // broad shoulders (a lathe flattened front to back), a neck, the head with nose, chin and ears
    P.add(lathe('bu.torso', [0.07, 0, 0.115, 0.012, 0.13, 0.05, 0.128, 0.085, 0.112, 0.11, 0.07, 0.128, 0.04, 0.136, 0, 0.138], 22), br, 0, 0.08, 0, 0, 0, 0, 1, 1, 0.52);
    P.add(cyl('bu.neck3', 0.028, 0.034, 0.07, 14), br, 0, 0.245, 0.004, 0.1, 0, 0);
    P.add(sph('bu.head', 1, 18, 14), br, 0, 0.318, 0.012, 0, 0, 0, 0.05, 0.064, 0.058);
    P.add(cyl('bu.nose', 0.002, 0.008, 0.02, 6), br, 0, 0.317, 0.072, H);
    P.add(sph('bu.chin', 0.022, 10, 8), br, 0, 0.283, 0.04, 0, 0, 0, 1, 0.7, 0.8);
    for (const sx of [-1, 1]) P.add(sph('bu.ear', 0.012, 8, 6), br, sx * 0.049, 0.318, 0.005, 0, 0, 0, 0.4, 1, 0.8);
  },
  's.cryo': (P) => {
    const st: Surf = { color: 0xb7bcc1, rough: 0.28, metal: 0.92, tex: 'brushed' };
    P.add(lathe('cr.body', [0, 0, 0.11, 0, 0.12, 0.008, 0.123, 0.03, 0.123, 0.46, 0.118, 0.5, 0.09, 0.54, 0.055, 0.56, 0.05, 0.575, 0.05, 0.59, 0, 0.59], 28), st);
    P.add(cyl('cr.label', 0.1238, 0.1238, 0.13, 28, true, -1.4, 2.8), pr('label.cryo', 0.4), 0, 0.27, 0);
    P.add(cyl('cr.cap', 0.058, 0.058, 0.035, 20), { color: 0x2f5d8a, rough: 0.45 }, 0, 0.605, 0);
    P.add(cyl('cr.knob', 0.02, 0.024, 0.02, 14), { color: 0x25486b, rough: 0.5 }, 0, 0.632, 0);
    for (const sx of [-1, 1]) P.add(tor('cr.handle', 0.038, 0.0065, 6, 14, Math.PI), st, sx * 0.085, 0.535, 0, 0, sx > 0 ? -H : H, 0);
    P.add(tor('cr.foot', 0.112, 0.008, 6, 32), SF.rubber!, 0, 0.006, 0, H);
  },
  // generic tier shapes for salvage names without a model (never a box)
  'loot.small': (P) => {
    // a bundle tied up in a red cloth: a squat lump, the knot on top and the cloth's four corners sticking out
    const cloth: Surf = { color: 0x8e3a2e, rough: 0.95, tex: 'weave' };
    P.add(sph('ls.bundle2', 1, 16, 10), cloth, 0, 0.03, 0, 0, 0, 0, 0.065, 0.031, 0.056);
    P.add(sph('ls.knot', 0.012, 10, 8), { ...cloth, color: 0x7a3026 }, 0, 0.062, 0, 0, 0, 0, 1.2, 0.8, 1);
    for (let i = 0; i < 4; i++) {
      const a = i * H + 0.5;
      P.add(cyl('ls.corner', 0.0015, 0.012, 0.03, 6), cloth, Math.sin(a) * 0.012, 0.068, Math.cos(a) * 0.012, Math.cos(a) * 0.85, 0, -Math.sin(a) * 0.85);
    }
  },
  'loot.medium': (P) => {
    P.add(lathe('lm.sack', [0, 0, 0.08, 0.004, 0.11, 0.03, 0.12, 0.08, 0.112, 0.14, 0.09, 0.18, 0.05, 0.205, 0.035, 0.215, 0.042, 0.235, 0.05, 0.25, 0.03, 0.255, 0, 0.256], 18), SF.burlap!, 0, 0, 0, 0, 0, 0, 1.05, 1, 0.9);
    P.add(tor('lm.tie', 0.037, 0.006, 6, 18), { color: 0x6b5232, rough: 0.9 }, 0, 0.212, 0, H);
  },
  'loot.heavy': (P) => {
    const paint2: Surf = { color: 0x34495e, rough: 0.55, metal: 0.6, tex: 'brushed' };
    P.add(lathe('lh.drum', [0, 0, 0.17, 0, 0.18, 0.01, 0.18, 0.43, 0.17, 0.44, 0, 0.44], 28), paint2);
    for (const y of [0.14, 0.3]) P.add(tor('lh.hoop', 0.181, 0.006, 6, 36), paint2, 0, y, 0, H);
    P.add(cyl('lh.bung', 0.02, 0.02, 0.01, 12), SF.dsteel!, 0.09, 0.445, 0.02);
    P.add(pln('lh.label', 0.12, 0.08), pr('label.hazard', 0.5), 0, 0.24, 0.1805);
  },
  // ---------------------------------------------------------------- curios (a per-name centrepiece, most under the jar)
  'loot.curio': (P) => {
    bellJar(P);
    P.add(g('cu.obj', () => new THREE.TorusKnotGeometry(0.022, 0.007, 48, 6)), { color: 0xc99b45, rough: 0.28, metal: 1, emissive: 0x5a3a08, ei: 0.8 }, 0, 0.06, 0);
  },
  'c.pen': (P) => {
    bellJar(P);
    P.add(box('cp.stand', 0.07, 0.008, 0.024), SF.walnut!, 0, 0.029, 0);
    P.add(cyl('cp.barrel', 0.0042, 0.0042, 0.07, 12), curioGlow({ color: 0x141414, rough: 0.15, metal: 0.2 }), -0.008, 0.038, 0, 0, 0.5, H);
    P.add(cyl('cp.cap', 0.0047, 0.0047, 0.036, 12), curioGlow(SF.gold!), 0.026, 0.038, -0.02, 0, 0.5, H);
    P.add(cyl('cp.nib', 0.0005, 0.0038, 0.014, 8), curioGlow(SF.gold!), -0.046, 0.038, 0.02, 0, 0.5, H);
  },
  'c.plaque': (P) => {
    bellJar(P, 0.11);
    P.add(rbox('cq.board', 0.07, 0.09, 0.009, 0.003, 1), SF.walnut!, 0, 0.074, 0, -0.14, 0, 0);
    P.add(pln('cq.plate', 0.056, 0.064), curioGlow(pr('plaque.employee', 0.3, 1)), 0, 0.075, 0.0055, -0.14, 0, 0);
    P.add(box('cq.foot', 0.05, 0.006, 0.03), SF.walnut!, 0, 0.028, -0.004);
  },
  'c.snowglobe': (P) => {
    P.add(lathe('sg.base', [0, 0, 0.046, 0, 0.048, 0.008, 0.044, 0.026, 0.038, 0.032, 0, 0.032], 24), SF.walnut!);
    P.add(pln('sg.label', 0.05, 0.016), pr('face.snowglobe', 0.4), 0, 0.016, 0.0462, -0.22, 0, 0);
    P.add(cyl('sg.snow', 0.036, 0.036, 0.004, 20), { color: 0xf4f6f8, rough: 0.9 }, 0, 0.034, 0);
    P.add(rbox('sg.van', 0.042, 0.022, 0.02, 0.004, 1), curioGlow({ color: 0xe8e6df, rough: 0.4 }), 0, 0.048, 0);
    for (const [x, z] of [[-0.013, 0.01], [0.013, 0.01], [-0.013, -0.01], [0.013, -0.01]] as const) P.add(cyl('sg.wheel', 0.0045, 0.0045, 0.004, 8), SF.black!, x, 0.04, z, H, 0, 0);
    P.add(sph('sg.globe', 0.05, 20, 14), SF.glass!, 0, 0.068, 0);
  },
  'c.doll': (P) => {
    bellJar(P, 0.11);
    P.add(cyl('cd.dress', 0.008, 0.027, 0.052, 14), { color: 0xd9a3b0, rough: 0.8, tex: 'weave' }, 0, 0.051, 0);
    P.add(sph('cd.head', 0.0145, 14, 10), curioGlow(SF.porcelain!), 0, 0.09, 0);
    P.add(sph('cd.hair', 0.0152, 14, 8, 0, TAU, 0, 1.6), { color: 0x5a3a20, rough: 0.7 }, 0, 0.0912, -0.002);
    for (const sx of [-1, 1]) {
      P.add(cyl('cd.arm', 0.003, 0.004, 0.032, 6), SF.porcelain!, sx * 0.013, 0.064, 0, 0, 0, sx * 0.5);
      P.add(sph('cd.eye', 0.0024, 6, 4), { color: 0x1a2a4a, rough: 0.1 }, sx * 0.005, 0.092, 0.0135);
    }
  },
  'c.musicbox': (P) => {
    const box2: Surf = { ...SF.walnut!, color: 0x6a4228 };
    P.add(rbox('mb.box', 0.1, 0.048, 0.07, 0.004, 1), box2, 0, 0.024, 0);
    P.add(box('mb.velvet', 0.09, 0.002, 0.06), SF.velvet!, 0, 0.0475, 0);
    P.add(rbox('mb.lid', 0.1, 0.008, 0.07, 0.003, 1), box2, 0, 0.082, -0.04, -1.95, 0, 0);
    P.add(cyl('mb.drum', 0.008, 0.008, 0.06, 14), curioGlow(SF.brass!), -0.008, 0.054, 0.005, 0, 0, H);
    P.add(box('mb.comb', 0.05, 0.003, 0.012), curioGlow(SF.steel!), -0.008, 0.053, 0.02);
    P.add(cyl('mb.crank', 0.0025, 0.0025, 0.02, 6), SF.brass!, 0.058, 0.03, 0.01, 0, 0, H);
    P.add(cyl('mb.ballerina', 0.003, 0.012, 0.02, 10), { color: 0xf0d0dc, rough: 0.5 }, 0.03, 0.06, 0.012);
    P.add(sph('mb.head', 0.0045, 8, 6), SF.porcelain!, 0.03, 0.074, 0.012);
  },
  'c.dashcam': (P) => {
    cassette(P, 'face.dashcam');
    P.add(rbox('dc.bag', 0.124, 0.02, 0.09, 0.006, 2), { color: 0xe8eef2, rough: 0.12, metal: 0.05, opacity: 0.22 }, 0, 0.01, 0);
    P.add(pln('dc.tag', 0.04, 0.026), pr('paper', 0.9), 0.07, 0.0011, 0.04, -H, 0, 0.3);
  },
  'c.tooth': (P) => {
    bellJar(P);
    // a gold molar on a velvet cushion, big enough to read under the glass (a prize, shown off)
    P.add(rbox('ct.cushion', 0.056, 0.016, 0.056, 0.007, 2), SF.velvet!, 0, 0.033, 0);
    const gold: Surf = { color: 0xe6be52, rough: 0.14, metal: 1, emissive: 0x6a4a10, ei: 0.5 };
    P.add(lathe('ct.crown', [0, 0, 0.007, 0, 0.0095, 0.006, 0.0098, 0.012, 0.007, 0.016, 0, 0.0155], 14), gold, 0, 0.046, 0, 0, 0, 0, 1.9, 1.7, 1.7);
    for (const sx of [-1, 1]) P.add(cyl('ct.root', 0.004, 0.0015, 0.014, 6), gold, sx * 0.007, 0.043, 0, 0, 0, sx * 0.3);
  },
  'c.planchette': (P) => {
    const heart = extrude('op.heart', () => {
      const s = new THREE.Shape();
      s.moveTo(0, -0.068);
      s.bezierCurveTo(0.03, -0.035, 0.058, 0.0, 0.052, 0.03);
      s.bezierCurveTo(0.046, 0.06, 0.012, 0.064, 0, 0.042);
      s.bezierCurveTo(-0.012, 0.064, -0.046, 0.06, -0.052, 0.03);
      s.bezierCurveTo(-0.058, 0.0, -0.03, -0.035, 0, -0.068);
      s.holes.push(new THREE.Path().absarc(0, 0.012, 0.015, 0, TAU, true));
      return s;
    }, 0.01);
    P.add(heart, curioGlow({ color: 0xb08860, rough: 0.5, tex: 'grain' }), 0, 0.015, 0, -H, 0, Math.PI);
    P.add(tor('op.ring', 0.0155, 0.002, 6, 20), curioGlow(SF.brass!), 0, 0.02, -0.012, H);
    P.add(circ('op.lens', 0.0145, 18), { color: 0xdfe9ee, rough: 0.04, metal: 0.1, opacity: 0.25 }, 0, 0.0205, -0.012, -H);
    for (const [x, z] of [[0, 0.058], [-0.036, -0.03], [0.036, -0.03]] as const) P.add(cyl('op.foot', 0.0045, 0.0045, 0.01, 8), { color: 0x2a2a2a, rough: 0.9 }, x, 0.005, z);
  },
  'c.manual': (P) => {
    P.add(rbox('sm.book', 0.15, 0.012, 0.21, 0.002, 1), { color: 0xe8e2cc, rough: 0.85 }, 0, 0.006, 0);
    P.add(pln('sm.cover', 0.148, 0.208), curioGlow(pr('cover.manual', 0.7)), 0, 0.01205, 0, -H);
    P.add(box('sm.spine', 0.008, 0.0125, 0.21), { color: 0x141414, rough: 0.6 }, -0.073, 0.00625, 0);
  },
  'c.owl': (P) => {
    bellJar(P, 0.15);
    P.add(cyl('ow.perch', 0.006, 0.007, 0.085, 8), SF.oak!, 0, 0.05, 0, 0, 0, H);
    P.add(cyl('ow.post', 0.005, 0.006, 0.026, 8), SF.oak!, 0, 0.037, 0);
    const fe: Surf = { color: 0x5a4028, rough: 0.92, tex: 'speckle', emissive: 0x2a1a08, ei: 0.3 };
    P.add(sph('ow.body', 1, 14, 10), fe, 0, 0.09, 0, 0.12, 0, 0, 0.028, 0.042, 0.026);
    P.add(sph('ow.head', 0.024, 14, 10), fe, 0, 0.138, 0.004);
    P.add(circ('ow.face', 0.019, 18), { color: 0xd8c8a8, rough: 0.9, tex: 'speckle' }, 0, 0.138, 0.0262);
    for (const sx of [-1, 1]) {
      P.add(sph('ow.eye', 0.0058, 10, 8), { color: 0xd08a1a, rough: 0.08, metal: 0.1 }, sx * 0.0085, 0.141, 0.027);
      P.add(cyl('ow.tuft', 0.0008, 0.005, 0.014, 6), fe, sx * 0.014, 0.162, 0.004, 0, 0, -sx * 0.4);
    }
    P.add(cyl('ow.beak', 0.0008, 0.003, 0.008, 6), { color: 0x3a3022, rough: 0.5 }, 0, 0.132, 0.031, H + 0.3, 0, 0);
  },
  'c.wax': (P) => {
    P.add(cyl('wx.tube', 0.028, 0.028, 0.11, 18), { color: 0xa8865a, rough: 0.9, tex: 'paper' }, -0.022, 0.055, 0);
    P.add(cyl('wx.label', 0.0283, 0.0283, 0.05, 18, true, -1.3, 2.6), pr('label.wax', 0.85), -0.022, 0.062, 0);
    P.add(cyl('wx.lid', 0.0292, 0.0292, 0.016, 18), { color: 0x8a6a42, rough: 0.85 }, 0.04, 0.0292, 0.025, H, 0, 0);
    P.add(lathe('wx.cyl', [0.024, 0, 0.024, 0.1], 20, 0.004), curioGlow({ color: 0x4a2a14, rough: 0.3, metal: 0.1, tex: 'brushed' }), 0.035, 0.024, -0.04, 0, 0.3, H);
  },
  'c.helmet': (P) => {
    const br: Surf = curioGlow({ color: 0xb5893a, rough: 0.35, metal: 1, tex: 'speckle' });
    P.add(lathe('dh.shell', [0, 0, 0.15, 0, 0.152, 0.02, 0.13, 0.05, 0.12, 0.08, 0.135, 0.12, 0.14, 0.2, 0.125, 0.27, 0.09, 0.33, 0.04, 0.355, 0, 0.36], 28), br);
    P.add(tor('dh.port', 0.046, 0.011, 8, 24), br, 0, 0.2, 0.128);
    P.add(circ('dh.glass', 0.042, 22), SF.darkGlass!, 0, 0.2, 0.124);
    for (const sx of [-1, 1]) {
      P.add(tor('dh.side', 0.032, 0.009, 8, 20), br, sx * 0.128, 0.2, 0.02, 0, sx * H, 0);
      P.add(circ('dh.sglass', 0.029, 18), SF.darkGlass!, sx * 0.1255, 0.2, 0.02, 0, sx * H, 0);
    }
    for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; P.add(sph('dh.bolt', 0.007, 6, 5), SF.brass!, Math.sin(a) * 0.145, 0.03, Math.cos(a) * 0.145); }
  },
};
function cassette(P: Parts, face: string): void {
  P.add(rbox('ct.body', 0.1, 0.012, 0.064, 0.003, 1), { color: 0x1a1a1a, rough: 0.45, metal: 0.05 }, 0, 0.006, 0);
  P.add(pln('ct.face', 0.096, 0.06), pr(face, 0.45), 0, 0.01205, 0, -H);
}
/** v1.3 F3 noise lure: a wind-up tin noisemaker (the workbench art): dark tin, a hazard label, a grille, a brass winding
 *  key on top and a red LED that blinks while it is armed (a separate mesh then, plus a faint red floor halo) */
function lureParts(P: Parts, LED: Parts, armed: boolean, out: BuildOut): void {
  const tin: Surf = { color: 0x3a3226, rough: 0.48, metal: 0.65, tex: 'brushed' };
  P.add(rbox('lu.body', 0.08, 0.058, 0.06, 0.009, 2), tin, 0, 0.029, 0);
  // the amber band glints faintly (it reads at a flashlight's edge on a dark floor, like the keycards)
  P.add(rbox('lu.band', 0.082, 0.012, 0.062, 0.004, 1), { color: 0xf0b43c, rough: 0.45, metal: 0.3, emissive: 0xf0a020, ei: 0.35 }, 0, 0.046, 0);
  P.add(pln('lu.label', 0.05, 0.026), pr('label.hazard', 0.5), 0, 0.022, 0.0302);
  P.add(pln('lu.grille', 0.04, 0.03), pr('grill', 0.85), 0.0402, 0.026, 0, 0, H, 0);
  P.add(cyl('lu.stem', 0.0032, 0.0032, 0.014, 8), SF.brass!, 0, 0.064, -0.008);
  P.add(rbox('lu.key', 0.034, 0.012, 0.004, 0.003, 1), SF.brass!, 0, 0.076, -0.008);
  P.add(tor('lu.keyring', 0.0075, 0.0018, 5, 12), SF.brass!, -0.012, 0.076, -0.008);
  P.add(tor('lu.keyring', 0.0075, 0.0018, 5, 12), SF.brass!, 0.012, 0.076, -0.008);
  (armed ? LED : P).add(sph('lu.led', 0.0045, 8, 6), armed ? { color: 0xff5040, emissive: 0xff2010, ei: 9 } : { color: 0x401412, rough: 0.4 }, 0.03, 0.061, 0.022);
  if (armed) out.hg = haloGeometry('lu', [{ w: 0.62, color: 0xff3020, a: 0.26, y: 0 }], [0, 0.006, 0]);
}
/** v1.3 F3 field receiver: a handheld receiver (the workbench art): a dark body, a lit teal tuning display over the
 *  frequency band print, a speaker grille, a dial and a whip antenna with a teal tip */
function receiverParts(P: Parts): void {
  P.add(rbox('rc.body', 0.075, 0.13, 0.04, 0.008, 2), { color: 0x1d2326, rough: 0.55, metal: 0.15, tex: 'leather' }, 0, 0.065, 0);
  P.add(rbox('rc.screen', 0.052, 0.024, 0.003, 0.0012, 1), { color: 0x0b1513, rough: 0.2, metal: 0.1, emissive: 0x62e0c4, ei: 1.1 }, 0, 0.104, 0.0205);
  P.add(pln('rc.band', 0.054, 0.016), pr('dial.radio', 0.5), 0, 0.083, 0.0202);
  P.add(pln('rc.grille', 0.054, 0.04), pr('grill', 0.85), 0, 0.045, 0.0202);
  P.add(cyl('rc.dial', 0.0095, 0.0095, 0.008, 14), SF.black!, 0.021, 0.134, 0.004);
  P.add(cyl('rc.ant', 0.0022, 0.003, 0.12, 6), SF.chrome!, -0.024, 0.19, -0.006, 0, 0, 0.12);
  P.add(sph('rc.tip', 0.0045, 8, 6), { color: 0x62e0c4, emissive: 0x30ffd0, ei: 2 }, -0.0312, 0.249, -0.006);
  P.add(rbox('rc.clip', 0.03, 0.05, 0.004, 0.0015, 1), SF.dsteel!, 0, 0.09, -0.022);
}
function flareSticks(P: Parts, n: number): void {
  const red: Surf = { color: 0xc8241b, rough: 0.6 };
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 0.038;
    P.add(cyl('fl.stick2', 0.014, 0.014, 0.2, 12), red, x, 0.015, 0.005, H);
    P.add(cyl('fl.wrap', 0.0142, 0.0142, 0.15, 12, true), pr('wrap.flare', 0.65), x, 0.015, 0.02, H, 0, 0);
    P.add(cyl('fl.cap2', 0.0155, 0.0155, 0.03, 12), DARK, x, 0.015, -0.11, H);
    P.add(cyl('fl.striker', 0.01, 0.0155, 0.008, 12), { color: 0x6b4a2a, rough: 0.9 }, x, 0.015, -0.129, H);
  }
}

function withSize(mg: Omit<ModelGeo, 'size'>): ModelGeo {
  const b = new THREE.Box3();
  for (const x of [mg.solid, mg.clear, mg.led]) {
    if (!x) continue;
    x.computeBoundingBox();
    b.union(x.boundingBox!);
  }
  return { ...mg, size: b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3()) };
}

/** the merged geometry of a model (cached per key / variant). Origin = bottom centre, +Z forward. key = the visual key
 *  (v1.2 item models; the type for the v1.2.0 models) */
function modelGeometry(type: string, lit: boolean, vm: boolean, key: string = type, legacy = true): ModelGeo {
  const k = key || type;
  const ck = `${legacy ? 'L' : 'V'}:${k}${type === 'glowstick' && lit ? ':lit' : ''}${type === 'walkie' && vm ? ':vm' : ''}`;
  const have = modelGeos.get(ck);
  if (have) return have;
  const P = new Parts();
  const LED = new Parts();
  const out: BuildOut = { hg: null, glow: false, mg: null };
  const v2 = legacy ? undefined : V2[k];
  if (v2) v2(P, LED, { lit, vm }, out);
  else if (!legacy && k.startsWith('mat.')) out.mg = withSize({ solid: matGeometryV2(k), clear: null, led: null, halo: null, glow: false });
  else legacyParts(legacy ? type : k, lit, vm, P, LED, out);
  const mg = out.mg ?? withSize({ solid: mergeParts(P.solid), clear: mergeParts(P.clear), led: mergeParts(LED.solid), halo: out.hg, glow: out.glow });
  modelGeos.set(ck, mg);
  return mg;
}

// ---------------------------------------------------------------- real models (Poly Haven GLBs via the level's loader)

/** how a real model is found, posed and fitted */
interface PhSpec {
  /** Poly Haven ids of the staged item GLBs: a manifest prop.item_* entry whose source is 'polyhaven:<id>' */
  ph?: string[];
  /** manifest prop keys (without 'prop.') tried after the sources: item_* names, the shipped props */
  keys: string[];
  /** rest pose: 'flat' = the thinnest side down (a no-op when the build already laid it flat), 'asis', or where the
   *  authored +x, +y, +z axes go ('+x' | '-x' | '+y' | ...) */
  pose?: 'flat' | 'asis' | [string, string, string];
  /** body only: the GLB's movable parts left out (the fuse box door stands open) */
  body?: boolean;
  /** keep only this top fraction of the authored model (the gas mask without its 0.8 m hose) */
  clipTop?: number;
  /** longest side (m) at most: an unscaled build shrinks to it */
  maxLen?: number;
  /** marble to bronze when the build left the material unbaked */
  bronze?: boolean;
}
const PH_SPECS: Readonly<Record<string, PhSpec>> = {
  's.watch': { ph: ['pocket_watch', 'vintage_pocket_watch'], keys: ['item_pocket_watch', 'item_watch'], pose: 'flat', maxLen: 0.12 },
  's.camera': { ph: ['vintage_video_camera'], keys: ['item_old_camera', 'item_camera', 'item_video_camera'], pose: 'asis', maxLen: 0.2 },
  's.circuit': { ph: ['circuit_board'], keys: ['item_circuit_board', 'item_circuit'], pose: 'flat', maxLen: 0.24 },
  's.cassette': { ph: ['cassette_player'], keys: ['item_cassette_tape', 'item_cassette'], pose: 'flat', maxLen: 0.12 },
  's.glasses': { ph: ['round_spectacles'], keys: ['item_reading_glasses', 'item_spectacles', 'item_glasses'], pose: 'flat', maxLen: 0.18 },
  's.toolchest': { ph: ['metal_toolbox'], keys: ['item_tool_chest', 'item_toolbox'], pose: 'asis', maxLen: 0.46 },
  's.jerrycan': { ph: ['metal_jerrycan_green'], keys: ['item_jerrycan'], pose: 'asis', maxLen: 0.56 },
  's.radio': { ph: ['vintage_radio_transceiver'], keys: ['item_radio_set', 'item_radio', 'item_transceiver'], pose: 'asis', maxLen: 0.4 },
  's.lamp': { ph: ['Lantern_01', 'lantern_01'], keys: ['item_brass_lamp', 'item_lantern', 'item_lamp'], pose: 'asis', maxLen: 0.34 },
  's.projector': { ph: ['filmstrip_projector_8mm'], keys: ['item_film_projector', 'item_projector'], pose: 'asis', maxLen: 0.64 },
  's.bust': { ph: ['marble_bust_01'], keys: ['item_bronze_bust', 'item_bust'], pose: 'asis', maxLen: 0.56, bronze: true },
  's.gasmask': { keys: ['item_gas_mask', 'gas_mask'], pose: ['+x', '-z', '+y'], clipTop: 0.31, maxLen: 0.36 },
  's.fusebox': { keys: ['item_fuse_box', 'fuse_box'], pose: ['+x', '-z', '+y'], body: true, maxLen: 0.52 },
  crowbar: { keys: ['crowbar'], pose: ['+y', '+z', '+x'] },
  medkit: { keys: ['medical_box'], pose: 'asis' },
  flashlight_pro: { ph: ['signal_flashlight'], keys: ['item_flashlight_pro', 'item_signal_flashlight', 'item_pro_flashlight'], pose: 'asis', maxLen: 0.2 },
  'mat.chem': { ph: ['drain_cleaner'], keys: ['item_chem', 'item_drain_cleaner', 'item_mat_chem'], pose: 'asis', maxLen: 0.2 },
  'mat.optics': { ph: ['magnifying_glass_01'], keys: ['item_optics', 'item_magnifying_glass', 'item_mat_optics'], pose: 'flat', maxLen: 0.28 },
  'mat.relic': { ph: ['carved_wooden_elephant'], keys: ['item_relic', 'item_elephant', 'item_mat_relic'], pose: 'asis', maxLen: 0.14 },
};
/** the real model a visual key would use (null = procedural) */
export function realModelKeys(): readonly string[] { return Object.keys(PH_SPECS); }

/** a loaded real model, ready to place: template meshes (shared geometry + material) under one rest-pose matrix */
export interface ItemTemplate {
  key: string;
  /** manifest prop key (without 'prop.') */
  prop: string;
  meshes: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  /** rest pose x fit scale, grounded: bottom centre at the origin */
  matrix: THREE.Matrix4;
  /** size after the matrix (m) */
  size: THREE.Vector3;
  tris: number;
}
const templates = new Map<string, ItemTemplate>();
const tplListeners = new Set<(key: string) => void>();
const tried = new Set<string>();

const AXES: Readonly<Record<string, [number, number, number]>> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
function restQuat(pose: PhSpec['pose'], size: THREE.Vector3): THREE.Quaternion {
  const q = new THREE.Quaternion();
  if (!pose || pose === 'asis') return q;
  if (pose === 'flat') {
    if (size.y <= size.x && size.y <= size.z) return q;
    return size.z <= size.x ? q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -H) : q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), H);
  }
  const [a, b, c] = pose.map((s) => new THREE.Vector3(...(AXES[s] ?? [0, 0, 0])));
  return q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(a!, b!, c!));
}
/** a copy keeping only the triangles at or above y = cut */
function clipAbove(src: THREE.BufferGeometry, cut: number): THREE.BufferGeometry {
  const gm = src.index ? src.toNonIndexed() : src;
  const pos = gm.attributes.position!;
  const keep: number[] = [];
  for (let t = 0; t + 2 < pos.count; t += 3) if (pos.getY(t) >= cut && pos.getY(t + 1) >= cut && pos.getY(t + 2) >= cut) keep.push(t);
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(gm.attributes)) {
    const a = gm.attributes[name] as THREE.BufferAttribute;
    const k = a.itemSize;
    const arr = new Float32Array(keep.length * 3 * k);
    let o = 0;
    for (const t of keep) for (let i = 0; i < 3; i++) for (let c = 0; c < k; c++) arr[o++] = a.getComponent(t + i, c);
    out.setAttribute(name, new THREE.BufferAttribute(arr, k));
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
const bronzeCache = new WeakMap<THREE.Material, THREE.Material>();
/** the marble bust in bronze (same maps and layout: the same program as every other real item model) */
function bronzeOf(m: THREE.Material): THREE.Material {
  const sm = m as THREE.MeshStandardMaterial;
  if (!sm.isMeshStandardMaterial || sm.metalness > 0.5) return m;
  let b = bronzeCache.get(m);
  if (!b) {
    const c = sm.clone();
    c.color.setHex(0xa77b4f);
    c.metalness = 1;
    c.roughness = 0.6;
    c.name = `${m.name}:bronze`;
    bronzeCache.set(m, (b = c));
  }
  return b;
}
/** normalise a loaded model for placement: clip, tint, rest pose, fit, ground. Null when it holds no mesh. */
export function makeItemTemplate(key: string, prop: string, src: { geometry: THREE.BufferGeometry; material: THREE.Material }[], spec: PhSpec = PH_SPECS[key] ?? { keys: [] }): ItemTemplate | null {
  let meshes = src.filter((m) => !!m.geometry?.attributes?.position && !!m.material);
  if (!meshes.length) return null;
  const bb = new THREE.Box3();
  const bounds = () => {
    bb.makeEmpty();
    for (const m of meshes) { m.geometry.computeBoundingBox(); bb.union(m.geometry.boundingBox!); }
  };
  bounds();
  if (spec.clipTop && spec.clipTop < 1) {
    const cut = bb.max.y - (bb.max.y - bb.min.y) * spec.clipTop;
    meshes = meshes.map((m) => ({ geometry: clipAbove(m.geometry, cut), material: m.material })).filter((m) => m.geometry.attributes.position!.count > 0);
    if (!meshes.length) return null;
    bounds();
  }
  if (spec.bronze) meshes = meshes.map((m) => ({ geometry: m.geometry, material: bronzeOf(m.material) }));
  const R = new THREE.Matrix4().makeRotationFromQuaternion(restQuat(spec.pose, bb.getSize(new THREE.Vector3())));
  const rb = new THREE.Box3(), v = new THREE.Vector3();
  let tris = 0;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position!;
    for (let i = 0; i < pos.count; i++) rb.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(R));
    tris += (m.geometry.index ? m.geometry.index.count : pos.count) / 3;
  }
  const sz = rb.getSize(new THREE.Vector3());
  const L = Math.max(sz.x, sz.y, sz.z);
  const s = spec.maxLen && L > spec.maxLen ? spec.maxLen / L : 1;
  const c = rb.getCenter(new THREE.Vector3());
  const matrix = new THREE.Matrix4().makeTranslation(-c.x * s, -rb.min.y * s, -c.z * s).multiply(new THREE.Matrix4().makeScale(s, s, s)).multiply(R);
  return { key, prop, meshes, matrix, size: sz.multiplyScalar(s), tris: Math.round(tris) };
}
/** tests / tools: install a template as if its GLB had loaded (listeners rebuild the placed items) */
export function registerItemTemplate(t: ItemTemplate | null, key = t?.key ?? ''): void {
  if (!key) return;
  if (t) templates.set(key, t);
  else templates.delete(key);
  for (const fn of tplListeners) fn(key);
}
/** loaded real models (tests, debug) */
export function itemTemplates(): ReadonlyMap<string, ItemTemplate> { return templates; }

/** the manifest prop key of a spec (without 'prop.'), or null: a staged item GLB by its Poly Haven source, else a key */
function propKeyIn(spec: PhSpec, files: Readonly<Record<string, { source?: string }>>): string | null {
  for (const id of spec.ph ?? []) {
    const src = `polyhaven:${id}`;
    for (const k in files) if (k.startsWith('prop.item_') && files[k]!.source === src) return k.slice(5);
  }
  for (const k of spec.keys) if (files[`prop.${k}`]) return k;
  return null;
}
function propKeyFor(spec: PhSpec): string | null {
  const files = getAssetManifest()?.files;
  return files ? propKeyIn(spec, files) : null;
}
/** tests / tools: the manifest prop key a visual key's real model loads from (null = procedural); body = parts dropped */
export function realModelProp(key: string, files: Readonly<Record<string, { source?: string }>>): { prop: string; body: boolean } | null {
  const spec = PH_SPECS[key];
  const prop = spec ? propKeyIn(spec, files) : null;
  return prop && spec ? { prop, body: !!spec.body } : null;
}
interface LevelAssetsLike {
  loadPropModel?: (key: string) => Promise<THREE.Object3D | null>;
  templateInfo?: (tpl: THREE.Object3D | null) => { body: THREE.Mesh[]; full(): THREE.Mesh[] } | null;
}
let assetsMod: Promise<LevelAssetsLike | null> | null = null;
function levelAssets(): Promise<LevelAssetsLike | null> {
  assetsMod ??= import('../level/assets.ts').then((m) => m as unknown as LevelAssetsLike).catch(() => null);
  return assetsMod;
}
/** the meshes of a loaded level template (body + parts merged per material; body only for spec.body) */
function templateMeshes(m: LevelAssetsLike, tpl: THREE.Object3D, body: boolean): { geometry: THREE.BufferGeometry; material: THREE.Material }[] {
  try {
    const info = m.templateInfo?.(tpl);
    if (info) return (body ? info.body : info.full()).map((x) => ({ geometry: x.geometry, material: x.material as THREE.Material }));
  } catch { /* an older level build: walk the root */ }
  const out: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  tpl.updateMatrixWorld(true);
  tpl.traverse((o) => {
    const me = o as THREE.Mesh;
    if (me.isMesh && !Array.isArray(me.material)) out.push({ geometry: me.geometry.clone().applyMatrix4(me.matrixWorld), material: me.material });
  });
  return out;
}
let preloadRun: Promise<void> | null = null;
/** start loading every real item model the manifest has (once per key; each load counts in the level's propsPending,
 *  so the loading screen waits for them) */
export function preloadItemModels(): Promise<void> {
  preloadRun ??= (async () => {
    if (!getAssetManifest()) await loadAssetManifest().catch(() => null);
    const m = await levelAssets();
    if (!m?.loadPropModel) return;
    const loads: Promise<void>[] = [];
    for (const [key, spec] of Object.entries(PH_SPECS)) {
      if (templates.has(key) || tried.has(key)) continue;
      const prop = propKeyFor(spec);
      if (!prop) continue;
      tried.add(key);
      loads.push(m.loadPropModel(prop).catch(() => null).then((tpl) => {
        if (!tpl) return;
        const t = makeItemTemplate(key, prop, templateMeshes(m, tpl, !!spec.body), spec);
        if (t) registerItemTemplate(t);
      }));
    }
    await Promise.all(loads);
  })().finally(() => { preloadRun = null; });
  return preloadRun;
}

// ---------------------------------------------------------------- material layouts (the warm-up's proxies)

const SIG_SKIP = /^(is[A-Z]|_)|^(visible|version|uuid|name|opacity|userData)$/;
const protoKeys = new Map<unknown, string[]>();
/** The render-object cache key of a material as three r186 builds it (RenderObject.getMaterialCacheKey: numbers on /
 *  off except side, textures by mapping + sampler): materials with one signature share a node build and a program. */
export function materialSignature(m: THREE.Material): string {
  let pk = protoKeys.get(m.constructor);
  if (!pk) {
    pk = [];
    for (let p = Object.getPrototypeOf(m); p; p = Object.getPrototypeOf(p)) {
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) if (typeof d.get === 'function') pk.push(k);
    }
    protoKeys.set(m.constructor, pk);
  }
  const rec = m as unknown as Record<string, unknown>;
  let s = `${m.type}:`;
  for (const k of [...Object.keys(m), ...pk]) {
    if (SIG_SKIP.test(k)) continue;
    let v: unknown;
    try { v = rec[k]; } catch { v = null; }
    if (v === null || v === undefined) s += `${v},`;
    else if (typeof v === 'number') s += k === 'side' ? `${v},` : v !== 0 ? '1,' : '0,';
    else if (typeof v === 'object') {
      const t = v as THREE.Texture;
      s += t.isTexture ? `{${t.mapping}${t.magFilter}${t.minFilter}${t.wrapS}${t.wrapT}},` : '{},';
    } else if (typeof v === 'function') s += 'f,';
    else s += `${String(v)},`;
  }
  return s;
}
/** the geometry part of the cache key: attribute names / sizes and the index */
export function geometrySignature(gm: THREE.BufferGeometry): string {
  return Object.keys(gm.attributes).sort().map((n) => {
    const a = gm.attributes[n] as THREE.BufferAttribute;
    return `${n}${a.itemSize}${a.normalized ? 'n' : ''}`;
  }).join(',') + (gm.index ? ',i' : '');
}

// ---------------------------------------------------------------- the item models

const castsOf = (h: number) => h >= CAST_H - 1e-6;
/** tall models that never stand in the world: a bottle lies on its side on the floor and in drawers, and flies when thrown */
const NEVER_CASTS: ReadonlySet<string> = new Set(['bottle']);
/** v1.2 item models: does a model of this key cast (0.3 m or more in height)? */
export function castsFor(key: string, glb = true): boolean {
  const t = glb ? templates.get(key) : undefined;
  if (t) return castsOf(t.size.y);
  if (NEVER_CASTS.has(key)) return false;
  const type = key.startsWith('s.') ? 'loot.medium' : key.startsWith('c.') ? CURIO_TYPE : key;
  return castsOf(modelGeometry(type, false, false, key, false).size.y);
}

export interface BuildOpts {
  lit?: boolean;
  vm?: boolean;
  /** the item's name: salvage and curios pick their model by it */
  name?: string;
  /** the v1.2.0 models (flag itemModels off) */
  legacy?: boolean;
  /** use a loaded real model (default true) */
  glb?: boolean;
}

/** Build a model for an item type: one 'body' mesh (+ 'glass' for clear parts, 'led' for a blinking LED, 'halo' and
 *  'glow' for lit things), or a real model's meshes ('body', under 'pose'). Origin = bottom centre, +Z forward.
 *  vm = the first-person view model variant. userData: key, size (m), glb. */
export function buildItemModel(type: string, opts: BuildOpts = {}): THREE.Group {
  const legacy = !!opts.legacy;
  const key = visualKey({ type, name: opts.name }, legacy);
  const grp = new THREE.Group();
  grp.name = `ix:${type}`;
  grp.userData.key = key;
  const tpl = !legacy && opts.glb !== false ? templates.get(key) : undefined;
  if (tpl) {
    const pose = new THREE.Group();
    pose.name = 'pose';
    pose.matrixAutoUpdate = false;
    pose.matrix.copy(tpl.matrix);
    const cast = !opts.vm && castsOf(tpl.size.y);
    tpl.meshes.forEach((src, i) => {
      const me = new THREE.Mesh(src.geometry, src.material);
      me.name = i === 0 ? 'body' : `body${i + 1}`;
      me.castShadow = cast;
      me.receiveShadow = true;
      pose.add(me);
    });
    grp.add(pose);
    grp.userData.size = tpl.size.clone();
    grp.userData.glb = tpl.prop;
    return grp;
  }
  const mg = modelGeometry(type, !!opts.lit, !!opts.vm, key, legacy);
  const cast = legacy ? ITEM_CASTS.has(type) : !opts.vm && !NEVER_CASTS.has(key) && castsOf(mg.size.y);
  if (mg.solid) {
    const me = new THREE.Mesh(mg.solid, itemMaterial(false));
    me.name = 'body';
    me.castShadow = cast;
    me.receiveShadow = true;
    grp.add(me);
  }
  if (mg.clear) {
    const me = new THREE.Mesh(mg.clear, itemMaterial(true));
    me.name = 'glass';
    me.castShadow = false;
    me.receiveShadow = true;
    grp.add(me);
  }
  if (mg.led) {
    const me = new THREE.Mesh(mg.led, itemMaterial(false));
    me.name = 'led';
    me.castShadow = false;
    me.receiveShadow = true;
    grp.add(me);
  }
  if (mg.halo) {
    const h = new THREE.Mesh(mg.halo.geo, haloMaterial());
    h.position.set(...mg.halo.p);
    h.renderOrder = 2;
    h.name = 'halo';
    grp.add(h);
  }
  if (mg.glow) {
    // upright glow sprite around the burning tip (reads from any angle, flickers)
    const sp = new THREE.Sprite(glowMaterial());
    sp.scale.setScalar(0.55);
    sp.position.set(0, 0.06, 0.11);
    sp.name = 'glow';
    grp.add(sp);
  }
  grp.userData.size = mg.size.clone();
  return grp;
}

// v1.2.0: real prop models for some world items via ② Level's loader (the itemModels flag off; v1.2 item models load
// every real model through preloadItemModels instead). Guarded: absent / failing -> the procedural model stays.
const PROP_FOR: Record<string, string> = { crowbar: 'crowbar', medkit: 'medical_box' };
/** the prop as few meshes as possible: body + parts merged per material when the level split it (1 draw for both GLBs) */
function propModel(key: string): Promise<THREE.Mesh[] | THREE.Object3D | null> {
  return levelAssets().then(async (m) => {
    if (!m?.loadPropModel) return null;
    const tpl = await m.loadPropModel(key).catch(() => null);
    if (!tpl) return null;
    try { const full = m.templateInfo?.(tpl)?.full(); if (full?.length) return full; } catch { /* older level build */ }
    return tpl;
  });
}

/** v1.2 item models: the drawn top (m over the item's y) per world item, for the targeting sphere (targeting.ts) */
const aimTop = new Map<string, number>();
/** v1.2 item models: the targeting sphere's height over an item's y: half its drawn height for tall models, at least
 *  0.1 m (the v1.2.0 offset) */
export function itemAimOffset(id: string): number {
  const t = aimTop.get(id);
  return t === undefined ? 0.1 : Math.max(0.1, t / 2);
}

// ---------------------------------------------------------------- the live flag

let flagRun: Promise<boolean> | null = null;
/** itemModels from the live flags (the server's /healthz copy over the bundled one, as core/flags.ts merges them) when
 *  the caller did not pass it; true without either */
function resolveItemModelsFlag(): Promise<boolean> {
  flagRun ??= (async () => {
    let bundled: Record<string, boolean> = {};
    try { bundled = (await import('../core/config.ts')).bundledFlags(); } catch { /* no Vite (Node tests) */ }
    let live: Record<string, boolean> | null = null;
    try { live = await (await import('../core/flags.ts')).fetchServerFlags({ timeoutMs: 1500 }); } catch { live = null; }
    const v = live && typeof live.itemModels === 'boolean' ? live.itemModels : bundled.itemModels;
    return v !== false;
  })();
  return flagRun;
}

// ---------------------------------------------------------------- the per-crew visuals

export interface HeldView {
  pid: string;
  type: string;
  /** world position of the hand (bone) */
  p: V3;
  /** avatar yaw */
  yaw: number;
}

export interface ThrownView { id: string; p: V3; yaw: number }

export interface Visuals {
  update(st: InteractionState, opts: VisualOpts): void;
  /** remote players' active items, placed at their hands every frame */
  held(list: readonly HeldView[]): void;
  /** play the held-item swing / throw animation */
  animate(kind: 'swing' | 'throw' | 'use'): void;
  /** v1.2 flashbulb: the pooled spot flashes at p along dir */
  flash(p: V3, dir: V3): void;
  /** v1.2: put the first-person view model on this render layer only (null = default layer 0) */
  setFirstPersonLayer(layer: number | null): void;
  /** v1.2 gate P: put every world item / material / glow / flare / thrown / held mesh on this render layer (render's
   *  'detail': drawn by every view, shadowed only by your own beam); null = layer 0 */
  setDetailLayer(layer: number | null): void;
  /** v1.2 test hook: instanced material draws (types with instances) and instance count */
  matStats(): { draws: number; instances: number };
  /** v1.2 test hook: per instanced type, instance 0 in world space + where it projects for the camera */
  matProbe(camera: THREE.Camera): MatProbe[];
  /** v1.2 test hook: draw the world materials as plain meshes instead of instances (a render A/B check) */
  matPlain(on: boolean): void;
  /** v1.2 test hook: what the interaction root would draw now (meshes per pass, shadow casters, the warm set) */
  drawStats(): DrawStats;
  dispose(): void;
}

export interface MatProbe {
  type: string;
  count: number;
  /** every ancestor visible, and the chain reaches a Scene */
  visible: boolean;
  inScene: boolean;
  layers: number;
  p: number[];
  scale: number;
  ndc: number[];
  verts: number;
  radius: number;
}

export interface DrawStats {
  /** world items (non-material) placed / shown after the visible-space cull */
  items: number;
  shown: number;
  /** visible draw objects under the interaction root (meshes with instances, sprites), the warm set excluded */
  draws: number;
  /** of those, shadow casters */
  casters: number;
  /** the pre-warm set is still in the scene; drawn frames counted so far */
  warm: boolean;
  warmFrames: number;
  /** visible meshes of each shown world item (1 = merged; 2 with a clear part) */
  maxMeshesPerItem: number;
  /** thrown projectiles / remote players' held items drawn now */
  thrown: number;
  held: number;
  /** v1.2 item models: the flag, shown items drawn with a real model, loaded real models, warm-up proxies / arms */
  itemModels?: boolean;
  glbShown?: number;
  templates?: number;
  warmProxies?: number;
  warmArms?: number;
}

export interface VisualOpts {
  camera: THREE.PerspectiveCamera;
  activeType: string | null;
  /** v1.2 item models: the active item's name (salvage / curio models); absent = looked up in the state */
  activeName?: string | null;
  showViewModel: boolean;
  /** world item id under the crosshair (glint) */
  targetItem: string | null;
  targetPos: V3 | null;
  /** thrown projectiles from snapshot dyn: id -> pos/yaw */
  thrown: readonly ThrownView[];
  serverNow: number;
  radioTx: boolean;
  dt: number;
  /** the mirrored state's patch counter: structure only re-syncs when it (or the layout) changes */
  version: number;
  /** identity of the current layout (a new one re-places everything); the LevelLayout itself (drawer fit) */
  layoutRef?: unknown;
  /** v1.2: spaces visible from the camera (level.visibleSpaces) and the space of a point; absent = draw everything */
  visibleSpaces?: Set<number> | null;
  spaceAt?: (x: number, z: number) => number;
}

/** the pre-warm ends after this many drawn frames AND this long after its first drawn frame */
const WARM_FRAMES = 3;
const WARM_MS = 500;
/** a warm whose main-camera draws are never seen still ends this long after any draw (a render without that camera) */
const WARM_FALLBACK_MS = 15_000;

interface VmPose { pos: V3; rot: V3; scale: number }
const VM_POSE: Record<string, VmPose> = {
  crowbar: { pos: [0.02, -0.02, 0.02], rot: [-1.1, 0.25, 0.1], scale: 1 },
  bottle: { pos: [0.02, -0.12, 0.02], rot: [0.35, 0.2, 0.25], scale: 0.85 },
  walkie: { pos: [0, -0.06, 0], rot: [0.25, -0.5, 0], scale: 1.1 },
  medkit: { pos: [-0.02, -0.1, -0.05], rot: [0.35, -0.4, 0], scale: 0.8 },
  glowstick: { pos: [0.03, -0.09, 0.02], rot: [0.9, 0.4, 0.3], scale: 0.75 },
  airhorn: { pos: [0, -0.09, 0], rot: [0.9, 0, 0], scale: 1 },
  keycard: { pos: [0, 0, 0], rot: [1.2, 0.1, 0], scale: 1.4 },
  flashlight_pro: { pos: [0.02, -0.06, 0], rot: [0.15, 0.25, 0], scale: 1.2 },
  flare: { pos: [0.03, -0.08, 0.02], rot: [0.9, 0.4, 0.3], scale: 0.85 },
  sensor: { pos: [0, -0.1, 0], rot: [0.6, 0.2, 0], scale: 1.1 },
  syringe: { pos: [0.02, -0.07, 0], rot: [0.5, 0.5, 0.2], scale: 1.4 },
  charm: { pos: [0, -0.07, 0], rot: [0.8, 0.3, 0], scale: 1.4 },
  'loot.idol': { pos: [0, -0.2, -0.03], rot: [0.1, 0.4, 0], scale: 0.85 },
  badge: { pos: [0, 0, 0], rot: [1.2, 0.1, 0], scale: 1.4 },
  battery: { pos: [0.01, -0.07, 0], rot: [0.4, 0.5, 0.1], scale: 1.4 },
  lockpick: { pos: [0.01, -0.06, 0], rot: [0.9, 0.5, 0.15], scale: 1.4 },
  masterkey: { pos: [0.01, -0.04, 0.02], rot: [1.05, 0.25, 0.1], scale: 1.1 },
  soles: { pos: [0, -0.1, -0.02], rot: [0.5, 0.4, 0], scale: 1 },
  nvg: { pos: [0, -0.07, 0], rot: [0.3, 0.6, 0], scale: 1.3 },
  flashbulb: { pos: [0.02, -0.1, 0], rot: [0.15, 0.2, 0], scale: 1.25 },
  'loot.curio': { pos: [0, -0.16, -0.02], rot: [0.15, 0.4, 0], scale: 1.2 },
  // held up a little (the left hand sits behind the inventory row at 16:9): the tin's key, the receiver's display
  lure: { pos: [0.02, -0.05, 0], rot: [0.35, 0.45, 0], scale: 1.25 },
  receiver: { pos: [0, -0.04, 0], rot: [0.22, -0.45, 0], scale: 1 },
};
/** v1.2 item models: view-model poses of the real models (their size and rest frame differ from the procedural ones) */
const VM_GLB: Record<string, VmPose> = {
  crowbar: { pos: [0.02, -0.02, 0.02], rot: [-1.1, 0.25, 0.1], scale: 1.15 },
  medkit: { pos: [-0.02, -0.11, -0.06], rot: [0.4, -0.4, 0], scale: 0.5 },
};
const VM_DEFAULT: VmPose = { pos: [0, -0.1, 0], rot: [0.2, 0.3, 0], scale: 0.7 };
/** a carried thing without its own pose: held low in the left hand, scaled to read at about 0.2 m (small things held
 *  up close, big ones at arm's length) */
function autoVmPose(size: THREE.Vector3 | undefined): VmPose {
  const L = size ? Math.max(size.x, size.y, size.z) : 0.2;
  const s = Math.min(2, Math.max(0.36, 0.2 / Math.max(0.01, L)));
  return { pos: [0.02, -0.13 + Math.max(0, 0.12 - (size?.y ?? 0.1) * s) * 0.3, -0.02], rot: [0.32, 0.45, 0], scale: s };
}

const HELD_TILT: Record<string, V3> = {
  crowbar: [-1.2, 0, 0], bottle: [0.2, 0, 0], glowstick: [-1.3, 0, 0], flashlight_pro: [-0.2, 0, 0], flare: [-1.2, 0, 0],
  syringe: [-1.2, 0, 0], lockpick: [-1.1, 0, 0], masterkey: [-1.3, 0, 0], flashbulb: [-0.3, 0, 0],
};
const NO_TILT: V3 = [0, 0, 0];

/** the view-model pose of a carried item: the real model's own pose, the type's pose for the procedural models that kept
 *  the v1.2.0 shape, else sized to read in the hand (legacy = the v1.2.0 table) */
export function viewModelPose(type: string, key: string, glb: boolean, size: THREE.Vector3 | undefined, legacy = false): VmPose {
  if (legacy) return VM_POSE[type] ?? VM_DEFAULT;
  return (glb ? VM_GLB[key] : undefined) ?? (key === type || key === 'flare.lit' ? VM_POSE[type] : undefined) ?? autoVmPose(size);
}
/** one item for drawerPack: its model size at scale 1, laid on its side (a bottle), the scale before the fit, its yaw
 *  against the part */
export interface PackItem { size: THREE.Vector3; lying: boolean; base: number; rel: number }
/** v1.2 item models: the items of one open part side by side across its width (in the given order): each at its own
 *  size (base, capped by the travel and the height: s = min(base, (w - 0.01)/x, (travel - 0.02)/z, hMax/y)), all
 *  shrunk by one factor only when together they are wider than the part. Per item: the scale and the centre's offset
 *  across the width. A lying bottle's length runs along its own axis (rel decides where that points). */
export function drawerPack(list: readonly PackItem[], w: number, depth: number, hMax: number, gap = 0.012): { scale: number; off: number }[] {
  const ext = list.map((it) => {
    const c = Math.abs(Math.cos(it.rel)), sn = Math.abs(Math.sin(it.rel));
    const fx = it.lying ? it.size.y : it.size.x, fz = it.size.z, fy = it.lying ? Math.max(it.size.x, it.size.z) : it.size.y;
    const ex = c * fx + sn * fz, ez = sn * fx + c * fz;
    return { ex, m: Math.min(it.base, (w - 0.01) / Math.max(1e-4, ex), depth / Math.max(1e-4, ez), hMax / Math.max(1e-4, fy)) };
  });
  const gaps = gap * Math.max(0, list.length - 1);
  const natural = ext.reduce((a, e) => a + e.ex * e.m, 0);
  const f = natural + gaps > w ? Math.max(0.05, (w - gaps) / Math.max(1e-4, natural)) : 1;
  let x = -(natural * f + gaps) / 2;
  return ext.map((e) => {
    const wi = e.ex * e.m * f;
    const off = x + wi / 2;
    x += wi + gap;
    return { scale: Math.max(0.05, e.m * f), off };
  });
}
/** v1.2 item models: the scale of a lone item in an open part (drawerPack of one) */
export function drawerFitScale(size: THREE.Vector3, lying: boolean, base: number, rel: number, w: number, depth: number, hMax: number): number {
  return drawerPack([{ size, lying, base, rel }], w, depth, hMax)[0]!.scale;
}
/** the drawer parts of the v1.2 containers, for tests: the usable width, travel and height of one (desk drawer default) */
export const DESK_DRAWER = { w: 0.411 - 0.04, depth: 0.4 - 0.02, hMax: 0.162 - 0.0155 + 0.05 } as const;

/** an open container part where searched items lie: its slot, width axis (a) and travel axis (t), usable size */
interface DrawerSlot { id: string; slot: V3; ax: number; az: number; tx: number; tz: number; rot: number; w: number; depth: number; hMax: number }
/** GLB inner floors over each drawer's bottom (procgen/containers.ts GLB_FLOOR); procedural drawers: 3 cm */
const DRAWER_FLOOR: Readonly<Record<string, number>> = { cabinet: 0.0585, desk: 0.0155, drawer_chest: 0.0146, nightstand: 0.0026 };
function drawerSlot(c: ContainerInfo, part: ContainerPart): DrawerSlot {
  const rot = c.rot ?? 0, s = Math.sin(rot), co = Math.cos(rot);
  let depth: number, hMax: number;
  if (part.kind === 'drawer' || part.kind === 'tray') {
    depth = part.travel - 0.02;
    hMax = Math.max(0.06, part.size[1] - (DRAWER_FLOOR[c.kind] ?? 0.03)) + 0.05;
  } else if (part.kind === 'lid') { depth = part.size[2] - 0.02; hMax = 0.16; } else { depth = 0.36; hMax = 0.45; }
  return { id: `${c.id}:${part.idx}`, slot: [part.slot[0], part.slot[1], part.slot[2]], ax: co, az: -s, tx: s, tz: co, rot, w: part.size[0] - 0.04, depth, hMax };
}

/** a placed world object: its last placement and the space it stands in (-1 = none: always drawn) */
interface Placed {
  obj: THREE.Group; type: string; key: string; glb: string | null; x: number; y: number; z: number; rot: number; space: number; gen: number; led: THREE.Object3D | null;
  /** v1.2 item models: model size at scale 1 (m), the scale before a drawer fit, the open part it lies in */
  size: THREE.Vector3; base: number; lying: boolean; drawer: DrawerSlot | null; along: number;
  /** the item (or glow) id */
  lid: string;
  /** v1.2 item models: the drawn model's centre on the floor (a lying bottle's middle, a drawer slot's share) */
  vx?: number; vz?: number;
}
interface FlareObj { obj: THREE.Group; space: number; gen: number; x: number; z: number; until: number; k: number; d: number; halo: THREE.Object3D | null; glow: THREE.Object3D | null }
interface RingObj { mesh: THREE.Mesh; until: number; gen: number }

export function createVisuals(scene: THREE.Scene, cfg: { propModels?: boolean; itemModels?: boolean; hideParkedLights?: boolean } = {}): Visuals {
  const root = new THREE.Group();
  root.name = 'interaction';
  scene.add(root);
  // v1.2 item models: the flag (the caller's value, else the live flags); off = the v1.2.0 models
  let modelsOn = cfg.itemModels ?? true;
  let modelsKnown = cfg.itemModels !== undefined;
  let modelsDirty = false;
  if (!modelsKnown) {
    void resolveItemModelsFlag().then((on) => {
      modelsKnown = true;
      if (on !== modelsOn) { modelsOn = on; modelsDirty = true; }
    });
  }
  const glbOk = () => cfg.propModels !== false;
  const tplRev = (key: string): string | null => (modelsOn && glbOk() ? (templates.get(key)?.prop ?? null) : null);
  const items = new Map<string, Placed>();
  const glows = new Map<string, Placed>();
  const flares = new Map<string, FlareObj>();
  const rings = new Map<string, RingObj>();
  const thrown = new Map<string, { obj: THREE.Group; gen: number }>();
  const heldObjs = new Map<string, { type: string; key: string; glb: string | null; obj: THREE.Group; gen: number }>();
  const armedLeds = new Set<THREE.Object3D>();
  let gen = 0;
  let cam: THREE.Camera | null = null;
  // burning flares + their pooled red lights (unshadowed SpotLights pointing down: DynamicLighting batches them, and
  // they exist from the first frame, so lighting a flare never changes the light-type set / recompiles materials)
  const FLARE_LIGHTS = 2;
  const flareLights: THREE.SpotLight[] = [];
  for (let i = 0; i < FLARE_LIGHTS; i++) {
    const l = new THREE.SpotLight(0xff2a14, 0, 11, 1.52, 0.55, 1.5);
    l.castShadow = false;
    l.name = `flare-light-${i}`;
    l.position.set(0, -520 - i, 0);
    l.target.position.set(0, -530 - i, 0);
    root.add(l, l.target);
    flareLights.push(l);
  }
  let lightsParked = true;
  const flareOrder: FlareObj[] = [];
  const byDist = (a: FlareObj, b: FlareObj) => a.d - b.d;
  // v1.2 flashbulb: one pooled unshadowed SpotLight (render reserves the slot), parked and dark until a flash
  const flashLight = new THREE.SpotLight(0xfff4e0, 0, 16, 0.5, 0.35, 1.2);
  flashLight.castShadow = false;
  flashLight.name = 'flashbulb-light';
  flashLight.position.set(0, -540, 0);
  flashLight.target.position.set(0, -550, 0);
  root.add(flashLight, flashLight.target);
  let flashT = -1;
  // v1.3 (plan 4b): a parked (dark) flare or flashbulb light leaves the batched light loop (visible = false). three's
  // DynamicLighting batches unshadowed lights into uniform arrays with a count uniform, so the count drops and no
  // program changes. The lights stay visible until the start-up warm-up is over, so the scene's lights node has built
  // its SpotLight data node with them (its light-type set is kept from then on: hiding them never changes a program).
  // hideParkedLights: false (a renderer without DynamicLighting, where every light is its own program) keeps the v1.2
  // behaviour: always visible, dark while parked.
  const hideLights = cfg.hideParkedLights !== false;
  let lightsSettled = false;
  const parkedVisible = (): boolean => !hideLights || !lightsSettled;
  /** the warm-up is over: every parked light leaves the loop */
  const settleLights = () => {
    if (lightsSettled) return;
    lightsSettled = true;
    for (const l of flareLights) if (l.intensity === 0) l.visible = parkedVisible();
    if (flashT < 0) flashLight.visible = parkedVisible();
  };
  const tmpCam = new THREE.Vector3();
  // view model follows the camera (matrix copied each frame; the camera need not be in the scene)
  const vmRoot = new THREE.Group();
  vmRoot.matrixAutoUpdate = false;
  root.add(vmRoot);
  let fpLayer: number | null = null;
  const applyLayer = (o: THREE.Object3D) => o.traverse((c) => { if (fpLayer === null) c.layers.set(0); else c.layers.set(fpLayer); });
  // the detail layer for world objects: meshes and sprites only (lights stay on layer 0: a camera only collects lights
  // on its own layers; groups need no layer, the renderer walks their children anyway)
  let detail: number | null = null;
  const tagDetail = <T extends THREE.Object3D>(o: T): T => {
    const l = detail ?? 0;
    o.traverse((c) => { if ((c as THREE.Mesh).isMesh || (c as THREE.Sprite).isSprite) c.layers.set(l); });
    return o;
  };
  // v1.2 crafting materials + pouches: one InstancedMesh per type (no shadows; each InstancedMesh is its own program,
  // traversed and built in the first frames even with no instance), compacted to the visible spaces. v1.2 item models:
  // chem / optics / relic switch to their real model when it loads (geometry + a self-lit copy of its material).
  const MAT_CAP = 64;
  const matTypes = [...MATERIAL_TYPES, POUCH_TYPE];
  const matMeshes = new Map<string, THREE.InstancedMesh>();
  const matLists = new Map<string, ItemState[]>();
  /** per type: the uploaded instances as [x, y, z, yaw, ...] (an unchanged compaction skips the upload) */
  const matPrev = new Map<string, number[]>();
  for (const t of matTypes) {
    const im = new THREE.InstancedMesh(matGeometry(t, modelsOn), itemMaterial(false), MAT_CAP);
    im.name = `ix:inst:${t}`;
    im.castShadow = false;
    im.receiveShadow = true;
    im.frustumCulled = false;
    // the matrices change whenever a material is picked up, dropped or a pouch merges: dynamic usage makes the node
    // observer refresh the instance bindings every frame (a pass without a velocity MRT must not keep stale matrices)
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    root.add(im);
    matMeshes.set(t, im);
    matLists.set(t, []);
    matPrev.set(t, []);
  }
  const matGlbGeo = new Map<string, THREE.BufferGeometry>();
  const matGlbMat = new Map<string, THREE.Material>();
  /** the instance model of a material type for the current mode (a real model when loaded) */
  const swapMat = (t: string) => {
    const im = matMeshes.get(t);
    if (!im) return;
    const tpl = modelsOn && glbOk() ? templates.get(t) : undefined;
    if (tpl && tpl.meshes[0]) {
      let gm = matGlbGeo.get(tpl.prop);
      if (!gm) {
        gm = tpl.meshes[0].geometry.clone().applyMatrix4(tpl.matrix);
        gm.computeBoundingBox();
        gm.computeBoundingSphere();
        matGlbGeo.set(tpl.prop, gm);
      }
      let mm = matGlbMat.get(tpl.prop);
      if (!mm) {
        mm = tpl.meshes[0].material.clone();
        const sm = mm as THREE.MeshStandardMaterial;
        // the v1.2.0 materials' faint self-light: a material on a dark floor still reads in a flashlight's edge
        if (sm.emissive) { sm.emissive.set(MATERIAL_COLOR[t] ?? '#888888').multiplyScalar(matGlow(t) * 0.6); sm.emissiveIntensity = 1; }
        mm.name = `ix:mat:${t}`;
        matGlbMat.set(tpl.prop, mm);
      }
      im.geometry = gm;
      im.material = mm;
    } else {
      im.geometry = matGeometry(t, modelsOn);
      im.material = itemMaterial(false);
    }
    matPrev.set(t, []);
  };
  /** test A/B only (matPlain): the same materials as plain meshes */
  const plainGrp = new THREE.Group();
  plainGrp.name = 'ix:mat-plain';
  root.add(plainGrp);
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpP = new THREE.Vector3();
  const tmpS = new THREE.Vector3(1, 1, 1);
  const upY = new THREE.Vector3(0, 1, 0);
  const vmHolder = new THREE.Group();
  vmHolder.position.set(-0.25, -0.25, -0.5); // left hand: ⑤'s flashlight view model is on the right
  vmRoot.add(vmHolder);

  // ---- pre-warm (initial-lag fix): one microscopic mesh per item pipeline right in front of the camera (its own
  // group: never on the first-person layer), drawn during the first frames (join / loading screen) so the pipelines
  // compile there instead of the first time someone picks up a medkit or throws a flare mid-contract. The opaque item
  // mesh and every real-model layout cast (the depth pipelines). It ends after WARM_FRAMES drawn frames AND WARM_MS,
  // and re-arms whenever a real item model brings a material layout the set has not drawn yet. (The material
  // InstancedMeshes warm themselves: each is its own program, built on its first traversal with count 0.)
  const warm = new THREE.Group();
  warm.name = 'ix-warm';
  warm.matrixAutoUpdate = false;
  const warmInner = new THREE.Group();
  warmInner.position.set(0, 0, -0.4);
  warmInner.scale.setScalar(0.0002);
  warm.add(warmInner);
  const warmSigs = new Set<string>();
  const sigOf = (gm: THREE.BufferGeometry, m: THREE.Material, cast: boolean) => `${materialSignature(m)}|${geometrySignature(gm)}|${cast ? 'c' : '-'}`;
  /** a proxy for a layout the warm set lacks (false = already there) */
  const addWarm = (gm: THREE.BufferGeometry, m: THREE.Material, cast: boolean): THREE.Mesh | null => {
    const sig = sigOf(gm, m, cast);
    if (warmSigs.has(sig)) return null;
    warmSigs.add(sig);
    const me = new THREE.Mesh(gm, m);
    me.castShadow = cast;
    me.receiveShadow = true;
    me.frustumCulled = false;
    me.name = 'ix-warm-proxy';
    warmInner.add(tagDetail(me));
    return me;
  };
  const wSolid = addWarm(modelGeometry('keycard', false, false).solid!, itemMaterial(false), true)!;
  addWarm(modelGeometry('syringe', false, false).clear!, itemMaterial(true), false);
  const wHalo = new THREE.Mesh(modelGeometry('glowstick', true, false).halo!.geo, haloMaterial());
  const wGlow = new THREE.Sprite(glowMaterial());
  for (const o of [wHalo, wGlow]) { o.frustumCulled = false; warmInner.add(o); }
  root.add(warm);
  let warmOn = true;
  let warmFrames = 0;
  let warmT0 = 0;
  let warmHit = false;
  let warmAnyAt = 0;
  let warmArms = 1;
  wSolid.onBeforeRender = (_r: unknown, _s: unknown, c: THREE.Camera) => {
    if (c === cam) warmHit = true;
    else if (!warmAnyAt) warmAnyAt = performance.now();
  };
  const tickWarm = (camera: THREE.Camera) => {
    if (!warmOn) return;
    warm.matrix.copy(camera.matrixWorld);
    warm.matrixWorldNeedsUpdate = true;
    const now = performance.now();
    if (warmHit) {
      warmHit = false;
      if (warmFrames++ === 0) warmT0 = now;
    }
    const done = (warmFrames >= WARM_FRAMES && now - warmT0 >= WARM_MS) || (warmFrames === 0 && warmAnyAt > 0 && now - warmAnyAt > WARM_FALLBACK_MS);
    if (!done) return;
    warmOn = false;
    root.remove(warm);
    settleLights();
  };
  /** draw the warm set again (a new material layout arrived) */
  const rearmWarm = () => {
    if (!warmOn) { warmOn = true; root.add(warm); }
    warmFrames = 0; warmT0 = 0; warmHit = false; warmAnyAt = 0;
    warmArms++;
  };

  let vmType: string | null = null;
  let vmKey: string | null = null;
  let vmRev: string | null = null;
  let vmVer = Number.NaN;
  let vmObj: THREE.Group | null = null;
  let vmLed: THREE.Object3D | null = null;
  let vmPose = VM_DEFAULT;
  let anim: { kind: 'swing' | 'throw' | 'use'; t: number } | null = null;
  let bob = 0;
  const glint = new THREE.Mesh(
    paintedShape('glint', () => new THREE.TorusGeometry(0.12, 0.005, 6, 32), { color: 0xffd27a, emissive: 0xffb347, ei: 2.5, opacity: 0.75 }),
    itemMaterial(true),
  );
  glint.rotation.x = -Math.PI / 2;
  glint.visible = false;
  glint.castShadow = false;
  glint.receiveShadow = true;
  root.add(glint);
  const ringGeo = paintedShape('revring', () => new THREE.TorusGeometry(0.55, 0.012, 6, 48), { color: 0xff3b3b, emissive: 0xff2020, ei: 2.2, opacity: 0.8 });

  const shownIn = (vis: Set<number> | null, space: number) => vis === null || space < 0 || vis.has(space);

  // ---- v1.2 item models: open container parts of the current layout (drawer fit)
  let drawerLayout: unknown = null;
  let drawerList: DrawerSlot[] = [];
  const drawersFor = (L: unknown): DrawerSlot[] => {
    if (L === drawerLayout) return drawerList;
    drawerLayout = L;
    drawerList = [];
    const lay = L as LevelLayout | null;
    if (!lay || typeof lay !== 'object' || !Array.isArray(lay.items) || !Array.isArray(lay.spaces)) return drawerList;
    let list: readonly ContainerInfo[] = [];
    try { list = containersOf(lay); } catch { list = []; }
    for (const c of list) {
      const part = c.parts.find((q) => q.idx === c.main) ?? c.parts[0];
      if (part) drawerList.push(drawerSlot(c, part));
    }
    return drawerList;
  };
  /** the open part an item lies in (within its footprint, near its floor), and its offset across the width */
  const drawerAt = (x: number, y: number, z: number, list: DrawerSlot[]): { d: DrawerSlot; along: number } | null => {
    for (const d of list) {
      const dx = x - d.slot[0], dz = z - d.slot[2];
      if (Math.abs(y - d.slot[1]) > 0.08) continue;
      const along = dx * d.ax + dz * d.az, across = dx * d.tx + dz * d.tz;
      if (Math.abs(along) <= d.w / 2 + 0.06 && Math.abs(across) <= d.depth / 2 + 0.06) return { d, along };
    }
    return null;
  };

  // ---- structure (only when the state version, the layout, the visible-space set or the item models change)
  const placeItem = (e: Placed, it: ItemState, drawers: DrawerSlot[]) => {
    const obj = e.obj, p = it.p!;
    const rot = it.rot ?? 0;
    obj.position.set(p[0], p[1], p[2]);
    obj.rotation.set(0, rot, 0);
    obj.scale.setScalar(1);
    e.drawer = null;
    e.lying = false;
    if (!modelsOn) {
      // v1.2.0: lying items: bottles on the floor lie on their side
      if (it.type === 'bottle' && p[1] < 0.05) obj.rotation.z = Math.PI / 2 * 0.98, obj.position.y = 0.04;
      aimTop.delete(it.id);
      return;
    }
    const inDrawer = drawers.length ? drawerAt(p[0], p[1], p[2], drawers) : null;
    // bottles lie on their side on the floor and in drawers (centred on their spot)
    e.lying = e.type === 'bottle' && (p[1] < 0.05 || !!inDrawer);
    const sz = e.size;
    const L = Math.max(sz.x, sz.y, sz.z);
    e.base = isSalvageKey(e.key) && L > 0 && L < MIN_SALVAGE ? MIN_SALVAGE / L : 1;
    if (inDrawer) { e.drawer = inDrawer.d; e.along = inDrawer.along; }
    poseItem(e, p[0], p[1], p[2], rot, e.base);
  };
  /** position / lay down / scale a v1.2 world item at (x, y, z) */
  const poseItem = (e: Placed, x: number, y: number, z: number, rot: number, s: number) => {
    const obj = e.obj;
    obj.scale.setScalar(s);
    e.vx = x; e.vz = z;
    if (e.lying) {
      const len = e.size.y * s, r = Math.max(e.size.x, e.size.z) * 0.5 * s;
      obj.rotation.set(0, rot, Math.PI / 2 * 0.98);
      // the bottle's length runs along local -x once laid down: shift it back over its spot
      obj.position.set(x + Math.cos(rot) * len / 2, y + r, z - Math.sin(rot) * len / 2);
      aimTop.set(e.lid, r * 2);
    } else {
      obj.rotation.set(0, rot, 0);
      obj.position.set(x, y, z);
      aimTop.set(e.lid, e.size.y * s);
    }
  };
  /** v1.2 item models: the items in each open part sit side by side across its width, scaled to fit it */
  const fitDrawers = (st: InteractionState) => {
    const groups = new Map<string, Placed[]>();
    for (const e of items.values()) {
      if (!e.drawer) continue;
      const l = groups.get(e.drawer.id) ?? [];
      l.push(e);
      groups.set(e.drawer.id, l);
    }
    for (const list of groups.values()) {
      const d = list[0]!.drawer!;
      list.sort((a, b) => a.along - b.along || (a.lid < b.lid ? -1 : 1));
      // a bottle lies front to back (along the travel), so it leaves the width to the others
      const placed = list.map((e) => ({ e, it: st.items[e.lid] })).filter((x) => !!x.it?.p).map((x) => ({ ...x, yaw: x.e.lying ? d.rot + H : (x.it!.rot ?? 0) }));
      const fit = drawerPack(placed.map(({ e, yaw }) => ({ size: e.size, lying: e.lying, base: e.base, rel: yaw - d.rot })), d.w, d.depth, d.hMax);
      placed.forEach(({ e, it, yaw }, i) => {
        const f = fit[i]!;
        poseItem(e, d.slot[0] + d.ax * f.off, it!.p![1], d.slot[2] + d.az * f.off, yaw, f.scale);
      });
    }
  };

  const dropItem = (id: string, e: Placed) => {
    root.remove(e.obj);
    if (e.led) armedLeds.delete(e.led);
    items.delete(id);
    aimTop.delete(id);
  };

  const syncItems = (st: InteractionState, spaceAt: VisualOpts['spaceAt'], relayout: boolean, layoutRef: unknown) => {
    const gn = ++gen;
    const legacy = !modelsOn;
    const drawers = legacy ? [] : drawersFor(layoutRef);
    let drawerDirty = false;
    for (const id in st.items) {
      const it = st.items[id]!;
      if (it.where !== 'world' || !it.p) continue;
      if (matMeshes.has(it.type)) continue; // instanced (syncMaterials)
      const mtype = it.type === 'sensor' && it.armed ? 'sensor.armed' : it.type === 'lure' && it.armed ? 'lure.armed' : it.type;
      const key = visualKey({ type: mtype, name: it.name }, legacy);
      const rev = legacy ? null : tplRev(key);
      let e = items.get(id);
      if (e && (e.type !== mtype || e.key !== key || e.glb !== rev)) { dropItem(id, e); e = undefined; }
      if (!e) {
        const obj = tagDetail(buildItemModel(mtype, { name: it.name, legacy, glb: glbOk() }));
        const led = mtype === 'sensor.armed' || mtype === 'lure.armed' ? (obj.getObjectByName('led') ?? null) : null;
        if (led) armedLeds.add(led);
        const size = (obj.userData.size as THREE.Vector3 | undefined) ?? new THREE.Vector3(0.1, 0.1, 0.1);
        const made: Placed = { obj, type: mtype, key, glb: rev, x: NaN, y: NaN, z: NaN, rot: NaN, space: -1, gen: gn, led, size, base: 1, lying: false, drawer: null, along: 0, lid: id };
        e = made;
        root.add(obj);
        items.set(id, made);
        const pk = PROP_FOR[it.type];
        if (legacy && pk && glbOk()) {
          void propModel(pk).then((m) => {
            if (!m || items.get(id) !== made) return;
            made.obj.clear();
            if (Array.isArray(m)) {
              for (const src of m) {
                const me = new THREE.Mesh(src.geometry, src.material);
                me.castShadow = ITEM_CASTS.has(made.type);
                me.receiveShadow = true;
                made.obj.add(me);
              }
            } else made.obj.add(m.clone(true));
            tagDetail(made.obj);
          });
        }
      }
      e.gen = gn;
      const p = it.p, rot = it.rot ?? 0;
      if (relayout || e.x !== p[0] || e.y !== p[1] || e.z !== p[2] || e.rot !== rot) {
        e.x = p[0]; e.y = p[1]; e.z = p[2]; e.rot = rot;
        const was = e.drawer;
        placeItem(e, it, drawers);
        if (was || e.drawer) drawerDirty = true;
        e.space = spaceAt ? spaceAt(p[0], p[2]) : -1;
      }
    }
    for (const [id, e] of items) if (e.gen !== gn) { if (e.drawer) drawerDirty = true; dropItem(id, e); }
    if (drawerDirty) fitDrawers(st);
  };

  const syncGlows = (st: InteractionState, spaceAt: VisualOpts['spaceAt'], relayout: boolean) => {
    const gn = ++gen;
    for (const id in st.glows) {
      const p = st.glows[id]!;
      let e = glows.get(id);
      if (!e) {
        const obj = tagDetail(buildItemModel('glowstick', { lit: true, legacy: !modelsOn }));
        obj.rotation.y = (id.length * 1.7) % Math.PI;
        root.add(obj);
        glows.set(id, (e = { obj, type: 'glowstick', key: 'glowstick', glb: null, x: NaN, y: NaN, z: NaN, rot: 0, space: -1, gen: gn, led: null, size: new THREE.Vector3(), base: 1, lying: false, drawer: null, along: 0, lid: id }));
      }
      e.gen = gn;
      if (relayout || e.x !== p[0] || e.y !== p[1] || e.z !== p[2]) {
        e.x = p[0]; e.y = p[1]; e.z = p[2];
        e.obj.position.set(p[0], p[1], p[2]);
        e.space = spaceAt ? spaceAt(p[0], p[2]) : -1;
      }
    }
    for (const [id, e] of glows) if (e.gen !== gn) { root.remove(e.obj); glows.delete(id); }
  };

  const syncFlares = (st: InteractionState, spaceAt: VisualOpts['spaceAt'], relayout: boolean) => {
    const gn = ++gen;
    const list = st.flares ?? {};
    for (const id in list) {
      const fl = list[id]!;
      let f = flares.get(id);
      if (!f) {
        const obj = tagDetail(buildItemModel('flare.lit', { legacy: !modelsOn }));
        obj.rotation.y = (id.length * 2.3 + fl.p[0]) % (Math.PI * 2);
        root.add(obj);
        f = { obj, space: -1, gen: gn, x: NaN, z: NaN, until: fl.until, k: 1, d: 0, halo: obj.getObjectByName('halo') ?? null, glow: obj.getObjectByName('glow') ?? null };
        flares.set(id, f);
      }
      f.gen = gn;
      f.until = fl.until;
      if (relayout || f.x !== fl.p[0] || f.z !== fl.p[2]) {
        f.x = fl.p[0]; f.z = fl.p[2];
        f.obj.position.set(fl.p[0], 0, fl.p[2]);
        f.space = spaceAt ? spaceAt(fl.p[0], fl.p[2]) : -1;
      }
    }
    for (const [id, f] of flares) if (f.gen !== gn) { root.remove(f.obj); flares.delete(id); }
  };

  const syncRings = (st: InteractionState, now: number) => {
    const gn = ++gen;
    for (const pid in st.bodies) {
      const b = st.bodies[pid]!;
      let r = rings.get(pid);
      if (!r) {
        if (now >= b.reviveBy) continue;
        const mesh = tagDetail(new THREE.Mesh(ringGeo, itemMaterial(true)));
        mesh.rotation.x = -Math.PI / 2;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        root.add(mesh);
        rings.set(pid, (r = { mesh, until: b.reviveBy, gen: gn }));
      }
      r.gen = gn;
      r.until = b.reviveBy;
      r.mesh.position.set(b.p[0], 0.02, b.p[2]);
    }
    for (const [pid, r] of rings) if (r.gen !== gn) { root.remove(r.mesh); rings.delete(pid); }
  };

  /** items, lit glowsticks and burning flares in spaces the camera cannot see are not drawn (nor cast) */
  const cull = (vis: Set<number> | null) => {
    for (const e of items.values()) e.obj.visible = shownIn(vis, e.space);
    for (const e of glows.values()) e.obj.visible = shownIn(vis, e.space);
    for (const f of flares.values()) f.obj.visible = shownIn(vis, f.space);
  };

  /** v1.2: materials / pouches lying in the world as instances of their type's mesh (visible spaces only) */
  const syncMaterials = (st: InteractionState, vis: Set<number> | null, spaceAt: VisualOpts['spaceAt']) => {
    for (const l of matLists.values()) l.length = 0;
    for (const id in st.items) {
      const it = st.items[id]!;
      if (it.where !== 'world' || !it.p) continue;
      const l = matLists.get(it.type);
      if (!l) continue;
      if (vis && spaceAt && !shownIn(vis, spaceAt(it.p[0], it.p[2]))) continue;
      l.push(it);
    }
    for (const [t, im] of matMeshes) {
      const l = matLists.get(t)!;
      const prev = matPrev.get(t)!;
      const n = Math.min(MAT_CAP, l.length);
      let same = prev.length === n * 4;
      for (let i = 0; i < n && same; i++) {
        const it = l[i]!;
        const yaw = (it.rot ?? 0) + (it.id.length * 0.7) % 1.3;
        same = prev[i * 4] === it.p![0] && prev[i * 4 + 1] === it.p![1] && prev[i * 4 + 2] === it.p![2] && prev[i * 4 + 3] === yaw;
      }
      if (same) continue;
      prev.length = n * 4;
      for (let i = 0; i < n; i++) {
        const it = l[i]!;
        const yaw = (it.rot ?? 0) + (it.id.length * 0.7) % 1.3;
        prev[i * 4] = it.p![0]; prev[i * 4 + 1] = it.p![1]; prev[i * 4 + 2] = it.p![2]; prev[i * 4 + 3] = yaw;
        tmpQ.setFromAxisAngle(upY, yaw);
        tmpP.set(it.p![0], Math.max(0, it.p![1]), it.p![2]);
        im.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS.setScalar(1)));
      }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    }
  };

  // ---- per frame (no allocation while nothing changes)
  const tickFlares = (camera: THREE.Camera, now: number) => {
    if (flares.size === 0) {
      if (lightsParked) return;
      lightsParked = true;
      for (let i = 0; i < flareLights.length; i++) {
        const l = flareLights[i]!;
        l.intensity = 0;
        l.position.set(0, -520 - i, 0);
        l.target.position.set(0, -530 - i, 0);
        l.target.updateMatrixWorld();
        l.visible = parkedVisible();
      }
      return;
    }
    lightsParked = false;
    camera.getWorldPosition(tmpCam);
    const t = performance.now() / 1000;
    flareOrder.length = 0;
    for (const f of flares.values()) {
      // sputter: the last 8 s the flame dies down
      const left = Math.max(0, (f.until - now) / 1000);
      const fade = Math.min(1, left / 8);
      const flick = 0.8 + 0.12 * Math.sin(t * 23 + f.x) + 0.08 * Math.sin(t * 57 + f.z);
      f.k = fade * flick;
      if (f.glow) f.glow.scale.setScalar((0.45 + 0.2 * flick) * (0.3 + 0.7 * fade));
      if (f.halo) f.halo.scale.setScalar(0.35 + 0.65 * fade * (0.9 + 0.1 * flick));
      // the pooled lights only go to flares in visible spaces (one behind a wall would light this room through it)
      if (!f.obj.visible) continue;
      f.d = f.obj.position.distanceToSquared(tmpCam);
      flareOrder.push(f);
    }
    flareOrder.sort(byDist);
    for (let i = 0; i < flareLights.length; i++) {
      const l = flareLights[i]!;
      const f = flareOrder[i];
      if (!f) {
        if (l.intensity !== 0) { l.intensity = 0; l.position.set(0, -520 - i, 0); l.target.position.set(0, -530 - i, 0); l.target.updateMatrixWorld(); }
        l.visible = parkedVisible();
        continue;
      }
      l.visible = true;
      l.position.set(f.x, 1.45, f.z);
      l.target.position.set(f.x, 0, f.z);
      l.target.updateMatrixWorld();
      l.intensity = 34 * f.k;
    }
  };

  const tickRings = (now: number) => {
    if (rings.size === 0) return;
    const k = 1 + Math.sin(now / 180) * 0.06;
    for (const [pid, r] of rings) {
      if (now >= r.until) { root.remove(r.mesh); rings.delete(pid); continue; }
      r.mesh.scale.setScalar(k);
    }
  };

  const syncThrown = (list: readonly ThrownView[]) => {
    if (list.length === 0 && thrown.size === 0) return;
    const gn = ++gen;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      let e = thrown.get(t.id);
      if (!e) {
        const obj = tagDetail(buildItemModel(t.id.includes(':flare:') ? 'flare.lit' : t.id.includes(':lure:') ? 'lure' : 'bottle', { legacy: !modelsOn }));
        const h = obj.getObjectByName('halo');
        if (h) h.visible = false;
        root.add(obj);
        thrown.set(t.id, (e = { obj, gen: gn }));
      }
      e.gen = gn;
      e.obj.position.set(t.p[0], t.p[1] - 0.14, t.p[2]);
      e.obj.rotation.set(t.yaw, t.yaw * 0.3, 0);
    }
    // every listed id has its entry: a sweep is only needed when some entry was not listed
    if (thrown.size !== list.length) for (const [id, e] of thrown) if (e.gen !== gn) { root.remove(e.obj); thrown.delete(id); }
  };

  /** the active item's name: VisualOpts.activeName, else the one active item of that type in the state */
  let vmName: string | undefined;
  let vmKeyType: string | null = null, vmKeyName: string | undefined, vmKeyMode = modelsOn, vmKeyNow: string | null = null;
  const activeNameOf = (o: VisualOpts, st: InteractionState, type: string): string | undefined => {
    if (o.activeName !== undefined) return o.activeName ?? undefined;
    let name: string | undefined, n = 0;
    for (const pid in st.inventories) {
      const inv = st.inventories[pid];
      const id = inv?.[st.active?.[pid] ?? 0];
      const it = id ? st.items[id] : undefined;
      if (it && it.type === type) { n++; name = it.name; }
    }
    return n === 1 ? name : undefined;
  };
  const vmPoseFor = (type: string, key: string, glb: boolean, size: THREE.Vector3 | undefined): VmPose => viewModelPose(type, key, glb, size, !modelsOn);
  const syncViewModel = (o: VisualOpts, st: InteractionState) => {
    vmRoot.matrix.copy(o.camera.matrixWorld);
    vmRoot.matrixWorldNeedsUpdate = true;
    const want = o.showViewModel ? o.activeType : null;
    // the caller's activeName as it is; the state lookup only when the state or the type changed
    if (o.activeName !== undefined) vmName = want && modelsOn ? (o.activeName ?? undefined) : undefined;
    else if (want !== vmType || o.version !== vmVer) {
      vmVer = o.version;
      vmName = want && modelsOn ? activeNameOf(o, st, want) : undefined;
    }
    // the key is recomputed only when the type, the name or the mode changed (no per-frame allocation)
    if (want !== vmKeyType || vmName !== vmKeyName || modelsOn !== vmKeyMode) {
      vmKeyType = want; vmKeyName = vmName; vmKeyMode = modelsOn;
      vmKeyNow = want ? visualKey({ type: want, name: vmName }, !modelsOn) : null;
    }
    const key = vmKeyNow;
    const rev = key && modelsOn ? tplRev(key) : null;
    if (want !== vmType || key !== vmKey || rev !== vmRev) {
      if (vmObj) vmHolder.remove(vmObj);
      vmObj = null;
      vmLed = null;
      vmType = want;
      vmKey = key;
      vmRev = rev;
      if (want && key) {
        vmObj = buildItemModel(want, { vm: true, name: vmName, legacy: !modelsOn, glb: glbOk() });
        vmObj.traverse((c) => { c.castShadow = false; });
        vmLed = vmObj.getObjectByName('led') ?? null;
        if (fpLayer !== null) applyLayer(vmObj);
        vmHolder.add(vmObj);
        vmPose = vmPoseFor(want, key, !!vmObj.userData.glb, vmObj.userData.size as THREE.Vector3 | undefined);
        vmObj.position.set(...vmPose.pos);
        vmObj.rotation.set(...vmPose.rot);
        vmObj.scale.setScalar(vmPose.scale);
      }
    }
    if (!vmObj || !vmType) return;
    bob += o.dt;
    const ps = vmPose;
    let ox = 0, oy = Math.sin(bob * 1.6) * 0.004, oz = 0, rx = 0;
    if (anim) {
      anim.t += o.dt;
      const dur = anim.kind === 'swing' ? 0.38 : 0.3;
      const k = Math.min(1, anim.t / dur);
      const s = Math.sin(k * Math.PI);
      if (anim.kind === 'swing') { rx = -s * 1.6; ox = -s * 0.12; oz = -s * 0.1; }
      else if (anim.kind === 'throw') { oz = -s * 0.25; oy += s * 0.08; }
      else { oy -= s * 0.05; }
      if (k >= 1) anim = null;
    }
    vmObj.position.set(ps.pos[0] + ox, ps.pos[1] + oy, ps.pos[2] + oz);
    vmObj.rotation.set(ps.rot[0] + rx, ps.rot[1], ps.rot[2]);
    if (vmLed) vmLed.visible = o.radioTx ? true : Math.floor(bob * 2) % 2 === 0;
  };

  // ---- v1.2 item models: a real model arrived (rebuild its items, warm its layout, swap a material's instances)
  let forceSync = false;
  const onTemplate = (key: string) => {
    forceSync = true;
    const t = templates.get(key);
    if (t && modelsOn && glbOk()) {
      let added = false;
      for (const m of t.meshes) added = !!addWarm(m.geometry, m.material, true) || added;
      if (added) rearmWarm();
    }
    if (matMeshes.has(key)) swapMat(key);
  };
  tplListeners.add(onTemplate);
  // models already loaded by an earlier visuals instance: warm their layouts now
  for (const key of templates.keys()) onTemplate(key);
  /** the flag flipped (the live flags answered): rebuild every model in the new mode */
  const rebuildAll = () => {
    for (const [id, e] of items) dropItem(id, e);
    for (const e of glows.values()) root.remove(e.obj);
    glows.clear();
    for (const f of flares.values()) root.remove(f.obj);
    flares.clear();
    for (const e of thrown.values()) root.remove(e.obj);
    thrown.clear();
    for (const e of heldObjs.values()) root.remove(e.obj);
    heldObjs.clear();
    if (vmObj) vmHolder.remove(vmObj);
    vmObj = null; vmType = null; vmKey = null; vmRev = null;
    for (const t of matTypes) swapMat(t);
    for (const key of templates.keys()) onTemplate(key);
    forceSync = true;
  };

  // ---- test hooks (scene graph: root.userData.ixDebug): the mode, the loaded models, a view-model gallery
  const gallery = new THREE.Group();
  gallery.name = 'ix-gallery';
  vmRoot.add(gallery);
  root.userData.ixDebug = {
    info: () => ({
      itemModels: modelsOn, known: modelsKnown, warmProxies: warmInner.children.length, warmArms, warmOn,
      templates: [...templates.values()].map((t) => ({ key: t.key, prop: t.prop, size: t.size.toArray().map((v) => Math.round(v * 1000) / 1000), tris: t.tris, casts: castsOf(t.size.y), mats: t.meshes.length })),
      drawers: drawerList.length,
    }),
    key: (type: string, name?: string) => visualKey({ type, name }, !modelsOn),
    /** v1.3 (4b): the pooled flare / flashbulb lights (a parked one is invisible once the warm-up is over) */
    lights: () => ({
      settled: lightsSettled, hide: hideLights,
      list: [...flareLights, flashLight].map((l) => ({ name: l.name, visible: l.visible, intensity: Math.round(l.intensity * 100) / 100 })),
    }),
    samples: () => itemSamples(),
    realKeys: () => realModelKeys(),
    /** the view models of these items side by side in front of the camera (4 per row, 2 rows); null clears */
    gallery: (list: { type: string; name?: string }[] | null) => {
      gallery.clear();
      if (!list) return 0;
      list.slice(0, 8).forEach((x, i) => {
        const obj = buildItemModel(x.type, { vm: true, name: x.name, legacy: !modelsOn, glb: glbOk() });
        obj.traverse((c) => { c.castShadow = false; });
        const key = visualKey(x, !modelsOn);
        const pose = vmPoseFor(x.type, key, !!obj.userData.glb, obj.userData.size as THREE.Vector3 | undefined);
        const holder = new THREE.Group();
        holder.position.set(-0.42 + (i % 4) * 0.28, i < 4 ? 0.0 : -0.25, -0.62);
        obj.position.set(pose.pos[0], pose.pos[1] + 0.06, pose.pos[2]);
        obj.rotation.set(...pose.rot);
        obj.scale.setScalar(pose.scale);
        holder.add(obj);
        applyLayer(holder);
        gallery.add(holder);
      });
      return gallery.children.length;
    },
  };

  let lastVer = Number.NaN;
  let lastLayout: unknown = undefined;
  let preloadedFor: unknown = null;
  let lastVis: Set<number> | null = null;
  let visInit = false;
  /** same members (the level hands out a new set whenever the camera crosses a cell, often with the same members) */
  const sameSet = (a: Set<number> | null, b: Set<number> | null): boolean => {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  };
  let heldGen = 0;
  let ledOn = false;
  const blink = (led: THREE.Object3D) => { led.visible = ledOn; };
  const glintAt = new THREE.Vector3();

  return {
    update(st, o) {
      cam = o.camera;
      o.camera.updateMatrixWorld();
      tickWarm(o.camera);
      if (modelsDirty) { modelsDirty = false; rebuildAll(); lastLayout = undefined; }
      const relayout = o.layoutRef !== lastLayout;
      // v1.2 item models: every real model starts loading with the first layout once the flag is known to be on (the
      // loading screen waits for them; a flag-off client never downloads them)
      if (o.layoutRef && o.layoutRef !== preloadedFor && modelsKnown && modelsOn && glbOk()) { preloadedFor = o.layoutRef; void preloadItemModels(); }
      const changed = relayout || o.version !== lastVer || forceSync;
      if (changed) {
        forceSync = false;
        lastVer = o.version;
        lastLayout = o.layoutRef;
        syncItems(st, o.spaceAt, relayout, o.layoutRef);
        syncGlows(st, o.spaceAt, relayout);
        syncFlares(st, o.spaceAt, relayout);
        syncRings(st, o.serverNow);
      }
      const vis = o.visibleSpaces ?? null;
      const visChanged = !visInit || !sameSet(vis, lastVis);
      lastVis = vis;
      if (changed || visChanged) {
        visInit = true;
        cull(vis);
        syncMaterials(st, vis, o.spaceAt);
      }
      if (flashT >= 0) {
        // a hard pop, then a fast falloff (~0.35 s)
        flashT += o.dt;
        const k = flashT < 0.05 ? 1 : Math.max(0, 1 - (flashT - 0.05) / 0.3);
        flashLight.intensity = 260 * k * k;
        if (k <= 0) {
          flashT = -1;
          flashLight.intensity = 0;
          flashLight.position.set(0, -540, 0);
          flashLight.target.position.set(0, -550, 0);
          flashLight.target.updateMatrixWorld();
          flashLight.visible = parkedVisible();
        }
      }
      tickFlares(o.camera, o.serverNow);
      if (armedLeds.size) {
        ledOn = Math.floor(performance.now() / 450) % 3 === 0;
        armedLeds.forEach(blink);
      }
      tickRings(o.serverNow);
      syncThrown(o.thrown);
      syncViewModel(o, st);
      if (o.targetPos) {
        glint.visible = true;
        const k = 1 + Math.sin(performance.now() / 160) * 0.08;
        const e = modelsOn && o.targetItem ? items.get(o.targetItem) : undefined;
        if (e) {
          // v1.2 item models: the ring lies at the item's foot and opens around big models
          glintAt.set(e.vx ?? e.obj.position.x, 0, e.vz ?? e.obj.position.z);
          const s = e.obj.scale.x;
          const foot = Math.max(e.lying ? e.size.y : e.size.x, e.size.z) * s * 0.5 + 0.03;
          glint.position.set(glintAt.x, Math.max(0.015, e.y + 0.012), glintAt.z);
          glint.scale.setScalar(k * Math.max(1, foot / 0.12));
        } else {
          glint.position.set(o.targetPos[0], Math.max(0.015, o.targetPos[1] - 0.08), o.targetPos[2]);
          glint.scale.setScalar(k);
        }
      } else glint.visible = false;
    },
    held(list) {
      if (list.length === 0 && heldObjs.size === 0) return;
      const gn = ++heldGen;
      for (let i = 0; i < list.length; i++) {
        const h = list[i]!;
        let e = heldObjs.get(h.pid);
        // held items carry no name: the key is the type's (computed once per new item, no per-frame allocation)
        const key = e && e.type === h.type ? e.key : visualKey({ type: h.type }, !modelsOn);
        const rev = modelsOn ? tplRev(key) : null;
        if (e && (e.type !== h.type || e.key !== key || e.glb !== rev)) { root.remove(e.obj); e = undefined; }
        if (!e) {
          e = { type: h.type, key, glb: rev, obj: tagDetail(buildItemModel(h.type, { legacy: !modelsOn, glb: glbOk() })), gen: gn };
          root.add(e.obj);
          heldObjs.set(h.pid, e);
        }
        e.gen = gn;
        const tilt = HELD_TILT[h.type] ?? NO_TILT;
        e.obj.position.set(h.p[0], h.p[1] - 0.06, h.p[2]);
        e.obj.rotation.set(tilt[0], h.yaw + tilt[1], tilt[2], 'YXZ');
        e.obj.visible = true;
      }
      if (heldObjs.size !== list.length) for (const [pid, e] of heldObjs) if (e.gen !== gn) { root.remove(e.obj); heldObjs.delete(pid); }
    },
    animate(kind) {
      anim = { kind, t: 0 };
    },
    flash(p, dir) {
      flashLight.position.set(p[0], p[1], p[2]);
      flashLight.target.position.set(p[0] + dir[0] * 8, p[1] + dir[1] * 8, p[2] + dir[2] * 8);
      flashLight.target.updateMatrixWorld();
      flashLight.intensity = 260;
      flashLight.visible = true;
      flashT = 0;
    },
    setFirstPersonLayer(layer) {
      if (layer === fpLayer) return;
      fpLayer = layer;
      applyLayer(vmRoot);
    },
    setDetailLayer(layer) {
      if (layer === detail) return;
      detail = layer;
      for (const c of root.children) if (c !== vmRoot) tagDetail(c);
    },
    matStats() {
      let draws = 0, instances = 0;
      for (const im of matMeshes.values()) if (im.count > 0) { draws++; instances += im.count; }
      return { draws, instances };
    },
    matProbe(camera) {
      const out: MatProbe[] = [];
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      camera.updateMatrixWorld();
      for (const [t, im] of matMeshes) {
        if (im.count <= 0) continue;
        im.updateMatrixWorld();
        im.getMatrixAt(0, m);
        m.premultiply(im.matrixWorld).decompose(p, q, s);
        let visible = true, inScene = false;
        for (let o: THREE.Object3D | null = im; o; o = o.parent) {
          if (!o.visible) visible = false;
          if ((o as THREE.Scene).isScene) inScene = true;
        }
        const ndc = p.clone().project(camera);
        out.push({
          type: t, count: im.count, visible, inScene, layers: im.layers.mask, p: [r3(p.x), r3(p.y), r3(p.z)], scale: r3(s.x),
          ndc: [r3(ndc.x), r3(ndc.y), r3(ndc.z)], verts: im.geometry.attributes.position?.count ?? 0, radius: r3(im.geometry.boundingSphere?.radius ?? -1),
        });
      }
      return out;
    },
    matPlain(on) {
      plainGrp.clear();
      for (const im of matMeshes.values()) im.visible = !on;
      if (!on) return;
      const m = new THREE.Matrix4();
      for (const im of matMeshes.values()) {
        for (let i = 0; i < im.count; i++) {
          const me = tagDetail(new THREE.Mesh(im.geometry, im.material));
          im.getMatrixAt(i, m);
          m.decompose(me.position, me.quaternion, me.scale);
          me.castShadow = false;
          me.receiveShadow = true;
          plainGrp.add(me);
        }
      }
    },
    drawStats() {
      let draws = 0, casters = 0, shown = 0, maxMeshesPerItem = 0, glbShown = 0;
      const countIn = (o: THREE.Object3D) => {
        o.traverseVisible((c) => {
          const im = c as THREE.InstancedMesh;
          if (im.isInstancedMesh ? im.count > 0 : (c as THREE.Mesh).isMesh || (c as THREE.Sprite).isSprite) {
            draws++;
            if (c.castShadow) casters++;
          }
        });
      };
      for (const c of root.children) if (c !== warm) countIn(c);
      for (const e of items.values()) {
        if (!e.obj.visible) continue;
        shown++;
        if (e.glb) glbShown++;
        let n = 0;
        e.obj.traverseVisible((c) => { if ((c as THREE.Mesh).isMesh) n++; });
        maxMeshesPerItem = Math.max(maxMeshesPerItem, n);
      }
      return {
        items: items.size, shown, draws, casters, warm: warmOn, warmFrames, maxMeshesPerItem, thrown: thrown.size, held: heldObjs.size,
        itemModels: modelsOn, glbShown, templates: templates.size, warmProxies: warmInner.children.length, warmArms,
      };
    },
    dispose() {
      tplListeners.delete(onTemplate);
      scene.remove(root);
    },
  };
}

export function itemColor(type: string): string {
  return itemDef(type).color;
}
