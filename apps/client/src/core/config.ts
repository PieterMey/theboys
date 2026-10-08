// Client copy of config/flags.json + config/balance/*.json (bundled at build time; HMR in dev).
// Same shape as the server: balance.<domain>.<key>. Flags: the server's live copy (GET /healthz .flags, fetched by
// main.ts before the track installs; see flags.ts) wins over the bundled one, so a server flag reload reaches
// clients on their next page load; without it (older server, offline) the bundled copy is used.
import { mergeFlags } from './flags.ts';

const flagMods = import.meta.glob('../../../../config/flags.json', { eager: true, import: 'default' });
const balanceMods = import.meta.glob('../../../../config/balance/*.json', { eager: true, import: 'default' });

export type Flags = Record<string, boolean>;
export type Balance = Record<string, Record<string, unknown>> & { core: Record<string, unknown> };

/** The flags bundled at build time (config/flags.json when the client was built). */
export function bundledFlags(): Flags {
  return { ...((Object.values(flagMods)[0] ?? {}) as Flags) };
}

export function loadClientConfig(serverFlags?: Flags | null): { flags: Flags; balance: Balance } {
  const flags = mergeFlags(bundledFlags(), serverFlags ?? null);
  const balance: Record<string, Record<string, unknown>> = { core: {} };
  for (const [path, mod] of Object.entries(balanceMods)) {
    const name = path.split('/').pop()!.replace(/\.json$/, '');
    balance[name] = mod as Record<string, unknown>;
  }
  return { flags, balance: balance as Balance };
}
