// Owner: players-stealth (v1.2). Crawl vents (flag crawlVents, stretch): a crouching player can crawl through a vent
// pair the Listener / Snatcher use, from one grate to its twin.
// - interactables: 'crawl:<vent item id>' (catalog v12Id('vent', id)), kind 'vent', hold E 1200 ms, r 0.45, one per
//   grate of every pair that is not in the vault; registered from this module's tick once interaction rebuilt its
//   interactables for the layout (never in a phase hook that runs before interaction's)
// - a pair across the keycard door (keycard zones 0 / 1) crawls only once the layout's locked door
//   (L.metrics.lockDoor) shows locked:false in interaction's state: plan check #1, re-checked on every use
// - deny unless: alive, the server's stealth stance is crouch, not a Core carrier (objectives), no heavy salvage, the
//   10 s cooldown passed, and ventInUse (monsters: any snatch, or a Listener vent trip on this pair) is false
// - crawl: interaction hideIn(crew, pid, 'duct:<vent id>') (light off, actions blocked, monsters ignore the player),
//   clamp(straight duct length / ventSpeed, 3, 7) s, a 'ductThump' noise of 4 m at the entry and 6 m at the exit, then
//   unhide + serverTeleport to the twin grate's front; 'players.crawl' {pid, phase, p, yaw, until} to the crew;
//   recordStat ductsCrawled
// - dev: dbg.players.vents (pairs, crawlability, active crawls), dbg.players.crawl {vent} (crawl without the hold)
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import type { LayoutItem, LevelLayout } from '@dead-air/shared/layout.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { v12Id } from '@dead-air/shared/catalog.ts';
import type { CrawlEvent } from '@dead-air/shared/messages/players.ts';
import * as IX from '../interaction/api.ts';
import { ventInUse } from '../monsters/api.ts';
import * as OBJ from '../objectives/api.ts';
import { recordStat } from '../meta/api.ts';
import { serverTeleport } from '../net/movement.ts';
import { emitNoise } from './noise.ts';
import { stealthStance } from './api.ts';

export interface VentDeps {
  ventsOn(crew: Crew): boolean;
  bal(): Record<string, unknown>;
}

/** one grate: wall point, inward normal, the walkable spot in front of it */
export interface Grate { id: string; to: string; space: number; x: number; z: number; nx: number; nz: number; fx: number; fz: number }

export interface VentPair {
  a: Grate;
  b: Grate;
  /** keycard zones of both spaces */
  zones: [number, number];
  /** straight duct length (m) */
  len: number;
}

interface Crawl { pid: string; from: Grate; to: Grate; until: number; startedAt: number }

interface VentSlice {
  /** layout hash the interactables were registered for ('' = none) */
  registeredFor: string;
  /** interactable ids this module registered */
  ids: string[];
  pairs: VentPair[];
  crawls: Map<string, Crawl>;
  /** pid -> server ms when the player may crawl again */
  cooldownUntil: Map<string, number>;
  /** dev/test stand-ins (dbg.players.vents): ducts busy (ventInUse) / a pid counted as a Core carrier */
  devBusy: boolean;
  devCarrier: string | null;
}

