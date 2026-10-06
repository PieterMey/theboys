// Client copy of config/flags.json + config/balance/*.json (bundled at build time; HMR in dev).
// Same shape as the server: balance.<domain>.<key>.
const flagMods = import.meta.glob('../../../../config/flags.json', { eager: true, import: 'default' });
const balanceMods = import.meta.glob('../../../../config/balance/*.json', { eager: true, import: 'default' });

export type Flags = Record<string, boolean>;
export type Balance = Record<string, Record<string, unknown>> & { core: Record<string, unknown> };

export function loadClientConfig(): { flags: Flags; balance: Balance } {
  const flags = (Object.values(flagMods)[0] ?? {}) as Flags;
  const balance: Record<string, Record<string, unknown>> = { core: {} };
  for (const [path, mod] of Object.entries(balanceMods)) {
    const name = path.split('/').pop()!.replace(/\.json$/, '');
    balance[name] = mod as Record<string, unknown>;
  }
  return { flags, balance: balance as Balance };
}
