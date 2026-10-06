// Owner: track ② Level. Level surface materials: flat PBR immediately (built with ③'s makeSurfaceMaterial), upgraded
// in place to KTX2 textures from /assets/manifest.json (albedo + normal + packed ORM = 3 textures max) when present.
import * as THREE from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { assetUrl, basisPath, getAssetManifest, hasAsset, loadAssetManifest } from '@dead-air/shared/assets.ts';
import type { MaterialId } from '@dead-air/shared/assets.ts';
import { makeEmissive, makeSurfaceMaterial } from '../render/materials.ts';

export type MatId =
  | 'floor_concrete' | 'floor_lino' | 'floor_tiles' | 'floor_rubber' | 'floor_metal' | 'floor_dirt'
  | 'wall_tile_green' | 'wall_tile_white' | 'wall_plaster' | 'wall_plaster_green' | 'wall_plaster_blue' | 'wall_concrete'
  | 'wall_concrete_dark' | 'wall_vault' | 'ceiling_tiles' | 'ceiling_concrete' | 'ceiling_metal'
  | 'facade' | 'asphalt' | 'trim' | 'metal_rusty' | 'metal_painted' | 'metal_dark' | 'wood' | 'van_body' | 'rubble';

interface MatSpec {
  tex?: MaterialId;
  /** flat colour (no textures) */
  color: number;
  /** tint multiplied onto the albedo texture */
  tint?: number;
  rough: number;
  metal: number;
  grime?: number;
  side?: THREE.Side;
  /** anisotropic filtering for grazing floors */
  aniso?: number;
  /** 0..1 standing water (puddle gloss, ③ makeSurfaceMaterial wet) */
  wet?: number;
  /** roughness floor after texture/grime modulation (matte walls: no glare under the flashlight) */
  minRough?: number;
}

const SPECS: Record<MatId, MatSpec> = {
  floor_concrete: { tex: 'concrete_floor', color: 0x77746d, tint: 0xd8d4cc, rough: 0.92, metal: 0, grime: 0.6, aniso: 8, wet: 0.55 },
  floor_lino: { tex: 'floor_linoleum', color: 0x6f7b6c, tint: 0xb7c4ad, rough: 0.7, metal: 0, grime: 0.55, aniso: 8, wet: 0.45 },
  floor_tiles: { tex: 'floor_tiles', color: 0x9a9e95, tint: 0xd6dbcf, rough: 0.55, metal: 0, grime: 0.55, aniso: 8, wet: 0.7 },
  floor_rubber: { tex: 'rubber_floor', color: 0x3c3f41, tint: 0x9aa0a4, rough: 0.85, metal: 0, grime: 0.4, aniso: 8 },
  floor_metal: { tex: 'metal_plate', color: 0x5d6062, tint: 0xa9adb0, rough: 0.5, metal: 0.65, grime: 0.6, aniso: 8, wet: 0.35 },
  floor_dirt: { tex: 'asphalt', color: 0x3b3328, tint: 0x8a7558, rough: 0.98, metal: 0, grime: 0.7, aniso: 8 },
  wall_tile_green: { tex: 'tiles_white', color: 0x7f977c, tint: 0xa9c4a0, rough: 0.6, metal: 0, grime: 0.65, minRough: 0.5 },
  wall_tile_white: { tex: 'tiles_white', color: 0xb9bcb3, tint: 0xe2e3da, rough: 0.6, metal: 0, grime: 0.6, minRough: 0.5 },
  wall_plaster: { tex: 'wall_plaster', color: 0xa9ad9f, tint: 0xd8dccd, rough: 0.92, metal: 0, grime: 0.6, minRough: 0.86 },
  wall_plaster_green: { tex: 'wall_plaster', color: 0x7e8f7a, tint: 0xaabda2, rough: 0.92, metal: 0, grime: 0.65, minRough: 0.86 },
  wall_plaster_blue: { tex: 'wall_plaster', color: 0x7a8791, tint: 0xa7b6c2, rough: 0.92, metal: 0, grime: 0.6, minRough: 0.86 },
  wall_concrete: { tex: 'wall_concrete', color: 0x7f7d77, tint: 0xd2cfc6, rough: 0.94, metal: 0, grime: 0.7, minRough: 0.88 },
  wall_concrete_dark: { tex: 'wall_concrete', color: 0x5d5c58, tint: 0x9b9890, rough: 0.95, metal: 0, grime: 0.75, minRough: 0.88 },
  wall_vault: { tex: 'metal_plate', color: 0x5e656b, tint: 0x9aa4ad, rough: 0.58, metal: 0.45, grime: 0.45, minRough: 0.45 },
  ceiling_tiles: { tex: 'ceiling_tiles', color: 0x9c9c95, tint: 0xd0d0c6, rough: 0.92, metal: 0, grime: 0.5, minRough: 0.85 },
  ceiling_concrete: { tex: 'ceiling_plaster', color: 0x6c6b67, tint: 0xa8a69f, rough: 0.95, metal: 0, grime: 0.6, minRough: 0.88 },
  ceiling_metal: { tex: 'corrugated_metal', color: 0x5a5b5a, tint: 0x9c9d9a, rough: 0.6, metal: 0.5, grime: 0.6 },
  facade: { tex: 'wall_concrete', color: 0x5f5e5a, tint: 0xa4a29a, rough: 0.96, metal: 0, grime: 0.85, minRough: 0.9 },
  asphalt: { tex: 'asphalt', color: 0x2f3032, tint: 0x8d8e90, rough: 0.97, metal: 0, grime: 0.6, aniso: 8, wet: 0.8 },
  trim: { color: 0x26292a, rough: 0.6, metal: 0.1, grime: 0.3 },
  metal_rusty: { tex: 'metal_rusty', color: 0x6a4a35, tint: 0xd0b8a5, rough: 0.7, metal: 0.55, grime: 0.5 },
  metal_painted: { tex: 'metal_painted', color: 0x5f6a64, tint: 0xb8c4bc, rough: 0.72, metal: 0.1, grime: 0.5, minRough: 0.6 },
  metal_dark: { tex: 'metal_plate', color: 0x3c4044, tint: 0x80868c, rough: 0.6, metal: 0.6, grime: 0.4, minRough: 0.45 },
  wood: { color: 0x5b4030, rough: 0.62, metal: 0, grime: 0.45 },
  van_body: { color: 0xa9aaa3, rough: 0.74, metal: 0, grime: 0.6, minRough: 0.62 },
  rubble: { tex: 'wall_concrete', color: 0x6b6862, tint: 0xb6b2aa, rough: 0.98, metal: 0, grime: 0.8, minRough: 0.9 },
};

