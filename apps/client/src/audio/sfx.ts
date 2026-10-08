// Owner: env-audio (v1.2; was track ④ Voice/audio). services.sfx.play(key, pos?, opts?) -> { stop() } | null.
// Keys from /assets/manifest.json (packages/shared/src/assets.ts). Missing keys are silently ignored (null).
// 'sfx.door_open' picks a random present variant ('sfx.door_open.1', '.2', ...). Buffers decode lazily, cached.
// Spatial: PannerNode (equalpower, inverse, refDistance 1.5) + the wall lowpass (same wall test as voice). 2D without pos.
// v1.2: a sound played with opts.occlude === true (ambience, paranormal, synth) also gets the occlusion GAIN and a
// per-sound reverb send (acoustics.ts: room size, surface, theme; config/balance/audio.json). Every other sound
// (monsters, items, UI) keeps the v1.1 chain: lowpass only (audio.json legacyLowpassHz), its gain untouched and no
// send, unless audio.json occludeMonsters is signed off. playVoice() runs synth plans through the same chain.
import { ASSET_MANIFEST_URL } from '@dead-air/shared/assets.ts';
import type { AssetManifest } from '@dead-air/shared/assets.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { ClientContext } from '../core/context.ts';
import type { AudioGraph, ListenerPose, V3 } from './graph.ts';
import { listenerPose, makeNoise, setPannerPos, targetTo, useLoose } from './graph.ts';
import { levelGrid, wallCrossings } from './occlusion.ts';
import type { AudioCfg } from './config.ts';
import { legacyLowpass, occlusionOf, reverbSend, roomInfo, spaceAt } from './acoustics.ts';
import type { RoomInfo } from './acoustics.ts';
import type { PlayedPlan } from './synth.ts';

export interface SfxPlayOpts {
  volume?: number;
  loop?: boolean;
  radius?: number;
  id?: string;
  rate?: number;
  ui?: boolean;
  /** v1.2: occlusion gain + per-sound reverb send (ambience, paranormal). Monsters / items / UI leave it unset. */
  occlude?: boolean;
}
export interface SfxHandle { stop(): void; setPos?(p: V3): void }

/** builds a synth plan into `input` (synth.playPlan) */
export type VoiceBuild = (ac: AudioContext, input: AudioNode, when: number, noise: AudioBuffer) => PlayedPlan | null;
export type SfxBus = 'sfx' | 'amb';

interface Live {
  src: AudioBufferSourceNode | null;
  /** synth: every node of the plan and its sources */
  extra: AudioNode[] | null;
  sources: AudioScheduledSourceNode[] | null;
  panner: PannerNode | null;
  lp: BiquadFilterNode | null;
  /** occluded sounds only */
  occ: GainNode | null;
  send: GainNode | null;
  room: RoomInfo | null;
  out: GainNode;
  pos: V3 | null;
  stopped: boolean;
  loop: boolean;
  occlude: boolean;
  vol: number;
  radius: number;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
  nodes: number;
  /** node accounting: asset sounds vs synth voices */
  tag: 'sfx' | 'synth';
}

interface Hear { lp: ListenerPose | null; grid: EdgeGrid | null; doorOpen: ((id: number) => boolean) | null }

export class SfxEngine {
  private ctx: ClientContext;
  private g: () => AudioGraph | null;
  private cfg: () => AudioCfg;
  private manifest: AssetManifest | null = null;
  private manifestP: Promise<AssetManifest | null> | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private live = new Set<Live>();
  private byId = new Map<string, SfxHandle>();
  private rnd = makeNoise(0x5eed);
  private count = { sfx: 0, synth: 0 };

