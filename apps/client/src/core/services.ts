// Typed service locator. Every service is OPTIONAL: always handle `use()` returning undefined.
// Providers: three = ③ Render (temporary stub in render/index.ts), sfx = ④ Voice/audio, input = ⑤ Players,
// voice = ④ Voice, ui = core. Tracks may add services by module augmentation in THEIR files:
//   declare module '../core/services.ts' { interface ServiceMap { level: LevelService } }
import type * as THREE from 'three/webgpu';
import type { Vec3 } from '@dead-air/shared/state.ts';
import type { InputState, VoiceDebugApi } from '@dead-air/shared/test-api.ts';
import type { UiApi } from './ui/api.ts';

export interface ThreeService {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  backend: 'webgpu' | 'webgl2';
}

export interface SfxOpts {
  volume?: number;
  rate?: number;
  loop?: boolean;
  /** non-positional (UI / 2D) */
  ui?: boolean;
}

export interface SfxService {
  play(id: string, pos?: Vec3, opts?: SfxOpts): void;
}

export interface InputService {
  /** current input state (keyboard/mouse merged with test overrides) */
  state(): InputState;
  /** test hook: override input (pointer-lock bypass) */
  setInput(input: Partial<InputState>): void;
  teleport(x: number, z: number, yaw?: number): void;
  look(yaw: number, pitch: number): void;
}

export interface VoiceService {
  /** local detected loudness band (BAND) */
  band(): number;
  debug?: VoiceDebugApi;
}

export interface ServiceMap {
  three: ThreeService;
  sfx: SfxService;
  input: InputService;
  voice: VoiceService;
  ui: UiApi;
}

export type ServiceName = keyof ServiceMap & string;

export interface Services {
  provide<K extends ServiceName>(name: K, impl: ServiceMap[K]): void;
  /** the service or undefined (never throws) */
  use<K extends ServiceName>(name: K): ServiceMap[K] | undefined;
  /** the service or throw */
  require<K extends ServiceName>(name: K): ServiceMap[K];
  /** resolves once provided */
  wait<K extends ServiceName>(name: K): Promise<ServiceMap[K]>;
}

export function createServices(): Services {
  const map = new Map<string, unknown>();
  const waiters = new Map<string, ((v: unknown) => void)[]>();
  return {
    provide(name, impl) {
      map.set(name, impl);
      for (const w of waiters.get(name) ?? []) w(impl);
      waiters.delete(name);
    },
    use: (name) => map.get(name) as never,
    require(name) {
      const s = map.get(name);
      if (s === undefined) throw new Error(`service '${name}' not provided`);
      return s as never;
    },
    wait(name) {
      const s = map.get(name);
      if (s !== undefined) return Promise.resolve(s as never);
      return new Promise((res) => {
        const list = waiters.get(name) ?? [];
        list.push(res as (v: unknown) => void);
        waiters.set(name, list);
      });
    },
  };
}
