// env-world test harness: builds the client level in Node (no GPU, no browser). A tiny DOM shim gives CanvasTexture
// sources a canvas whose 2D context swallows every call, and a fake ClientContext runs level/index.ts install().
import * as THREE from 'three/webgpu';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';

export const REPO = resolve(import.meta.dirname, '../..');

/** a 2D context that accepts any call (measureText -> width 0) */
function fakeContext2d(): unknown {
  const target: Record<string, unknown> = {
    measureText: (s: string) => ({ width: String(s).length * 10 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === 'string' ? () => undefined : undefined),
    set: (t, k, v) => { t[k as string] = v; return true; },
  });
}
export function installDomShim(): void {
  const g = globalThis as unknown as { document?: unknown; window?: unknown };
  if (g.document) return;
  g.document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') return {};
      const c = { width: 300, height: 150, style: {}, getContext: () => ctx2d, toDataURL: () => '' };
      const ctx2d = fakeContext2d();
      return c;
    },
    fonts: { add: () => {} },
  };
}

export interface FakeCtx {
  ctx: unknown;
  errors: string[];
  systems: { name: string; update(dt: number): void }[];
  world: { layout: LevelLayout | null; full: unknown; subscribe(fn: () => void): () => void; notify(): void };
  services: { provide(n: string, v: unknown): void; use(n: string): unknown; wait(n: string): Promise<unknown> };
  tick(dt?: number, frames?: number): void;
}

export async function fakeContext(): Promise<FakeCtx> {
  const { createServices } = await import('../../apps/client/src/core/services.ts');
  const { createReadiness } = await import('../../apps/client/src/core/readiness.ts');
  const subs = new Set<() => void>();
  const world = {
    layout: null as LevelLayout | null,
    full: null as unknown,
    subscribe(fn: () => void) { subs.add(fn); return () => subs.delete(fn); },
    notify() { for (const f of subs) f(); },
  };
  const errors: string[] = [];
  const systems: FakeCtx['systems'] = [];
  const services = createServices();
  const flags = JSON.parse(readFileSync(join(REPO, 'config/flags.json'), 'utf8')) as Record<string, boolean>;
  const ctx = {
    flags, balance: {}, testMode: false, params: new URLSearchParams(), build: 'test', world, net: {}, bus: { emit() {}, on() { return () => {}; } },
    services, ui: {}, audio: {}, readiness: createReadiness(), registerSystem: (s: FakeCtx['systems'][number]) => systems.push(s),
    reportError: (m: string) => errors.push(m), errors: () => errors, diag: {} as Record<string, unknown>, loop: {},
  };
  return {
    ctx, errors, systems, world, services: services as unknown as FakeCtx['services'],
    tick(dt = 1 / 60, frames = 1) { for (let f = 0; f < frames; f++) for (const s of systems) s.update(dt); },
  };
}

/** the client level installed on a fake context, with a stand-in three service (scene + camera, no renderer) */
export async function installLevel(L: LevelLayout): Promise<FakeCtx & { scene: THREE.Scene; camera: THREE.PerspectiveCamera }> {
  installDomShim();
  const f = await fakeContext();
  const { install } = await import('../../apps/client/src/level/index.ts');
  f.world.layout = L;
  install(f.ctx as never);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 200);
  f.services.provide('three', { renderer: { getMaxAnisotropy: () => 8 }, scene, camera, backend: 'webgpu' });
  await new Promise((r) => setTimeout(r, 0));
  return { ...f, scene, camera };
}
