// Owner: env-paranormal (v1.2) client.
//  - presence: an invisible humanoid on the phantom layer (drawn only by shadow cameras): you see it as a shadow in a
//    beam, 4-9 m ahead in the dark. It ends when a beam holds it within 14 m for 0.4 s (or you walk up to it); T2 makes
//    the local beam stutter (beamInterference('local', 300, 0.6)) as it goes.
//  - silhouette: a pitch-dark figure at the far end of a corridor, backlit by that end's light (the corridor's own end
//    fixture or the lit space through the opening behind it); once looked at (or approached) it is gone and that
//    backlit space (data.room) browns out.
import * as THREE from 'three/webgpu';
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import { los } from '@dead-air/shared/nav/index.ts';
import type { Effect, Env, V3, WitnessSpec } from './env.ts';
import { dist2d } from './env.ts';
import { disposeFigureMesh, figureMesh } from './figure.ts';

const tmpA = new THREE.Vector3();

export class Presence implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private mesh: THREE.Mesh | null = null;
  private litFor = 0;
  private gone = false;
  private reported = false;
  private endAt: number;

  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
    this.endAt = ev.at + ev.ms;
  }

  private spawn(): void {
    const t = this.env.three();
    if (!t) return;
    const m = figureMesh('phantom', Number(this.ev.data?.variant ?? 0), (s) => this.env.log(s));
    const p = this.ev.p ?? [0, 0, 0];
    m.position.set(p[0], 0, p[2]);
    m.rotation.y = this.ev.yaw ?? 0;
    m.updateMatrixWorld(true);
    const lv = this.env.level();
    const grp = lv?.spaceGroup?.(this.ev.space) ?? null;
    (grp ?? t.scene).add(m);
    this.mesh = m;
  }

  /** the local beam holds it: within litM, inside the cone, line of sight */
  private litByMe(): boolean {
    const r = this.env.render();
    const beams = r?.beams?.() ?? [];
    const b = beams.find((x) => x.local && x.intensity > 0.05);
    if (!b || !this.ev.p) return false;
    const litM = Number(this.ev.data?.litM ?? 14);
    const p = this.ev.p;
    // test the chest, not the feet
    tmpA.set(p[0] - b.pos[0], 1.1 - b.pos[1], p[2] - b.pos[2]);
    const d = tmpA.length();
    if (d > Math.min(litM, b.range || litM)) return false;
    tmpA.divideScalar(d || 1);
    const cos = tmpA.x * b.dir[0] + tmpA.y * b.dir[1] + tmpA.z * b.dir[2];
    if (cos < Math.cos(Math.max(0.15, b.angle) * 0.9)) return false;
    const lv = this.env.level();
    if (lv?.grid && lv.doorOpen && !los(lv.grid, b.pos[0], b.pos[2], p[0], p[2], lv.doorOpen)) return false;
    return true;
  }

  update(now: number, dt: number): boolean {
    if (this.gone) return false;
    if (now < this.ev.at) return true;
    if (!this.mesh) this.spawn();
    if (now > this.endAt) { this.vanish(false); return false; }
    // local end conditions (the server checks every beam + approach as well; whichever comes first)
    const cam = this.env.players()?.cameraPos?.();
    const appr = Number(this.ev.data?.approachM ?? 7);
    if (cam && this.ev.p && dist2d(cam, this.ev.p) < appr) {
      this.report();
      this.vanish(false);
      return false;
    }
    if (this.litByMe()) {
      this.litFor += dt;
      if (this.litFor * 1000 >= Number(this.ev.data?.litMs ?? 400)) {
        this.report();
        this.vanish(true);
        return false;
      }
    } else this.litFor = Math.max(0, this.litFor - dt * 2);
    return true;
  }

  private report(): void {
    if (this.reported) return;
    this.reported = true;
    this.env.seen(this.ev.id, true);
  }

  private vanish(lit: boolean): void {
    if (this.gone) return;
    this.gone = true;
    if (this.mesh) disposeFigureMesh(this.mesh);
    this.mesh = null;
    if (lit) {
      this.env.fear(0.5, 3500);
      if (this.ev.data?.interf === true && !this.env.reduceFlicker() && this.env.settings().mode !== 'subtle') this.env.render()?.beamInterference?.('local', 300, 0.6);
    }
  }

  end(reason: string): void {
    // someone else's beam (or the server's own check) ended it
    this.vanish(reason === 'lit' && this.litFor > 0.15);
  }

  witness(): WitnessSpec | null { return null; }
  dispose(): void { this.vanish(false); }
}

export class Silhouette implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private mesh: THREE.Mesh | null = null;
  private gone = false;
  private seenSent = false;
  private endAt: number;

  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
    this.endAt = ev.at + ev.ms;
  }

  private spawn(): void {
    const t = this.env.three();
    if (!t) return;
    const m = figureMesh('dark', 1, (s) => this.env.log(s));
    const p = this.ev.p ?? [0, 0, 0];
    m.position.set(p[0], 0, p[2]);
    m.rotation.y = this.ev.yaw ?? 0;
    m.updateMatrixWorld(true);
    const grp = this.env.level()?.spaceGroup?.(this.ev.space) ?? null;
    (grp ?? t.scene).add(m);
    this.mesh = m;
  }

  update(now: number): boolean {
    if (this.gone) return false;
    if (now < this.ev.at) return true;
    if (!this.mesh) this.spawn();
    if (now > this.endAt) { this.vanish(); return false; }
    const cam = this.env.players()?.cameraPos?.();
    if (cam && this.ev.p && dist2d(cam, this.ev.p) < Number(this.ev.data?.approachM ?? 7)) {
      if (!this.seenSent) { this.seenSent = true; this.env.seen(this.ev.id, true); }
      this.vanish();
      return false;
    }
    return true;
  }

  private vanish(): void {
    if (this.gone) return;
    this.gone = true;
    if (this.mesh) disposeFigureMesh(this.mesh);
    this.mesh = null;
    // that room browns out as it goes (a smooth sag, never a strobe)
    const room = Number(this.ev.data?.room ?? this.ev.space);
    this.env.render()?.brownout?.(room, Number(this.ev.data?.brownMs ?? 1800), Number(this.ev.data?.depth ?? 0.7));
  }

  witness(): WitnessSpec | null {
    if (this.seenSent || !this.mesh || !this.ev.p) return null;
    const p = this.ev.p;
    // looked at for 0.6 s: report with end (the server ends it for everyone)
    return { points: [[p[0], 1.55, p[2]], [p[0], 0.9, p[2]]], maxM: 24, end: true, holdSec: Number(this.ev.data?.holdMs ?? 600) / 1000 };
  }

  onSeen(): void {
    this.seenSent = true;
    this.env.fear(0.45, 3000);
    this.vanish();
  }

  end(): void { this.vanish(); }
  dispose(): void {
    if (this.mesh) disposeFigureMesh(this.mesh);
    this.mesh = null;
    this.gone = true;
  }
}

export type { V3 };
