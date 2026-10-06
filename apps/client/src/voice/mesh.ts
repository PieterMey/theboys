// Owner: track ④ Voice. WebRTC full mesh: one RTCPeerConnection per other player (audio + one unreliable data
// channel), MDN "perfect negotiation" over ctx.net.sendSig/onSig. polite = lexicographically smaller id.
// Every signal carries the sender's per-PC session id (sid): a description from a NEW sid means the other side
// rebuilt its PC (reload / resume) -> we rebuild ours too. Candidates from unknown sids are dropped.
import type { RTCIceServerLike } from '@dead-air/shared/envelope.ts';
import type { VoicePeerDebug } from '@dead-air/shared/test-api.ts';

export interface PeerState { band: number | null; radio: 0 | 1; baseDb: number | null; at: number }

interface SigMsg {
  v: 'vm1';
  sid: string;
  desc?: RTCSessionDescriptionInit;
  cand?: RTCIceCandidateInit | null;
}

export interface MeshDeps {
  me(): string | null;
  sendSig(to: string, d: unknown): void;
  iceServers(): RTCIceServerLike[];
  relayOnly(): boolean;
  /** the fixed outgoing track/stream (silence when there's no mic) */
  sendTrack(): { track: MediaStreamTrack; stream: MediaStream } | null;
  onRemoteStream(id: string, stream: MediaStream): void;
  onPeerClosed(id: string): void;
  log(msg: string): void;
}

