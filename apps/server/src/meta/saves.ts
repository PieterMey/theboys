// Owner: track (d) Meta. Host-side persistence: saves/crews/<code>.json + saves/players/<id>.json (PlayerSave/CrewSave
// contracts in packages/shared/src/saves.ts). Atomic writes (tmp + rename), debounced. saves/ is gitignored: never commit.
// SAVES_DIR overrides the folder (tests use a temp dir).
import { createHash, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CrewSave, PlayerSave } from '@dead-air/shared/saves.ts';

export function savesDir(root: string): string {
  return process.env.SAVES_DIR ?? join(root, 'saves');
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomInt(1e9)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    renameSync(tmp, path);
  } catch (e) {
    // Windows: a reader holding the target open can make rename fail (EPERM/EBUSY); retry once by replacing
    try {
      rmSync(path, { force: true });
      renameSync(tmp, path);
    } catch {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function hashPin(saveId: string, pin: string): string {
  return createHash('sha256').update(`deadair|${saveId}|${pin}`).digest('hex');
}

export function newPin(): string {
  return String(randomInt(10000)).padStart(4, '0');
}

export class SaveStore {
  readonly dir: string;
  private players = new Map<string, PlayerSave>();
  private keyIndex = new Map<string, string>();
  private crews = new Map<string, CrewSave>();
  private dirtyPlayers = new Set<string>();
  private dirtyCrews = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private onError: (msg: string) => void;
  /** total successful writes (tests/diagnostics) */
  writes = 0;

  constructor(dir: string, debounceMs = 400, onError: (msg: string) => void = () => {}) {
    this.dir = dir;
    this.debounceMs = debounceMs;
    this.onError = onError;
    this.loadPlayers();
  }

  private loadPlayers(): void {
    const d = join(this.dir, 'players');
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const s = readJson<PlayerSave>(join(d, f));
      if (!s || typeof s.id !== 'string') continue;
      this.players.set(s.id, s);
      for (const k of s.keys ?? []) this.keyIndex.set(k, s.id);
    }
  }

  playerById(id: string): PlayerSave | null {
    return this.players.get(id) ?? null;
  }

  playerByKey(key: string): PlayerSave | null {
    const id = this.keyIndex.get(key);
    return id ? (this.players.get(id) ?? null) : null;
  }

  allPlayers(): PlayerSave[] {
    return [...this.players.values()];
  }

  putPlayer(s: PlayerSave): void {
    s.updatedAt = new Date().toISOString();
    this.players.set(s.id, s);
    for (const k of s.keys) this.keyIndex.set(k, s.id);
    this.dirtyPlayers.add(s.id);
    this.schedule();
  }

  /** move a browser key to another save (claim) */
  bindKey(key: string, to: PlayerSave): void {
    const prevId = this.keyIndex.get(key);
    if (prevId && prevId !== to.id) {
      const prev = this.players.get(prevId);
      if (prev) {
        prev.keys = prev.keys.filter((k) => k !== key);
        // an untouched temporary profile is just clutter
        if (!prev.keys.length && prev.xp === 0) {
          this.players.delete(prev.id);
          this.dirtyPlayers.delete(prev.id);
          try { rmSync(join(this.dir, 'players', `${safe(prev.id)}.json`), { force: true }); } catch { /* ignore */ }
        } else this.putPlayer(prev);
      }
    }
    if (!to.keys.includes(key)) to.keys = [...to.keys, key].slice(-8);
    this.putPlayer(to);
  }

  crew(code: string): CrewSave | null {
    const c = this.crews.get(code);
    if (c) return c;
    const s = readJson<CrewSave>(join(this.dir, 'crews', `${safe(code)}.json`));
    if (s && typeof s.code === 'string') this.crews.set(code, s);
    return s;
  }

  putCrew(s: CrewSave): void {
    s.updatedAt = new Date().toISOString();
    this.crews.set(s.code, s);
    this.dirtyCrews.add(s.code);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const id of this.dirtyPlayers) {
      const s = this.players.get(id);
      if (!s) continue;
      try {
        writeJsonAtomic(join(this.dir, 'players', `${safe(id)}.json`), s);
        this.writes++;
      } catch (e) {
        this.onError(`player save ${id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.dirtyPlayers.clear();
    for (const code of this.dirtyCrews) {
      const s = this.crews.get(code);
      if (!s) continue;
      try {
        writeJsonAtomic(join(this.dir, 'crews', `${safe(code)}.json`), s);
        this.writes++;
      } catch (e) {
        this.onError(`crew save ${code} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.dirtyCrews.clear();
  }
}
