// Owner: track (e) AI. Plays the Listener's generated radio lines ('ai.lure', apps/server/src/ai/lure.ts).
// The clip is fetched + decoded only when the event arrives (nothing loads at boot), then played through a walkie
// radio chain on the ONE AudioContext, modelled on the voice track's radio path (voice/playback.ts):
//   static burst (sfx) -> clip -> highpass 320 / lowpass 3200 / mid peak +7 dB / drive + waveshaper crunch
//   -> signal dropouts + squelch-open/close bursts + a hiss bed (shared noise buffer) -> out
// Where it plays:
//   - the lured player: their own walkie, close and 2D (like a radio call);
//   - teammates within lureNearM: that walkie squawking at the victim's position (PannerNode + wall occlusion),
//     so a crew that stands together can catch the lie;
//   - intercom lures (p): at the intercom for everyone within lureIntercomM.
import type { Vec3 } from '@dead-air/shared/state.ts';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import { getGraph, listenerPose, setPannerPos } from '../audio/graph.ts';
import type { AudioGraph } from '../audio/graph.ts';
import { levelGrid, occlusionParams, wallCrossings } from '../audio/occlusion.ts';

interface SfxLike { play?(id: string, pos?: Vec3, opts?: { volume?: number; radius?: number; rate?: number }): unknown }

interface Active {
  victim: string | null;
  panner: PannerNode | null;
  lp: BiquadFilterNode | null;
  until: number;
  tap: AnalyserNode | null;
  entry: LureDebug;
}

export interface LureDebug { url: string; mode: 'self' | 'near' | 'intercom'; at: number; ok: boolean; dur: number; peak: number; err?: string; ac?: string; samples?: number }

function crunchCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return c;
}

const num = (b: Record<string, unknown>, k: string, d: number): number => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? (b[k] as number) : d);

