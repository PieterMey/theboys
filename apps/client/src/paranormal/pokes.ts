// Owner: env-paranormal (v1.3 F4 dead pokes) client. The flicker a dead player sends to the room they watch: every
// glowing fixture of that room pulses twice (render.fixtureCurve 'pulse', 2.4 s, staggered 40 ms; one slow 'brown' sag
// with reduce flicker), with a relay tink at the first fixture. It never changes a light's state (the server's lights
// stay as they are). The knock poke renders as a Knock (ambient.ts): the living cannot tell a friend from the building.
import type { ParanormalEvent } from '@dead-air/shared/messages/paranormal.ts';
import type { Effect, Env } from './env.ts';

export class PokeFlicker implements Effect {
  readonly ev: ParanormalEvent;
  private env: Env;
  private started = false;
  private endAt: number;
  constructor(env: Env, ev: ParanormalEvent) {
    this.env = env;
    this.ev = ev;
    this.endAt = ev.at + Math.max(600, ev.ms);
  }

  /** the local camera stands in the flickering room */
  private inRoom(): boolean {
    const cam = this.env.players()?.cameraPos?.();
    const L = this.env.level()?.layout;
    if (!cam || !L) return false;
    const cx = Math.floor(cam[0]), cz = Math.floor(cam[2]);
    if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return false;
    return L.owner[cz * L.W + cx] === this.ev.space;
  }

  update(now: number): boolean {
    if (this.started) return now < this.endAt + 300;
    if (now < this.ev.at) return true;
    const lv = this.env.level();
    if (!lv || !lv.fixtures.length) return now < this.endAt + 3000;
    this.started = true;
    // a late join / reconnect: the flicker is already over
    if (now - this.ev.at > 1500) return false;
    const ids = (this.ev.data?.lights as string[] | undefined) ?? [];
    const idx = ids.map((id) => this.env.fixtureIndex(id)).filter((i) => i >= 0);
    if (!idx.length) return false;
    const reduce = this.env.reduceFlicker();
    this.env.render()?.fixtureCurve?.(idx, reduce ? 'brown' : 'pulse', this.env.local(this.ev.at), reduce ? 0 : 40);
    const subtle = this.env.settings().mode === 'subtle';
    this.env.synth('relay_tink', lv.fixtures[idx[0]].pos, { seed: this.ev.seed, volume: subtle ? 0.25 : 0.4, rate: 0.85 }, { key: 'sfx.switch_click', volume: 0.25 });
    if (!this.env.players()?.spectating?.() && this.inRoom()) this.env.fear(0.15, 2000);
    return true;
  }

  end(): void {}
  dispose(): void { /* the curve belongs to render and recovers by itself */ }
}
