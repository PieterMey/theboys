// __game.ready(): true once every required part reported done (render after warm-up frames, level after the
// mesh is built, ...). Tracks call `const done = ctx.readiness.require('level')` at install, then `done()`.
export interface Readiness {
  require(name: string): () => void;
  isReady(): boolean;
  pending(): string[];
}

export function createReadiness(): Readiness {
  const parts = new Map<string, boolean>();
  return {
    require(name) {
      parts.set(name, false);
      return () => { parts.set(name, true); };
    },
    isReady: () => parts.size > 0 && [...parts.values()].every(Boolean),
    pending: () => [...parts].filter(([, v]) => !v).map(([k]) => k),
  };
}
