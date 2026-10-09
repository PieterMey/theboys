// Owner: env-paranormal (v1.2). System order 77 (after the director, 75). Server-authoritative paranormal activity:
// synced ('paranormal.event' with at = now + 350 and a seed), fair (blocks, gates, budgets, spacing), never spammy.
// Tell language: brownouts, dying tubes, frost, knocks, shadows, wet prints; never strobes, walkies, intercoms, vents,
// ceiling scratching or the scrape loop. Gated by flags.paranormal and balance.paranormal.enabled.
//   reqs: paranormal.sync (residue + active), paranormal.seen (rate-limited witness / end),
//         paranormal.poke (v1.3 dead pokes, flag deadPokes: pokes.ts)
//   dbg:  paranormal.fire {kind, target?, force?}, paranormal.state, paranormal.tune {...}, paranormal.reset
// v1.3 site rules (flag siteRules): siterules.ts, installed from here.
import type { ParanormalData, ParanormalKind, PokeKind, PokeRefusal } from '@dead-air/shared/messages/paranormal.ts';
import type { Crew, ServerContext } from '../core/types.ts';
import { listener, onMonsterEvent } from '../monsters/api.ts';
import { emitNoise } from '../players/noise.ts';
import { bindParanormalImpl, emitPhenomenon } from './api.ts';
import type { PhenomenonRecord } from './api.ts';
import { resolveBalance } from './balance.ts';
import { emitExtra, firePara, hauntDebug, leavePara, newCrewPara, resetPara, seenPara, syncPara, tickPara } from './plan.ts';
import { KIND_BY_NAME } from './kinds.ts';
import { newPokeState, pokeCooldowns, pokeOnce } from './pokes.ts';
import { installSiteRules } from './siterules.ts';
import type { PokeState } from './pokes.ts';
import type { CrewPara, ParaOut } from './types.ts';
import { makeLiveWorld } from './world.ts';
import type { LiveWorld } from './world.ts';

export const PARANORMAL_ORDER = 77;

interface Slot { st: CrewPara; w: LiveWorld }
/** per-crew inputs that may arrive before (or between) contracts */
interface Side {
  layout: unknown;
  stalk: { pid: string; at: number } | null;
  room: { callsign: string; space: number; at: number } | null;
  wokeAt: number;
  lore: string[];
  /** records of the current / last contract */
  records: PhenomenonRecord[];
}

const slots = new WeakMap<Crew, Slot>();
const sides = new WeakMap<Crew, Side>();

function side(crew: Crew): Side {
  let s = sides.get(crew);
  if (!s || s.layout !== crew.layout) {
    const records = s?.records ?? [];
    s = { layout: crew.layout, stalk: null, room: null, wokeAt: -Infinity, lore: [], records };
    sides.set(crew, s);
  }
  return s;
}

