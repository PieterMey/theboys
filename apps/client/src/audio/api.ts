// Owner: env-audio (v1.2). Contract stub (plan check #24a, #13): the synthesized-sound names and options env-paranormal
// (E4) and env-audio (E5) share, plus the v1.2 sfx members. E5 implements them in audio/index.ts and sfx.ts; until then
// consumers call them with ?.:  ctx.services.use('sfx')?.synth?.('knock', p, { seed, pattern: 'wood' }).
import type { Vec3 } from '@dead-air/shared/state.ts';
import type { SfxHandle } from './sfx.ts';

/** procedural sounds (no assets, no ElevenLabs), seeded so every client hears the same pattern. Never breath or a
 *  whisper (breath is the Listener's retreat cue: plan check #14) and never the Mannequin's scrape loop. */
export type SynthKind =
  // MUST (E5)
  | 'knock' // door / wall / locker knocks (opts.pattern)
  | 'handle_rattle'
  | 'chair_scrape' // one short wooden scrape
  | 'glass_creak' | 'glass_squeak' | 'glass_crack'
  | 'frost' // frost crackle + low wind
  | 'relay_tink' | 'filament_pop'
  | 'wet_step'
  // SHOULD (E5); synth() returns null for kinds that are not built
  | 'music_box' | 'phone_bell' | 'radio_sweep' | 'tv_static' | 'clock_chime' | 'pipe_groan';

export type KnockPattern = 'wood' | 'metal' | 'locker';

export interface SynthOpts {
  /** deterministic variation (no Math.random where clients must agree): pass the event seed */
  seed?: number;
  volume?: number;
  rate?: number;
  /** knock: material pattern (default 'wood') */
  pattern?: KnockPattern;
  /** knock: number of hits */
  count?: number;
  /** sustained kinds (frost, tv_static, radio_sweep, pipe_groan): duration in ms */
  ms?: number;
  /** spatial falloff radius (m) */
  radius?: number;
  /** occlusion + per-sound reverb send (config/balance/audio.json); ambience and paranormal only, never monsters */
  occlude?: boolean;
  /** non-positional (UI / 2D) */
  ui?: boolean;
}

declare module './sfx.ts' {
  interface SfxPlayOpts {
    /** v1.2 (E5): occlusion + reverb send for this sound (ambience, paranormal); ignored until E5 implements it */
    occlude?: boolean;
  }
}

declare module '../core/services.ts' {
  interface SfxService {
    /** v1.2 (E5): play a synthesized sound at pos (2D without); null when audio is locked or the kind is not built */
    synth?(kind: SynthKind, pos?: Vec3, opts?: SynthOpts): SfxHandle | null;
    /**
     * v1.2 (E5, plan check #13): heartbeat intensity 0..1 per source ('spotted', 'paranormal', ...); the heartbeat follows
     * the maximum over live sources. v 0 clears the source; ms clears it after ms. setFear(v) = fear('default', v).
     */
    fear?(source: string, v: number, ms?: number): void;
  }
}
