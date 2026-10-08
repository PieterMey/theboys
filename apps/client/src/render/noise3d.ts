// Owner: env-render (v1.2). Seeded, tileable 64^3 R8 noise volume (fBm of smooth value noise) shared by the fog,
// the mist march and surface macro variation. Replaces the ALU-heavy mx_fractal_noise calls with 1-2 filtered
// taps. Deterministic: an integer hash of (seed, lattice point); no Math.random.
import * as THREE from 'three/webgpu';

export const NOISE_SIZE = 64;

/** 32-bit integer hash -> [0, 1) */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/**
 * Tileable fBm value noise, 0..1 per voxel (period = size). octaves: lattice cell counts per axis (each must divide
 * size); weights normalised. A slight contrast curve keeps the mist banks readable.
 */
export function generateNoise3D(size = NOISE_SIZE, seed = 1337, octaves: readonly number[] = [4, 8, 16, 32]): Uint8Array {
  const out = new Uint8Array(size * size * size);
  const acc = new Float32Array(size * size * size);
  let wsum = 0;
  octaves.forEach((cells, o) => {
    const w = Math.pow(0.55, o);
    wsum += w;
    const step = size / cells;
    // lattice values (cells^3), wrapped
    const lat = new Float32Array(cells * cells * cells);
    for (let z = 0; z < cells; z++) for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) lat[(z * cells + y) * cells + x] = hash3(x, y, z, seed + o * 7919);
    const L = (x: number, y: number, z: number) => lat[(((z % cells) * cells) + (y % cells)) * cells + (x % cells)];
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    for (let z = 0; z < size; z++) {
      const fz = z / step, z0 = Math.floor(fz), tz = fade(fz - z0);
      for (let y = 0; y < size; y++) {
        const fy = y / step, y0 = Math.floor(fy), ty = fade(fy - y0);
        for (let x = 0; x < size; x++) {
          const fx = x / step, x0 = Math.floor(fx), tx = fade(fx - x0);
          const c000 = L(x0, y0, z0), c100 = L(x0 + 1, y0, z0), c010 = L(x0, y0 + 1, z0), c110 = L(x0 + 1, y0 + 1, z0);
          const c001 = L(x0, y0, z0 + 1), c101 = L(x0 + 1, y0, z0 + 1), c011 = L(x0, y0 + 1, z0 + 1), c111 = L(x0 + 1, y0 + 1, z0 + 1);
          const a = c000 + (c100 - c000) * tx, b = c010 + (c110 - c010) * tx;
          const c = c001 + (c101 - c001) * tx, d = c011 + (c111 - c011) * tx;
          const e = a + (b - a) * ty, f = c + (d - c) * ty;
          acc[(z * size + y) * size + x] += w * (e + (f - e) * tz);
        }
      }
    }
  });
  // normalise to 0..1 with a gentle S-curve around the mean
  for (let i = 0; i < acc.length; i++) {
    const v = acc[i] / wsum;
    const s = Math.max(0, Math.min(1, (v - 0.5) * 1.6 + 0.5));
    out[i] = Math.round((s * s * (3 - 2 * s)) * 255);
  }
  return out;
}

let shared: THREE.Data3DTexture | null = null;

/** the one shared noise volume (R8, linear, repeat on all axes) */
export function noiseTexture3D(seed = 1337): THREE.Data3DTexture {
  if (shared) return shared;
  const data = generateNoise3D(NOISE_SIZE, seed);
  const t = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'render-noise3d';
  t.needsUpdate = true;
  shared = t;
  return t;
}

/** CPU sample of the same volume (trilinear, repeat): matches the shader within the 8-bit quantisation */
export function sampleNoise(data: Uint8Array, x: number, y: number, z: number, size = NOISE_SIZE): number {
  const fx = x * size - 0.5, fy = y * size - 0.5, fz = z * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const m = (v: number) => ((v % size) + size) % size;
  const V = (xx: number, yy: number, zz: number) => data[(m(zz) * size + m(yy)) * size + m(xx)] / 255;
  const a = V(x0, y0, z0) + (V(x0 + 1, y0, z0) - V(x0, y0, z0)) * tx;
  const b = V(x0, y0 + 1, z0) + (V(x0 + 1, y0 + 1, z0) - V(x0, y0 + 1, z0)) * tx;
  const c = V(x0, y0, z0 + 1) + (V(x0 + 1, y0, z0 + 1) - V(x0, y0, z0 + 1)) * tx;
  const d = V(x0, y0 + 1, z0 + 1) + (V(x0 + 1, y0 + 1, z0 + 1) - V(x0, y0 + 1, z0 + 1)) * tx;
  const e = a + (b - a) * ty, f = c + (d - c) * ty;
  return e + (f - e) * tz;
}
