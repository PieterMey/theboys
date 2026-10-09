// Owner: G3 interaction (v1.3 F3, flag fieldReceiver). The field receiver's ears and voice:
// - on the air: a monster cue ('monsters.cue', broadcast to the whole crew) reaches a listening player when it is within
//   receiverRangeMult x the cue's own radius (straight line) AND receiverPathM by sound path (the monsters' hearing
//   metric: walls block, doors cost extra) from them; it plays again through the radio, louder the shorter the path,
//   panned by its bearing;
// - ear to a door: every monster on the open floor behind the door (the space behind it and whatever opens off it
//   without another door, within the same path budget) gives its tell on the radio every ~2 s (a sniff, a click, a
//   creak; never breath: that is the Listener's retreat cue);
// - the radio chain: high-pass 320 / low-pass 3000 / a mid lift / drive + a soft clip, a hiss bed while the receiver is
//   open, straight to the output with the player's own master x sfx volume. It is in your ear, so muffling your own
//   hearing (sfx.muffle, E5) leaves it clear.
// Pure helpers (onAir, airGain, airPan, spaceAcross, farPoint, dueTells, AirField) are unit-tested in Node
// (tests/gear/f3.test.ts).
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { assetUrl, assetVariants, getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
import { ALL_CLOSED, buildEdgeGrid, fieldAt, pathDistanceField, soundFlood } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';

/** monster cue -> [sfx key, volume, rate] as the monsters client plays it (its CUE_SFX is not exported: mirrored here) */
export const CUE_SOUND: Readonly<Record<string, readonly [string, number, number?]>> = {
  growl: ['sfx.hound_growl_low', 1], huff: ['sfx.hound_alert_huff', 0.9], bark: ['sfx.hound_charge_bark', 1], sniff: ['sfx.hound_sniff', 0.8],
  eat: ['sfx.hound_eating', 0.9], lunge: ['sfx.hound_charge_bark', 1], creak: ['sfx.mannequin_creak', 0.85], click: ['sfx.listener_click_tick', 0.85],
  vent: ['sfx.listener_vent_crawl', 1], scream: ['sfx.creature_scream', 1], breath: ['sfx.creature_breath', 0.7], notice: ['sfx.listener_click_tick', 0.9, 0.62],
  rattle: ['sfx.listener_vent_crawl', 0.85, 1.12], tick: ['sfx.listener_click_tick', 0.5, 1.38], snatch: ['sfx.creature_scream', 1, 0.9],
  scratch: ['sfx.mannequin_scrape', 0.7, 0.85], shriek: ['sfx.creature_scream', 1, 1.3],
};

/** what a monster behind a door gives away on the receiver: [sfx key, volume, rate] (no breath, no whisper) */
export const TELL_SOUND: Readonly<Record<string, readonly [string, number, number]>> = {
  hound: ['sfx.hound_sniff', 0.6, 0.92], listener: ['sfx.listener_click_tick', 0.65, 0.84], mannequin: ['sfx.mannequin_creak', 0.55, 0.9],
  snatcher: ['sfx.listener_vent_crawl', 0.45, 1.1],
};

export interface AirCfg {
  /** a cue carries this many times its own radius on the air */
  mult: number;
  /** and never beyond this sound path (m) */
  maxPath: number;
}

/** a cue d m away (straight) with its own audible radius, path m away by sound path: on the air? */
export function onAir(d: number, radius: number, path: number, cfg: AirCfg): boolean {
  return Number.isFinite(d) && Number.isFinite(path) && radius > 0 && d <= radius * cfg.mult && path <= cfg.maxPath;
}

/** loudness on the air: 1 up close, falling with the sound path to 0.2 at the reach */
export function airGain(path: number, reach: number): number {
  if (!(reach > 0) || !Number.isFinite(path)) return 0;
  const k = Math.max(0, Math.min(1, path / reach));
  return 1 - 0.8 * Math.sqrt(k);
}

/** -1 (left) .. 1 (right): the bearing of (sx, sz) seen from (ox, oz) facing (fx, fz) (three: right = (-fz, fx)) */
export function airPan(fx: number, fz: number, ox: number, oz: number, sx: number, sz: number): number {
  const fl = Math.hypot(fx, fz), dx = sx - ox, dz = sz - oz, dl = Math.hypot(dx, dz);
  if (fl < 1e-6 || dl < 1e-6) return 0;
  const p = (dx * -fz + dz * fx) / (fl * dl);
  return Math.max(-1, Math.min(1, p)) * 0.85;
}

/** the space across a door's edge from (px, pz) (the server's farSpaceOf), -1 = none */
export function spaceAcross(L: Pick<LevelLayout, 'W' | 'H' | 'owner' | 'doors'>, doorId: number, px: number, pz: number): number {
  const d = L.doors.find((x) => x.id === doorId);
  if (!d) return -1;
  const cx = d.dir === 'v' ? d.x : d.x + d.len / 2, cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
  const x = d.dir === 'v' ? cx + (px < cx ? 0.5 : -0.5) : cx, z = d.dir === 'v' ? cz : cz + (pz < cz ? 0.5 : -0.5);
  const ix = Math.floor(x), iz = Math.floor(z);
  return ix < 0 || iz < 0 || ix >= L.W || iz >= L.H ? -1 : (L.owner[iz * L.W + ix] ?? -1);
}

/** sound-path distances from the listener (budget maxPath), rebuilt on demand; the edge grid is cached per layout.
 *  region(): the open floor behind a door (ear to the door): every cell reachable from the far side without crossing
 *  another door, a wall or a fence (a junction and the corridor running on from it count; the room past the next door
 *  does not), by walking distance. */
export class AirField {
  private layout: LevelLayout | null = null;
  private grid: EdgeGrid | null = null;
  private field: Float32Array | null = null;
  private behind: Float32Array | null = null;
  private use(L: LevelLayout | null): EdgeGrid | null {
    if (!L) { this.layout = null; this.grid = null; this.field = null; this.behind = null; return null; }
    if (L !== this.layout) {
      this.layout = L;
      try { this.grid = buildEdgeGrid(L); } catch { this.grid = null; }
      this.field = null;
      this.behind = null;
    }
    return this.grid;
  }
  update(L: LevelLayout | null, x: number, z: number, budget: number, doorOpen: DoorOpenFn): void {
    const g = this.use(L);
    if (!g) { this.field = null; return; }
    this.field = soundFlood(g, x, z, budget, doorOpen, this.field ?? undefined);
  }
  /** sound path (m) to (x, z), Infinity beyond the budget / unknown */
  at(x: number, z: number): number {
    return this.grid && this.field ? fieldAt(this.grid, this.field, x, z) : Infinity;
  }
  /** the open floor behind a door from its far-side point (x, z) within budget m; null clears it */
  region(L: LevelLayout | null, x: number, z: number, budget: number): void {
    const g = this.use(L);
    if (!g || !Number.isFinite(x) || !Number.isFinite(z)) { this.behind = null; return; }
    this.behind = pathDistanceField(g, x, z, { mode: 'walk', doorOpen: ALL_CLOSED, budget }, this.behind ?? undefined);
  }
  clearRegion(): void { this.behind = null; }
  /** walking distance (m) from the far side of the door to (x, z) on that open floor; Infinity = not behind the door */
  behindAt(x: number, z: number): number {
    return this.grid && this.behind ? fieldAt(this.grid, this.behind, x, z) : Infinity;
  }
}

/** a monster as the snapshots carry it (only what the tells need) */
export interface TellMonster { id: string; kind: string; x: number; z: number; active: boolean }
/** the far side of a door from (px, pz): 0.5 m past its centre across its edge (null = no such door) */
export function farPoint(L: Pick<LevelLayout, 'doors'>, doorId: number, px: number, pz: number): [number, number] | null {
  const d = L.doors.find((x) => x.id === doorId);
  if (!d) return null;
  const cx = d.dir === 'v' ? d.x : d.x + d.len / 2, cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
  return d.dir === 'v' ? [cx + (px < cx ? 0.5 : -0.5), cz] : [cx, cz + (pz < cz ? 0.5 : -0.5)];
}
/** the tells due now: active monsters behind the door (behindAt finite, within maxPath), each at most once every
 *  1.7-2.4 s (a fixed per-id stagger in `next`, server ms or performance.now: one clock). out is reused. */
export function dueTells(list: readonly TellMonster[], behindAt: (x: number, z: number) => number, maxPath: number, now: number,
  next: Map<string, number>, out: { id: string; kind: string; path: number }[] = []): { id: string; kind: string; path: number }[] {
  out.length = 0;
  for (const m of list) {
    if (!m.active) continue;
    const path = behindAt(m.x, m.z);
    if (!(path <= maxPath) || now < (next.get(m.id) ?? -Infinity)) continue;
    let h = 0;
    for (let i = 0; i < m.id.length; i++) h = (h * 31 + m.id.charCodeAt(i)) >>> 0;
    next.set(m.id, now + 1700 + (h % 700));
    if (TELL_SOUND[m.kind]) out.push({ id: m.id, kind: m.kind, path });
  }
  return out;
}

/** one clip the receiver played (or would have, without audio): tests read these */
export interface AirLog { key: string; why: string; gain: number; pan: number; played: boolean; t: number }

function crunch(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return c;
}

/** the receiver's radio chain on the ONE AudioContext (ctx.audio.ctx; nothing happens before the join unlocked it) */
export class RadioOut {
  readonly log: AirLog[] = [];
  private readonly getAc: () => AudioContext | null;
  private readonly volume: () => number;
  private ac: AudioContext | null = null;
  private out: GainNode | null = null;
  private hiss: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private noise: AudioBuffer | null = null;
  private curve: Float32Array<ArrayBuffer> | null = null;
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();

  constructor(getAc: () => AudioContext | null, volume: () => number) {
    this.getAc = getAc;
    this.volume = volume;
  }

  private ensure(): { ac: AudioContext; out: GainNode } | null {
    const ac = this.getAc();
    if (!ac) return null;
    if (ac !== this.ac || !this.out) {
      this.ac = ac;
      this.out = new GainNode(ac, { gain: this.volume() });
      this.out.connect(ac.destination);
      this.buffers.clear();
      this.noise = null;
      this.hiss = null;
    }
    return { ac, out: this.out };
  }

  /** the receiver opens: the output follows the volume settings again, a faint hiss bed starts */
  open(): void {
    const e = this.ensure();
    if (!e) return;
    const t = e.ac.currentTime;
    e.out.gain.setTargetAtTime(this.volume(), t, 0.02);
    if (this.hiss) return;
    if (!this.noise) {
      // deterministic noise (audio texture only)
      const len = Math.floor(e.ac.sampleRate);
      this.noise = e.ac.createBuffer(1, len, e.ac.sampleRate);
      const d = this.noise.getChannelData(0);
      let s = 0x2545f491;
      for (let i = 0; i < len; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; d[i] = s / 2147483648 - 1; }
    }
    const src = new AudioBufferSourceNode(e.ac, { buffer: this.noise, loop: true });
    const bp = new BiquadFilterNode(e.ac, { type: 'bandpass', frequency: 2300, Q: 0.7 });
    const gain = new GainNode(e.ac, { gain: 0 });
    src.connect(bp).connect(gain).connect(e.out);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.015);
    gain.gain.linearRampToValueAtTime(0.035, t + 0.12);
    src.start(t);
    this.hiss = { src, gain };
  }

  /** the receiver closes: a short squelch tail, the hiss stops */
  close(): void {
    const h = this.hiss;
    this.hiss = null;
    if (!h || !this.ac) return;
    const t = this.ac.currentTime;
    h.gain.gain.cancelScheduledValues(t);
    h.gain.gain.setValueAtTime(h.gain.gain.value, t);
    h.gain.gain.linearRampToValueAtTime(0.16, t + 0.012);
    h.gain.gain.linearRampToValueAtTime(0, t + 0.09);
    try { h.src.stop(t + 0.12); } catch { /* already stopped */ }
  }

  /** a clip on the air: gain 0..1, pan -1..1, playback rate; why = what it is (tests) */
  play(key: string, gain: number, pan: number, rate: number, why: string): void {
    const e = this.ensure();
    const entry: AirLog = { key, why, gain: Math.round(gain * 1000) / 1000, pan: Math.round(pan * 1000) / 1000, played: false, t: Math.round(performance.now()) };
    this.log.push(entry);
    if (this.log.length > 64) this.log.shift();
    if (!e || !(gain > 0.001)) return;
    void this.buffer(key).then((buf) => {
      if (!buf || this.ac !== e.ac) return;
      const ac = e.ac;
      this.curve ??= crunch(5);
      const when = ac.currentTime + 0.01;
      const src = new AudioBufferSourceNode(ac, { buffer: buf, playbackRate: Math.max(0.5, Math.min(2, rate)) });
      const hp = new BiquadFilterNode(ac, { type: 'highpass', frequency: 320, Q: 0.7 });
      const lp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 3000, Q: 0.7 });
      const mid = new BiquadFilterNode(ac, { type: 'peaking', frequency: 1700, Q: 1, gain: 6 });
      const drive = new GainNode(ac, { gain: 2 });
      const shaper = new WaveShaperNode(ac, { curve: this.curve, oversample: '2x' });
      const v = new GainNode(ac, { gain: 0.55 * Math.min(1, gain) });
      const pn = new StereoPannerNode(ac, { pan: Math.max(-1, Math.min(1, pan)) });
      src.connect(hp).connect(lp).connect(mid).connect(drive).connect(shaper).connect(v).connect(pn).connect(e.out);
      src.start(when);
      src.onended = () => { try { pn.disconnect(); } catch { /* gone */ } };
      entry.played = true;
    });
  }

  private buffer(key: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(key);
    if (!p) {
      const ac = this.ac;
      p = (getAssetManifest() ? Promise.resolve(getAssetManifest()) : loadAssetManifest().catch(() => null)).then((m) => {
        if (!m || !ac) return null;
        const vars = assetVariants(key);
        const url = assetUrl(key) ?? (vars.length ? assetUrl(vars[0]!) : null);
        if (!url) return null;
        return fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then((ab) => ac.decodeAudioData(ab));
      }).catch(() => { this.buffers.delete(key); return null; });
      this.buffers.set(key, p);
      if (this.buffers.size > 24) this.buffers.delete(this.buffers.keys().next().value as string);
    }
    return p;
  }
}
