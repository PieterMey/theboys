// Owner: track (e) speech. STT bridge install (called from apps/server/src/ai/index.ts: stt is not a separate
// entry in the server's TRACKS list). See ./bridge.ts for the pipeline.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { PlayerPose, ServerContext } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import { crewAi, dropPlayer, handleChunk, noteSnapshot, onProxText, recentUtterances, setFakeListener, startHealthPoll, sttStats, tick } from './bridge.ts';
import { noiseApi, onDepLoaded } from '../ai/adapters.ts';
import { forgetCrewQuotes } from '../ai/hub.ts';

export function install(ctx: ServerContext): void {
  const log = ctx.log('stt');
  ctx.onVoiceChunk((crew, player, h, pcm) => handleChunk(ctx, crew, player, h, pcm));
  ctx.registerSystem({ name: 'ai.stt', order: SYSTEM_ORDER.ai, tick: (_dt, crew) => tick(ctx, crew) });
  ctx.hooks.crewSnapshot.push((crew, snap) => noteSnapshot(crew, snap));
  ctx.hooks.leave.push((crew, player, info) => {
    if (info.final) dropPlayer(crew, player.id);
    if (info.final && crew.players.size === 0) forgetCrewQuotes(crew.code);
  });
  sttStats(ctx, () => ctx.crews.list());

  // typed proximity text: quote candidates for the HR memo (the monsters track feeds it to the Listener itself)
  let proxWired = false;
  const wireProx = () => {
    const api = noiseApi();
    if (proxWired || !api?.onProxText) return;
    api.onProxText((crew, e) => onProxText(ctx, crew, e));
    proxWired = true;
    log.info('proximity text wired (HR-memo quotes only; the monsters track hears it directly)');
  };
  onDepLoaded((name) => { if (name === 'noise') wireProx(); });
  wireProx();

  if (process.argv.includes('--selftest') || ctx.env.mode === 'test') {
    // no sidecar polling in selftests / unit boots
  } else {
    startHealthPoll(ctx);
  }

  // ---- dev-only test helpers (dbg.ai.*) ----
  ctx.registerDbg('ai.fakeListener', (crew, _p, args) => {
    const a = (args ?? {}) as { x?: number; z?: number; off?: boolean };
    if (a.off) {
      setFakeListener(crew, null);
      return { fake: null };
    }
    const pos = { x: Number(a.x ?? 0), z: Number(a.z ?? 0) };
    setFakeListener(crew, pos);
    return { fake: pos };
  });
  ctx.registerDbg('ai.place', (crew, player, args) => {
    const a = (args ?? {}) as { id?: string; x?: number; z?: number; yaw?: number };
    const target = a.id ? crew.players.get(a.id) : player;
    if (!target) throw new Error('no such player');
    const pose: PlayerPose = { ...target.pose, p: [Number(a.x ?? 0), 0, Number(a.z ?? 0)], yaw: Number(a.yaw ?? target.pose.yaw) };
    target.pose = pose;
    target.poseAt = performance.now();
    return { id: target.id, p: pose.p };
  });
  ctx.registerDbg('ai.layout', (crew, _p, args) => {
    // test-only: load a fixture layout. phase 'contract' -> ctx.setPhase (meta adopts it); else swap crew.layout in
    // place WITHOUT a phase change (meta puts the hub layout back while in the hub phase)
    const a = (args ?? {}) as { fixture?: string; phase?: 'contract' };
    const name = String(a.fixture ?? 'facility_s1_p2').replace(/[^a-z0-9_]/gi, '');
    const L = JSON.parse(readFileSync(join(ctx.env.ROOT, 'tests/fixtures/layouts', `${name}.json`), 'utf8')) as LevelLayout;
    if (a.phase === 'contract') ctx.setPhase(crew, 'contract', L);
    else crew.layout = L;
    return { seed: L.seed, W: L.W, H: L.H, spaces: L.spaces.length, phase: crew.phase };
  });
  ctx.registerDbg('ai.utterances', (crew) => ({ utterances: recentUtterances(crew) }));
  ctx.registerDbg('ai.sttState', (crew) => {
    const st = crewAi(crew);
    return {
      fakeListener: st.fakeListener,
      listener: st.listener,
      players: [...st.players.entries()].map(([id, ps]) => ({ id, open: ps.open ? { segId: ps.open.segId, samples: ps.open.samples, hearers: [...ps.open.players], listener: ps.open.listener } : null, queued: ps.queue.length, busy: ps.busy })),
    };
  });
}
