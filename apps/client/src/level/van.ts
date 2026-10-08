// Owner: env-world (v1.2). The crew van, replacing exterior.ts buildVan: a battered 1980s box truck,
// 'DEAD AIR SALVAGE · UNIT 9'. Exterior (group 'van', in the lot's space group): extruded + bevelled cab with a wheel
// arch, extruded box sides with arches, rounded roof / Luton peak / corner posts, lathed tyres + steel rims, a
// clear-coated paint with procedural mud and arch rust, smeared glass, emissive lenses + an amber beacon, roof rack,
// ladder, mirrors, a CanvasTexture plate + livery atlas, the rear barn doors swung flat. Interior (group
// 'van-interior', in the van's space group): checker-plate floor + tie-down rails, ply / painted liners, wheel humps,
// light housings, LED strip + red night light, and the stations at stationsOf's positions with their NAMED parts
// (own materials): workbench 'lamp', stash 'door', shelf 'books', charger 'cradle', mirror 'glass'. Upgrade parts are
// pre-merged per van material and hidden; setVanUpgrades only toggles visible.
// Van-local frame: origin at the centre of the rear opening on the ground, +X = world +X, +Z = toward the nose.
// The cargo collision walls are the cab rect's cell edges (x = +-c.w/2); interior faces sit at +-(c.w/2 - HALF_T) like
// every other wall, so env-layout's wall-backed station props (back on the HALF_T line) sit flush.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { attribute, float, length, min, mix, mx_noise_float, positionLocal, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import { VAN_CAB_L, stationsOf } from '@dead-air/shared/procgen/van.ts';
import type { Station, StationKind } from '@dead-air/shared/procgen/van.ts';
import type { LevelMaterials } from './materials.ts';
import { setMaterial } from './setpieces.ts';
import { stencilTexture } from './stencils.ts';

type G = THREE.BufferGeometry;
type V3 = [number, number, number];
const BX = (w: number, h: number, d: number, x = 0, y = 0, z = 0): G => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const RB = (w: number, h: number, d: number, x = 0, y = 0, z = 0, r = 0.03, seg = 2): G =>
  new RoundedBoxGeometry(w, h, d, seg, Math.max(0.002, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001))).translate(x, y, z);
const CY = (r: number, h: number, x = 0, y = 0, z = 0, seg = 12, r2 = r): G => new THREE.CylinderGeometry(r, r2, h, seg).translate(x, y, z);
const CX = (r: number, len: number, x = 0, y = 0, z = 0, seg = 12): G => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2).translate(x, y, z);
const CZ = (r: number, len: number, x = 0, y = 0, z = 0, seg = 12): G => new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2).translate(x, y, z);

/** paint colours (vertex colours of the one paint mesh) */
const CREAM: V3 = [0.62, 0.59, 0.5];
const GREEN: V3 = [0.09, 0.17, 0.12];
const OLIVE: V3 = [0.16, 0.18, 0.1];
const RED: V3 = [0.42, 0.05, 0.03];
/** emissive lens colours (HDR, vertex colours of the lens / LED mesh) */
const L_HEAD: V3 = [2.6, 2.3, 1.7], L_TAIL: V3 = [2.4, 0.12, 0.06], L_AMBER: V3 = [2.6, 1.1, 0.15], L_WHITE: V3 = [1.6, 1.6, 1.5];
const L_LED: V3 = [1.7, 1.9, 2.1], L_NIGHT: V3 = [2.2, 0.08, 0.04], L_GREEN: V3 = [0.2, 2.2, 0.5], L_TIP: V3 = [3.0, 0.9, 0.1];

/** box + cab body half width; the rear doors fold flat outside it to 1.1 (body + doors <= 2.2 m) */
export const VAN_BODY_HALF_W = 1.065;
const DOOR_T = 0.032;
/** rear axle distance from the rear opening (m): behind the rear doors folded flat, in front of the workbench humps */
export const REAR_AXLE_Z = 1.45;
const WHEEL_R = 0.38, ARCH_R = 0.47, ARCH_Y = 0.4;
const BOX_TOP = 2.6, ROOF_IN = 2.34, SILL = 0.24;

/** geometry collector per material key (non-indexed, position / normal / uv [+ color]) */
class Coll {
  readonly m = new Map<string, G[]>();
  /** non-merged objects (station holders with named parts) */
  readonly extraObjects: THREE.Object3D[] = [];
  add(key: string, g: G, rgb?: V3): void {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') n.deleteAttribute(name);
    n.clearGroups();
    const count = n.getAttribute('position').count;
    if (!n.getAttribute('normal')) n.computeVertexNormals();
    if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    if (rgb) {
      const c = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) c.set(rgb, i * 3);
      n.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    let list = this.m.get(key);
    if (!list) { list = []; this.m.set(key, list); }
    list.push(n);
  }
  addAll(key: string, gs: G[], rgb?: V3): void { for (const g of gs) this.add(key, g, rgb); }
}

// ---------------------------------------------------------------- materials (created once, kept across layouts)

let paintMat: THREE.MeshPhysicalNodeMaterial | null = null;
/** clear-coated paint: vertex colour base, procedural mud low on the body and a ragged rust band round each arch */
function paintMaterial(): THREE.MeshPhysicalNodeMaterial {
  if (paintMat) return paintMat;
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.4, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.3 });
  m.name = 'level.van.paint';
  const p = positionLocal;
  const base = attribute('color', 'vec3');
  const big = mx_noise_float(p.mul(1.7)).mul(0.5).add(0.5);
  const fine = mx_noise_float(p.mul(11.0)).mul(0.5).add(0.5);
  // mud: splashed up from the road, heavier toward the back and on the lower panels
  const mud = smoothstep(1.05, 0.22, p.y).mul(big.mul(0.7).add(0.45)).mul(smoothstep(0.25, 0.6, fine).mul(0.35).add(0.75)).clamp(0, 1);
  const dr = length(vec2(p.z.sub(REAR_AXLE_Z), p.y.sub(ARCH_Y)));
  const df = length(vec2(p.z.sub(uniformFrontAxle), p.y.sub(ARCH_Y)));
  const d = min(dr, df);
  const rust = smoothstep(ARCH_R + 0.2, ARCH_R + 0.02, d).mul(smoothstep(ARCH_R - 0.04, ARCH_R + 0.01, d)).mul(big.mul(0.9).add(fine.mul(0.5))).clamp(0, 1);
  const mudC = vec3(0.17, 0.13, 0.085), rustC = vec3(0.3, 0.13, 0.05);
  m.colorNode = mix(mix(base, mudC, mud.mul(0.8)), rustC, rust.mul(0.85));
  m.roughnessNode = mix(mix(float(0.36), float(0.93), mud), float(0.82), rust);
  m.clearcoatNode = float(0.4).mul(float(1).sub(mud)).mul(float(1).sub(rust));
  paintMat = m;
  return m;
}
/** z of the front axle (van-local): a uniform so every layout shares one paint pipeline */
const uniformFrontAxle = uniform(5.22);

