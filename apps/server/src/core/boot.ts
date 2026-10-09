// Boots the game server: config -> context -> track installs (in order) -> HTTP (+Vite in dev) -> /ws -> loop.
import type { AddressInfo } from 'node:net';
import type { Mode } from './config.ts';
import { loadConfig } from './config.ts';
import { createContext } from './context.ts';
import { createCrews } from './crews.ts';
import { createHttp } from './http.ts';
import { attachWs } from './ws.ts';
import { startLoop } from './loop.ts';
import { installCoreDbg } from './dbg.ts';
import { installCoreDiag } from './diag.ts';
import { makeLogger } from './log.ts';
import type { ServerContext } from './types.ts';

export type TrackInstall = (ctx: ServerContext) => void | Promise<void>;

export interface BootOpts {
  mode: Mode;
  /** override PORT (0 = random free port) */
  port?: number;
  tracks: [name: string, install: TrackInstall][];
  /** throw if any track install fails (selftest) */
  strict?: boolean;
}

export interface Booted {
  ctx: ServerContext;
  port: number;
  installErrors: string[];
  close(): Promise<void>;
}

export async function boot(opts: BootOpts): Promise<Booted> {
  const log = makeLogger('boot');
  const cfg = loadConfig(opts.mode, opts.port);
  const { ctx, internals, setCrews } = createContext(cfg);
  const crews = createCrews(ctx);
  setCrews(crews);
  installCoreDbg(ctx, internals);
  // v1.3 telemetry v2: 'core.diag' (logged without names)
  installCoreDiag(ctx);

  const installErrors: string[] = [];
  for (const [name, install] of opts.tracks) {
    try {
      await install(ctx);
    } catch (e) {
      const msg = `track ${name} install failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`;
      installErrors.push(msg);
      log.error(msg);
      if (opts.strict) throw new Error(msg);
    }
  }

  const http = await createHttp(ctx);
  const ws = attachWs(http.server, ctx, internals, crews);
  await new Promise<void>((resolve, reject) => {
    http.server.once('error', reject);
    http.server.listen(cfg.env.PORT, cfg.env.HOST, () => resolve());
  });
  const port = (http.server.address() as AddressInfo).port;
  if (cfg.env.PORT !== port) {
    if (!process.env.BASE_URL) cfg.env.BASE_URL = `http://127.0.0.1:${port}`;
    cfg.env.PORT = port;
  }
  const loop = startLoop(ctx, internals, crews);

  return {
    ctx,
    port,
    installErrors,
    async close() {
      loop.stop();
      ws.close();
      await http.close();
    },
  };
}
