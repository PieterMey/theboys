// Owner: env-paranormal (v1.2) client. Knocks + handle rattles (synth on the far side, 0.3 m beyond the leaf, plus
// level.rattleDoor; the logical door state never changes), the cold spot (a frost fog volume, frost crackle + low
// wind, frost puffs, your breath shows inside it) and the brownout breath (the room sags, breath clouds; no sound of
// breathing: that is the Listener's retreat cue).
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import type { FogVolume } from '../render/api.ts';
import type { Effect, Env, V3, WitnessSpec } from './env.ts';
import { dist2d, seeded, smooth01 } from './env.ts';

export class Knock implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private started = false;
  private rattled = false;
  private endAt: number;
  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
    this.endAt = ev.at + ev.ms;
  }
  update(now: number): boolean {
    if (now < this.ev.at) return true;
    const p = (this.ev.p ?? [0, 1.2, 0]) as V3;
    const d = this.ev.data ?? {};
    const door = Number(d.door ?? -1);
    const subtle = this.env.settings().mode === 'subtle';
    const amp = Number(d.amp ?? 0.8) * (subtle ? 0.6 : 1);
    const late = now - this.ev.at > 1200;
    if (!this.started) {
      this.started = true;
      if (!late) {
        const pattern = (d.pattern === 'metal' || d.pattern === 'locker' ? d.pattern : 'wood') as 'wood' | 'metal' | 'locker';
        if (this.ev.kind === 'knock') {
          const count = Math.max(1, Math.min(8, Number(d.count ?? 3)));
          this.env.synth('knock', p, { seed: this.ev.seed, pattern, count, volume: amp }, { key: pattern === 'wood' ? 'sfx.wood_hit' : 'sfx.metal_hit', volume: 0.55 * amp });
          if (door >= 0) this.env.level()?.rattleDoor?.(door, Math.min(this.ev.ms, 260 * count), 0.35 * amp);
        } else {
          this.env.synth('handle_rattle', p, { seed: this.ev.seed, count: 3, volume: amp }, { key: 'sfx.metal_latch', volume: 0.5 * amp });
          if (door >= 0) this.env.level()?.rattleDoor?.(door, Math.min(1400, this.ev.ms), 0.9 * amp);
        }
        const cam = this.env.players()?.cameraPos?.();
        if (cam && dist2d(cam, p) < 9) this.env.fear(this.ev.tier >= 1 ? 0.4 : 0.25, 2500);
      }
    }
    // T1 knocks end with the handle trying the door
    if (!this.rattled && this.ev.kind === 'knock' && d.rattle === true && now >= this.ev.at + 260 * Number(d.count ?? 3) + 350) {
      this.rattled = true;
      if (now - this.ev.at < 4000) {
        this.env.synth('handle_rattle', p, { seed: this.ev.seed + 1, count: 2, volume: amp * 0.8 }, { key: 'sfx.metal_latch', volume: 0.4 * amp });
        if (door >= 0) this.env.level()?.rattleDoor?.(door, 900, 0.8 * amp);
      }
    }
    return now < this.endAt + 500;
  }
  end(): void {}
  dispose(): void {}
}

/** every cold spot's fog volume (render.setFogVolumes takes the whole list) */
const volumes = new Map<number, FogVolume>();
let volumesDirty = false;
let volumesSentAt = 0;
export function flushVolumes(env: Env, force = false): void {
  if (!volumesDirty && !force) return;
  const t = performance.now();
  if (!force && t - volumesSentAt < 100) return;
  volumesSentAt = t;
  volumesDirty = false;
  env.render()?.setFogVolumes?.([...volumes.values()]);
}
export function clearVolumes(env: Env): void {
  volumes.clear();
  volumesDirty = false;
  env.render()?.setFogVolumes?.([]);
}