let lensMat: THREE.MeshBasicNodeMaterial | null = null;
/** unlit HDR emissive with per-vertex colour: every lens and LED of the van in one draw */
function lensMaterial(): THREE.MeshBasicNodeMaterial {
  if (lensMat) return lensMat;
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = attribute('color', 'vec3');
  m.fog = false;
  m.name = 'level.van.lens';
  lensMat = m;
  return m;
}
let glassMat: THREE.MeshStandardNodeMaterial | null = null;
function glassMaterial(): THREE.MeshStandardNodeMaterial {
  if (glassMat) return glassMat;
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x141b1e, metalness: 0.6, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false });
  const p = positionLocal;
  // smeared: road film and wiper fans of cleaner glass, never mirror-sharp
  const smear = mx_noise_float(p.mul(vec3(2.5, 7.0, 2.5))).mul(0.5).add(0.5);
  const film = smoothstep(1.55, 1.2, p.y).mul(0.4);
  m.roughnessNode = mix(float(0.06), float(0.5), smear.mul(0.55).add(film)).clamp(0.04, 0.7);
  m.name = 'level.van.glass';
  glassMat = m;
  return m;
}
let tyreMat: THREE.MeshStandardNodeMaterial | null = null;
function tyreMaterial(): THREE.MeshStandardNodeMaterial {
  tyreMat ??= Object.assign(new THREE.MeshStandardNodeMaterial({ color: 0x151515, roughness: 0.93, metalness: 0 }), { name: 'level.van.tyre' });
  return tyreMat;
}

let atlas: { tex: THREE.CanvasTexture; mat: THREE.MeshStandardNodeMaterial } | null = null;
/** livery atlas (1024 x 1024 canvas): side livery, 'UNIT 9' spray stencil (stencilTexture, read only), number plates,
 *  rear chevrons. null without a DOM (unit tests). */
function liveryAtlas(): { tex: THREE.CanvasTexture; mat: THREE.MeshStandardNodeMaterial } | null {
  if (atlas) return atlas;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 1024, 1024);
  // side livery (0..1024 x 0..320): logo disc + DEAD AIR + SALVAGE & RECOVERY + a slogan
  const ink = '#1d3326', cream = '#e9e2cc';
  g.fillStyle = ink;
  g.beginPath(); g.arc(150, 160, 120, 0, Math.PI * 2); g.fill();
  g.strokeStyle = cream; g.lineWidth = 10;
  g.beginPath(); g.moveTo(150, 250); g.lineTo(150, 95); g.stroke();
  g.beginPath(); g.moveTo(112, 250); g.lineTo(150, 140); g.lineTo(188, 250); g.stroke();
  for (const r of [42, 72]) { g.beginPath(); g.arc(150, 100, r, -Math.PI * 0.8, -Math.PI * 0.55); g.stroke(); g.beginPath(); g.arc(150, 100, r, -Math.PI * 0.45, -Math.PI * 0.2); g.stroke(); }
  g.fillStyle = '#b3261e'; g.beginPath(); g.arc(150, 95, 14, 0, Math.PI * 2); g.fill();
  g.font = "900 150px 'Arial Black', Impact, 'Segoe UI Black', sans-serif";
  g.textBaseline = 'alphabetic';
  g.lineWidth = 14; g.strokeStyle = cream; g.strokeText('DEAD AIR', 300, 168, 700);
  g.fillStyle = ink; g.fillText('DEAD AIR', 300, 168, 700);
  g.font = "800 58px 'Arial Black', Impact, sans-serif";
  g.fillStyle = '#b3261e'; g.fillText('SALVAGE & RECOVERY', 304, 236, 690);
  g.font = "700 30px 'Segoe UI', Arial, sans-serif";
  g.fillStyle = ink; g.fillText('NIGHT CALLS  ·  NO QUESTIONS  ·  UNIT 9', 306, 284, 690);
  // weathering: chips + a peeled corner
  g.globalCompositeOperation = 'destination-out';
  let h = 9;
  const rnd = () => ((h = (h * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let k = 0; k < 900; k++) { g.globalAlpha = 0.3 + rnd() * 0.7; const s = 1 + rnd() * 4; g.fillRect(rnd() * 1024, rnd() * 320, s, s * (0.4 + rnd())); }
  g.globalAlpha = 1;
  g.beginPath(); g.moveTo(1024, 250); g.lineTo(960, 320); g.lineTo(1024, 320); g.fill();
  g.globalCompositeOperation = 'source-over';
  // 'UNIT 9' spray stencil (320..576, left half): read from stencils.ts, cropped to its letters
  const st = stencilTexture('UNIT 9', '#e6dfc8');
  g.drawImage(st.tex.image as HTMLCanvasElement, 0, 40, 1024, 190, 0, 330, 512, 95);
  const st2 = stencilTexture('KEEP CLEAR', '#d9a514');
  g.drawImage(st2.tex.image as HTMLCanvasElement, 0, 40, 1024, 190, 0, 450, 512, 95);
  // number plates (512..1024 x 320..448 rear, 448..576 front): Dutch yellow, black characters
  for (const [y, text] of [[320, 'DA-79-UN'], [448, 'DA-79-UN']] as const) {
    g.fillStyle = '#e8c23a'; g.fillRect(522, y + 14, 492, 104);
    g.strokeStyle = '#111'; g.lineWidth = 6; g.strokeRect(526, y + 18, 484, 96);
    g.fillStyle = '#121212'; g.font = "700 74px 'Arial Narrow', 'Segoe UI', Arial, sans-serif";
    g.textAlign = 'center'; g.fillText(text, 768, y + 94, 460); g.textAlign = 'left';
    g.fillStyle = 'rgba(70,50,20,0.35)';
    for (let k = 0; k < 60; k++) g.fillRect(522 + rnd() * 492, y + 14 + rnd() * 104, 2 + rnd() * 6, 2 + rnd() * 4);
  }
  // rear chevrons (576..704): red / white reflective stripes
  for (let x = -128; x < 1024 + 128; x += 64) {
    g.fillStyle = (x / 64) % 2 === 0 ? '#c41c14' : '#efece0';
    g.beginPath(); g.moveTo(x, 704); g.lineTo(x + 64, 704); g.lineTo(x + 128, 576); g.lineTo(x + 64, 576); g.closePath(); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.5, metalness: 0, alphaTest: 0.35 });
  mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -4;
  mat.name = 'level.van.livery';
  atlas = { tex, mat };
  return atlas;
}
/** atlas regions (u0, v0, u1, v1) in canvas pixels (y down) */
const ATLAS = {
  livery: [0, 0, 1024, 320], unit: [0, 330, 512, 425], keep: [0, 450, 512, 545],
  plateRear: [522, 334, 1014, 438], plateFront: [522, 462, 1014, 566], chevron: [0, 576, 1024, 704],
} as const;
/** a decal quad in the plane facing `n` ('+x' | '-x' | '+z' | '-z'), centred at c, size w x h, atlas region r */
function decal(c: V3, w: number, h: number, n: '+x' | '-x' | '+z' | '-z', r: readonly [number, number, number, number]): G {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const [u0, v0, u1, v1] = [r[0] / 1024, 1 - r[3] / 1024, r[2] / 1024, 1 - r[1] / 1024];
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  if (n === '+x') g.rotateY(Math.PI / 2); else if (n === '-x') g.rotateY(-Math.PI / 2); else if (n === '-z') g.rotateY(Math.PI);
  return g.translate(c[0], c[1], c[2]);
}

/** named-part material: a plain standard material (shares the plain-material pipeline; own instance so a consumer can
 *  restyle it: emissiveIntensity for the lamp / cradle / screens) */
const namedMats = new Map<string, THREE.MeshStandardNodeMaterial>();
export function namedMaterial(name: string, color: number, o: { emissive?: number; ei?: number; rough?: number; metal?: number; vertexColors?: boolean } = {}): THREE.MeshStandardNodeMaterial {
  let m = namedMats.get(name);
  if (!m) {
    m = new THREE.MeshStandardNodeMaterial({ color, roughness: o.rough ?? 0.55, metalness: o.metal ?? 0.1, emissive: o.emissive ?? 0x000000, emissiveIntensity: o.ei ?? 0, vertexColors: o.vertexColors ?? false });
    m.name = `level.van.${name}`;
    namedMats.set(name, m);
  }
  // a rebuild starts from the resting look (a consumer may have lit the lamp / opened the door)
  m.emissiveIntensity = o.ei ?? 0;
  return m;
}