export function installLure(ctx: ClientContext): void {
  const bal = (ctx.balance.ai ?? {}) as Record<string, unknown>;
  const nearM = num(bal, 'lureNearM', 9);
  const intercomM = num(bal, 'lureIntercomM', 14);
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  const active = new Set<Active>();
  const debug: LureDebug[] = [];
  const tapBuf = new Float32Array(1024);
  let curve: Float32Array<ArrayBuffer> | null = null;
  const sfx = () => (ctx.services.use as (n: string) => unknown)('sfx') as SfxLike | undefined;
  const graph = (): AudioGraph | null => (ctx.audio.ctx ? getGraph(ctx.audio.ctx) : null);

  const load = (g: AudioGraph, url: string): Promise<AudioBuffer | null> => {
    let p = buffers.get(url);
    if (!p) {
      p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((ab) => g.ac.decodeAudioData(ab))
        .catch(() => { buffers.delete(url); return null; });
      buffers.set(url, p);
      if (buffers.size > 8) buffers.delete(buffers.keys().next().value as string);
    }
    return p;
  };

  const victimPos = (id: string): Vec3 | null => {
    const s = ctx.world.samplePlayer(id);
    return s ? [s.p[0], s.p[1] + 1.1, s.p[2]] : null;
  };

  const occlude = (a: Active, pos: Vec3) => {
    if (!a.lp) return;
    const lp = listenerPose(ctx);
    const { grid, doorOpen } = levelGrid(ctx);
    if (!lp || !grid) return;
    const vb = (ctx.balance.voice ?? {}) as Record<string, unknown>;
    const hz = Array.isArray(vb.occlusionLowpassHz) ? (vb.occlusionLowpassHz as number[]) : [20000, 2400, 1200, 700, 450];
    const o = occlusionParams(wallCrossings(grid, lp.pos[0], lp.pos[2], pos[0], pos[2], doorOpen), hz, num(vb, 'occlusionPerWallDb', -6));
    a.lp.frequency.setTargetAtTime(Math.max(200, Math.min(20000, o.freq)), a.lp.context.currentTime, 0.05);
  };

  /** the radio chain for one clip, starting at `when` (AudioContext time); returns its end time */
  const chain = (g: AudioGraph, buf: AudioBuffer, out: AudioNode, when: number, tint: number): number => {
    const ac = g.ac;
    curve ??= crunchCurve(7);
    const rate = 0.96 - (tint % 3) * 0.015;
    const src = new AudioBufferSourceNode(ac, { buffer: buf, playbackRate: rate });
    const hp = new BiquadFilterNode(ac, { type: 'highpass', frequency: 320, Q: 0.7 });
    const lp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 3200, Q: 0.7 });
    const mid = new BiquadFilterNode(ac, { type: 'peaking', frequency: 1700, Q: 1.1, gain: 7 });
    const drive = new GainNode(ac, { gain: 2.4 });
    const shaper = new WaveShaperNode(ac, { curve, oversample: '2x' });
    const v = new GainNode(ac, { gain: 0 });
    src.connect(hp).connect(lp).connect(mid).connect(drive).connect(shaper).connect(v).connect(out);
    const dur = buf.duration / rate;
    const end = when + dur;
    const lvl = 0.7;
    v.gain.setValueAtTime(0, when);
    v.gain.linearRampToValueAtTime(lvl, when + 0.02);
    // a bad signal: three short dropouts at fixed fractions (audio texture, deterministic)
    for (const f of [0.29, 0.57, 0.84]) {
      const t = when + dur * f;
      v.gain.setValueAtTime(lvl, t);
      v.gain.linearRampToValueAtTime(0.08, t + 0.02);
      v.gain.linearRampToValueAtTime(lvl, t + 0.075);
    }
    v.gain.setValueAtTime(lvl, end);
    v.gain.linearRampToValueAtTime(0, end + 0.03);
    // squelch open, hiss bed, squelch close
    const hiss = new AudioBufferSourceNode(ac, { buffer: g.noise, loop: true });
    const hbp = new BiquadFilterNode(ac, { type: 'bandpass', frequency: 2400, Q: 0.6 });
    const h = new GainNode(ac, { gain: 0 });
    hiss.connect(hbp).connect(h).connect(out);
    const t0 = Math.max(ac.currentTime, when - 0.06);
    h.gain.setValueAtTime(0, t0);
    h.gain.linearRampToValueAtTime(0.24, t0 + 0.01);
    h.gain.linearRampToValueAtTime(0.05, t0 + 0.09);
    h.gain.setValueAtTime(0.05, end);
    h.gain.linearRampToValueAtTime(0.26, end + 0.012);
    h.gain.linearRampToValueAtTime(0, end + 0.1);
    src.start(when);
    src.stop(end + 0.05);
    hiss.start(t0);
    hiss.stop(end + 0.15);
    hiss.onended = () => { try { out.disconnect(); } catch { /* ignore */ } };
    return end;
  };

  ctx.net.on('ai.lure', (d) => {
    const g = graph();
    const me = ctx.world.me;
    const victim = d.to[0] ?? null;
    let mode: LureDebug['mode'];
    let pos: Vec3 | null = null;
    let radius = 0;
    if (d.p) {
      mode = 'intercom';
      pos = d.p;
      radius = intercomM;
    } else if (me && victim === me) mode = 'self';
    else if (victim) {
      mode = 'near';
      pos = victimPos(victim);
      radius = nearM;
    } else return;
    const entry: LureDebug = { url: d.url, mode, at: performance.now(), ok: false, dur: 0, peak: 0 };
    // out of earshot (or the victim isn't visible to this client): don't even fetch it
    if (mode === 'near' && !pos) return;
    if (pos) {
      const lp = listenerPose(ctx);
      const dist = lp ? Math.hypot(lp.pos[0] - pos[0], lp.pos[2] - pos[2]) : Infinity;
      if (dist > radius + 2) {
        if (ctx.testMode) debug.push({ ...entry, err: `out of range (${Number.isFinite(dist) ? dist.toFixed(1) : 'no pose'} m)` });
        return;
      }
    }
    debug.push(entry);
    if (debug.length > 20) debug.shift();
    if (!g) { entry.err = 'no audio'; return; }
    // static burst right away (the garbled lure's opener), the voice after it
    if (pos) sfx()?.play?.('sfx.radio_static_burst', pos, { volume: 0.75, radius: radius + 2 });
    else sfx()?.play?.('sfx.radio_static_burst', undefined, { volume: 0.55 });
    const t0 = g.ac.currentTime;
    void load(g, d.url).then((buf) => {
      if (!buf) { entry.err = 'fetch/decode failed'; return; }
      const ac = g.ac;
      const when = Math.max(ac.currentTime + 0.02, t0 + 0.32);
      const out = new GainNode(ac, { gain: mode === 'self' ? 0.95 : 1 });
      const a: Active = { victim: mode === 'near' ? victim : null, panner: null, lp: null, until: 0, tap: null, entry };
      if (pos) {
        a.lp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 20000, Q: 0.5 });
        a.panner = new PannerNode(ac, {
          panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1.2, maxDistance: Math.max(2, radius), rolloffFactor: 1.4,
          positionX: pos[0], positionY: pos[1], positionZ: pos[2],
        });
        out.connect(a.lp).connect(a.panner).connect(g.voiceBus);
        occlude(a, pos);
      } else out.connect(g.voiceBus);
      if (ctx.testMode) {
        a.tap = new AnalyserNode(ac, { fftSize: 1024 });
        out.connect(a.tap);
      }
      const end = chain(g, buf, out, when, d.voice ?? 0);
      entry.ok = true;
      entry.ac = ac.state;
      entry.dur = Math.round((end - when) * 1000);
      a.until = performance.now() + (end - ac.currentTime) * 1000 + 200;
      active.add(a);
      // test RMS tap on a timer (headless pages may not produce animation frames while nothing is screenshotted)
      const tap = a.tap;
      if (tap) {
        const sample = () => {
          tap.getFloatTimeDomainData(tapBuf);
          let sum = 0;
          for (let i = 0; i < tapBuf.length; i++) sum += tapBuf[i] * tapBuf[i];
          entry.peak = Math.max(entry.peak, Math.sqrt(sum / tapBuf.length));
          entry.samples = (entry.samples ?? 0) + 1;
          if (performance.now() < a.until) setTimeout(sample, 40);
        };
        setTimeout(sample, 40);
      }
    });
  });

  // follow the victim's walkie while it squawks
  ctx.registerSystem({
    name: 'ai.lure',
    order: SYS.audio + 5,
    update: () => {
      if (!active.size) return;
      const now = performance.now();
      for (const a of active) {
        if (now > a.until) { active.delete(a); continue; }
        if (a.panner && a.victim) {
          try {
            const p = victimPos(a.victim);
            const g = graph();
            if (p && g) { setPannerPos(a.panner, g.ac, p, 0.06); occlude(a, p); }
          } catch (e) {
            a.entry.err = `follow: ${e instanceof Error ? e.message : e}`;
          }
        }
      }
    },
  });

  if (ctx.testMode) {
    (window as unknown as { __aiDebug?: unknown }).__aiDebug = { lures: () => debug.map((e) => ({ ...e, peak: Math.round(e.peak * 10000) / 10000 })) };
  }
}
