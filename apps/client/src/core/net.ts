// Minimal game-socket client (① Net extends it in apps/client/src/net/**). Same-origin /ws, binary frames,
// hello -> welcome, typed req/rep, events, pose at 20 Hz from a timer (not rAF), reconnect 250 ms -> 4 s with resume.
import { PROTOCOL_VERSION, decodeMsg, encodeMsg, encodeVoiceChunk } from '@dead-air/shared/envelope.ts';
import type { ClientMsg, ErrCode, ServerMsg, VoiceChunkHeader } from '@dead-air/shared/envelope.ts';
import type { EventName, EventPayload, ReqArgs, ReqName, ReqResult } from '@dead-air/shared/messages/index.ts';
import { POSE_HZ } from '@dead-air/shared/constants.ts';
import { randomProfile } from '@dead-air/shared/profile.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import type { World } from './world.ts';
import type { Bus } from './bus.ts';

export type NetStatus = 'idle' | 'connecting' | 'open' | 'joined' | 'reconnecting' | 'failed';
export type WelcomeMsg = Extract<ServerMsg, { op: 'welcome' }>;
export type PoseData = Omit<Extract<ClientMsg, { op: 'pose' }>, 'op' | 'seq'>;

export class JoinError extends Error {
  code: ErrCode | 'closed';
  constructor(code: ErrCode | 'closed', msg: string) {
    super(msg);
    this.code = code;
  }
}

export interface Net {
  readonly status: NetStatus;
  /** local player id after welcome */
  readonly me: string | null;
  readonly crewCode: string | null;
  /** smoothed round-trip time (ms) */
  readonly rtt: number;
  readonly lastWelcome: WelcomeMsg | null;
  /** connect + hello; resolves on welcome. crew '' = create a new crew (dev, or with admin token) */
  join(crew: string, name?: string): Promise<WelcomeMsg>;
  leave(): void;
  req<R extends ReqName>(r: R, a: ReqArgs<R>, timeoutMs?: number): Promise<ReqResult<R>>;
  /** dev-only server requests ('dbg.*'); name may omit the prefix */
  dbg(r: string, a?: unknown): Promise<unknown>;
  on<E extends EventName>(e: E, fn: (d: EventPayload<E>, t: number) => void): () => void;
  /** WebRTC signalling relay */
  onSig(fn: (from: string, d: unknown) => void): () => void;
  sendSig(to: string, d: unknown): void;
  /** register the pose provider; sampled at POSE_HZ by a timer while joined. Return null to skip. */
  setPoseSource(fn: (() => PoseData | null) | null): void;
  sendLoud(band: number, radio: 0 | 1): void;
  sendVoiceChunk(h: VoiceChunkHeader, pcm: Int16Array): void;
  /** raw send (no-op when not open) */
  send(m: ClientMsg): void;
  onStatus(fn: (s: NetStatus) => void): () => void;
  /** player key / name / profile persistence (localStorage) */
  identity(): { playerKey: string; name: string; profile: Profile };
  setIdentity(p: { name?: string; profile?: Profile }): void;
  adminToken(): string | null;
  // --- additive (track ① Net) ---
  /** last server 'err' (stale_build, kicked, unknown_crew, ...) for this page, or null */
  readonly lastError: { code: ErrCode; msg: string } | null;
  /** fires on every server 'err' message (the server closes the socket right after) */
  onServerError(fn: (code: ErrCode, msg: string) => void): () => void;
  /** last raw RTT sample (ms) and the time it was measured (performance.now()) */
  readonly rttSample: { ms: number; at: number };
}

const LS = { key: 'deadair.key', name: 'deadair.name', profile: 'deadair.profile', admin: 'deadair.admin' } as const;

function lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}

