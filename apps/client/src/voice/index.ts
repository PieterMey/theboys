// Owner: track ④ Voice (apps/client/src/voice/**). Proximity voice: mic + band detector, WebRTC mesh, per-voice
// Web Audio playback with the 1:1 gating rule, radio chain, dead channel, calibration + echo check, HUD meter.
// Provides services.voice (VoiceService, augmented below) and window.__voiceDebug (test mode / dev).
import { BAND_HOLD_MS, BAND_RADIUS_M } from '@dead-air/shared/constants.ts';
import type { RTCIceServerLike } from '@dead-air/shared/envelope.ts';
import type { VoiceDebugApi, VoicePeerDebug } from '@dead-air/shared/test-api.ts';
import type { ClientContext } from '../core/context.ts';
import { getGraph, applyListener, listenerPose, useLoose } from '../audio/graph.ts';
import type { AudioGraph, V3 } from '../audio/graph.ts';
import { levelGrid, occlusionParams, wallCrossings } from '../audio/occlusion.ts';
import { Mic, bandConfig } from './mic.ts';
import type { MicDevice } from './mic.ts';
import { Mesh } from './mesh.ts';
import { RemoteVoice } from './playback.ts';
import type { GateInput, VoiceTuning } from './playback.ts';
import { echoCheck, runCalibration } from './calibrate.ts';
import type { CalOpts, CalibrationResult, EchoResult } from './calibrate.ts';
import { BandMeter, CalibrationScreen, MicJoinSection } from './ui.tsx';

export { CalibrationPanel, CalibrationScreen, BandMeter } from './ui.tsx';
export type { CalibrationResult } from './calibrate.ts';

declare module '../core/services.ts' {
  interface VoiceService {
    /** 6-8 s calibration (noise, talk, optional whisper/shout) + echo check; usable by the meta kennel UI */
    calibrate(opts?: CalOpts): Promise<CalibrationResult>;
    echoCheck(): Promise<EchoResult | null>;
    setPushToTalk(on: boolean): void;
    pushToTalk(): boolean;
    /** true when a failed echo check forced PTT ('speakers: PTT on' badge) */
    speakersPtt(): boolean;
    peers(): Record<string, { state: string; candidate: string; name: string; band: number; gain: number }>;
    hasMic(): boolean;
    micError(): string | null;
    devices(): Promise<MicDevice[]>;
    setDevice(deviceId: string): Promise<boolean>;
    deviceId(): string;
    setMicGain(g: number): void;
    micGain(): number;
    /** live mic level (dBFS, 100 ms window) and the current talk baseline */
    level(): { db: number; base: number; gate: number; band: number };
    radio(): 0 | 1;
    transmitting(): boolean;
    setTranscribe(on: boolean): void;
    transcribe(): boolean;
    setRelayOnly(on: boolean): void;
    relayOnly(): boolean;
    setPeerVolume(id: string, v: number): void;
    setMuted(on: boolean): void;
    /** start the mic now (inside or after a user gesture); also happens automatically on audio unlock */
    startMic(): Promise<boolean>;
  }
}

interface InteractionLike { hasWalkie?(id: string): boolean }
interface PlayersLike { headPos?(id: string): V3 | null; spectating?(): boolean }

const LS_PTT = 'deadair.voice.ptt';
const LS_SPK = 'deadair.voice.speakersPtt';
const LS_TX = 'deadair.voice.transcribe';
const LS_RELAY = 'deadair.voice.relay';
function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export interface VoiceInstallOpts {
  /** 'voicetest' = the /voicetest page: every peer 2D + ungated (link test) */
  mode?: 'game' | 'voicetest';
}

