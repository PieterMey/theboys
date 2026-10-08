// Owner: env-paranormal (v1.2) client. Movable props (level.propHandle: the instance is hidden, a movable clone is
// handed out, commit() bakes it back): the poltergeist shove (a short jerky slide + a chair scrape) and the fall (a
// fixed-step 120 Hz seeded tip-over to the server's final orientation, landing thud). Every client runs the same
// steps from the same seed; late events and residue jump to the final pose.
import * as THREE from 'three/webgpu';
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import type { PropHandle } from '../level/api.ts';
import type { Effect, Env, WitnessSpec } from './env.ts';
import { seeded } from './env.ts';

const STEP = 1 / 120;

/** fixed-step fall: tip about the push edge, drop to the floor, one small bounce; returns pose at time t (s) */
export interface FallPose { x: number; y: number; z: number; yaw: number; angle: number; done: boolean }

export function fallPose(from: number[], to: number[], angle: number, seed: number, tSec: number): FallPose {
  const rnd = seeded(seed);
  const tipT = 0.32 + rnd() * 0.12;
  const y0 = from[1] ?? 0;
  const g = 9.81;
  const dropT = y0 > 0.05 ? Math.sqrt((2 * y0) / g) : 0;
  const bounceH = 0.02 + rnd() * 0.03;
  const bounceT = 2 * Math.sqrt((2 * bounceH) / g);
  const total = tipT + dropT + bounceT + 0.15;
  const steps = Math.min(Math.round(total / STEP), Math.max(0, Math.floor(tSec / STEP)));
  let x = from[0], z = from[2], y = y0, a = 0, yaw = from[3] ?? 0;
  const ex = to[0], ez = to[1], eyaw = to[2] ?? yaw;
  for (let i = 1; i <= steps; i++) {
    const t = i * STEP;
    if (t <= tipT) {
      // accelerating tip (like a pendulum leaving balance)
      const u = t / tipT;
      a = angle * 0.55 * u * u;
      const k = u * 0.35;
      x = from[0] + (ex - from[0]) * k; z = from[2] + (ez - from[2]) * k;
    } else if (t <= tipT + dropT) {
      const u = (t - tipT) / Math.max(1e-6, dropT);
      a = angle * (0.55 + 0.45 * u);
      x = from[0] + (ex - from[0]) * (0.35 + 0.6 * u); z = from[2] + (ez - from[2]) * (0.35 + 0.6 * u);
      const tt = t - tipT;
      y = Math.max(0, y0 - 0.5 * g * tt * tt);
    } else if (t <= tipT + dropT + bounceT) {
      const tt = t - tipT - dropT;
      y = Math.max(0, Math.sqrt(2 * g * bounceH) * tt - 0.5 * g * tt * tt);
      a = angle;
      x = ex + (from[0] - ex) * 0.05 * (1 - tt / bounceT); z = ez + (from[2] - ez) * 0.05 * (1 - tt / bounceT);
    } else {
      x = ex; z = ez; y = 0; a = angle;
    }
    yaw = (from[3] ?? 0) + (eyaw - (from[3] ?? 0)) * Math.min(1, t / total);
  }
  const done = tSec >= total;
  if (done) { x = ex; z = ez; y = 0; a = angle; yaw = eyaw; }
  return { x, y, z, yaw, angle: a, done };
}

export function fallDuration(from: number[], seed: number): number {
  const rnd = seeded(seed);
  const tipT = 0.32 + rnd() * 0.12;
  const y0 = from[1] ?? 0;
  const dropT = y0 > 0.05 ? Math.sqrt((2 * y0) / 9.81) : 0;
  const bounceH = 0.02 + rnd() * 0.03;
  return tipT + dropT + 2 * Math.sqrt((2 * bounceH) / 9.81) + 0.15;
}

const axis = new THREE.Vector3();
const qYaw = new THREE.Quaternion();
const qTilt = new THREE.Quaternion();
const yAxis = new THREE.Vector3(0, 1, 0);

