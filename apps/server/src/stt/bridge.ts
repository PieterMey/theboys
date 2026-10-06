// Owner: track (e) speech. STT bridge (PLAN §4.6/§4.7):
//   ctx.onVoiceChunk -> per player, per segId buffer (start/end flags, max ~10 s; chunks of players who did not
//   consent to transcription are dropped: they stay loudness-only) -> on segEnd POST the PCM to the sidecar with
//   langs=en,nl + hotwords (layout callsigns + crew names); one request in flight per player, queue max 2 (oldest
//   dropped), stale (> 5 s since segEnd) dropped.
//   WHO HEARD WHAT: while a segment is open, every sim tick accumulates hearers with the max band radius so far and
//   path distance from the speaker: living players, the Listener (from snapshot monsters, or a dbg fake), walkie
//   receivers when the speaker transmitted (+ the 0.6x leak around each receiving walkie when flags.radioLeak).
//   The speaker's room is recorded at onset. Dead speakers never reach the Listener (only other dead players).
//   Transcripts live in RAM only (never written to disk or logs).
import { BAND_RADIUS_M, BAND, VOICE } from '@dead-air/shared/constants.ts';
import { CALLSIGN_INFO, layoutCallsigns } from '@dead-air/shared/callsign.ts';
import type { VoiceChunkHeader } from '@dead-air/shared/envelope.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { Snapshot } from '@dead-air/shared/state.ts';
import type { Utterance } from '@dead-air/shared/messages/ai.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { doorOpenFor, hasWalkie, isAlive, monstersApi } from '../ai/adapters.ts';
import { addQuote, aiBal, balNum, emitUtterance, flagOn, setSttStatus } from '../ai/hub.ts';
import { analyze } from '../ai/text.ts';
import { Hearing, euclid } from './hearing.ts';
import { health, transcribe } from './client.ts';

const SAMPLE_RATE = VOICE.sampleRate;

interface Seg {
  /** layout at onset (callsigns are resolved against the layout the words were spoken in) */
  layout: LevelLayout | null;
  segId: number;
  pid: string;
  name: string;
  chunks: Int16Array[];
  samples: number;
  startedAt: number;
  lastChunkPerf: number;
  endedAt: number;
  endedPerf: number;
  maxBand: number;
  roomId: number;
  room: string | null;
  pos: [number, number];
  radio: boolean;
  players: Set<string>;
  walkies: Set<string>;
  listener: boolean;
  listenerDist: number;
  speakerAlive: boolean;
  closed: boolean;
}

interface PState { open: Seg | null; ignoreSegId: number; queue: Seg[]; busy: boolean }

export interface ListenerPos { x: number; z: number; active: boolean; at: number }

/** per-player pipeline counters for one transcribed phase (contract): evidence in the server log, counts only */
export interface PlayerSttRun {
  name: string;
  /** voice chunks received while the phase allowed STT (consenting or not) */
  chunks: number;
  /** of those, ignored because the player opted out of transcription */
  consentChunks: number;
  segments: number;
  /** segments shorter than sttMinSegmentMs, or dropped stale / by the per-player queue cap */
  dropped: number;
  utterances: number;
  empty: number;
  failed: number;
  /** utterances whose hearers include the Listener */
  heard: number;
  /** loudest band the server saw from this player's 'loud' messages during the run */
  maxBand: number;
}

export interface SttRun {
  phase: string;
  startedPerf: number;
  players: Map<string, PlayerSttRun>;
  firstUtteranceLogged: boolean;
  firstFailureLogged: boolean;
  /** nearest Listener path distance (m) of any segment, heard or not (Infinity = never within the max radius) */
  listenerNearestM: number;
}

interface CrewAi {
  players: Map<string, PState>;
  hearing: Hearing | null;
  hearingFor: LevelLayout | null;
  listener: ListenerPos | null;
  fakeListener: { x: number; z: number } | null;
  recent: Utterance[];
  textSeq: number;
  run: SttRun | null;
}

