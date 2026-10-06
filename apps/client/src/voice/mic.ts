// Owner: track ④ Voice. Local microphone: capture (EC on, NS on, AGC OFF), device list, send chain with gain/PTT,
// mic-tap worklet -> loudness band detector (PLAN §3.1) + energy VAD segments for STT (PLAN §4.6).
//
//   mic track -> MediaStreamSource --> tap worklet (band measured BEFORE the gain)
//                                  \-> micGain (slider) -> pttGain -> MediaStreamDestination (sendTrack, fixed)
// The sent track never changes (device switches just re-wire the source), so peers need no replaceTrack.
import { BAND, BAND_THRESH_DB, VOICE } from '@dead-air/shared/constants.ts';
import type { VoiceChunkHeader } from '@dead-air/shared/envelope.ts';
import { MIC_TAP_NAME, micTapUrl } from './worklets/micTap.ts';

export interface MicDevice { deviceId: string; label: string }

export interface BandConfig {
  whisperMaxDb: number;
  shoutMinDb: number;
  screamMinDb: number;
  screamHoldMs: number;
  hysteresisDb: number;
  holdMs: number;
  gateBelowWhisperDb: number;
  vadHangMs: number;
  /** uncalibrated starting talk baseline (headset-ish speech level) */
  defaultTalkDb: number;
  /** an uncalibrated baseline never leaves [baseMinDb, baseMaxDb] (a constant shouter stays SHOUT) */
  baseMinDb: number;
  baseMaxDb: number;
  /** talk-or-louder frames (10 Hz) before the first baseline update (~2 s of speech) */
  baseMinFrames: number;
  /** extra shout margin until the baseline has seen baseMinFrames of speech (no false SHOUT on a cold start) */
  coldShoutMarginDb: number;
}

export interface MicCallbacks {
  /** band or radio changed, or periodic (every 500 ms while not silent) -> net.sendLoud */
  onLoud(band: number, radio: 0 | 1): void;
  /** ~20 Hz state for the data channel */
  onState(band: number, radio: 0 | 1, baseDb: number): void;
  onChunk(h: VoiceChunkHeader, pcm: Int16Array): void;
  /** should PCM be streamed (consent + joined)? */
  wantChunks(): boolean;
  /** radio PTT currently transmitting (Q held + has walkie) */
  radio(): 0 | 1;
  log(msg: string): void;
}

const LS_DEV = 'deadair.voice.device';
const LS_GAIN = 'deadair.voice.gain';
const LS_BASE = 'deadair.voice.base';
const LS_CAL = 'deadair.voice.cal';

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export const toDb = (rms: number): number => 20 * Math.log10(Math.max(1e-7, rms));

export interface CalibrationData { noiseDb: number; talkDb: number; whisperDb?: number; shoutDb?: number; at: number }

export class Mic {
  readonly ac: AudioContext;
  readonly sendDest: MediaStreamAudioDestinationNode;
  readonly micGain: GainNode;
  readonly pttGain: GainNode;
  stream: MediaStream | null = null;
  track: MediaStreamTrack | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private tap: AudioWorkletNode | null = null;
  private sink: GainNode;
  private workletReady: Promise<void> | null = null;
  private cb: MicCallbacks;
  cfg: BandConfig;
  error: string | null = null;
  starting: Promise<boolean> | null = null;

  // detector state
  baseDb: number;
  noiseDb = -80;
  cal: CalibrationData | null = null;
  levelDb = -120;
  peakDb = -120;
  private win: number[] = []; // last 5 frames of mean-square (100 ms)
  private band = 0;
  private heldBand = 0;
  private holdUntil = 0;
  private screamSince = 0;
  private speech: number[] = []; // speech-frame levels (10 Hz decimated) for the adaptive baseline
  private speechTick = 0;
  private lastBaseUpdate = 0;
  private lastLoudAt = 0;
  private lastLoudBand = -1;
  private lastLoudRadio = -1;
  private lastStateAt = 0;
  /** listeners for raw 20 ms levels (calibration / echo check / meters) */
  readonly levelSubs = new Set<(rmsDb: number, peak: number, t: number) => void>();
  // VAD / segments
  private segOpen = false;
  private segId = 0;
  private segSeq = 0;
  private segStartAt = 0;
  private segMaxBand = 0;
  private lastVoiceAt = 0;
  private preRoll: Int16Array[] = [];
  /** push-to-talk mode (forced by a failed echo check, or chosen) */
  ptt = false;
  pttHeld = false;
  muted = false;

