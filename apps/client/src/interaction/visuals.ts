// Owner: track (b) Interaction / v1.2 G3 interaction-gear. Procedural item meshes (world items, held view model, thrown
// bottles), lit glowstick markers (emissive only + a floor halo, no lights), revive rings at fresh bodies, the target
// glint, burning flares (+ FLARE_LIGHTS pooled unshadowed SpotLights created once at start-up, so the light-type set
// never changes mid-game), armed motion sensors (blinking LED), the v1.2 gear and field-note page models, crafting
// materials + dropped pouches (one global InstancedMesh per type: 7 draws at most, no shadows, compacted to the visible
// spaces), one pooled unshadowed flashbulb SpotLight, and the view model on render.layers.firstPerson when render has it.
// v1.2 draw budget (gate P):
// - every model is ONE merged geometry per pass: per-vertex colour, roughness / metalness and emissive radiance are read
//   by two shared node materials (opaque + clear), so a world item costs 1 draw (2 with glass) and every item, LED,
//   glint, revive ring and material instance shares one pipeline;
// - only items of 0.3 m or more cast shadows (ITEM_CASTS), and every item mesh sits on render.layers.detail when render
//   provides it (every view draws it, only your own beam shadows it; layer 0 without it);
// - world items, lit glowsticks and burning flares in spaces the camera cannot see (level.visibleSpaces) are hidden, the
//   same test the material instances use, and the pooled flare lights only go to visible flares;
// - the pre-warm is one microscopic mesh per pipeline (only one of them casts) and ends after 3 drawn frames AND 0.5 s;
// - the per-frame path allocates nothing while nothing changes: structure re-syncs on the interaction state version,
//   the layout or a new visible-space set.
import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MATERIAL_COLOR, itemDef } from '@dead-air/shared/interactables.ts';
import { MATERIAL_TYPES, POUCH_TYPE } from '@dead-air/shared/catalog.ts';
import type { InteractionState, ItemState } from '@dead-air/shared/messages/interaction.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;
type V3 = [number, number, number];

// ---------------------------------------------------------------- surfaces + the shared materials

/** one surface of a model: colour (sRGB hex), roughness, metalness, emissive colour x intensity, opacity (< 1 = clear pass) */
export interface Surf { color: number; rough?: number; metal?: number; emissive?: number; ei?: number; opacity?: number }

const DARK: Surf = { color: 0x222222, rough: 0.6 };
const STEEL: Surf = { color: 0x8a8f94, rough: 0.35, metal: 0.9 };

/** world items of 0.3 m or more cast shadows; anything smaller only receives them (a shadow draw per beam for a shadow
 *  nobody sees). The bottle (a 7 cm cylinder, 0.31 m tall) and the loot boxes under 0.3 m stay off. */
export const ITEM_CASTS: ReadonlySet<string> = new Set(['crowbar', 'medkit', 'loot.heavy', 'loot.idol']);

let solidMat: THREE.MeshStandardNodeMaterial | null = null;
let clearMat: THREE.MeshStandardNodeMaterial | null = null;
/** The two item materials: per-vertex colour ('color': rgb, rgba on the clear pass), roughness + metalness ('ixs') and
 *  emissive radiance ('ixe', linear colour x intensity). Every item model, LED, glint, revive ring and material instance
 *  uses one of them, so they all share one pipeline (per pass) and the pre-warm compiles it once. */
export function itemMaterial(clear: boolean): THREE.MeshStandardNodeMaterial {
  const have = clear ? clearMat : solidMat;
  if (have) return have;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  m.name = clear ? 'ix.items.clear' : 'ix.items';
  m.colorNode = attribute('color', clear ? 'vec4' : 'vec3') as AnyNode;
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
/** writes the surface as vertex attributes (colour in the linear working space, like a material colour) */
function paint(gm: THREE.BufferGeometry, s: Surf, clear: boolean): THREE.BufferGeometry {
  const n = gm.attributes.position!.count;
  const k = clear ? 4 : 3;
  const col = new Float32Array(n * k), sur = new Float32Array(n * 2), emi = new Float32Array(n * 3);
  _col.set(s.color);
  const r = _col.r, gr = _col.g, b = _col.b, a = s.opacity ?? 1;
  let er = 0, eg = 0, eb = 0;
  if (s.emissive !== undefined) {
    _col.set(s.emissive);
    const ei = s.ei ?? 1;
    er = _col.r * ei; eg = _col.g * ei; eb = _col.b * ei;
  }
  const rough = s.rough ?? 0.6, metal = s.metal ?? 0;
  for (let i = 0; i < n; i++) {
    col[i * k] = r; col[i * k + 1] = gr; col[i * k + 2] = b;
    if (clear) col[i * k + 3] = a;
    sur[i * 2] = rough; sur[i * 2 + 1] = metal;
    emi[i * 3] = er; emi[i * 3 + 1] = eg; emi[i * 3 + 2] = eb;
  }
  gm.setAttribute('color', new THREE.BufferAttribute(col, k));
  gm.setAttribute('ixs', new THREE.BufferAttribute(sur, 2));
  gm.setAttribute('ixe', new THREE.BufferAttribute(emi, 3));
  return gm;
}

/** only position + normal survive into a merged model (no maps: the surfaces are vertex attributes) */
function strip(gm: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const k of Object.keys(gm.attributes)) if (k !== 'position' && k !== 'normal') gm.deleteAttribute(k);
  return gm;
}

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
    const gm = strip(shape.clone());
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

