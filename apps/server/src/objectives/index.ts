// Owner: track (a) Objectives (apps/server/src/objectives/**). Server plugin entry; see apps/server/src/core/types.ts.
// Levers -> power -> keypad -> vault -> Core, salvage + extraction, the contract clock, Company Requests, notes.
// Public API for other tracks: ./api.ts. Requests: 'objectives.*' (packages/shared/src/messages/objectives.ts).
// Dev-only: dbg.objectives.start | clock | doors | state | end | teleportCheck
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as C from './contract.ts';
import * as deps from './deps.ts';

// NOT 'loot' / 'deposit': (b) rolls + owns the salvage items (inventory, drop, deposit) unless someone handles 'loot'.
// Objectives mirrors (b)'s loot for the HUD / haul and only falls back to its own registry without (b).
const KINDS = ['lever', 'keypad', 'core', 'leave_lever', 'note'] as const;

export function install(ctx: ServerContext): void {
  const log = ctx.log('objectives');
  C.bindContext(ctx);
  deps.initDeps(ctx);

  // cross-track subscriptions as soon as each owner's API module is available
  deps.whenLoaded((name) => {
    if (name === 'interaction') {
      const b = deps.interaction();
      try {
        b?.onDeath?.((crew: Crew, pid: string, cause?: unknown) => C.onPlayerDeath(crew, pid, cause));
        b?.onDeposit?.((crew: Crew, pid: string, items: deps.IxItem[]) => C.onIxDeposit(crew, pid, items));
      } catch (e) { log.warn('interaction.onDeath/onDeposit failed', e instanceof Error ? e.message : e); }
      for (const kind of KINDS) {
        try {
          b?.onInteract?.(kind, (crew: Crew, player: ServerPlayer, targetId: string) => {
            const res = C.interact(crew, player, targetId);
            return { ok: res.ok, ...(res.msg ? { msg: res.msg } : {}) };
          });
        } catch (e) { log.warn(`interaction.onInteract(${kind}) failed`, e instanceof Error ? e.message : e); }
      }
    } else if (name === 'monsters') {
      try {
        deps.monsters()?.listener?.onDecision?.((...a: unknown[]) => C.onListenerDecision(a));
      } catch (e) { log.warn('monsters.listener.onDecision failed', e instanceof Error ? e.message : e); }
    }
  });
  // dependencies install after us: load them once everything installed, then retry missing ones periodically
  setTimeout(() => void deps.loadDeps(), 0);
  let depAcc = 0;

  ctx.registerSystem({
    name: 'objectives',
    order: SYSTEM_ORDER.objectives,
    tick(dt, crew) {
      C.tick(dt, crew);
    },
  });
  // retry missing deps every ~10 s (cheap; one crew-independent system)
  ctx.registerSystem({
    name: 'objectives.deps',
    order: SYSTEM_ORDER.objectives + 1,
    tick(dt, crew) {
      if (crew !== ctx.crews.list()[0]) return;
      depAcc += dt;
      if (depAcc < 10) return;
      depAcc = 0;
      const s = deps.depStatus();
      if (!s.interaction || !s.monsters || !s.noise || !s.meta) void deps.loadDeps();
    },
  });

  ctx.hooks.phase.push((crew, from, to) => C.onPhase(crew, from, to));
  ctx.hooks.fullState.push((crew, _player, state) => {
    state.objectives = C.publicState(crew);
    const r = C.rt(crew);
    state.clockMin = r && r.st.active && crew.phase === 'contract' ? Math.round(C.clockMinOf(r)) : -1;
  });
  ctx.hooks.crewSnapshot.push((crew, snap) => C.fillSnapshot(crew, snap));

  // ---------------- requests ----------------
  ctx.registerReq('objectives.interact', (crew, player, a) => C.interact(crew, player, String(a?.id ?? '')));
  ctx.registerReq('objectives.lever', (crew, player, a) => C.pullLever(crew, player, String(a?.id ?? '')));
  ctx.registerReq('objectives.keypad', (crew, player, a) => C.enterCode(crew, player, String(a?.code ?? '')));
  ctx.registerReq('objectives.key', (crew, player, a) => {
    const r = C.rt(crew);
    const k = r?.st.keypad;
    if (!r || !k || !r.st.active) return { ok: false };
    const key = String(a?.key ?? '').slice(0, 1);
    ctx.emit(crew, 'objectives.keypad', { id: k.id, by: player.id, ok: true, reason: `key:${key}`, p: k.p }, { except: [player.id] });
    return { ok: true };
  });
  ctx.registerReq('objectives.core', (crew, player, a) => C.coreAction(crew, player, a?.action === 'release' ? 'release' : 'grab'));
  ctx.registerReq('objectives.pick', (crew, player, a) => C.pickLoot(crew, player, String(a?.id ?? '')));
  ctx.registerReq('objectives.drop', (crew, player, a) => C.dropLoot(crew, player, a?.id ? String(a.id) : undefined));
  ctx.registerReq('objectives.deposit', (crew, player) => C.depositAll(crew, player));
  ctx.registerReq('objectives.leave', (crew, player) => C.pullLeave(crew, player));
  ctx.registerReq('objectives.state', (crew) => C.publicState(crew));

  // ---------------- dev-only ----------------
  ctx.registerDbg('objectives.start', async (crew, _player, args) => {
    const a = (args ?? {}) as { seed?: string; players?: number; risk?: number; realSec?: number; fixture?: string; monsters?: boolean; order?: C.OrderLike; openDoors?: boolean };
    let layout: LevelLayout;
    if (a.fixture) {
      const p = join(ctx.env.ROOT, 'tests/fixtures/layouts', a.fixture.endsWith('.json') ? a.fixture : `${a.fixture}.json`);
      if (!existsSync(p)) throw new Error(`no fixture ${a.fixture}`);
      layout = JSON.parse(readFileSync(p, 'utf8')) as LevelLayout;
    } else {
      const players = a.players ?? Math.max(1, ctx.crews.connected(crew).length);
      layout = await deps.generateFacility({ seed: String(a.seed ?? `dbg-${crew.code}-${Date.now() % 100000}`), players, risk: a.risk ?? 1 });
    }
    for (const p of crew.players.values()) { p.alive = true; p.ready = false; }
    // meta (d) adopts a foreign 'contract' phase and calls startContract itself (setImmediate): let it, with our
    // overrides, so there is exactly one contract (and meta's results/saves see it)
    C.setNextStartOpts(crew, { realSec: a.realSec, ...(a.order ? { orderPatch: a.order } : {}) });
    const before = C.rt(crew);
    ctx.setPhase(crew, 'contract', layout);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
    let r = C.rt(crew);
    if (!r || r === before || r.layout !== layout) {
      C.startContract(crew, { id: `dbg-${layout.seed}`, risk: (a.risk ?? 1) as 1, siteName: 'Debug Site', ...(a.order ?? {}) }, { realSec: a.realSec });
      r = C.rt(crew);
    }
    // monsters: (c) restarts a stopped runtime by itself; clients/bots freeze it with dbg.monsters.freeze
    if (a.openDoors) openAllDoors(crew);
    const st = r!.st;
    return { seed: layout.seed, hash: layout.hash, lootTotal: st.lootTotal, loot: st.loot.length, realSec: st.realSec, deps: deps.depStatus() };
  });
  ctx.registerDbg('objectives.clock', (crew, _p, args) => {
    const a = (args ?? {}) as { min?: number; realSec?: number };
    const st = C.setClock(crew, a);
    return st ? { clockMin: C.clockMinOf(C.rt(crew)!), realSec: st.realSec } : null;
  });
  ctx.registerDbg('objectives.doors', (crew, _p, args) => {
    const a = (args ?? {}) as { open?: boolean };
    return { opened: openAllDoors(crew, a.open !== false) };
  });
  ctx.registerDbg('objectives.state', (crew) => ({ state: C.publicState(crew), deps: deps.depStatus(), result: C.rt(crew)?.result ?? null }));
  ctx.registerDbg('objectives.end', (crew, _p, args) => C.endContract(crew, ((args as { reason?: 'leave' | 'departure' | 'abort' } | null)?.reason) ?? 'leave'));
  ctx.registerDbg('objectives.deps', async () => {
    await deps.loadDeps();
    return deps.depStatus();
  });

  /** open every non-vault, non-rubble door (bots / screenshots; keycard puzzles are (b)'s) */
  function openAllDoors(crew: Crew, open = true): number {
    const L = crew.layout;
    if (!L) return 0;
    let n = 0;
    for (const d of L.doors) {
      if (d.kind === 'open' || d.kind === 'blocked' || d.kind === 'vault') continue;
      deps.setDoorOpen(crew, d.id, open, null);
      n++;
    }
    return n;
  }

  log.info('objectives installed');
}
