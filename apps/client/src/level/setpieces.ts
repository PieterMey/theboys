// Owner: track ② Level. Procedural set-piece furniture (server racks, morgue drawers, pews, canteen tables, pallet
// racks, boilers, tanks, counters, washers...) and cosmetic clutter (paper, boxes, bottles, debris, fallen ceiling
// tiles, hanging cables, puddles, posters, ceiling pipes). Everything here is static: the level merges it per space and
// material (one draw call per material per room), so a densely furnished room costs a handful of draws.
// Local frame of a furniture item: origin on the floor at the item centre, +X along its width, +Z = its front.
// Wall-mounted items are centred on their mount height (y in [-h/2, h/2]) with the back at z = -d/2.
import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import type { LayoutItem } from '@dead-air/shared/layout.ts';
import type { ClutterItem } from '@dead-air/shared/procgen/clutter.ts';
import { PROP_DEFS } from '@dead-air/shared/procgen/decor.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import type { LevelMaterials, MatId } from './materials.ts';
import { fallbackParts, kitParts } from './kits.ts';
import { decalMaterial } from './decals.ts';
import { GeoRef, box, cyl, mergeParts, part, shape } from './geo.ts';
import type { AnyGeo, Part } from './geo.ts';

export type { Part };

// shared prototypes placed by matrices (geo.ts): no per-part BufferGeometry for boxes and cylinders
const B = (w: number, h: number, d: number, x = 0, y = 0, z = 0): GeoRef => box(w, h, d, x, y, z);
const CY = (r: number, h: number, x = 0, y = 0, z = 0, seg = 16, r2 = r): GeoRef => cyl(r, h, x, y, z, seg, r2);
/** cylinder lying along x */
const CX = (r: number, len: number, x = 0, y = 0, z = 0, seg = 12): GeoRef => cyl(r, len, 0, 0, 0, seg).rotateZ(Math.PI / 2).translate(x, y, z);
/** cylinder lying along z */
const CZ = (r: number, len: number, x = 0, y = 0, z = 0, seg = 12): GeoRef => cyl(r, len, 0, 0, 0, seg).rotateX(Math.PI / 2).translate(x, y, z);

let mats: Map<string, THREE.Material> | null = null;