  constructor(ctx: ClientContext, g: () => AudioGraph | null, cfg: () => AudioCfg) {
    this.ctx = ctx;
    this.g = g;
    this.cfg = cfg;
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

  /** live sounds / their nodes (debug: returns to the baseline once everything ended) */
  liveCount(): number { return this.live.size; }
  nodes(): number { return this.count.sfx + this.count.synth; }
  /** nodes / live sounds per kind: asset sounds ('sfx') and synth voices ('synth') */
  nodesBy(): { sfx: number; synth: number; liveSfx: number; liveSynth: number } {
    let liveSynth = 0;
    for (const l of this.live) if (l.tag === 'synth') liveSynth++;
    return { sfx: this.count.sfx, synth: this.count.synth, liveSfx: this.live.size - liveSynth, liveSynth };
  }

  private grow(live: Live, n: number): void {
    live.nodes += n;
    this.count[live.tag] += n;
  }

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

  /** occlusion + reverb send for this sound? Only when asked (or when audio.json occludeMonsters is signed off) */
  private wantsOcclusion(pos: V3 | null | undefined, opts: SfxPlayOpts): boolean {
    if (opts.occlude === true) return !!pos && !opts.ui;
    if (opts.occlude === false) return false;
    return this.cfg().occludeMonsters === true && !!pos && !opts.ui;
  }

  private newLive(g: AudioGraph, pos: V3 | null, opts: SfxPlayOpts, occlude: boolean, bus: SfxBus = 'sfx', tag: 'sfx' | 'synth' = 'sfx'): Live {
    const out = g.ac.createGain();
    out.connect(bus === 'amb' ? g.ambBus : g.sfxBus);
    const vol = Number.isFinite(opts.volume) ? (opts.volume as number) : 1;
    this.count[tag]++;
    return {
      src: null, extra: null, sources: null, panner: null, lp: null, occ: null, send: null, room: null, out, pos,
      stopped: false, loop: !!opts.loop, occlude: occlude && !!pos, vol, radius: opts.radius ?? 30, timer: null, done: false, nodes: 1, tag,
    };
  }

  play(key: string, pos?: V3 | null, opts: SfxPlayOpts = {}): SfxHandle | null {
    const g = this.g();
    if (!g) return null;
    if (opts.id) this.byId.get(opts.id)?.stop();
    const p = pos && !opts.ui ? pos : null;
    const occlude = this.wantsOcclusion(p, opts);
    if (!this.manifest) {
      // first call before the manifest: load it and play when ready (still returns a stoppable handle)
      const live = this.newLive(g, p, opts, occlude);
      const h: SfxHandle = { stop: () => this.stopLive(live) };
      void this.loadManifest().then(() => { if (!live.stopped) this.start(live, key, opts); else this.cleanup(live); });
      if (opts.id) this.byId.set(opts.id, h);
      return h;
    }
    if (!this.resolveKey(key)) return null;
    const live = this.newLive(g, p, opts, occlude);
    this.start(live, key, opts);
    const h: SfxHandle = {
      stop: () => this.stopLive(live),
      setPos: (np) => this.setPos(live, np),
    };
    if (opts.id) this.byId.set(opts.id, h);
    return h;
  }

  /** run a synth plan through the positional chain (pos null or opts.ui = 2D); null when audio is locked */
  playVoice(build: VoiceBuild, pos: V3 | null, opts: SfxPlayOpts = {}, bus: SfxBus = 'sfx'): SfxHandle | null {
    const g = this.g();
    if (!g) return null;
    if (opts.id) this.byId.get(opts.id)?.stop();
    const p = pos && !opts.ui ? pos : null;
    const live = this.newLive(g, p, opts, this.wantsOcclusion(p, opts), bus, 'synth');
    live.out.gain.value = live.vol;
    const input = this.chain(live, g, null);
    let played: PlayedPlan | null = null;
    try {
      played = build(g.ac, input, g.ac.currentTime + 0.01, g.noise);
    } catch (e) {
      this.cleanup(live);
      throw e;
    }
    if (!played) {
      this.cleanup(live);
      return null;
    }
    live.extra = played.nodes;
    live.sources = played.sources;
    this.grow(live, played.nodes.length);
    if (played.last) played.last.onended = () => this.cleanup(live);
    // safety net if onended never fires (suspended context): well after the plan's end
    live.timer = setTimeout(() => this.cleanup(live), Math.max(0, (played.end - g.ac.currentTime) * 1000) + 2000);
    this.live.add(live);
    const h: SfxHandle = { stop: () => this.stopLive(live), setPos: (np) => this.setPos(live, np) };
    if (opts.id) this.byId.set(opts.id, h);
    return h;
  }

  private setPos(live: Live, p: V3): void {
    const g = this.g();
    if (!g || !live.pos) return;
    live.pos = p;
    live.room = null;
    if (live.panner) setPannerPos(live.panner, g.ac, p, 0.05);
  }

  /** the positional chain (lowpass -> [occlusion gain] -> panner -> out, lowpass -> send -> reverb); returns its input */
  private chain(live: Live, g: AudioGraph, hear: Hear | null): AudioNode {
    if (!live.pos) return live.out;
    const ac = g.ac;
    const lp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 20000, Q: 0.5 });
    const panner = new PannerNode(ac, {
      panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1.5, maxDistance: Math.max(2, live.radius), rolloffFactor: 1.2,
      positionX: live.pos[0], positionY: live.pos[1], positionZ: live.pos[2],
    });
    if (live.occlude) {
      const occ = new GainNode(ac, { gain: 1 });
      const send = new GainNode(ac, { gain: 0 });
      lp.connect(occ).connect(panner);
      lp.connect(send).connect(g.reverb);
      live.occ = occ;
      live.send = send;
      this.grow(live, 2);
    } else lp.connect(panner);
    panner.connect(live.out);
    live.lp = lp;
    live.panner = panner;
    this.grow(live, 2);
    this.occlude(live, hear ?? this.hear(), true);
    return lp;
  }

  private start(live: Live, key: string, opts: SfxPlayOpts): void {
    const g = this.g();
    const rk = this.resolveKey(key);
    if (!g || !rk) { this.cleanup(live); return; }
    void this.buffer(rk).then((buf) => {
      if (!buf || live.stopped) { this.cleanup(live); return; }
      const ac = g.ac;
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = !!opts.loop;
      src.playbackRate.value = opts.rate ?? 1;
      live.out.gain.value = live.vol;
      const input = this.chain(live, g, null);
      src.connect(input);
      live.src = src;
      this.grow(live, 1);
      src.onended = () => { if (!live.loop) this.cleanup(live); };
      src.start();
      this.live.add(live);
    });
  }

  private hear(): Hear {
    const { grid, doorOpen } = levelGrid(this.ctx);
    return { lp: listenerPose(this.ctx), grid, doorOpen };
  }

  private roomOf(p: V3): RoomInfo | null {
    const L = this.ctx.world.layout;
    if (!L) return null;
    const sp = spaceAt(L, p[0], p[2]);
    if (sp < 0) return null;
    let surf: string | null = null;
    try { surf = useLoose<{ surfaceAt?(x: number, z: number): string }>(this.ctx, 'level')?.surfaceAt?.(p[0], p[2]) ?? null; } catch { surf = null; }
    return roomInfo(L, sp, surf);
  }

  private occlude(live: Live, h: Hear, first = false): void {
    if (!live.lp || !live.pos) return;
    const lp = h.lp, grid = h.grid;
    if (!lp || !grid) return;
    const ac = live.lp.context;
    const t = ac.currentTime;
    const cfg = this.cfg();
    if (!live.occlude) {
      // v1.1 behaviour (monsters, items): the lowpass only, its gain untouched, no reverb send
      const walls = wallCrossings(grid, lp.pos[0], lp.pos[2], live.pos[0], live.pos[2], h.doorOpen);
      live.lp.frequency.setTargetAtTime(legacyLowpass(walls, cfg), t, 0.05);
      return;
    }
    const walls = wallCrossings(grid, lp.pos[0], lp.pos[2], live.pos[0], live.pos[2], h.doorOpen, cfg.closedDoorWallFrac);
    const o = occlusionOf(walls, cfg);
    live.room ??= this.roomOf(live.pos);
    const d = Math.hypot(lp.pos[0] - live.pos[0], lp.pos[1] - live.pos[1], lp.pos[2] - live.pos[2]);
    const send = live.vol * reverbSend(live.room, d, o.gain, cfg.reverb);
    if (first) {
      // a one-shot's attack must already be behind the wall: set the values before the source starts
      live.lp.frequency.value = o.freq;
      if (live.occ) live.occ.gain.value = o.gain;
      if (live.send) live.send.gain.value = Number.isFinite(send) ? send : 0;
      return;
    }
    targetTo(live.lp.frequency, o.freq, t, 0.05);
    if (live.occ) targetTo(live.occ.gain, o.gain, t, 0.05);
    if (live.send && !live.stopped) targetTo(live.send.gain, send, t, 0.05);
  }

  /** re-run occlusion for long / looping / occluded sounds (called ~25 Hz) */
  update(): void {
    if (!this.live.size) return;
    const h = this.hear();
    for (const l of this.live) if (l.loop || l.occlude) this.occlude(l, h);
  }

  /** occlusion + send a sound at pos would get now (debug) */
  probe(pos: V3): { walls: number; gain: number; freq: number; send: number; legacyHz: number } | null {
    const h = this.hear();
    if (!h.lp || !h.grid) return null;
    const cfg = this.cfg();
    const walls = wallCrossings(h.grid, h.lp.pos[0], h.lp.pos[2], pos[0], pos[2], h.doorOpen, cfg.closedDoorWallFrac);
    const o = occlusionOf(walls, cfg);
    const d = Math.hypot(h.lp.pos[0] - pos[0], h.lp.pos[1] - pos[1], h.lp.pos[2] - pos[2]);
    const legacyWalls = wallCrossings(h.grid, h.lp.pos[0], h.lp.pos[2], pos[0], pos[2], h.doorOpen);
    return { walls, gain: o.gain, freq: o.freq, send: reverbSend(this.roomOf(pos), d, o.gain, cfg.reverb), legacyHz: legacyLowpass(legacyWalls, cfg) };
  }

  private stopLive(live: Live): void {
    if (live.stopped) return;
    live.stopped = true;
    const ac = live.out.context;
    live.out.gain.setTargetAtTime(0, ac.currentTime, 0.03);
    if (live.send) { try { live.send.gain.cancelScheduledValues(ac.currentTime); live.send.gain.setTargetAtTime(0, ac.currentTime, 0.03); } catch { /* ignore */ } }
    setTimeout(() => {
      try { live.src?.stop(); } catch { /* not started */ }
      for (const s of live.sources ?? []) { try { s.stop(); } catch { /* not started */ } }
      this.cleanup(live);
    }, 150);
  }

  private cleanup(live: Live): void {
    if (live.done) return;
    live.done = true;
    if (live.timer) clearTimeout(live.timer);
    this.live.delete(live);
    for (const n of live.extra ?? []) { try { n.disconnect(); } catch { /* ignore */ } }
    for (const n of [live.src, live.lp, live.occ, live.send, live.panner, live.out]) {
      if (!n) continue;
      try { n.disconnect(); } catch { /* ignore */ }
    }
    this.count[live.tag] -= live.nodes;
  }
}
