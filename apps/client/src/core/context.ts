// ClientContext: what every client track's `install(ctx)` receives.
import { createBus } from './bus.ts';
import type { Bus } from './bus.ts';
import { createServices } from './services.ts';
import type { Services } from './services.ts';
import { createWorld } from './world.ts';
import type { World } from './world.ts';
import { createNet } from './net.ts';
import type { Net } from './net.ts';
import { createLoop } from './loop.ts';
import type { ClientSystem, Loop } from './loop.ts';
import { createAudioCore } from './audio.ts';
import type { AudioCore } from './audio.ts';
import { createErrorLog } from './errors.ts';
import { createReadiness } from './readiness.ts';
import type { Readiness } from './readiness.ts';
import { bundledFlags, loadClientConfig } from './config.ts';
import type { Balance, Flags } from './config.ts';
import { changedFlags } from './flags.ts';
import { createUi } from './ui/api.ts';
import type { UiApi } from './ui/api.ts';

export interface ClientContext {
  flags: Flags;
  balance: Balance;
  /** ?test=1 (enables window.__game) */
  testMode: boolean;
  /** URL query params (e.g. webgl=1, test=1, preset=low) */
  params: URLSearchParams;
  /** 'dev' in the Vite dev server, else the build id */
  build: string;
  world: World;
  net: Net;
  bus: Bus;
  services: Services;
  /** same object as services.use('ui') (core always provides it) */
  ui: UiApi;
  audio: AudioCore;
  readiness: Readiness;
  registerSystem(sys: ClientSystem): void;
  /** record an error (shown in __game.errors(); fails gates) */
  reportError(msg: string): void;
  errors(): string[];
  /** free-form diagnostics included in __game.state().diag */
  diag: Record<string, unknown>;
  loop: Loop;
}

/** URL hash: '#CODE', '#CODE&admin=TOKEN' or '#admin=TOKEN'. The admin token is stored and stripped. */
function parseHash(): string {
  const parts = location.hash.replace(/^#/, '').split('&').filter(Boolean);
  let code = '';
  let changed = false;
  for (const p of parts) {
    if (p.startsWith('admin=')) {
      try { localStorage.setItem('deadair.admin', decodeURIComponent(p.slice(6))); } catch { /* ignore */ }
      changed = true;
    } else if (!code) code = p.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  if (changed) history.replaceState(null, '', `${location.pathname}${location.search}${code ? `#${code}` : ''}`);
  return code;
}

/** serverFlags: the server's live flags (core/flags.ts fetchServerFlags; null = keep the bundled copy) */
export function createClientContext(serverFlags: Flags | null = null): ClientContext & { hashCrew: string } {
  const errors = createErrorLog();
  const bus = createBus(errors.report);
  const world = createWorld();
  const net = createNet(world, bus, errors.report);
  const loop = createLoop(errors.report);
  const services = createServices();
  const params = new URLSearchParams(location.search);
  const { flags, balance } = loadClientConfig(serverFlags);
  // which flags the server overrode (a kill switch flipped since this client was built); __game.state().diag.flags
  const flagsDiag = { source: serverFlags ? 'server' : 'bundled', changed: changedFlags(bundledFlags(), flags) };
  if (flagsDiag.changed.length) console.info('[flags] server overrides:', flagsDiag.changed.map((k) => `${k}=${flags[k]}`).join(' '));
  const ctx = {
    flags,
    balance,
    testMode: params.get('test') === '1',
    params,
    build: __BUILD_ID__,
    world,
    net,
    bus,
    services,
    ui: null as unknown as UiApi,
    audio: createAudioCore(bus),
    readiness: createReadiness(),
    registerSystem: (sys: ClientSystem) => loop.add(sys),
    reportError: (msg: string) => {
      errors.report(msg);
      bus.emit('error', { msg });
    },
    errors: () => errors.list.slice(),
    diag: { flags: flagsDiag } as Record<string, unknown>,
    loop,
    hashCrew: parseHash(),
  };
  ctx.ui = createUi(ctx);
  services.provide('ui', ctx.ui);
  return ctx;
}