const stats = { segments: 0, utterances: 0, dropped: 0, empty: 0, failed: 0, consentDrops: 0, lastMs: null as number | null, recentMs: [] as number[], inFlight: 0, healthy: null as boolean | null };

export function crewAi(crew: Crew): CrewAi {
  const s = crew.slices as { ai?: CrewAi };
  s.ai ??= { players: new Map(), hearing: null, hearingFor: null, listener: null, fakeListener: null, recent: [], textSeq: 0, run: null };
  s.ai.run ??= null;
  return s.ai;
}

function runPlayer(crew: Crew, pid: string): PlayerSttRun | null {
  const run = crewAi(crew).run;
  if (!run) return null;
  let p = run.players.get(pid);
  if (!p) {
    const name = crew.players.get(pid)?.name ?? pid;
    run.players.set(pid, (p = { name, chunks: 0, consentChunks: 0, segments: 0, dropped: 0, utterances: 0, empty: 0, failed: 0, heard: 0, maxBand: 0 }));
  }
  return p;
}

function pstate(crew: Crew, pid: string): PState {
  const st = crewAi(crew);
  let p = st.players.get(pid);
  if (!p) st.players.set(pid, (p = { open: null, ignoreSegId: -1, queue: [], busy: false }));
  return p;
}

export function bandRadius(ctx: ServerContext, band: number): number {
  const arr = (ctx.balance.voice?.bandRadiusM ?? BAND_RADIUS_M) as readonly number[];
  const b = Math.max(0, Math.min(BAND.scream, band | 0));
  const r = arr[b];
  return typeof r === 'number' && Number.isFinite(r) ? r : BAND_RADIUS_M[b];
}

function hearingOf(crew: Crew): Hearing | null {
  const st = crewAi(crew);
  const L = crew.layout;
  if (!L) {
    st.hearing = null;
    st.hearingFor = null;
    return null;
  }
  if (st.hearingFor !== L) {
    try {
      st.hearing = new Hearing(L, 40);
    } catch {
      st.hearing = null;
    }
    st.hearingFor = L;
  }
  return st.hearing;
}

/** Hotwords: primary spoken form of every layout callsign, crew names, then alternate forms (sidecar caps 40 / 400 chars). */
export function hotwords(crew: Crew, layout: LevelLayout | null = crew.layout): string[] {
  const out: string[] = [];
  const add = (w: string) => {
    const s = w.replace(/[,\s]+/g, ' ').trim();
    if (s && !out.includes(s) && out.length < 40 && out.join(',').length + s.length < 390) out.push(s);
  };
  const cs = layout ? layoutCallsigns(layout) : [];
  for (const c of cs) add(CALLSIGN_INFO[c]?.forms[0] ?? c.toLowerCase());
  for (const p of crew.players.values()) add(p.name);
  for (const c of cs) {
    const f = CALLSIGN_INFO[c]?.forms;
    if (f && f[1]) add(f[1]);
  }
  return out;
}

export function listenerPosition(crew: Crew): { x: number; z: number } | null {
  const st = crewAi(crew);
  if (st.fakeListener) return st.fakeListener;
  const api = monstersApi();
  if (api?.monsterPositions) {
    try {
      const m = api.monsterPositions(crew).find((x) => x.kind === 'listener');
      return m && Number.isFinite(m.x) && Number.isFinite(m.z) ? { x: m.x, z: m.z } : null;
    } catch { /* fall back to the snapshot */ }
  }
  const l = st.listener;
  if (!l || performance.now() - l.at > 2000) return null;
  return l;
}

/** crewSnapshot hook (runs after the monsters track filled snap.monsters). */
export function noteSnapshot(crew: Crew, snap: Snapshot): void {
  const m = snap.monsters.find((x) => x.kind === 'listener');
  const st = crewAi(crew);
  st.listener = m && Array.isArray(m.p) ? { x: m.p[0], z: m.p[2], active: m.active !== false, at: performance.now() } : null;
}