// ---------------------------------------------------------------- shapes

/** extruded side panel in the (z, y) plane with an arch cut over a wheel, extruded along x from x0 by `depth` */
function archedPanel(z0: number, z1: number, y0: number, y1: number, archZ: number, x0: number, depth: number, bevel: number): G {
  const s = new THREE.Shape();
  s.moveTo(z0, y0);
  s.lineTo(archZ - ARCH_R, y0);
  s.lineTo(archZ - ARCH_R, ARCH_Y);
  s.absarc(archZ, ARCH_Y, ARCH_R, Math.PI, 0, true);
  s.lineTo(archZ + ARCH_R, y0);
  s.lineTo(z1, y0);
  s.lineTo(z1, y1);
  s.lineTo(z0, y1);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 18 });
  // shape (u = z, v = y), extrusion w -> x = -w: rotateY(-pi/2) maps (u, v, w) to (-w, v, u)
  g.rotateY(-Math.PI / 2);
  return g.translate(x0 + depth + bevel, 0, 0);
}

/** driver cab: side profile (z, y) from the bulkhead to the grille with the front wheel arch, extruded across x */
function cabShell(zc0: number, zf: number, zAxle: number, halfW: number, bevel: number): G {
  const s = new THREE.Shape();
  const yb = 0.44;
  s.moveTo(zc0, yb);
  s.lineTo(zAxle - ARCH_R, yb);
  s.absarc(zAxle, ARCH_Y + 0.02, ARCH_R, Math.PI, 0, true);
  s.lineTo(zf - 0.06, yb);
  s.lineTo(zf, yb + 0.08);
  s.lineTo(zf, 1.06);
  s.lineTo(zf - 0.3, 1.18);
  s.lineTo(zf - 0.62, 1.24);
  s.lineTo(zc0 + 0.95, 2.04);
  s.lineTo(zc0 + 0.82, 2.14);
  s.lineTo(zc0, 2.14);
  s.closePath();
  const depth = 2 * halfW - 2 * bevel;
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 3, curveSegments: 18 });
  g.rotateY(-Math.PI / 2);
  return g.translate(halfW - bevel, 0, 0);
}

/** tyre (lathe of a rounded section) around +x at (x, y, z) */
function tyre(x: number, y: number, z: number): G {
  const pts: THREE.Vector2[] = [];
  const ri = 0.235, ro = WHEEL_R, hw = 0.11;
  const sec: [number, number][] = [[ri, -hw * 0.95], [ri + 0.06, -hw], [ro - 0.05, -hw], [ro - 0.012, -hw * 0.82], [ro, -hw * 0.45], [ro, hw * 0.45], [ro - 0.012, hw * 0.82], [ro - 0.05, hw], [ri + 0.06, hw], [ri, hw * 0.95]];
  for (const [r, a] of sec) pts.push(new THREE.Vector2(r, a));
  return new THREE.LatheGeometry(pts, 28).rotateZ(Math.PI / 2).translate(x, y, z);
}
/** steel rim + hub (lathe, dish facing outward = sign of x) */
function rim(x: number, y: number, z: number): G[] {
  const s = Math.sign(x) || 1;
  const pts = [[0.0, 0.07], [0.06, 0.07], [0.075, 0.05], [0.13, 0.035], [0.2, 0.055], [0.232, 0.09], [0.236, 0.1], [0.236, -0.1], [0.215, -0.09]].map(([r, a]) => new THREE.Vector2(r, a));
  const g = new THREE.LatheGeometry(pts, 24).rotateZ(-Math.PI / 2 * s).translate(x, y, z);
  const out: G[] = [g];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    out.push(CX(0.012, 0.03, x + s * 0.075, y + Math.cos(a) * 0.1, z + Math.sin(a) * 0.1, 6));
  }
  return out;
}

// ---------------------------------------------------------------- build

export interface VanMirror { glass: THREE.Mesh; itemId: string; space: number; w: number; h: number }
export interface VanBuild {
  /** exterior: parented to the lot's space group */
  exterior: THREE.Group;
  /** interior + stations: parented to the van's space group */
  interior: THREE.Group;
  /** station objects built here (props with data.station): workbench, stash, booklet, charger, mirror */
  stations: Map<StationKind, THREE.Object3D>;
  /** van upgrade id -> its pre-merged hidden meshes */
  upgrades: Map<string, THREE.Object3D[]>;
  /** mirror glasses to register with render.mirrors (kind 'van') */
  mirrors: VanMirror[];
  /** per-layout geometries (free on rebuild; materials are shared and kept) */
  geometries: G[];
  /** item ids built here (the level skips them in its item loop) */
  itemIds: Set<string>;
  /** station-local bounds of each station's furniture + named parts (upgrades excluded): tests check the collision box */
  stationBounds: Map<StationKind, THREE.Box3>;
}

/** world -> van-local */
function toLocal(L: LevelLayout, x: number, z: number): [number, number] {
  const c = L.van.cab;
  return [x - (c.x + c.w / 2), z - c.y];
}