export class PropMove implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private h: PropHandle | null = null;
  private tried = 0;
  private done = false;
  private soundAt = false;
  private landed = false;
  private seenSent = false;
  private residue: boolean;
  private scale = new THREE.Vector3(1, 1, 1);
  private baseQ = new THREE.Quaternion();

  constructor(env: Env, ev: ParanormalEvent, residue: boolean) {
    this.env = env;
    this.ev = ev;
    this.residue = residue;
  }

  private grab(): boolean {
    if (this.h) return true;
    if (this.tried++ > 120) { this.done = true; return false; }
    const lv = this.env.level();
    const from = (this.ev.data?.from as number[] | undefined) ?? [0, 0, 0, 0];
    const h = lv?.propHandle?.(String(this.ev.ref ?? ''), { key: String(this.ev.data?.key ?? ''), x: from[0], z: from[2] }) ?? null;
    if (!h) return false;
    this.h = h;
    this.scale.copy(h.object.scale);
    // the instance's own orientation without its yaw (props stand upright; keep any modelling rotation)
    this.baseQ.copy(h.object.quaternion);
    const e = new THREE.Euler().setFromQuaternion(this.baseQ, 'YXZ');
    this.baseQ.premultiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -e.y));
    return true;
  }

  private pose(x: number, y: number, z: number, yaw: number, tilt: number, tx: number, tz: number): void {
    const o = this.h!.object;
    qYaw.setFromAxisAngle(yAxis, yaw);
    axis.set(tx, 0, tz);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    axis.normalize();
    qTilt.setFromAxisAngle(axis, tilt);
    o.quaternion.copy(qTilt).multiply(qYaw).multiply(this.baseQ);
    o.position.set(x, y, z);
    o.updateMatrix();
  }

  update(now: number): boolean {
    if (this.done) return false;
    if (now < this.ev.at && !this.residue) return true;
    if (!this.grab()) return !this.done;
    const from = (this.ev.data?.from as number[] | undefined) ?? [0, 0, 0, 0];
    const to = (this.ev.data?.to as number[] | undefined) ?? from;
    const p: [number, number, number] = [from[0], from[1] + 0.3, from[2]];
    const age = (now - this.ev.at) / 1000;
    const subtle = this.env.settings().mode === 'subtle';
    if (this.ev.kind === 'poltergeist') {
      const T = Math.max(0.3, this.ev.ms / 1000);
      // a hard shove that drags to a stop
      const u = this.residue ? 1 : Math.min(1, Math.max(0, age / T));
      const k = 1 - (1 - u) * (1 - u) * (1 - u);
      const x = from[0] + (to[0] - from[0]) * k, z = from[2] + (to[2] - from[2]) * k;
      const yaw = from[3] + (to[3] - from[3]) * k;
      this.pose(x, from[1], z, yaw, 0, 1, 0);
      if (!this.soundAt && !this.residue && age < 0.5) {
        this.soundAt = true;
        this.env.synth('chair_scrape', p, { seed: this.ev.seed, volume: subtle ? 0.35 : 0.6 }, { key: 'sfx.wood_hit', volume: 0.2, rate: 0.7 });
      }
      if (u >= 1) return this.finish();
      return true;
    }
    // object_fall
    const tilt = (this.ev.data?.tilt as number[] | undefined) ?? [1, 0];
    const angle = Number(this.ev.data?.angle ?? Math.PI / 2);
    const fp = fallPose(from, to, angle, this.ev.seed, this.residue ? 1e3 : Math.max(0, age));
    this.pose(fp.x, fp.y, fp.z, fp.yaw, fp.angle, tilt[0], tilt[1]);
    if (!this.landed && fp.y <= 0.001 && age > 0.3) {
      this.landed = true;
      if (!this.residue && age < fallDuration(from, this.ev.seed) + 0.4) {
        this.env.sfx()?.play('sfx.item_drop', [fp.x, 0.1, fp.z], { volume: subtle ? 0.45 : 0.75, occlude: true });
      }
    }
    if (fp.done) return this.finish();
    return true;
  }

  private finish(): boolean {
    if (this.h) {
      const o = this.h.object;
      o.updateMatrix();
      this.h.commit(o.matrix.clone());
    }
    this.h = null;
    this.done = true;
    return false;
  }

  witness(): WitnessSpec | null {
    if (this.seenSent || this.residue || this.done || !this.ev.p) return null;
    const p = this.ev.p;
    return { points: [[p[0], (p[1] ?? 0) + 0.3, p[2]]], maxM: 16 };
  }

  onSeen(): void { this.seenSent = true; }
  end(): void { /* the move finishes on its own clock */ }
  dispose(): void {
    // a level rebuild restores every instance; mid-move we leave it where it is
    if (this.h) { try { this.h.restore(); } catch { /* level gone */ } }
    this.h = null;
    this.done = true;
  }
}
