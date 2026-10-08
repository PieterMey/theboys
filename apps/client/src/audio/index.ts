// Owner: env-audio (v1.2; was track ④ Voice (audio)). SFX engine + procedural ambience on the ONE AudioContext.
// services.sfx: play(key, pos?, opts?) -> { stop() } | null (opts.occlude: occlusion gain + reverb send, sfx.ts);
// synth(kind, pos?, opts?) -> seeded procedural sounds (synth.ts); fear(source, v, ms?) -> the heartbeat follows the
// maximum over sources, setFear(v) = fear('default', v) (fear.ts); setStatic(0..1); flicker(space, ms); setAmbience(on).
// Bus 'audio:flicker' { space, ms } stutters the hums of a space (when render has no fixtureLevels).
// Every frame: power-aware hums (hums.ts) from render.fixtureLevels() (fallback: level.fixtures x interaction lights);
// ~25 Hz: heartbeat, occlusion of long / occluded sounds, the listener-room reverb blend (acoustics.ts), theme beds.
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import { applyListener, getGraph, listenerPose, useLoose } from './graph.ts';
import type { AudioGraph, ListenerPose, V3 } from './graph.ts';
import { SfxEngine } from './sfx.ts';
import type { SfxBus, SfxHandle, SfxPlayOpts } from './sfx.ts';
import { Ambience } from './ambience.ts';
import { readAudioCfg } from './config.ts';
import type { AudioCfg } from './config.ts';
import { FearMix, smoothFear } from './fear.ts';
import { Hums, fallbackLevel, humVoiceOf } from './hums.ts';
import type { HumEvent, HumFixture } from './hums.ts';
import { Beds } from './beds.ts';
import { SYNTH_KINDS, isPlanKind, planSynth, playPlan } from './synth.ts';
import type { PlanKind } from './synth.ts';
import type { SynthOpts } from './api.ts';
import { irBlend, occlusionOf, roomAtXZ, spaceAt, wetLevel } from './acoustics.ts';
import type { RoomInfo } from './acoustics.ts';
import { levelGrid, wallCrossings } from './occlusion.ts';

export type { SfxHandle, SfxPlayOpts } from './sfx.ts';

declare module '../core/services.ts' {
  interface SfxService {
    /** play a manifest key (or a variant family like 'sfx.door_open'); spatial with pos, 2D without. null if missing. */
    play(id: string, pos?: Vec3, opts?: SfxPlayOpts): SfxHandle | null;
    has(key: string): boolean;
    preload(keys: string[]): void;
    /** heartbeat intensity 0..1 (= fear('default', v)) */
    setFear(v: number): void;
    /** radio static level 0..1 */
    setStatic(v: number): void;
    /** fluorescent hum stutter for a space (sync with render flicker) */
    flicker(space: number, ms: number): void;
    /** tension drone on/off (auto: on during contracts) */
    setAmbience(on: boolean): void;
  }
}
declare module '../core/bus.ts' {
  interface BusEvents {
    'audio:flicker': { space: number; ms: number };
  }
}

interface LevelLike { fixtures?: readonly HumFixture[]; surfaceAt?(x: number, z: number): string }
interface RenderLike { fixtureLevels?(): ArrayLike<number> }
interface InteractionLike { state?(): { lights?: Record<number, boolean> } | null }

const MAX_HUM_EVENTS = 3;

