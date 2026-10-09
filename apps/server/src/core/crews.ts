// Crew registry + Hello/resume/leave handling. Simple by design; track ① Net hardens it
// (session persistence, kick, passwords UI, admin flows).
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, encodeMsg } from '@dead-air/shared/envelope.ts';
import type { ErrCode } from '@dead-air/shared/envelope.ts';
import { CREW_CODE_ALPHABET, CREW_CODE_LEN, MAX_PLAYERS, NET } from '@dead-air/shared/constants.ts';
import { PROFILE_LIMITS, randomProfile } from '@dead-air/shared/profile.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import { renameNotice, safeDisplayName } from '@dead-air/shared/names.ts';
import type { SafeDisplayName } from '@dead-air/shared/names.ts';
import type { CrewPublic } from '@dead-air/shared/state.ts';
import type { Crew, CrewRegistry, HelloMsg, ServerContext, ServerPlayer, WelcomeMsg } from './types.ts';
import { runHooks } from './hooks.ts';

/** One WebSocket connection (before and after Hello). */
export interface Conn {
  ws: WebSocket;
  isAlive: boolean;
  crew: Crew | null;
  player: ServerPlayer | null;
}

export interface CrewCore extends CrewRegistry {
  handleHello(conn: Conn, hello: HelloMsg): void;
  /** deliberate = the client closed with LEAVE_CLOSE_CODE ('Leave the shift'): release the slot now */
  handleClose(conn: Conn, deliberate?: boolean): void;
  /** expire held slots / empty crews (called ~1 Hz by the loop) */
  sweep(now: number): void;
  kick(crew: Crew, id: string, reason?: string): void;
  // ---- additive (track ① Net): admin flag + session restore after a server restart ----
  /** true if this player presented the admin token in any Hello of this process */
  isAdmin(id: string): boolean;
  /**
   * Re-create crews from a saved session (saves/session.json). Crews come back empty in phase 'hub';
   * their former members (by id / resume token) may rejoin without the crew password. Existing crews are kept.
   */
  restoreSession(entries: RestoreEntry[]): void;
  /** ids of the former members of a restored crew (empty set if none) */
  restoredMembers(code: string): ReadonlySet<string>;
}

/** One crew from saves/session.json (see track ① Net, apps/server/src/net/session.ts). */
export interface RestoreEntry {
  code: string;
  password?: string;
  players: { id: string; resume: string }[];
}

/** WebSocket close code a client sends for a deliberate leave (the held slot is released at once). */
export const LEAVE_CLOSE_CODE = 4100;

/** /voicetest joins as 'voicetest': a voice-only observer (never alive, no avatar, never leader). */
export function isObserver(p: ServerPlayer): boolean {
  return (p.slices as { observer?: unknown }).observer === true;
}

/** v1.3 P2b: a scripted test client (hello.build === 'bot'); meta's drive wait never waits for one. */
export function isBot(p: ServerPlayer): boolean {
  return p.bot === true;
}

/** Sticky observer: alive reads false whatever other tracks assign (revive-all, phase resets). */
function markObserver(p: ServerPlayer): void {
  p.slices.observer = true;
  p.band = 0;
  p.radio = 0;
  Object.defineProperty(p, 'alive', { get: () => false, set: () => { /* observers never live */ }, enumerable: true, configurable: true });
}

export function playerIdFromKey(key: string): string {
  return 'p' + createHash('sha256').update(key).digest('base64url').slice(0, 10);
}

export function normCode(code: unknown): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * v1.3 P1a: the display name everyone else sees (packages/shared/src/names.ts): cleaned (controls, zero-width, bidi
 * overrides, angle brackets out; at most PROFILE_LIMITS.nameMax), and a hate / sexual / harassment term or a reserved
 * name (Listener, Company, HR, Admin, Claude, System) becomes Contractor-NNNN from the player id ('blocked': tell the
 * player privately). Empty -> 'Contractor'. Only this player's exact defaults skip the filter: its Contractor-NNNN and
 * the client's default for its key (names.ts defaultName); any other Contractor-... name is checked like every name.
 */
function cleanName(n: unknown, id: string, key: string): SafeDisplayName {
  return safeDisplayName(n, id, key);
}

