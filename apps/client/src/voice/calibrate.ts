// Owner: track ④ Voice. Calibration (noise floor, talk baseline, optional whisper/shout) + echo self-test.
// Echo test: a 1 s log chirp through the voice OUTPUT chain (panner -> voiceBus -> compressor -> destination) while
// watching the processed (EC/NS) mic. Mic level rising with the chirp to within -20 dB of the output => speakers
// without enough echo cancellation => force push-to-talk (V) and set the 'speakers: PTT on' flag.
import type { AudioGraph } from '../audio/graph.ts';
import type { CalibrationData, Mic } from './mic.ts';

export type CalStep = 'noise' | 'talk' | 'whisper' | 'shout' | 'echo' | 'done' | 'failed';

export interface CalibrationResult {
  ok: boolean;
  reason?: string;
  data?: CalibrationData;
  echo?: EchoResult;
}

export interface EchoResult { residualDb: number; pickupDb: number; echo: boolean }

export interface CalOpts {
  whisper?: boolean;
  shout?: boolean;
  echo?: boolean;
  /** progress callback: step + 0..1 + current level (dBFS) */
  onStep?: (step: CalStep, progress: number, levelDb: number) => void;
  signal?: AbortSignal;
}

const median = (a: number[]): number => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};
const percentile = (a: number[], q: number): number => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * q)))];
};

function collect(mic: Mic, ms: number, step: CalStep, opts: CalOpts): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const out: number[] = [];
    const t0 = performance.now();
    const fn = (db: number) => {
      out.push(db);
      const p = (performance.now() - t0) / ms;
      opts.onStep?.(step, Math.min(1, p), db);
      if (p >= 1) { mic.levelSubs.delete(fn); resolve(out); }
    };
    mic.levelSubs.add(fn);
    opts.signal?.addEventListener('abort', () => { mic.levelSubs.delete(fn); reject(new Error('aborted')); });
    // no mic frames at all (no worklet / no mic): resolve after the window anyway
    setTimeout(() => { if (mic.levelSubs.has(fn)) { mic.levelSubs.delete(fn); resolve(out); } }, ms + 1500);
  });
}

/** speech frames of a window: frames well above the noise floor, top part (ignore pauses between words) */
function speechLevel(frames: number[], noiseDb: number): { db: number; n: number } {
  const voiced = frames.filter((d) => d > noiseDb + 10 && d > -70);
  if (voiced.length < 10) return { db: NaN, n: voiced.length };
  const s = voiced.sort((a, b) => a - b);
  // median of the upper 70% (energy averages over speech frames only)
  const lo = Math.floor(s.length * 0.3);
  return { db: median(s.slice(lo)), n: voiced.length };
}