export function install(ctx: ServerContext): void {
  const log = ctx.log('paranormal');
  let b = resolveBalance(ctx.balance.paranormal);
  ctx.hooks.config.push(() => { b = resolveBalance(ctx.balance.paranormal); });
  const enabled = () => ctx.flags.paranormal !== false && b.enabled;

  const outFor = (crew: Crew): ParaOut => ({
    event: (ev) => ctx.emit(crew, 'paranormal.event', ev, ev.to ? { to: ev.to } : undefined),
    end: (id, reason, to) => ctx.emit(crew, 'paranormal.end', { id, reason }, to ? { to } : undefined),
    reveal: (id, at, to) => ctx.emit(crew, 'paranormal.reveal', { id, at }, to ? { to } : undefined),
    phenomenon: (rec) => {
      side(crew).records.push(rec);
      emitPhenomenon(crew, rec);
    },
  });

  const contractIndexOf = (crew: Crew): number => Number((crew.slices.meta as { shift?: { contract?: number } } | undefined)?.shift?.contract ?? 0) || 0;

  const drop = (crew: Crew, s: Slot) => {
    slots.delete(crew);
    try { resetPara(s.st, s.w, b, outFor(crew)); } catch (e) { log.warn('reset failed', e instanceof Error ? e.message : e); }
  };

  /** the crew's haunt state for the running contract (created on first use) */
  const slotFor = (crew: Crew, create: boolean): Slot | null => {
    const L = crew.layout;
    let s = slots.get(crew);
    if (crew.phase !== 'contract' || !L || L.kind !== 'facility') {
      if (s) drop(crew, s);
      return null;
    }
    if (s && s.st.layout !== L) { drop(crew, s); s = undefined; }
    if (!s && create) {
      const w = makeLiveWorld(ctx, crew, L);
      const st = newCrewPara(w, crew.code, contractIndexOf(crew), b);
      const sd = side(crew);
      sd.records = [];
      st.stalk = sd.stalk;
      st.room = sd.room;
      st.wokeAt = sd.wokeAt;
      st.loreTargets = sd.lore.slice();
      s = { st, w };
      slots.set(crew, s);
      log.debug(`crew ${crew.code}: haunt started (${L.seed}, contract ${contractIndexOf(crew)})`);
    }
    return s ?? null;
  };

  ctx.registerSystem({
    name: 'paranormal',
    order: PARANORMAL_ORDER,
    tick(_dt, crew) {
      if (!enabled()) {
        const s = slots.get(crew);
        if (s) drop(crew, s);
        return;
      }
      const s = slotFor(crew, true);
      if (!s) return;
      s.w.refresh();
      tickPara(s.st, s.w, b, outFor(crew));
    },
  });

  // reset on phase and layout change (end active effects as interrupted: their witnesses still count)
  ctx.hooks.phase.push((crew) => {
    const s = slots.get(crew);
    if (s && (crew.phase !== 'contract' || crew.layout !== s.st.layout)) drop(crew, s);
    side(crew);
  });

  // cleanup on leave
  ctx.hooks.leave.push((crew, player, info) => {
    if (!info.final) return;
    const s = slots.get(crew);
    if (!s) return;
    s.w.refresh();
    leavePara(s.st, s.w, b, outFor(crew), player.id);
  });

  // honest tells: the Listener's valid stalk target, its valid investigate/ambush room
  listener.onDecision((crew, d) => {
    if (!d.valid) return;
    const sd = side(crew);
    const st = slots.get(crew)?.st;
    if (d.action === 'stalk_player' && d.player) {
      sd.stalk = { pid: d.player, at: d.at };
      if (st) st.stalk = sd.stalk;
    }
    if ((d.action === 'investigate_room' || d.action === 'ambush_room') && d.room) {
      sd.room = { callsign: d.room, space: d.space, at: d.at };
      if (st) st.room = sd.room;
    }
  });
  onMonsterEvent((crew, e) => {
    if (e.event !== 'wake') return;
    const sd = side(crew);
    sd.wokeAt = Math.max(sd.wokeAt, e.at || ctx.now());
    const st = slots.get(crew)?.st;
    if (st) st.wokeAt = Math.max(st.wokeAt, sd.wokeAt);
  });

  // ---------------- requests ----------------
  ctx.registerReq('paranormal.sync', (crew, player) => {
    const s = enabled() ? slotFor(crew, false) : null;
    return { ...syncPara(s?.st ?? null, player.id), now: ctx.now() };
  });
  ctx.registerReq('paranormal.seen', (crew, player, a) => {
    const s = enabled() ? slotFor(crew, false) : null;
    const id = Number(a?.id);
    if (!s || !Number.isFinite(id)) return { ok: false };
    s.w.refresh();
    return { ok: seenPara(s.st, s.w, b, outFor(crew), player.id, id, a?.end === true) };
  });
  // v1.3 dead pokes (flag deadPokes; balance kinds.dead_poke false is a kill switch): a dead player knocks near their
  // camera or flickers the room they watch. Outside the haunt's budgets; the knock's noise reaches monsters.
  const pokeStates = new WeakMap<Crew, PokeState>();
  const pokeStateOf = (crew: Crew, s: Slot): PokeState => {
    let ps = pokeStates.get(crew);
    if (!ps || ps.key !== s.st.key) { ps = newPokeState(s.st.key); pokeStates.set(crew, ps); }
    return ps;
  };
  const pokesOn = () => ctx.flags.deadPokes === true && enabled() && b.kinds.dead_poke !== false;
  type PokeReply = { ok: boolean; cooldownMs?: number; reason?: PokeRefusal; id?: number; knockMs?: number; flickerMs?: number };
  ctx.registerReq('paranormal.poke', (crew, player, a): PokeReply => {
    const raw = (a ?? {}) as { kind?: unknown; count?: unknown };
    const kind: PokeKind | null = raw.kind === 'knock' ? 'knock' : raw.kind === 'flicker' || raw.kind === 'brownout' ? 'flicker' : null;
    if (!kind || !pokesOn()) return { ok: false, reason: 'off' };
    const s = slotFor(crew, true);
    if (!s) return { ok: false, reason: 'phase' };
    s.w.refresh();
    const ps = pokeStateOf(crew, s);
    const now = ctx.now();
    const r = pokeOnce(ps, s.w, b, player.id, kind, Number(raw.count ?? 1), now);
    if (!r.ok || !r.built) {
      const cd = pokeCooldowns(ps, b, player.id, now);
      return { ok: false, reason: r.reason, ...(r.cooldownMs !== undefined ? { cooldownMs: r.cooldownMs } : {}), knockMs: cd.knockMs, flickerMs: cd.flickerMs };
    }
    const ev = emitExtra(s.st, b, outFor(crew), r.built, now, r.seed ?? 1);
    // the dead make no noise for monsters as players (monsters drop a dead source): the knock is the building's
    if (r.noise) emitNoise(crew, { x: r.noise.x, z: r.noise.z, radiusM: r.noise.radiusM, kind: 'deadStatic', source: '' });
    const cd = pokeCooldowns(ps, b, player.id, now);
    log.debug(`crew ${crew.code}: dead poke ${kind}${kind === 'knock' ? ` x${String(ev.data?.count ?? 1)}` : ''} (space ${ev.space})`);
    return { ok: true, id: ev.id, ...(r.cooldownMs !== undefined ? { cooldownMs: r.cooldownMs } : {}), knockMs: cd.knockMs, flickerMs: cd.flickerMs };
  });

  // ---------------- api ----------------
  bindParanormalImpl({
    phenomena: (crew) => side(crew).records.slice(),
    witnessedBy: (crew, pid) => side(crew).records.filter((r) => r.witnesses.includes(pid)).length,
    quietUntil: (crew) => {
      const q = slots.get(crew)?.st.quietUntil ?? 0;
      return q > ctx.now() ? q : 0;
    },
    setLoreTargets: (crew, ids) => {
      const list = [...new Set(ids.map(String))];
      side(crew).lore = list;
      const st = slots.get(crew)?.st;
      if (st) st.loreTargets = list.slice();
    },
    trigger: (crew, kind, opts) => {
      if (!enabled()) return false;
      const s = slotFor(crew, true);
      if (!s) return false;
      s.w.refresh();
      return !!firePara(s.st, s.w, b, outFor(crew), kind, { target: opts?.target, force: opts?.force });
    },
  });

  // ---------------- dev only ----------------
  ctx.registerDbg('paranormal.fire', (crew, player, args) => {
    const a = (args ?? {}) as { kind?: string; target?: string; force?: boolean; self?: boolean; patch?: ParanormalData };
    const kind = String(a.kind ?? '') as ParanormalKind;
    if (!KIND_BY_NAME.has(kind)) return { ok: false, reason: `unknown kind (${[...KIND_BY_NAME.keys()].join(', ')})` };
    if (!enabled()) return { ok: false, reason: 'disabled' };
    const s = slotFor(crew, true);
    if (!s) return { ok: false, reason: `no contract (phase ${crew.phase})` };
    s.w.refresh();
    const patch = a.patch && typeof a.patch === 'object' ? a.patch : undefined;
    const ev = firePara(s.st, s.w, b, outFor(crew), kind, { target: a.target ?? (a.self ? player.id : undefined), force: a.force !== false, patch });
    return ev ? { ok: true, ev } : { ok: false, reason: s.st.stats.why || 'nothing fits here' };
  });
  ctx.registerDbg('paranormal.state', (crew) => {
    const s = slotFor(crew, false);
    if (!s) return { enabled: enabled(), running: false, records: side(crew).records };
    s.w.refresh();
    const st = s.st;
    const ps = pokeStates.get(crew);
    return {
      enabled: enabled(), running: true, ...hauntDebug(st, s.w, b), records: side(crew).records,
      avgTickMs: st.stats.ticks ? Math.round((st.stats.tickMs / st.stats.ticks) * 10000) / 10000 : 0,
      stalk: st.stalk, room: st.room, lore: st.loreTargets,
      pokes: { on: pokesOn(), stats: ps && ps.key === st.key ? ps.stats : null },
    };
  });
  ctx.registerDbg('paranormal.tune', (crew, _p, args) => {
    const s = slotFor(crew, true);
    if (!s) return { ok: false };
    const a = (args ?? {}) as {
      nextInSec?: number; tensionEma?: number; t1Done?: boolean; t2Done?: boolean; clearBudgets?: boolean; lastAgoSec?: number; reviveInSec?: number;
    };
    const now = ctx.now();
    if (a.reviveInSec !== undefined) for (const d of s.st.dark.values()) if (!d.needsSwitch) d.reviveAt = now + Number(a.reviveInSec) * 1000;
    if (a.nextInSec !== undefined) s.st.nextAt = now + Number(a.nextInSec) * 1000;
    if (a.tensionEma !== undefined) s.st.tensionEma = Number(a.tensionEma);
    if (a.t1Done !== undefined) s.st.t1Done = !!a.t1Done;
    if (a.t2Done !== undefined) s.st.t2Done = !!a.t2Done;
    if (a.clearBudgets) { s.st.used = {}; s.st.recent = []; s.st.perPlayer.clear(); s.st.lastDarkWalkAt = -Infinity; }
    if (a.lastAgoSec !== undefined) s.st.lastAt = now - Number(a.lastAgoSec) * 1000;
    return { ok: true };
  });
  ctx.registerDbg('paranormal.reset', (crew) => {
    const s = slots.get(crew);
    if (s) drop(crew, s);
    return { ok: true };
  });

  // v1.3 site rules (flag siteRules): the building answers what the crew says (siterules.ts)
  installSiteRules(ctx, () => b, enabled);

  log.info(`installed (order ${PARANORMAL_ORDER}, ${enabled() ? 'on' : 'off'})`);
}
