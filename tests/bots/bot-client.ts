// Owner: track (a) Objectives (tests/bots/**). Headless WebSocket bot client (Node 'ws' + the envelope codec).
// Reusable by gate scripts:
//   const bot = await connectBot({ url: 'ws://127.0.0.1:3011/ws', crew: 'BOTS', name: 'Bot-A' });
//   await bot.goTo(x, z);  await bot.req('objectives.lever', { id: 'lever:0' });  bot.close();
// Movement: A* over the shared edge grid (packages/shared/src/nav), poses at 20 Hz at a bounded speed, re-syncing
// to the server's position (snapshot) whenever the server rejected/clamped our poses.
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '@dead-air/shared/envelope.ts';
import type { ClientMsg, ServerMsg } from '@dead-air/shared/envelope.ts';
import type { EventName, EventPayload, ReqArgs, ReqName, ReqResult } from '@dead-air/shared/messages/index.ts';
import type { FullState, Snapshot } from '@dead-air/shared/state.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { ObjectivesState } from '@dead-air/shared/messages/objectives.ts';
import { randomProfile } from '@dead-air/shared/profile.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { astar, buildEdgeGrid, pathPoints, smoothPath, spaceAt } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';

export interface BotOpts {
  url: string;
  crew: string;
  name: string;
  /** stable key => stable player id (default random) */
  playerKey?: string;
  log?: (s: string) => void;
}

export interface GoOpts {
  /** m/s (default 4.2 = a jog the server's speed clamp accepts) */
  speed?: number;
  /** arrival tolerance (m) */
  tol?: number;
  timeoutMs?: number;
  /** door-state override for path planning */
  doorOpen?: DoorOpenFn;
}

export interface Bot {
  readonly name: string;
  readonly crew: string;
  id: string;
  full: FullState | null;
  obj: ObjectivesState | null;
  layout: LevelLayout | null;
  snap: Snapshot | null;
  /** local (client-side) position + facing */
  pos: [number, number];
  yaw: number;
  stance: number;
  /** recent events (name, payload, server time) */
  events: { e: string; d: unknown; t: number }[];
  posesSent: number;
  corrections: number;
  req<R extends ReqName>(r: R, a: ReqArgs<R>, timeoutMs?: number): Promise<ReqResult<R>>;
  dbg(name: string, args?: unknown, timeoutMs?: number): Promise<unknown>;
  on<E extends EventName>(e: E, fn: (d: EventPayload<E>) => void): () => void;
  waitEvent<E extends EventName>(e: E, pred?: (d: EventPayload<E>) => boolean, timeoutMs?: number): Promise<EventPayload<E>>;
  waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void>;
  /** my position as the server last reported it (snapshot), or null */
  serverPos(): [number, number] | null;
  /** jump the local position (e.g. to the server's spawn) */
  setPos(x: number, z: number, yaw?: number): void;
  /** dev-only server teleport (dbg.net.teleport) + local jump; falls back to a local jump */
  teleport(x: number, z: number, yaw?: number): Promise<void>;
  /** plan + walk to (x, z); resolves on arrival */
  goTo(x: number, z: number, opts?: GoOpts): Promise<void>;
  /** walk straight towards (x, z) by at most `maxStep` metres this pose (caller drives it, e.g. Core carry) */
  stepToward(x: number, z: number, speed: number): void;
  /** stop any running goTo */
  stop(): void;
  /** door open state used for planning (layout + objectives.vaultOpen + (b) InteractionState if present) */
  doorOpen: DoorOpenFn;
  grid(): EdgeGrid | null;
  /** path cost (m) from my position to (x, z), Infinity if unreachable */
  pathCost(x: number, z: number): number;
  close(): void;
}

const POSE_MS = 50;