export function install(ctx: ClientContext): void {
  const cfg: AudioCfg = readAudioCfg(ctx.balance.audio);
  let graph: AudioGraph | null = null;
  let amb: Ambience | null = null;
  let hums: Hums | null = null;
  let beds: Beds | null = null;
  const fearMix = new FearMix();
  let fearNow = 0;
  let ambOverride: boolean | null = null;
  /** space -> performance.now() until which its hums stutter (fallback path) */
  const flickers = new Map<number, number>();
  let cosmetic = 0x51ed;
  const nextSeed = () => (cosmetic = (cosmetic * 1103515245 + 12345) >>> 0);
  const g = () => {
    const ac = ctx.audio.ctx;
    if (!ac) return null;
    graph ??= getGraph(ac);
    return graph;
  };
  const engine = new SfxEngine(ctx, g, () => cfg);

  const synth = (kind: PlanKind, pos: Vec3 | V3 | null | undefined, opts: SynthOpts = {}, bus: SfxBus = 'sfx'): SfxHandle | null => {
    if (!isPlanKind(kind) || !g()) return null;
    const plan = planSynth(kind, opts);
    if (!plan || !plan.voices.length) return null;
    const p: V3 | null = pos && !opts.ui && Number.isFinite(pos[0]) && Number.isFinite(pos[1]) && Number.isFinite(pos[2]) ? [pos[0], pos[1], pos[2]] : null;
    return engine.playVoice((ac, input, when, noise) => playPlan(ac, plan, input, noise, when, 1), p, {
      volume: Number.isFinite(opts.volume) ? opts.volume : 1, radius: opts.radius ?? plan.radius, occlude: opts.occlude !== false,
      ...(opts.ui ? { ui: true } : {}), ...(opts.id ? { id: opts.id } : {}),
    }, bus);
  };

  const ensure = () => {
    const gr = g();
    if (!gr) return null;
    amb ??= new Ambience(gr);
    hums ??= new Hums(gr, cfg.hum);
    beds ??= new Beds(gr, cfg.beds, { play: (k, p, level, seed) => { synth(k, p, { seed, volume: level }, 'amb'); } });
    return amb;
  };
  const syncDrone = () => {
    const a = ensure();
    if (!a) return;
    const on = ambOverride ?? ctx.world.phase === 'contract';
    if (a.drone() !== on) a.setDrone(on);
  };
  const fear = (source: string, v: number, ms?: number) => fearMix.set(source, v, ms, performance.now());

  ctx.bus.on('audio:unlocked', () => {
    ensure();
    syncDrone();
    void engine.loadManifest();
  });
  ctx.bus.on('world:phase', () => {
    fearMix.clear();
    syncDrone();
  });
  ctx.bus.on('audio:flicker', ({ space, ms }) => { flickers.set(space, performance.now() + Math.max(0, ms)); });

  // ---- hum levels: render.fixtureLevels() when it lines up with level.fixtures, else state x lights x flicker.
  // stale = the frame loop is stalled (render's levels are frozen): the live light state may still darken a fixture
  // (a switch / blackout during a long GPU compile or in a hidden tab), but never revives one render has killed
  const levelSource = (fixtures: readonly HumFixture[], stale = false): ((i: number) => number) => {
    let levels: ArrayLike<number> | null = null;
    try { levels = useLoose<RenderLike>(ctx, 'render')?.fixtureLevels?.() ?? null; } catch { levels = null; }
    if (levels && levels.length === fixtures.length) {
      const lv = levels;
      if (!stale) return (i) => lv[i];
      const fb = fallbackSource(fixtures);
      return (i) => Math.min(lv[i], fb(i));
    }
    return fallbackSource(fixtures);
  };
  const fallbackSource = (fixtures: readonly HumFixture[]): ((i: number) => number) => {
    let lights: Record<number, boolean> | null = null;
    try { lights = useLoose<InteractionLike>(ctx, 'interaction')?.state?.()?.lights ?? null; } catch { lights = null; }
    const nowMs = performance.now();
    const t = nowMs / 1000;
    return (i) => {
      const f = fixtures[i];
      // battery kinds (emergency) ignore blackouts and switches; spaces without light state (hub) are powered
      const battery = f.battery === true || f.kind === 'emergency';
      const known = !!lights && Object.prototype.hasOwnProperty.call(lights, f.space);
      const powered = battery || !known || !!lights![f.space];
      return fallbackLevel(f, i, t, powered, (flickers.get(f.space) ?? 0) > nowMs);
    };
  };
  const onHum = (e: HumEvent, lp: ListenerPose | null) => {
    if (e.kind === 'tick') { synth('relay_tink', e.pos, { seed: nextSeed(), volume: cfg.hum.kinds.tick ?? 0.12, radius: 8 }); return; }
    if (!lp || Math.hypot(e.pos[0] - lp.pos[0], e.pos[2] - lp.pos[2]) > cfg.hum.tinkRadiusM) return;
    // several tubes of one room going dark together = a switch / a power loss: the ballasts clunk (single fixtures
    // dying one by one are the dark walk, which brings its own relay tinks and filament pops)
    if (e.kind === 'off' && e.count >= 2) synth('relay_tink', e.pos, { seed: nextSeed(), volume: cfg.hum.switchTink, rate: 0.7 });
    // tubes strike back on with their starter
    else if (e.kind === 'on' && (e.voice === 'tube' || e.voice === 'highbay')) synth('relay_tink', e.pos, { seed: nextSeed(), volume: cfg.hum.switchTink * 0.8, rate: 1.15 });
  };

  // ---- listener-room reverb (small dry room <-> hall), only on room changes
  let roomKey = '';
  let room: RoomInfo | null = null;
  const reverbByRoom = (lp: ListenerPose | null) => {
    const gr = g();
    if (!gr) return;
    const L = ctx.world.layout;
    const sp = L && lp ? spaceAt(L, lp.pos[0], lp.pos[2]) : -1;
    let surf: string | null = null;
    if (L && sp >= 0 && lp) {
      try { surf = useLoose<LevelLike>(ctx, 'level')?.surfaceAt?.(lp.pos[0], lp.pos[2]) ?? null; } catch { surf = null; }
    }
    const inCab = !!L && !!lp && sp < 0 && !!L.van?.cab && (() => { const c = L.van.cab; return lp.pos[0] >= c.x && lp.pos[0] <= c.x + c.w && lp.pos[2] >= c.y && lp.pos[2] <= c.y + c.h; })();
    const key = `${L?.hash ?? ''}|${sp}|${surf ?? ''}|${inCab ? 'cab' : ''}`;
    if (key === roomKey) return;
    roomKey = key;
    room = L && lp ? roomAtXZ(L, lp.pos[0], lp.pos[2], surf) : null;
    gr.setReverbMix?.(irBlend(room, cfg.reverb), 0.6);
    gr.setReverbWet?.(wetLevel(room, cfg.reverb), 0.6);
  };

  // ---- test hooks
  let analyser: AnalyserNode | null = null;
  if (ctx.testMode) {
    (window as unknown as { __audioDebug?: unknown }).__audioDebug = {
      play: (k: string, pos?: Vec3, o?: SfxPlayOpts) => !!engine.play(k, pos ?? null, o),
      has: (k: string) => engine.has(k),
      manifest: () => engine.loadManifest().then((m) => (m ? Object.keys(m.files).filter((k) => k.startsWith('sfx.')).length : 0)),
      ambience: () => ({ drone: amb?.drone() ?? false, fear: fearNow }),
      fear: (v: number) => fear('default', v),
      // v1.2 (env-audio)
      kinds: () => [...SYNTH_KINDS],
      synth: (kind: string, pos?: Vec3 | null, o?: SynthOpts) => !!synth(kind as PlanKind, pos ?? null, o ?? {}),
      /** play every synth kind once (2 m apart around pos); one row per kind */
      synthAll: (pos?: Vec3 | null, o?: SynthOpts) => SYNTH_KINDS.map((k, i) => {
        try {
          const p: Vec3 | null = pos ? [pos[0] + Math.cos(i) * 2, pos[1], pos[2] + Math.sin(i) * 2] : null;
          return { kind: k, ok: !!synth(k, p, { seed: 1000 + i, ...(o ?? {}) }) };
        } catch (e) {
          return { kind: k, ok: false, err: e instanceof Error ? e.message : String(e) };
        }
      }),
      plan: (kind: string, o?: SynthOpts) => planSynth(kind as PlanKind, o ?? {}),
      nodes: () => {
        const sfx = engine.nodes(), h = hums?.nodes() ?? 0, b = beds?.nodes() ?? 0;
        const by = engine.nodesBy();
        return { sfx, live: engine.liveCount(), synth: by.synth, liveSynth: by.liveSynth, assets: by.sfx, liveAssets: by.liveSfx, hums: h, beds: b, total: sfx + h + b };
      },
      hums: () => hums?.info() ?? [],
      /** RMS (dBFS) of the hum bus over ms */
      humRms: (ms = 300) => new Promise<number>((resolve) => {
        const gr = g();
        if (!gr || !hums) { resolve(-Infinity); return; }
        if (!analyser) { analyser = new AnalyserNode(gr.ac, { fftSize: 2048 }); hums.bus.connect(analyser); }
        const a = analyser;
        const buf = new Float32Array(a.fftSize);
        let sum = 0, n = 0;
        const t0 = performance.now();
        const tick = () => {
          a.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) { sum += buf[i] * buf[i]; n++; }
          if (performance.now() - t0 < ms) setTimeout(tick, 40);
          else resolve(n ? 10 * Math.log10(sum / n + 1e-20) : -Infinity);
        };
        tick();
      }),
      fixtures: () => {
        const fx = useLoose<LevelLike>(ctx, 'level')?.fixtures ?? [];
        const lv = levelSource(fx);
        return fx.map((f, i) => ({ i, space: f.space, kind: f.kind ?? 'tube', voice: humVoiceOf(f.kind), pos: f.pos, state: f.state, level: lv(i) }));
      },
      levelSource: () => {
        let n = -1;
        try { n = useLoose<RenderLike>(ctx, 'render')?.fixtureLevels?.()?.length ?? -1; } catch { n = -1; }
        const fx = useLoose<LevelLike>(ctx, 'level')?.fixtures?.length ?? 0;
        return n === fx && n >= 0 ? 'render.fixtureLevels' : 'fallback';
      },
      beds: () => beds?.info() ?? null,
      bedTheme: (t: string | null | undefined) => beds?.forceTheme(t),
      reverb: () => ({ ...(graph?.reverbState?.() ?? { mix: 1, wet: 1 }), room }),
      fearSrc: (s: string, v: number, ms?: number) => fear(s, v, ms),
      fearState: () => ({ value: fearNow, target: fearMix.value(performance.now()), sources: fearMix.sources(performance.now()) }),
      probe: (pos: Vec3) => engine.probe([pos[0], pos[1], pos[2]]),
      cfg: () => cfg,
      /** render one plan offline (OfflineAudioContext, not the live graph): its real Web Audio levels */
      renderOffline: async (kind: string, o?: SynthOpts) => {
        const plan = planSynth(kind as PlanKind, o ?? {});
        if (!plan) return null;
        const sr = 48000;
        const oc = new OfflineAudioContext(1, Math.ceil((plan.dur + 0.1) * sr), sr);
        const noise = graph?.noise ?? (() => {
          const b = oc.createBuffer(1, sr * 2, sr);
          const d = b.getChannelData(0);
          let s = 0x9e3779b9;
          for (let i = 0; i < d.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; d[i] = s / 2147483648 - 1; }
          return b;
        })();
        playPlan(oc, plan, oc.destination, noise, 0, o?.volume ?? 1);
        const buf = await oc.startRendering();
        const d = buf.getChannelData(0);
        let peak = 0, sum = 0, bad = 0;
        for (let i = 0; i < d.length; i++) { const x = d[i]; if (!Number.isFinite(x)) { bad++; continue; } sum += x * x; if (Math.abs(x) > peak) peak = Math.abs(x); }
        return { kind, peak, rmsDb: 10 * Math.log10(sum / d.length + 1e-20), dur: plan.dur, voices: plan.voices.length, bad };
      },
    };
  }

  ctx.services.provide('sfx', {
    play: (id, pos, opts) => engine.play(id, pos ?? null, opts),
    has: (k) => engine.has(k),
    preload: (keys) => engine.preload(keys),
    setFear: (v) => fear('default', v),
    setStatic: (v) => ensure()?.setStatic(v),
    flicker: (space, ms) => { flickers.set(space, performance.now() + Math.max(0, ms)); },
    setAmbience: (on) => { ambOverride = on; syncDrone(); },
    synth: (kind, pos, opts) => synth(kind, pos ?? null, opts ?? {}),
    fear: (source, v, ms) => fear(source, v, ms),
  });

  let acc = 0;
  let revAcc = 1;
  let bedAcc = 1;
  /** one audio update: hums every call, the rest at ~25 Hz. stale = run by the watchdog (no frame for a while) */
  const frame = (dt: number, stale: boolean) => {
    if (!ctx.audio.ctx) return;
    if (!amb) {
      // unlocked before this module installed (a click during the async installs): build the graph now
      ensure();
      syncDrone();
    }
    const gr = graph;
    if (!gr || !amb) return;
    const now = gr.ac.currentTime;
    const lp = listenerPose(ctx);
    // the voice track moves ac.listener (30 Hz); without it (voice disabled / failed) the audio system does
    if (lp && !ctx.services.use('voice') && ctx.world.me) applyListener(gr.ac, lp);
    // hums: every frame, so a dying / stuttering light is heard as it happens
    if (hums) {
      const fx = useLoose<LevelLike>(ctx, 'level')?.fixtures;
      const fixtures = Array.isArray(fx) ? fx : null;
      const { grid, doorOpen } = levelGrid(ctx);
      const occOf = grid && lp
        ? (f: HumFixture) => occlusionOf(wallCrossings(grid, lp.pos[0], lp.pos[2], f.pos[0], f.pos[2], doorOpen, cfg.closedDoorWallFrac), cfg).gain
        : undefined;
      const events = hums.update(lp?.pos ?? null, fixtures, fixtures ? levelSource(fixtures, stale) : () => 0, now, occOf);
      for (let i = 0; i < events.length && i < MAX_HUM_EVENTS; i++) onHum(events[i], lp);
    }
    acc += dt;
    if (acc < 0.04) return;
    const step = Math.min(0.25, acc);
    acc = 0;
    fearNow = smoothFear(fearNow, fearMix.value(performance.now()), step, cfg.fear.attackSec, cfg.fear.releaseSec);
    amb.setFear(fearNow);
    amb.update();
    engine.update();
    revAcc += step;
    if (revAcc >= 0.25) { revAcc = 0; reverbByRoom(lp); }
    bedAcc += step;
    if (bedAcc >= 0.1 && beds) {
      bedAcc = 0;
      beds.update({ layout: ctx.world.layout, phase: ctx.world.phase, listener: lp?.pos ?? null, siteThemes: ctx.flags.siteThemes !== false, now });
    }
  };
  let lastFrame = 0;
  ctx.registerSystem({
    name: 'audio',
    order: SYS.audio,
    update(dt) {
      lastFrame = performance.now();
      frame(dt, false);
    },
  });
  // watchdog (browser only): the frame loop stalls behind a long GPU pipeline compile and stops in a hidden tab, but
  // audio keeps its promises meanwhile (a room that loses power goes silent within 0.3 s, the heartbeat keeps time).
  // Idle while frames flow; the audio context keeps timers at full rate in a tab that is playing sound.
  if (typeof document !== 'undefined') {
    let last = performance.now();
    let failures = 0;
    const tick = () => {
      setTimeout(tick, 50);
      const t = performance.now();
      const dt = Math.min(0.25, Math.max(0, (t - last) / 1000));
      last = t;
      if (lastFrame && t - lastFrame < 150) return;
      try { frame(dt, true); } catch (e) {
        if (++failures <= 3) ctx.reportError(`audio watchdog: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    setTimeout(tick, 50);
  }
}
