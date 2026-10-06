// Owner: track ④ Voice. Mic tap AudioWorklet (loaded from a Blob URL so it needs no bundler support).
// Per 20 ms frame (50 Hz): RMS + peak -> port {t:'lvl', rms, peak}. Also resamples to 16 kHz mono and posts
// 100 ms PCM16 chunks -> port {t:'pcm', pcm: Int16Array} (transferred). Band detection / VAD run in the port
// handler on the main thread (not rAF), so they keep running while the tab is in the background.
export const MIC_TAP_NAME = 'dead-air-mic-tap';

export const MIC_TAP_SOURCE = String.raw`
class DeadAirMicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameLen = Math.max(64, Math.round(sampleRate * 0.02));
    this.acc = 0; this.n = 0; this.peak = 0;
    this.ratio = sampleRate / 16000;
    this.pos = 0;            // fractional read position in input samples (relative to this block)
    this.lp = 0;             // one-pole lowpass state (anti-alias before decimation)
    this.alpha = Math.min(1, 2 * Math.PI * 7000 / sampleRate);
    this.prev = 0;
    this.out = new Int16Array(1600); this.outN = 0;
    this.on = true;
    this.port.onmessage = (e) => { if (e.data && e.data.t === 'on') this.on = !!e.data.v; };
  }
  process(inputs) {
    const inp = inputs[0];
    const ch = inp && inp[0];
    if (!ch) return true;
    const len = ch.length;
    for (let i = 0; i < len; i++) {
      const s = ch[i];
      this.acc += s * s;
      const a = s < 0 ? -s : s;
      if (a > this.peak) this.peak = a;
      if (++this.n >= this.frameLen) {
        this.port.postMessage({ t: 'lvl', rms: Math.sqrt(this.acc / this.n), peak: this.peak });
        this.acc = 0; this.n = 0; this.peak = 0;
      }
    }
    if (!this.on) return true;
    // lowpass + fractional decimation to 16 kHz (linear interpolation)
    const f = new Float32Array(len);
    let lp = this.lp;
    for (let i = 0; i < len; i++) { lp += (ch[i] - lp) * this.alpha; f[i] = lp; }
    this.lp = lp;
    let p = this.pos;
    while (p < len) {
      const i0 = Math.floor(p);
      const k = p - i0;
      const a = i0 - 1 >= 0 ? f[i0 - 1] : this.prev;
      const b = f[i0];
      let v = a + (b - a) * k;
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      this.out[this.outN++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.outN >= this.out.length) {
        const chunk = this.out;
        this.port.postMessage({ t: 'pcm', pcm: chunk }, [chunk.buffer]);
        this.out = new Int16Array(1600); this.outN = 0;
      }
      p += this.ratio;
    }
    this.pos = p - len;
    this.prev = f[len - 1];
    return true;
  }
}
registerProcessor('${'dead-air-mic-tap'}', DeadAirMicTap);
`;

let urlCache: string | null = null;
export function micTapUrl(): string {
  urlCache ??= URL.createObjectURL(new Blob([MIC_TAP_SOURCE], { type: 'application/javascript' }));
  return urlCache;
}
