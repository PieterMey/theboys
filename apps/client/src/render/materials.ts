// Owner: track ③ Render / env-render (v1.2). Material factory for every track (world-space UVs, <= 3 textures,
// procedural grime).
//   import { makeSurfaceMaterial, makeEmissive } from '../render/materials.ts';
//   const wall = makeSurfaceMaterial({ color: 0x59605a, roughness: 0.85, metalness: 0 });
//   const sign = makeEmissive(0x30ff70, 6);   // bright enough to bloom
// v1.2: the base colour and an optional tint go through per-material uniforms (m.tintUniform), so theme variants of
// the same surface share ONE shader program; vertexMasks reads a 'mask' vec3 attribute (x contact AO, y dirt,
// z damp) smoothed in the shader; macro = large world-space albedo breakup from the shared noise volume; geometric
// specular AA; 'corrugated' / 'diamond' metal patterns (rough >= 0.7, metal <= 0.3: never a mirror ceiling).
// Sampler budget: every shadowed flashlight binds a depth texture + comparison sampler into EVERY lit material
// (Chrome WebGPU: 16 samplers per stage). Keep materials at <= 3 textures (pack AO/rough/metal into one ORM).
import * as THREE from 'three/webgpu';
import {
  float, mix, mx_fractal_noise_float, mx_noise_float, normalWorld, normalView, positionWorld, texture, texture3D, triplanarTexture, uniform,
  color as tslColor, smoothstep, fract, floor, hash, abs, vec2, vec3, attribute, fwidth, max, sin,
} from 'three/tsl';
import { noiseTexture3D } from './noise3d.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

export const MAX_MATERIAL_TEXTURES = 3;

export interface SurfaceOpts {
  /** albedo (sRGB) texture, sampled triplanar in world space */
  albedo?: THREE.Texture;
  /** tangent-space normal map: only applied with uvMode 'uv' (triplanar normal mapping is not supported) */
  normal?: THREE.Texture;
  /** packed occlusion(R) / roughness(G) / metalness(B) */
  orm?: THREE.Texture;
  color: THREE.ColorRepresentation;
  roughness: number;
  metalness: number;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  /** metres per texture repeat for world-space projection (default 2) */
  scale?: number;
  /** 'world' (default, no UVs needed) or 'uv' (mesh UVs, normal map allowed) */
  uvMode?: 'world' | 'uv';
  /** 0..1 procedural grime / roughness breakup (default 0.5; 0 = perfectly flat) */
  grime?: number;
  side?: THREE.Side;
  /** procedural world-space detail: 'paint' = two-tone institutional wall (dado band, seams, water stains),
   *  'tile' = 0.6 m floor tiles with grout + wet patches, 'concrete' = blotchy concrete,
   *  v1.2 'corrugated' = ribbed sheet metal, 'diamond' = diamond tread plate (both rough >= 0.7, metal <= 0.3) */
  pattern?: 'paint' | 'tile' | 'concrete' | 'corrugated' | 'diamond';
  /** 0..1 standing water on floors: world-space puddles (near-mirror roughness, darker albedo) with damp rims */
  wet?: number;
  /** roughness floor after ORM / grime / pattern modulation (matte walls never turn glossy under the flashlight) */
  minRough?: number;
  /** v1.2: tint (multiplies the albedo) through a per-material uniform: theme variants share one shader */
  tint?: THREE.ColorRepresentation;
  /** v1.2: reuse an existing tint uniform (in-place material upgrades keep their tint handle) */
  tintUniform?: { value: THREE.Color };
  /** v1.2: read the geometry's 'mask' vec3 attribute (x contact AO, y dirt, z damp, each 0..1), smoothed in the shader */
  vertexMasks?: boolean;
  /** v1.2: 0..1 macro variation (large world-space albedo breakup, no visible tiling) */
  macro?: number;
  /** v1.2: geometric specular anti-aliasing (default true) */
  specularAA?: boolean;
}

