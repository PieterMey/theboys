// Client-local typed event bus. Tracks add their own events by module augmentation in THEIR files:
//   declare module '../core/bus.ts' { interface BusEvents { 'players:spawned': { id: string } } }
import type { Phase } from '@dead-air/shared/state.ts';
import type { NetStatus } from './net.ts';

export interface BusEvents {
  /** fired synchronously inside the Join click (user gesture): do gesture-gated work here */
  'join:click': { crew: string; name: string };
  'net:status': { status: NetStatus };
  /** after 'welcome' was applied to the world (first join or resume) */
  'net:welcome': { you: string; resumed: boolean };
  'world:phase': { from: Phase; to: Phase };
  /** v1.3: a 'phase' event arrived and is about to be applied (world.phase is still `from`; its layout may rebuild the
   *  level synchronously right after). Send requests that must leave before any heavy work here; do no work. */
  'net:phase-incoming': { from: Phase; to: Phase };
  'audio:unlocked': { ctx: AudioContext };
  'error': { msg: string };
}

export type BusKey = keyof BusEvents & string;

export interface Bus {
  on<K extends BusKey>(k: K, fn: (d: BusEvents[K]) => void): () => void;
  emit<K extends BusKey>(k: K, d: BusEvents[K]): void;
}

export function createBus(onError: (msg: string) => void): Bus {
  const subs = new Map<string, Set<(d: unknown) => void>>();
  return {
    on(k, fn) {
      let set = subs.get(k);
      if (!set) subs.set(k, (set = new Set()));
      set.add(fn as (d: unknown) => void);
      return () => set.delete(fn as (d: unknown) => void);
    },
    emit(k, d) {
      for (const fn of subs.get(k) ?? []) {
        try {
          fn(d);
        } catch (e) {
          if (k !== 'error') onError(`bus ${k}: ${e instanceof Error ? e.message : e}`);
        }
      }
    },
  };
}