const SPOT = 'duct:';
const r2 = (v: number) => Math.round(v * 100) / 100;

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** every vent grate with its inward normal and front spot (same rule as the Snatcher's rescue spot) */
export function gratesOf(L: Pick<LevelLayout, 'W' | 'H' | 'owner' | 'items'>): Grate[] {
  const own = (x: number, z: number) => (x >= 0 && z >= 0 && x < L.W && z < L.H ? L.owner[Math.floor(z) * L.W + Math.floor(x)] ?? -1 : -1);
  const out: Grate[] = [];
  for (const it of L.items) {
    if (it.kind !== 'vent') continue;
    const rot = it.rot ?? 0;
    let nx = Math.sin(rot), nz = Math.cos(rot);
    if (own(it.x + nx * 0.6, it.z + nz * 0.6) !== it.space && own(it.x - nx * 0.6, it.z - nz * 0.6) === it.space) { nx = -nx; nz = -nz; }
    let fx = it.x + nx * 0.6, fz = it.z + nz * 0.6;
    if (own(fx, fz) < 0) { fx = it.x + nx * 0.35; fz = it.z + nz * 0.35; }
    out.push({ id: it.id, to: String(it.data?.to ?? ''), space: it.space, x: it.x, z: it.z, nx, nz, fx, fz });
  }
  return out;
}

/** vent pairs a player may ever crawl: both grates exist, neither is in the vault */
export function ventPairsOf(L: Pick<LevelLayout, 'W' | 'H' | 'owner' | 'items' | 'spaces'>): VentPair[] {
  const grates = gratesOf(L);
  const byId = new Map(grates.map((g) => [g.id, g]));
  const out: VentPair[] = [];
  const seen = new Set<string>();
  for (const a of grates) {
    const b = byId.get(a.to);
    if (!b || seen.has(a.id) || seen.has(b.id)) continue;
    seen.add(a.id);
    seen.add(b.id);
    const sa = L.spaces[a.space], sb = L.spaces[b.space];
    if (!sa || !sb || sa.kind === 'vault' || sb.kind === 'vault') continue; // never into or out of the vault wing
    out.push({ a, b, zones: [sa.zone, sb.zone], len: Math.hypot(a.x - b.x, a.z - b.z) });
  }
  return out;
}

/** keycard rule (plan check #1): same zone, or the layout's locked door is open (unlocked) by now */
export function pairOpen(p: VentPair, L: Pick<LevelLayout, 'metrics'>, doorLocked: (id: number) => boolean | undefined): boolean {
  if (p.zones[0] === p.zones[1]) return true;
  const lockDoor = num(L.metrics?.lockDoor, -1);
  if (lockDoor < 0) return true; // no keycard door in this layout: zones are one wing
  return doorLocked(lockDoor) === false;
}

export function installVents(ctx: ServerContext, deps: VentDeps): void {
  const log = ctx.log('players');
  const slice = (c: Crew): VentSlice => {
    let s = c.slices.playersVents as VentSlice | undefined;
    if (!s) c.slices.playersVents = s = { registeredFor: '', ids: [], pairs: [], crawls: new Map(), cooldownUntil: new Map(), devBusy: false, devCarrier: null };
    return s;
  };
  const bal = deps.bal;
  const safe = <T>(f: () => T, d: T): T => {
    try { return f(); } catch { return d; }
  };
  const doorLocked = (crew: Crew) => (id: number): boolean | undefined => safe(() => {
    const d = (IX.state(crew).doors as Record<string, { locked?: boolean } | undefined>)[String(id)];
    return d ? !!d.locked : undefined;
  }, undefined);
  const pairOf = (s: VentSlice, ventId: string): { pair: VentPair; from: Grate; to: Grate } | null => {
    for (const p of s.pairs) {
      if (p.a.id === ventId) return { pair: p, from: p.a, to: p.b };
      if (p.b.id === ventId) return { pair: p, from: p.b, to: p.a };
    }
    return null;
  };

  /** (re)register the crawl interactables for the crew's current layout (or drop them when off / no layout) */
  const sync = (crew: Crew) => {
    const s = slice(crew);
    const L = crew.layout;
    const want = L && L.kind === 'facility' && crew.phase === 'contract' && deps.ventsOn(crew) ? L.hash : '';
    if (want === s.registeredFor) return;
    for (const id of s.ids) safe(() => IX.removeInteractable(crew, id), undefined);
    s.ids = [];
    s.pairs = [];
    for (const c of [...s.crawls.values()]) finish(crew, c, 'layout');
    s.registeredFor = want;
    if (!want || !L) return;
    s.pairs = ventPairsOf(L);
    const holdMs = Math.max(200, num(bal().ventHoldMs, 1200));
    const r = num(bal().ventRadius, 0.45);
    const list = s.pairs.flatMap((p) => [p.a, p.b]).map((g) => ({
      id: v12Id('vent', g.id), kind: 'vent', p: [r2(g.x), 0.35, r2(g.z)] as [number, number, number],
      prompt: 'Crawl through the vent (crouch, hold E)', enabled: true, holdMs, r, ref: g.id,
    }));
    if (list.length) safe(() => IX.registerInteractables(crew, list), undefined);
    s.ids = list.map((i) => i.id);
    log.info(`crew ${crew.code}: ${s.pairs.length} crawlable vent pair(s) (${s.pairs.filter((p) => p.zones[0] !== p.zones[1]).length} across the keycard door)`);
  };

  /** why pid may not crawl into ventId right now ('' = may) */
  const denial = (crew: Crew, pl: ServerPlayer, ventId: string): string => {
    const s = slice(crew);
    if (!deps.ventsOn(crew)) return 'The vent is screwed shut';
    const hit = pairOf(s, ventId);
    if (!hit) return 'The vent is screwed shut';
    if (!safe(() => IX.isAlive(crew, pl.id), pl.alive)) return 'You are dead';
    if (s.crawls.has(pl.id) || safe(() => IX.isHidden(crew, pl.id), false)) return 'You are already hiding';
    if (stealthStance(crew, pl.id) !== STANCE.crouch) return 'Crouch (C) to crawl in';
    const carrier = s.devCarrier === pl.id || safe(() => (OBJ.state(crew)?.core?.carriers ?? []).includes(pl.id) || OBJ.carrying(crew, pl.id) === 'core', false);
    if (carrier) return 'The Core will not fit through a vent';
    if (safe(() => IX.holding(crew, pl.id, 'loot.heavy') || OBJ.carrying(crew, pl.id) === 'loot', false)) return 'Too bulky to fit: drop the heavy salvage';
    const now = ctx.now();
    const cd = s.cooldownUntil.get(pl.id) ?? 0;
    if (now < cd) return `Catch your breath (${Math.ceil((cd - now) / 1000)} s)`;
    if (s.devBusy || safe(() => ventInUse(crew, hit.from.id) || ventInUse(crew, hit.to.id), false)) return 'Something is moving in the ducts';
    if (!pairOpen(hit.pair, crew.layout ?? { metrics: {} }, doorLocked(crew))) return 'This duct runs past the keycard door: open it first';
    return '';
  };

  const yawOut = (g: Grate) => Math.atan2(g.nx, g.nz);
  /** facing into the duct (normalized to -pi..pi) */
  const yawIn = (g: Grate) => Math.atan2(-g.nx, -g.nz);

  const start = (crew: Crew, pl: ServerPlayer, ventId: string): { ok: boolean; msg?: string } => {
    const why = denial(crew, pl, ventId);
    if (why) return { ok: false, msg: why };
    const s = slice(crew);
    const hit = pairOf(s, ventId)!;
    if (!safe(() => IX.hideIn(crew, pl.id, SPOT + hit.from.id), false)) return { ok: false, msg: 'You cannot get in there' };
    const b = bal();
    const sec = Math.max(num(b.ventMinSec, 3), Math.min(num(b.ventMaxSec, 7), hit.pair.len / Math.max(0.1, num(b.ventSpeed, 1.5))));
    const now = ctx.now();
    const c: Crawl = { pid: pl.id, from: hit.from, to: hit.to, until: now + sec * 1000, startedAt: now };
    s.crawls.set(pl.id, c);
    emitNoise(crew, { x: hit.from.x, z: hit.from.z, radiusM: num(b.ventThumpEnterM, 4), kind: 'ductThump', source: pl.id });
    const ev: CrawlEvent = { pid: pl.id, phase: 'enter', p: [r2(hit.from.fx), 0, r2(hit.from.fz)], yaw: r2(yawIn(hit.from)), until: Math.round(c.until), from: hit.from.id, to: hit.to.id };
    ctx.emit(crew, 'players.crawl', ev);
    safe(() => recordStat(crew, pl.id, 'ductsCrawled', 1), undefined);
    return { ok: true };
  };

  /** end a crawl: out at the twin grate (or, for a cancelled one on a new layout, nowhere) */
  function finish(crew: Crew, c: Crawl, why: 'done' | 'layout' | 'left'): void {
    const s = slice(crew);
    s.crawls.delete(c.pid);
    const pl = crew.players.get(c.pid);
    if (safe(() => IX.hiddenIn(crew, c.pid), null) === SPOT + c.from.id) safe(() => IX.unhide(crew, c.pid), false);
    s.cooldownUntil.set(c.pid, ctx.now() + num(bal().ventCooldownSec, 10) * 1000);
    if (why === 'layout' || !pl) return;
    const yaw = yawOut(c.to);
    serverTeleport(pl, c.to.fx, c.to.fz, 0, yaw);
    if (pl.pose.stance === STANCE.hidden) pl.pose.stance = STANCE.crouch;
    emitNoise(crew, { x: c.to.x, z: c.to.z, radiusM: num(bal().ventThumpExitM, 6), kind: 'ductThump', source: c.pid });
    const p: Vec3 = [r2(c.to.fx), 0, r2(c.to.fz)];
    const ev: CrawlEvent = { pid: c.pid, phase: 'exit', p, yaw: r2(yaw), until: Math.round(ctx.now()), from: c.from.id, to: c.to.id };
    ctx.emit(crew, 'players.crawl', ev);
  }

  IX.onInteract('vent', (crew, player, targetId) => {
    const ventId = String(targetId).startsWith(`${v12Id('vent', '')}`) ? String(targetId).slice(v12Id('vent', '').length) : String(targetId);
    const r = start(crew, player, ventId);
    return r.ok ? true : r.msg ?? false;
  });

  ctx.registerSystem({
    name: 'players.vents',
    order: SYSTEM_ORDER.players + 1,
    tick(_dt, crew) {
      sync(crew);
      const s = slice(crew);
      if (!s.crawls.size) return;
      const now = ctx.now();
      for (const c of [...s.crawls.values()]) {
        const pl = crew.players.get(c.pid);
        if (!pl) { finish(crew, c, 'left'); continue; }
        const stillIn = safe(() => IX.hiddenIn(crew, c.pid), null) === SPOT + c.from.id;
        if (now >= c.until || !stillIn || !safe(() => IX.isAlive(crew, c.pid), pl.alive)) finish(crew, c, 'done');
      }
    },
  });

  // ---- dev ----
  ctx.registerDbg('players.vents', (crew, player, args) => {
    const s = slice(crew);
    const a = (args ?? {}) as { busy?: boolean; carrier?: string | null };
    if (typeof a.busy === 'boolean') s.devBusy = a.busy;
    if (a.carrier !== undefined) s.devCarrier = typeof a.carrier === 'string' && a.carrier ? a.carrier : null;
    const L = crew.layout;
    const lockId = L ? num(L.metrics?.lockDoor, -1) : -1;
    const ld = L && lockId >= 0 ? L.doors.find((d) => d.id === lockId) : undefined;
    // cell centres on both sides of the keycard door (tests walk up to it), with each side's space and zone
    const sides = ld && L ? (ld.dir === 'v' ? [[ld.x - 0.5, ld.y + 0.5], [ld.x + 0.5, ld.y + 0.5]] : [[ld.x + 0.5, ld.y - 0.5], [ld.x + 0.5, ld.y + 0.5]]).map(([x, z]) => {
      const sp = L.owner[Math.floor(z) * L.W + Math.floor(x)] ?? -1;
      return { x, z, space: sp, zone: sp >= 0 ? L.spaces[sp]?.zone ?? -1 : -1 };
    }) : [];
    return {
      on: deps.ventsOn(crew), registeredFor: s.registeredFor, ids: s.ids,
      lockDoor: lockId, lockDoorSides: sides, lockDoorLocked: lockId >= 0 ? doorLocked(crew)(lockId) ?? null : null,
      pairs: s.pairs.map((p) => ({
        a: { id: p.a.id, space: p.a.space, front: [r2(p.a.fx), r2(p.a.fz)], yaw: r2(yawOut(p.a)) },
        b: { id: p.b.id, space: p.b.space, front: [r2(p.b.fx), r2(p.b.fz)], yaw: r2(yawOut(p.b)) },
        zones: p.zones, len: r2(p.len), open: L ? pairOpen(p, L, doorLocked(crew)) : false,
      })),
      crawls: [...s.crawls.values()].map((c) => ({ pid: c.pid, from: c.from.id, to: c.to.id, leftMs: Math.round(c.until - ctx.now()) })),
      denial: Object.fromEntries(s.pairs.flatMap((p) => [p.a.id, p.b.id]).map((id) => [id, denial(crew, player, id) || 'ok'])),
    };
  });
  ctx.registerDbg('players.crawl', (crew, player, args) => {
    const vent = String((args as { vent?: unknown } | null)?.vent ?? '');
    return start(crew, player, vent);
  });
}

/** grate items of a layout by id (tests) */
export function ventItems(L: Pick<LevelLayout, 'items'>): LayoutItem[] {
  return L.items.filter((i) => i.kind === 'vent');
}
