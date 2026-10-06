// Owner: track ④ Voice/audio. services.sfx.play(key, pos?, opts?) -> { stop() } | null.
// Keys from /assets/manifest.json (packages/shared/src/assets.ts). Missing keys are silently ignored (null).
// 'sfx.door_open' picks a random present variant ('sfx.door_open.1', '.2', ...). Buffers decode lazily, cached.
// Spatial: PannerNode (equalpower, inverse, refDistance 1.5) + occlusion lowpass (same wall test as voice). 2D without pos.
import { ASSET_MANIFEST_URL } from '@dead-air/shared/assets.ts';
import type { AssetManifest } from '@dead-air/shared/assets.ts';
import type { ClientContext } from '../core/context.ts';
import type { AudioGraph, V3 } from './graph.ts';
import { listenerPose, makeNoise, setPannerPos } from './graph.ts';
import { levelGrid, occlusionParams, wallCrossings } from './occlusion.ts';

export interface SfxPlayOpts { volume?: number; loop?: boolean; radius?: number; id?: string; rate?: number; ui?: boolean }
export interface SfxHandle { stop(): void; setPos?(p: V3): void }

interface Live { src: AudioBufferSourceNode | null; panner: PannerNode | null; lp: BiquadFilterNode | null; out: GainNode; pos: V3 | null; stopped: boolean; loop: boolean }

export class SfxEngine {
  private ctx: ClientContext;
  private g: () => AudioGraph | null;
  private manifest: AssetManifest | null = null;
  private manifestP: Promise<AssetManifest | null> | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private live = new Set<Live>();
  private byId = new Map<string, SfxHandle>();
  private rnd = makeNoise(0x5eed);
  private lowpassHz: number[];
  private perWallDb: number;

  constructor(ctx: ClientContext, g: () => AudioGraph | null) {
    this.ctx = ctx;
    this.g = g;
    const vb = (ctx.balance.voice ?? {}) as Record<string, unknown>;
    this.lowpassHz = Array.isArray(vb.occlusionLowpassHz) ? (vb.occlusionLowpassHz as number[]) : [20000, 2400, 1200, 700, 450];
    this.perWallDb = typeof vb.occlusionPerWallDb === 'number' ? vb.occlusionPerWallDb : -6;
  }

  loadManifest(): Promise<AssetManifest | null> {
    this.manifestP ??= fetch(ASSET_MANIFEST_URL, { cache: 'no-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<AssetManifest>) : null))
      .catch(() => null)
      .then((m) => {
        this.manifest = m;
        if (!m) this.manifestP = null; // retry later (assets may still be landing)
        return m;
      });
    return this.manifestP;
  }

  has(key: string): boolean { return !!this.resolveKey(key); }

  private resolveKey(key: string): string | null {
    const files = this.manifest?.files;
    if (!files) return null;
    if (files[key]) return key;
    const vars = Object.keys(files).filter((k) => k.startsWith(`${key}.`) && /^\d+$/.test(k.slice(key.length + 1)));
    if (!vars.length) return null;
    return vars[Math.floor(((this.rnd() + 1) / 2) * vars.length) % vars.length];
  }

  private buffer(key: string): Promise<AudioBuffer | null> {
    const g = this.g();
    const e = this.manifest?.files[key];
    if (!g || !e) return Promise.resolve(null);
    const base = this.manifest?.base ?? '/assets/';
    const url = `${base.replace(/\/$/, '')}/${e.url}`;
    let p = this.buffers.get(url);
    if (!p) {
      p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((ab) => g.ac.decodeAudioData(ab))
        .catch(() => null);
      this.buffers.set(url, p);
    }
    return p;
  }

  /** warm the decode cache for keys (e.g. at contract start) */
  preload(keys: string[]): void {
    void this.loadManifest().then(() => { for (const k of keys) { const r = this.resolveKey(k); if (r) void this.buffer(r); } });
  }

  play(key: string, pos?: V3 | null, opts: SfxPlayOpts = {}): SfxHandle | null {
    const g = this.g();
    if (!g) return null;
    if (opts.id) this.byId.get(opts.id)?.stop();
    if (!this.manifest) {
      // first call before the manifest: load it and play when ready (still returns a stoppable handle)
      const live: Live = { src: null, panner: null, lp: null, out: g.ac.createGain(), pos: pos ?? null, stopped: false, loop: !!opts.loop };
      const h: SfxHandle = { stop: () => this.stopLive(live) };
      void this.loadManifest().then(() => { if (!live.stopped) this.start(live, key, opts); });
      if (opts.id) this.byId.set(opts.id, h);
      return h;
    }
    if (!this.resolveKey(key)) return null;
    const live: Live = { src: null, panner: null, lp: null, out: g.ac.createGain(), pos: pos && !opts.ui ? pos : null, stopped: false, loop: !!opts.loop };
    this.start(live, key, opts);
    const h: SfxHandle = {
      stop: () => this.stopLive(live),
      setPos: (p) => { live.pos = p; if (live.panner) setPannerPos(live.panner, g.ac, p, 0.05); },
    };
    if (opts.id) this.byId.set(opts.id, h);
    return h;
  }

  private start(live: Live, key: string, opts: SfxPlayOpts): void {
    const g = this.g();
    const rk = this.resolveKey(key);
    if (!g || !rk) return;
    void this.buffer(rk).then((buf) => {
      if (!buf || live.stopped) return;
      const ac = g.ac;
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = !!opts.loop;
      src.playbackRate.value = opts.rate ?? 1;
      live.out.gain.value = opts.volume ?? 1;
      let node: AudioNode = src;
      if (live.pos) {
        const lp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 20000, Q: 0.5 });
        const radius = opts.radius ?? 30;
        const panner = new PannerNode(ac, {
          panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1.5, maxDistance: Math.max(2, radius), rolloffFactor: 1.2,
          positionX: live.pos[0], positionY: live.pos[1], positionZ: live.pos[2],
        });
        node.connect(lp);
        lp.connect(panner);
        node = panner;
        live.lp = lp;
        live.panner = panner;
        this.occlude(live);
      }
      node.connect(live.out).connect(g.sfxBus);
      live.src = src;
      src.onended = () => { if (!live.loop) this.cleanup(live); };
      src.start();
      this.live.add(live);
    });
  }

  private occlude(live: Live): void {
    if (!live.lp || !live.pos) return;
    const lp = listenerPose(this.ctx);
    const { grid, doorOpen } = levelGrid(this.ctx);
    if (!lp || !grid) return;
    const walls = wallCrossings(grid, lp.pos[0], lp.pos[2], live.pos[0], live.pos[2], doorOpen);
    const o = occlusionParams(walls, this.lowpassHz, this.perWallDb);
    const ac = live.lp.context;
    live.lp.frequency.setTargetAtTime(o.freq, ac.currentTime, 0.05);
  }

  /** re-run occlusion for long / looping sounds (called ~5 Hz) */
  update(): void {
    for (const l of this.live) if (l.loop) this.occlude(l);
  }

  private stopLive(live: Live): void {
    if (live.stopped) return;
    live.stopped = true;
    const ac = live.out.context;
    live.out.gain.setTargetAtTime(0, ac.currentTime, 0.03);
    setTimeout(() => {
      try { live.src?.stop(); } catch { /* not started */ }
      this.cleanup(live);
    }, 150);
  }

  private cleanup(live: Live): void {
    this.live.delete(live);
    try { live.out.disconnect(); } catch { /* ignore */ }
  }
}
