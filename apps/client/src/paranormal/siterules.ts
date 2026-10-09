// Owner: env-paranormal (v1.3 F7 Site Rules v0) client. Renders the building's answers ('paranormal.rule', flag
// siteRules on the server), with the existing synth sounds only:
//  - bell_digits: the bell's yoke groans (wind-up), then one deep strike (clock_chime, pitched down, heard ~45 m through
//    the walls) every everyMs from the server time `at`, a little dust shaken loose with each strike
//  - phone_callsign: the exchange relay clicks over (wind-up), then the room's dead phone rings (phone_bell, ringMs long)
//    `rings` times every everyMs
// Late events skip what is already over. No text, no meshes, never a light change.
import type { SiteRuleEvent } from '@dead-air/shared/messages/paranormal.ts';
import type { Env, V3 } from './env.ts';
import { dist2d, seeded } from './env.ts';

/** how long before the first strike / ring the wind-up starts (ms) */
const WIND_UP_MS = 700;

export class SiteRuleSound {
  readonly ev: SiteRuleEvent;
  private env: Env;
  private next = 0;
  private wound = false;
  private count: number;
  private every: number;
  private endAt: number;
  private rnd: () => number;

  constructor(env: Env, ev: SiteRuleEvent) {
    this.env = env;
    this.ev = ev;
    const d = ev.data ?? {};
    const bell = ev.rule === 'bell_digits';
    this.count = Math.max(1, Math.min(12, Math.round(Number(bell ? d.strikes : d.rings)) || 1));
    this.every = Math.max(300, Number(d.everyMs) || (bell ? 2200 : 4000));
    this.endAt = ev.at + (this.count - 1) * this.every + (bell ? 4500 : Number(d.ringMs ?? 2000) + 500);
    this.rnd = seeded(ev.seed);
  }

  update(now: number): boolean {
    const p = (Array.isArray(this.ev.p) ? this.ev.p : [0, 1.3, 0]) as V3;
    const subtle = this.env.settings().mode === 'subtle';
    const bell = this.ev.rule === 'bell_digits';
    if (!this.wound && now >= this.ev.at - WIND_UP_MS) {
      this.wound = true;
      if (now < this.ev.at) {
        if (bell) this.env.synth('pipe_groan', p, { seed: this.ev.seed, ms: 900, volume: subtle ? 0.35 : 0.55, radius: 30 });
        else this.env.synth('relay_tink', p, { seed: this.ev.seed, volume: 0.5, rate: 0.7, radius: 16 }, { key: 'sfx.switch_click', volume: 0.3 });
      }
    }
    while (this.next < this.count) {
      const t = this.ev.at + this.next * this.every;
      if (now < t) break;
      if (now - t <= 600) this.fire(this.next, p, subtle, bell);
      this.next++;
    }
    return now < this.endAt;
  }

  private fire(i: number, p: V3, subtle: boolean, bell: boolean): void {
    const cam = this.env.players()?.cameraPos?.() ?? null;
    if (bell) {
      this.env.synth('clock_chime', p, { seed: this.ev.seed + i * 7919, count: 1, rate: 0.55, volume: subtle ? 0.7 : 1, radius: 45 });
      this.env.render()?.puff?.([p[0] + (this.rnd() - 0.5) * 0.6, Math.max(0.6, p[1] - 0.25), p[2] + (this.rnd() - 0.5) * 0.6], 'dust', 0.45);
      if (i === 0 && cam && dist2d(cam, p) < 14) this.env.fear(0.3, 2500);
    } else {
      this.env.synth('phone_bell', p, { seed: this.ev.seed + i, ms: Math.max(300, Number(this.ev.data?.ringMs ?? 2000)), volume: subtle ? 0.6 : 0.85, radius: 28 });
      if (i === 0 && cam && dist2d(cam, p) < 10) this.env.fear(0.25, 2500);
    }
  }

  dispose(): void { /* one-shot synth sounds end on their own */ }
}
