// Owner: track ④ Voice/audio. Procedural ambience (no assets): low tension drone, fluorescent hum per nearby
// fixture (follows 'flicker' / 'off' / 'broken' fixture states and bus 'audio:flicker'), heartbeat (setFear 0..1),
// radio static generator. All synthesized on the shared graph (ambBus).
import type { AudioGraph, V3 } from './graph.ts';
import { setPannerPos } from './graph.ts';
import { crackleRng, crackleStep } from './crackle.ts';

export interface FixtureLike { space: number; pos: V3; state: 'on' | 'off' | 'flicker' | 'broken' }

interface Hum { osc: OscillatorNode[]; g: GainNode; panner: PannerNode; fx: FixtureLike; flickerUntil: number }

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
  private hums = new Map<string, Hum>();
  private humBus: GainNode;
  private flickers = new Map<number, number>();

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
    this.humBus = ac.createGain();
    this.humBus.gain.value = 0.5;
    this.humBus.connect(g.ambBus);
  }

  setDrone(on: boolean, level = 0.22): void {
    this.droneOn = on;
    this.droneGain.gain.setTargetAtTime(on ? level : 0, this.g.ac.currentTime, 1.5);
  }
  drone(): boolean { return this.droneOn; }

  setFear(v: number): void { this.fear = Math.max(0, Math.min(1, v)); }

  /** radio static level 0..1 (e.g. near the Listener / dead air) */
  setStatic(v: number): void {
    const t = this.g.ac.currentTime;
    this.staticGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)) * 0.08, t, 0.08);
  }

  flicker(space: number, ms: number): void {
    this.flickers.set(space, performance.now() + ms);
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
    }
  }

  /** called ~20-30 Hz with the listener position and nearby fixtures */
  update(listener: V3 | null, fixtures: readonly FixtureLike[] | null): void {
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
    // fluorescent hums: the 6 nearest lit fixtures within 12 m
    if (!listener || !fixtures) return;
    const near = fixtures
      .map((f, i) => ({ f, i, d: Math.hypot(f.pos[0] - listener[0], f.pos[2] - listener[2]) }))
      .filter((x) => x.d < 12 && x.f.state !== 'off' && x.f.state !== 'broken')
      .sort((a, b) => a.d - b.d)
      .slice(0, 6);
    const keep = new Set<string>();
    for (const { f, i } of near) {
      const key = `${i}:${f.pos[0].toFixed(1)},${f.pos[2].toFixed(1)}`;
      keep.add(key);
      let h = this.hums.get(key);
      if (!h) {
        const g = new GainNode(ac, { gain: 0 });
        const panner = new PannerNode(ac, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, maxDistance: 12, rolloffFactor: 1.5, positionX: f.pos[0], positionY: f.pos[1], positionZ: f.pos[2] });
        const osc = [100, 200, 300, 120].map((fr, j) => {
          const o = new OscillatorNode(ac, { type: j === 0 ? 'sawtooth' : 'sine', frequency: fr + (i % 3) * 0.3 });
          const og = new GainNode(ac, { gain: [0.02, 0.012, 0.006, 0.008][j] });
          o.connect(og).connect(g);
          o.start();
          return o;
        });
        g.connect(panner).connect(this.humBus);
        h = { osc, g, panner, fx: f, flickerUntil: 0 };
        this.hums.set(key, h);
      }
      h.fx = f;
      setPannerPos(h.panner, ac, f.pos, 0.1);
      const flick = f.state === 'flicker' || (this.flickers.get(f.space) ?? 0) > performance.now();
      if (flick) {
        // stuttering buzz synced to the flicker
        const on = Math.sin(now * 23.3 + i) + Math.sin(now * 7.1 + i * 2) > 0.3;
        h.g.gain.setTargetAtTime(on ? 1.4 : 0.05, now, 0.01);
      } else h.g.gain.setTargetAtTime(1, now, 0.2);
    }
    for (const [key, h] of this.hums) {
      if (keep.has(key)) continue;
      h.g.gain.setTargetAtTime(0, now, 0.2);
      this.hums.delete(key);
      setTimeout(() => { for (const o of h.osc) { try { o.stop(); } catch { /* ignore */ } } h.g.disconnect(); }, 1200);
    }
  }
}
