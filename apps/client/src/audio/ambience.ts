// Owner: env-audio (v1.2; was track ④ Voice/audio). Procedural ambience (no assets) on the shared graph (ambBus):
// the low tension drone, the heartbeat (fear 0..1: the maximum over sfx.fear sources, fear.ts) and the radio static
// generator with its crackle. The fixture hums moved to hums.ts (power-aware), the theme beds to beds.ts.
import type { AudioGraph, V3 } from './graph.ts';
import { crackleRng, crackleStep } from './crackle.ts';

/** a fixture as the level service lists it (kept for older callers; hums.ts has the v1.2 shape) */
export interface FixtureLike { space: number; pos: V3; state: 'on' | 'off' | 'flicker' | 'broken'; kind?: string }

export class Ambience {
  private g: AudioGraph;
  private droneGain: GainNode;
  private droneLp: BiquadFilterNode;
  private droneOn = false;
  private hbGain: GainNode;
  private fear = 0;
  private nextBeat = 0;
  private staticGain: GainNode;
  private crackleGain: GainNode;
  /** audio time of the next scheduled static pop, and whether pops are being scheduled */
  private nextCrackle = 0;
  private crackling = false;
  private crackleRnd = crackleRng();

  constructor(g: AudioGraph) {
    this.g = g;
    const ac = g.ac;
    // drone: detuned low saws + sub sine through a slowly moving lowpass
    this.droneGain = ac.createGain();
    this.droneGain.gain.value = 0;
    this.droneLp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 220, Q: 2.5 });
    this.droneLp.connect(this.droneGain).connect(g.ambBus);
    for (const [f, type, lvl] of [[41.2, 'sawtooth', 0.18], [41.5, 'sawtooth', 0.18], [61.7, 'triangle', 0.1], [27.5, 'sine', 0.35]] as const) {
      const o = new OscillatorNode(ac, { type, frequency: f });
      const og = new GainNode(ac, { gain: lvl });
      o.connect(og).connect(this.droneLp);
      o.start();
    }
    const lfo = new OscillatorNode(ac, { type: 'sine', frequency: 0.05 });
    const lfoG = new GainNode(ac, { gain: 90 });
    lfo.connect(lfoG).connect(this.droneLp.frequency);
    lfo.start();
    // heartbeat bus
    this.hbGain = ac.createGain();
    this.hbGain.gain.value = 0.9;
    this.hbGain.connect(g.ambBus);
    // radio static: bandpassed noise + crackle
    this.staticGain = ac.createGain();
    this.staticGain.gain.value = 0;
    const n = ac.createBufferSource();
    n.buffer = g.noise;
    n.loop = true;
    const bp = new BiquadFilterNode(ac, { type: 'bandpass', frequency: 1800, Q: 0.5 });
    n.connect(bp).connect(this.staticGain).connect(g.ambBus);
    this.crackleGain = ac.createGain();
    this.crackleGain.gain.value = 0;
    const hp = new BiquadFilterNode(ac, { type: 'highpass', frequency: 3000 });
    n.connect(hp).connect(this.crackleGain).connect(g.ambBus);
    n.start();
  }

  setDrone(on: boolean, level = 0.22): void {
    this.droneOn = on;
    this.droneGain.gain.setTargetAtTime(on ? level : 0, this.g.ac.currentTime, 1.5);
  }
  drone(): boolean { return this.droneOn; }

  /** heartbeat drive 0..1 (index.ts feeds the smoothed maximum over the fear sources) */
  setFear(v: number): void { this.fear = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
  fearLevel(): number { return this.fear; }

  /** radio static level 0..1 (e.g. near the Listener / dead air) */
  setStatic(v: number): void {
    const t = this.g.ac.currentTime;
    this.staticGain.gain.setTargetAtTime((Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0) * 0.08, t, 0.08);
  }

  private beat(at: number, strength: number): void {
    const ac = this.g.ac;
    for (const [dt, f, a] of [[0, 58, 1], [0.16, 50, 0.7]] as const) {
      const o = new OscillatorNode(ac, { type: 'sine', frequency: f * 1.6 });
      const eg = new GainNode(ac, { gain: 0 });
      o.connect(eg).connect(this.hbGain);
      const t = at + dt;
      o.frequency.setValueAtTime(f * 1.6, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.09);
      eg.gain.setValueAtTime(0, t);
      eg.gain.linearRampToValueAtTime(0.5 * a * strength, t + 0.012);
      eg.gain.exponentialRampToValueAtTime(0.0005, t + 0.22);
      o.start(t);
      o.stop(t + 0.25);
      o.onended = () => { try { eg.disconnect(); } catch { /* ignore */ } };
    }
  }

  /** called ~25 Hz: heartbeat + crackle scheduling on the audio clock */
  update(): void {
    const ac = this.g.ac;
    const now = ac.currentTime;
    // heartbeat scheduler (look-ahead)
    if (this.fear > 0.05) {
      const bpm = 62 + this.fear * 88;
      if (this.nextBeat < now) this.nextBeat = now + 0.05;
      while (this.nextBeat < now + 0.15) {
        this.beat(this.nextBeat, 0.25 + this.fear * 0.75);
        this.nextBeat += 60 / bpm;
      }
    }
    // crackle pops while static is up: irregular, density follows the static level (crackle.ts), scheduled on the
    // audio clock ~120 ms ahead so the rhythm doesn't depend on this update's rate
    const st = this.staticGain.gain.value;
    if (st > 0.005) {
      const level = st / 0.08;
      if (!this.crackling || this.nextCrackle < now) this.nextCrackle = now + crackleStep(level, this.crackleRnd).wait;
      this.crackling = true;
      while (this.nextCrackle < now + 0.12) {
        const pop = crackleStep(level, this.crackleRnd);
        const t0 = this.nextCrackle;
        this.crackleGain.gain.setValueAtTime(st * 2.5 * pop.amp, t0);
        this.crackleGain.gain.setTargetAtTime(0, t0 + pop.dur, 0.004);
        this.nextCrackle = t0 + pop.wait;
      }
    } else if (this.crackling) {
      this.crackling = false;
      this.crackleGain.gain.cancelScheduledValues(now);
      this.crackleGain.gain.setTargetAtTime(0, now, 0.02);
    }
  }
}