const geo = new Map<string, THREE.BufferGeometry>();
function g<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let x = geo.get(key) as T | undefined;
  if (!x) geo.set(key, (x = make()));
  return x;
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
  return { color, rough, metal, emissive: color, ei: type === 'mat.relic' ? 0.5 : type === 'mat.optics' ? 0.3 : 0.12 };
}

/** v1.2 world materials + pouches: one merged, painted geometry per type (origin = bottom centre) */
function matGeometry(type: string): THREE.BufferGeometry {
  return g(`mat.geo:${type}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const at = (gm: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void => {
      gm.rotateX(rx); gm.rotateY(ry); gm.rotateZ(rz); gm.translate(x, y, z);
      parts.push(strip(gm.index ? gm.toNonIndexed() : gm));
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

// ---------------------------------------------------------------- item models

interface ModelGeo {
  solid: THREE.BufferGeometry | null;
  clear: THREE.BufferGeometry | null;
  /** a separate blinking LED (the walkie's view model, an armed sensor) */
  led: THREE.BufferGeometry | null;
  halo: HaloGeo | null;
  /** the burning flare's upright glow sprite */
  glow: boolean;
}
const modelGeos = new Map<string, ModelGeo>();

/** the merged geometry of a model (cached per type / variant). Origin = bottom centre, +Z forward. */
function modelGeometry(type: string, lit: boolean, vm: boolean): ModelGeo {
  const key = `${type}${type === 'glowstick' && lit ? ':lit' : ''}${type === 'walkie' && vm ? ':vm' : ''}`;
  const have = modelGeos.get(key);
  if (have) return have;
  const P = new Parts();
  const LED = new Parts();
  let hg: HaloGeo | null = null;
  let glow = false;
  let mg: ModelGeo | null = null;
  const H = Math.PI / 2;
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
      if (lit) hg = haloGeometry('gs', [{ w: 2.6, color: 0x39ff6a, a: 0.32, y: 0 }, { w: 0.5, color: 0xb8ffc8, a: 0.55, y: 0.002 }], [0, 0.01, 0]);
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
        hg = haloGeometry('fl', [{ w: 4.2, color: 0xff2a12, a: 0.42, y: 0 }], [0, 0.012, 0.1]);
        glow = true;
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
      if (armed) hg = haloGeometry('ms', [{ w: 0.9, color: 0x30ffd0, a: 0.28, y: 0 }], [0, 0.006, 0]);
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
      hg = haloGeometry('id', [{ w: 0.9, color: 0x7a3cff, a: 0.22, y: 0 }], [0, 0.008, 0]);
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
      P.add(g('pg.sheet', () => {
        const pg = new THREE.PlaneGeometry(0.148, 0.21, 6, 1);
        const pos = pg.attributes.position!;
        for (let i = 0; i < pos.count; i++) pos.setZ(i, 0.006 * (pos.getX(i) / 0.074) ** 2);
        pg.computeVertexNormals();
        return pg;
      }), { color: 0xe8dfc6, rough: 0.9, emissive: 0x2a2618, ei: 0.4 }, 0, 0.004, 0, -H);
      for (let i = 0; i < 6; i++) P.add(g('pg.line', () => new THREE.PlaneGeometry(0.11, 0.0022)), { color: 0x3b3a52, rough: 0.9 }, -0.008, 0.0072, -0.07 + i * 0.025, -H);
      break;
    }
    default: {
      // crafting materials / pouches (the world draws them instanced; this one is for previews and held models)
      if (type.startsWith('mat.')) { mg = { solid: matGeometry(type), clear: null, led: null, halo: null, glow: false }; break; }
      // salvage (only when this track rolls loot; objectives renders its own)
      const tier = type === 'loot.heavy' ? 2 : type === 'loot.medium' ? 1 : 0;
      const s = [0.14, 0.26, 0.46][tier]!;
      P.add(g(`loot.${tier}`, () => new THREE.BoxGeometry(s, s * 0.7, s * 0.8)), { color: [0xb08d2a, 0x8d6b3a, 0x6c5a48][tier]!, rough: 0.5, metal: 0.5 }, 0, s * 0.35, 0);
      break;
    }
  }
  mg ??= { solid: mergeParts(P.solid), clear: mergeParts(P.clear), led: mergeParts(LED.solid), halo: hg, glow };
  modelGeos.set(key, mg);
  return mg;
}

/** Build a model for an item type: one 'body' mesh (+ 'glass' for clear parts, 'led' for a blinking LED, 'halo' and
 *  'glow' for lit things). Origin = bottom centre, +Z forward. vm = the first-person view model variant. */
export function buildItemModel(type: string, opts: { lit?: boolean; vm?: boolean } = {}): THREE.Group {
  const grp = new THREE.Group();
  grp.name = `ix:${type}`;
  const mg = modelGeometry(type, !!opts.lit, !!opts.vm);
  if (mg.solid) {
    const me = new THREE.Mesh(mg.solid, itemMaterial(false));
    me.name = 'body';
    me.castShadow = ITEM_CASTS.has(type);
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
  return grp;
}

// real prop models for some world items via ② Level's loader (guarded: absent / failing -> the procedural model stays)
const PROP_FOR: Record<string, string> = { crowbar: 'crowbar', medkit: 'medical_box' };
type PropLoader = (key: string) => Promise<THREE.Object3D | null>;
interface LevelAssetsLike { loadPropModel?: PropLoader; templateInfo?: (tpl: THREE.Object3D | null) => { full(): THREE.Mesh[] } | null }
let assetsMod: Promise<LevelAssetsLike | null> | null = null;
/** the prop as few meshes as possible: body + parts merged per material when the level split it (1 draw for both GLBs) */
function propModel(key: string): Promise<THREE.Mesh[] | THREE.Object3D | null> {
  assetsMod ??= import('../level/assets.ts').then((m) => m as unknown as LevelAssetsLike).catch(() => null);
  return assetsMod.then(async (m) => {
    if (!m?.loadPropModel) return null;
    const tpl = await m.loadPropModel(key).catch(() => null);
    if (!tpl) return null;
    try { const full = m.templateInfo?.(tpl)?.full(); if (full?.length) return full; } catch { /* older level build */ }
    return tpl;
  });
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
}

export interface VisualOpts {
  camera: THREE.PerspectiveCamera;
  activeType: string | null;
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
  /** identity of the current layout (a new one re-places everything) */
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

const VM_POSE: Record<string, { pos: V3; rot: V3; scale: number }> = {
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
};
const VM_DEFAULT = { pos: [0, -0.1, 0] as V3, rot: [0.2, 0.3, 0] as V3, scale: 0.7 };

const HELD_TILT: Record<string, V3> = {
  crowbar: [-1.2, 0, 0], bottle: [0.2, 0, 0], glowstick: [-1.3, 0, 0], flashlight_pro: [-0.2, 0, 0], flare: [-1.2, 0, 0],
  syringe: [-1.2, 0, 0], lockpick: [-1.1, 0, 0], masterkey: [-1.3, 0, 0], flashbulb: [-0.3, 0, 0],
};
const NO_TILT: V3 = [0, 0, 0];

/** a placed world object: its last placement and the space it stands in (-1 = none: always drawn) */
interface Placed { obj: THREE.Group; type: string; x: number; y: number; z: number; rot: number; space: number; gen: number; led: THREE.Object3D | null }
interface FlareObj { obj: THREE.Group; space: number; gen: number; x: number; z: number; until: number; k: number; d: number; halo: THREE.Object3D | null; glow: THREE.Object3D | null }
interface RingObj { mesh: THREE.Mesh; until: number; gen: number }

export function createVisuals(scene: THREE.Scene, cfg: { propModels?: boolean } = {}): Visuals {
  const root = new THREE.Group();
  root.name = 'interaction';
  scene.add(root);
  const items = new Map<string, Placed>();
  const glows = new Map<string, Placed>();
  const flares = new Map<string, FlareObj>();
  const rings = new Map<string, RingObj>();
  const thrown = new Map<string, { obj: THREE.Group; gen: number }>();
  const heldObjs = new Map<string, { type: string; obj: THREE.Group; gen: number }>();
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
  // v1.2 crafting materials + pouches: one InstancedMesh per type (no shadows, one shared material = one pipeline),
  // compacted to the visible spaces
  const MAT_CAP = 64;
  const matTypes = [...MATERIAL_TYPES, POUCH_TYPE];
  const matMeshes = new Map<string, THREE.InstancedMesh>();
  const matLists = new Map<string, ItemState[]>();
  /** per type: the uploaded instances as [x, y, z, yaw, ...] (an unchanged compaction skips the upload) */
  const matPrev = new Map<string, number[]>();
  for (const t of matTypes) {
    const im = new THREE.InstancedMesh(matGeometry(t), itemMaterial(false), MAT_CAP);
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

  // ---- pre-warm (initial-lag fix): one microscopic mesh per item pipeline right in front of the camera (layer 0, its
  // own group: never on the first-person layer), drawn during the first frames (join / loading screen) so the pipelines
  // compile there instead of the first time someone picks up a medkit or throws a flare mid-contract. Only the opaque
  // item mesh casts (the item depth pipeline); it ends after WARM_FRAMES drawn frames AND WARM_MS.
  const warm = new THREE.Group();
  warm.name = 'ix-warm';
  warm.matrixAutoUpdate = false;
  const warmInner = new THREE.Group();
  warmInner.position.set(0, 0, -0.4);
  warmInner.scale.setScalar(0.0002);
  warm.add(warmInner);
  const wSolid = new THREE.Mesh(modelGeometry('keycard', false, false).solid!, itemMaterial(false));
  wSolid.castShadow = true;
  wSolid.receiveShadow = true;
  const wClear = new THREE.Mesh(modelGeometry('syringe', false, false).clear!, itemMaterial(true));
  wClear.receiveShadow = true;
  // same capacity as the world material meshes: the instance matrices are a uniform array sized by it (same shader)
  const wInst = new THREE.InstancedMesh(matGeometry(MATERIAL_TYPES[0]), itemMaterial(false), MAT_CAP);
  wInst.count = 1;
  wInst.setMatrixAt(0, new THREE.Matrix4());
  wInst.receiveShadow = true;
  const wHalo = new THREE.Mesh(modelGeometry('glowstick', true, false).halo!.geo, haloMaterial());
  const wGlow = new THREE.Sprite(glowMaterial());
  for (const o of [wSolid, wClear, wInst, wHalo, wGlow]) { o.frustumCulled = false; warmInner.add(o); }
  root.add(warm);
  let warmOn = true;
  let warmFrames = 0;
  let warmT0 = 0;
  let warmHit = false;
  let warmAnyAt = 0;
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
    wInst.dispose();
  };

  let vmType: string | null = null;
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

  // ---- structure (only when the state version, the layout or the visible-space set changes)
  const placeItem = (obj: THREE.Group, it: ItemState) => {
    const p = it.p!;
    obj.position.set(p[0], p[1], p[2]);
    // lying items: bottles / airhorns stand, crowbars lie, cards lie flat
    obj.rotation.set(0, it.rot ?? 0, 0);
    if (it.type === 'bottle' && p[1] < 0.05) obj.rotation.z = Math.PI / 2 * 0.98, obj.position.y = 0.04;
  };

  const dropItem = (id: string, e: Placed) => {
    root.remove(e.obj);
    if (e.led) armedLeds.delete(e.led);
    items.delete(id);
  };

  const syncItems = (st: InteractionState, spaceAt: VisualOpts['spaceAt'], relayout: boolean) => {
    const gn = ++gen;
    for (const id in st.items) {
      const it = st.items[id]!;
      if (it.where !== 'world' || !it.p) continue;
      if (matMeshes.has(it.type)) continue; // instanced (syncMaterials)
      const mtype = it.type === 'sensor' && it.armed ? 'sensor.armed' : it.type;
      let e = items.get(id);
      if (e && e.type !== mtype) { dropItem(id, e); e = undefined; }
      if (!e) {
        const obj = tagDetail(buildItemModel(mtype));
        const led = mtype === 'sensor.armed' ? (obj.getObjectByName('led') ?? null) : null;
        if (led) armedLeds.add(led);
        const made: Placed = { obj, type: mtype, x: NaN, y: NaN, z: NaN, rot: NaN, space: -1, gen: gn, led };
        e = made;
        root.add(obj);
        items.set(id, made);
        const pk = PROP_FOR[it.type];
        if (pk && cfg.propModels !== false) {
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
        placeItem(e.obj, it);
        e.space = spaceAt ? spaceAt(p[0], p[2]) : -1;
      }
    }
    for (const [id, e] of items) if (e.gen !== gn) dropItem(id, e);
  };

  const syncGlows = (st: InteractionState, spaceAt: VisualOpts['spaceAt'], relayout: boolean) => {
    const gn = ++gen;
    for (const id in st.glows) {
      const p = st.glows[id]!;
      let e = glows.get(id);
      if (!e) {
        const obj = tagDetail(buildItemModel('glowstick', { lit: true }));
        obj.rotation.y = (id.length * 1.7) % Math.PI;
        root.add(obj);
        glows.set(id, (e = { obj, type: 'glowstick', x: NaN, y: NaN, z: NaN, rot: 0, space: -1, gen: gn, led: null }));
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
        const obj = tagDetail(buildItemModel('flare.lit'));
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
        continue;
      }
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
        const obj = tagDetail(buildItemModel(t.id.includes(':flare:') ? 'flare.lit' : 'bottle'));
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

  const syncViewModel = (o: VisualOpts) => {
    vmRoot.matrix.copy(o.camera.matrixWorld);
    vmRoot.matrixWorldNeedsUpdate = true;
    const want = o.showViewModel ? o.activeType : null;
    if (want !== vmType) {
      if (vmObj) vmHolder.remove(vmObj);
      vmObj = null;
      vmLed = null;
      vmType = want;
      if (want) {
        vmObj = buildItemModel(want, { vm: true });
        vmObj.traverse((c) => { c.castShadow = false; });
        vmLed = vmObj.getObjectByName('led') ?? null;
        if (fpLayer !== null) applyLayer(vmObj);
        vmHolder.add(vmObj);
        vmPose = VM_POSE[want] ?? VM_DEFAULT;
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

  let lastVer = Number.NaN;
  let lastLayout: unknown = undefined;
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

  return {
    update(st, o) {
      cam = o.camera;
      o.camera.updateMatrixWorld();
      tickWarm(o.camera);
      const relayout = o.layoutRef !== lastLayout;
      const changed = relayout || o.version !== lastVer;
      if (changed) {
        lastVer = o.version;
        lastLayout = o.layoutRef;
        syncItems(st, o.spaceAt, relayout);
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
        }
      }
      tickFlares(o.camera, o.serverNow);
      if (armedLeds.size) {
        ledOn = Math.floor(performance.now() / 450) % 3 === 0;
        armedLeds.forEach(blink);
      }
      tickRings(o.serverNow);
      syncThrown(o.thrown);
      syncViewModel(o);
      if (o.targetPos) {
        glint.visible = true;
        glint.position.set(o.targetPos[0], Math.max(0.015, o.targetPos[1] - 0.08), o.targetPos[2]);
        const k = 1 + Math.sin(performance.now() / 160) * 0.08;
        glint.scale.setScalar(k);
      } else glint.visible = false;
    },
    held(list) {
      if (list.length === 0 && heldObjs.size === 0) return;
      const gn = ++heldGen;
      for (let i = 0; i < list.length; i++) {
        const h = list[i]!;
        let e = heldObjs.get(h.pid);
        if (e && e.type !== h.type) { root.remove(e.obj); e = undefined; }
        if (!e) {
          e = { type: h.type, obj: tagDetail(buildItemModel(h.type)), gen: gn };
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
      let draws = 0, casters = 0, shown = 0, maxMeshesPerItem = 0;
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
        let n = 0;
        e.obj.traverseVisible((c) => { if ((c as THREE.Mesh).isMesh) n++; });
        maxMeshesPerItem = Math.max(maxMeshesPerItem, n);
      }
      return { items: items.size, shown, draws, casters, warm: warmOn, warmFrames, maxMeshesPerItem, thrown: thrown.size, held: heldObjs.size };
    },
    dispose() {
      scene.remove(root);
    },
  };
}

export function itemColor(type: string): string {
  return itemDef(type).color;
}