export class ColdSpot implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private sounded = false;
  private puffAt = 0;
  private breathAt = 0;
  private inside = false;
  private seenSent = false;
  private endAt: number;
  private rnd: () => number;
  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
    this.endAt = ev.at + ev.ms;
    this.rnd = seeded(ev.seed);
  }
  update(now: number): boolean {
    if (now < this.ev.at) return true;
    const p = (this.ev.p ?? [0, 0, 0]) as V3;
    const r = Number(this.ev.data?.r ?? 2);
    const age = now - this.ev.at;
    const k = smooth01(age / 2000) * (1 - smooth01((age - (this.ev.ms - 3000)) / 3000));
    if (now > this.endAt) {
      volumes.delete(this.ev.id);
      volumesDirty = true;
      flushVolumes(this.env, true);
      return false;
    }
    const dens = Number(this.ev.data?.density ?? 0.55) * k;
    const prev = volumes.get(this.ev.id);
    if (!prev || Math.abs(prev.density - dens) > 0.01) {
      volumes.set(this.ev.id, { p: [p[0], 0.7, p[2]], r, density: dens, color: '#d6e6f5', frost: Number(this.ev.data?.frost ?? 1) * k, ground: true });
      volumesDirty = true;
    }
    flushVolumes(this.env);
    if (!this.sounded && age < 2500) {
      this.sounded = true;
      this.env.synth('frost', [p[0], 1, p[2]], { seed: this.ev.seed, ms: Math.min(this.ev.ms, 9000), volume: this.env.settings().mode === 'subtle' ? 0.3 : 0.5 });
    }
    const t = performance.now();
    if (t > this.puffAt && k > 0.3) {
      this.puffAt = t + 900 + this.rnd() * 900;
      const a = this.rnd() * Math.PI * 2, d = this.rnd() * r * 0.7;
      this.env.render()?.puff?.([p[0] + Math.sin(a) * d, 0.25 + this.rnd() * 0.9, p[2] + Math.cos(a) * d], 'frost', 0.6 + this.rnd() * 0.4);
    }
    const cam = this.env.players()?.cameraPos?.();
    const inside = !!cam && dist2d(cam, p) < r + 0.3;
    if (inside && !this.inside) this.env.fear(0.25, 2500);
    this.inside = inside;
    if (inside && cam && t > this.breathAt) {
      // your breath shows in the cold (a visual cloud, no sound)
      this.breathAt = t + 1500 + this.rnd() * 600;
      this.env.render()?.puff?.([cam[0], cam[1] - 0.08, cam[2]], 'breath', 0.8);
    }
    return true;
  }
  witness(): WitnessSpec | null {
    if (this.seenSent || !this.ev.p || this.env.serverNow() < this.ev.at + 1500) return null;
    const p = this.ev.p;
    return { points: [[p[0], 0.6, p[2]]], maxM: Number(this.ev.data?.r ?? 2) + 10 };
  }
  onSeen(): void { this.seenSent = true; }
  end(): void { /* fades on its own clock */ }
  dispose(): void {
    if (volumes.delete(this.ev.id)) { volumesDirty = true; flushVolumes(this.env, true); }
  }
}

export class BrownoutBreath implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private started = false;
  private puffs = 0;
  private nextPuff = 0;
  private endAt: number;
  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
    this.endAt = ev.at + ev.ms;
  }
  private inSpace(): boolean {
    const cam = this.env.players()?.cameraPos?.();
    const lv = this.env.level();
    const L = lv?.layout;
    if (!cam || !L) return false;
    const cx = Math.floor(cam[0]), cz = Math.floor(cam[2]);
    if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return false;
    return L.owner[cz * L.W + cx] === this.ev.space;
  }
  update(now: number): boolean {
    if (now < this.ev.at) return true;
    if (!this.started) {
      this.started = true;
      const left = this.endAt - now;
      if (left > 300) this.env.render()?.brownout?.(this.ev.space, left, Number(this.ev.data?.depth ?? 0.55));
      if (this.inSpace() && left > 1000) this.env.fear(0.2, Math.min(4000, left));
    }
    const max = Number(this.ev.data?.puffs ?? 3);
    const t = performance.now();
    if (this.puffs < max && t > this.nextPuff && now < this.endAt && this.inSpace()) {
      this.puffs++;
      this.nextPuff = t + 900;
      const cam = this.env.players()!.cameraPos!();
      this.env.render()?.puff?.([cam[0], cam[1] - 0.08, cam[2]], 'breath', 0.9);
    }
    return now < this.endAt + 300;
  }
  witness(): WitnessSpec | null { return null; }
  end(): void {}
  dispose(): void {}
}