export function connectBot(opts: BotOpts): Promise<Bot> {
  const log = opts.log ?? (() => {});
  const ws = new WebSocket(opts.url);
  ws.binaryType = 'nodebuffer';
  const playerKey = opts.playerKey ?? randomBytes(16).toString('hex');
  let reqId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const subs = new Map<string, Set<(d: unknown) => void>>();
  let grid: EdgeGrid | null = null;
  let gridFor: LevelLayout | null = null;
  let poseTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let lastPoseAt = performance.now();
  let move: { pts: [number, number][]; i: number; speed: number; tol: number; resolve: () => void; reject: (e: Error) => void; started: number; timeoutMs: number; tx: number; tz: number; lastProgress: number; lastPos: [number, number]; replans: number } | null = null;
  let manual: { x: number; z: number; speed: number } | null = null;
  let offSince = 0;

  const send = (m: ClientMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMsg(m));
  };

  const doorOpen: DoorOpenFn = (id: number) => {
    const L = bot.layout;
    const d = L?.doors[id];
    if (!d) return false;
    const inter = bot.full?.interaction?.doors?.[id];
    if (d.kind === 'vault') return !!bot.obj?.vaultOpen || !!inter?.open;
    if (d.kind === 'open') return true;
    if (d.kind === 'blocked') return false;
    if (inter) return inter.open || !inter.locked;
    return true; // bots assume dbg.objectives.doors opened everything else
  };

  const ensureGrid = (): EdgeGrid | null => {
    const L = bot.layout;
    if (!L) return null;
    if (gridFor !== L) { grid = buildEdgeGrid(L); gridFor = L; }
    return grid;
  };

  const plan = (fx: number, fz: number, tx: number, tz: number, door: DoorOpenFn): [number, number][] | null => {
    const g = ensureGrid();
    if (!g) return null;
    const r = astar(g, fx, fz, tx, tz, { mode: 'walk', doorOpen: door, canOpen: door });
    if (!r) return null;
    const pts = pathPoints(g, r.cells);
    pts[0] = [fx, fz];
    pts[pts.length - 1] = [tx, tz];
    return smoothPath(g, pts, door, 0.32);
  };

  const advance = () => {
    const now = performance.now();
    const dt = Math.min(0.2, (now - lastPoseAt) / 1000);
    lastPoseAt = now;
    // server correction: if the server keeps us far from where we think we are, adopt its position
    const sp = bot.serverPos();
    if (sp) {
      const off = Math.hypot(sp[0] - bot.pos[0], sp[1] - bot.pos[1]);
      if (off > 1.6) {
        offSince ||= now;
        if (now - offSince > 700) {
          bot.corrections++;
          log(`${opts.name}: server correction ${off.toFixed(1)} m -> (${sp[0].toFixed(1)}, ${sp[1].toFixed(1)})`);
          bot.pos = [sp[0], sp[1]];
          offSince = 0;
          if (move) {
            const m = move;
            const pts = plan(bot.pos[0], bot.pos[1], m.tx, m.tz, doorOpen);
            if (pts) { m.pts = pts; m.i = 1; }
          }
        }
      } else offSince = 0;
    }
    if (manual) {
      const { x, z, speed } = manual;
      manual = null;
      const dx = x - bot.pos[0], dz = z - bot.pos[1];
      const d = Math.hypot(dx, dz);
      const step = Math.min(d, speed * Math.max(dt, POSE_MS / 1000));
      if (d > 1e-3) {
        bot.pos = [bot.pos[0] + (dx / d) * step, bot.pos[1] + (dz / d) * step];
        bot.yaw = Math.atan2(dx, dz);
      }
      return;
    }
    const m = move;
    if (!m) return;
    if (now - m.started > m.timeoutMs) {
      move = null;
      m.reject(new Error(`${opts.name}: goTo(${m.tx.toFixed(1)}, ${m.tz.toFixed(1)}) timed out at (${bot.pos[0].toFixed(1)}, ${bot.pos[1].toFixed(1)})`));
      return;
    }
    let budget = m.speed * dt;
    while (budget > 0 && m.i < m.pts.length) {
      const [wx, wz] = m.pts[m.i];
      const dx = wx - bot.pos[0], dz = wz - bot.pos[1];
      const d = Math.hypot(dx, dz);
      if (d <= budget) {
        bot.pos = [wx, wz];
        budget -= d;
        m.i++;
      } else {
        bot.pos = [bot.pos[0] + (dx / d) * budget, bot.pos[1] + (dz / d) * budget];
        bot.yaw = Math.atan2(dx, dz);
        budget = 0;
      }
    }
    const dist = Math.hypot(m.tx - bot.pos[0], m.tz - bot.pos[1]);
    if (m.i >= m.pts.length || dist <= m.tol) {
      // arrived locally: wait until the server agrees (pose accepted)
      const s = bot.serverPos();
      if (!s || Math.hypot(s[0] - bot.pos[0], s[1] - bot.pos[1]) < 0.9) {
        move = null;
        bot.stance = STANCE.stand;
        m.resolve();
      }
    }
    const sp2 = bot.serverPos() ?? bot.pos;
    if (Math.hypot(sp2[0] - m.lastPos[0], sp2[1] - m.lastPos[1]) > 0.25) { m.lastPos = [sp2[0], sp2[1]]; m.lastProgress = now; }
    else if (now - m.lastProgress > 2500 && m.replans < 4) {
      // stuck: re-plan from the server position
      m.replans++;
      m.lastProgress = now;
      const s = bot.serverPos();
      if (s) bot.pos = [s[0], s[1]];
      const pts = plan(bot.pos[0], bot.pos[1], m.tx, m.tz, doorOpen);
      if (pts) { m.pts = pts; m.i = 1; }
      log(`${opts.name}: stuck, re-planned (${m.replans})`);
    }
  };

  const poseLoop = () => {
    if (closed) return;
    advance();
    if (bot.id) {
      send({ op: 'pose', seq: ++bot.posesSent, p: [bot.pos[0], 0, bot.pos[1]], yaw: bot.yaw, pitch: 0, stance: bot.stance, anim: 0, light: 1 });
    }
    poseTimer = setTimeout(poseLoop, POSE_MS);
  };

  const bot: Bot = {
    name: opts.name,
    crew: opts.crew,
    id: '',
    full: null,
    obj: null,
    layout: null,
    snap: null,
    pos: [0, 0],
    yaw: 0,
    stance: STANCE.stand,
    events: [],
    posesSent: 0,
    corrections: 0,
    req(r, a, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
        const id = reqId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${opts.name}: ${r} timed out`)); }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        send({ op: 'req', id, r, a });
      });
    },
    dbg(name, args, timeoutMs = 15000) {
      const r = (name.startsWith('dbg.') ? name : `dbg.${name}`) as ReqName;
      return bot.req(r, args as never, timeoutMs);
    },
    on(e, fn) {
      let s = subs.get(e);
      if (!s) subs.set(e, (s = new Set()));
      s.add(fn as (d: unknown) => void);
      return () => s.delete(fn as (d: unknown) => void);
    },
    waitEvent(e, pred, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(`${opts.name}: no '${e}' event in ${timeoutMs} ms`)); }, timeoutMs);
        const off = bot.on(e, (d) => {
          if (pred && !pred(d)) return;
          clearTimeout(timer);
          off();
          resolve(d);
        });
      });
    },
    waitFor(pred, timeoutMs, label) {
      return new Promise((resolve, reject) => {
        const t0 = performance.now();
        const check = () => {
          let ok = false;
          try { ok = pred(); } catch { ok = false; }
          if (ok) return resolve();
          if (performance.now() - t0 > timeoutMs) return reject(new Error(`${opts.name}: timed out waiting for ${label}`));
          setTimeout(check, 50);
        };
        check();
      });
    },
    serverPos() {
      const me = bot.snap?.players.find((p) => p.id === bot.id);
      return me ? [me.p[0], me.p[2]] : null;
    },
    setPos(x, z, yaw) {
      bot.pos = [x, z];
      if (yaw !== undefined) bot.yaw = yaw;
    },
    async teleport(x, z, yaw) {
      bot.stop();
      await bot.dbg('net.teleport', { x, z, yaw }).catch(() => undefined);
      bot.setPos(x, z, yaw);
      // wait until the server's snapshot shows us there (pose accepted)
      await bot.waitFor(() => { const s = bot.serverPos(); return !!s && Math.hypot(s[0] - x, s[1] - z) < 0.5; }, 3000, `teleport (${x.toFixed(1)}, ${z.toFixed(1)})`).catch(() => undefined);
    },
    goTo(x, z, o = {}) {
      bot.stop();
      const speed = o.speed ?? 4.2;
      const pts = plan(bot.pos[0], bot.pos[1], x, z, o.doorOpen ?? doorOpen);
      if (!pts) return Promise.reject(new Error(`${opts.name}: no path from (${bot.pos[0].toFixed(1)}, ${bot.pos[1].toFixed(1)}) to (${x.toFixed(1)}, ${z.toFixed(1)})`));
      bot.stance = speed > 3.2 ? STANCE.sprint : STANCE.stand;
      return new Promise<void>((resolve, reject) => {
        const now = performance.now();
        move = { pts, i: 1, speed, tol: o.tol ?? 0.15, resolve, reject, started: now, timeoutMs: o.timeoutMs ?? 45000, tx: x, tz: z, lastProgress: now, lastPos: [bot.pos[0], bot.pos[1]], replans: 0 };
      });
    },
    stepToward(x, z, speed) {
      manual = { x, z, speed };
    },
    stop() {
      if (move) { const m = move; move = null; m.reject(new Error('stopped')); }
    },
    doorOpen,
    grid: ensureGrid,
    pathCost(x, z) {
      const g = ensureGrid();
      if (!g) return Infinity;
      const r = astar(g, bot.pos[0], bot.pos[1], x, z, { mode: 'walk', doorOpen, canOpen: doorOpen });
      return r ? r.cost : Infinity;
    },
    close() {
      closed = true;
      if (poseTimer) clearTimeout(poseTimer);
      bot.stop();
      try { ws.close(); } catch { /* closing */ }
    },
  };

  const emitLocal = (e: string, d: unknown) => {
    for (const fn of subs.get(e) ?? []) {
      try { fn(d); } catch (err) { log(`${opts.name}: handler ${e} threw ${err instanceof Error ? err.message : err}`); }
    }
  };

  const applyFull = (st: FullState) => {
    bot.full = st;
    bot.layout = st.layout;
    bot.obj = st.objectives;
    if (st.snap) bot.snap = st.snap;
  };

  return new Promise<Bot>((resolve, reject) => {
    const failTimer = setTimeout(() => reject(new Error(`${opts.name}: no welcome`)), 10000);
    ws.on('open', () => {
      send({ op: 'hello', v: PROTOCOL_VERSION, build: 'bot', crew: opts.crew, playerKey, name: opts.name, profile: randomProfile(opts.name) });
    });
    ws.on('message', (data: Buffer) => {
      let m: ServerMsg;
      try { m = decodeMsg<ServerMsg>(data); } catch { return; }
      switch (m.op) {
        case 'welcome': {
          bot.id = m.you;
          applyFull(m.state);
          const sp = bot.serverPos();
          if (sp) bot.pos = sp;
          clearTimeout(failTimer);
          poseLoop();
          resolve(bot);
          return;
        }
        case 'snap':
          bot.snap = m.s;
          return;
        case 'ev': {
          if (m.e === 'phase') {
            const d = m.d as EventPayload<'phase'>;
            applyFull(d.state);
            // adopt the server's spawn for the new phase
            const sp = bot.serverPos();
            if (sp) bot.pos = sp;
          } else if (m.e === 'objectives.state') {
            bot.obj = m.d as ObjectivesState;
            if (bot.full) bot.full.objectives = bot.obj;
          } else if (m.e === 'interaction.patch' && bot.full) {
            applyIxPatch(bot.full, m.d as Record<string, unknown>);
          } else if (m.e === 'net.correct') {
            // ① rejected a pose: snap back to the last accepted position (goTo re-plans when stuck)
            const c = m.d as { p?: [number, number, number] };
            if (c.p) { bot.pos = [c.p[0], c.p[2]]; bot.corrections++; }
          }
          bot.events.push({ e: m.e, d: m.d, t: m.t });
          if (bot.events.length > 400) bot.events.splice(0, 100);
          emitLocal(m.e, m.d);
          return;
        }
        case 'rep': {
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve(m.d);
          else p.reject(new Error(m.err ?? 'request failed'));
          return;
        }
        case 'err':
          log(`${opts.name}: server err ${m.code}: ${m.msg}`);
          clearTimeout(failTimer);
          reject(new Error(`${m.code}: ${m.msg}`));
          return;
        default:
          return;
      }
    });
    ws.on('error', (e) => { clearTimeout(failTimer); reject(e); });
    ws.on('close', () => {
      closed = true;
      if (poseTimer) clearTimeout(poseTimer);
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('socket closed')); }
      pending.clear();
    });
  });
}

/** merge a (b) 'interaction.patch' into FullState.interaction (null deletes a key; reset replaces) */
function applyIxPatch(full: FullState, patch: Record<string, unknown>): void {
  if (patch.reset) { full.interaction = patch.reset as FullState['interaction']; return; }
  const st = full.interaction as unknown as Record<string, unknown> | null;
  if (!st) return;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) { st[k] = v; continue; }
    if (typeof v !== 'object') continue;
    const target = (st[k] ??= {}) as Record<string, unknown>;
    for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
      if (vv === null) delete target[kk];
      else target[kk] = vv;
    }
  }
}

/** Is (x, z) a walkable cell of the layout? */
export function walkable(L: LevelLayout, x: number, z: number): boolean {
  return spaceAt({ W: L.W, H: L.H, owner: L.owner as unknown as Int32Array }, x, z) >= 0;
}