function sid(): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Peer {
  readonly id: string;
  readonly polite: boolean;
  readonly sid = sid();
  remoteSid: string | null = null;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  state: PeerState = { band: null, radio: 0, baseDb: null, at: 0 };
  candidate: VoicePeerDebug['candidate'] = 'none';
  bytesReceived = 0;
  private makingOffer = false;
  private ignoreOffer = false;
  private srdAnswerPending = false;
  private disconnectedAt = 0;
  private deps: MeshDeps;
  closed = false;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCands: RTCIceCandidateInit[] = [];
  /** remote candidates accepted / dropped (debug) */
  cands = 0;
  dropped = 0;
  sent = 0;

  constructor(id: string, deps: MeshDeps) {
    this.id = id;
    this.deps = deps;
    const me = deps.me() ?? '';
    this.polite = me < id;
    this.pc = new RTCPeerConnection({
      iceServers: deps.iceServers() as RTCIceServer[],
      iceTransportPolicy: deps.relayOnly() ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    });
    const send = deps.sendTrack();
    if (send) this.pc.addTrack(send.track, send.stream);
    else this.pc.addTransceiver('audio', { direction: 'recvonly' });
    this.dc = this.pc.createDataChannel('vstate', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.dc.onmessage = (e) => this.onData(e.data);
    this.pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      deps.onRemoteStream(id, stream);
    };
    this.pc.onicecandidate = ({ candidate }) => { this.sent++; this.signal({ cand: candidate ? candidate.toJSON() : null }); };
    this.pc.onnegotiationneeded = async () => {
      try {
        // Initial offer: only the impolite side (larger id) starts. The polite side waits a moment for that offer;
        // in glare Chrome's implicit rollback of an in-flight offer can leave the polite PC emitting no candidates.
        if (this.polite && !this.pc.remoteDescription) {
          await new Promise((r) => setTimeout(r, 2500));
          if (this.closed || this.pc.remoteDescription || this.pc.signalingState !== 'stable') return;
        }
        if (this.pc.signalingState !== 'stable') return;
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) this.signal({ desc: this.pc.localDescription.toJSON() });
      } catch (e) {
        deps.log(`peer ${id}: offer failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        this.makingOffer = false;
      }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') {
        deps.log(`peer ${id}: connection failed -> restartIce`);
        this.pc.restartIce();
      }
      if (s === 'connected') void this.pollStats();
    };
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      if (s === 'disconnected') this.disconnectedAt = performance.now();
      else if (s === 'connected' || s === 'completed') this.disconnectedAt = 0;
      else if (s === 'failed') this.pc.restartIce();
    };
    this.schedStats();
  }

  private signal(d: Omit<SigMsg, 'v' | 'sid'>): void {
    if (this.closed) return;
    this.deps.sendSig(this.id, { v: 'vm1', sid: this.sid, ...d } satisfies SigMsg);
  }

  /** returns false if the message belongs to a NEW remote session (caller rebuilds the peer and re-delivers) */
  async onSignal(m: SigMsg): Promise<boolean> {
    if (m.desc) {
      if (this.remoteSid && m.sid !== this.remoteSid) return false;
      this.remoteSid = m.sid;
      const pc = this.pc;
      const desc = m.desc;
      // perfect negotiation (MDN)
      const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.srdAnswerPending);
      const offerCollision = desc.type === 'offer' && !readyForOffer;
      this.ignoreOffer = !this.polite && offerCollision;
      this.deps.log(`peer ${this.id}: got ${desc.type} sid=${m.sid} state=${pc.signalingState} collision=${offerCollision} polite=${this.polite}${this.ignoreOffer ? ' -> IGNORED' : ''}`);
      if (this.ignoreOffer) return true;
      try {
        this.srdAnswerPending = desc.type === 'answer';
        await pc.setRemoteDescription(desc);
        this.srdAnswerPending = false;
        for (const c of this.pendingCands.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) this.signal({ desc: pc.localDescription.toJSON() });
        }
      } catch (e) {
        this.srdAnswerPending = false;
        this.deps.log(`peer ${this.id}: setRemoteDescription failed: ${e instanceof Error ? e.message : e}`);
      }
      return true;
    }
    if ('cand' in m) {
      if (m.sid !== this.remoteSid) { this.dropped++; return true; } // stale session or before its description: drop
      this.cands++;
      try {
        if (!this.pc.remoteDescription) { if (m.cand) this.pendingCands.push(m.cand); return true; }
        await this.pc.addIceCandidate(m.cand ?? undefined);
      } catch (e) {
        if (!this.ignoreOffer) this.deps.log(`peer ${this.id}: addIceCandidate failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return true;
  }

  private onData(data: unknown): void {
    if (typeof data !== 'string') return;
    try {
      const o = JSON.parse(data) as { b?: number; r?: number; d?: number };
      this.state = {
        band: typeof o.b === 'number' ? Math.max(0, Math.min(4, o.b | 0)) : this.state.band,
        radio: o.r ? 1 : 0,
        baseDb: typeof o.d === 'number' && Number.isFinite(o.d) ? o.d : this.state.baseDb,
        at: performance.now(),
      };
    } catch { /* ignore */ }
  }

  sendState(band: number, radio: 0 | 1, baseDb: number): void {
    if (this.dc.readyState !== 'open') return;
    try { this.dc.send(JSON.stringify({ b: band, r: radio, d: Math.round(baseDb * 10) / 10 })); } catch { /* closing */ }
  }

  readonly createdAt = performance.now();

  /** never got connected within the window -> the caller rebuilds this link (fresh sid; the other side follows) */
  stuck(now: number, attempt = 0): boolean {
    if (this.closed || this.everConnected) return false;
    const s = this.pc.connectionState;
    if (s === 'connected') { this.everConnected = true; return false; }
    // impolite side rebuilds first; the polite side only as a late fallback (avoids both rebuilding at once).
    // Backoff per attempt (a crew member without voice, e.g. a ws-only bot, never answers): 11 s, 22 s, 44 s .. 120 s
    const base = this.polite ? 22_000 : 11_000;
    return now - this.createdAt > Math.min(120_000, base * 2 ** attempt);
  }
  everConnected = false;

  /** ICE stuck in 'disconnected' (e.g. after a network change) -> restart */
  watchdog(now: number): void {
    if (this.closed) return;
    if (this.disconnectedAt && now - this.disconnectedAt > 5000) {
      this.disconnectedAt = now;
      this.deps.log(`peer ${this.id}: ICE disconnected >5s -> restartIce`);
      this.pc.restartIce();
    }
  }

  restartIce(): void {
    if (!this.closed) this.pc.restartIce();
  }

  private schedStats(): void {
    if (this.closed) return;
    this.statsTimer = setTimeout(() => { void this.pollStats().finally(() => this.schedStats()); }, 1000);
  }

  async pollStats(): Promise<void> {
    if (this.closed) return;
    try {
      const stats = await this.pc.getStats();
      let pairId: string | null = null;
      const byId = new Map<string, Record<string, unknown>>();
      let bytes = 0;
      stats.forEach((r: Record<string, unknown>) => {
        byId.set(r.id as string, r);
        if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') pairId = r.selectedCandidatePairId;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += Number(r.bytesReceived ?? 0);
      });
      if (!pairId) stats.forEach((r: Record<string, unknown>) => { if (r.type === 'candidate-pair' && r.selected) pairId = r.id as string; });
      this.bytesReceived = bytes;
      const pair = pairId ? byId.get(pairId) : undefined;
      if (pair) {
        const lc = byId.get(pair.localCandidateId as string);
        const rc = byId.get(pair.remoteCandidateId as string);
        const lt = String(lc?.candidateType ?? 'none');
        const rt = String(rc?.candidateType ?? 'none');
        this.candidate = (lt === 'relay' || rt === 'relay' ? 'relay' : lt) as VoicePeerDebug['candidate'];
      } else if (this.pc.connectionState === 'failed') this.candidate = 'none';
    } catch { /* closed */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.statsTimer) clearTimeout(this.statsTimer);
    try { this.dc.close(); } catch { /* ignore */ }
    this.pc.close();
  }
}

export class Mesh {
  readonly peers = new Map<string, Peer>();
  private deps: MeshDeps;
  constructor(deps: MeshDeps) {
    this.deps = deps;
  }

  ensure(id: string): Peer {
    let p = this.peers.get(id);
    if (!p || p.closed) {
      p = new Peer(id, this.deps);
      this.peers.set(id, p);
    }
    return p;
  }

  drop(id: string): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.close();
    this.peers.delete(id);
    this.deps.onPeerClosed(id);
  }

  async onSig(from: string, d: unknown): Promise<void> {
    const m = d as SigMsg;
    if (!m || m.v !== 'vm1' || typeof m.sid !== 'string') return;
    if (!this.deps.me() || from === this.deps.me()) return;
    let p = this.ensure(from);
    const ok = await p.onSignal(m);
    if (!ok) {
      this.deps.log(`peer ${from}: new remote session -> rebuilding the connection`);
      this.drop(from);
      p = this.ensure(from);
      await p.onSignal(m);
    }
  }

  /** keep exactly the given remote ids connected */
  sync(ids: readonly string[]): void {
    const want = new Set(ids);
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.drop(id);
    const now = performance.now();
    for (const id of want) {
      const p = this.peers.get(id);
      if (p?.everConnected) this.rebuilds.delete(id);
      const n = this.rebuilds.get(id) ?? 0;
      if (p && p.stuck(now, n)) {
        this.deps.log(`peer ${id}: not connected after ${Math.round((now - p.createdAt) / 1000)}s (${p.pc.connectionState}) -> rebuilding (#${n + 1})`);
        this.rebuilds.set(id, n + 1);
        this.drop(id);
      }
      this.ensure(id);
    }
    for (const id of [...this.rebuilds.keys()]) if (!want.has(id)) this.rebuilds.delete(id);
  }
  private rebuilds = new Map<string, number>();

  closeAll(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
  }
}
