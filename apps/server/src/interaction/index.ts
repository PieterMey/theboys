// Owner: track (b) Interaction (apps/server/src/interaction/**). Server plugin entry; see apps/server/src/core/types.ts.
// Interactable registry + doors + items/inventory + hiding + light switches + death/revive. Cross-track API: ./api.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { ContainerInfo } from '@dead-air/shared/procgen/containers.ts';
import type { Phase, Vec3 } from '@dead-air/shared/state.ts';
import * as E from './engine.ts';

/** guarded dynamic import of another track's module (absent / WIP -> null) */
async function tryImport(spec: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(spec)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** re-check adapters that may land later in the night (only matters across restarts, but cheap) */
async function loadAdapters(ctx: ServerContext): Promise<void> {
  const log = ctx.log(E.TRACK);
  const noise = await tryImport('../players/noise.ts');
  E.adapters.noise = noise && typeof noise.emitNoise === 'function' ? (noise as never) : null;
  const obj = await tryImport('../objectives/api.ts');
  E.adapters.obj = obj && typeof obj.state === 'function' ? (obj as never) : null;
  const meta = await tryImport('../meta/api.ts');
  E.adapters.meta = meta && Object.keys(meta).length ? meta : null;
  log.info(`adapters: noise=${E.adapters.noise ? 'players/noise.ts' : 'absent'} power=${E.adapters.obj ? 'objectives/api.ts' : 'default'} meta=${E.adapters.meta ? 'yes' : 'absent (walkie fallback on)'}`);
}

const PHASES: readonly Phase[] = ['hub', 'drive', 'contract', 'results'];

export async function install(ctx: ServerContext): Promise<void> {
  E.bindCtx(ctx);
  await loadAdapters(ctx);
  // v1.3 F3: the noise lure / field receiver ITEM_DEFS follow their flags (missing = off), on every reload too
  E.syncFlaggedDefs();
  ctx.hooks.config.push(function interactionFlags() { E.syncFlaggedDefs(); });

  ctx.registerSystem({
    name: 'interaction',
    order: SYSTEM_ORDER.interaction,
    tick(dt, crew) {
      E.tick(crew, dt);
    },
  });

  // ---------------- requests
  const done = <T>(crew: Crew, r: T): T => {
    E.flush(crew);
    return r;
  };
  ctx.registerReq('interaction.use', (crew, player, a) => done(crew, E.use(crew, player, String(a?.id ?? ''), !!a?.hold)));
  // v1.3: fuse (noise lure) and door (field receiver at a door) ride along untyped (TODO(integrator): messages/interaction.ts)
  ctx.registerReq('interaction.act', (crew, player, a) => {
    const x = (a ?? {}) as { fuse?: unknown; door?: unknown };
    return done(crew, E.act(crew, player, a?.dir as Vec3, a?.eye as Vec3 | undefined, { fuse: x.fuse, door: x.door }));
  });
  ctx.registerReq('interaction.drop', (crew, player, a) => done(crew, E.dropActive(crew, player, typeof a?.slot === 'number' ? a.slot : undefined)));
  ctx.registerReq('interaction.slot', (crew, player, a) => done(crew, E.selectSlot(crew, player, Number(a?.slot))));
  ctx.registerReq('interaction.consoleDoor', (crew, player, a) => done(crew, E.consoleDoor(crew, player, Number(a?.id), typeof a?.open === 'boolean' ? a.open : undefined)));
  // v1.2: server-timed hold-E (quiet doors / drawers, lockpicks, security-door holds) and night vision
  ctx.registerReq('interaction.ease', (crew, player, a) => done(crew, E.easeReq(crew, player, String(a?.id ?? ''), a?.on === true)));
  ctx.registerReq('interaction.nv', (crew, player, a) => done(crew, E.setNightVision(crew, player, a?.on === true)));

  // ---------------- hooks
  ctx.hooks.join.push(function interactionJoin(crew, player) {
    E.onJoin(crew, player);
    E.flush(crew);
  });
  ctx.hooks.leave.push(function interactionLeave(crew, player, info) {
    if (info.final) E.onLeaveFinal(crew, player);
  });
  ctx.hooks.phase.push(function interactionPhase(crew, from, to) {
    E.onPhase(crew, from, to);
  });
  ctx.hooks.pose.push(function interactionPose(crew, player, pose) {
    E.onPose(crew, player, pose);
  });
  ctx.hooks.crewSnapshot.push(function interactionSnap(crew, snap) {
    for (const d of E.thrownDyn(crew)) snap.dyn.push(d);
  });
  ctx.hooks.fullState.push(function interactionFull(crew, _player, state) {
    state.interaction = E.publicState(E.slice(crew));
  });

  // ---------------- dev-only debug requests (dbg.interaction.*)
  const target = (crew: Crew, me: ServerPlayer, pid: unknown): ServerPlayer => {
    const p = typeof pid === 'string' ? crew.players.get(pid) : undefined;
    return p ?? me;
  };
  ctx.registerDbg('interaction.loadLayout', async (crew, _p, args) => {
    const a = (args ?? {}) as { name?: string; dir?: string; phase?: Phase; seed?: string; players?: number; risk?: number };
    let layout: LevelLayout | null = null;
    if (a.seed !== undefined) {
      const lvl = await tryImport('../level/index.ts');
      const gen = lvl?.generateFacility as ((o: { seed: string; players: number; risk: number }) => LevelLayout) | undefined;
      if (typeof gen === 'function') layout = gen({ seed: String(a.seed), players: a.players ?? Math.max(2, crew.players.size), risk: a.risk ?? 1 });
    }
    if (!layout) {
      const name = String(a.name ?? 'facility_s1_p2').replace(/[^a-z0-9_]/gi, '');
      // 'layouts' (default) or a frozen reference set such as 'identity-v11'
      const dir = String(a.dir ?? 'layouts').replace(/[^a-z0-9_-]/gi, '');
      const file = join(ctx.env.ROOT, 'tests/fixtures', dir, `${name}.json`);
      if (!existsSync(file)) throw new Error(`no fixture ${name}`);
      layout = JSON.parse(readFileSync(file, 'utf8')) as LevelLayout;
    }
    const phase = a.phase && PHASES.includes(a.phase) ? a.phase : layout.kind === 'hub' ? 'hub' : 'contract';
    ctx.setPhase(crew, phase, layout);
    return { phase, seed: layout.seed, hash: layout.hash, kind: layout.kind };
  });
  ctx.registerDbg('interaction.state', (crew) => {
    const s = E.slice(crew);
    return { ...E.publicState(s), thrown: s.thrown, deaths: s.deaths, powerPush: s.powerPush, blackoutPush: s.blackoutPush, switches: s.switches, adapters: { noise: !!E.adapters.noise, obj: !!E.adapters.obj, meta: !!E.adapters.meta }, ...E.f3Peek(crew) };
  });
  ctx.registerDbg('interaction.give', (crew, p, args) => {
    const a = (args ?? {}) as { type?: string; pid?: string; count?: number; value?: number; name?: string; lock?: number; via?: string };
    const via = (['handout', 'buy', 'craft', 'safe', 'container', 'api'] as const).find((v) => v === a.via);
    const it = E.giveItemTo(crew, target(crew, p, a.pid).id, String(a.type ?? 'bottle'), {
      ...(a.count !== undefined ? { count: a.count } : {}), ...(a.value !== undefined ? { value: a.value } : {}),
      ...(a.name ? { name: a.name } : {}), ...(a.lock !== undefined ? { lock: a.lock } : {}), ...(via ? { via } : {}),
    });
    E.flush(crew);
    return it;
  });
  ctx.registerDbg('interaction.spawn', (crew, _p, args) => {
    const a = (args ?? {}) as { type?: string; x?: number; z?: number; y?: number; count?: number; value?: number; name?: string; mats?: Record<string, number> };
    const it = E.spawnWorldItem(crew, String(a.type ?? 'bottle'), [Number(a.x ?? 0), Number(a.y ?? 0), Number(a.z ?? 0)], {
      ...(a.count !== undefined ? { count: a.count } : {}), ...(a.value !== undefined ? { value: a.value } : {}),
      ...(a.name ? { name: String(a.name) } : {}), ...(a.mats && typeof a.mats === 'object' ? { mats: { ...a.mats } } : {}),
    });
    E.flush(crew);
    return it;
  });
  ctx.registerDbg('interaction.kill', (crew, p, args) => {
    const a = (args ?? {}) as { pid?: string; killer?: string; reason?: string; detail?: string };
    return { ok: E.killPid(crew, target(crew, p, a.pid).id, { killer: a.killer ?? 'HOUND', reason: a.reason ?? 'heard your SPRINT (9 m)', detail: a.detail }) };
  });
  ctx.registerDbg('interaction.revive', (crew, p, args) => {
    const a = (args ?? {}) as { pid?: string };
    return { ok: E.reviveSelf(crew, target(crew, p, a.pid).id, null, { how: 'api' }) };
  });
  ctx.registerDbg('interaction.pose', (crew, p, args) => {
    // place a player's server-side pose (bots/tests without a controller)
    const a = (args ?? {}) as { pid?: string; x?: number; z?: number; yaw?: number; light?: 0 | 1 };
    const pl = target(crew, p, a.pid);
    pl.pose = { ...pl.pose, p: [Number(a.x ?? pl.pose.p[0]), 0, Number(a.z ?? pl.pose.p[2])], yaw: Number(a.yaw ?? pl.pose.yaw), light: a.light ?? pl.pose.light };
    pl.poseAt = performance.now();
    return { p: pl.pose.p };
  });
  ctx.registerDbg('interaction.tune', (_crew, _p, args) => {
    const b = (ctx.balance.interaction ??= {}) as Record<string, unknown>;
    Object.assign(b, (args ?? {}) as Record<string, unknown>);
    return b;
  });
  ctx.registerDbg('interaction.power', (crew, _p, args) => {
    const a = (args ?? {}) as { zone?: number; on?: boolean; blackout?: boolean };
    if (typeof a.blackout === 'boolean') E.setBlackoutPush(crew, a.blackout);
    if (typeof a.zone === 'number') E.setPowerPush(crew, a.zone, a.on !== false);
    E.flush(crew);
    return { lights: E.slice(crew).lights };
  });
  ctx.registerDbg('interaction.setLights', (crew, _p, args) => {
    const a = (args ?? {}) as { space?: number | 'all'; on?: boolean };
    E.setSwitch(crew, a.space === undefined ? 'all' : a.space, a.on !== false);
    E.flush(crew);
    return { lights: E.slice(crew).lights };
  });
  ctx.registerDbg('interaction.litAt', (crew, _p, args) => {
    const a = (args ?? {}) as { x?: number; z?: number };
    return { lit: E.litAtXZ(crew, Number(a.x ?? 0), Number(a.z ?? 0)) };
  });
  // v1.2 (dev only): a containersOf test double until E1's lands (list = ContainerInfo[]; [] / null = back to containersOf),
  // the private drawer contents, the van stash and the van materials (take: true empties them like takeVanMaterials)
  ctx.registerDbg('interaction.containers', (crew, _p, args) => {
    const a = (args ?? {}) as { list?: ContainerInfo[] | null };
    const n = E.overrideContainers(crew, Array.isArray(a.list) ? a.list : null);
    E.flush(crew);
    return { n };
  });
  ctx.registerDbg('interaction.stock', (crew, _p, args) => {
    const a = (args ?? {}) as { id?: string; type?: string; name?: string; value?: number };
    return { ok: E.stockContainerItem(crew, String(a.id ?? ''), { type: String(a.type ?? 'page'), ...(a.name ? { name: String(a.name) } : {}), ...(a.value !== undefined ? { value: Number(a.value) } : {}) }) };
  });
  ctx.registerDbg('interaction.peek', (crew) => {
    const s = E.slice(crew);
    return { contents: E.containerPeek(crew), vanMats: { ...s.vanMats }, easing: s.easing, pending: s.pendingSpawns.length };
  });
  ctx.registerDbg('interaction.vanMaterials', (crew, _p, args) => {
    const take = (args as { take?: boolean } | null)?.take === true;
    const r = E.vanMaterialsOf(crew, take);
    E.flush(crew);
    return r;
  });
  ctx.registerDbg('interaction.consoleAnywhere', (_crew, p, args) => {
    const sl = ((p.slices[E.TRACK] ??= {}) as { consoleAnywhere?: boolean });
    sl.consoleAnywhere = (args as { on?: boolean } | null)?.on !== false;
    return { on: sl.consoleAnywhere };
  });
}
