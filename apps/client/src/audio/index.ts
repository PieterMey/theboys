// Owner: track ④ Voice (audio) (apps/client/src/audio/**). SFX engine + procedural ambience on the ONE AudioContext.
// services.sfx.play(key, pos?, opts?) -> { stop() } | null; setFear(0..1); setStatic(0..1); flicker(space, ms);
// setAmbience(on). Bus 'audio:flicker' { space, ms } syncs the fluorescent hum with light flicker (render/level emit it).
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import { getGraph, listenerPose, useLoose } from './graph.ts';
import type { AudioGraph } from './graph.ts';
import { SfxEngine } from './sfx.ts';
import type { SfxHandle, SfxPlayOpts } from './sfx.ts';
import { Ambience } from './ambience.ts';
import type { FixtureLike } from './ambience.ts';

export type { SfxHandle, SfxPlayOpts } from './sfx.ts';

declare module '../core/services.ts' {
  interface SfxService {
    /** play a manifest key (or a variant family like 'sfx.door_open'); spatial with pos, 2D without. null if missing. */
    play(id: string, pos?: Vec3, opts?: SfxPlayOpts): SfxHandle | null;
    has(key: string): boolean;
    preload(keys: string[]): void;
    /** heartbeat intensity 0..1 */
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

interface LevelLike { fixtures?: readonly FixtureLike[] }

export function install(ctx: ClientContext): void {
  let graph: AudioGraph | null = null;
  let amb: Ambience | null = null;
  let fear = 0;
  let ambOverride: boolean | null = null;
  const g = () => {
    const ac = ctx.audio.ctx;
    if (!ac) return null;
    graph ??= getGraph(ac);
    return graph;
  };
  const engine = new SfxEngine(ctx, g);
  const ensureAmb = () => {
    const gr = g();
    if (!gr) return null;
    amb ??= new Ambience(gr);
    return amb;
  };
  const syncDrone = () => {
    const a = ensureAmb();
    if (!a) return;
    const on = ambOverride ?? ctx.world.phase === 'contract';
    if (a.drone() !== on) a.setDrone(on);
  };

  ctx.bus.on('audio:unlocked', () => {
    g();
    ensureAmb()?.setFear(fear);
    syncDrone();
    void engine.loadManifest();
  });
  ctx.bus.on('world:phase', () => syncDrone());
  ctx.bus.on('audio:flicker', ({ space, ms }) => ensureAmb()?.flicker(space, ms));

  if (ctx.testMode) {
    (window as unknown as { __audioDebug?: unknown }).__audioDebug = {
      play: (k: string, pos?: Vec3, o?: SfxPlayOpts) => !!engine.play(k, pos ?? null, o),
      has: (k: string) => engine.has(k),
      manifest: () => engine.loadManifest().then((m) => (m ? Object.keys(m.files).filter((k) => k.startsWith('sfx.')).length : 0)),
      ambience: () => ({ drone: amb?.drone() ?? false, fear }),
      fear: (v: number) => { fear = v; ensureAmb()?.setFear(v); },
    };
  }
  ctx.services.provide('sfx', {
    play: (id, pos, opts) => engine.play(id, pos ?? null, opts),
    has: (k) => engine.has(k),
    preload: (keys) => engine.preload(keys),
    setFear: (v) => { fear = v; ensureAmb()?.setFear(v); },
    setStatic: (v) => ensureAmb()?.setStatic(v),
    flicker: (space, ms) => ensureAmb()?.flicker(space, ms),
    setAmbience: (on) => { ambOverride = on; syncDrone(); },
  });

  let acc = 0;
  ctx.registerSystem({
    name: 'audio',
    order: SYS.audio,
    update(dt) {
      if (!ctx.audio.ctx || !amb) return;
      acc += dt;
      if (acc < 0.04) return;
      acc = 0;
      const lp = listenerPose(ctx);
      const fixtures = useLoose<LevelLike>(ctx, 'level')?.fixtures ?? null;
      amb.update(lp?.pos ?? null, fixtures);
      engine.update();
    },
  });
}
