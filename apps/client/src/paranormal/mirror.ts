// Owner: env-paranormal (v1.2) client. Mirrors (level.mirrorOf(itemId) -> render MirrorHandle; works on fallback glass):
//  - writing: condensation creeps in (setFog -> 0.85 over 4 s from `at`), then on the first witness the server sends
//    'paranormal.reveal' and the letters are drawn stroke by stroke over 2 s from that server time; it stays as
//    residue. Text is only ever a callsign, a roster name or a fixed phrase (server side).
//  - figure (armed for one player): when they look into a live mirror within 5 m, a hunched worker in wet coveralls
//    stands 1.2-1.8 m behind them in handle.ghost (reflections only, no shadow); it is gone when they turn or after
//    1.2 s. Not live (Low preset, flag mirrors off) or subtle mode: fog + a handprint instead.
import * as THREE from 'three/webgpu';
import { PARANORMAL_PHRASES } from '@dead-air/shared/messages/paranormal.ts';
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import { nameBlocked, textBlocked } from '@dead-air/shared/names.ts';
import type { MirrorHandle } from '../render/api.ts';
import type { Effect, Env, V3, WitnessSpec } from './env.ts';
import { seeded, smooth01 } from './env.ts';
import { handprintMask, loadWritingFont, writingMask } from './writing.ts';
import type { WritingMask } from './writing.ts';
import { disposeFigureMesh, figureMesh } from './figure.ts';

/** mirrors carrying our fog / writing (one owner at a time) */
const owners = new Map<string, number>();

function mirrorPos(h: MirrorHandle): THREE.Vector3 {
  return h.ghost.getWorldPosition(new THREE.Vector3());
}
function mirrorNormal(h: MirrorHandle): THREE.Vector3 {
  const q = h.ghost.getWorldQuaternion(new THREE.Quaternion());
  return new THREE.Vector3(0, 0, 1).applyQuaternion(q);
}

export class MirrorWriting implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private handle: MirrorHandle | null = null;
  private mask: WritingMask | null = null;
  private revealAt: number | null = null;
  private lastDraw = -1;
  private seenSent = false;
  private residue: boolean;
  private item: string;
  private gaveUp = false;
  private squeaked = false;

  constructor(env: Env, ev: ParanormalEvent, residue: boolean) {
    this.env = env;
    this.ev = ev;
    this.residue = residue;
    this.item = String(ev.data?.mirror ?? ev.ref ?? '');
    const ra = ev.data?.revealAt;
    if (typeof ra === 'number') this.revealAt = ra;
    void loadWritingFont();
  }

  private grab(now: number): MirrorHandle | null {
    if (this.handle) return this.handle;
    const h = this.env.level()?.mirrorOf?.(this.item) ?? null;
    if (!h) {
      if (now > this.ev.at + 15_000) this.gaveUp = true;
      return null;
    }
    // a handprint (mirror figure on Low / subtle) still owns this glass: wait for it (it releases in ~10 s)
    const other = owners.get(this.item);
    if (other !== undefined && other !== this.ev.id) return null;
    this.handle = h;
    owners.set(this.item, this.ev.id);
    return h;
  }

  reveal(at: number): void {
    this.revealAt = at;
  }

  update(now: number): boolean {
    if (this.gaveUp) return false;
    const h = this.grab(now);
    if (!h) return true;
    if (owners.get(this.item) !== this.ev.id) return true;
    const fog = Number(this.ev.data?.fog ?? 0.85);
    const fogMs = Number(this.ev.data?.fogMs ?? 4000);
    // condensation creeps over the glass (a late join sees it already there)
    h.setFog(fog * smooth01((now - this.ev.at) / fogMs));
    if (this.revealAt !== null) {
      if (!this.mask) {
        const w = Number(this.ev.data?.w ?? 0.8), hh = Number(this.ev.data?.h ?? 1);
        // v1.3 P1d, belt and braces (the server writes only safeMirrorName names): never draw a blocked word, even one an
        // older server sent; a fixed phrase instead (seeded: every client draws the same)
        const raw = String(this.ev.data?.text ?? '');
        const text = raw && (nameBlocked(raw) || textBlocked(raw)) ? PARANORMAL_PHRASES[Math.abs(this.ev.seed) % PARANORMAL_PHRASES.length] : raw;
        this.mask = writingMask(text, w, hh, this.ev.seed);
      }
      const revealMs = Number(this.ev.data?.revealMs ?? 2000);
      const k = smooth01((now - this.revealAt) / revealMs);
      if (now >= this.revealAt) {
        // redraw ~15x over the reveal (cheap canvas, one small upload each)
        const q = k >= 1 ? 1 : Math.floor(k * 15) / 15;
        if (q !== this.lastDraw) {
          this.lastDraw = q;
          this.mask.draw(q);
          h.setWriting(this.mask.tex, 1);
        }
        if (!this.squeaked && now - this.revealAt < 600) {
          this.squeaked = true;
          const p = mirrorPos(h);
          this.env.synth('glass_squeak', [p.x, p.y, p.z], { seed: this.ev.seed, volume: 0.5, count: 3 }, { key: 'sfx.door_creak', volume: 0.12, rate: 2.4 });
          const cam = this.env.players()?.cameraPos?.();
          if (cam && Math.hypot(cam[0] - p.x, cam[2] - p.z) < 10) this.env.fear(0.45, 3500);
        }
      }
    }
    // residue: stays for the contract (cleared by the level rebuild)
    return true;
  }

  witness(): WitnessSpec | null {
    // armed until the first witness reveals it
    if (this.seenSent || this.revealAt !== null) return null;
    if (!this.handle || this.env.serverNow() < this.ev.at) return null;
    // a hair in front of the glass: the glass sits on the wall line, so its own cell may be the wall's far side
    const n = mirrorNormal(this.handle);
    const p = mirrorPos(this.handle).addScaledVector(n, 0.15);
    return { points: [[p.x, p.y, p.z]], maxM: 20, facing: [n.x, n.y, n.z] };
  }

  onSeen(): void { this.seenSent = true; }
  end(): void { /* the writing stays */ }

  dispose(): void {
    if (this.handle && owners.get(this.item) === this.ev.id) {
      try {
        this.handle.setWriting(null);
        this.handle.setFog(0);
      } catch { /* mirror already disposed with the level */ }
      owners.delete(this.item);
    }
    this.mask?.dispose();
  }
}

