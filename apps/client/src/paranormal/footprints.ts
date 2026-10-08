// Owner: env-paranormal (v1.2) client. Wet bare-foot prints: ONE global InstancedMesh (one draw for every print of
// every footprint event), each print appearing at `at + i * stepMs` with a soft wet step, drying out by `at + fadeMs`
// (90 s). Glossy dark decals a few mm above the floor; left feet are the mirrored right print.
import * as THREE from 'three/webgpu';
import { attribute, float, texture, uv, vec3 } from 'three/tsl';
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import type { Effect, Env, WitnessSpec } from './env.ts';
import { seeded } from './env.ts';
import { footprintTexture } from './writing.ts';

const MAX = 128;

interface Pool {
  mesh: THREE.InstancedMesh;
  fade: THREE.InstancedBufferAttribute;
  /** slot -> owning event id (0 = free) */
  owner: Int32Array;
}

let pool: Pool | null = null;

/** the shared pool mesh (created once; parented by the caller under the scene) */
export function footprintPool(): Pool {
  if (pool) return pool;
  const geo = new THREE.PlaneGeometry(0.125, 0.285);
  geo.rotateX(-Math.PI / 2);
  const fade = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
  fade.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('fade', fade);
  const tex = footprintTexture();
  const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, metalness: 0 });
  const a = texture(tex, uv()).a;
  // standing water: very dark and glossy. Not mirror-smooth: at roughness ~0.03 a flashlight only makes a pin-point
  // glint per print (shots 2026-10-08); ~0.14 spreads the sheen over the whole print so its shape reads in a beam
  mat.colorNode = vec3(0.004, 0.005, 0.006);
  mat.roughnessNode = float(0.14);
  mat.opacityNode = a.mul(attribute('fade', 'float')).mul(0.96);
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
  mat.name = 'para-footprint';
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.name = 'para-footprints';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.count = 0;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX; i++) mesh.setMatrixAt(i, zero);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pool = { mesh, fade, owner: new Int32Array(MAX) };
  return pool;
}

/** compact draw count: highest used slot + 1 (prints keep their slot while they live) */
function recount(p: Pool): void {
  let n = 0;
  for (let i = 0; i < MAX; i++) if (p.owner[i] !== 0) n = i + 1;
  p.mesh.count = n;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();

export class Footprints implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private slots: number[] = [];
  private pts: number[][];
  private stepped: boolean[];
  private seenSent = false;
  private fadeMs: number;
  private stepMs: number;

  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
    this.pts = (ev.data?.pts as number[][] | undefined) ?? [];
    this.stepped = this.pts.map(() => false);
    this.fadeMs = Number(ev.data?.fadeMs ?? 90_000);
    this.stepMs = Number(ev.data?.stepMs ?? 560);
    const p = footprintPool();
    const rnd = seeded(ev.seed);
    for (let i = 0; i < this.pts.length; i++) {
      let s = -1;
      for (let k = 0; k < MAX; k++) if (p.owner[k] === 0) { s = k; break; }
      if (s < 0) break;
      p.owner[s] = ev.id;
      this.slots.push(s);
      const [x, z, yaw] = this.pts[i];
      const left = i % 2 === 1;
      q.setFromAxisAngle(up, yaw + (rnd() - 0.5) * 0.12);
      pos.set(x, 0.006 + i * 0.0001, z);
      const k = 0.93 + rnd() * 0.12;
      scl.set(left ? -k : k, 1, k);
      m4.compose(pos, q, scl);
      p.mesh.setMatrixAt(s, m4);
      p.fade.setX(s, 0);
    }
    p.mesh.instanceMatrix.needsUpdate = true;
    p.fade.needsUpdate = true;
    recount(p);
  }

  update(now: number): boolean {
    const p = footprintPool();
    const age = now - this.ev.at;
    if (age > this.fadeMs) return false;
    const subtle = this.env.settings().mode === 'subtle';
    const cam = this.env.players()?.cameraPos?.();
    let dirty = false;
    for (let i = 0; i < this.slots.length; i++) {
      const t0 = i * this.stepMs;
      const local = age - t0;
      // appear (150 ms), stay wet, dry out over the last third of the 90 s
      let f = local < 0 ? 0 : Math.min(1, local / 150);
      const dryStart = this.fadeMs * 0.66;
      if (age > dryStart) f *= Math.max(0, 1 - (age - dryStart) / (this.fadeMs - dryStart));
      const s = this.slots[i];
      if (Math.abs(p.fade.getX(s) - f) > 0.004) { p.fade.setX(s, f); dirty = true; }
      if (!this.stepped[i] && local >= 0) {
        this.stepped[i] = true;
        const [x, z] = this.pts[i];
        // a soft wet step (only where the local listener could hear it, and not for a late join's backlog)
        if (local < 300 && cam && Math.hypot(cam[0] - x, cam[2] - z) < 14) {
          this.env.synth('wet_step', [x, 0.05, z], { seed: this.ev.seed + i, volume: subtle ? 0.18 : 0.3 }, { key: 'sfx.step_concrete', volume: 0.07, rate: 0.75 });
        }
      }
    }
    if (dirty) p.fade.needsUpdate = true;
    return true;
  }

  witness(): WitnessSpec | null {
    if (this.seenSent) return null;
    const age = this.env.serverNow() - this.ev.at;
    if (age < 0) return null;
    const shown = Math.min(this.pts.length, Math.floor(age / this.stepMs) + 1);
    const pts = this.pts.slice(Math.max(0, shown - 6), shown).map((q2) => [q2[0], 0.05, q2[1]] as [number, number, number]);
    return pts.length ? { points: pts, maxM: 20 } : null;
  }

  onSeen(): void { this.seenSent = true; }
  end(): void { /* prints stay until they dry */ }

  dispose(): void {
    const p = footprintPool();
    const zero = m4.makeScale(0, 0, 0);
    for (const s of this.slots) {
      p.owner[s] = 0;
      p.fade.setX(s, 0);
      p.mesh.setMatrixAt(s, zero);
    }
    p.mesh.instanceMatrix.needsUpdate = true;
    p.fade.needsUpdate = true;
    recount(p);
    this.slots = [];
  }
}
