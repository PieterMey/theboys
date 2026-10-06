// FROZEN CONTRACT (P0): test hooks exposed only when the client runs with ?test=1 or in dev mode.
// Playwright gates and agents drive the game exclusively through these.

export interface InputState {
  forward: number; // -1..1
  right: number; // -1..1
  sprint: boolean;
  crouch: boolean;
  /** one-shot actions, consumed on next frame */
  interact?: boolean;
  use?: boolean;
  drop?: boolean;
  flashlight?: boolean;
  radio?: boolean;
  slot?: number;
}

export interface GameTestApi {
  /** true once renderer, net and level are ready (and warm-up frames rendered) */
  ready(): boolean;
  backend(): 'webgpu' | 'webgl2' | 'none';
  /** join a crew without UI; resolves after 'welcome' */
  join(crew: string, name?: string): Promise<void>;
  /** current local player id */
  me(): string | null;
  /** shallow JSON-safe state dump (phase, players, monsters, objectives) */
  state(): unknown;
  perf(): { fps: number; frameMs: number; gpuMs?: number; drawCalls?: number };
  teleport(x: number, z: number, yaw?: number): void;
  look(yaw: number, pitch: number): void;
  setInput(input: Partial<InputState>): void;
  /** captured console errors + WebGPU uncaptured errors */
  errors(): string[];
  /** send a dev-only request (server registers 'dbg.*' only with NODE_ENV=development) */
  dbg(r: string, a?: unknown): Promise<unknown>;
  /** test-only: send any game request (e.g. 'meta.pick') */
  req?(r: string, a?: unknown): Promise<unknown>;
}

export interface VoicePeerDebug {
  state: string;
  candidate: 'host' | 'srflx' | 'prflx' | 'relay' | 'none';
  bytesReceived: number;
  rmsL: number;
  rmsR: number;
  gain: number;
  band: number;
}

export interface VoiceDebugApi {
  peers(): Record<string, VoicePeerDebug>;
  /** local detected band */
  band(): number;
  /** local mic track settings (to assert AGC off / EC on) */
  micSettings(): Record<string, unknown> | null;
}

declare global {
  interface Window {
    __game?: GameTestApi;
    __voiceDebug?: VoiceDebugApi;
  }
}