// ---------------------------------------------------------------- hearers

function accumulate(ctx: ServerContext, crew: Crew, seg: Seg, speaker: ServerPlayer): void {
  const band = Math.max(seg.maxBand, speaker.band | 0);
  seg.maxBand = band;
  if (speaker.radio) seg.radio = true;
  const alive = isAlive(crew, speaker);
  if (!alive) seg.speakerAlive = false;
  if (!seg.speakerAlive) {
    // the dead hear each other in 2D; the living and the Listener never hear the dead
    for (const q of crew.players.values()) if (q !== speaker && q.connected && !isAlive(crew, q)) seg.players.add(q.id);
    return;
  }
  const radius = bandRadius(ctx, band);
  if (radius <= 0) return;
  const H = hearingOf(crew);
  const doorOpen = doorOpenFor(crew);
  if (H) H.setDoors(H.doorSignature(doorOpen));
  const dist = (ax: number, az: number, bx: number, bz: number) => (H ? H.dist(ax, az, bx, bz, doorOpen) : euclid(ax, az, bx, bz));
  const sx = speaker.pose.p[0], sz = speaker.pose.p[2];
  const living: ServerPlayer[] = [];
  for (const q of crew.players.values()) if (q !== speaker && q.connected && isAlive(crew, q)) living.push(q);
  for (const q of living) if (dist(sx, sz, q.pose.p[0], q.pose.p[2]) <= radius) seg.players.add(q.id);
  const L = listenerPosition(crew);
  if (L) {
    const d = dist(sx, sz, L.x, L.z);
    const run = crewAi(crew).run;
    if (run && d < run.listenerNearestM) run.listenerNearestM = d;
    if (d <= radius) {
      seg.listener = true;
      seg.listenerDist = Math.min(seg.listenerDist, d);
    }
  }
  if (speaker.radio && hasWalkie(crew, speaker)) {
    const receivers = living.filter((q) => hasWalkie(crew, q));
    const leakOn = flagOn('radioLeak') && ctx.flags.radioLeak === true;
    const leak = radius * balNum('walkieLeakMult', 0.6);
    for (const r of receivers) {
      seg.walkies.add(r.id);
      seg.players.add(r.id);
      if (!leakOn) continue;
      const rx = r.pose.p[0], rz = r.pose.p[2];
      for (const q of living) if (q !== r && dist(rx, rz, q.pose.p[0], q.pose.p[2]) <= leak) seg.players.add(q.id);
      if (L) {
        const d = dist(rx, rz, L.x, L.z);
        if (d <= leak) {
          seg.listener = true;
          seg.listenerDist = Math.min(seg.listenerDist, d);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- segments

function phaseAllowed(ctx: ServerContext, crew: Crew): boolean {
  const ph = aiBal().sttPhases;
  return !Array.isArray(ph) || ph.includes(crew.phase);
}

function openSeg(ctx: ServerContext, crew: Crew, player: ServerPlayer, h: VoiceChunkHeader): Seg {
  const x = player.pose.p[0], z = player.pose.p[2];
  const H = hearingOf(crew);
  const roomId = H ? H.spaceAt(x, z) : -1;
  const room = roomId >= 0 ? (crew.layout?.spaces[roomId]?.callsign ?? null) : null;
  const seg: Seg = {
    layout: crew.layout,
    segId: h.segId, pid: player.id, name: player.name, chunks: [], samples: 0, startedAt: ctx.now(), lastChunkPerf: performance.now(),
    endedAt: 0, endedPerf: 0, maxBand: h.maxBand | 0, roomId, room, pos: [x, z], radio: player.radio === 1,
    players: new Set(), walkies: new Set(), listener: false, listenerDist: Infinity, speakerAlive: isAlive(crew, player), closed: false,
  };
  stats.segments++;
  const rp = runPlayer(crew, player.id);
  if (rp) rp.segments++;
  accumulate(ctx, crew, seg, player);
  return seg;
}

function noteDrop(crew: Crew, pid: string): void {
  stats.dropped++;
  const rp = runPlayer(crew, pid);
  if (rp) rp.dropped++;
}

function closeSeg(ctx: ServerContext, crew: Crew, player: ServerPlayer | undefined, seg: Seg): void {
  if (seg.closed) return;
  seg.closed = true;
  seg.endedAt = ctx.now();
  seg.endedPerf = performance.now();
  if (player) accumulate(ctx, crew, seg, player);
  const ps = pstate(crew, seg.pid);
  if (ps.open === seg) ps.open = null;
  const minSamples = (balNum('sttMinSegmentMs', 250) / 1000) * SAMPLE_RATE;
  if (seg.samples < minSamples) {
    noteDrop(crew, seg.pid);
    return;
  }
  ps.queue.push(seg);
  const max = Math.max(0, balNum('sttQueueMax', 2));
  while (ps.queue.length > max) {
    ps.queue.shift();
    noteDrop(crew, seg.pid);
  }
  pump(ctx, crew, seg.pid);
}

function pump(ctx: ServerContext, crew: Crew, pid: string): void {
  const ps = pstate(crew, pid);
  if (ps.busy) return;
  let seg: Seg | undefined;
  const stale = balNum('sttStaleMs', 5000);
  while ((seg = ps.queue.shift())) {
    if (performance.now() - seg.endedPerf <= stale) break;
    noteDrop(crew, pid);
  }
  if (!seg) return;
  ps.busy = true;
  stats.inFlight++;
  const s = seg;
  const pcm = new Uint8Array(new ArrayBuffer(s.samples * 2));
  let off = 0;
  for (const c of s.chunks) {
    pcm.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), off);
    off += c.byteLength;
  }
  s.chunks = [];
  const langs = typeof aiBal().sttLangs === 'string' ? (aiBal().sttLangs as string) : 'en,nl';
  void transcribe(ctx.env.STT_URL, pcm, langs, hotwords(crew, s.layout), balNum('sttTimeoutMs', 4000))
    .then((out) => {
      stats.lastMs = Math.round(out.ms);
      stats.recentMs.push(out.ms);
      if (stats.recentMs.length > 30) stats.recentMs.shift();
      if (!out.ok) {
        stats.failed++;
        const rp = runPlayer(crew, pid);
        if (rp) rp.failed++;
        if (out.reason === 'network') stats.healthy = false;
        const why = `${out.reason}${out.status ? ` HTTP ${out.status}` : ''}`;
        const run = crewAi(crew).run;
        if (run && !run.firstFailureLogged) {
          // production logs info+: the first failure per contract must be visible (later ones stay debug)
          run.firstFailureLogged = true;
          ctx.log('stt').warn(`crew ${crew.code}: transcription request failed (${why}, ${Math.round(out.ms)} ms) at ${ctx.env.STT_URL}`);
        } else ctx.log('stt').debug(`transcribe failed: ${why}`);
        return;
      }
      stats.healthy = true;
      deliver(ctx, crew, s, out.res.text, out.res.lang ?? null, out.ms);
    })
    .catch(() => {
      stats.failed++;
      const rp = runPlayer(crew, pid);
      if (rp) rp.failed++;
    })
    .finally(() => {
      ps.busy = false;
      stats.inFlight--;
      pump(ctx, crew, pid);
    });
}

function deliver(ctx: ServerContext, crew: Crew, seg: Seg, rawText: string, lang: string | null, sttMs: number): void {
  const text = (rawText ?? '').trim();
  if (!text) {
    stats.empty++;
    const rp = runPlayer(crew, seg.pid);
    if (rp) rp.empty++;
    return;
  }
  const speaker = crew.players.get(seg.pid);
  if (speaker && !isAlive(crew, speaker)) seg.speakerAlive = false;
  const u = buildUtterance(crew, {
    layout: seg.layout, segId: seg.segId, speaker: seg.pid, speakerName: speaker?.name ?? seg.name, text, lang, band: seg.maxBand, room: seg.room, roomId: seg.roomId,
    pos: seg.pos, startedAt: seg.startedAt, endedAt: seg.endedAt, viaRadio: seg.radio, kind: 'voice',
    players: [...seg.players], walkies: [...seg.walkies], listener: seg.speakerAlive && seg.listener, listenerDist: seg.listenerDist, sttMs,
  });
  publish(ctx, crew, u);
}

interface UtteranceParts {
  layout?: LevelLayout | null;
  segId: number; speaker: string; speakerName: string; text: string; lang: string | null; band: number; room: string | null; roomId: number;
  pos: [number, number]; startedAt: number; endedAt: number; viaRadio: boolean; kind: 'voice' | 'text';
  players: string[]; walkies: string[]; listener: boolean; listenerDist: number; sttMs: number;
}

export function buildUtterance(crew: Crew, p: UtteranceParts): Utterance {
  const L = p.layout !== undefined ? p.layout : crew.layout;
  const cs = L ? layoutCallsigns(L) : [];
  const roster = [...crew.players.values()].map((q) => ({ id: q.id, name: q.name }));
  const a = analyze(p.text, cs, roster.filter((q) => q.id !== p.speaker));
  const hearers: Utterance['hearers'] = { players: p.players.filter((id) => id !== p.speaker), listener: p.listener, walkies: p.walkies };
  if (p.listener && Number.isFinite(p.listenerDist)) hearers.listenerDistM = Math.round(p.listenerDist * 10) / 10;
  return {
    segId: p.segId, crew: crew.code, speaker: p.speaker, speakerName: p.speakerName, text: p.text, norm: a.norm, lang: p.lang, band: p.band,
    room: p.room, roomId: p.roomId, pos: p.pos, startedAt: p.startedAt, endedAt: p.endedAt, viaRadio: p.viaRadio, kind: p.kind,
    via: p.kind === 'text' ? 'text' : p.viaRadio ? 'radio' : 'voice',
    callsigns: a.callsigns, names: a.names, digits: a.digits, meaningful: a.meaningful, taunt: a.taunt, hearers, sttMs: Math.round(p.sttMs),
  };
}

function publish(ctx: ServerContext, crew: Crew, u: Utterance): void {
  const st = crewAi(crew);
  stats.utterances++;
  st.recent.push(u);
  const keep = balNum('recentUtterances', 50);
  if (st.recent.length > keep) st.recent.splice(0, st.recent.length - keep);
  addQuote(crew.code, u.speaker, { text: u.text, at: u.endedAt, heardByListener: u.hearers.listener, meaningful: u.meaningful, band: u.band }, balNum('quotesPerPlayer', 40));
  const rp = runPlayer(crew, u.speaker);
  if (rp) {
    rp.utterances++;
    if (u.hearers.listener) rp.heard++;
  }
  const run = st.run;
  if (run && !run.firstUtteranceLogged) {
    // one info line per contract proves the whole chain worked (counts only: transcripts never reach the log)
    run.firstUtteranceLogged = true;
    ctx.log('stt').info(`crew ${crew.code}: first transcript this ${run.phase} (${u.speakerName}, ${u.text.length} chars, ${u.sttMs} ms STT, Listener ${u.hearers.listener ? `heard it at ${u.hearers.listenerDistM ?? '?'} m` : 'out of earshot'})`);
  }
  if (process.env.STT_LOG_TEXT === '1') ctx.log('stt').info(`${u.speakerName}: ${u.text}`);
  else ctx.log('stt').debug(`utterance seg ${u.segId}: ${u.text.length} chars, ${u.callsigns.length} callsigns, hearers ${u.hearers.players.length} listener=${u.hearers.listener}`);
  emitUtterance(crew, u);
}

/**
 * Proximity text (players track): the monsters track already feeds typed lines to the Listener itself (onProxText),
 * so they are NOT re-emitted via onUtterance (that would double-count). They only become HR-memo quote candidates.
 */
export function onProxText(_ctx: ServerContext, crew: Crew, e: { player: ServerPlayer; text: string; x: number; z: number; radiusM: number; heardBy: string[]; t: number }): void {
  if (!e?.player || typeof e.text !== 'string' || !e.text.trim() || !e.player.consent.transcribe) return;
  const text = e.text.trim().slice(0, 200);
  const cs = crew.layout ? layoutCallsigns(crew.layout) : [];
  const a = analyze(text, cs, []);
  addQuote(crew.code, e.player.id, { text, at: e.t, heardByListener: false, meaningful: a.meaningful, band: BAND.talk }, balNum('quotesPerPlayer', 40));
}

// ---------------------------------------------------------------- wiring

/**
 * WORKAROUND for core decodeVoiceChunk (packages/shared/src/envelope.ts): ws delivers frames as Node Buffers
 * (pooled 8 KB slabs for < 4 KB), and Buffer#slice is a VIEW, so `new Int16Array(bytes.buffer, 0, ...)` reads
 * from offset 0 of the slab instead of the payload. Locate this chunk's exact 9-byte header in the underlying
 * ArrayBuffer and copy the payload that follows it. Always returns an owned copy (the slab gets reused).
 * Harmless once the decoder is fixed (a fresh exact-size buffer has no room for a header -> plain copy).
 */
export function recoverPcm(h: VoiceChunkHeader, pcm: Int16Array): Int16Array {
  const ab = pcm.buffer as ArrayBuffer;
  const need = pcm.byteLength;
  if (!(ab instanceof ArrayBuffer) || ab.byteLength < need + 9) return pcm.slice();
  const u8 = new Uint8Array(ab);
  const flags = (h.start ? 1 : 0) | (h.end ? 2 : 0);
  const id = h.segId >>> 0;
  const b1 = id & 0xff, b2 = (id >>> 8) & 0xff, b3 = (id >>> 16) & 0xff, b4 = (id >>> 24) & 0xff;
  const q0 = h.seq & 0xff, q1 = (h.seq >>> 8) & 0xff, mb = h.maxBand & 0xff;
  const last = ab.byteLength - need - 9;
  for (let o = 0; o <= last; o++) {
    if (u8[o] !== 1 || u8[o + 1] !== b1 || u8[o + 2] !== b2 || u8[o + 3] !== b3 || u8[o + 4] !== b4) continue;
    if (u8[o + 5] !== q0 || u8[o + 6] !== q1 || u8[o + 7] !== flags || u8[o + 8] !== mb) continue;
    if (o + 9 === pcm.byteOffset) return pcm.slice();
    return new Int16Array(ab.slice(o + 9, o + 9 + need));
  }
  return pcm.slice();
}

export function handleChunk(ctx: ServerContext, crew: Crew, player: ServerPlayer, h: VoiceChunkHeader, rawPcm: Int16Array): void {
  if (!flagOn('stt') || ctx.flags.stt === false) return;
  const ps = pstate(crew, player.id);
  const allowed = phaseAllowed(ctx, crew);
  if (allowed && !crewAi(crew).run) startRun(ctx, crew, crew.phase); // e.g. a server restart mid-contract
  const rp = allowed ? runPlayer(crew, player.id) : null;
  if (rp) rp.chunks++;
  if (!player.consent.transcribe) {
    if (ps.open) ps.open = null;
    stats.consentDrops++;
    if (rp) rp.consentChunks++;
    return;
  }
  if (!allowed) return;
  let seg = ps.open;
  if (seg && seg.segId !== h.segId) {
    closeSeg(ctx, crew, player, seg);
    seg = null;
  }
  if (!seg) {
    if (ps.ignoreSegId === h.segId) return;
    seg = openSeg(ctx, crew, player, h);
    ps.open = seg;
  }
  const pcm = recoverPcm(h, rawPcm);
  seg.lastChunkPerf = performance.now();
  if ((h.maxBand | 0) > seg.maxBand) seg.maxBand = h.maxBand | 0;
  const maxSamples = Math.round((balNum('sttMaxSegmentMs', VOICE.maxSegmentMs + 500) / 1000) * SAMPLE_RATE);
  const room = maxSamples - seg.samples;
  if (pcm.length > room) {
    if (room > 0) {
      seg.chunks.push(pcm.subarray(0, room));
      seg.samples += room;
    }
    ps.ignoreSegId = h.segId; // drop the rest of an over-long segment
    closeSeg(ctx, crew, player, seg);
    return;
  }
  if (pcm.length) {
    seg.chunks.push(pcm);
    seg.samples += pcm.length;
  }
  if (h.end) closeSeg(ctx, crew, player, seg);
}

/** Sim tick: accumulate hearers for open segments, close idle ones. */
export function tick(ctx: ServerContext, crew: Crew): void {
  const st = crew.slices.ai as CrewAi | undefined;
  if (!st) return;
  if (st.run) {
    for (const p of crew.players.values()) {
      if (!p.connected || (p.band | 0) <= 0) continue;
      const rp = runPlayer(crew, p.id);
      if (rp && (p.band | 0) > rp.maxBand) rp.maxBand = p.band | 0;
    }
  }
  const idle = balNum('sttIdleCloseMs', 1500);
  const now = performance.now();
  for (const [pid, ps] of st.players) {
    const seg = ps.open;
    if (!seg) continue;
    const speaker = crew.players.get(pid);
    if (!speaker || !speaker.connected || now - seg.lastChunkPerf > idle) {
      closeSeg(ctx, crew, speaker, seg);
      continue;
    }
    accumulate(ctx, crew, seg, speaker);
  }
}

// ---------------------------------------------------------------- per-contract evidence (server log, counts only)

const BAND_NAME = ['SILENT', 'WHISPER', 'TALK', 'SHOUT', 'SCREAM'];

function runPhases(): string[] {
  const ph = aiBal().sttPhases;
  return Array.isArray(ph) ? ph.map(String) : ['contract'];
}

function startRun(ctx: ServerContext, crew: Crew, phase: string): SttRun {
  const st = crewAi(crew);
  st.run = { phase, startedPerf: performance.now(), players: new Map(), firstUtteranceLogged: false, firstFailureLogged: false, listenerNearestM: Infinity };
  for (const p of crew.players.values()) if (p.connected) runPlayer(crew, p.id);
  const off = [...crew.players.values()].filter((p) => p.connected && !p.consent.transcribe).map((p) => p.name);
  if (off.length) ctx.log('stt').info(`crew ${crew.code}: transcription OFF for ${off.join(', ')} (loudness only this ${phase})`);
  return st.run;
}

/** one summary per transcribed phase: which players streamed voice, how much became text, what the Listener heard */
export function endRun(ctx: ServerContext, crew: Crew): void {
  const st = crew.slices.ai as CrewAi | undefined;
  const run = st?.run;
  if (!st || !run) return;
  st.run = null;
  const log = ctx.log('stt');
  const secs = Math.round((performance.now() - run.startedPerf) / 1000);
  const t = { segments: 0, utterances: 0, empty: 0, failed: 0, dropped: 0, heard: 0 };
  for (const p of run.players.values()) {
    t.segments += p.segments; t.utterances += p.utterances; t.empty += p.empty; t.failed += p.failed; t.dropped += p.dropped; t.heard += p.heard;
  }
  const near = Number.isFinite(run.listenerNearestM) ? `${run.listenerNearestM.toFixed(1)} m` : 'never within 40 m';
  log.info(`crew ${crew.code}: STT ${run.phase} summary (${secs} s, sidecar ${ctx.env.STT_URL} ${stats.healthy === false ? 'DOWN' : 'up'}): ${t.segments} segments -> ${t.utterances} transcripts (${t.empty} empty, ${t.failed} failed, ${t.dropped} dropped); Listener heard ${t.heard}, closest speaker ${near}`);
  for (const p of run.players.values()) {
    let note = '';
    if (p.chunks === 0) note = p.maxBand > 0 ? ' | NO voice chunks although its band rose above SILENT (client not streaming PCM)' : ' | no voice chunks: never above SILENT (muted, push-to-talk, or a very quiet mic)';
    else if (p.consentChunks >= p.chunks) note = ' | transcription OFF (loudness only)';
    log.info(`  ${p.name}: ${p.chunks} chunks, ${p.segments} segments, ${p.utterances} transcripts (${p.empty} empty, ${p.failed} failed, ${p.dropped} dropped), Listener heard ${p.heard}, loudest band ${BAND_NAME[p.maxBand] ?? p.maxBand}${note}`);
  }
}

/** phase hook: entering a transcribed phase starts a run, leaving it logs the run's summary */
export function onPhase(ctx: ServerContext, crew: Crew, _from: string, to: string): void {
  const phases = runPhases();
  const st = crewAi(crew);
  if (st.run && !phases.includes(to)) endRun(ctx, crew);
  if (!st.run && phases.includes(to)) startRun(ctx, crew, to);
}

export function sttRun(crew: Crew): { phase: string; listenerNearestM: number | null; players: Record<string, PlayerSttRun> } | null {
  const run = crewAi(crew).run;
  if (!run) return null;
  return { phase: run.phase, listenerNearestM: Number.isFinite(run.listenerNearestM) ? Math.round(run.listenerNearestM * 10) / 10 : null, players: Object.fromEntries([...run.players].map(([id, p]) => [id, { ...p }])) };
}

export function dropPlayer(crew: Crew, pid: string): void {
  const st = crew.slices.ai as CrewAi | undefined;
  st?.players.delete(pid);
}

export function recentUtterances(crew: Crew): Utterance[] {
  return crewAi(crew).recent.slice();
}

export function setFakeListener(crew: Crew, pos: { x: number; z: number } | null): void {
  crewAi(crew).fakeListener = pos;
}

function p50(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.floor((s.length - 1) / 2)]);
}

export function sttStats(ctx: ServerContext, crews: () => Crew[]): void {
  setSttStatus(() => {
    let queued = 0;
    for (const c of crews()) {
      const st = c.slices.ai as CrewAi | undefined;
      if (st) for (const ps of st.players.values()) queued += ps.queue.length;
    }
    return {
      url: ctx.env.STT_URL, healthy: stats.healthy, lastMs: stats.lastMs, p50Ms: p50(stats.recentMs), inFlight: stats.inFlight, queued,
      segments: stats.segments, utterances: stats.utterances, dropped: stats.dropped + stats.failed,
    };
  });
}

/** Background sidecar health poll (self-rescheduling setTimeout; never setInterval on the server). */
export function startHealthPoll(ctx: ServerContext): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let warned = false;
  const run = async () => {
    const h = await health(ctx.env.STT_URL);
    stats.healthy = h.ok;
    if (!h.ok && !warned) {
      warned = true;
      ctx.log('stt').warn(`STT sidecar not reachable at ${ctx.env.STT_URL} (start it with npm run stt); voice stays loudness-only until it is`);
    }
    if (h.ok && warned) {
      warned = false;
      ctx.log('stt').info(`STT sidecar healthy (${h.device ?? '?'})`);
    }
    if (!stopped) {
      timer = setTimeout(() => void run(), balNum('sttHealthEveryMs', 10_000));
      timer.unref();
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
