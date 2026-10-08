// Owner: env-audio (v1.2). A small fake Web Audio API for node --test, so the real audio modules run unchanged:
// - AudioParam automation timelines (setValueAtTime / linear / exponential ramps / setTargetAtTime / cancel) that can be
//   evaluated at any time (valueAt) and that THROW on non-finite values like the real API;
// - a connection graph (connectedCount() = nodes with a live output: the leak check);
// - scheduled sources that end (onended) when the fake clock passes their stop time (advance());
// - global constructors (GainNode, OscillatorNode, ...) and ctx.createX() factories.
// Not a renderer: tests/audio/render.ts renders synth plans offline for level checks.

type EvType = 'set' | 'lin' | 'exp' | 'target';
interface Ev { type: EvType; v: number; t: number; tc: number; call: number }

const fin = (name: string, ...vals: number[]): void => {
  for (const v of vals) if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${name}: non-finite value ${v}`);
};

export class FakeParam {
  readonly name: string;
  readonly ctx: FakeContext;
  readonly defaultValue: number;
  readonly minValue = -3.4028234663852886e38;
  readonly maxValue = 3.4028234663852886e38;
  /** value before any automation */
  private base: number;
  events: Ev[] = [];
  inputs = new Set<FakeNode>();
  /** every value ever scheduled (the "finite and bounded" checks) */
  readonly history: number[] = [];

  constructor(ctx: FakeContext, name: string, v: number) {
    this.ctx = ctx;
    this.name = name;
    this.base = v;
    this.defaultValue = v;
    this.history.push(v);
  }
  get value(): number { return this.valueAt(this.ctx.currentTime); }
  set value(v: number) {
    fin(`${this.name}.value`, v);
    // spec: like setValueAtTime(v, currentTime)
    if (!this.events.length) this.base = v;
    else this.insert('set', v, this.ctx.currentTime, 0);
    this.history.push(v);
  }
  private insert(type: EvType, v: number, t: number, tc: number): this {
    const e: Ev = { type, v, t, tc, call: this.ctx.currentTime };
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].t > t) i--;
    this.events.splice(i, 0, e);
    this.history.push(v);
    return this;
  }
  setValueAtTime(v: number, t: number): this { fin(`${this.name}.setValueAtTime`, v, t); return this.insert('set', v, t, 0); }
  linearRampToValueAtTime(v: number, t: number): this { fin(`${this.name}.linearRamp`, v, t); return this.insert('lin', v, t, 0); }
  exponentialRampToValueAtTime(v: number, t: number): this {
    fin(`${this.name}.exponentialRamp`, v, t);
    if (v === 0) throw new RangeError(`${this.name}: exponential ramp to 0`);
    return this.insert('exp', v, t, 0);
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    fin(`${this.name}.setTargetAtTime`, v, t, tc);
    if (tc < 0) throw new RangeError(`${this.name}: negative time constant`);
    return this.insert('target', v, t, tc);
  }
  cancelScheduledValues(t: number): this {
    fin(`${this.name}.cancelScheduledValues`, t);
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  cancelAndHoldAtTime(t: number): this {
    const v = this.valueAt(t);
    this.cancelScheduledValues(t);
    return this.insert('set', v, t, 0);
  }
  setValueCurveAtTime(values: number[], t: number, dur: number): this {
    for (const v of values) fin(`${this.name}.curve`, v);
    fin(this.name, t, dur);
    values.forEach((v, i) => this.insert('set', v, t + (dur * i) / Math.max(1, values.length - 1), 0));
    return this;
  }

  /** the automation value at time t (Web Audio semantics, simplified) */
  valueAt(t: number): number {
    let v = this.base;
    let tPrev = -Infinity;
    let prev: Ev | null = null;
    const seg = (at: number): number => (prev && prev.type === 'target'
      ? (prev.tc === 0 ? prev.v : prev.v + (v - prev.v) * Math.exp(-(at - tPrev) / prev.tc))
      : v);
    for (const e of this.events) {
      if (e.type === 'lin' || e.type === 'exp') {
        const t0 = tPrev === -Infinity ? Math.min(e.call, e.t) : tPrev;
        const v0 = seg(t0);
        if (t < e.t) {
          if (t <= t0) return seg(t);
          const k = (t - t0) / Math.max(1e-12, e.t - t0);
          if (e.type === 'lin') return v0 + (e.v - v0) * k;
          if (v0 === 0 || v0 * e.v < 0) return v0;
          return v0 * Math.pow(e.v / v0, k);
        }
        v = e.v;
        tPrev = e.t;
        prev = e;
        continue;
      }
      if (t < e.t) return seg(t);
      const atE = seg(e.t);
      v = e.type === 'set' ? e.v : atE;
      tPrev = e.t;
      prev = e;
    }
    return seg(t);
  }
}

export class FakeNode {
  readonly ctx: FakeContext;
  readonly kind: string;
  outputs = new Set<FakeNode | FakeParam>();
  ins = new Set<FakeNode>();
  readonly params: FakeParam[] = [];
  disconnected = false;
  constructor(ctx: FakeContext, kind: string) {
    this.ctx = ctx;
    this.kind = kind;
    ctx.nodes.add(this);
  }
  get context(): FakeContext { return this.ctx; }
  protected param(name: string, v: number): FakeParam {
    const p = new FakeParam(this.ctx, `${this.kind}.${name}`, v);
    this.params.push(p);
    return p;
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    if (!dest) throw new TypeError('connect: no destination');
    if (dest instanceof FakeParam) dest.inputs.add(this);
    else if (dest instanceof FakeNode) { if (dest.ctx !== this.ctx) throw new Error('connect across contexts'); dest.ins.add(this); }
    else throw new TypeError('connect: not a node');
    this.outputs.add(dest);
    return dest;
  }
  disconnect(dest?: FakeNode | FakeParam): void {
    const drop = (o: FakeNode | FakeParam) => { if (o instanceof FakeParam) o.inputs.delete(this); else o.ins.delete(this); };
    if (dest) { if (this.outputs.delete(dest)) drop(dest); return; }
    for (const o of this.outputs) drop(o);
    this.outputs.clear();
    this.disconnected = true;
  }
}

export class FakeScheduled extends FakeNode {
  startAt: number | null = null;
  stopAt: number | null = null;
  offset = 0;
  ended = false;
  onended: ((ev?: unknown) => void) | null = null;
  start(when = 0, offset = 0): void {
    fin(`${this.kind}.start`, when, offset);
    if (this.startAt !== null) throw new Error(`InvalidStateError: ${this.kind} started twice`);
    this.startAt = when;
    this.offset = offset;
    this.ctx.sources.add(this);
  }
  stop(when = 0): void {
    fin(`${this.kind}.stop`, when);
    if (this.startAt === null) throw new Error(`InvalidStateError: ${this.kind} stopped before start`);
    this.stopAt = when;
  }
  /** natural end without stop() (buffer sources) */
  naturalEnd(): number { return Infinity; }
}

export class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(ctx: FakeContext, o: { gain?: number } = {}) { super(ctx, 'Gain'); this.gain = this.param('gain', o.gain ?? 1); }
}
export class FakeOscillator extends FakeScheduled {
  frequency: FakeParam;
  detune: FakeParam;
  type: string;
  constructor(ctx: FakeContext, o: { type?: string; frequency?: number; detune?: number } = {}) {
    super(ctx, 'Oscillator');
    if (o.frequency !== undefined) fin('Oscillator.frequency', o.frequency);
    this.type = o.type ?? 'sine';
    if (!['sine', 'square', 'sawtooth', 'triangle', 'custom'].includes(this.type)) throw new TypeError(`bad oscillator type ${this.type}`);
    this.frequency = this.param('frequency', o.frequency ?? 440);
    this.detune = this.param('detune', o.detune ?? 0);
  }
}
export class FakeBiquad extends FakeNode {
  frequency: FakeParam;
  Q: FakeParam;
  gain: FakeParam;
  detune: FakeParam;
  type: string;
  constructor(ctx: FakeContext, o: { type?: string; frequency?: number; Q?: number; gain?: number } = {}) {
    super(ctx, 'Biquad');
    if (o.frequency !== undefined) fin('Biquad.frequency', o.frequency);
    if (o.Q !== undefined) fin('Biquad.Q', o.Q);
    this.type = o.type ?? 'lowpass';
    if (!['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'].includes(this.type)) throw new TypeError(`bad biquad type ${this.type}`);
    this.frequency = this.param('frequency', o.frequency ?? 350);
    this.Q = this.param('Q', o.Q ?? 1);
    this.gain = this.param('gain', o.gain ?? 0);
    this.detune = this.param('detune', 0);
  }
}
export class FakePanner extends FakeNode {
  positionX: FakeParam; positionY: FakeParam; positionZ: FakeParam;
  orientationX: FakeParam; orientationY: FakeParam; orientationZ: FakeParam;
  refDistance: number; maxDistance: number; rolloffFactor: number; panningModel: string; distanceModel: string;
  constructor(ctx: FakeContext, o: Record<string, number | string | undefined> = {}) {
    super(ctx, 'Panner');
    for (const k of ['positionX', 'positionY', 'positionZ', 'refDistance', 'maxDistance', 'rolloffFactor']) if (o[k] !== undefined) fin(`Panner.${k}`, o[k] as number);
    this.positionX = this.param('positionX', (o.positionX as number) ?? 0);
    this.positionY = this.param('positionY', (o.positionY as number) ?? 0);
    this.positionZ = this.param('positionZ', (o.positionZ as number) ?? 0);
    this.orientationX = this.param('orientationX', 1);
    this.orientationY = this.param('orientationY', 0);
    this.orientationZ = this.param('orientationZ', 0);
    this.refDistance = (o.refDistance as number) ?? 1;
    this.maxDistance = (o.maxDistance as number) ?? 10000;
    this.rolloffFactor = (o.rolloffFactor as number) ?? 1;
    this.panningModel = (o.panningModel as string) ?? 'equalpower';
    this.distanceModel = (o.distanceModel as string) ?? 'inverse';
  }
}
export class FakeBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private data: Float32Array[];
  constructor(o: { numberOfChannels?: number; length: number; sampleRate: number }) {
    fin('AudioBuffer', o.length, o.sampleRate);
    if (o.length < 1) throw new RangeError('AudioBuffer length < 1');
    this.numberOfChannels = o.numberOfChannels ?? 1;
    this.length = Math.floor(o.length);
    this.sampleRate = o.sampleRate;
    this.data = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(c: number): Float32Array { return this.data[c]; }
}
export class FakeBufferSource extends FakeScheduled {
  buffer: FakeBuffer | null;
  loop: boolean;
  playbackRate: FakeParam;
  detune: FakeParam;
  constructor(ctx: FakeContext, o: { buffer?: FakeBuffer | null; loop?: boolean; playbackRate?: number } = {}) {
    super(ctx, 'BufferSource');
    if (o.playbackRate !== undefined) fin('BufferSource.playbackRate', o.playbackRate);
    this.buffer = o.buffer ?? null;
    this.loop = !!o.loop;
    this.playbackRate = this.param('playbackRate', o.playbackRate ?? 1);
    this.detune = this.param('detune', 0);
  }
  override naturalEnd(): number {
    if (this.loop || !this.buffer || this.startAt === null) return Infinity;
    return this.startAt + Math.max(0, this.buffer.duration - this.offset) / Math.max(1e-6, this.playbackRate.value);
  }
}
export class FakeConvolver extends FakeNode {
  buffer: FakeBuffer | null = null;
  normalize = true;
  constructor(ctx: FakeContext) { super(ctx, 'Convolver'); }
}
export class FakeCompressor extends FakeNode {
  threshold: FakeParam; knee: FakeParam; ratio: FakeParam; attack: FakeParam; release: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'Compressor');
    this.threshold = this.param('threshold', -24);
    this.knee = this.param('knee', 30);
    this.ratio = this.param('ratio', 12);
    this.attack = this.param('attack', 0.003);
    this.release = this.param('release', 0.25);
  }
}
export class FakeAnalyser extends FakeNode {
  fftSize: number;
  constructor(ctx: FakeContext, o: { fftSize?: number } = {}) { super(ctx, 'Analyser'); this.fftSize = o.fftSize ?? 2048; }
  getFloatTimeDomainData(a: Float32Array): void { a.fill(0); }
}
export class FakeConstant extends FakeScheduled {
  offset2: FakeParam;
  constructor(ctx: FakeContext, o: { offset?: number } = {}) { super(ctx, 'Constant'); this.offset2 = this.param('offset', o.offset ?? 1); }
}

export class FakeContext {
  currentTime = 0;
  readonly sampleRate: number;
  state = 'running';
  nodes = new Set<FakeNode>();
  sources = new Set<FakeScheduled>();
  readonly destination: FakeNode;
  readonly listener: Record<string, FakeParam>;
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.destination = new FakeNode(this, 'Destination');
    const p = (n: string, v: number) => new FakeParam(this, `listener.${n}`, v);
    this.listener = {
      positionX: p('positionX', 0), positionY: p('positionY', 0), positionZ: p('positionZ', 0),
      forwardX: p('forwardX', 0), forwardY: p('forwardY', 0), forwardZ: p('forwardZ', -1),
      upX: p('upX', 0), upY: p('upY', 1), upZ: p('upZ', 0),
    };
  }
  resume(): Promise<void> { return Promise.resolve(); }
  createGain(): FakeGain { return new FakeGain(this); }
  createOscillator(): FakeOscillator { return new FakeOscillator(this); }
  createBiquadFilter(): FakeBiquad { return new FakeBiquad(this); }
  createPanner(): FakePanner { return new FakePanner(this); }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(this); }
  createConvolver(): FakeConvolver { return new FakeConvolver(this); }
  createDynamicsCompressor(): FakeCompressor { return new FakeCompressor(this); }
  createAnalyser(): FakeAnalyser { return new FakeAnalyser(this); }
  createConstantSource(): FakeConstant { return new FakeConstant(this); }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer { return new FakeBuffer({ numberOfChannels: ch, length: len, sampleRate: sr }); }
  decodeAudioData(): Promise<FakeBuffer> { return Promise.resolve(new FakeBuffer({ length: this.sampleRate, sampleRate: this.sampleRate })); }

  /** move the clock; sources past their stop (or natural end) end and fire onended */
  advance(sec: number): void {
    const target = this.currentTime + sec;
    // step so onended handlers run in time order
    for (;;) {
      let next: FakeScheduled | null = null;
      let at = Infinity;
      for (const s of this.sources) {
        if (s.ended || s.startAt === null) continue;
        const end = Math.min(s.stopAt ?? Infinity, s.naturalEnd());
        if (end <= target && end < at) { at = end; next = s; }
      }
      if (!next) break;
      this.currentTime = Math.max(this.currentTime, at);
      next.ended = true;
      this.sources.delete(next);
      next.onended?.({});
    }
    this.currentTime = target;
  }

  /** nodes with at least one live output connection */
  connectedCount(): number {
    let n = 0;
    for (const x of this.nodes) if (x.outputs.size > 0) n++;
    return n;
  }
  /** every AudioParam of every node created so far */
  allParams(): FakeParam[] {
    const out: FakeParam[] = [];
    for (const x of this.nodes) out.push(...x.params);
    return out;
  }
}

/** install the fake constructors as globals (GainNode, OscillatorNode, ...); idempotent */
export function installFakeAudio(): void {
  const G = globalThis as Record<string, unknown>;
  const ctor = (C: new (ctx: FakeContext, o?: never) => unknown) => function (this: unknown, ctx: FakeContext, o?: never) { return new C(ctx, o); };
  G.GainNode = ctor(FakeGain as never);
  G.OscillatorNode = ctor(FakeOscillator as never);
  G.BiquadFilterNode = ctor(FakeBiquad as never);
  G.PannerNode = ctor(FakePanner as never);
  G.AudioBufferSourceNode = ctor(FakeBufferSource as never);
  G.ConvolverNode = ctor(FakeConvolver as never);
  G.DynamicsCompressorNode = ctor(FakeCompressor as never);
  G.AnalyserNode = ctor(FakeAnalyser as never);
  G.ConstantSourceNode = ctor(FakeConstant as never);
  G.AudioBuffer = FakeBuffer;
}

/** the fake as the DOM types the modules expect */
export const asAudio = (c: FakeContext): AudioContext => c as unknown as AudioContext;
