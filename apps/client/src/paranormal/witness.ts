// Owner: env-paranormal (v1.2) client. Witness reports: an armed effect counts as seen when one of its points is in the
// camera frustum, within maxM (<= 20 m by default), with grid line of sight, for >= 0.25 s continuously. Runs at <= 10 Hz
// and only while something is armed; reports go out as 'paranormal.seen' (the server rate-limits to 10/s and validates).
import * as THREE from 'three/webgpu';
import { los } from '@dead-air/shared/nav/index.ts';
import type { Effect, Env } from './env.ts';

const HZ = 10;

export class WitnessTracker {
  private env: Env;
  private acc = 0;
  private held = new Map<number, number>();
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private cam = new THREE.Vector3();
  /** checks run / reports sent (diag) */
  stats = { checks: 0, reports: 0, why: {} as Record<string, string> };

  constructor(env: Env) {
    this.env = env;
  }

  update(dt: number, effects: Iterable<Effect>): void {
    this.acc += dt;
    if (this.acc < 1 / HZ) return;
    const step = this.acc;
    this.acc = 0;
    const armed: { e: Effect; spec: NonNullable<ReturnType<NonNullable<Effect['witness']>>> }[] = [];
    for (const e of effects) {
      const spec = e.witness?.();
      if (spec && spec.points.length) armed.push({ e, spec });
    }
    if (!armed.length) {
      if (this.held.size) this.held.clear();
      return;
    }
    const t = this.env.three();
    const lv = this.env.level();
    if (!t || this.env.players()?.spectating?.()) return;
    const cam = t.camera;
    cam.updateMatrixWorld();
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    cam.getWorldPosition(this.cam);
    this.stats.checks++;
    const live = new Set<number>();
    for (const { e, spec } of armed) {
      const id = e.ev.id;
      live.add(id);
      let vis = false;
      let why = 'none';
      for (const p of spec.points) {
        this.v.set(p[0], p[1], p[2]);
        if (this.v.distanceTo(this.cam) > spec.maxM) { why = 'far'; continue; }
        if (spec.facing) {
          const f = spec.facing;
          if ((this.cam.x - p[0]) * f[0] + (this.cam.y - p[1]) * f[1] + (this.cam.z - p[2]) * f[2] <= 0) { why = 'behind'; continue; }
        }
        if (!this.frustum.containsPoint(this.v)) { why = 'frustum'; continue; }
        if (lv?.grid && lv.doorOpen && !los(lv.grid, this.cam.x, this.cam.z, p[0], p[2], lv.doorOpen)) { why = 'los'; continue; }
        vis = true;
        why = 'visible';
        break;
      }
      this.stats.why[`${e.ev.kind}:${id}`] = why;
      const h = vis ? (this.held.get(id) ?? 0) + step : 0;
      this.held.set(id, h);
      if (vis && h >= (spec.holdSec ?? 0.25)) {
        this.held.delete(id);
        this.stats.reports++;
        this.env.seen(id, spec.end === true);
        e.onSeen?.();
      }
    }
    for (const id of this.held.keys()) if (!live.has(id)) this.held.delete(id);
  }

  clear(): void {
    this.held.clear();
  }
}