function cleanProfile(p: unknown, name: string): Profile {
  const base = randomProfile(name);
  if (!p || typeof p !== 'object') return base;
  const q = p as Partial<Profile>;
  const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
  return {
    name,
    body: q.body === 'f' ? 'f' : 'm',
    suit: [hex(q.suit?.[0], base.suit[0]), hex(q.suit?.[1], base.suit[1])],
    helmet: q.helmet === 'box' || q.helmet === 'diver' ? q.helmet : 'dome',
    visor: {
      glyphs: String(q.visor?.glyphs ?? base.visor.glyphs).slice(0, PROFILE_LIMITS.glyphsMax),
      color: hex(q.visor?.color, base.visor.color),
    },
    badge: Number.isInteger(q.badge) && (q.badge as number) > 0 && (q.badge as number) < 100000 ? (q.badge as number) : base.badge,
  };
}

/** Client build id from apps/client/dist/build.json (prod); null = unknown (check skipped). */
function readBuild(dist: string): string | null {
  const p = join(dist, 'build.json');
  if (!existsSync(p)) return null;
  try {
    return String((JSON.parse(readFileSync(p, 'utf8')) as { build?: string }).build ?? '') || null;
  } catch {
    return null;
  }
}

export function createCrews(ctx: ServerContext): CrewCore {
  const log = ctx.log('crews');
  const crews = new Map<string, Crew>();
  const resumes = new Map<string, { code: string; id: string }>();
  /** resume tokens of a previous process (restored session) -> crew code + player id */
  const restoredResumes = new Map<string, { code: string; id: string }>();
  const restoredIds = new Map<string, Set<string>>();
  const admins = new Set<string>();
  const env = ctx.env;
  const openJoin = env.dev || env.mode === 'test';

  const cap = () => Math.min(MAX_PLAYERS, Number(ctx.balance.core.lobbyCap ?? MAX_PLAYERS));

  const reject = (conn: Conn, code: ErrCode, msg: string) => {
    log.info(`hello rejected: ${code} (${msg})`);
    if (conn.ws.readyState === 1) conn.ws.send(encodeMsg({ op: 'err', code, msg }));
    conn.ws.close(4000, code);
  };

  const recomputeLeader = (crew: Crew) => {
    let leader: ServerPlayer | null = null;
    for (const p of crew.players.values()) if (p.connected && !isObserver(p) && (!leader || p.joinedAt < leader.joinedAt)) leader = p;
    for (const p of crew.players.values()) p.isLeader = p === leader;
  };

  const newCode = (): string => {
    for (;;) {
      let c = '';
      for (let i = 0; i < CREW_CODE_LEN; i++) c += CREW_CODE_ALPHABET[randomInt(CREW_CODE_ALPHABET.length)];
      if (!crews.has(c)) return c;
    }
  };

  const removePlayer = (crew: Crew, p: ServerPlayer, reason: 'expired' | 'kicked' | 'replaced') => {
    crew.players.delete(p.id);
    resumes.delete(p.resume);
    runHooks(ctx, 'leave', ctx.hooks.leave, crew, p, { final: true, reason });
    recomputeLeader(crew);
    reg.broadcastRoster(crew);
  };

  const reg: CrewCore = {
    get: (code) => crews.get(normCode(code)),
    list: () => [...crews.values()],
    create(code, opts) {
      const c = code ? normCode(code) : newCode();
      if (!c) throw new Error('bad crew code');
      if (crews.has(c)) throw new Error(`crew ${c} exists`);
      const crew: Crew = { code: c, phase: 'hub', players: new Map(), layout: null, slices: {}, createdAt: Date.now(), tick: 0, password: opts?.password, emptySince: performance.now() };
      crews.set(c, crew);
      log.info(`crew ${c} created`);
      return crew;
    },
    remove(code) {
      const crew = crews.get(normCode(code));
      if (!crew) return;
      for (const p of crew.players.values()) {
        resumes.delete(p.resume);
        p.socket?.close(4003, 'crew closed');
      }
      crews.delete(crew.code);
      log.info(`crew ${crew.code} removed`);
    },
    toPublic(crew): CrewPublic {
      return {
        code: crew.code,
        phase: crew.phase,
        maxPlayers: cap(),
        players: [...crew.players.values()].map((p) => ({
          id: p.id, name: p.name, profile: p.profile, connected: p.connected, ready: p.ready, alive: p.alive,
          isLeader: p.isLeader, consent: p.consent, level: p.level,
        })),
      };
    },
    connected: (crew) => [...crew.players.values()].filter((p) => p.connected),
    broadcastRoster(crew) {
      recomputeLeader(crew);
      ctx.emit(crew, 'crew', reg.toPublic(crew));
    },
    findPlayer(id) {
      for (const crew of crews.values()) {
        const player = crew.players.get(id);
        if (player) return { crew, player };
      }
      return undefined;
    },
    kick(crew, id, reason = 'kicked') {
      const p = crew.players.get(id);
      if (!p) return;
      if (p.socket?.readyState === 1) p.socket.send(encodeMsg({ op: 'err', code: 'kicked', msg: reason }));
      p.socket?.close(4004, 'kicked');
      p.socket = null;
      p.connected = false;
      removePlayer(crew, p, 'kicked');
    },

    handleHello(conn, hello) {
      if (conn.player) return;
      if (hello.v !== PROTOCOL_VERSION) return reject(conn, 'bad_version', `server protocol v${PROTOCOL_VERSION}`);
      if (env.mode === 'production') {
        const build = readBuild(env.CLIENT_DIST);
        if (build && hello.build !== build) return reject(conn, 'stale_build', 'a new version is out: reload the page');
      }
      const key = String(hello.playerKey ?? '');
      if (key.length < 8 || key.length > 128) return reject(conn, 'server', 'bad player key');
      const isAdmin = typeof hello.admin === 'string' && safeEq(hello.admin, env.ADMIN_TOKEN);
      const id = playerIdFromKey(key);
      if (isAdmin) admins.add(id);
      const named = cleanName(hello.name, id, key);

      // 1) resume token (this process, then a restored session), 2) crew code, 3) create
      let crew: Crew | undefined;
      const r = hello.resume ? (resumes.get(hello.resume) ?? restoredResumes.get(hello.resume)) : undefined;
      if (r && r.id === id) crew = crews.get(r.code);
      let created = false;
      if (!crew) {
        const code = normCode(hello.crew);
        crew = code ? crews.get(code) : undefined;
        if (!crew) {
          if (!openJoin && !isAdmin) return reject(conn, 'unknown_crew', code ? `no crew ${code}` : 'crew code required');
          crew = reg.create(code || undefined);
          created = true;
        }
      }

      let player = crew.players.get(id);
      const resumed = !!player;
      if (player) {
        if (player.socket && player.socket !== conn.ws) {
          const old = player.socket;
          player.socket = null;
          if (old.readyState === 1) old.send(encodeMsg({ op: 'err', code: 'kicked', msg: 'opened in another tab' }));
          old.close(4005, 'replaced');
        }
      } else {
        const wasMember = restoredIds.get(crew.code)?.has(id) === true;
        if (crew.password && hello.password !== crew.password && !isAdmin && !wasMember) return reject(conn, 'bad_password', 'wrong crew password');
        if (crew.players.size >= cap()) {
          // capacity counts connected players: a newcomer takes over the oldest held (away) slot
          let away: ServerPlayer | null = null;
          for (const q of crew.players.values()) if (!q.connected && (!away || q.disconnectedAt < away.disconnectedAt)) away = q;
          if (!away) return reject(conn, 'crew_full', `crew is full (${cap()})`);
          log.info(`crew ${crew.code} full: ${away.name}'s held slot released for a newcomer`);
          removePlayer(crew, away, 'expired');
        }
        // same key held in another crew -> drop that slot
        for (const other of crews.values()) {
          const dup = other !== crew ? other.players.get(id) : undefined;
          if (dup) {
            dup.socket?.close(4005, 'replaced');
            dup.socket = null;
            dup.connected = false;
            removePlayer(other, dup, 'replaced');
          }
        }
        const name = named.name;
        player = {
          id, key, name, profile: cleanProfile(hello.profile, name),
          connected: false, ready: false, alive: true, consent: { transcribe: false, mimic: false }, level: 1,
          pose: { seq: 0, p: [0, 0, 0], yaw: 0, pitch: 0, stance: 0, anim: 0, light: 0 }, poseAt: 0,
          band: 0, radio: 0, socket: null, resume: randomBytes(18).toString('base64url'),
          joinedAt: performance.now(), isLeader: false, disconnectedAt: 0, slices: {},
        };
        crew.players.set(id, player);
        resumes.set(player.resume, { code: crew.code, id });
      }
      if (named.name.toLowerCase() === 'voicetest' && !isObserver(player)) markObserver(player);
      if (resumed) {
        player.name = named.name;
        player.profile = cleanProfile(hello.profile, player.name);
      }
      // v1.3 P2b: scripted test clients say build 'bot' (tests/bots, tests/meta); the drive wait skips them
      player.bot = hello.build === 'bot';
      player.socket = conn.ws;
      player.connected = true;
      player.disconnectedAt = 0;
      conn.crew = crew;
      conn.player = player;
      crew.emptySince = 0;
      recomputeLeader(crew);
      runHooks(ctx, 'join', ctx.hooks.join, crew, player, { resumed, created });

      const welcome: WelcomeMsg = {
        op: 'welcome', v: PROTOCOL_VERSION, you: player.id, resume: player.resume, crew: reg.toPublic(crew),
        state: ctx.buildFullState(crew, player), iceServers: [], serverTime: ctx.now(),
        build: env.mode === 'production' ? (readBuild(env.CLIENT_DIST) ?? 'unknown') : 'dev',
      };
      runHooks(ctx, 'welcome', ctx.hooks.welcome, crew, player, welcome);
      ctx.send(player, welcome);
      reg.broadcastRoster(crew);
      ctx.notice(crew, `${player.name} ${resumed ? 'reconnected' : 'joined'}`, 'info');
      log.info(`${player.name} (${player.id}) ${resumed ? 'resumed' : 'joined'} crew ${crew.code} [${crew.players.size}]`);
      if (named.blocked) {
        // only this player hears why; the log never carries the refused name
        ctx.emit(crew, 'notice', { text: renameNotice(named), kind: 'warn' }, { to: [player.id] });
        log.info(`name filter: ${player.id} shown as ${player.name} (${named.reason})`);
      }
    },

    handleClose(conn, deliberate) {
      const { crew, player } = conn;
      if (!crew || !player || player.socket !== conn.ws) return;
      player.socket = null;
      player.connected = false;
      player.disconnectedAt = performance.now();
      // a dropped socket is silent: monsters must never hear a ghost (the last 'loud' band would stick for 90 s)
      player.band = 0;
      player.radio = 0;
      runHooks(ctx, 'leave', ctx.hooks.leave, crew, player, { final: false, reason: 'disconnect' });
      if (deliberate && crew.players.get(player.id) === player) {
        log.info(`${player.name} (${player.id}) left ${crew.code}; slot released`);
        removePlayer(crew, player, 'expired');
        return;
      }
      reg.broadcastRoster(crew);
      log.info(`${player.name} (${player.id}) disconnected from ${crew.code}; slot held ${NET.resumeHoldMs / 1000}s`);
    },

    isAdmin: (id) => admins.has(id),
    restoreSession(entries) {
      for (const e of entries) {
        const code = normCode(e.code);
        if (!code) continue;
        if (!crews.has(code)) {
          const crew = reg.create(code, { password: e.password || undefined });
          crew.emptySince = performance.now();
        }
        let ids = restoredIds.get(code);
        if (!ids) restoredIds.set(code, (ids = new Set()));
        for (const p of e.players) {
          if (typeof p.id !== 'string' || !p.id) continue;
          ids.add(p.id);
          if (typeof p.resume === 'string' && p.resume) restoredResumes.set(p.resume, { code, id: p.id });
        }
      }
    },
    restoredMembers: (code) => restoredIds.get(normCode(code)) ?? new Set<string>(),

    sweep(now) {
      for (const crew of [...crews.values()]) {
        for (const p of [...crew.players.values()]) {
          if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > NET.resumeHoldMs) removePlayer(crew, p, 'expired');
        }
        if (crew.players.size === 0) {
          if (!crew.emptySince) crew.emptySince = now;
          else if (now - crew.emptySince > NET.resumeHoldMs) reg.remove(crew.code);
        }
      }
    },
  };
  return reg;
}