/** what makeSurfaceMaterial returns: the tint uniform is live (set .value to re-tint without a recompile) */
export type SurfaceMaterial = THREE.MeshStandardNodeMaterial & { tintUniform: { value: THREE.Color }; baseUniform: { value: THREE.Color } };

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[render] ${msg}`);
}

/** Standard PBR surface: world-space triplanar maps (or mesh UVs), procedural grime so flat walls read in a flashlight. */
export function makeSurfaceMaterial(o: SurfaceOpts): SurfaceMaterial {
  const corr = o.pattern === 'corrugated' || o.pattern === 'diamond';
  const roughness0 = corr ? Math.max(0.7, o.roughness) : o.roughness;
  const metalness0 = corr ? Math.min(0.3, o.metalness) : o.metalness;
  const m = new THREE.MeshStandardNodeMaterial({ color: o.color, roughness: roughness0, metalness: metalness0 }) as SurfaceMaterial;
  if (o.side !== undefined) m.side = o.side;
  const scale = float(1 / (o.scale ?? 2));
  const world = (o.uvMode ?? 'world') === 'world';
  const tex = [o.albedo, o.normal, o.orm].filter(Boolean).length;
  if (tex > MAX_MATERIAL_TEXTURES) warnOnce(`surf${tex}`, `makeSurfaceMaterial: ${tex} textures > budget ${MAX_MATERIAL_TEXTURES}`);

  const grime = o.grime ?? 0.5;
  // two cheap noise octaves in world space: large stains + fine speckle
  const p = positionWorld;
  const stains: AnyNode = grime > 0 ? mx_fractal_noise_float(p.mul(0.35), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5).clamp(0, 1) : float(0.5);
  const speck: AnyNode = grime > 0 ? mx_fractal_noise_float(p.mul(3.1), 2, 2.0, 0.5, 1.0).mul(0.5).add(0.5).clamp(0, 1) : float(0.5);
  // darker near the floor (dirt line)
  const floorDirt: AnyNode = grime > 0 ? float(1).sub(p.y.mul(2.2).clamp(0, 1).oneMinus().mul(0.35 * grime)) : float(1);

  // v1.2: base colour + tint are uniforms (the same pattern / texture set compiles once for every colour)
  const base = uniform(new THREE.Color(o.color));
  const tintU = o.tintUniform ?? { value: new THREE.Color(o.tint ?? 0xffffff) };
  if (o.tint !== undefined && o.tintUniform) o.tintUniform.value.set(o.tint);
  const tint0 = uniform(tintU.value);
  let colorNode: AnyNode = (base as AnyNode).mul(tint0);
  if (o.albedo) {
    o.albedo.colorSpace = THREE.SRGBColorSpace;
    o.albedo.wrapS = o.albedo.wrapT = THREE.RepeatWrapping;
    const a: AnyNode = world ? triplanarTexture(texture(o.albedo), null, null, scale) : texture(o.albedo);
    colorNode = colorNode.mul(a.rgb);
  }
  const tint = mix(float(1 - 0.28 * grime), float(1 + 0.08 * grime), stains).mul(mix(float(0.92), float(1.04), speck)).mul(floorDirt);
  let patRough: AnyNode = float(1);
  const pat = o.pattern;
  if (pat === 'paint') {
    const y = p.y;
    const u = p.x.add(p.z);
    const lower = smoothstep(1.07, 1.03, y);
    const trim = smoothstep(0.035, 0.0, abs(y.sub(1.05)));
    const f = fract(u.div(1.25));
    const seam = smoothstep(0.0, 0.01, f).mul(smoothstep(1.0, 0.99, f));
    const streak = mx_noise_float(vec3(u.mul(2.7), y.mul(0.18), 0.5)).mul(0.5).add(0.5);
    const stain = smoothstep(0.55, 0.85, streak).mul(smoothstep(2.9, 0.6, y)).mul(0.45);
    const band = mix(vec3(1, 1, 1), vec3(0.5, 0.6, 0.55), lower);
    colorNode = colorNode.mul(band).mul(mix(float(0.55), float(1), seam)).mul(float(1).sub(trim.mul(0.5))).mul(float(1).sub(stain));
    patRough = mix(float(1), float(0.62), lower).mul(mix(float(0.8), float(1), seam));
  } else if (pat === 'tile') {
    const q = p.xz.div(0.6);
    const cell = floor(q);
    const f = fract(q);
    const grout = smoothstep(0.0, 0.035, f.x).mul(smoothstep(1.0, 0.965, f.x)).mul(smoothstep(0.0, 0.035, f.y)).mul(smoothstep(1.0, 0.965, f.y));
    const tileTint = hash(cell.x.mul(7.13).add(cell.y.mul(157.7))).mul(0.22).add(0.86);
    const wet = smoothstep(0.62, 0.8, mx_noise_float(vec3(p.x.mul(0.35), 0.0, p.z.mul(0.35))).mul(0.5).add(0.5));
    colorNode = colorNode.mul(tileTint).mul(mix(float(0.4), float(1), grout)).mul(float(1).sub(wet.mul(0.25)));
    patRough = mix(float(1.6), float(1), grout).mul(float(1).sub(wet.mul(0.65)));
  } else if (pat === 'concrete') {
    const blot = mx_fractal_noise_float(p.mul(1.7), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    colorNode = colorNode.mul(mix(float(0.75), float(1.12), blot));
    patRough = mix(float(1.1), float(0.85), blot);
  } else if (pat === 'corrugated') {
    // ribs every 7.6 cm along the dominant horizontal axis: ridge highlights read in a raking beam, never a mirror
    const along = p.x.add(p.z).div(0.076).mul(Math.PI * 2);
    const rib = sin(along).mul(0.5).add(0.5);
    colorNode = colorNode.mul(mix(float(0.78), float(1.08), rib));
    patRough = mix(float(1.12), float(0.92), rib);
  } else if (pat === 'diamond') {
    // tread plate: raised diamonds on a 3 cm lattice
    const q = p.xz.div(0.03);
    const f = fract(vec2(q.x.add(floor(q.y).mul(0.5)), q.y));
    const dmd = smoothstep(0.32, 0.18, abs(f.x.sub(0.5)).add(abs(f.y.sub(0.5)).mul(0.45)));
    colorNode = colorNode.mul(mix(float(0.82), float(1.12), dmd));
    patRough = mix(float(1.1), float(0.85), dmd);
  }
  // standing water: low-frequency world-space puddles (flashlight + tube glints) with a damp darker rim
  let puddle: AnyNode = null;
  let damp: AnyNode = null;
  if (o.wet && o.wet > 0) {
    const w = mx_fractal_noise_float(vec3(p.x.mul(0.21), p.y.mul(0.0), p.z.mul(0.21)), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    puddle = smoothstep(0.6, 0.68, w).mul(o.wet);
    damp = smoothstep(0.5, 0.62, w).mul(o.wet);
    colorNode = colorNode.mul(float(1).sub(damp.mul(0.22)).sub(puddle.mul(0.18)));
  }
  // v1.2 macro variation: one tap of the shared noise volume at ~14 m scale (same binding as the fog's noise)
  if (o.macro && o.macro > 0) {
    const n = texture3D(noiseTexture3D(), p.mul(0.071).add(vec3(0.13, 0.41, 0.77))).r;
    colorNode = colorNode.mul(mix(float(1 - 0.2 * o.macro), float(1 + 0.12 * o.macro), n));
  }
  // v1.2 vertex masks: contact AO, dirt, damp (per-vertex bands smoothed + broken up so they never read as stripes)
  let maskAO: AnyNode = null;
  let maskDirt: AnyNode = null;
  let maskDamp: AnyNode = null;
  if (o.vertexMasks) {
    const mk = attribute('mask', 'vec3') as AnyNode;
    const brk = texture3D(noiseTexture3D(), p.mul(0.9)).r;
    maskAO = smoothstep(0.0, 1.0, mk.x).mul(brk.mul(0.4).add(0.8)).clamp(0, 1);
    maskDirt = smoothstep(brk.mul(0.5), brk.mul(0.5).add(0.6), mk.y);
    maskDamp = smoothstep(brk.mul(0.4).add(0.1), brk.mul(0.4).add(0.55), mk.z);
    colorNode = colorNode.mul(float(1).sub(maskAO.mul(0.5))).mul(mix(vec3(1), vec3(0.6, 0.55, 0.48), maskDirt)).mul(float(1).sub(maskDamp.mul(0.3)));
  }
  m.colorNode = colorNode.mul(tint);

  let rough: AnyNode = float(roughness0);
  let metal: AnyNode = float(metalness0);
  if (o.orm) {
    o.orm.wrapS = o.orm.wrapT = THREE.RepeatWrapping;
    const orm: AnyNode = world ? triplanarTexture(texture(o.orm), null, null, scale) : texture(o.orm);
    rough = rough.mul(orm.g);
    metal = metal.mul(orm.b);
    m.aoNode = maskAO ? orm.r.mul(float(1).sub(maskAO.mul(0.6))) : orm.r;
  } else if (maskAO) m.aoNode = float(1).sub(maskAO.mul(0.6));
  if (grime > 0) rough = rough.mul(mix(float(1 - 0.35 * grime), float(1 + 0.1 * grime), stains));
  rough = rough.mul(patRough).clamp(o.minRough ?? (corr ? 0.62 : 0.04), 1);
  if (maskDirt) rough = rough.add(maskDirt.mul(0.15)).clamp(0.04, 1);
  if (maskDamp) rough = rough.mul(float(1).sub(maskDamp.mul(0.55))).clamp(0.04, 1);
  if (puddle) rough = mix(rough.mul(float(1).sub(damp.mul(0.35))), float(0.045), puddle);
  // geometric specular AA: curved / bevelled geometry raises its roughness by its normal's screen-space variation
  if (o.specularAA !== false) rough = max(rough, fwidth(normalView).length().mul(0.9).clamp(0, 0.5));
  m.roughnessNode = rough;
  m.metalnessNode = corr ? metal.min(0.3) : metal;

  if (o.normal) {
    if (world) warnOnce('trinormal', 'makeSurfaceMaterial: normal map ignored with uvMode world (use uvMode: "uv")');
    else {
      m.normalMap = o.normal;
    }
  }
  if (o.emissive !== undefined) {
    m.emissive = new THREE.Color(o.emissive);
    m.emissiveIntensity = o.emissiveIntensity ?? 1;
  }
  void normalWorld; void tslColor;
  m.tintUniform = tintU;
  m.baseUniform = base as unknown as { value: THREE.Color };
  return m;
}

/** re-tint a surface material live (no recompile) */
export function setSurfaceTint(m: THREE.Material, c: THREE.ColorRepresentation): void {
  (m as Partial<SurfaceMaterial>).tintUniform?.value.set(c);
}

export interface EmissiveMaterial extends THREE.MeshBasicNodeMaterial {
  /** live intensity (HDR multiplier; > ~1 blooms) */
  intensity: { value: number };
}

/** Unlit HDR emissive (exit signs, visors, the Core, LEDs). intensity > ~1 feeds bloom. */
export function makeEmissive(color: THREE.ColorRepresentation, intensity = 4): EmissiveMaterial {
  const m = new THREE.MeshBasicNodeMaterial() as EmissiveMaterial;
  const k = uniform(intensity);
  m.colorNode = tslColor(new THREE.Color(color)).mul(k);
  m.intensity = k as unknown as { value: number };
  m.fog = false;
  return m;
}

/** Counts texture slots used by a classic material's map properties (node-graph textures are not visible here). */
export function materialTextureCount(m: THREE.Material): number {
  let n = 0;
  for (const v of Object.values(m)) if (v && typeof v === 'object' && (v as { isTexture?: boolean }).isTexture) n++;
  return n;
}

/** Scene scan: one summary line per scan listing materials (by name, each reported once) over the sampler budget. */
export function auditSceneMaterials(scene: THREE.Object3D): void {
  const over: string[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      const key = `tex:${m.name || m.type}`;
      if (warned.has(key)) continue;
      const n = materialTextureCount(m);
      if (n > MAX_MATERIAL_TEXTURES) { warned.add(key); over.push(`${m.name || m.type}(${n})`); }
    }
  });
  if (over.length) console.info(`[render] ${over.length} material(s) over the ${MAX_MATERIAL_TEXTURES}-texture budget (16-sampler risk with shadowed flashlights): ${over.slice(0, 12).join(', ')}${over.length > 12 ? ', ...' : ''}`);
}
