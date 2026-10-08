// Owner: env-audio (v1.2). Contract (plan check #24a, #13): the synthesized-sound names and options env-paranormal
// (E4) and env-audio (E5) share, plus the v1.2 sfx members (implemented in audio/index.ts, synth.ts, sfx.ts).
// Consumers call them with ?. (a missing provider is a no-op):
//   ctx.services.use('sfx')?.synth?.('knock', p, { seed, pattern: 'wood' });
//   ctx.services.use('sfx')?.play('sfx.door_creak', p, { occlude: true });   // ambience / paranormal only
//   ctx.services.use('sfx')?.fear?.('paranormal', 0.6, 4000);                // only what the player perceives
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
  // SHOULD (E5); synth() returns null for kinds that are not built (all of them are built in v1.2)
  | 'music_box' | 'phone_bell' | 'radio_sweep' | 'tv_static' | 'clock_chime' | 'pipe_groan';

export type KnockPattern = 'wood' | 'metal' | 'locker';

export interface SynthOpts {
  /** deterministic variation (no Math.random where clients must agree): pass the event seed */
  seed?: number;
  volume?: number;
  /** pitch + speed like a playbackRate (0.5..2, default 1) */
  rate?: number;
  /** knock: material pattern (default 'wood') */
  pattern?: KnockPattern;
  /** knock: number of hits (1-8); handle_rattle: rattles; glass_squeak: squeaks; clock_chime: strikes (1-12) */
  count?: number;
  /** sustained kinds (frost, tv_static, radio_sweep, pipe_groan, phone_bell, music_box): duration in ms */
  ms?: number;
  /** spatial falloff radius (m); default per kind */
  radius?: number;
  /** occlusion + per-sound reverb send (config/balance/audio.json). synth sounds are ambience / paranormal, so a
   *  positional synth() call occludes unless this is false. */
  occlude?: boolean;
  /** non-positional (UI / 2D) */
  ui?: boolean;
  /** v1.2 addition: a new sound with the same id stops the previous one */
  id?: string;
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
