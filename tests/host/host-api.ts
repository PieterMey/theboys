// Types for the parts of tools/host.mjs (plain JS) that the host tests use. The tests import host.mjs dynamically,
// after they point HOST_STATE / HOST_LOGS / PORT / HOST_SERVER_ENTRY at their own scratch folder and test port.

export interface HostState {
  adminToken?: string;
  crew?: string;
  serverPid?: number;
  serverSpawnedPid?: number;
  serverPort?: number;
  serverStartedAt?: string;
  watchdogRestarts?: number[];
}

export interface WatchdogCfg {
  intervalMs: number;
  timeoutMs: number;
  failLimit: number;
  maxRestarts: number;
  windowMs: number;
}

export interface WatchdogMem {
  fails?: number;
  seenPid?: number | null;
  ownPid?: number | null;
  gaveUp?: boolean;
}

export interface WatchdogObs {
  healthy: boolean;
  spawnedPid?: number | null;
  portPid?: number | null;
  alive?: boolean;
  lock?: LockHolder | null;
  restarts?: number[];
  now: number;
}

export type WatchdogAction = 'ok' | 'miss' | 'warn' | 'busy' | 'gone' | 'foreign' | 'off' | 'give-up' | 'restart';

export interface LockHolder {
  pid: number;
  by: string;
  at: number;
}

export interface RestartLock {
  holder: LockHolder;
  release(): void;
}

export interface HostApi {
  PORT: number;
  SERVER_LOG: string;
  RESTART_LOCK: string;
  TEST_SERVER_ENTRY: string | null;
  WATCHDOG: WatchdogCfg;
  readState(): HostState;
  writeState(s: HostState): void;
  ensureHostSecrets(s: HostState): HostState;
  serverArgs(): string[];
  startGameServer(s: HostState, port?: number): Promise<number>;
  stopGameServer(s: HostState, port?: number): Promise<void>;
  serverHealthy(port?: number, ms?: number): Promise<boolean>;
  pidOnPort(port: number): number | null;
  pidAlive(pid: number | null | undefined): boolean;
  watchdogStep(mem: WatchdogMem, obs: WatchdogObs, cfg?: WatchdogCfg): { mem: Required<WatchdogMem>; action: WatchdogAction };
  startWatchdog(opts?: Partial<WatchdogCfg> & { port?: number; log?: (text: string) => void }): { stop(): Promise<void> };
  readRestartLock(file?: string): LockHolder | null;
  restartLockStale(h: LockHolder | null, now?: number): boolean;
  restartInProgress(file?: string): LockHolder | null;
  acquireRestartLock(by: string, file?: string): RestartLock | null;
  releaseRestartLock(file?: string): void;
  waitForRestartLock(by: string, ms?: number, onWait?: (h: LockHolder | null) => void, file?: string): Promise<RestartLock | null>;
}

/** import tools/host.mjs (after the caller set its env); a computed specifier, so tsc does not need its types */
export async function importHost(): Promise<HostApi> {
  const url = new URL('../../tools/host.mjs', import.meta.url).href;
  return (await import(url)) as HostApi;
}