function posterAtlas(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d')!;
  const posters: [string, string, string, string][] = [
    ['#c9b98f', '#7a1c16', 'SILENCE', 'IS SAFETY'],
    ['#d8d2bf', '#1f2a24', 'REPORT', 'ANY VOICES'],
    ['#b8c4bc', '#7a1c16', 'DO NOT', 'SHOUT'],
    ['#d4c48a', '#202020', 'CAUTION', 'WET FLOOR'],
    ['#c2c8cc', '#14365c', 'WEAR', 'YOUR PPE'],
    ['#d9d4c3', '#5a1410', 'NO', 'SMOKING'],
    ['#b6b09a', '#202020', 'EVACUATION', 'ROUTE >'],
    ['#cfc7b4', '#3b2a14', 'THEY CAN', 'HEAR YOU'],
  ];
  posters.forEach(([bg, ink, l1, l2], i) => {
    const x = (i % 4) * 256, y = Math.floor(i / 4) * 256;
    g.fillStyle = bg; g.fillRect(x + 6, y + 6, 244, 244);
    g.fillStyle = ink; g.fillRect(x + 6, y + 6, 244, 34);
    g.fillRect(x + 6, y + 228, 244, 22);
    g.font = "900 40px 'Arial Black', Impact, sans-serif";
    g.textAlign = 'center';
    g.fillText(l1, x + 128, y + 110, 230);
    g.font = "900 30px 'Arial Black', Impact, sans-serif";
    g.fillText(l2, x + 128, y + 160, 230);
    // age: stains + torn corner
    for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(70,55,30,${0.04 + ((k * 37) % 10) / 120})`; g.beginPath(); g.arc(x + ((k * 53) % 244) + 6, y + ((k * 97) % 244) + 6, 4 + ((k * 13) % 18), 0, Math.PI * 2); g.fill(); }
    g.clearRect(x + 200 + (i % 3) * 8, y + 220, 60, 40);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function stdMat(name: string, color: number, roughness: number, metalness: number, extra: Partial<THREE.MeshStandardNodeMaterialParameters> = {}): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness, ...extra });
  m.name = `level.set.${name}`;
  return m;
}

/** shared set-piece materials (created once; kept across layouts) */
export function setMaterial(lm: LevelMaterials, key: string): THREE.Material {
  if (!mats) {
    const M = new Map<string, THREE.Material>();
    M.set('steel', stdMat('steel', 0x9aa1a6, 0.32, 0.85));
    M.set('steelDark', stdMat('steeldark', 0x3a3f44, 0.5, 0.7));
    M.set('rack', stdMat('rack', 0x17191b, 0.55, 0.55));
    M.set('rackFront', stdMat('rackfront', 0x24282b, 0.4, 0.7));
    M.set('woodDark', stdMat('wooddark', 0x3a281b, 0.7, 0));
    M.set('pallet', stdMat('pallet', 0x8b6b45, 0.85, 0));
    M.set('enamel', stdMat('enamel', 0xc9c8bf, 0.38, 0.05));
    M.set('cardboard', stdMat('cardboard', 0x8a6a45, 0.92, 0));
    M.set('cardboardDark', stdMat('cardboarddark', 0x6b5034, 0.94, 0));
    M.set('cloth', stdMat('cloth', 0x5e1a17, 0.92, 0));
    M.set('sheet', stdMat('sheet', 0xbdb8aa, 0.95, 0));
    M.set('plant', stdMat('plant', 0x3a3a22, 0.95, 0));
    M.set('pot', stdMat('pot', 0x7a4a32, 0.85, 0));
    M.set('water', stdMat('water', 0x0b1311, 0.03, 0.15, { transparent: true, opacity: 0.82, depthWrite: false }));
    M.set('puddle', stdMat('puddle', 0x080b0a, 0.02, 0.2, { transparent: true, opacity: 0.72, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    M.set('stain', stdMat('stain', 0x1a140c, 0.95, 0, { transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    M.set('paper', stdMat('paper', 0xcfc9b6, 0.95, 0, { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    M.set('glassBrown', stdMat('glassbrown', 0x3a2410, 0.12, 0.2, { transparent: true, opacity: 0.85 }));
    M.set('glassGreen', stdMat('glassgreen', 0x1d3a1c, 0.12, 0.2, { transparent: true, opacity: 0.85 }));
    M.set('blue', stdMat('rackblue', 0x24477a, 0.55, 0.6));
    M.set('orange', stdMat('rackorange', 0xa3501c, 0.5, 0.55));
    M.set('red', stdMat('red', 0x8e1d16, 0.45, 0.25));
    M.set('black', stdMat('black', 0x0d0e0f, 0.7, 0.2));
    M.set('cork', stdMat('cork', 0x8f6b43, 0.95, 0));
    M.set('brass', stdMat('brass', 0x9a8a5a, 0.3, 0.9));
    M.set('hole', stdMat('hole', 0x050505, 1, 0, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    M.set('poster', stdMat('poster', 0xffffff, 0.9, 0, { map: typeof document !== 'undefined' ? posterAtlas() : null, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    M.set('cable', stdMat('cable', 0x101010, 0.6, 0.1));
    M.set('bookA', stdMat('booka', 0x5a1f1a, 0.8, 0));
    M.set('bookB', stdMat('bookb', 0x1f2f4a, 0.8, 0));
    M.set('bookC', stdMat('bookc', 0x4a4030, 0.85, 0));
    // v1.2 kits (env-world): plain standard materials share one pipeline (colour is a uniform)
    M.set('blanket', stdMat('blanket', 0x50686a, 0.95, 0));
    M.set('curtain', stdMat('curtain', 0x8fa89c, 0.92, 0, { side: THREE.DoubleSide }));
    M.set('pumpGreen', stdMat('pumpgreen', 0x34493b, 0.55, 0.45));
    M.set('glassCase', stdMat('glasscase', 0x9fb4b8, 0.04, 0.1, { transparent: true, opacity: 0.22, depthWrite: false }));
    M.set('bone', stdMat('bone', 0xcfc4a6, 0.7, 0));
    M.set('muslin', stdMat('muslin', 0xb9a99a, 0.95, 0));
    M.set('meat', stdMat('meat', 0x5a2622, 0.6, 0));
    M.set('pvc', stdMat('pvc', 0xa9c4cc, 0.18, 0, { transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }));
    M.set('slate', stdMat('slate', 0x1b231f, 0.78, 0));
    M.set('mirrorBack', stdMat('mirrorback', 0x8d969a, 0.06, 1));
    mats = M;
  }
  const hit = mats.get(key);
  if (hit) return hit;
  if (key === 'vc') return vertexColourMaterial();
  if (key === 'vcGlass') return vertexGlassMaterial();
  if (key === 'ledG') return lm.glow(0x30ff70, 2.2);
  if (key === 'ledA') return lm.glow(0xffa020, 2.2);
  if (key === 'ledR') return lm.glow(0xff2a1a, 2.4);
  if (key === 'candle') return lm.glow(0xffb050, 3);
  if (key === 'bulbWarm') return lm.glow(0xffd8a0, 2.6);
  if (key === 'exitGlow') return lm.glow(0x30ff70, 3);
  if (key === 'decal') return decalMaterial();
  return lm.get(key as MatId);
}

/** plain opaque set materials (a colour, roughness and metalness, nothing else): the level folds every one of them in
 *  a space into ONE vertex-colour mesh ('vc'), one draw per pass instead of one per colour */
const PLAIN = new Set(['steel', 'steelDark', 'rack', 'rackFront', 'woodDark', 'pallet', 'enamel', 'cardboard', 'cardboardDark', 'cloth', 'sheet', 'plant', 'pot', 'blue', 'orange', 'red', 'black', 'cork', 'brass', 'cable', 'bookA', 'bookB', 'bookC', 'blanket', 'pumpGreen', 'bone', 'muslin', 'meat', 'slate', 'mirrorBack']);
/** set materials whose parts never make a merged furniture mesh cast (glass, glows, paper, decals, floor films, pulls) */
export const NO_CAST_MATS: ReadonlySet<string> = new Set(['paper', 'brass', 'glassBrown', 'glassGreen', 'glassCase', 'pvc', 'water', 'puddle', 'stain', 'poster', 'hole', 'decal', 'ledG', 'ledA', 'ledR', 'candle', 'bulbWarm', 'exitGlow']);
/** bottle glass (same transparency, roughness and metalness in every colour): one vertex-colour glass mesh per space */
const PLAIN_GLASS = new Set(['glassBrown', 'glassGreen']);
export interface PlainParams { bucket: 'vc' | 'vcGlass'; rgb: [number, number, number]; rm: [number, number] }
const plainCache = new Map<string, PlainParams>();
/** the shared vertex-colour bucket of a plain set material + its linear colour and roughness / metalness (null = it
 *  keeps its own material) */
export function plainParams(lm: LevelMaterials, key: string): PlainParams | null {
  const glass = PLAIN_GLASS.has(key);
  if (!glass && !PLAIN.has(key)) return null;
  let v = plainCache.get(key);
  if (!v) {
    const m = setMaterial(lm, key) as THREE.MeshStandardNodeMaterial;
    v = { bucket: glass ? 'vcGlass' : 'vc', rgb: [m.color.r, m.color.g, m.color.b], rm: [m.roughness, m.metalness] };
    plainCache.set(key, v);
  }
  return v;
}
let vcMat: THREE.MeshStandardNodeMaterial | null = null;
/** the shared furniture material: colour from the 'color' attribute, roughness / metalness from the 'rm' attribute */
function vertexColourMaterial(): THREE.MeshStandardNodeMaterial {
  if (!vcMat) {
    vcMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true });
    vcMat.name = 'level.set.vc';
    const rm = attribute<'vec2'>('rm', 'vec2');
    vcMat.roughnessNode = rm.x;
    vcMat.metalnessNode = rm.y;
  }
  return vcMat;
}
let vcGlass: THREE.MeshStandardNodeMaterial | null = null;
/** the shared bottle glass: colour from the 'color' attribute (glassBrown / glassGreen) */
function vertexGlassMaterial(): THREE.MeshStandardNodeMaterial {
  if (!vcGlass) {
    vcGlass = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.85, vertexColors: true });
    vcGlass.name = 'level.set.vcglass';
  }
  return vcGlass;
}

// ---------------------------------------------------------------- furniture

/** container hosts (v1.2): no cosmetic random-open drawer; `skip` part indices are drawn as movable instances instead */
export interface ProcHostOpts { host?: boolean; skip?: ReadonlySet<number> }

/** filing cabinet drawer k (0..3, bottom up) in the host frame: front panel centre y and the closed front z */
export const FILING_DRAWER = { y0: 0.17, pitch: 0.32, h: 0.29 } as const;

/**
 * Parts of one procedural furniture item in its local frame. Unknown keys: a kit (kits.ts) or, for any other
 * PROP_DEFS key, a bevelled box of its footprint, so a solid prop is never invisible (null only for keys PROP_DEFS
 * does not know at all).
 */
export function procParts(it: LayoutItem, rng: Rng, o: ProcHostOpts = {}): Part[] | null {
  const key = String(it.data?.prop ?? '');
  const def = PROP_DEFS[key];
  const w = Number(it.data?.w ?? def?.w ?? 1), d = Number(it.data?.d ?? def?.d ?? 0.6), n = Math.max(1, Number(it.data?.n ?? 1));
  const P: Part[] = [];
  const add = (mat: string, ...gs: AnyGeo[]) => { for (const g of gs) P.push(part(mat, g)); };
  switch (key) {
    case 'server_rack': {
      const uw = w / n;
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + uw * (i + 0.5);
        add('rack', B(uw - 0.03, 2.02, d, x, 1.01, 0));
        add('rackFront', B(uw - 0.09, 1.86, 0.02, x, 1.02, d / 2 + 0.005));
        // blade slots + blinking-looking LED dots
        for (let k = 0; k < 9; k++) {
          const y = 0.22 + k * 0.19;
          add('steelDark', B(uw - 0.14, 0.012, 0.012, x, y + 0.08, d / 2 + 0.02));
          const leds = rng.int(0, 3);
          for (let l = 0; l < leds; l++) add(rng.chance(0.75) ? 'ledG' : 'ledA', B(0.018, 0.012, 0.01, x - uw / 2 + 0.1 + l * 0.04 + rng.next() * 0.2, y, d / 2 + 0.022));
        }
        // rear: cable bundle
        add('cable', B(uw - 0.2, 1.6, 0.05, x, 1.0, -d / 2 - 0.02));
      }
      // cable tray over the row
      add('steelDark', B(w, 0.04, 0.32, 0, 2.42, 0), B(w, 0.1, 0.02, 0, 2.47, 0.16), B(w, 0.1, 0.02, 0, 2.47, -0.16));
      for (let x = -w / 2 + 0.3; x < w / 2; x += 1.2) add('steelDark', B(0.02, 0.56, 0.02, x, 2.72, 0));
      break;
    }
    case 'morgue_drawers': {
      add('steel', B(w, 2.0, d, 0, 1.0, 0));
      for (let r = 0; r < 3; r++) for (let c2 = 0; c2 < 3; c2++) {
        const x = -w / 2 + (c2 + 0.5) * (w / 3), y = 0.42 + r * 0.6;
        const open = rng.chance(0.08) && !o.host;
        // container hosts: a dark opening on the carcass face behind each door (seen when its tray slides out)
        if (o.host) add('black', B(w / 3 - 0.08, 0.48, 0.002, x, y, d / 2 + 0.001));
        if (o.skip?.has(r * 3 + c2)) continue;
        add('steelDark', B(w / 3 - 0.06, 0.5, 0.025, x, y, d / 2 + (open ? 0.42 : 0.013)));
        if (open) add('steel', B(w / 3 - 0.12, 0.06, 0.45, x, y - 0.2, d / 2 + 0.2), B(w / 3 - 0.16, 0.14, 0.4, x, y - 0.13, d / 2 + 0.2));
        add('steel', B(0.16, 0.025, 0.04, x, y + 0.12, d / 2 + (open ? 0.45 : 0.04)));
        add('paper', B(0.1, 0.06, 0.004, x - 0.12, y + 0.14, d / 2 + (open ? 0.433 : 0.027)));
      }
      break;
    }
    case 'autopsy_table': {
      add('steelDark', CY(0.12, 0.72, 0, 0.36, 0, 14), CY(0.3, 0.05, 0, 0.025, 0, 18));
      add('steel', B(w, 0.06, d, 0, 0.82, 0), B(w, 0.06, 0.03, 0, 0.87, d / 2 - 0.015), B(w, 0.06, 0.03, 0, 0.87, -d / 2 + 0.015), B(0.03, 0.06, d, -w / 2 + 0.015, 0.87, 0), B(0.03, 0.06, d, w / 2 - 0.015, 0.87, 0));
      if (rng.chance(0.55)) {
        // a sheet over something about the size of a person
        const body = new THREE.CapsuleGeometry(0.2, w * 0.62, 6, 12).rotateZ(Math.PI / 2).scale(1, 0.62, 1).translate(0.04, 0.95, 0);
        add('sheet', body, new THREE.SphereGeometry(0.15, 12, 8).scale(1, 0.75, 1).translate(-w * 0.4, 0.96, 0));
      }
      break;
    }
    case 'table': {
      add(rng.chance(0.5) ? 'wood' : 'enamel', B(w, 0.04, d, 0, 0.74, 0));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('steelDark', B(0.04, 0.72, 0.04, sx * (w / 2 - 0.08), 0.36, sz * (d / 2 - 0.08)));
      add('steelDark', B(w - 0.2, 0.03, 0.03, 0, 0.18, 0));
      // what was left on it
      for (let k = rng.int(0, 3); k > 0; k--) {
        const x = (rng.next() - 0.5) * (w - 0.3), z = (rng.next() - 0.5) * (d - 0.2);
        const r = rng.next();
        if (r < 0.4) add('enamel', CY(0.04, 0.09, x, 0.805, z, 10));
        else if (r < 0.7) add('steel', B(0.42, 0.02, 0.3, x, 0.77, z));
        else add('paper', B(0.22, 0.004, 0.3, x, 0.762, z).rotateY(rng.next()));
      }
      break;
    }
    case 'pew': {
      add('wood', B(w - 0.08, 0.05, 0.4, 0, 0.45, 0.05), B(w - 0.08, 0.42, 0.04, 0, 0.75, -d / 2 + 0.04));
      add('woodDark', B(0.05, 0.95, d, -w / 2 + 0.025, 0.475, 0), B(0.05, 0.95, d, w / 2 - 0.025, 0.475, 0), B(w - 0.08, 0.1, 0.03, 0, 0.3, -d / 2 + 0.05));
      if (rng.chance(0.25)) add('paper', B(0.15, 0.03, 0.2, (rng.next() - 0.5) * w * 0.7, 0.49, 0.05)); // hymn book
      break;
    }
    case 'altar': {
      add('woodDark', B(w, 0.95, d, 0, 0.475, 0));
      add('cloth', B(w + 0.04, 0.02, d + 0.04, 0, 0.96, 0), B(w * 0.5, 0.7, 0.01, 0, 0.62, d / 2 + 0.022));
      for (let k = 0; k < 5; k++) {
        const x = -w / 2 + 0.25 + k * ((w - 0.5) / 4), h = 0.12 + rng.next() * 0.2;
        add('enamel', CY(0.025, h, x, 0.97 + h / 2, -0.1, 8));
        add('candle', shape('sph:0.014:6:4', () => new THREE.SphereGeometry(0.014, 6, 4)).scale(1, 1.8, 1).translate(x, 0.97 + h + 0.02, -0.1));
      }
      break;
    }
    case 'pallet_rack': {
      const uw = w / n, levels = [0.12, 1.02, 1.92];
      for (let i = 0; i <= n; i++) {
        const x = -w / 2 + i * uw;
        add('blue', B(0.07, 2.6, 0.07, x + (i === n ? -0.035 : 0.035), 1.3, d / 2 - 0.04), B(0.07, 2.6, 0.07, x + (i === n ? -0.035 : 0.035), 1.3, -d / 2 + 0.04));
      }
      for (const y of levels) {
        add('orange', B(w, 0.1, 0.05, 0, y + 0.05, d / 2 - 0.04), B(w, 0.1, 0.05, 0, y + 0.05, -d / 2 + 0.04));
        add('steelDark', B(w - 0.06, 0.015, d - 0.08, 0, y + 0.1, 0));
        for (let i = 0; i < n; i++) {
          const cx = -w / 2 + uw * (i + 0.5);
          if (rng.chance(0.15)) continue;
          // a pallet with a load: boxes / a crate / drums
          add('pallet', B(uw - 0.25, 0.12, d - 0.12, cx, y + 0.17, 0));
          const kind = rng.next();
          if (kind < 0.55) {
            const cols = rng.int(2, 3), rows = rng.int(1, 3);
            for (let a = 0; a < cols; a++) for (let b2 = 0; b2 < rows; b2++) {
              const bw = (uw - 0.35) / cols - 0.03, bh = 0.24 + rng.next() * 0.12;
              add(rng.chance(0.7) ? 'cardboard' : 'cardboardDark', B(bw, bh, d - 0.25, cx - (uw - 0.35) / 2 + (a + 0.5) * ((uw - 0.35) / cols), y + 0.23 + b2 * 0.28 + bh / 2, (rng.next() - 0.5) * 0.04));
            }
          } else if (kind < 0.8) add('wood', B(uw - 0.4, 0.5 + rng.next() * 0.2, d - 0.2, cx, y + 0.5, 0));
          else for (const bx of [-0.35, 0.35]) add(rng.chance(0.5) ? 'metal_rusty' : 'blue', CY(0.27, 0.62, cx + bx * (uw / 1.9), y + 0.54, 0, 14));
        }
      }
      break;
    }
    case 'boiler_tank': {
      const R = Math.min(w, d) / 2 - 0.08;
      add('wall_concrete_dark', B(w, 0.25, d, 0, 0.125, 0));
      add('metal_rusty', CY(R, 1.9, 0, 1.2, 0, 28), new THREE.SphereGeometry(R, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 1).translate(0, 2.15, 0));
      for (const y of [0.45, 1.2, 1.95]) add('steelDark', new THREE.TorusGeometry(R + 0.015, 0.03, 6, 32).rotateX(Math.PI / 2).translate(0, y, 0));
      // flue to the ceiling, a feed pipe, a pressure gauge and a valve wheel on the front
      add('steelDark', CY(0.14, 1.0, 0, 2.7, 0, 12), CZ(0.07, 0.5, R * 0.55, 0.9, R + 0.2, 10), CY(0.07, 0.9, R * 0.55, 0.45, R + 0.45, 10));
      add('brass', CZ(0.09, 0.06, -R * 0.4, 1.55, R + 0.03, 16), new THREE.TorusGeometry(0.16, 0.022, 6, 18).translate(R * 0.55, 1.15, R + 0.5));
      add('enamel', CZ(0.07, 0.01, -R * 0.4, 1.55, R + 0.065, 16));
      break;
    }
    case 'tank': {
      const R = Math.min(w, d) / 2 - 0.03;
      add(rng.chance(0.5) ? 'metal_painted' : 'metal_rusty', CY(R, 1.55, 0, 0.85, 0, 22), new THREE.SphereGeometry(R, 22, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.5, 1).translate(0, 1.62, 0));
      add('steelDark', CY(R + 0.02, 0.08, 0, 0.04, 0, 22), new THREE.TorusGeometry(R + 0.01, 0.02, 6, 24).rotateX(Math.PI / 2).translate(0, 1.2, 0), CY(0.04, 1.3, 0, 2.35, 0, 8));
      add('brass', CZ(0.06, 0.05, 0, 1.1, R + 0.02, 14));
      break;
    }
    case 'counter': {
      if (o.host) counterCarcass(w, d, add);
      else add('metal_painted', B(w, 0.86, d - 0.04, 0, 0.47, -0.02));
      add('steel', B(w + 0.02, 0.04, d, 0, 0.92, 0));
      add('black', B(w, 0.08, d - 0.1, 0, 0.04, -0.05));
      for (let k = 0; k < 3; k++) if (!o.skip?.has(k)) add('steelDark', B(w / 3 - 0.06, 0.6, 0.012, -w / 3 + k * (w / 3), 0.5, d / 2 - 0.03));
      for (let k = rng.int(0, 3); k > 0; k--) add('steel', B(0.35, 0.03, 0.26, (rng.next() - 0.5) * (w - 0.4), 0.955, (rng.next() - 0.5) * 0.2));
      break;
    }
    case 'workbench': {
      add('wood', B(w, 0.06, d, 0, 0.88, 0), B(w - 0.1, 0.03, d - 0.1, 0, 0.25, 0));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('steelDark', B(0.05, 0.85, 0.05, sx * (w / 2 - 0.06), 0.43, sz * (d / 2 - 0.06)));
      add('cork', B(w, 0.9, 0.02, 0, 1.45, -d / 2 + 0.01));
      add('steelDark', B(0.16, 0.12, 0.2, w / 2 - 0.25, 0.97, d / 2 - 0.15)); // vise
      for (let k = 0; k < 6; k++) add(rng.chance(0.5) ? 'steel' : 'red', B(0.03 + rng.next() * 0.04, 0.16 + rng.next() * 0.2, 0.02, -w / 2 + 0.2 + k * ((w - 0.4) / 5), 1.45 + (rng.next() - 0.5) * 0.3, -d / 2 + 0.035));
      if (rng.chance(0.6)) add('red', B(0.4, 0.18, 0.2, (rng.next() - 0.5) * 0.6, 1.0, 0));
      break;
    }
    case 'washer': {
      add('enamel', B(w - 0.02, 0.88, d - 0.02, 0, 0.44, 0));
      add('steelDark', new THREE.TorusGeometry(0.2, 0.03, 8, 24).translate(0, 0.45, d / 2));
      add('black', CZ(0.18, 0.02, 0, 0.45, d / 2 - 0.005, 24), B(w - 0.1, 0.1, 0.01, 0, 0.8, d / 2 - 0.005));
      if (rng.chance(0.3)) add('ledA', B(0.03, 0.02, 0.01, 0.22, 0.8, d / 2 + 0.002));
      break;
    }
    case 'stove': {
      add('enamel', B(w - 0.02, 0.86, d - 0.02, 0, 0.43, 0));
      add('black', B(w - 0.04, 0.02, d - 0.04, 0, 0.87, 0), B(w - 0.16, 0.45, 0.01, 0, 0.42, d / 2 - 0.005), B(w, 0.5, 0.04, 0, 1.15, -d / 2 + 0.02));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('steelDark', CY(0.09, 0.02, sx * w * 0.24, 0.89, sz * d * 0.22, 14));
      add('steel', B(w - 0.25, 0.025, 0.03, 0, 0.7, d / 2 + 0.02));
      break;
    }
    case 'pallet_stack': {
      add('pallet', B(w, 0.13, d, 0, 0.065, 0));
      const layers = rng.int(1, 3);
      for (let l = 0; l < layers; l++) for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 2; b2++) {
        if (l > 0 && rng.chance(0.3)) continue;
        const bw = w / 2 - 0.04, bd = d / 2 - 0.04, bh = 0.3;
        add(rng.chance(0.6) ? 'cardboard' : 'cardboardDark', B(bw, bh, bd, -w / 4 + a * (w / 2), 0.13 + bh / 2 + l * (bh + 0.005), -d / 4 + b2 * (d / 2)).rotateY((rng.next() - 0.5) * 0.04));
      }
      if (rng.chance(0.5)) add('black', B(0.03, 0.02, d + 0.02, w * 0.2, 0.13 + layers * 0.3, 0), B(0.03, 0.02, d + 0.02, -w * 0.2, 0.13 + layers * 0.3, 0));
      break;
    }
    case 'plant_table': {
      add('steelDark', B(w, 0.04, d, 0, 0.82, 0));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('steelDark', B(0.04, 0.8, 0.04, sx * (w / 2 - 0.05), 0.4, sz * (d / 2 - 0.05)));
      for (let k = 0; k < 8; k++) {
        if (rng.chance(0.2)) continue;
        const x = -w / 2 + 0.17 + (k % 4) * ((w - 0.34) / 3), z = k < 4 ? -0.18 : 0.18;
        add('pot', CY(0.09, 0.16, x, 0.92, z, 10, 0.07));
        const hh = 0.15 + rng.next() * 0.35;
        const cr = 0.07 + rng.next() * 0.05;
        add('plant', shape('cone:5', () => new THREE.ConeGeometry(1, 1, 5)).scale(cr, hh, cr).translate(x, 1.0 + hh / 2, z).rotateY(rng.next()));
      }
      break;
    }
    case 'bench': {
      for (let k = 0; k < 3; k++) add('wood', B(w, 0.03, 0.11, 0, 0.45, -d / 2 + 0.07 + k * 0.14));
      add('steelDark', B(0.04, 0.44, d - 0.04, -w / 2 + 0.15, 0.22, 0), B(0.04, 0.44, d - 0.04, w / 2 - 0.15, 0.22, 0));
      break;
    }
    case 'filing': {
      add('metal_painted', B(w, 1.32, d, 0, 0.66, 0));
      const roll = rng.chance(0.2) ? rng.int(0, 3) : -1;
      const open = o.host ? -1 : roll;
      for (let k = 0; k < 4; k++) {
        // container hosts: a dark opening on the carcass face behind each drawer front (seen when it slides out)
        if (o.host) add('black', B(w - 0.08, FILING_DRAWER.h - 0.03, 0.002, 0, FILING_DRAWER.y0 + k * FILING_DRAWER.pitch, d / 2 + 0.001));
        if (o.skip?.has(k)) continue;
        const y = FILING_DRAWER.y0 + k * FILING_DRAWER.pitch, oz = k === open ? 0.3 : 0;
        add('metal_painted', B(w - 0.04, 0.29, 0.02, 0, y, d / 2 + 0.01 + oz));
        add('steel', B(0.12, 0.02, 0.03, 0, y + 0.06, d / 2 + 0.035 + oz));
        if (k === open) add('paper', B(w - 0.1, 0.22, 0.28, 0, y, d / 2 - 0.13 + oz));
      }
      break;
    }
    case 'pipes_wall': {
      // vertical risers from the floor to the ceiling void (centred on the mount height)
      for (const [x, r] of [[-0.2, 0.06], [0.05, 0.045], [0.24, 0.035]] as const) {
        add('metal_painted', CY(r, 2.9, x, 0.17, 0, 10));
        for (const y of [-0.8, 0.4]) add('steelDark', B(r * 2 + 0.04, 0.05, 0.12, x, y, -0.04));
      }
      add('red', new THREE.TorusGeometry(0.09, 0.016, 6, 14).translate(-0.2, -0.1, 0.09));
      break;
    }
    case 'fire_ext': {
      add('red', CY(0.075, 0.48, 0, -0.05, 0.02, 14), B(0.3, 0.12, 0.02, 0, 0.28, -0.09));
      add('black', CY(0.03, 0.08, 0, 0.23, 0.02, 8), B(0.02, 0.3, 0.02, 0.07, 0.02, 0.09));
      break;
    }
    case 'noticeboard': {
      add('cork', B(w, 0.8, 0.02, 0, 0, -0.01));
      add('woodDark', B(w + 0.05, 0.04, 0.035, 0, 0.42, 0), B(w + 0.05, 0.04, 0.035, 0, -0.42, 0));
      for (let k = rng.int(3, 7); k > 0; k--) add('paper', B(0.18 + rng.next() * 0.1, 0.24 + rng.next() * 0.08, 0.003, (rng.next() - 0.5) * (w - 0.3), (rng.next() - 0.5) * 0.45, 0.003).rotateZ((rng.next() - 0.5) * 0.2));
      break;
    }
    case 'clock': {
      add('black', CZ(0.17, 0.05, 0, 0, 0, 24));
      add('enamel', CZ(0.145, 0.01, 0, 0, 0.027, 24));
      add('black', B(0.012, 0.1, 0.006, 0, 0.04, 0.034).rotateZ(-0.6), B(0.01, 0.13, 0.006, 0, 0.05, 0.036).rotateZ(2.2));
      break;
    }
    case 'crucifix': {
      add('woodDark', B(0.07, 0.8, 0.04, 0, 0, 0), B(0.44, 0.07, 0.04, 0, 0.15, 0));
      break;
    }
    default: {
      if (!def) return null;
      const dims = { w, d, h: Number(it.data?.h ?? def.h), n };
      return kitParts(key, dims, rng, String(it.data?.room ?? ''), def.mount) ?? fallbackParts(dims, def.mount);
    }
  }
  return P;
}

/** a procedural host's movable part: one geometry per material + shape (instanced), optionally with a second piece
 *  that moves on its own (a morgue door swinging aside on a vertical hinge while the tray slides) */
export interface ProcPartGeometry {
  mat: string; geo: THREE.BufferGeometry; shapeKey: string;
  piece?: {
    mat: string; geo: THREE.BufferGeometry; shapeKey: string;
    /** piece centre relative to the part centre (closed pose) */
    offset: [number, number, number];
    /** hinge line (vertical) relative to the part centre */
    pivot: [number, number, number];
    sign: 1 | -1; travel: number;
    /** part openness at which the piece is fully swung */
    lead: number;
  };
}

/** counter cupboard floor (top face) on container hosts: env-layout's slot height, where searched items lie */
export const COUNTER_FLOOR_Y = 0.15;

/**
 * Hollow carcass of a container-host counter: three real cupboard bays (floor slab, back, end panels, two dividers, a
 * face frame around the openings and a dark back liner), so whatever lies at a bay's slot is seen once its door swings
 * open. Doors (drawn as movable instances) hang on the frame at z d/2 - 0.03; the worktop closes the top at y 0.9.
 */
function counterCarcass(w: number, d: number, add: (mat: string, ...g: AnyGeo[]) => void): void {
  const t = 0.02, bay = w / 3, zb = -d / 2, zf = d / 2 - 0.04, yb = COUNTER_FLOOR_Y, yt = 0.9;
  // each opening is 2 cm smaller than its door all round (doors w/3 - 0.06 x 0.6 at y 0.5)
  const ow = bay - 0.1, oy0 = 0.22, oy1 = 0.78;
  const inner = d - 0.04 - t, zi = zb + t + inner / 2;
  add('metal_painted',
    B(w, yb - 0.04, d - 0.04, 0, (0.04 + yb) / 2, -0.02), // floor slab (its top is the cupboard floor)
    B(w, yt - yb, t, 0, (yb + yt) / 2, zb + t / 2), // back
    // ends + dividers run from the back to the face frame
    B(t, yt - yb, inner - t, -w / 2 + t / 2, (yb + yt) / 2, zi - t / 2), B(t, yt - yb, inner - t, w / 2 - t / 2, (yb + yt) / 2, zi - t / 2),
    B(t, yt - yb, inner - t, -bay / 2, (yb + yt) / 2, zi - t / 2), B(t, yt - yb, inner - t, bay / 2, (yb + yt) / 2, zi - t / 2),
    // face frame: bottom + top rails, outer + inner stiles
    B(w, oy0 - yb, t, 0, (yb + oy0) / 2, zf - t / 2), B(w, yt - oy1, t, 0, (oy1 + yt) / 2, zf - t / 2),
    B((bay - ow) / 2, oy1 - oy0, t, -w / 2 + (bay - ow) / 4, (oy0 + oy1) / 2, zf - t / 2), B((bay - ow) / 2, oy1 - oy0, t, w / 2 - (bay - ow) / 4, (oy0 + oy1) / 2, zf - t / 2),
    B(bay - ow, oy1 - oy0, t, -bay / 2, (oy0 + oy1) / 2, zf - t / 2), B(bay - ow, oy1 - oy0, t, bay / 2, (oy0 + oy1) / 2, zf - t / 2),
  );
  // a dark liner on each bay's back wall: the cupboards read deep, the items in front of it stand out
  for (let k = 0; k < 3; k++) add('black', B(bay - t - 0.012, yt - yb - 0.012, 0.004, -bay + k * bay, (yb + yt) / 2, zb + t + 0.002));
}

/**
 * Geometry of a procedural host's movable part in its CLOSED pose, CENTRED on the part's own centre (the level places
 * it with T(part.local), so same-size parts share one instanced geometry: shapeKey). One material each.
 * filing: front + pull + an open-top tray with hanging files at its back; morgue_drawers: a door front + handle + a
 * slab tray with a sheeted shape at its back; counter: a cupboard door + pull.
 * `slot` = where searched items lie, relative to the part centre in its CLOSED pose (x, floor y, z); default =
 * env-layout's convention for the key. Trays put their floor exactly at the slot height (items rest ON it, never in
 * it) and keep the slot area clear.
 */
export function procPartGeometry(key: string, part: { idx: number; kind?: string; size: [number, number, number]; travel?: number }, slot?: readonly [number, number, number]): ProcPartGeometry {
  const [sw, sh, sd] = part.size;
  const parts: AnyGeo[] = [];
  const fz = sd / 2;
  const travel = part.travel ?? (key === 'morgue_drawers' ? 0.45 : 0.4);
  // env-layout's slot conventions: drawers 3 cm over the part bottom, half the travel past the closed front; morgue
  // trays 0.13 m under the door centre, 0.2 m past the front
  const fy = slot?.[1] ?? (key === 'morgue_drawers' ? -0.13 : -sh / 2 + 0.03);
  const sz = slot?.[2] ?? (key === 'morgue_drawers' ? fz + 0.2 - travel : fz + travel / 2 - travel);
  const mm = (v: number) => Math.round(v * 1000);
  const shapeKey = `${key}:${part.kind ?? 'drawer'}:${mm(sw)}x${mm(sh)}x${mm(sd)}:${mm(fy)}:${mm(sz)}`;
  if (key === 'filing') {
    const td = Math.max(0.12, sd - 0.03), tz = fz - 0.02 - td / 2, back = tz - td / 2;
    const top = sh * 0.23, bot = fy - 0.012;
    parts.push(B(sw, sh, 0.02, 0, 0, fz - 0.01));
    parts.push(B(0.12, 0.02, 0.03, 0, 0.06, fz + 0.015));
    parts.push(B(sw - 0.04, 0.012, td, 0, fy - 0.006, tz)); // tray floor: its top is the slot height
    for (const sx of [-1, 1]) parts.push(B(0.012, top - bot, td, sx * (sw / 2 - 0.026), (top + bot) / 2, tz));
    parts.push(B(sw - 0.04, top - bot, 0.012, 0, (top + bot) / 2, back + 0.006));
    // hanging files only in the back of the tray: the slot (items, a lore page) stays in the clear
    const fileEnd = Math.min(back + 0.17, sz - 0.14);
    for (let k = 0; k < 4; k++) {
      const z = back + 0.035 + k * ((fileEnd - back - 0.035) / 3);
      if (z > fileEnd + 1e-6) break;
      parts.push(B(sw - 0.09, sh * 0.62, 0.004, 0, fy + sh * 0.31, z));
    }
    return { mat: 'metal_painted', geo: mergeAll(parts), shapeKey };
  }
  if (key === 'morgue_drawers') {
    // a real mortuary cabinet: the insulated door swings aside on its left edge (a separate piece, fully open a third
    // of the way) while the slab tray rolls out behind it, so the tray is seen from a standing height
    parts.push(B(sw - 0.06, 0.04, sd - 0.06, 0, fy - 0.02, -0.01)); // slab tray: its top is the slot height
    parts.push(B(sw - 0.12, 0.022, 0.022, 0, fy + 0.03, fz - 0.06)); // pull bar at its front end
    for (const sx of [-1, 1]) parts.push(B(0.02, 0.05, 0.02, sx * (sw / 2 - 0.07), fy + 0.005, fz - 0.06));
    // a sheeted shape pushed to the back of the tray, ending 12 cm short of the slot
    const z0 = -sd / 2 + 0.04, len = Math.max(0.02, Math.min(0.14, sz - 0.12 - z0 - 0.2));
    parts.push(new THREE.CapsuleGeometry(0.1, len, 4, 10).rotateX(Math.PI / 2).scale(1, 0.5, 1).translate(0, fy + 0.04, z0 + 0.1 + len / 2));
    const door = mergeAll([B(sw, sh, 0.025, 0, 0, 0), B(0.03, 0.15, 0.035, sw / 2 - 0.07, 0.02, 0.03)]);
    return {
      mat: 'steelDark', geo: mergeAll(parts), shapeKey,
      piece: { mat: 'steelDark', geo: door, shapeKey: `${shapeKey}:door`, offset: [0, 0, fz - 0.0125], pivot: [-sw / 2, 0, fz], sign: -1, travel: 1.75, lead: 0.35 },
    };
  }
  if (part.kind === 'door' || key === 'counter') {
    parts.push(B(sw, sh, Math.max(0.008, sd), 0, 0, 0));
    parts.push(B(0.02, 0.12, 0.03, sw / 2 - 0.06, 0.18, Math.max(0.008, sd) / 2 + 0.015));
    return { mat: 'steelDark', geo: mergeAll(parts), shapeKey };
  }
  parts.push(B(sw, sh, Math.max(0.01, Math.min(0.03, sd)), 0, 0, fz - 0.012));
  parts.push(B(Math.min(0.16, sw * 0.4), 0.025, 0.04, 0, sh * 0.2, fz + 0.02));
  if (sd > 0.1) parts.push(B(sw - 0.04, 0.02, sd - 0.04, 0, -sh / 2 + 0.02, -0.01));
  return { mat: 'metal_painted', geo: mergeAll(parts), shapeKey };
}

/** non-indexed merge keeping position / normal / uv (one geometry per movable part) */
export function mergeAll(gs: readonly AnyGeo[]): THREE.BufferGeometry {
  return mergeParts(gs.map((g) => (g instanceof GeoRef ? { geo: g.geo, m: g.m } : { geo: g, m: null })));
}

/** a procedural flooded floor for a boiler hall: one dark water sheet over the room (local to the space rect) */
export function waterSheet(x: number, z: number, w: number, h: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w - 0.17, h - 0.17).rotateX(-Math.PI / 2).translate(x + w / 2, 0.05, z + h / 2);
}

// ---------------------------------------------------------------- clutter

/** Parts of one clutter item in WORLD space. */
export function clutterParts(ci: ClutterItem, rng: Rng): Part[] {
  const P: Part[] = [];
  const m = new THREE.Matrix4().makeRotationY(ci.rot).setPosition(ci.x, ci.y, ci.z);
  const add = (mat: string, g: AnyGeo, world = false) => { P.push(part(mat, world ? g : g.applyMatrix4(m))); };
  switch (ci.kind) {
    case 'paper':
      for (let k = 0; k < ci.a; k++) add('paper', shape('plane:0.21x0.297', () => new THREE.PlaneGeometry(0.21, 0.297)).rotateX(-Math.PI / 2).rotateY(rng.next() * 3).translate((rng.next() - 0.5) * 0.3, k * 0.002, (rng.next() - 0.5) * 0.3));
      break;
    case 'box':
      for (let k = 0; k < ci.a; k++) {
        const w = 0.3 + rng.next() * 0.25, h = 0.2 + rng.next() * 0.2, d = 0.25 + rng.next() * 0.2;
        add(rng.chance(0.6) ? 'cardboard' : 'cardboardDark', B(w, h, d, 0, h / 2 + k * 0.001, 0).rotateY((rng.next() - 0.5) * 0.6).translate((rng.next() - 0.5) * 0.35, 0, (rng.next() - 0.5) * 0.2));
        if (rng.chance(0.4) && k === 0) add('cardboard', B(w * 0.9, 0.18, d * 0.9, 0, h + 0.09, 0).rotateY(0.4));
      }
      break;
    case 'bottle':
      for (let k = 0; k < ci.a; k++) {
        const g = cyl(0.035, 0.24, 0, 0.12, 0, 8);
        if (rng.chance(0.45)) g.rotateZ(Math.PI / 2).translate(0, -0.085, 0);
        add(rng.chance(0.5) ? 'glassBrown' : 'glassGreen', g.rotateY(rng.next() * 3).translate((rng.next() - 0.5) * 0.3, 0, (rng.next() - 0.5) * 0.3));
      }
      break;
    case 'debris':
      for (let k = 0; k < ci.a; k++) {
        const s = 0.06 + rng.next() * 0.16;
        add('rubble', box(s * (1 + rng.next()), s * 0.7, s * (1 + rng.next())).rotateY(rng.next() * 3).rotateZ((rng.next() - 0.5) * 0.6).translate((rng.next() - 0.5) * 0.5, s * 0.3, (rng.next() - 0.5) * 0.5));
      }
      break;
    case 'tile': {
      // a dark hole in the ceiling grid + (when the floor below is free) the fallen tile
      add('hole', shape('plane:0.6x0.6', () => new THREE.PlaneGeometry(0.6, 0.6)).rotateX(Math.PI / 2).translate(0, -0.006, 0));
      if (ci.b > 0) add('ceiling_tiles', B(0.6, 0.015, 0.6, 0, 0, 0).rotateZ((rng.next() - 0.5) * 0.2).applyMatrix4(new THREE.Matrix4().makeTranslation(0.3 * (rng.next() - 0.5), 0.012 - ci.y, 0.3 * (rng.next() - 0.5))));
      if (ci.a > 0.6) add('ceiling_tiles', B(0.6, 0.015, 0.3, 0.15, -0.25, 0.2).rotateX(0.9)); // half-hanging tile
      break;
    }
    case 'cable': {
      for (let k = 0; k < ci.b; k++) {
        const len = ci.a * (0.6 + rng.next() * 0.6);
        add('cable', CY(0.008, len, (rng.next() - 0.5) * 0.25, -len / 2, (rng.next() - 0.5) * 0.25, 5).rotateZ((rng.next() - 0.5) * 0.2));
      }
      break;
    }
    case 'puddle':
      add('puddle', shape('circle:0.5:14', () => new THREE.CircleGeometry(0.5, 14)).scale(ci.a, ci.b + 0.4, 1).rotateX(-Math.PI / 2));
      break;
    case 'stain':
      add('stain', shape('circle:0.45:12', () => new THREE.CircleGeometry(0.45, 12)).scale(ci.a, ci.a * (0.5 + ci.b), 1).rotateX(-Math.PI / 2));
      break;
    case 'poster': {
      const g = new THREE.PlaneGeometry(0.46, 0.46).rotateZ(ci.b);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const cx = (ci.a % 4) / 4, cy = 1 - (Math.floor(ci.a / 4) + 1) / 2;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, cx + uv.getX(i) * 0.25, cy + uv.getY(i) * 0.5);
      add('poster', g.translate(0, 0, 0.004));
      break;
    }
    case 'pipe': {
      const x2 = ci.x2 ?? ci.x, z2 = ci.z2 ?? ci.z;
      const len = Math.hypot(x2 - ci.x, z2 - ci.z);
      const alongX = Math.abs(x2 - ci.x) > Math.abs(z2 - ci.z);
      const mx = (ci.x + x2) / 2, mz = (ci.z + z2) / 2;
      const pipe = alongX ? CX(ci.a, len, mx, ci.y, mz, 10) : CZ(ci.a, len, mx, ci.y, mz, 10);
      add(ci.b === 0 ? 'metal_rusty' : 'metal_painted', pipe, true);
      // hangers every ~1.8 m + flanges
      for (let t = 0.9; t < len; t += 1.8) {
        const hx = alongX ? ci.x + Math.sign(x2 - ci.x) * t : ci.x, hz = alongX ? ci.z : ci.z + Math.sign(z2 - ci.z) * t;
        add('steelDark', B(0.02, 3.0 - ci.y, 0.02, hx, (3.0 + ci.y) / 2, hz), true);
        add('steelDark', alongX ? CX(ci.a + 0.018, 0.05, hx + 0.3, ci.y, hz, 10) : CZ(ci.a + 0.018, 0.05, hx, ci.y, hz + 0.3, 10), true);
      }
      break;
    }
    default:
      break;
  }
  return P;
}

/** Contents for asset furniture (in the model's local frame, front = +Z): books / boxes on shelves, office desk tops. */
export function fillParts(key: string, rng: Rng, roomType: string): Part[] {
  const P: Part[] = [];
  const add = (mat: string, ...gs: AnyGeo[]) => { for (const g of gs) P.push(part(mat, g)); };
  if (key === 'shelves') {
    const books = roomType === 'library' || roomType === 'archive' || roomType === 'office' || roomType === 'mailroom';
    for (const y of [0.06, 0.53, 1.0, 1.47]) {
      if (rng.chance(0.2)) continue;
      let x = -0.5;
      while (x < 0.48) {
        if (books && rng.chance(0.75)) {
          // a run of books, some leaning
          const run = rng.int(4, 12);
          for (let k = 0; k < run && x < 0.48; k++) {
            const bw = 0.03 + rng.next() * 0.03, bh = 0.2 + rng.next() * 0.13, bd = 0.17 + rng.next() * 0.08;
            const g = B(bw, bh, bd, 0, bh / 2, 0);
            if (k === run - 1 && rng.chance(0.4)) g.rotateZ(-0.35).translate(0.04, -0.01, 0);
            add(['bookA', 'bookB', 'bookC'][rng.int(0, 2)], g.translate(x + bw / 2, y, 0.02));
            x += bw + 0.004;
          }
          x += 0.05 + rng.next() * 0.12;
        } else {
          const bw = 0.2 + rng.next() * 0.16, bh = 0.16 + rng.next() * 0.14;
          if (x + bw > 0.52) break;
          add(rng.chance(0.6) ? 'cardboard' : 'cardboardDark', B(bw, bh, 0.3, x + bw / 2, y + bh / 2, 0.02));
          x += bw + 0.04 + rng.next() * 0.1;
        }
      }
    }
  } else if (key === 'desk') {
    // CRT monitor, keyboard, papers, a mug, sometimes a desk lamp (front of the desk = +Z, the chair side)
    const mx = (rng.next() - 0.5) * 0.8;
    if (rng.chance(0.75)) {
      add('enamel', B(0.42, 0.36, 0.4, mx, 0.79 + 0.2, -0.15));
      add('black', B(0.34, 0.27, 0.01, mx, 0.79 + 0.21, 0.056), B(0.44, 0.03, 0.14, mx, 0.795, 0.15));
    }
    for (let k = rng.int(1, 4); k > 0; k--) add('paper', B(0.21, 0.004, 0.297, (rng.next() - 0.5) * 1.5, 0.792 + k * 0.002, (rng.next() - 0.3) * 0.5).rotateY(rng.next() - 0.5));
    if (rng.chance(0.5)) add('enamel', CY(0.04, 0.09, mx + 0.5, 0.835, 0.1, 10));
    if (rng.chance(0.35)) add('steelDark', CY(0.08, 0.02, -mx * 0.5 - 0.5, 0.8, -0.2, 12), B(0.02, 0.4, 0.02, -mx * 0.5 - 0.5, 1.0, -0.2), CY(0.09, 0.12, -mx * 0.5 - 0.4, 1.2, -0.15, 12, 0.05));
  }
  return P;
}
