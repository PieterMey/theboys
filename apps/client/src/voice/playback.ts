// Owner: track ④ Voice. Per-remote-voice playback graph (PLAN §4.6), all on the ONE AudioContext:
//   <audio muted> keep-alive (Chrome bug 40094084) + MediaStreamSource
//     -> inAnalyser (energy for the hold rule + self-heal)
//     -> occlusion lowpass -> occlusion gain -> PannerNode (HRTF, linear, rolloff 0: direction only)
//        -> gate (distance + band radius + hold rule) -> makeup (speaker baseDb) -> vol -> voiceBus (+ reverb send)
//     -> dead2d (dead channel: 2D, slight reverb) -> vol
//     -> radio chain (2D): bandpass 300-3400 + waveshaper + hiss + squelch -> voiceBus
//   vol -> splitter -> L/R analysers (test RMS)
// Self-heal: data channel says band>0 for 3 s but Web Audio sees nothing -> unmute the element, volume = same gain.
import type { AudioGraph } from '../audio/graph.ts';
import { dbToGain, setPannerPos, targetTo } from '../audio/graph.ts';
import type { V3 } from '../audio/graph.ts';

export interface VoiceTuning {
  radius: readonly number[];
  holdMs: number;
  makeupMaxDb: number;
  reverbSend: number;
  deadReverbSend: number;
  radioHiss: number;
  selfHealSec: number;
  edgeFadeM: number;
  /** StereoPanner amount per unit of lateral offset (0 = pure HRTF) */
  panBoost: number;
}

export interface GateInput {
  /** speaker band from the data channel (null = no data yet) */
  band: number | null;
  radio: 0 | 1;
  baseDb: number | null;
  /** path distance to the speaker (m); 255 = unreachable */
  dist: number;
  speakerPos: V3 | null;
  /** occlusion */
  lowpass: number;
  occGain: number;
  /** routing: 'spatial' (normal), 'dead2d' (dead speaker heard by a dead listener), 'mute' (living hear dead), 'monitor' (voicetest: 2D ungated) */
  route: 'spatial' | 'dead2d' | 'mute' | 'monitor';
  /** receiver has a walkie (radio path) */
  canRadio: boolean;
  /** user per-voice volume (0..2) */
  volume: number;
  /** lateral position of the speaker in the listener frame (-1 = hard left .. 1 = hard right), null = unknown */
  lateral: number | null;
}

const TARGET_TALK_DBFS = -26;

function rmsOf(buf: Float32Array<ArrayBuffer>): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

function crunchCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return c;
}

export class RemoteVoice {
  readonly id: string;
  readonly el: HTMLAudioElement | null;
  readonly stream: MediaStream;
  private g: AudioGraph;
  private t: VoiceTuning;
  private src: MediaStreamAudioSourceNode;
  private inAn: AnalyserNode;
  private lp: BiquadFilterNode;
  private occ: GainNode;
  readonly panner: PannerNode;
  /** extra lateral ILD after the HRTF (gameplay clarity on cheap headsets); driven from the azimuth */
  private width: StereoPannerNode;
  private gate: GainNode;
  private makeup: GainNode;
  private vol: GainNode;
  private dead2d: GainNode;
  private revSend: GainNode;
  private radioIn: GainNode;
  private radioOut: GainNode;
  private hissGain: GainNode;
  private hissSrc: AudioBufferSourceNode;
  private anL: AnalyserNode;
  private anR: AnalyserNode;
  private bufIn: Float32Array<ArrayBuffer>;
  private bufL: Float32Array<ArrayBuffer>;
  private bufR: Float32Array<ArrayBuffer>;
  // hold-rule state
  private lastRadius = 0;
  private lastLoudAt = -1e9;
  private lastRadio: 0 | 1 = 0;
  /** smoothed input RMS */
  inRms = 0;
  gateValue = 0;
  band = 0;
  // self-heal
  private talkSince = 0;
  fallback = false;
  private onLog: (m: string) => void;