let ktx2: KTX2Loader | null = null;
const texCache = new Map<string, Promise<THREE.Texture | null>>();

/** one KTX2 loader for the level (surface textures + prop GLBs) */
export function sharedKTX2(renderer: THREE.WebGPURenderer): KTX2Loader {
  ktx2 ??= new KTX2Loader().setTranscoderPath(basisPath()).detectSupport(renderer);
  return ktx2;
}

function loadTex(renderer: THREE.WebGPURenderer, key: string, linear: boolean): Promise<THREE.Texture | null> {
  let p = texCache.get(key);
  if (p) return p;
  p = (async () => {
    const url = assetUrl(key);
    if (!url) return null;
    try {
      const k = sharedKTX2(renderer);
      const t = await k.loadAsync(url);
      t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    } catch {
      const webp = assetUrl(key, 'webp');
      if (!webp) return null;
      try {
        const t = await new THREE.TextureLoader().loadAsync(webp);
        t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        return t;
      } catch { return null; }
    }
  })();
  texCache.set(key, p);
  return p;
}

export class LevelMaterials {
  private mats = new Map<MatId, THREE.MeshStandardNodeMaterial>();
  private upgraded = new Set<MatId>();
  private emissive = new Map<string, THREE.Material>();
  private renderer: THREE.WebGPURenderer | null = null;
  /** true once every requested material has its textures (or has none available) */
  texturesDone = false;

  get(id: MatId): THREE.MeshStandardNodeMaterial {
    let m = this.mats.get(id);
    if (m) return m;
    const s = SPECS[id];
    m = makeSurfaceMaterial({ color: s.color, roughness: s.rough, metalness: s.metal, grime: s.grime ?? 0.5, uvMode: 'uv', side: s.side, wet: s.wet, minRough: s.minRough });
    m.name = `level.${id}`;
    this.mats.set(id, m);
    if (this.renderer) void this.upgradeOne(id);
    return m;
  }

  /** unlit emissive material (cached by colour+intensity) */
  glow(color: number, intensity: number): THREE.Material {
    const k = `${color}:${intensity}`;
    let m = this.emissive.get(k);
    if (!m) { m = makeEmissive(color, intensity); m.name = `level.glow.${color.toString(16)}`; this.emissive.set(k, m); }
    return m;
  }

  /** start loading textures for all current (and future) materials */
  async upgradeAll(renderer: THREE.WebGPURenderer): Promise<void> {
    this.renderer = renderer;
    if (!getAssetManifest()) await loadAssetManifest();
    await Promise.all([...this.mats.keys()].map((id) => this.upgradeOne(id)));
    this.texturesDone = true;
  }

  private async upgradeOne(id: MatId): Promise<void> {
    if (this.upgraded.has(id) || !this.renderer) return;
    this.upgraded.add(id);
    const s = SPECS[id];
    if (!s.tex || !hasAsset(`tex.${s.tex}.albedo`)) return;
    const r = this.renderer;
    const [albedo, normal, orm] = await Promise.all([
      loadTex(r, `tex.${s.tex}.albedo`, false), loadTex(r, `tex.${s.tex}.normal`, true), loadTex(r, `tex.${s.tex}.orm`, true),
    ]);
    if (!albedo) return;
    const aniso = Math.min(s.aniso ?? 4, r.getMaxAnisotropy?.() ?? 4);
    for (const t of [albedo, normal, orm]) if (t) t.anisotropy = aniso;
    const tm = makeSurfaceMaterial({
      albedo, normal: normal ?? undefined, orm: orm ?? undefined, color: s.tint ?? 0xffffff, roughness: Math.min(1, s.rough + 0.05),
      metalness: s.metal, grime: (s.grime ?? 0.5) * 0.7, uvMode: 'uv', side: s.side, wet: s.wet, minRough: s.minRough,
    });
    const m = this.mats.get(id);
    if (!m) return;
    // in-place upgrade keeps every mesh reference valid
    m.colorNode = tm.colorNode;
    m.roughnessNode = tm.roughnessNode;
    m.metalnessNode = tm.metalnessNode;
    m.aoNode = tm.aoNode;
    m.normalMap = tm.normalMap;
    if (m.normalMap) m.normalScale.set(1, 1);
    m.needsUpdate = true;
    tm.dispose();
  }
}
