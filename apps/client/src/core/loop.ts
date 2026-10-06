// requestAnimationFrame loop: systems run every frame in `order` (see SYS). dt in seconds, clamped to 0.1.
import type { ClientContext } from './context.ts';

export const SYS = {
  input: 10,
  net: 20,
  players: 30,
  monsters: 40,
  level: 50,
  interaction: 60,
  audio: 70,
  voice: 80,
  render: 100,
  ui: 110,
} as const;

export interface ClientSystem {
  name: string;
  order: number;
  update(dt: number, ctx: ClientContext): void;
}

export interface Loop {
  add(sys: ClientSystem): void;
  start(ctx: ClientContext): void;
  perf: { fps: number; frameMs: number; frames: number };
}

export function createLoop(onError: (msg: string) => void): Loop {
  const systems: ClientSystem[] = [];
  const failures = new Map<string, number>();
  let last = 0;
  let running = false;
  const perf = { fps: 0, frameMs: 0, frames: 0 };
  return {
    perf,
    add(sys) {
      if (systems.some((s) => s.name === sys.name)) throw new Error(`system ${sys.name} already registered`);
      systems.push(sys);
      systems.sort((a, b) => a.order - b.order);
    },
    start(ctx) {
      if (running) return;
      running = true;
      const frame = (now: number) => {
        const raw = last ? (now - last) / 1000 : 1 / 60;
        last = now;
        const dt = Math.min(0.1, Math.max(0, raw));
        const t0 = performance.now();
        for (const sys of systems) {
          try {
            sys.update(dt, ctx);
          } catch (e) {
            const n = (failures.get(sys.name) ?? 0) + 1;
            failures.set(sys.name, n);
            if (n <= 3 || n % 300 === 0) onError(`system ${sys.name}: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
          }
        }
        perf.frames++;
        perf.frameMs = perf.frameMs * 0.9 + (performance.now() - t0) * 0.1;
        if (raw > 0) perf.fps = perf.fps * 0.9 + (1 / raw) * 0.1;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
  };
}