function randomKey(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createNet(world: World, bus: Bus, onError: (msg: string) => void): Net {
  let ws: WebSocket | null = null;
  let status: NetStatus = 'idle';
  let me: string | null = null;
  let crewCode: string | null = null;
  let resume: string | undefined;
  let rtt = 0;
  const rttWindow: number[] = [];
  let lastWelcome: WelcomeMsg | null = null;
  let wantOnline = false;
  let backoff = 250;
  let reqId = 1;
  let poseSeq = 0;
  let poseSource: (() => PoseData | null) | null = null;
  let poseTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let joinWaiter: { resolve: (w: WelcomeMsg) => void; reject: (e: Error) => void } | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const evSubs = new Map<string, Set<(d: unknown, t: number) => void>>();
  const sigSubs = new Set<(from: string, d: unknown) => void>();
  const statusSubs = new Set<(s: NetStatus) => void>();
  const errSubs = new Set<(code: ErrCode, msg: string) => void>();
  let lastError: { code: ErrCode; msg: string } | null = null;
  const rttSample = { ms: 0, at: 0 };

  const setStatus = (s: NetStatus) => {
    if (status === s) return;
    status = s;
    for (const fn of statusSubs) fn(s);
    bus.emit('net:status', { status: s });
  };

  const identity = () => {
    let playerKey = lsGet(LS.key);
    if (!playerKey) lsSet(LS.key, (playerKey = randomKey()));
    const name = lsGet(LS.name) || `Contractor-${playerKey.slice(0, 3).toUpperCase()}`;
    let profile: Profile | null = null;
    try { profile = JSON.parse(lsGet(LS.profile) ?? 'null') as Profile | null; } catch { profile = null; }
    if (!profile || typeof profile !== 'object') profile = randomProfile(name);
    profile.name = name;
    return { playerKey, name, profile };
  };

  const send = (m: ClientMsg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeMsg(m) as Uint8Array<ArrayBuffer>);
  };

  const emitEvent = (e: string, d: unknown, t: number) => {
    for (const fn of evSubs.get(e) ?? []) {
      try { fn(d, t); } catch (err) { onError(`event ${e}: ${err instanceof Error ? err.message : err}`); }
    }
  };

  const schedulePose = () => {
    if (poseTimer) clearTimeout(poseTimer);
    poseTimer = setTimeout(() => {
      poseTimer = null;
      if (status === 'joined' && poseSource) {
        try {
          const p = poseSource();
          if (p) send({ op: 'pose', seq: ++poseSeq, ...p });
        } catch (e) {
          onError(`pose source: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (wantOnline) schedulePose();
    }, 1000 / POSE_HZ);
  };

  const schedulePing = () => {
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      send({ op: 'ping', c: performance.now() });
      if (wantOnline) schedulePing();
    }, 2000);
  };

  const onMessage = (m: ServerMsg) => {
    switch (m.op) {
      case 'welcome': {
        const resumed = me === m.you;
        me = m.you;
        resume = m.resume;
        crewCode = m.crew.code;
        lastWelcome = m;
        backoff = 250;
        world.me = m.you;
        world.crew = m.crew;
        world.observeServerTime(m.serverTime);
        world.applyFull(m.state);
        setStatus('joined');
        schedulePose();
        schedulePing();
        bus.emit('net:welcome', { you: m.you, resumed });
        joinWaiter?.resolve(m);
        joinWaiter = null;
        return;
      }
      case 'snap':
        world.applySnap(m.s);
        return;
      case 'ev':
        if (m.e === 'crew') {
          world.crew = m.d as WelcomeMsg['crew'];
          world.notify();
        } else if (m.e === 'phase') {
          const d = m.d as EventPayload<'phase'>;
          const from = world.phase;
          world.applyFull(d.state);
          bus.emit('world:phase', { from, to: d.phase });
        }
        emitEvent(m.e, m.d, m.t);
        return;
      case 'rep': {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.d);
        else p.reject(new Error(m.err ?? 'request failed'));
        return;
      }
      case 'sig':
        for (const fn of sigSubs) fn(m.from, m.d);
        return;
      case 'pong': {
        const sample = performance.now() - m.c;
        // median of the last 5 samples: one sample inflated by a long frame (shader compile at join) must not
        // show a scary "1000 MS" for the next half minute the way an exponential average did
        rttWindow.push(sample);
        if (rttWindow.length > 5) rttWindow.shift();
        rtt = [...rttWindow].sort((a, b) => a - b)[rttWindow.length >> 1];
        rttSample.ms = sample;
        rttSample.at = performance.now();
        world.observeServerTime(m.s + sample / 2);
        return;
      }
      case 'err': {
        wantOnline = false; // every err is final for this join attempt (server closes the socket)
        const e = new JoinError(m.code, m.msg);
        if (joinWaiter) {
          joinWaiter.reject(e);
          joinWaiter = null;
        }
        lastError = { code: m.code, msg: m.msg };
        // expected, user-facing outcomes are shown by the net track's screens, not logged as errors
        if (m.code !== 'stale_build' && m.code !== 'kicked' && m.code !== 'unknown_crew') onError(`server: ${m.code}: ${m.msg}`);
        else console.warn(`server: ${m.code}: ${m.msg}`);
        if (m.code === 'stale_build' || m.code === 'kicked' || m.code === 'unknown_crew') setStatus('failed');
        for (const fn of errSubs) {
          try { fn(m.code, m.msg); } catch (err) { onError(`err listener: ${err instanceof Error ? err.message : err}`); }
        }
        return;
      }
    }
  };

  const connect = () => {
    const id = identity();
    setStatus(me ? 'reconnecting' : 'connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      setStatus('open');
      send({
        op: 'hello', v: PROTOCOL_VERSION, build: __BUILD_ID__, crew: crewCode ?? '', playerKey: id.playerKey,
        resume, name: id.name, profile: id.profile, admin: lsGet(LS.admin) ?? undefined,
      });
    };
    sock.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      try {
        onMessage(decodeMsg<ServerMsg>(new Uint8Array(ev.data)));
      } catch (e) {
        onError(`bad server frame: ${e instanceof Error ? e.message : e}`);
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('disconnected'));
      }
      pending.clear();
      if (!wantOnline) {
        if (status !== 'failed') setStatus('idle');
        if (joinWaiter) {
          joinWaiter.reject(new JoinError('closed', 'connection closed'));
          joinWaiter = null;
        }
        return;
      }
      setStatus('reconnecting');
      setTimeout(() => { if (wantOnline && !ws) connect(); }, backoff);
      backoff = Math.min(4000, backoff * 2);
    };
  };

  const net: Net = {
    get status() { return status; },
    get me() { return me; },
    get crewCode() { return crewCode; },
    get rtt() { return rtt; },
    get lastWelcome() { return lastWelcome; },
    join(crew, name) {
      if (name) net.setIdentity({ name });
      const code = crew.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code !== crewCode) {
        resume = undefined;
        me = null;
      }
      crewCode = code;
      wantOnline = true;
      joinWaiter?.reject(new JoinError('closed', 'superseded'));
      return new Promise<WelcomeMsg>((resolve, reject) => {
        joinWaiter = { resolve, reject };
        if (ws) ws.close();
        ws = null;
        connect();
      });
    },
    leave() {
      wantOnline = false;
      ws?.close();
    },
    req(r, a, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
        const id = reqId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request ${r} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        send({ op: 'req', id, r, a });
      });
    },
    dbg(r, a) {
      const name = (r.startsWith('dbg.') ? r : `dbg.${r}`) as ReqName;
      return net.req(name, a as never);
    },
    on(e, fn) {
      let set = evSubs.get(e);
      if (!set) evSubs.set(e, (set = new Set()));
      set.add(fn as (d: unknown, t: number) => void);
      return () => set.delete(fn as (d: unknown, t: number) => void);
    },
    onSig(fn) {
      sigSubs.add(fn);
      return () => sigSubs.delete(fn);
    },
    sendSig: (to, d) => send({ op: 'sig', to, d }),
    setPoseSource(fn) { poseSource = fn; },
    sendLoud: (band, radio) => send({ op: 'loud', band, radio }),
    sendVoiceChunk(h, pcm) {
      if (ws && ws.readyState === WebSocket.OPEN && status === 'joined') ws.send(encodeVoiceChunk(h, pcm) as Uint8Array<ArrayBuffer>);
    },
    send,
    onStatus(fn) {
      statusSubs.add(fn);
      return () => statusSubs.delete(fn);
    },
    identity,
    setIdentity(p) {
      if (p.name) lsSet(LS.name, p.name.slice(0, 16));
      if (p.profile) lsSet(LS.profile, JSON.stringify(p.profile));
    },
    adminToken: () => lsGet(LS.admin),
    get lastError() { return lastError; },
    onServerError(fn) {
      errSubs.add(fn);
      return () => errSubs.delete(fn);
    },
    rttSample,
  };
  return net;
}
