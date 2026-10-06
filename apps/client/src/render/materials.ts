// Owner: track ③ Render. Material factory for every track (world-space UVs, <= 3 textures, procedural grime).
//   import { makeSurfaceMaterial, makeEmissive } from '../render/materials.ts';
//   const wall = makeSurfaceMaterial({ color: 0x59605a, roughness: 0.85, metalness: 0 });
//   const sign = makeEmissive(0x30ff70, 6);   // bright enough to bloom
// Sampler budget: every shadowed flashlight binds a depth texture + comparison sampler into EVERY lit material
// (Chrome WebGPU: 16 samplers per stage). Keep materials at <= 3 textures (pack AO/rough/metal into one ORM).
import * as THREE from 'three/webgpu';
import {
  float, mix, mx_fractal_noise_float, mx_noise_float, normalWorld, positionWorld, texture, triplanarTexture, uniform,
  color as tslColor, smoothstep, fract, floor, hash, abs, vec3,
} from 'three/tsl';

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
   *  'tile' = 0.6 m floor tiles with grout + wet patches, 'concrete' = blotchy concrete, default none */
  pattern?: 'paint' | 'tile' | 'concrete';
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[render] ${msg}`);
}

/** Standard PBR surface: world-space triplanar maps (or mesh UVs), procedural grime so flat walls read in a flashlight. */
export function makeSurfaceMaterial(o: SurfaceOpts): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color: o.color, roughness: o.roughness, metalness: o.metalness });
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

  let colorNode: AnyNode = tslColor(new THREE.Color(o.color));
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
  }
  m.colorNode = colorNode.mul(tint);

  let rough: AnyNode = float(o.roughness);
  let metal: AnyNode = float(o.metalness);
  if (o.orm) {
    o.orm.wrapS = o.orm.wrapT = THREE.RepeatWrapping;
    const orm: AnyNode = world ? triplanarTexture(texture(o.orm), null, null, scale) : texture(o.orm);
    rough = rough.mul(orm.g);
    metal = metal.mul(orm.b);
    m.aoNode = orm.r;
  }
  if (grime > 0) rough = rough.mul(mix(float(1 - 0.35 * grime), float(1 + 0.1 * grime), stains));
  rough = rough.mul(patRough).clamp(0.04, 1);
  m.roughnessNode = rough;
  m.metalnessNode = metal;

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
  void normalWorld;
  return m;
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

/** Scene scan: warns once per material over the sampler budget. */
export function auditSceneMaterials(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      const n = materialTextureCount(m);
      if (n > MAX_MATERIAL_TEXTURES) warnOnce(m.uuid, `material '${m.name || m.type}' on '${mesh.name || mesh.type}' uses ${n} textures (> ${MAX_MATERIAL_TEXTURES}): risks the 16-sampler limit with shadowed flashlights`);
    }
  });
}