export function install(ctx: ClientContext, opts: VoiceInstallOpts = {}): void {
  const mode = opts.mode ?? 'game';
  const vb = (ctx.balance.voice ?? {}) as Record<string, unknown>;
  const num = (k: string, d: number) => (typeof vb[k] === 'number' ? (vb[k] as number) : d);
  const radius = Array.isArray(vb.bandRadiusM) && vb.bandRadiusM.length === 5 ? (vb.bandRadiusM as number[]) : [...BAND_RADIUS_M];
  const tuning: VoiceTuning = {
    radius,
    holdMs: num('bandHoldMs', BAND_HOLD_MS),
    makeupMaxDb: num('makeupMaxDb', 12),
    reverbSend: num('reverbSend', 0.12),
    deadReverbSend: num('deadReverbSend', 0.25),
    radioHiss: num('radioHiss', 0.012),
    selfHealSec: num('selfHealSec', 3),
    edgeFadeM: num('edgeFadeM', 1.5),
    panBoost: num('panBoost', 0.5),
  };
  const lowpassHz = Array.isArray(vb.occlusionLowpassHz) ? (vb.occlusionLowpassHz as number[]) : [20000, 2400, 1200, 700, 450];
  const perWallDb = num('occlusionPerWallDb', -6);
  const closedDoorFrac = num('closedDoorWallFrac', 0.6);
  const keepAlive = ctx.params.get('voiceNoKeepAlive') !== '1';
  const euclidOnly = ctx.params.get('voiceAud') === 'euclid';
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
    if (logs.length > 60) logs.shift();
    console.info(`[voice] ${m}`);
  };

  let mic: Mic | null = null;
  let graph: AudioGraph | null = null;
  let mesh: Mesh | null = null;
  let iceServers: RTCIceServerLike[] = [];
  let lastIceAt = 0;
  let relayOnly = ctx.params.get('relay') === '1' || lsGet(LS_RELAY) === '1';
  let transcribe = lsGet(LS_TX) !== '0'; // default ON (crew consent), toggle in the join section / settings
  let speakersPtt = lsGet(LS_SPK) === '1';
  let radioHeld = false;
  const voices = new Map<string, RemoteVoice>();
  const volumes = new Map<string, number>();
  const goneSince = new Map<string, number>();

  const walkie = (id: string | null): boolean => {
    if (!id) return false;
    // dev / test override first (flag devAllWalkies or ?walkies=1), then the interaction track's inventory
    if (ctx.flags.devAllWalkies === true || ctx.params.get('walkies') === '1') return true;
    const ia = useLoose<InteractionLike>(ctx, 'interaction');
    return ia?.hasWalkie ? ia.hasWalkie(id) : false;
  };
  const radioNow = (): 0 | 1 => (radioHeld && walkie(ctx.net.me) ? 1 : 0);

  const ensureMic = (): Mic | null => {
    const ac = ctx.audio.ctx;
    if (!ac) return null;
    graph ??= getGraph(ac);
    if (!mic) {
      mic = new Mic(ac, bandConfig(vb), {
        onLoud: (band, radio) => ctx.net.sendLoud(band, radio),
        onState: (band, radio, base) => { if (mesh) for (const p of mesh.peers.values()) p.sendState(band, radio, base); },
        onChunk: (h, pcm) => ctx.net.sendVoiceChunk(h, pcm),
        wantChunks: () => transcribe && ctx.net.status === 'joined' && mode === 'game',
        radio: radioNow,
        log,
      });
      mic.setPtt(speakersPtt || lsGet(LS_PTT) === '1');
    }
    return mic;
  };

  const startMic = async (): Promise<boolean> => {
    const m = ensureMic();
    if (!m) return false;
    if (m.hasMic()) return true;
    if (m.starting) return m.starting;
    const ok = await m.start();
    if (ok) log(`mic live: ${JSON.stringify(m.settings())}`);
    return ok;
  };

  ctx.bus.on('audio:unlocked', () => { void startMic(); });
  ctx.bus.on('join:click', () => { void startMic(); });

  // ---------------- mesh ----------------
  const refreshIce = async (force = false) => {
    if (!force && performance.now() - lastIceAt < 6 * 3600_000 && iceServers.length) return;
    try {
      const r = await ctx.net.req('voice.ice', undefined, 8000);
      iceServers = r.iceServers;
      lastIceAt = performance.now();
    } catch { /* keep the old list */ }
  };

  const ensureMesh = (): Mesh => {
    mesh ??= new Mesh({
      me: () => ctx.net.me,
      sendSig: (to, d) => ctx.net.sendSig(to, d),
      iceServers: () => iceServers,
      relayOnly: () => relayOnly,
      sendTrack: () => {
        const m = ensureMic();
        return m ? { track: m.sendTrack, stream: m.sendStream } : null;
      },
      onRemoteStream: (id, stream) => {
        const g = graph ?? (ctx.audio.ctx ? (graph = getGraph(ctx.audio.ctx)) : null);
        if (!g) return;
        const old = voices.get(id);
        if (old && old.stream === stream) return;
        old?.close();
        voices.set(id, new RemoteVoice(id, stream, g, tuning, { keepAlive, log }));
        log(`remote stream from ${id}${keepAlive ? '' : ' (NO keep-alive element: control mode)'}`);
      },
      onPeerClosed: (id) => {
        voices.get(id)?.close();
        voices.delete(id);
      },
      log,
    });
    return mesh;
  };

  ctx.net.onSig((from, d) => {
    if (!ctx.audio.ctx || !ctx.net.me) return;
    ensureMic();
    void ensureMesh().onSig(from, d);
  });

  const wantedPeers = (): string[] => {
    const me = ctx.net.me;
    const crew = ctx.world.crew;
    if (!me || !crew || ctx.net.status !== 'joined') return [];
    const now = performance.now();
    const out: string[] = [];
    for (const p of crew.players) {
      if (p.id === me) continue;
      if (p.connected) { goneSince.delete(p.id); out.push(p.id); continue; }
      // keep the link through short ws blips; WebRTC is independent of the game socket
      const since = goneSince.get(p.id) ?? now;
      goneSince.set(p.id, since);
      if (now - since < 15_000 && mesh?.peers.has(p.id)) out.push(p.id);
    }
    return out;
  };

  ctx.bus.on('net:welcome', ({ resumed }) => {
    const w = ctx.net.lastWelcome;
    if (w?.iceServers?.length) { iceServers = w.iceServers; lastIceAt = performance.now(); }
    ensureMic();
    if (resumed && mesh) {
      for (const p of mesh.peers.values()) {
        const s = p.pc.connectionState;
        if (s === 'failed' || s === 'disconnected') p.restartIce();
      }
    }
    if (mic && !mic.hasMic() && !mic.starting) void startMic();
  });

  // ---------------- keyboard (Q = walkie, V = push-to-talk) ----------------
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  addEventListener('keydown', (e) => {
    if (e.repeat || typing(e)) return;
    if (e.code === 'KeyQ') { radioHeld = true; mic?.refreshGate(); }
    if (e.code === 'KeyV') mic?.setPttHeld(true);
  });
  addEventListener('keyup', (e) => {
    if (e.code === 'KeyQ') { radioHeld = false; mic?.refreshGate(); }
    if (e.code === 'KeyV') mic?.setPttHeld(false);
  });
  addEventListener('blur', () => { radioHeld = false; mic?.setPttHeld(false); mic?.refreshGate(); });
  // the players track's action map (keyboard, test setInput({radio}), future rebinding) emits these on the bus
  const onLoose = ctx.bus.on as unknown as (k: string, fn: (d: { down?: boolean }) => void) => () => void;
  onLoose('action:radio', (d) => { radioHeld = !!d?.down; mic?.refreshGate(); });
  onLoose('action:ptt', (d) => { mic?.setPttHeld(!!d?.down); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      for (const v of voices.values()) v.resume();
      if (ctx.audio.ctx && ctx.audio.ctx.state !== 'running') void ctx.audio.ctx.resume();
    }
  });

  // ---------------- 30 Hz audio update (timer, keeps running in background tabs playing audio) ----------------
  const playerPublic = (id: string) => ctx.world.crew?.players.find((p) => p.id === id);
  const speakerPos = (id: string): V3 | null => {
    const pl = useLoose<PlayersLike>(ctx, 'players');
    const h = pl?.headPos?.(id);
    if (h) return h;
    const s = ctx.world.samplePlayer(id);
    return s ? [s.p[0], s.p[1] + 1.55, s.p[2]] : null;
  };

  let lastPeerSync = 0;
  const tick = () => {
    setTimeout(tick, 33);
    const ac = ctx.audio.ctx;
    if (!ac || !graph) return;
    const now = performance.now();
    if (now - lastPeerSync > 250) {
      lastPeerSync = now;
      const ids = wantedPeers();
      if (ids.length || mesh) ensureMesh().sync(ids);
      if (mesh) for (const p of mesh.peers.values()) p.watchdog(now);
      if (mesh && now - lastIceAt > 15_000 && [...mesh.peers.values()].some((p) => p.pc.connectionState === 'failed')) {
        lastIceAt = now; // throttle: at most one forced refresh per 15 s
        void refreshIce(true);
      }
      if (mode === 'game') void refreshIce(false);
    }
    const lp = mode === 'game' ? listenerPose(ctx) : null;
    if (lp) applyListener(ac, lp);
    const me = ctx.net.me;
    const meAlive = me ? playerPublic(me)?.alive !== false : true;
    const { grid, doorOpen } = lp ? levelGrid(ctx) : { grid: null, doorOpen: null };
    const canRadio = walkie(me);
    for (const [id, v] of voices) {
      const peer = mesh?.peers.get(id);
      const st = peer?.state;
      const pub = playerPublic(id);
      const sp = speakerPos(id);
      let route: GateInput['route'] = 'spatial';
      if (mode === 'voicetest' || pub?.name === 'voicetest' || pub?.profile?.name === 'voicetest') route = 'monitor';
      else if (pub && pub.alive === false) route = meAlive ? 'mute' : 'dead2d';
      // path distance from the server snapshot (① Net), Euclidean fallback until it lands
      let dist = euclidOnly ? undefined : ctx.world.aud[id];
      if (dist === undefined) {
        // fallback distance from the SERVER positions (the rendered avatar can lag a teleport by seconds)
        const ss = ctx.world.samplePlayer(id)?.p;
        const me = ctx.world.me ? ctx.world.samplePlayer(ctx.world.me)?.p : undefined;
        const lpos = ctx.params.get('voiceListener') === 'server' || !lp ? me : lp.pos;
        if (ss && lpos) dist = Math.hypot(ss[0] - lpos[0], ss[2] - lpos[2]);
        else if (lp && sp) dist = Math.hypot(sp[0] - lp.pos[0], sp[2] - lp.pos[2]);
        else dist = 0;
      }
      let lowpass = lowpassHz[0] ?? 20000, occGain = 1;
      if (grid && lp && sp && route === 'spatial') {
        const walls = wallCrossings(grid, lp.pos[0], lp.pos[2], sp[0], sp[2], doorOpen, closedDoorFrac);
        const o = occlusionParams(walls, lowpassHz, perWallDb);
        lowpass = o.freq;
        occGain = o.gain;
      }
      let lateral: number | null = null;
      if (lp && sp && route === 'spatial') {
        // right = forward x up (Web Audio / three convention)
        const f = lp.fwd, u = lp.up;
        const rx = f[1] * u[2] - f[2] * u[1], ry = f[2] * u[0] - f[0] * u[2], rz = f[0] * u[1] - f[1] * u[0];
        const dx = sp[0] - lp.pos[0], dy = sp[1] - lp.pos[1], dz = sp[2] - lp.pos[2];
        const len = Math.hypot(dx, dy, dz), rl = Math.hypot(rx, ry, rz);
        if (len > 0.05 && rl > 1e-6) lateral = (dx * rx + dy * ry + dz * rz) / (len * rl);
      }
      v.update({
        lateral,
        band: st && st.at > 0 && now - st.at < 3000 ? st.band : st?.at ? 0 : null,
        radio: st?.radio ?? 0,
        baseDb: st?.baseDb ?? null,
        dist,
        speakerPos: sp,
        lowpass,
        occGain,
        route,
        canRadio,
        volume: volumes.get(id) ?? 1,
      }, now);
    }
    ctx.diag.voice = {
      peers: mesh ? mesh.peers.size : 0,
      voices: voices.size,
      band: mic?.currentBand() ?? 0,
      mic: mic?.hasMic() ?? false,
      listener: lp?.src ?? 'none',
    };
  };
  setTimeout(tick, 33);

  // ---------------- debug + service ----------------
  const peerDebug = (): Record<string, VoicePeerDebug> => {
    const out: Record<string, VoicePeerDebug> = {};
    for (const [id, p] of mesh?.peers ?? []) {
      const v = voices.get(id);
      const o = v?.outRms() ?? { l: 0, r: 0 };
      out[id] = {
        state: p.pc.connectionState,
        candidate: p.candidate,
        bytesReceived: p.bytesReceived,
        rmsL: o.l,
        rmsR: o.r,
        gain: v?.gateValue ?? 0,
        band: p.state.band ?? -1,
      };
    }
    return out;
  };

  const debug: VoiceDebugApi & Record<string, unknown> = {
    peers: peerDebug,
    band: () => mic?.currentBand() ?? 0,
    micSettings: () => mic?.settings() ?? null,
    logs: () => logs.slice(),
    inRms: () => Object.fromEntries([...voices].map(([id, v]) => [id, v.inRms])),
    fallback: () => Object.fromEntries([...voices].map(([id, v]) => [id, v.fallback])),
    level: () => (mic ? { db: mic.levelDb, base: mic.baseDb, gate: mic.gateDb(), band: mic.currentBand() } : null),
    keepAlive: () => keepAlive,
    iceServers: () => iceServers.map((s) => ({ urls: s.urls, hasCredential: !!s.credential })),
    relayOnly: () => relayOnly,
    aud: () => ({ ...ctx.world.aud }),
    positions: () => {
      const lp = listenerPose(ctx);
      return { listener: lp, voices: Object.fromEntries([...voices.keys()].map((id) => [id, { used: speakerPos(id), server: ctx.world.players.get(id)?.latest()?.p ?? null, aud: ctx.world.aud[id] ?? null }])) };
    },
    mesh: () => Object.fromEntries([...(mesh?.peers ?? [])].map(([id, p]) => [id, { sig: p.pc.signalingState, ice: p.pc.iceConnectionState, gather: p.pc.iceGatheringState, sent: p.sent, cands: p.cands, dropped: p.dropped, sid: p.sid, remoteSid: p.remoteSid }])),
  };

  const svc = {
    band: () => mic?.currentBand() ?? 0,
    debug,
    calibrate: async (o?: CalOpts) => {
      if (!(await startMic()) || !mic || !graph) return { ok: false, reason: mic?.error ?? 'no microphone' } as CalibrationResult;
      const r = await runCalibration(mic, graph, o);
      if (r.echo) applyEcho(r.echo);
      return r;
    },
    echoCheck: async () => {
      if (!(await startMic()) || !mic || !graph) return null;
      const r = await echoCheck(mic, graph);
      applyEcho(r);
      return r;
    },
    setPushToTalk: (on: boolean) => { lsSet(LS_PTT, on ? '1' : '0'); ensureMic()?.setPtt(on || speakersPtt); },
    pushToTalk: () => mic?.ptt ?? false,
    speakersPtt: () => speakersPtt,
    peers: () => {
      const out: Record<string, { state: string; candidate: string; name: string; band: number; gain: number }> = {};
      for (const [id, p] of mesh?.peers ?? []) {
        out[id] = { state: p.pc.connectionState, candidate: p.candidate, name: playerPublic(id)?.name ?? id, band: p.state.band ?? -1, gain: voices.get(id)?.gateValue ?? 0 };
      }
      return out;
    },
    hasMic: () => mic?.hasMic() ?? false,
    micError: () => mic?.error ?? null,
    devices: async () => (ensureMic() ? mic!.devices() : []),
    setDevice: async (deviceId: string) => {
      const m = ensureMic();
      if (!m) { lsSet('deadair.voice.device', deviceId); return false; }
      const ok = await m.start(deviceId);
      if (ok) log(`mic switched: ${JSON.stringify(m.settings())}`);
      return ok;
    },
    deviceId: () => mic?.deviceId() ?? lsGet('deadair.voice.device') ?? '',
    setMicGain: (g: number) => ensureMic()?.setGain(g),
    micGain: () => mic?.gain() ?? 1,
    level: () => (mic ? { db: mic.levelDb, base: mic.baseDb, gate: mic.gateDb(), band: mic.currentBand() } : { db: -120, base: -30, gate: -60, band: 0 }),
    radio: radioNow,
    transmitting: () => mic?.transmitting() ?? false,
    setTranscribe: (on: boolean) => {
      transcribe = on;
      lsSet(LS_TX, on ? '1' : '0');
      if (ctx.net.status === 'joined') void ctx.net.req('voice.consent', { transcribe: on }).catch(() => {});
    },
    transcribe: () => transcribe,
    setRelayOnly: (on: boolean) => {
      relayOnly = on;
      lsSet(LS_RELAY, on ? '1' : '0');
      mesh?.closeAll(); // rebuilt on the next sync with the new policy
    },
    relayOnly: () => relayOnly,
    setPeerVolume: (id: string, v: number) => { volumes.set(id, Math.max(0, Math.min(2, v))); },
    setMuted: (on: boolean) => ensureMic()?.setMuted(on),
    startMic,
  };

  function applyEcho(r: EchoResult): void {
    log(`echo check: residual ${r.residualDb} dB, pickup ${r.pickupDb} dB -> ${r.echo ? 'ECHO (speakers): push-to-talk forced' : 'ok'}`);
    speakersPtt = r.echo;
    lsSet(LS_SPK, r.echo ? '1' : '0');
    mic?.setPtt(r.echo || lsGet(LS_PTT) === '1');
    if (r.echo) ctx.ui.toast('Speakers detected: push-to-talk is ON (hold V). Use a headset for open mic.', 'warn', 6000);
  }

  // sync consent to the server once joined (server default is false)
  ctx.bus.on('net:welcome', () => { void ctx.net.req('voice.consent', { transcribe }).catch(() => {}); });

  ctx.services.provide('voice', svc);
  debug.calibrate = (o?: CalOpts) => svc.calibrate(o);
  debug.echoCheck = () => svc.echoCheck();
  debug.service = () => svc;
  if (ctx.testMode || ctx.build === 'dev') window.__voiceDebug = debug;

  if (mode === 'game') {
    ctx.ui.registerHud('bottom-left', BandMeter, { order: 10, id: 'voice-band' });
    ctx.ui.registerHud('join', MicJoinSection, { order: 10, id: 'voice-join' });
    ctx.ui.registerScreen('voice-calibration', CalibrationScreen);
    debug.showCalibration = () => ctx.ui.setScreen('voice-calibration');
  }
}
