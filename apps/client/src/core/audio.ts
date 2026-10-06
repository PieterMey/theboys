// The ONE AudioContext (PLAN §4.6), created/resumed inside the Join click (user gesture).
// ④ Voice/audio build their graphs on ctx.audio.ctx after 'audio:unlocked'.
import type { Bus } from './bus.ts';

export interface AudioCore {
  /** null until unlock() */
  readonly ctx: AudioContext | null;
  /** call synchronously inside a user gesture; creates or resumes the context */
  unlock(): AudioContext;
}

export function createAudioCore(bus: Bus): AudioCore {
  let ac: AudioContext | null = null;
  return {
    get ctx() { return ac; },
    unlock() {
      const first = !ac;
      ac ??= new AudioContext({ latencyHint: 'interactive' });
      if (ac.state !== 'running') void ac.resume();
      if (first) bus.emit('audio:unlocked', { ctx: ac });
      return ac;
    },
  };
}
