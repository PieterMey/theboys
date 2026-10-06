// Snapshot building: one base per crew (players from poses + crewSnapshot hooks), then a per-receiver copy
// that hooks.snapshot may mutate (aud distances, filtering).
import type { Snapshot, SnapPlayer } from '@dead-air/shared/state.ts';
import type { Crew, ServerContext, ServerPlayer } from './types.ts';
import { runHooks } from './hooks.ts';

export function buildCrewSnapshot(ctx: ServerContext, crew: Crew): Snapshot {
  const players: SnapPlayer[] = [];
  for (const pl of crew.players.values()) {
    if (!pl.connected) continue;
    if ((pl.slices as { observer?: unknown }).observer === true) continue; // /voicetest observer: no avatar
    const s = pl.pose;
    players.push({ id: pl.id, p: s.p, yaw: s.yaw, pitch: s.pitch, stance: s.stance, anim: s.anim, light: s.light });
  }
  const snap: Snapshot = { t: ctx.now(), tick: crew.tick, players, monsters: [], dyn: [], aud: {} };
  runHooks(ctx, 'crewSnapshot', ctx.hooks.crewSnapshot, crew, snap);
  return snap;
}

export function snapshotFor(ctx: ServerContext, crew: Crew, base: Snapshot, receiver: ServerPlayer): Snapshot {
  const s: Snapshot = {
    t: base.t,
    tick: base.tick,
    players: base.players.slice(),
    monsters: base.monsters.slice(),
    dyn: base.dyn.slice(),
    aud: { ...base.aud },
  };
  runHooks(ctx, 'snapshot', ctx.hooks.snapshot, crew, receiver, s);
  return s;
}
