// Owner: env-paranormal (v1.2) client. The dark walk: every fixture of each space it enters dies in sequence
// (render.fixtureCurve 'die', one fixture every stepMs from the server time `at`), each with a relay tink and a
// filament pop; the hum stutters with the fixture levels (audio follows render.fixtureLevels). The server turns each
// space's lights off when its last fixture dies; 'revive' brings fixtures back (ignition curve). Late events fast-
// forward (a curve that started in the past finishes at once); residue (data.dead) shows dead spaces after a reconnect.
// Reduce flicker: slow brownout fades per space instead of the per-fixture curve.
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import type { Effect, Env, V3, WitnessSpec } from './env.ts';
import { dist2d } from './env.ts';

interface Step { idx: number; pos: V3 | null; at: number; space: number; popped: boolean; ticked: boolean }

export class DarkWalk implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private steps: Step[] = [];
  private applied = false;
  private levelVer = -1;
  private residue: boolean;
  private seenSent = false;
  private interfDone = false;
  private feared = false;
  private endAt: number;

  constructor(env: Env, ev: ParanormalEvent, residue: boolean) {
    this.env = env;
    this.ev = ev;
    this.residue = residue;
    this.endAt = ev.at + ev.ms;
  }

  /** (re)map fixture ids to indices for the current level build */
  private map(): boolean {
    const lv = this.env.level();
    if (!lv || !lv.fixtures.length) return false;
    if (this.levelVer === lv.version && this.steps.length) return true;
    this.levelVer = lv.version;
    const ids = (this.ev.data?.lights as string[] | undefined) ?? [];
    const step = Number(this.ev.data?.stepMs ?? 450);
    this.steps = ids.map((id, k) => {
      const idx = this.env.fixtureIndex(id);
      const f = idx >= 0 ? lv.fixtures[idx] : null;
      return { idx, pos: f ? f.pos : null, at: this.ev.at + k * step, space: f?.space ?? -1, popped: false, ticked: false };
    });
    this.applied = false;
    return true;
  }

  private apply(now: number): void {
    const r = this.env.render();
    if (!r) return;
    const dead = new Set((this.ev.data?.dead as number[] | undefined) ?? []);
    if (this.residue) {
      // reconnect / late join: spaces still dark are dead at once; the rest already came back
      const idx = this.steps.filter((s) => s.idx >= 0 && dead.has(s.space)).map((s) => s.idx);
      if (idx.length) r.fixtureCurve?.(idx, 'die', this.env.local(now) - 10_000, 0);
      for (const s of this.steps) { s.popped = true; s.ticked = true; }
      return;
    }
    if (this.env.reduceFlicker()) {
      // slow fades only: one smooth brownout per space up to its kill time, then the server's switch-off
      const spaces = (this.ev.data?.spaces as number[] | undefined) ?? [];
      const killAt = (this.ev.data?.killAt as number[] | undefined) ?? [];
      spaces.forEach((sp, i) => {
        const first = this.steps.find((s) => s.space === sp);
        const t0 = first ? first.at : this.ev.at;
        const dur = Math.max(400, this.ev.at + (killAt[i] ?? 0) - t0 + 300);
        const startIn = this.env.local(t0) - performance.now();
        if (startIn <= 0) r.brownout?.(sp, Math.max(200, dur + startIn), 0.85);
        else setTimeout(() => r.brownout?.(sp, dur, 0.85), startIn);
      });
      for (const s of this.steps) s.popped = true;
      return;
    }
    // one curve per fixture at its own server-timed start, so a missing fixture never shifts the rest
    for (const s of this.steps) if (s.idx >= 0) r.fixtureCurve?.([s.idx], 'die', this.env.local(s.at), 0);
  }

  update(now: number): boolean {
    if (!this.map()) return now < this.endAt + 5000;
    if (!this.applied) {
      this.apply(now);
      this.applied = true;
    }
    if (this.residue) return false;
    const subtle = this.env.settings().mode === 'subtle';
    const cam = this.env.players()?.cameraPos?.() ?? null;
    for (let k = 0; k < this.steps.length; k++) {
      const s = this.steps[k];
      if (!s.pos) continue;
      // relay tink as the tube gives up, filament pop as it goes out (skip the backlog of a late join)
      if (!s.ticked && now >= s.at) {
        s.ticked = true;
        if (now - s.at < 400 && k % 2 === 0) this.env.synth('relay_tink', s.pos, { seed: this.ev.seed + k, volume: subtle ? 0.25 : 0.4 }, { key: 'sfx.metal_click', volume: 0.25, rate: 1.6 });
      }
      if (!s.popped && now >= s.at + 380) {
        s.popped = true;
        if (now - s.at < 900 && (!subtle || k % 3 === 0)) this.env.synth('filament_pop', s.pos, { seed: this.ev.seed * 7 + k, volume: subtle ? 0.35 : 0.6 }, { key: 'sfx.glass_break', volume: 0.08, rate: 2.2 });
        // the darkness reached the local player: heartbeat
        if (!this.feared && cam && dist2d(cam, s.pos) < 6) {
          this.feared = true;
          this.env.fear(0.55, 4500);
        }
      }
    }
    // T2: when it reaches its target, their own beam stutters
    if (!this.interfDone && this.ev.data?.interf === true && now >= this.endAt - 300) {
      this.interfDone = true;
      if (this.ev.data?.target === this.env.me() && !this.env.reduceFlicker() && this.env.settings().mode !== 'subtle') this.env.render()?.beamInterference?.('local', 650, 0.7);
    }
    return now < this.endAt + 1500;
  }

  witness(): WitnessSpec | null {
    if (this.seenSent || this.residue) return null;
    const now = this.env.serverNow();
    // fixtures that are dying or just died
    const pts = this.steps.filter((s) => s.pos && now >= s.at - 100 && now <= s.at + 2500).map((s) => s.pos!) ;
    return pts.length ? { points: pts.slice(0, 8), maxM: 20 } : null;
  }

  onSeen(): void { this.seenSent = true; }
  end(): void { /* the server turns the spaces off; nothing to undo */ }
  dispose(): void { /* curves belong to render; a level rebuild resets them */ }
}

/** 'revive': the fixtures of one space come back with an ignition curve */
export class Revive implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private done = false;
  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
  }
  update(now: number): boolean {
    if (this.done) return false;
    const lv = this.env.level();
    if (!lv || !lv.fixtures.length) return now < this.ev.at + 5000;
    const ids = (this.ev.data?.lights as string[] | undefined) ?? [];
    const idx = ids.map((id) => this.env.fixtureIndex(id)).filter((i) => i >= 0);
    if (idx.length) this.env.render()?.fixtureCurve?.(idx, 'revive', this.env.local(this.ev.at), this.env.reduceFlicker() ? 0 : 60);
    const f = idx.length ? lv.fixtures[idx[0]] : null;
    if (f && now - this.ev.at < 1500) this.env.synth('relay_tink', f.pos, { seed: this.ev.seed, volume: 0.35, rate: 0.8 }, { key: 'sfx.switch_click', volume: 0.3 });
    this.done = true;
    return false;
  }
  end(): void {}
  dispose(): void {}
}