export class MirrorFigure implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private fig: THREE.Mesh | null = null;
  private figHandle: MirrorHandle | null = null;
  private shownAt = 0;
  /** performance.now() when the current look into a not-(yet)-live mirror began (0 = not looking) */
  private lookSince = 0;
  private done = false;
  private endAt: number;
  /** Low / subtle: fog + handprint on this mirror */
  private print: { h: MirrorHandle; item: string; tex: THREE.Texture; t0: number } | null = null;

  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
    this.endAt = ev.at + ev.ms;
  }

  /** the mirror the local camera looks into (within nearM, facing its front, centred in view) */
  private lookedAt(): { h: MirrorHandle; item: string; cam: THREE.Camera } | null {
    const t = this.env.three();
    const lv = this.env.level();
    if (!t || !lv?.mirrorOf) return null;
    const cam = t.camera;
    const cp = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const near = Number(this.ev.data?.nearM ?? 5);
    for (const item of (this.ev.data?.mirrors as string[] | undefined) ?? []) {
      const h = lv.mirrorOf(item);
      if (!h) continue;
      const mp = mirrorPos(h);
      const to = mp.clone().sub(cp);
      const d = to.length();
      if (d > near || d < 0.3) continue;
      // in front of the glass and looking into it
      if (mirrorNormal(h).dot(to) >= 0) continue;
      if (fwd.dot(to.normalize()) < Math.cos((32 * Math.PI) / 180)) continue;
      return { h, item, cam };
    }
    return null;
  }

  update(now: number): boolean {
    if (this.done) return false;
    if (now < this.ev.at) return true;
    if (this.print) return this.updatePrint(now);
    if (this.fig) {
      // gone when they turn away or after holdMs
      const hold = Number(this.ev.data?.holdMs ?? 1200);
      const still = this.lookedAtHandle(this.figHandle);
      if (!still || performance.now() - this.shownAt > hold) this.vanish();
      return true;
    }
    if (now > this.endAt) return false;
    const look = this.lookedAt();
    if (!look) { this.lookSince = 0; return true; }
    const subtle = this.env.settings().mode === 'subtle';
    if (look.h.live() && !subtle) { this.show(look.h, look.cam); return true; }
    // render picks its live mirrors in its own update: give it a moment before falling back to the handprint
    const t = performance.now();
    if (!subtle && (this.lookSince === 0 || t - this.lookSince < 300)) {
      if (this.lookSince === 0) this.lookSince = t;
      return true;
    }
    if (owners.has(look.item)) return true; // a writing owns this glass
    this.startPrint(look.h, look.item, now);
    return true;
  }

  private lookedAtHandle(h: MirrorHandle | null): boolean {
    if (!h) return false;
    const t = this.env.three();
    if (!t) return false;
    const cp = t.camera.getWorldPosition(new THREE.Vector3());
    const fwd = t.camera.getWorldDirection(new THREE.Vector3());
    const to = mirrorPos(h).sub(cp).normalize();
    return fwd.dot(to) > Math.cos((50 * Math.PI) / 180);
  }

  private show(h: MirrorHandle, cam: THREE.Camera): void {
    const rnd = seeded(this.ev.seed);
    const fig = figureMesh('wet', Math.floor(rnd() * 3), (m) => this.env.log(m));
    const cp = cam.getWorldPosition(new THREE.Vector3());
    const mp = mirrorPos(h);
    // straight behind the viewer, as seen from the glass
    const away = new THREE.Vector3(cp.x - mp.x, 0, cp.z - mp.z);
    if (away.lengthSq() < 1e-6) away.copy(mirrorNormal(h)).setY(0);
    away.normalize();
    const side = new THREE.Vector3(away.z, 0, -away.x);
    const behind = Number(this.ev.data?.behind ?? 1.5);
    const lat = Number(this.ev.data?.side ?? 0);
    const world = new THREE.Vector3(cp.x, 0, cp.z).addScaledVector(away, behind).addScaledVector(side, lat);
    // facing the viewer's back (toward the glass)
    const yaw = Math.atan2(-away.x, -away.z);
    const wq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    h.ghost.updateWorldMatrix(true, false);
    const inv = h.ghost.getWorldQuaternion(new THREE.Quaternion()).invert();
    fig.position.copy(h.ghost.worldToLocal(world.clone()));
    fig.quaternion.copy(inv.multiply(wq));
    h.ghost.add(fig);
    this.fig = fig;
    this.figHandle = h;
    this.shownAt = performance.now();
  }

  private vanish(): void {
    if (this.fig) disposeFigureMesh(this.fig);
    this.fig = null;
    this.done = true;
    // it was right behind you: heartbeat after it is gone
    this.env.fear(this.env.settings().mode === 'subtle' ? 0.35 : 0.7, 4000);
    this.env.seen(this.ev.id, true);
  }

  private startPrint(h: MirrorHandle, item: string, now: number): void {
    const w = 0.8, hh = 1;
    const tex = handprintMask(w, hh, this.ev.seed);
    owners.set(item, this.ev.id);
    this.print = { h, item, tex, t0: now };
    const p = mirrorPos(h);
    this.env.synth('glass_creak', [p.x, p.y, p.z], { seed: this.ev.seed, volume: 0.45 }, { key: 'sfx.door_creak', volume: 0.1, rate: 1.8 });
    this.env.fear(0.4, 3000);
    this.env.seen(this.ev.id, true);
  }

  private updatePrint(now: number): boolean {
    const pr = this.print!;
    const t = (now - pr.t0) / 1000;
    // fog breathes onto the glass, the hand presses from the other side, then it all fades
    const fog = 0.7 * smooth01(t / 0.8) * (1 - smooth01((t - 6) / 4));
    const hand = smooth01((t - 0.5) / 0.6) * (1 - smooth01((t - 5) / 4));
    try {
      pr.h.setFog(fog);
      pr.h.setWriting(pr.tex, hand);
    } catch { /* level rebuilt */ }
    if (t > 10.5) {
      this.releasePrint();
      return false;
    }
    return true;
  }

  private releasePrint(): void {
    const pr = this.print;
    if (!pr) return;
    if (owners.get(pr.item) === this.ev.id) {
      try {
        pr.h.setWriting(null);
        pr.h.setFog(0);
      } catch { /* gone */ }
      owners.delete(pr.item);
    }
    pr.tex.dispose();
    this.print = null;
    this.done = true;
  }

  end(): void {
    if (this.fig) {
      disposeFigureMesh(this.fig);
      this.fig = null;
    }
    if (!this.print) this.done = true;
  }

  dispose(): void {
    if (this.fig) disposeFigureMesh(this.fig);
    this.fig = null;
    this.releasePrint();
  }
}

export type { V3 };