export function buildVan(L: LevelLayout, lm: LevelMaterials, opts: { vanSpace: number | null } = { vanSpace: null }): VanBuild {
  const c = L.van.cab;
  const CL = c.h, HW = c.w / 2;
  const IN = HW - HALF_T; // interior wall face (station backs sit on it)
  const OW = VAN_BODY_HALF_W;
  const zF = CL + VAN_CAB_L - 0.78; // front axle under the cab
  uniformFrontAxle.value = zF;
  const zc0 = CL + 0.07, zf = CL + VAN_CAB_L; // cab back / grille face
  const ext = new Coll(), inn = new Coll();
  const up = new Map<string, Coll>();
  const upg = (id: string) => { let u = up.get(id); if (!u) { u = new Coll(); up.set(id, u); } return u; };
  const geometries: G[] = [];

  // ---------------- exterior: box body
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -OW + 0.0 : HW;
    ext.add('paint', archedPanel(-0.04, CL + 0.06, SILL, BOX_TOP - 0.08, REAR_AXLE_Z, x0, OW - HW - 0.02, 0.01), CREAM);
    // a dark green waist stripe + a lower rub rail (split round the arch)
    ext.add('paint', BX(0.006, 0.2, CL - 0.12, s * (OW + 0.001), 1.04, CL / 2), GREEN);
    for (const [z0, z1] of [[0.12, REAR_AXLE_Z - ARCH_R - 0.06], [REAR_AXLE_Z + ARCH_R + 0.06, CL - 0.05]]) if (z1 > z0) ext.add('trim', BX(0.03, 0.08, z1 - z0, s * (OW - 0.012), 0.31, (z0 + z1) / 2));
    // aluminium corner posts (rear), top rails, a front corner cap
    ext.add('chrome', RB(0.11, BOX_TOP - SILL, 0.1, s * (OW - 0.055), (BOX_TOP + SILL) / 2, -0.012, 0.025));
    ext.add('chrome', RB(0.07, 0.07, CL + 0.14, s * (OW - 0.035), BOX_TOP - 0.035, CL / 2 + 0.01, 0.02));
    ext.add('chrome', RB(0.07, BOX_TOP - SILL, 0.07, s * (OW - 0.035), (BOX_TOP + SILL) / 2, CL + 0.04, 0.02));
    // arch flares: half rings round the rear arch and the cab arch
    ext.add('trim', new THREE.TorusGeometry(ARCH_R + 0.02, 0.028, 6, 22, Math.PI).rotateY(Math.PI / 2).translate(s * (OW - 0.005), ARCH_Y, REAR_AXLE_Z));
    ext.add('trim', new THREE.TorusGeometry(ARCH_R + 0.02, 0.03, 6, 22, Math.PI).rotateY(Math.PI / 2).translate(s * (OW - 0.02), ARCH_Y + 0.02, zF));
  }
  ext.add('paint', RB(2 * OW - 0.04, 0.1, CL + 0.12, 0, BOX_TOP - 0.05, CL / 2 + 0.01, 0.04), CREAM);
  ext.add('paint', RB(2 * OW - 0.04, BOX_TOP - SILL - 0.06, 0.08, 0, (BOX_TOP + SILL) / 2 - 0.03, CL + 0.03, 0.03), CREAM);
  // Luton peak over the cab roof
  ext.add('paint', RB(2 * OW - 0.04, 0.42, 0.66, 0, BOX_TOP - 0.21, CL + 0.07 + 0.33, 0.07), CREAM);
  // rear header over the opening + the sill tread plate
  ext.add('paint', BX(2 * OW - 0.12, BOX_TOP - ROOF_IN - 0.02, 0.08, 0, (BOX_TOP + ROOF_IN) / 2 - 0.01, 0), CREAM);
  ext.add('chrome', BX(2 * HW - 0.1, 0.02, 0.16, 0, 0.01, -0.04));
  // chassis under the box + the cab
  ext.add('trim', BX(1.5, 0.16, VAN_CAB_L - 0.2, 0, 0.3, CL + VAN_CAB_L / 2));
  // rear corner bumpers (the middle stays open: the crew walks in at floor level) with chevrons
  for (const s of [-1, 1]) ext.add('trim', RB(0.3, 0.16, 0.14, s * (OW - 0.17), 0.33, -0.11, 0.03));

  // ---------------- exterior: cab (the bevel puts the shell's outer faces CAB_BEVEL outside its profile)
  const CAB_HW = OW - 0.03, CAB_BEVEL = 0.03, CAB_BS = CAB_BEVEL * 0.8;
  const zfo = zf + CAB_BS; // outer grille face
  ext.add('paint', cabShell(zc0, zf, zF, CAB_HW, CAB_BEVEL), GREEN);
  ext.add('trim', RB(2 * OW - 0.06, 0.2, 0.17 - CAB_BS, 0, 0.47, zfo + (0.17 - CAB_BS) / 2, 0.04)); // front bumper (overhang 0.17)
  ext.add('trim', BX(1.02, 0.34, 0.02, 0, 0.83, zfo + 0.01)); // grille
  for (const y of [0.72, 0.82, 0.92]) ext.add('chrome', BX(1.0, 0.018, 0.014, 0, y, zfo + 0.027));
  for (const s of [-1, 1]) {
    ext.add('chrome', new THREE.TorusGeometry(0.112, 0.018, 6, 22).translate(s * 0.7, 0.8, zfo + 0.016));
    // door seam + handle on the cab sides, a step under the door
    ext.add('trim', BX(0.004, 1.5, 0.012, s * (CAB_HW + 0.002), 1.3, zc0 + 1.08));
    ext.add('chrome', BX(0.02, 0.025, 0.12, s * (CAB_HW + 0.01), 1.22, zc0 + 0.9));
    ext.add('trim', BX(0.14, 0.03, 0.42, s * (CAB_HW - 0.06), 0.42, zc0 + 0.55));
    // mirrors on arms off the A-pillar
    ext.add('trim', BX(0.12, 0.025, 0.025, s * (CAB_HW + 0.06), 1.62, zf - 0.68));
    ext.add('trim', RB(0.045, 0.27, 0.15, s * (CAB_HW + 0.115), 1.76, zf - 0.7, 0.02, 1));
    ext.add('chrome', BX(0.032, 0.24, 0.004, s * (CAB_HW + 0.115), 1.76, zf - 0.778));
  }
  // wheels
  for (const z of [REAR_AXLE_Z, zF]) for (const s of [-1, 1]) {
    const x = s * (OW - 0.12);
    ext.add('tyre', tyre(x, WHEEL_R, z));
    ext.addAll('chrome', rim(x, WHEEL_R, z));
  }
  // glass: windscreen on the slope (nudged out along its normal past the bevel) + the side windows
  {
    const zAt = (y: number) => (zf - 0.62) - ((y - 1.24) * ((zf - 0.62) - (zc0 + 0.95))) / (2.04 - 1.24);
    const b = new THREE.Vector3(0, 1.28, zAt(1.28)), t = new THREE.Vector3(0, 2.0, zAt(2.0));
    const dir = t.clone().sub(b);
    const nrm = new THREE.Vector3(0, -dir.z, dir.y).normalize().multiplyScalar(CAB_BS + 0.006); // forward-up
    const ws = new THREE.PlaneGeometry(2 * CAB_HW - 0.16, dir.length());
    ws.rotateX(Math.atan2(dir.z, dir.y));
    ws.translate(0, (b.y + t.y) / 2 + nrm.y, (b.z + t.z) / 2 + nrm.z);
    ext.add('glass', ws);
    const win = new THREE.Shape();
    win.moveTo(zc0 + 0.14, 1.3); win.lineTo(zAt(1.3) - 0.04, 1.3); win.lineTo(zAt(1.97) - 0.04, 1.97); win.lineTo(zc0 + 0.14, 1.97); win.closePath();
    for (const s of [-1, 1]) ext.add('glass', new THREE.ShapeGeometry(win).rotateY(-Math.PI / 2).translate(s * (CAB_HW + 0.003), 0, 0));
  }
  // lenses: headlights, indicators, tail / reverse clusters, roof markers, the rear work flood, the amber beacon
  for (const s of [-1, 1]) {
    ext.add('lens', new THREE.CircleGeometry(0.1, 20).translate(s * 0.7, 0.8, zfo + 0.024), L_HEAD);
    ext.add('lens', RB(0.12, 0.07, 0.02, s * 0.93, 0.8, zfo + 0.01, 0.01, 1), L_AMBER);
    ext.add('lens', RB(0.075, 0.3, 0.02, s * (OW - 0.055), 1.12, -0.07, 0.01, 1), L_TAIL);
    ext.add('lens', RB(0.075, 0.1, 0.02, s * (OW - 0.055), 0.88, -0.07, 0.01, 1), L_AMBER);
    ext.add('lens', RB(0.075, 0.08, 0.02, s * (OW - 0.055), 0.76, -0.07, 0.01, 1), L_WHITE);
    for (let k = 0; k < 4; k++) ext.add('lens', RB(0.02, 0.04, 0.08, s * (OW + 0.004), BOX_TOP - 0.11, 0.3 + k * ((CL - 0.6) / 3), 0.008, 1), L_AMBER);
  }
  for (const x of [-0.5, 0, 0.5]) ext.add('lens', RB(0.09, 0.045, 0.02, x, BOX_TOP - 0.07, CL + 0.735, 0.01, 1), L_AMBER);
  // rear work flood: a housing around render's emitter at the layout's flood fixture (its lens shows through the front)
  {
    const fl = L.items.find((i) => i.kind === 'light' && i.data?.kind === 'flood');
    const [fx, fz] = fl ? toLocal(L, fl.x, fl.z) : [0, -0.06];
    const fy = fl?.y ?? 2.3;
    // render's flood emitter is a 0.375 x 0.15 x 0.224 box centred on the fixture: shroud it, open to the rear only
    ext.add('trim', RB(0.44, 0.03, 0.25, fx, fy + 0.092, fz + 0.005, 0.01, 1));
    for (const sx of [-1, 1]) ext.add('trim', RB(0.03, 0.19, 0.25, fx + sx * 0.205, fy, fz + 0.005, 0.01, 1));
    ext.add('trim', BX(0.44, 0.19, 0.02, fx, fy, fz + 0.125));
    ext.add('chrome', BX(0.05, 0.06, 0.1, fx, fy + 0.135, fz + 0.06));
  }
  ext.add('trim', CY(0.1, 0.06, 0.72, BOX_TOP + 0.03, CL - 0.3, 14));
  ext.add('lens', new THREE.SphereGeometry(0.085, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.3, 1).translate(0.72, BOX_TOP + 0.06, CL - 0.3), L_AMBER);
  // roof rack + cargo (tarp roll, spare wheel)
  for (const s of [-1, 1]) {
    ext.add('chrome', CZ(0.018, CL - 0.4, s * 0.86, BOX_TOP + 0.11, CL / 2, 8));
    for (let k = 0; k < 4; k++) ext.add('chrome', BX(0.03, 0.11, 0.03, s * 0.86, BOX_TOP + 0.055, 0.3 + k * ((CL - 0.6) / 3)));
  }
  for (let z = 0.4; z < CL - 0.2; z += 0.8) ext.add('chrome', CX(0.015, 1.72, 0, BOX_TOP + 0.11, z, 6));
  ext.add('paint', CX(0.13, 1.4, 0, BOX_TOP + 0.26, 0.9, 14), OLIVE);
  ext.add('tyre', tyre(0, 0, 0).rotateZ(Math.PI / 2).translate(0.3, BOX_TOP + 0.24, Math.min(CL - 0.7, 2.6)));
  // ladder up the rear right corner
  for (const lx of [0.88, 1.05]) ext.add('chrome', CY(0.016, BOX_TOP + 0.05 - 0.45, lx, (BOX_TOP + 0.05 + 0.45) / 2, -0.085, 8));
  for (let y = 0.6; y < BOX_TOP; y += 0.3) ext.add('chrome', CX(0.012, 0.17, 0.965, y, -0.085, 6));
  // rear barn doors swung flat against the box sides (outer face outward), locking rods + hinges
  for (const s of [-1, 1]) {
    ext.add('paint', RB(DOOR_T, BOX_TOP - 0.42, 0.97, s * (OW + DOOR_T / 2 + 0.001), (BOX_TOP + 0.42) / 2 - 0.02, 0.45, 0.01), CREAM);
    for (const z of [0.17, 0.74]) ext.add('chrome', CY(0.009, BOX_TOP - 0.55, s * (OW + DOOR_T + 0.003), (BOX_TOP + 0.42) / 2, z, 6));
    for (const y of [0.7, 1.4, 2.1]) ext.add('chrome', BX(0.03, 0.08, 0.05, s * (OW + 0.015), y, -0.03));
  }
  // livery atlas decals
  const at = liveryAtlas();
  if (at) {
    const lw = Math.min(3.1, CL - 0.6), lh = lw * (320 / 1024);
    ext.add('decal', decal([OW + 0.0015, 1.72, CL / 2 + 0.15], lw, lh, '+x', ATLAS.livery));
    const left = decal([0, 0, 0], lw, lh, '-x', ATLAS.livery);
    ext.add('decal', left.translate(-OW - 0.0015, 1.72, CL / 2 + 0.15));
    for (const s of [-1, 1]) ext.add('decal', decal([s * (OW + DOOR_T + 0.0025), 1.55, 0.45], 0.8, 0.15, s > 0 ? '+x' : '-x', ATLAS.unit));
    ext.add('decal', decal([0, 2.45, CL + 0.405], 0.8, 0.15, '+z', ATLAS.keep));
    ext.add('decal', decal([0, 0.45, zf + 0.172], 0.42, 0.09, '+z', ATLAS.plateFront));
    ext.add('decal', decal([0, 0.42, -0.135], 0.42, 0.09, '-z', ATLAS.plateRear));
    for (const s of [-1, 1]) ext.add('decal', decal([s * (OW - 0.17), 0.33, -0.181], 0.3, 0.12, '-z', ATLAS.chevron));
  }

  // ---------------- interior (cargo)
  inn.add('floor', BX(2 * IN, 0.03, CL - 0.02, 0, 0.015, CL / 2));
  for (const s of [-1, 1]) {
    // wheel hump over the rear wheel (checker plate), ply + painted liners, battens, ribs
    inn.add('floor', RB(HW - IN + 0.02, WHEEL_R * 2 + 0.06, 1.0, s * (IN - (HW - IN + 0.02) / 2 + 0.01), (WHEEL_R * 2 + 0.06) / 2, REAR_AXLE_Z, 0.04));
    inn.add('ply', BX(0.012, 1.13, CL - 0.04, s * (IN + 0.006), 0.6, CL / 2));
    inn.add('wall', BX(0.012, ROOF_IN - 1.16, CL - 0.04, s * (IN + 0.006), (ROOF_IN + 1.16) / 2, CL / 2));
    inn.add('trim', BX(0.02, 0.05, CL - 0.04, s * (IN - 0.004), 1.16, CL / 2));
    for (const y of [0.42, 0.8]) inn.add('ply', BX(0.016, 0.07, CL - 0.3, s * (IN - 0.008), y, CL / 2));
    for (const z of [0.35, 1.38, CL - 0.42]) if (z < CL - 0.2) inn.add('dark', BX(0.025, ROOF_IN - 1.2, 0.05, s * (IN - 0.012), (ROOF_IN + 1.2) / 2, z));
    // tie-down rails on the floor (outside the deposit hatch) with flat rings
    const r0 = 0.25, r1 = CL - 0.75;
    inn.add('steel', BX(0.06, 0.012, r1 - r0, s * 0.8, 0.036, (r0 + r1) / 2));
    for (let z = r0 + 0.2; z < r1; z += 0.5) inn.add('steel', new THREE.TorusGeometry(0.03, 0.007, 4, 12).rotateX(Math.PI / 2).translate(s * 0.8, 0.043, z));
  }
  inn.add('dark', BX(2 * IN, 0.012, CL - 0.02, 0, ROOF_IN + 0.006, CL / 2));
  for (const z of [0.62, 1.85, 2.45, 3.62]) if (z < CL - 0.2) inn.add('dark', BX(2 * IN - 0.02, 0.035, 0.05, 0, ROOF_IN - 0.018, z));
  inn.add('wall', BX(2 * IN, ROOF_IN - 0.03, 0.012, 0, (ROOF_IN - 0.03) / 2 + 0.03, CL - 0.016));
  inn.add('dark', BX(2 * IN, 0.15, 0.06, 0, ROOF_IN - 0.075, 0.03));
  // red night light over the rear opening + the LED strip / van light housings at the layout's van fixtures
  inn.add('trim', BX(0.14, 0.06, 0.02, 0, ROOF_IN - 0.2, 0.068));
  inn.add('led', BX(0.1, 0.035, 0.008, 0, ROOF_IN - 0.2, 0.08), L_NIGHT);
  let strip = false;
  for (const it of L.items) {
    if (it.kind !== 'light' || (opts.vanSpace !== null && it.space !== opts.vanSpace)) continue;
    const kind = String(it.data?.kind ?? '');
    const [lx, lz] = toLocal(L, it.x, it.z);
    if (lz < -0.1 || lz > CL + 0.1 || Math.abs(lx) > HW) continue;
    if (kind === 'van') {
      for (const s of [-1, 1]) { inn.add('dark', BX(0.68, 0.025, 0.03, lx, ROOF_IN - 0.016, lz + s * 0.13)); inn.add('dark', BX(0.03, 0.025, 0.26, lx + s * 0.33, ROOF_IN - 0.016, lz)); }
    } else if (kind === 'led_strip') {
      const len = Number(it.data?.len ?? 3);
      inn.add('steel', BX(0.03, 0.018, len + 0.02, lx, (it.y ?? 2.08) + 0.012, lz));
      inn.add('led', BX(0.016, 0.006, len, lx, (it.y ?? 2.08), lz), L_LED);
      strip = true;
    }
  }
  if (!strip) { // before gate L1 (no led_strip fixture): the strip over the right wall anyway
    inn.add('steel', BX(0.03, 0.018, CL - 0.98, IN - 0.04, 2.092, CL / 2));
    inn.add('led', BX(0.016, 0.006, CL - 1.0, IN - 0.04, 2.08, CL / 2), L_LED);
  }
  // fire extinguisher by the rear right corner
  inn.add('paint', CY(0.065, 0.42, IN - 0.1, 0.27, 0.22, 14), RED);
  inn.add('trim', CY(0.025, 0.07, IN - 0.1, 0.51, 0.22, 8));
  inn.add('steel', BX(0.03, 0.04, 0.16, IN - 0.03, 0.3, 0.22));

  // ---------------- stations (real props only: virtual stations are never drawn)
  const stations = new Map<StationKind, THREE.Object3D>();
  const itemIds = new Set<string>();
  const mirrors: VanMirror[] = [];
  const all = stationsOf(L);
  const station = (k: StationKind): Station | undefined => all.find((s) => s.kind === k && !s.virtual && L.items.some((it) => it.id === s.itemId && it.kind === 'prop'));
  /** station-local -> van-local matrix (origin on the floor under the station centre, +Z = the station's front) */
  const frameOf = (s: Station): THREE.Matrix4 => {
    const [lx, lz] = toLocal(L, s.x, s.z);
    return new THREE.Matrix4().makeRotationY(s.rot).setPosition(lx, 0, lz);
  };
  const stationBounds = new Map<StationKind, THREE.Box3>();
  let curBox: THREE.Box3 | null = null;
  const grow = (g: G) => { if (!curBox) return; g.computeBoundingBox(); if (g.boundingBox) curBox.union(g.boundingBox); };
  const place = (coll: Coll, key: string, m: THREE.Matrix4, g: G, rgb?: V3) => { if (coll === inn) grow(g); coll.add(key, g.applyMatrix4(m), rgb); };
  const begin = (k: StationKind) => { curBox = new THREE.Box3(); stationBounds.set(k, curBox); };
  const holder = (s: Station): THREE.Group => {
    const g = new THREE.Group();
    g.name = `station:${s.kind}`;
    g.userData.itemId = s.itemId;
    g.matrixAutoUpdate = false;
    g.matrix.copy(frameOf(s));
    g.matrixWorldNeedsUpdate = true;
    itemIds.add(s.itemId);
    return g;
  };
  const namedMesh = (name: string, geos: G[], mat: THREE.Material, cast = false, offset?: V3): THREE.Mesh => {
    for (const g of geos) grow(offset ? g.clone().translate(offset[0], offset[1], offset[2]) : g);
    const keepColor = geos.every((g) => !!g.getAttribute('color'));
    const flat = geos.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      if (n !== g) g.dispose();
      for (const a of Object.keys(n.attributes)) if (a !== 'position' && a !== 'normal' && a !== 'uv' && !(keepColor && a === 'color')) n.deleteAttribute(a);
      n.clearGroups();
      return n;
    });
    const merged = mergeFlat(flat);
    const m = new THREE.Mesh(merged, mat);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = true;
    geometries.push(merged);
    return m;
  };

  const wb = station('workbench');
  if (wb) {
    begin('workbench');
    const M = frameOf(wb);
    const h = holder(wb);
    const w = wb.w, d = wb.d, top = wb.h;
    place(inn, 'ply', M, RB(w, 0.045, d, 0, top - 0.0225, 0, 0.008));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) place(inn, 'steel', M, BX(0.035, top - 0.045, 0.035, sx * (w / 2 - 0.04), (top - 0.045) / 2, sz * (d / 2 - 0.03)));
    // drawer unit under the front half (the wheel hump sits under the rear half)
    const dx0 = w * 0.02, dx1 = w / 2 - 0.06;
    place(inn, 'wall', M, RB(dx1 - dx0, top - 0.33, d - 0.03, (dx0 + dx1) / 2, 0.29 + (top - 0.33) / 2 - 0.02, -0.01, 0.01));
    for (let k = 0; k < 3; k++) place(inn, 'steel', M, BX(0.12, 0.018, 0.02, (dx0 + dx1) / 2, 0.4 + k * 0.17, d / 2 - 0.015));
    // pegboard + tools, vise
    place(inn, 'ply', M, BX(w - 0.1, 0.6, 0.012, 0, top + 0.41, -d / 2 + 0.006));
    const tool = (x: number, y: number, len: number, wid: number, mat: string) => place(inn, mat, M, BX(wid, len, 0.012, x, y, -d / 2 + 0.02), mat === 'paint' ? RED : undefined);
    tool(-0.42, top + 0.42, 0.24, 0.03, 'steel'); tool(-0.34, top + 0.45, 0.2, 0.025, 'steel'); tool(-0.2, top + 0.4, 0.26, 0.022, 'paint');
    tool(-0.05, top + 0.47, 0.18, 0.02, 'paint'); tool(0.08, top + 0.43, 0.3, 0.035, 'steel'); tool(0.25, top + 0.45, 0.16, 0.06, 'steel');
    place(inn, 'trim', M, BX(0.2, 0.012, 0.012, 0.42, top + 0.55, -d / 2 + 0.02));
    for (let k = 0; k < 4; k++) place(inn, 'paint', M, CY(0.012, 0.11, 0.35 + k * 0.05, top + 0.48, -d / 2 + 0.03, 6), RED);
    place(inn, 'steel', M, BX(0.13, 0.08, 0.13, w / 2 - 0.12, top + 0.04, d / 2 - 0.08));
    place(inn, 'steel', M, BX(0.13, 0.06, 0.025, w / 2 - 0.12, top + 0.05, d / 2 + 0.005));
    place(inn, 'steel', M, CX(0.008, 0.2, w / 2 - 0.12, top + 0.02, d / 2 + 0.03, 6));
    // gooseneck lamp: steel arm + shade (merged), 'lamp' = bulb + shade mouth glow (own material)
    const lx = -w / 2 + 0.2;
    place(inn, 'steel', M, BX(0.06, 0.03, 0.08, lx, top + 0.015, -d / 2 + 0.06));
    place(inn, 'steel', M, CY(0.008, 0.42, lx, top + 0.24, -d / 2 + 0.06, 6));
    place(inn, 'steel', M, CZ(0.008, 0.2, lx, top + 0.45, -d / 2 + 0.16, 6));
    place(inn, 'steel', M, new THREE.ConeGeometry(0.065, 0.1, 14, 1, true).translate(lx, top + 0.41, -d / 2 + 0.26));
    const lampMat = namedMaterial('lamp', 0x2a2620, { emissive: 0xffc47a, ei: 0.08, rough: 0.3 });
    // the bulb hangs just below the shade's rim so it reads from most angles; the mouth disc lights the bench
    const lamp = namedMesh('lamp', [new THREE.SphereGeometry(0.03, 12, 8).scale(1, 1.25, 1).translate(lx, top + 0.355, -d / 2 + 0.26), new THREE.CircleGeometry(0.062, 16).rotateX(Math.PI / 2).translate(lx, top + 0.362, -d / 2 + 0.26)], lampMat);
    lamp.userData.on = (k: number) => { lampMat.emissiveIntensity = 0.08 + Math.max(0, k) * 3; };
    h.add(lamp);
    // bench_tools upgrade: soldering station, iron in its coil holder, glowing tip, a solder reel
    const ut = upg('bench_tools');
    place(ut, 'trim', M, RB(0.16, 0.08, 0.12, 0.05, top + 0.04, 0.0, 0.01, 1));
    place(ut, 'steel', M, CZ(0.018, 0.01, 0.05, top + 0.045, 0.062, 10));
    for (let k = 0; k < 5; k++) place(ut, 'steel', M, new THREE.TorusGeometry(0.02, 0.003, 4, 10).rotateX(Math.PI / 2).translate(0.2, top + 0.03 + k * 0.012, 0.0));
    place(ut, 'trim', M, CY(0.012, 0.12, 0.2, top + 0.13, 0.0, 8));
    place(ut, 'steel', M, CY(0.004, 0.06, 0.2, top + 0.22, 0.0, 6));
    place(ut, 'lens', M, new THREE.SphereGeometry(0.006, 8, 6).translate(0.2, top + 0.252, 0.0), L_TIP);
    place(ut, 'steel', M, CX(0.03, 0.025, -0.1, top + 0.03, 0.05, 14));
    stations.set('workbench', h);
    inn.extraObjects.push(h);
  }

  const sh = station('booklet');
  if (sh) {
    begin('booklet');
    const M = frameOf(sh), sy = sh.y;
    const h = holder(sh);
    const w = sh.w, d = sh.d, hh = sh.h;
    const by = sy - hh / 2;
    place(inn, 'ply', M, BX(w, 0.02, d, 0, by + 0.01, 0));
    for (const sx of [-1, 1]) place(inn, 'ply', M, BX(0.015, hh - 0.02, d, sx * (w / 2 - 0.0075), by + hh / 2, 0));
    place(inn, 'steel', M, CX(0.007, w - 0.03, 0, by + 0.09, d / 2 - 0.01, 6));
    for (const sx of [-0.33, 0.33]) place(inn, 'steel', M, BX(0.02, 0.1, d - 0.04, sx, by - 0.05, -0.02));
    // 'books': manuals and binders, vertex-coloured spines (own material)
    const geos: G[] = [];
    const cols: V3[] = [[0.42, 0.12, 0.1], [0.12, 0.2, 0.34], [0.36, 0.32, 0.22], [0.1, 0.26, 0.16], [0.55, 0.48, 0.3], [0.2, 0.2, 0.2], [0.5, 0.36, 0.08]];
    let x = -w / 2 + 0.03, k = 0;
    while (x < w / 2 - 0.08) {
      const bw = 0.03 + ((k * 37) % 5) * 0.009, bh = Math.min(hh - 0.06, 0.2 + ((k * 53) % 7) * 0.014), bd = Math.min(d - 0.04, 0.16 + ((k * 17) % 3) * 0.015);
      const g = BX(bw, bh, bd, x + bw / 2, by + 0.02 + bh / 2, -d / 2 + 0.02 + bd / 2);
      const col = cols[(k * 3) % cols.length];
      const n = g.index ? g.toNonIndexed() : g;
      const cc = new Float32Array(n.getAttribute('position').count * 3);
      for (let i = 0; i < cc.length; i += 3) cc.set(col, i);
      n.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      geos.push(n);
      x += bw + 0.004;
      k++;
      if (k === 11) x += 0.07; // a gap where the booklet goes
    }
    const books = namedMesh('books', geos, namedMaterial('books', 0xffffff, { vertexColors: true, rough: 0.78, metal: 0 }));
    h.add(books);
    stations.set('booklet', h);
    inn.extraObjects.push(h);
  }

  const ch = station('charger');
  if (ch) {
    begin('charger');
    const M = frameOf(ch), y = ch.y;
    const h = holder(ch);
    const w = ch.w, d = ch.d, hh = ch.h;
    place(inn, 'trim', M, RB(w, hh, d - 0.01, 0, y, -0.005, 0.015));
    for (let k = 0; k < 4; k++) {
      const x = -w / 2 + (k + 0.5) * (w / 4);
      place(inn, 'steel', M, CY(0.026, 0.09, x, y - hh / 2 + 0.06, d / 2 + 0.01, 12));
    }
    const cradle = namedMesh('cradle', [0, 1, 2, 3].map((k) => BX(0.03, 0.012, 0.004, -w / 2 + (k + 0.5) * (w / 4), y + hh / 2 - 0.06, d / 2 - 0.003)).concat([BX(w - 0.08, 0.02, 0.004, 0, y + hh / 2 - 0.035, d / 2 - 0.003)]), namedMaterial('cradle', 0x0a140c, { emissive: 0x3dff6a, ei: 1.6, rough: 0.3 }));
    h.add(cradle);
    // charging_rack upgrade: a rack under the charger with four flashlights docked + green LEDs
    const ur = upg('charging_rack');
    place(ur, 'steel', M, BX(w + 0.06, 0.025, d + 0.04, 0, y - hh / 2 - 0.22, 0.01));
    place(ur, 'steel', M, BX(w + 0.06, 0.12, 0.012, 0, y - hh / 2 - 0.16, -d / 2 + 0.01));
    for (let k = 0; k < 4; k++) {
      const x = -w / 2 + (k + 0.5) * (w / 4);
      place(ur, 'trim', M, CY(0.02, 0.2, x, y - hh / 2 - 0.1, d / 2 + 0.01, 10));
      place(ur, 'steel', M, CY(0.028, 0.05, x, y - hh / 2 + 0.02, d / 2 + 0.01, 12, 0.022));
      place(ur, 'lens', M, BX(0.012, 0.012, 0.004, x, y - hh / 2 - 0.19, d / 2 + 0.035), L_GREEN);
    }
    stations.set('charger', h);
    inn.extraObjects.push(h);
  }

  const st = station('stash');
  if (st) {
    begin('stash');
    const M = frameOf(st);
    const h = holder(st);
    const w = st.w, d = st.d, hh = st.h;
    place(inn, 'wall', M, BX(w, hh, 0.012, 0, hh / 2, -d / 2 + 0.006));
    for (const sx of [-1, 1]) place(inn, 'wall', M, BX(0.012, hh, d, sx * (w / 2 - 0.006), hh / 2, 0));
    place(inn, 'wall', M, BX(w, 0.012, d, 0, hh - 0.006, 0));
    place(inn, 'trim', M, BX(w, 0.06, d - 0.02, 0, 0.03, -0.01));
    for (const y of [0.62, 1.3]) place(inn, 'wall', M, BX(w - 0.024, 0.012, d - 0.03, 0, y, -0.015));
    // contents: a duffel bag on the floor, a crate and a box on the shelves
    place(inn, 'paint', M, new THREE.CapsuleGeometry(0.11, 0.3, 4, 10).rotateZ(Math.PI / 2).translate(0, 0.17, -0.02), OLIVE);
    place(inn, 'ply', M, BX(0.3, 0.2, 0.2, -0.08, 0.73, -0.03));
    place(inn, 'trim', M, BX(0.22, 0.14, 0.18, 0.1, 1.38, -0.03));
    // hinged 'door': pivot on the edge at local +x, opens toward the aisle with rotation.y = +angle
    const doorMat = namedMaterial('stash-door', 0x55625a, { rough: 0.5, metal: 0.4 });
    const pivot = new THREE.Group();
    pivot.name = 'door';
    pivot.position.set(w / 2 - 0.004, 0, d / 2 + 0.006);
    const dw = w - 0.012;
    const dg: G[] = [BX(dw, hh - 0.02, 0.016, -dw / 2, hh / 2, 0)];
    for (let k = 0; k < 6; k++) { dg.push(BX(dw * 0.6, 0.014, 0.012, -dw / 2, hh - 0.25 - k * 0.035, 0.011)); dg.push(BX(dw * 0.6, 0.014, 0.012, -dw / 2, 0.2 + k * 0.035, 0.011)); }
    dg.push(BX(0.025, 0.16, 0.03, -dw + 0.06, hh * 0.52, 0.02), BX(0.05, 0.05, 0.02, -dw + 0.06, hh * 0.45, 0.02));
    const door = namedMesh('door-leaf', dg, doorMat, true, [pivot.position.x, pivot.position.y, pivot.position.z]);
    pivot.add(door);
    pivot.userData.openAngle = 1.75;
    pivot.userData.setOpen = (t: number) => { pivot.rotation.y = Math.max(0, Math.min(1, t)) * 1.75; };
    h.add(pivot);
    stations.set('stash', h);
    inn.extraObjects.push(h);
  }

  const mr = station('mirror');
  if (mr) {
    begin('mirror');
    const M = frameOf(mr), y = mr.y;
    const h = holder(mr);
    const w = mr.w, hh = mr.h;
    place(inn, 'trim', M, BX(w, hh, 0.01, 0, y, -mr.d / 2 + 0.005));
    for (const sy of [-1, 1]) place(inn, 'steel', M, BX(w, 0.022, 0.024, 0, y + sy * (hh / 2 - 0.011), 0));
    for (const sx of [-1, 1]) place(inn, 'steel', M, BX(0.022, hh - 0.044, 0.024, sx * (w / 2 - 0.011), y, 0));
    const glassMat = namedMaterial('mirror-glass', 0x9aa3a6, { rough: 0.06, metal: 1 });
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.044, hh - 0.044), glassMat);
    glass.name = 'glass';
    glass.position.set(0, y, 0.008);
    grow(glass.geometry.clone().translate(0, y, 0.008));
    geometries.push(glass.geometry);
    const gh = new THREE.Group();
    gh.add(glass);
    h.add(gh);
    mirrors.push({ glass, itemId: mr.itemId, space: mr.space, w: w - 0.044, h: hh - 0.044 });
    stations.set('mirror', h);
    inn.extraObjects.push(h);
  }

  curBox = null;
  // stretcher upgrade: folded stretcher strapped under the roof on the left, a red-cross kit on the rear left wall
  {
    const u = upg('stretcher');
    const x = -IN + 0.42, z0 = 1.25, z1 = Math.min(CL - 0.7, 3.05);
    for (const dx of [-0.17, 0.17]) u.add('steel', CZ(0.016, z1 - z0, x + dx, ROOF_IN - 0.12, (z0 + z1) / 2, 8));
    u.add('paint', BX(0.32, 0.05, z1 - z0 - 0.1, x, ROOF_IN - 0.1, (z0 + z1) / 2), OLIVE);
    for (const z of [z0 + 0.3, z1 - 0.3]) u.add('trim', BX(0.4, 0.012, 0.05, x, ROOF_IN - 0.07, z));
    u.add('ply', RB(0.3, 0.22, 0.1, -IN + 0.05, 1.72, 0.32, 0.015));
    u.add('paint', BX(0.004, 0.035, 0.12, -IN + 0.102, 1.72, 0.32), RED);
    u.add('paint', BX(0.004, 0.12, 0.035, -IN + 0.102, 1.72, 0.32), RED);
  }
  // scanner upgrade (exterior part): roof mast with a whip and a small dish (screen3 sits on the console item)
  {
    const u = upg('scanner:ext');
    u.add('trim', CY(0.06, 0.05, -0.6, BOX_TOP + 0.025, CL - 0.6, 12));
    u.add('chrome', CY(0.018, 0.55, -0.6, BOX_TOP + 0.3, CL - 0.6, 8));
    u.add('chrome', CY(0.004, 1.1, -0.6, BOX_TOP + 1.1, CL - 0.6, 4));
    u.add('trim', new THREE.SphereGeometry(0.14, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.4).rotateX(-Math.PI / 2 - 0.4).translate(-0.6, BOX_TOP + 0.5, CL - 0.45));
  }

  // ---------------- materials + meshes
  const matOf = (key: string): THREE.Material => {
    switch (key) {
      case 'paint': return paintMaterial();
      case 'trim': return lm.get('trim');
      case 'chrome': case 'steel': return setMaterial(lm, 'steel');
      case 'tyre': return tyreMaterial();
      case 'glass': return glassMaterial();
      case 'lens': case 'led': return lensMaterial();
      case 'decal': return at?.mat ?? lm.get('trim');
      case 'floor': return lm.get('van_floor');
      case 'ply': return lm.get('wood');
      case 'wall': return lm.get('metal_painted');
      case 'dark': return lm.get('metal_dark');
      default: return lm.get('trim');
    }
  };
  const NO_SHADOW = new Set(['glass', 'lens', 'led', 'decal']);
  const finish = (coll: Coll, parent: THREE.Group, prefix: string, hidden = false): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    for (const [key, list] of coll.m) {
      const g = mergeFlat(list);
      geometries.push(g);
      const mesh = new THREE.Mesh(g, matOf(key));
      mesh.name = `${prefix}.${key}`;
      mesh.castShadow = !hidden && !NO_SHADOW.has(key);
      mesh.receiveShadow = !NO_SHADOW.has(key);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (hidden) mesh.visible = false;
      parent.add(mesh);
      out.push(mesh);
    }
    return out;
  };
  const exterior = new THREE.Group();
  exterior.name = 'van';
  exterior.position.set(c.x + c.w / 2, 0, c.y);
  const interior = new THREE.Group();
  interior.name = 'van-interior';
  interior.position.copy(exterior.position);
  finish(ext, exterior, 'van');
  // interior: 'lens' collects the upgrade LEDs; 'led' the always-on strip / night light
  finish(inn, interior, 'van.in');
  for (const o of inn.extraObjects) interior.add(o);
  const upgrades = new Map<string, THREE.Object3D[]>();
  for (const [id, coll] of up) {
    const ext2 = id.endsWith(':ext');
    const key = ext2 ? id.slice(0, -4) : id;
    const meshes = finish(coll, ext2 ? exterior : interior, `van.up.${key}`, true);
    upgrades.set(key, [...(upgrades.get(key) ?? []), ...meshes]);
  }
  exterior.updateMatrixWorld(true);
  interior.updateMatrixWorld(true);
  return { exterior, interior, stations, upgrades, mirrors, geometries, itemIds, stationBounds };
}

/** merge non-indexed geometries with the same attribute set (the collectors guarantee it) */
function mergeFlat(list: G[]): G {
  if (list.length === 1) return list[0];
  const merged = mergeGeometries(list) ?? list[0];
  if (merged !== list[0]) for (const g of list) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}
