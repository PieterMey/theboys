// Owner: env-render (v1.2). Puffs: breath, steam, dust and frost clouds (render.puff) from ONE instanced Sprite
// (64 soft sprites in a ring buffer, one draw, one pipeline that is always in the scene so the warm-up compiles it).
// Each sprite carries its own start time, drift and a brightness sampled at spawn (fixture grid + the local beam),
// so a breath cloud only shows where there is light to see it by. Deterministic jitter (no Math.random).
import * as THREE from 'three/webgpu';
import { Fn, float, instancedDynamicBufferAttribute, length, renderGroup, smoothstep, uniform, uv, vec3, mix } from 'three/tsl';
import type { V3 } from './api.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export type PuffKind = 'breath' | 'steam' | 'dust' | 'frost';

const KIND: Record<PuffKind, { color: [number, number, number]; n: number; life: number; size: [number, number]; rise: number; spread: number; alpha: number }> = {
  breath: { color: [0.82, 0.86, 0.9], n: 6, life: 1.6, size: [0.07, 0.42], rise: 0.12, spread: 0.18, alpha: 0.32 },
  steam: { color: [0.86, 0.88, 0.9], n: 10, life: 3.2, size: [0.15, 1.1], rise: 0.45, spread: 0.3, alpha: 0.26 },
  dust: { color: [0.62, 0.56, 0.48], n: 12, life: 2.6, size: [0.12, 0.9], rise: 0.05, spread: 0.55, alpha: 0.22 },
  frost: { color: [0.8, 0.9, 1.0], n: 8, life: 2.2, size: [0.1, 0.7], rise: -0.03, spread: 0.35, alpha: 0.28 },
};

export const PUFF_CAP = 64;

export interface Puffs {
  sprite: THREE.Sprite;
  /** spawn a puff; brightness = scene light at the spot (0 = invisible in the dark); now = performance.now() */
  puff(pos: V3, kind: PuffKind, strength: number, brightness: number, now: number, dir?: V3): void;
  /** per frame: the shared clock */
  update(now: number): void;
  active(now: number): number;
}

const hash = (n: number) => (((n | 0) * 2654435761) >>> 0) / 4294967296;

export function createPuffs(scene: THREE.Scene): Puffs {
  // a: pos.xyz + t0 (s); b: vel.xyz + life (s); c: size0, size1, alpha, rise; d: rgb x brightness, unused
  const A = new THREE.InstancedBufferAttribute(new Float32Array(PUFF_CAP * 4), 4);
  const B = new THREE.InstancedBufferAttribute(new Float32Array(PUFF_CAP * 4), 4);
  const C = new THREE.InstancedBufferAttribute(new Float32Array(PUFF_CAP * 4), 4);
  const D = new THREE.InstancedBufferAttribute(new Float32Array(PUFF_CAP * 4), 4);
  for (const a of [A, B, C, D]) a.setUsage(THREE.DynamicDrawUsage);
  // dead sprites: t0 far in the past
  for (let i = 0; i < PUFF_CAP; i++) { A.array[i * 4 + 3] = -1e6; B.array[i * 4 + 3] = 1; }
  const now = uniform(0).setGroup(renderGroup);
  const a = instancedDynamicBufferAttribute(A, 'vec4') as N;
  const b = instancedDynamicBufferAttribute(B, 'vec4') as N;
  const c = instancedDynamicBufferAttribute(C, 'vec4') as N;
  const dd = instancedDynamicBufferAttribute(D, 'vec4') as N;
  const m = new THREE.SpriteNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.name = 'render-puff';
  const age = now.sub(a.w).max(0).toVar();
  const u = age.div(b.w).clamp(0, 1).toVar();
  // drift: velocity slows down (drag), buoyancy lifts; the cloud grows and fades
  const drift = b.xyz.mul(age.mul(float(1).sub(u.mul(0.45))));
  m.positionNode = a.xyz.add(drift).add(vec3(0, c.w.mul(age).mul(age).mul(0.5), 0));
  m.scaleNode = mix(c.x, c.y, u.sqrt());
  const soft = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2);
    return smoothstep(1.0, 0.15, r).pow(1.6);
  })();
  const fade = smoothstep(0.0, 0.12, u).mul(float(1).sub(smoothstep(0.45, 1.0, u)));
  m.colorNode = dd.xyz;
  m.opacityNode = soft.mul(fade).mul(c.z).mul(age.lessThan(b.w).select(float(1), float(0)));
  const sprite = new THREE.Sprite(m);
  sprite.count = PUFF_CAP;
  sprite.frustumCulled = false;
  sprite.name = 'render-puffs';
  sprite.renderOrder = 7;
  scene.add(sprite);
  let head = 0;
  let seq = 0;
  let clock = 0;
  return {
    sprite,
    update(nowMs) { clock = nowMs / 1000; now.value = clock; },
    active(nowMs) {
      const t = nowMs / 1000;
      let n = 0;
      for (let i = 0; i < PUFF_CAP; i++) if (t - (A.array[i * 4 + 3] as number) < (B.array[i * 4 + 3] as number)) n++;
      return n;
    },
    puff(pos, kind, strength, brightness, nowMs, dir) {
      const k = KIND[kind] ?? KIND.breath;
      const t0 = nowMs / 1000;
      const s = Math.max(0, Math.min(2, strength));
      const lum = Math.max(0, brightness);
      for (let j = 0; j < k.n; j++) {
        const i = head;
        head = (head + 1) % PUFF_CAP;
        const h1 = hash(seq * 7 + 1), h2 = hash(seq * 7 + 2), h3 = hash(seq * 7 + 3), h4 = hash(seq * 7 + 4);
        seq++;
        const sp = k.spread * (0.4 + h1);
        const fwd = dir ? 0.35 : 0;
        A.array.set([pos[0] + (h2 - 0.5) * 0.06, pos[1] + (h3 - 0.5) * 0.04, pos[2] + (h4 - 0.5) * 0.06, t0 + j * 0.035], i * 4);
        B.array.set([(h2 - 0.5) * sp + (dir ? dir[0] * fwd : 0), (h3 - 0.3) * sp * 0.4 + (dir ? dir[1] * fwd : 0), (h4 - 0.5) * sp + (dir ? dir[2] * fwd : 0), k.life * (0.75 + 0.5 * h1)], i * 4);
        C.array.set([k.size[0] * (0.8 + 0.4 * h3), k.size[1] * s * (0.7 + 0.6 * h4), k.alpha * Math.min(1, s), k.rise], i * 4);
        D.array.set([k.color[0] * lum, k.color[1] * lum, k.color[2] * lum, 0], i * 4);
      }
      for (const x of [A, B, C, D]) x.needsUpdate = true;
      void clock;
    },
  };
}