  constructor(ac: AudioContext, cfg: BandConfig, cb: MicCallbacks) {
    this.ac = ac;
    this.cfg = cfg;
    this.cb = cb;
    this.sendDest = ac.createMediaStreamDestination();
    this.sendDest.channelCount = 1;
    this.micGain = ac.createGain();
    this.micGain.gain.value = Number(lsGet(LS_GAIN) ?? 1) || 1;
    this.pttGain = ac.createGain();
    this.micGain.connect(this.pttGain).connect(this.sendDest);
    this.sink = ac.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ac.destination);
    const savedBase = Number(lsGet(LS_BASE));
    try {
      const c = JSON.parse(lsGet(LS_CAL) ?? 'null') as CalibrationData | null;
      if (c && typeof c.talkDb === 'number' && Number.isFinite(c.talkDb)) { this.cal = c; this.noiseDb = c.noiseDb; }
    } catch { /* ignore */ }
    const haveSaved = Number.isFinite(savedBase) && savedBase < -5 && savedBase > -70;
    this.baseDb = this.clampBase(haveSaved ? savedBase : (this.cal?.talkDb ?? cfg.defaultTalkDb));
    this.warm = haveSaved || !!this.cal;
  }

  get sendTrack(): MediaStreamTrack { return this.sendDest.stream.getAudioTracks()[0]; }
  get sendStream(): MediaStream { return this.sendDest.stream; }
  hasMic(): boolean { return !!this.track && this.track.readyState === 'live'; }
  currentBand(): number { return this.heldBand; }
  deviceId(): string { return lsGet(LS_DEV) ?? ''; }
  gain(): number { return this.micGain.gain.value; }

  setGain(g: number): void {
    const v = Math.max(0, Math.min(4, g));
    this.micGain.gain.setTargetAtTime(v, this.ac.currentTime, 0.03);
    lsSet(LS_GAIN, String(v));
  }

  /** gate the SENT audio for PTT / mute (band also reports silent while gated) */
  private applyPtt(): void {
    const open = !this.muted && (!this.ptt || this.pttHeld || this.cb.radio() === 1);
    this.pttGain.gain.setTargetAtTime(open ? 1 : 0, this.ac.currentTime, 0.015);
  }
  setPtt(on: boolean): void { this.ptt = on; this.applyPtt(); }
  setPttHeld(on: boolean): void { this.pttHeld = on; this.applyPtt(); }
  setMuted(on: boolean): void { this.muted = on; this.applyPtt(); }
  refreshGate(): void { this.applyPtt(); }
  transmitting(): boolean { return !this.muted && (!this.ptt || this.pttHeld || this.cb.radio() === 1); }

  settings(): Record<string, unknown> | null {
    if (!this.track) return null;
    const s = this.track.getSettings() as Record<string, unknown>;
    return { ...s, label: this.track.label };
  }

  async devices(): Promise<MicDevice[]> {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return list.filter((d) => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    } catch {
      return [];
    }
  }

  private ensureWorklet(): Promise<void> {
    this.workletReady ??= this.ac.audioWorklet.addModule(micTapUrl()).then(() => {
      const tap = new AudioWorkletNode(this.ac, MIC_TAP_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      tap.port.onmessage = (e: MessageEvent) => this.onPort(e.data as { t: string; rms?: number; peak?: number; pcm?: Int16Array });
      tap.connect(this.sink);
      this.tap = tap;
    });
    return this.workletReady;
  }

  /** getUserMedia with the mandatory constraints; call after ctx.audio.unlock(). Resolves true if a mic is live. */
  start(deviceId?: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const dev = deviceId ?? this.deviceId();
      const audio: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
        ...(dev ? { deviceId: { exact: dev } } : {}),
      };
      let stream: MediaStream;
      try {
        await this.ensureWorklet();
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (e) {
          if (dev && e instanceof Error && e.name === 'OverconstrainedError') {
            const { deviceId: _d, ...rest } = audio;
            stream = await navigator.mediaDevices.getUserMedia({ audio: rest });
          } else throw e;
        }
      } catch (e) {
        this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        this.cb.log(`mic unavailable (${this.error}); listen-only`);
        return false;
      }
      // swap source
      this.src?.disconnect();
      for (const t of this.stream?.getTracks() ?? []) t.stop();
      this.stream = stream;
      this.track = stream.getAudioTracks()[0] ?? null;
      this.error = null;
      const src = this.ac.createMediaStreamSource(stream);
      src.connect(this.micGain);
      if (this.tap) src.connect(this.tap);
      this.src = src;
      if (dev) lsSet(LS_DEV, dev);
      const s = this.track?.getSettings() as Record<string, unknown> | undefined;
      if (s && (s.echoCancellation !== true || s.autoGainControl === true)) {
        this.cb.log(`mic settings not as requested: EC=${String(s.echoCancellation)} AGC=${String(s.autoGainControl)} NS=${String(s.noiseSuppression)}`);
      }
      this.track?.addEventListener('ended', () => this.cb.log('mic track ended'));
      return true;
    };
    this.starting = run().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** baseline has enough evidence (calibrated, saved from an earlier session, or ~2 s of speech) */
  private warm = false;
  /** the allowed baseline window: +-8 dB around a calibration, else [baseMinDb, baseMaxDb] */
  private clampBase(db: number): number {
    const lo = this.cal ? this.cal.talkDb - 8 : this.cfg.baseMinDb;
    const hi = this.cal ? this.cal.talkDb + 8 : this.cfg.baseMaxDb;
    return Number.isFinite(db) ? Math.max(lo, Math.min(hi, db)) : Math.max(lo, Math.min(hi, this.cfg.defaultTalkDb));
  }

  /** seed / replace the talk baseline (calibration) */
  setCalibration(c: CalibrationData): void {
    this.cal = c;
    this.noiseDb = c.noiseDb;
    this.baseDb = c.talkDb;
    this.warm = true;
    this.speech = [];
    lsSet(LS_CAL, JSON.stringify(c));
    lsSet(LS_BASE, String(c.talkDb));
  }

  /** silent threshold: from the player's own whisper level, but above the noise floor */
  gateDb(): number {
    const whisper = this.cal?.whisperDb ?? this.baseDb + this.cfg.whisperMaxDb - 4;
    return Math.max(this.noiseDb + 6, whisper - this.cfg.gateBelowWhisperDb, -62);
  }
  thresholds(): { gate: number; whisperMax: number; shoutMin: number; screamMin: number } {
    const b = this.baseDb;
    const cold = this.warm ? 0 : this.cfg.coldShoutMarginDb;
    const shoutMin = (this.cal?.shoutDb !== undefined ? Math.min(b + this.cfg.shoutMinDb, (b + this.cal.shoutDb) / 2 + 2) : b + this.cfg.shoutMinDb) + cold;
    // a calibrated whisper stays a whisper even if the baseline sagged (but whisperMax stays below talk)
    const whisperMax = this.cal?.whisperDb !== undefined
      ? Math.min(b - 4, Math.max(b + this.cfg.whisperMaxDb, (b + this.cal.whisperDb) / 2 - 2, this.cal.whisperDb + 2))
      : b + this.cfg.whisperMaxDb;
    return { gate: this.gateDb(), whisperMax, shoutMin, screamMin: b + this.cfg.screamMinDb + cold };
  }

  private classify(db: number, now: number): number {
    const th = this.thresholds();
    const h = this.cfg.hysteresisDb;
    const cur = this.band;
    // silent <-> whisper (gate)
    if (cur === BAND.silent ? db < th.gate : db < th.gate - h) { this.screamSince = 0; return BAND.silent; }
    let b: number;
    if (db >= th.screamMin - (cur === BAND.scream ? h : 0)) {
      if (!this.screamSince) this.screamSince = now;
      b = now - this.screamSince >= this.cfg.screamHoldMs || cur === BAND.scream ? BAND.scream : BAND.shout;
    } else {
      this.screamSince = 0;
      if (db >= th.shoutMin - (cur >= BAND.shout ? h : 0)) b = BAND.shout;
      else if (db <= th.whisperMax + (cur === BAND.whisper ? h : 0)) b = BAND.whisper;
      else b = BAND.talk;
    }
    return b;
  }

  private onPort(m: { t: string; rms?: number; peak?: number; pcm?: Int16Array }): void {
    if (m.t === 'lvl') return this.onLevel(m.rms ?? 0, m.peak ?? 0);
    if (m.t === 'pcm' && m.pcm) return this.onPcm(m.pcm);
  }

  private onLevel(rms: number, peak: number): void {
    const now = performance.now();
    const ms = rms * rms;
    this.win.push(ms);
    if (this.win.length > 5) this.win.shift();
    const mean = this.win.reduce((a, b) => a + b, 0) / this.win.length;
    const db = 10 * Math.log10(Math.max(1e-14, mean));
    this.levelDb = db;
    this.peakDb = toDb(peak);
    for (const fn of this.levelSubs) fn(toDb(rms), peak, now);
    const tx = this.transmitting();
    const raw = tx ? this.classify(db, now) : BAND.silent;
    this.band = raw;
    // 200 ms hold: rise immediately, fall only after the hold
    if (raw > this.heldBand) { this.heldBand = raw; this.holdUntil = now + this.cfg.holdMs; }
    else if (raw < this.heldBand && now >= this.holdUntil) { this.heldBand = raw; this.holdUntil = now + this.cfg.holdMs; }
    else if (raw === this.heldBand && raw > 0) this.holdUntil = Math.max(this.holdUntil, now + this.cfg.holdMs * 0.5);
    const band = this.heldBand;
    if (raw > 0) this.lastVoiceAt = now;
    // adaptive baseline: long-window median of talk-or-louder frames (10 Hz). Whisper frames never pull it down
    // (a whisperer stays WHISPER), and it is clamped to a plausible window (a constant shouter stays SHOUT).
    if (raw >= BAND.talk && tx && Number.isFinite(db) && ++this.speechTick % 5 === 0) {
      this.speech.push(db);
      if (this.speech.length > 900) this.speech.shift(); // ~90 s of speech
      const n = this.speech.length;
      const fast = n < this.cfg.baseMinFrames * 6; // the first ~12 s of speech converge quickly
      if (n >= this.cfg.baseMinFrames && now - this.lastBaseUpdate > (fast ? 1000 : 2000)) {
        this.lastBaseUpdate = now;
        const sorted = this.speech.slice().sort((a, b) => a - b);
        const med = sorted[n >> 1];
        const target = this.clampBase(med);
        this.baseDb = this.clampBase(this.baseDb + (target - this.baseDb) * (fast ? 0.5 : 0.15));
        this.warm = true;
        lsSet(LS_BASE, this.baseDb.toFixed(1));
      }
    }
    const radio = this.cb.radio();
    if (band !== this.lastLoudBand || radio !== this.lastLoudRadio || (band > 0 && now - this.lastLoudAt >= 500)) {
      this.lastLoudBand = band;
      this.lastLoudRadio = radio;
      this.lastLoudAt = now;
      this.cb.onLoud(band, radio);
      this.cb.onState(band, radio, this.baseDb);
      this.lastStateAt = now;
    } else if (now - this.lastStateAt >= 50) {
      this.lastStateAt = now;
      this.cb.onState(band, radio, this.baseDb);
    }
  }

  private emitChunk(pcm: Int16Array, start: boolean, end: boolean): void {
    this.cb.onChunk({ segId: this.segId, seq: this.segSeq++, start, end, maxBand: this.segMaxBand }, pcm);
  }

  private onPcm(pcm: Int16Array): void {
    const now = performance.now();
    const want = this.cb.wantChunks() && this.transmitting();
    const voiced = now - this.lastVoiceAt < this.cfg.vadHangMs && this.heldBand > 0 || this.band > 0;
    if (!want) {
      if (this.segOpen) { this.segOpen = false; this.emitChunk(pcm, false, true); }
      this.preRoll = [];
      return;
    }
    if (this.segOpen) {
      this.segMaxBand = Math.max(this.segMaxBand, this.heldBand);
      const tooLong = now - this.segStartAt >= VOICE.maxSegmentMs;
      const ended = !voiced && now - this.lastVoiceAt >= this.cfg.vadHangMs;
      if (ended || tooLong) {
        this.emitChunk(pcm, false, true);
        this.segOpen = false;
        this.preRoll = [];
        if (tooLong && voiced) this.openSegment(now, []); // force-split: continue in a new segment
        return;
      }
      this.emitChunk(pcm, false, false);
      return;
    }
    if (voiced && this.heldBand > 0) {
      this.openSegment(now, this.preRoll);
      this.emitChunk(pcm, false, false);
      this.preRoll = [];
      return;
    }
    this.preRoll.push(pcm);
    const keep = Math.ceil(VOICE.preRollMs / VOICE.chunkMs);
    while (this.preRoll.length > keep) this.preRoll.shift();
  }

  private openSegment(now: number, pre: Int16Array[]): void {
    this.segOpen = true;
    this.segId = (this.segId + 1) >>> 0;
    this.segSeq = 0;
    this.segStartAt = now;
    this.segMaxBand = this.heldBand;
    if (pre.length) {
      pre.forEach((c, i) => this.emitChunk(c, i === 0, false));
    } else {
      // no pre-roll: a 1-sample-silence start marker keeps the start flag on the first frame
      this.emitChunk(new Int16Array(160), true, false);
    }
  }

  segmentOpen(): boolean { return this.segOpen; }

  stop(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.src?.disconnect();
    this.stream = null;
    this.track = null;
  }
}

export function bandConfig(b: Record<string, unknown> | undefined): BandConfig {
  const n = (k: string, d: number) => (typeof b?.[k] === 'number' ? (b[k] as number) : d);
  return {
    whisperMaxDb: n('whisperMaxDb', BAND_THRESH_DB.whisperMax),
    shoutMinDb: n('shoutMinDb', BAND_THRESH_DB.shoutMin),
    screamMinDb: n('screamMinDb', BAND_THRESH_DB.screamMin),
    screamHoldMs: n('screamHoldMs', BAND_THRESH_DB.screamHoldMs),
    hysteresisDb: n('hysteresisDb', BAND_THRESH_DB.hysteresisDb),
    holdMs: n('bandHoldDetectMs', BAND_THRESH_DB.holdMs),
    gateBelowWhisperDb: n('gateBelowWhisperDb', 6),
    vadHangMs: n('vadHangMs', 450),
    defaultTalkDb: n('defaultTalkDbfs', -24),
    baseMinDb: n('baseMinDbfs', -38),
    baseMaxDb: n('baseMaxDbfs', -18),
    baseMinFrames: Math.max(5, n('baseMinFrames', 20)),
    coldShoutMarginDb: n('coldShoutMarginDb', 4),
  };
}