export async function runCalibration(mic: Mic, g: AudioGraph, opts: CalOpts = {}): Promise<CalibrationResult> {
  if (!mic.hasMic()) return { ok: false, reason: 'no microphone' };
  try {
    const noiseFrames = await collect(mic, 1500, 'noise', opts);
    const talkFrames = await collect(mic, 4000, 'talk', opts);
    // noise floor = the quiet end of both windows (the pauses between words hear the same room), not the median of
    // the "stay quiet" window: a player who keeps talking into it ("is this on?") otherwise sets the floor at speech
    // level, every talk frame fails the +10 dB test and calibration says "did not hear you talk". In a quiet room
    // the low percentile and the median differ by about 1 dB.
    const lows = [percentile(noiseFrames, 0.2), percentile(talkFrames, 0.1)].filter(Number.isFinite);
    const noiseDb = Math.max(-100, lows.length ? Math.min(...lows) : -100);
    const talk = speechLevel(talkFrames, noiseDb);
    if (!Number.isFinite(talk.db)) {
      opts.onStep?.('failed', 1, mic.levelDb);
      return { ok: false, reason: 'did not hear you talk: check the mic / device picker' };
    }
    const data: CalibrationData = { noiseDb, talkDb: talk.db, at: Date.now() };
    if (opts.whisper) {
      const w = speechLevel(await collect(mic, 2500, 'whisper', opts), noiseDb);
      if (Number.isFinite(w.db) && w.db < talk.db - 3) data.whisperDb = w.db;
    }
    if (opts.shout) {
      const s = speechLevel(await collect(mic, 2500, 'shout', opts), noiseDb);
      if (Number.isFinite(s.db) && s.db > talk.db + 3) data.shoutDb = s.db;
    }
    mic.setCalibration(data);
    let echo: EchoResult | undefined;
    if (opts.echo !== false) {
      opts.onStep?.('echo', 0, mic.levelDb);
      echo = await echoCheck(mic, g, opts);
    }
    opts.onStep?.('done', 1, mic.levelDb);
    return { ok: true, data, echo };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Echo self-test: 3 on/off bursts (250 ms on / 250 ms off, rising chirps) through the voice output chain while
 * watching the processed mic. Echo = the mic level FOLLOWS the burst pattern in every cycle (ON - OFF > 6 dB)
 * and the picked-up level is within -20 dB of the output. Talking during the test does not line up with the
 * pattern in all three cycles, so it does not trigger a false "speakers" verdict.
 */
export async function echoCheck(mic: Mic, g: AudioGraph, opts: CalOpts = {}): Promise<EchoResult> {
  const ac = g.ac;
  const outDb = -14;
  const amp = Math.pow(10, outDb / 20) * Math.SQRT2;
  const osc = ac.createOscillator();
  osc.type = 'sine';
  const env = ac.createGain();
  env.gain.value = 0;
  const pan = new PannerNode(ac, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0 });
  const L = ac.listener;
  pan.positionX.value = (L.positionX?.value ?? 0) + (L.forwardX?.value ?? 0);
  pan.positionY.value = (L.positionY?.value ?? 0) + (L.forwardY?.value ?? 0);
  pan.positionZ.value = (L.positionZ?.value ?? 0) + (L.forwardZ?.value ?? -1);
  osc.connect(env).connect(pan).connect(g.voiceBus);
  const lead = 0.15;
  const t0 = ac.currentTime + lead;
  const perf0 = performance.now() + lead * 1000;
  const cycles = 3, on = 0.25, off = 0.25;
  for (let c = 0; c < cycles; c++) {
    const ts = t0 + c * (on + off);
    osc.frequency.setValueAtTime(400 + c * 300, ts);
    osc.frequency.exponentialRampToValueAtTime(1800 + c * 600, ts + on);
    env.gain.setValueAtTime(0, ts);
    env.gain.linearRampToValueAtTime(amp, ts + 0.01);
    env.gain.setValueAtTime(amp, ts + on - 0.01);
    env.gain.linearRampToValueAtTime(0, ts + on);
  }
  osc.start(t0 - 0.01);
  osc.stop(t0 + cycles * (on + off) + 0.05);
  const frames: { t: number; db: number }[] = [];
  const fn = (db: number, _peak: number, t: number) => { frames.push({ t, db }); opts.onStep?.('echo', Math.min(1, (t - perf0) / ((on + off) * cycles * 1000)), db); };
  mic.levelSubs.add(fn);
  await new Promise((r) => setTimeout(r, (lead + cycles * (on + off)) * 1000 + 250));
  mic.levelSubs.delete(fn);
  osc.disconnect();
  // output + capture latency guard: ignore the first 90 ms of every window
  const lat = ((ac.outputLatency || 0) + (ac.baseLatency || 0)) * 1000 + 90;
  const diffs: number[] = [];
  const onLevels: number[] = [];
  for (let c = 0; c < cycles; c++) {
    const onS = perf0 + c * (on + off) * 1000;
    const offS = onS + on * 1000;
    const win = (a: number, b: number) => frames.filter((f) => f.t >= a + lat && f.t < b + lat * 0.5).map((f) => f.db);
    const mOn = median(win(onS, offS));
    const mOff = median(win(offS, offS + off * 1000));
    if (Number.isFinite(mOn) && Number.isFinite(mOff)) { diffs.push(mOn - mOff); onLevels.push(mOn); }
  }
  const pickupDb = diffs.length ? Math.min(...diffs) : 0;
  const residualDb = onLevels.length ? median(onLevels) - outDb : -120;
  const echo = diffs.length === cycles && pickupDb > 6 && residualDb > -20;
  return { residualDb: Math.round(residualDb * 10) / 10, pickupDb: Math.round(pickupDb * 10) / 10, echo };
}