  constructor(id: string, stream: MediaStream, g: AudioGraph, t: VoiceTuning, opts: { keepAlive: boolean; log: (m: string) => void }) {
    this.id = id;
    this.stream = stream;
    this.g = g;
    this.t = t;
    this.onLog = opts.log;
    const ac = g.ac;
    if (opts.keepAlive) {
      const el = new Audio();
      el.muted = true;
      el.autoplay = true;
      el.srcObject = stream;
      el.setAttribute('playsinline', '');
      el.dataset.voicePeer = id;
      void el.play().catch(() => { /* muted autoplay is allowed; retried on resume() */ });
      this.el = el;
    } else this.el = null;
    this.src = ac.createMediaStreamSource(stream);
    this.inAn = ac.createAnalyser();
    this.inAn.fftSize = 1024;
    this.bufIn = new Float32Array(this.inAn.fftSize);
    this.src.connect(this.inAn);
    this.lp = ac.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.5;
    this.occ = ac.createGain();
    this.panner = new PannerNode(ac, {
      panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0, refDistance: 1, maxDistance: 10000,
      coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 1,
    });
    this.width = new StereoPannerNode(ac, { pan: 0 });
    this.gate = ac.createGain();
    this.gate.gain.value = 0;
    this.makeup = ac.createGain();
    this.vol = ac.createGain();
    this.dead2d = ac.createGain();
    this.dead2d.gain.value = 0;
    this.revSend = ac.createGain();
    this.revSend.gain.value = t.reverbSend;
    this.src.connect(this.lp).connect(this.occ).connect(this.panner).connect(this.width).connect(this.gate).connect(this.makeup).connect(this.vol);
    this.gate.connect(this.revSend).connect(g.reverb);
    this.src.connect(this.dead2d).connect(this.makeup);
    this.vol.connect(g.voiceBus);
    // radio chain (2D)
    this.radioIn = ac.createGain();
    this.radioIn.gain.value = 0;
    const hp = new BiquadFilterNode(ac, { type: 'highpass', frequency: 300, Q: 0.7 });
    const lp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 3400, Q: 0.7 });
    const mid = new BiquadFilterNode(ac, { type: 'peaking', frequency: 1800, Q: 1.2, gain: 6 });
    const shaper = new WaveShaperNode(ac, { curve: crunchCurve(6), oversample: '2x' });
    this.radioOut = ac.createGain();
    this.radioOut.gain.value = 0.7;
    this.src.connect(this.radioIn).connect(hp).connect(lp).connect(mid).connect(shaper).connect(this.radioOut).connect(this.makeup);
    this.hissGain = ac.createGain();
    this.hissGain.gain.value = 0;
    this.hissSrc = ac.createBufferSource();
    this.hissSrc.buffer = g.noise;
    this.hissSrc.loop = true;
    const hissBp = new BiquadFilterNode(ac, { type: 'bandpass', frequency: 2500, Q: 0.6 });
    this.hissSrc.connect(hissBp).connect(this.hissGain).connect(g.voiceBus);
    this.hissSrc.start();
    // test taps (post-vol, stereo)
    const split = ac.createChannelSplitter(2);
    this.anL = ac.createAnalyser();
    this.anR = ac.createAnalyser();
    this.anL.fftSize = this.anR.fftSize = 2048;
    this.bufL = new Float32Array(2048);
    this.bufR = new Float32Array(2048);
    this.vol.connect(split);
    split.connect(this.anL, 0);
    split.connect(this.anR, 1);
  }

  /** resume the keep-alive element (after a user gesture / visibility change) */
  resume(): void {
    if (this.el && this.el.paused) void this.el.play().catch(() => {});
  }

  outRms(): { l: number; r: number } {
    this.anL.getFloatTimeDomainData(this.bufL);
    this.anR.getFloatTimeDomainData(this.bufR);
    return { l: rmsOf(this.bufL), r: rmsOf(this.bufR) };
  }

  measureIn(): number {
    this.inAn.getFloatTimeDomainData(this.bufIn);
    const r = rmsOf(this.bufIn);
    this.inRms = this.inRms * 0.6 + r * 0.4;
    return r;
  }

  private squelch(): void {
    // short noise burst through the hiss path = squelch click
    const ac = this.g.ac;
    const t = ac.currentTime;
    const p = this.hissGain.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(0.25, t + 0.008);
    p.linearRampToValueAtTime(this.lastRadio ? this.t.radioHiss : 0, t + 0.07);
  }

  /** drive all gains (called at ~30 Hz). Returns the target gate gain. */
  update(inp: GateInput, now: number): number {
    const ac = this.g.ac;
    const t = ac.currentTime;
    const R = this.t.radius;
    const energy = this.measureIn();
    // ---- hold rule ----
    let radius = 0;
    const band = inp.band;
    if (band !== null && band > 0) {
      radius = R[band] ?? 0;
      this.lastRadius = radius;
      this.lastLoudAt = now;
    } else if (now - this.lastLoudAt < this.t.holdMs) radius = this.lastRadius;
    // never gate below whisper while the stream has energy (and before any data channel message: assume talk)
    if (energy > 0.003) radius = Math.max(radius, band === null ? (R[2] ?? 10) : (R[1] ?? 3));
    this.band = band ?? -1;
    // ---- distance gain (1:1 rule: 0 beyond the radius) ----
    let g = 0;
    if (inp.dist < 255 && inp.dist <= radius && radius > 0) {
      const k = Math.min(1, inp.dist / radius);
      g = 1 - 0.55 * Math.pow(k, 1.6);
    }
    // ---- routing ----
    let spatial = 0, dead = 0;
    if (inp.route === 'spatial') spatial = g;
    else if (inp.route === 'dead2d') dead = 1;
    else if (inp.route === 'monitor') dead = 1;
    const radioOn = inp.radio === 1 && inp.canRadio && inp.route !== 'mute';
    if (radioOn !== (this.lastRadio === 1)) {
      this.lastRadio = radioOn ? 1 : 0;
      this.squelch();
    }
    targetTo(this.gate.gain, spatial, t, 0.05);
    targetTo(this.dead2d.gain, dead, t, 0.05);
    targetTo(this.revSend.gain, inp.route === 'dead2d' ? this.t.deadReverbSend : this.t.reverbSend, t, 0.1);
    targetTo(this.radioIn.gain, radioOn ? 1 : 0, t, 0.02);
    if (radioOn) targetTo(this.hissGain.gain, this.t.radioHiss, t, 0.05);
    else if (this.hissGain.gain.value > 0.0001) targetTo(this.hissGain.gain, 0, t, 0.05);
    // occlusion
    targetTo(this.lp.frequency, Math.max(200, Math.min(20000, inp.lowpass)), t, 0.08);
    targetTo(this.occ.gain, inp.occGain, t, 0.08);
    // makeup from the speaker's calibrated talk level (normalises quiet / loud mics)
    const base = inp.baseDb;
    const mk = base === null ? 0 : Math.max(-6, Math.min(this.t.makeupMaxDb, TARGET_TALK_DBFS - base));
    targetTo(this.makeup.gain, dbToGain(mk), t, 0.3);
    const vol = inp.route === 'mute' ? 0 : inp.volume;
    if (inp.speakerPos) setPannerPos(this.panner, ac, inp.speakerPos, 0.06);
    targetTo(this.width.pan, inp.lateral === null ? 0 : Math.max(-1, Math.min(1, inp.lateral * this.t.panBoost)), t, 0.06);
    const total = Math.max(spatial, dead, radioOn ? 1 : 0);
    this.gateValue = total;
    // ---- self-heal ----
    if (!this.fallback && this.el) {
      if (band !== null && band > 0 && energy < 1e-4) {
        if (!this.talkSince) this.talkSince = now;
        else if (now - this.talkSince > this.t.selfHealSec * 1000) {
          this.fallback = true;
          this.onLog(`voice ${this.id}: Web Audio path silent for ${this.t.selfHealSec}s while the peer talks -> plain <audio> fallback`);
        }
      } else this.talkSince = 0;
    }
    if (this.fallback && this.el) {
      targetTo(this.vol.gain, 0, t, 0.03);
      this.el.muted = false;
      const ev = total * dbToGain(mk) * vol;
      if (Number.isFinite(ev)) this.el.volume = Math.max(0, Math.min(1, ev));
    } else targetTo(this.vol.gain, vol, t, 0.05);
    return total;
  }

  close(): void {
    try { this.hissSrc.stop(); } catch { /* already stopped */ }
    for (const n of [this.src, this.vol, this.gate, this.revSend, this.dead2d, this.radioOut, this.hissGain]) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
    if (this.el) {
      this.el.pause();
      this.el.srcObject = null;
    }
  }
}
