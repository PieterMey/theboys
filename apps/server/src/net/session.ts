// Owner: track ① Net. Session persistence: saves/session.json (SessionSave + a few extra fields), written
// atomically (tmp + rename) shortly after every roster / phase change and checked every 5 s. On boot the crews
// come back empty in 'hub' (a mid-contract restart voids the contract); former members rejoin with the SAME id
// (ids hash the browser player key) and skip the crew password; the earlier join order (leader) is kept.
// Track dev servers on other ports use saves/session-<PORT>.json so they never restore each other's crews.
// SESSION_FILE overrides the path; NET_SESSION=0 disables persistence; mode 'test' persists only with SESSION_FILE.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionSave } from '@dead-air/shared/saves.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { CrewCore, RestoreEntry } from '../core/crews.ts';
import { netBalance } from './balance.ts';

interface SavedPlayer { id: string; playerKey: string; resume: string; name?: string; order?: number }
interface SavedCrew { code: string; phase: string; password?: string; players: SavedPlayer[] }
type SessionFile = Omit<SessionSave, 'crews'> & { crews: SavedCrew[]; version?: number };

export interface SessionApi {
  file: string | null;
  /** ids restored from the previous process -> join order (for leader continuity) */
  restoredOrder: Map<string, number>;
  schedule(): void;
  saveNow(): void;
  restored: number;
  /** player ids of crews that were mid-contract when the server stopped (each gets one 'contract void' notice) */
  voidedPlayers: Set<string>;
}

export function sessionFile(ctx: ServerContext): string | null {
  if (process.env.NET_SESSION === '0') return null;
  if (process.env.SESSION_FILE) return process.env.SESSION_FILE;
  if (ctx.env.mode === 'test') return null;
  const port = ctx.env.PORT;
  return join(ctx.env.ROOT, 'saves', port === 3000 ? 'session.json' : `session-${port}.json`);
}

function signature(crews: Crew[]): string {
  return crews.map((c) => `${c.code}:${c.phase}:${[...c.players.keys()].sort().join(',')}`).sort().join('|');
}

export function createSession(ctx: ServerContext): SessionApi {
  const log = ctx.log('session');
  const file = sessionFile(ctx);
  let timer: NodeJS.Timeout | null = null;
  let lastSig = '';
  const restoredOrder = new Map<string, number>();

  const build = (): SessionFile => ({
    version: 1,
    savedAt: new Date().toISOString(),
    crews: ctx.crews.list().filter((c) => c.players.size > 0).map((c) => ({
      code: c.code,
      phase: c.phase,
      password: c.password,
      players: [...c.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p: ServerPlayer, i) => ({ id: p.id, playerKey: p.key, resume: p.resume, name: p.name, order: i })),
    })),
  });

  const write = () => {
    if (!file) return;
    const data = build();
    const sig = signature(ctx.crews.list().filter((c) => c.players.size > 0));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(data, null, 1));
      try {
        renameSync(tmp, file);
      } catch {
        // Windows: target briefly locked (AV / reader) -> retry once
        renameSync(tmp, file);
      }
      lastSig = sig;
    } catch (e) {
      log.warn('session save failed:', e instanceof Error ? e.message : e);
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    }
  };

  const api: SessionApi = {
    file,
    restoredOrder,
    restored: 0,
    voidedPlayers: new Set<string>(),
    schedule() {
      if (!file || timer) return;
      timer = setTimeout(() => { timer = null; write(); }, netBalance(ctx).sessionSaveDebounceMs);
    },
    saveNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      write();
    },
  };

  // restore
  if (file && existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as SessionFile;
      const entries: RestoreEntry[] = [];
      for (const c of data.crews ?? []) {
        if (!c || typeof c.code !== 'string') continue;
        const players = (c.players ?? []).filter((p) => p && typeof p.id === 'string');
        players.forEach((p, i) => restoredOrder.set(p.id, typeof p.order === 'number' ? p.order : i));
        entries.push({ code: c.code, password: typeof c.password === 'string' ? c.password : undefined, players: players.map((p) => ({ id: p.id, resume: String(p.resume ?? '') })) });
        if (c.phase && c.phase !== 'hub') for (const p of players) api.voidedPlayers.add(p.id);
        if (c.phase && c.phase !== 'hub') log.info(`crew ${c.code} was in '${c.phase}' when the server stopped: back to the hub (contract void)`);
      }
      const core = ctx.crews as Partial<CrewCore>;
      if (typeof core.restoreSession === 'function') {
        core.restoreSession(entries);
        api.restored = entries.length;
        log.info(`restored ${entries.length} crew(s) from ${file}: ${entries.map((e) => `${e.code}[${e.players.length}]`).join(' ') || '-'}`);
      }
    } catch (e) {
      log.warn('session restore failed (ignored):', e instanceof Error ? e.message : e);
    }
  }

  // periodic safety net (crew removal by the sweep has no hook)
  const tick = () => {
    if (file) {
      const sig = signature(ctx.crews.list().filter((c) => c.players.size > 0));
      if (sig !== lastSig) api.schedule();
    }
    setTimeout(tick, 5000).unref();
  };
  setTimeout(tick, 5000).unref();
  return api;
}
