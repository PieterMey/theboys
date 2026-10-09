// Owner: env-paranormal (v1.2). The haunt scheduler (pure over ParaWorld + ParaOut; tests drive it with simulated crews).
//  - cadence: gap = lerp(75, 28, H) s ±35% from makeRng(`${L.seed}|${crew.code}|${contractIndex}`, 'paranormal'); x1.6 in relax
//  - blocks: director peak/fade, any chase/grab/snatch, 15 s after the Listener wakes, 8 s after a director event,
//    10 s crew-wide spacing; 45 s per target player
//  - budgets per contract, novelty (not either of the last 2 groups), a random no-op roll per slot
//  - guarantees: a T1 by clockMin 120, a T2 by clockMin 240, a mirror event when a player first stands within 5 m of one
//  - lifecycle: active events end on timeout / seen / lit / approach; dark-walk kills + revives; residue for sync
import { makeRng } from '@dead-air/shared/rng.ts';
import { los, pathDistance } from '@dead-air/shared/nav/index.ts';
import type { ParanormalData, ParanormalEvent, ParanormalKind } from '@dead-air/shared/messages/paranormal.ts';
import type { PhenomenonRecord } from './api.ts';
import { clamp01, drawGapSec, emaStep, fallbackClockMin, hauntLevel, tierCap } from './haunt.ts';
import { activeMonsters, angleTo, dist2, fixturesBySpace, indoor, spaceAtXZ, switchSpaces } from './gates.ts';
import { KINDS, KIND_BY_NAME, buildMirrorGuarantee, groupOf } from './kinds.ts';
import type { KindDef, Targets } from './kinds.ts';
import type {
  ActiveEv, BuildCtx, Built, CrewPara, DirectorPhase, ParaBalance, ParaMonster, ParaOut, ParaPlayer, ParaWorld, Tier,
} from './types.ts';

let idSeq = 0;
/** event ids are unique per server process (clients key effects by id across contracts) */
export function nextId(): number {
  idSeq = (idSeq + 1) % 2_000_000_000;
  return idSeq;
}

export function newCrewPara(w: ParaWorld, crewCode: string, contractIndex: number, b: ParaBalance): CrewPara {
  const L = w.layout;
  const now = w.now();
  const rng = makeRng(`${L.seed}|${crewCode}|${contractIndex}`, 'paranormal');
  return {
    key: `${L.hash}|${contractIndex}`,
    layout: L,
    rng,
    startedAt: now,
    nextAt: now + b.firstDelaySec * 1000,
    lastAt: -Infinity,
    perPlayer: new Map(),
    used: {},
    recent: [],
    t1Done: false,
    t2Done: false,
    mirrorGuard: new Map(),
    tensionEma: 0,
    emaAt: now,
    active: new Map(),
    residue: new Map(),
    records: [],
    dark: new Map(),
    lastDarkWalkAt: -Infinity,
    quietUntil: 0,
    wokeAt: -Infinity,
    directorEventAt: -Infinity,
    dirEvSeen: -1,
    dirEvLast: '',
    stalk: null,
    room: null,
    loreTargets: [],
    buckets: new Map(),
    checkAt: 0,
    forceAt: 0,
    listenerActive: null,
    stats: { planned: 0, noop: 0, blocked: 0, failed: 0, emitted: 0, planMs: 0, planMax: 0, ticks: 0, tickMs: 0, why: '', misses: {} },
    trace: [],
  };
}

const TRACE_MAX = 400;
function trace(st: CrewPara, e: CrewPara['trace'][number]): void {
  st.trace.push(e);
  if (st.trace.length > TRACE_MAX) st.trace.splice(0, st.trace.length - TRACE_MAX);
}

// ---------------------------------------------------------------- helpers

const CHASE = new Set(['charge', 'windup', 'hunt', 'grab', 'lunge', 'pounce', 'chase', 'drop', 'drag', 'struggle', 'knockdown']);

export function chaseActive(mons: readonly ParaMonster[], players: readonly ParaPlayer[]): boolean {
  if (players.some((p) => p.grabbed)) return true;
  return mons.some((m) => m.active && (CHASE.has(m.state) || (m.kind === 'mannequin' && m.state === 'move')));
}

export function clockMinOf(st: CrewPara, w: ParaWorld): number {
  const c = w.clockMin();
  return c >= 0 ? c : fallbackClockMin(st.startedAt, w.now(), w.contractRealSec());
}

export function directorPhase(w: ParaWorld): DirectorPhase {
  return w.director()?.phase ?? 'build';
}

/** the current haunt level H (never sent) */
export function hauntOf(st: CrewPara, w: ParaWorld, b: ParaBalance): number {
  return hauntLevel(b, { clockMin: clockMinOf(st, w), tensionEma: st.tensionEma, blackout: w.blackout(), coreLifted: w.coreLifted(), themeHaunt: w.themeHaunt() });
}

/** players an event may target (alive, inside the building, not in the van, not hiding, not grabbed) */
export function eligible(w: ParaWorld, players: readonly ParaPlayer[]): ParaPlayer[] {
  const L = w.layout;
  return players.filter((p) => p.alive && !p.inVan && !p.hidden && !p.grabbed && indoor(L, spaceAtXZ(L, p.x, p.z)))
    .sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
}

function targetsFor(st: CrewPara, b: ParaBalance, now: number, players: readonly ParaPlayer[], elig: ParaPlayer[], mons: ParaMonster[], spacing: boolean): Targets {
  const list = (spacing ? elig.filter((p) => now - (st.perPlayer.get(p.id) ?? -Infinity) >= b.perPlayerSec * 1000) : elig.slice())
    .sort((a, c) => (st.perPlayer.get(a.id) ?? -Infinity) - (st.perPlayer.get(c.id) ?? -Infinity) || (a.id < c.id ? -1 : 1));
  return { list, all: players.slice().sort((a, c) => (a.id < c.id ? -1 : 1)), mons };
}

/** why planning is blocked right now ('' = free) */
export function blockedWhy(st: CrewPara, w: ParaWorld, b: ParaBalance, now: number, players: readonly ParaPlayer[], mons: readonly ParaMonster[]): string {
  const ph = directorPhase(w);
  if (ph === 'peak' || ph === 'fade') return `director ${ph}`;
  if (chaseActive(mons, players)) return 'chase';
  if (now < st.wokeAt + b.blockAfterWakeSec * 1000) return 'wake';
  if (now < st.directorEventAt + b.blockAfterDirectorSec * 1000) return 'director event';
  if (now < st.lastAt + b.spacingSec * 1000) return 'spacing';
  return '';
}

function budgetLeft(st: CrewPara, b: ParaBalance, def: KindDef): boolean {
  const cap = b.budgets[def.group] ?? b.budgets[def.kind] ?? 0;
  return (st.used[def.group] ?? 0) < cap;
}

function kindEnabled(b: ParaBalance, def: KindDef): boolean {
  if (b.kinds[def.kind] === false) return false;
  return true;
}

// ---------------------------------------------------------------- emission

function emitBuilt(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, built: Built, now: number, counts = true, patch?: ParanormalData): ParanormalEvent {
  if (patch) built.ev.data = { ...(built.ev.data ?? {}), ...patch };
  const id = nextId();
  const at = now + Math.max(250, b.leadMs);
  const seed = st.rng.int(1, 0x7fffffff);
  const ev: ParanormalEvent = { id, kind: built.kind, tier: built.tier, at, seed, ...built.ev };
  const rec: PhenomenonRecord = {
    id, kind: built.kind, tier: built.tier, t: Math.round((at - st.startedAt) / 100) / 10, space: ev.space, target: built.target,
    witnesses: [], tell: !!built.tell,
  };
  const activeMs = built.activeMs ?? ev.ms;
  const a: ActiveEv = { ev, rec, endAt: at + activeMs, armed: !!built.armed, litSince: 0 };
  if (built.kills) a.kills = built.kills.map((k) => ({ space: k.space, at: at + k.at, done: false }));
  st.active.set(id, a);
  out.event(ev);
  // a mirror event aimed at this player already is their mirror moment: the first-mirror guarantee is answered
  if ((built.kind === 'mirror_figure' || built.kind === 'mirror_writing') && built.target) {
    const g = st.mirrorGuard.get(built.target);
    if (g) g.done = true;
    else st.mirrorGuard.set(built.target, { since: now, mirror: String(ev.ref ?? ''), done: true });
  }
  if (counts) {
    const g = groupOf(built.kind);
    st.used[g] = (st.used[g] ?? 0) + 1;
    st.recent.push(g);
    if (st.recent.length > 2) st.recent.shift();
    st.lastAt = now;
    if (built.target) st.perPlayer.set(built.target, now);
    if (built.tier >= 1) st.t1Done = true;
    if (built.tier >= 2) st.t2Done = true;
    if (built.kind === 'dark_walk') st.lastDarkWalkAt = now;
    st.stats.emitted++;
  }
  // other ambient systems hold back around a visible effect
  const visible = Math.min(ev.ms, 30_000);
  st.quietUntil = Math.max(st.quietUntil, at + visible + b.quietSec * 1000);
  return ev;
}

/**
 * v1.3: an event the haunt did not plan (a dead player's poke): active + synced + witnessed + recorded like any
 * phenomenon, but outside the haunt's budgets, novelty, spacing, per-player gaps and quiet window, and seeded by the
 * caller (the haunt rng stays untouched, so its seeded schedule never shifts).
 */
export function emitExtra(st: CrewPara, b: ParaBalance, out: ParaOut, built: Built, now: number, seed: number): ParanormalEvent {
  const id = nextId();
  const at = now + Math.max(250, b.leadMs);
  const ev: ParanormalEvent = { id, kind: built.kind, tier: built.tier, at, seed, ...built.ev };
  const rec: PhenomenonRecord = {
    id, kind: built.kind, tier: built.tier, t: Math.round((at - st.startedAt) / 100) / 10, space: ev.space, target: built.target,
    witnesses: [], tell: !!built.tell,
  };
  st.active.set(id, { ev, rec, endAt: at + (built.activeMs ?? ev.ms), armed: false, litSince: 0 });
  out.event(ev);
  return ev;
}

/** weighted order without replacement over the candidate kinds (seeded) */
function weightedOrder(st: CrewPara, b: ParaBalance, defs: KindDef[], cap: Tier): KindDef[] {
  const pool = defs.map((d) => ({ d, w: Math.max(0.0001, (b.weights[d.kind] ?? 1) * (d.tier >= 1 && cap >= d.tier ? b.tierBoost : 1)) }));
  const out: KindDef[] = [];
  while (pool.length) {
    let sum = 0;
    for (const p of pool) sum += p.w;
    let r = st.rng.next() * sum;
    let k = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) { k = i; break; }
    }
    out.push(pool[k].d);
    pool.splice(k, 1);
  }
  return out;
}

export interface PlanOpts {
  /** guarantee: only kinds of at least this tier, ignoring the H tier cap */
  minTier?: Tier;
  /** dbg/forced: one kind, no budgets/novelty/spacing/soft gates */
  kind?: ParanormalKind;
  force?: boolean;
  target?: string;
  /** dbg only: merged into the event data (e.g. a longer litMs / holdMs for screenshots) */
  patch?: ParanormalData;
}

/** one planning attempt; returns the emitted event or null */
export function planOnce(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, players: readonly ParaPlayer[], mons: ParaMonster[], o: PlanOpts = {}): ParanormalEvent | null {
  const now = w.now();
  const t0 = performance.now();
  const H = hauntOf(st, w, b);
  const phase = directorPhase(w);
  let cap = tierCap(b, H, phase);
  if (o.minTier !== undefined) cap = Math.max(cap, o.minTier) as Tier;
  if (o.force) cap = 2;
  const elig = eligible(w, players);
  const t = targetsFor(st, b, now, players, elig, mons, !o.force && !o.target);
  let defs: KindDef[];
  if (o.kind) {
    const d = KIND_BY_NAME.get(o.kind);
    defs = d ? [d] : [];
  } else {
    defs = KINDS.filter((d) => d.tier <= cap && (o.minTier === undefined || d.reaches >= o.minTier) && kindEnabled(b, d) && budgetLeft(st, b, d)
      && !st.recent.includes(d.group));
    defs = weightedOrder(st, b, defs, cap);
  }
  const c: BuildCtx = { w, st, b, now, tierCap: cap, force: !!o.force, target: o.target };
  let ev: ParanormalEvent | null = null;
  let tries = 0;
  for (const d of defs) {
    if (tries++ >= 6) break;
    // Core carriers get T0/T1 only: builders skip them for T2 kinds; a T2-only kind needs a non-carrier target
    const built = d.build(c, t);
    if (!built) { st.stats.misses[d.kind] = (st.stats.misses[d.kind] ?? 0) + 1; continue; }
    if (o.minTier !== undefined && built.tier < o.minTier) continue;
    const tgt = built.target ? players.find((p) => p.id === built.target) : undefined;
    if (tgt?.core && built.tier > 1) continue;
    ev = emitBuilt(st, w, b, out, built, now, true, o.patch);
    break;
  }
  const ms = performance.now() - t0;
  // forced dbg fires search on purpose: only regular planning counts toward the plan budget
  if (!o.force) {
    st.stats.planMs += ms;
    st.stats.planMax = Math.max(st.stats.planMax, ms);
  }
  return ev;
}

// ---------------------------------------------------------------- lifecycle

/** end an active event: paranormal.end to its audience, phenomenon record with witnesses, residue if persistent */
export function finish(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, a: ActiveEv, reason: 'seen' | 'lit' | 'interrupted' | 'timeout'): void {
  if (!st.active.has(a.ev.id)) return;
  st.active.delete(a.ev.id);
  addHeardWitnesses(st, w, b, a);
  out.end(a.ev.id, reason, a.ev.to);
  if (a.ev.persist) {
    if (a.ev.kind !== 'dark_walk' || ((a.ev.data?.dead as number[] | undefined)?.length ?? 0) > 0 || a.kills?.some((k) => !k.done)) st.residue.set(a.ev.id, a.ev);
  }
  st.records.push(a.rec);
  out.phenomenon(a.rec);
}

function addWitness(a: ActiveEv, pid: string): void {
  if (!a.rec.witnesses.includes(pid)) a.rec.witnesses.push(pid);
}

/** knocks, rattles and falls are heard: living players within hearM (sound path metric) witness them */
function addHeardWitnesses(st: CrewPara, w: ParaWorld, b: ParaBalance, a: ActiveEv): void {
  const k = a.ev.kind;
  const hear = k === 'knock' || k === 'handle_rattle' ? b.knock.hearM : k === 'object_fall' || k === 'poltergeist' ? b.props.hearM
    : k === 'dead_poke' && a.ev.data?.poke === 'knock' ? b.poke.hearM : 0;
  if (!hear || !a.ev.p) return;
  const [x, , z] = a.ev.p;
  for (const p of w.players()) {
    if (!p.alive || a.rec.witnesses.includes(p.id)) continue;
    if (dist2(p.x, p.z, x, z) > hear) continue;
    const d = pathDistance(w.grid, p.x, p.z, x, z, { doorOpen: w.doorOpen, maxCost: hear + 1 });
    if (d <= hear) addWitness(a, p.id);
  }
}

/** a living player's flashlight cone covers (x, z): <= litM, inside litDeg of their yaw, grid line of sight */
function litBy(w: ParaWorld, b: ParaBalance, players: readonly ParaPlayer[], x: number, z: number): ParaPlayer | null {
  const lim = (b.presence.litDeg * Math.PI) / 180;
  for (const p of players) {
    if (!p.alive || !p.light) continue;
    if (dist2(p.x, p.z, x, z) > b.presence.litM) continue;
    if (angleTo(p, x, z) > lim) continue;
    if (losClear(w, p.x, p.z, x, z)) return p;
  }
  return null;
}

function losClear(w: ParaWorld, ax: number, az: number, bx: number, bz: number): boolean {
  return los(w.grid, ax, az, bx, bz, w.doorOpen);
}

function tickActive(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, now: number, players: readonly ParaPlayer[], chase: boolean): void {
  for (const a of [...st.active.values()]) {
    const ev = a.ev;
    // dark walk: kill each space when its last fixture dies
    if (a.kills) {
      for (const k of a.kills) {
        if (k.done || now < k.at) continue;
        k.done = true;
        killSpace(st, w, b, a, k.space, now, players);
      }
    }
    if (now < ev.at) continue;
    if (ev.kind === 'presence' || ev.kind === 'silhouette') {
      if (chase) { finish(st, w, b, out, a, 'interrupted'); continue; }
      const [x, , z] = ev.p ?? [0, 0, 0];
      const appr = Number(ev.data?.approachM ?? b.presence.approachM);
      const near = players.find((p) => p.alive && dist2(p.x, p.z, x, z) < appr);
      if (near) { finish(st, w, b, out, a, 'seen'); continue; }
      if (ev.kind === 'presence') {
        const lp = litBy(w, b, players, x, z);
        if (lp) {
          if (!a.litSince) a.litSince = now;
          const litMs = Number(ev.data?.litMs ?? b.presence.litSec * 1000);
          if (now - a.litSince >= litMs) { addWitness(a, lp.id); finish(st, w, b, out, a, 'lit'); continue; }
        } else a.litSince = 0;
      }
    }
    if ((ev.kind === 'mirror_figure' || ev.kind === 'cold_spot') && chase) { finish(st, w, b, out, a, 'interrupted'); continue; }
    if (ev.kind === 'cold_spot' && ev.p) {
      const r = Number(ev.data?.r ?? 2) + 0.5;
      for (const p of players) if (p.alive && dist2(p.x, p.z, ev.p[0], ev.p[2]) <= r) addWitness(a, p.id);
    }
    if (ev.kind === 'brownout_breath' || (ev.kind === 'dead_poke' && ev.data?.poke === 'flicker')) {
      for (const p of players) if (p.alive && spaceAtXZ(w.layout, p.x, p.z) === ev.space) addWitness(a, p.id);
    }
    if (a.armed) {
      if (now >= a.endAt) { a.armed = false; finish(st, w, b, out, a, 'timeout'); }
      continue;
    }
    if (now >= a.endAt && (!a.kills || a.kills.every((k) => k.done))) finish(st, w, b, out, a, 'timeout');
  }
}

function killSpace(st: CrewPara, w: ParaWorld, b: ParaBalance, a: ActiveEv, space: number, now: number, players: readonly ParaPlayer[]): void {
  const lights = (fixturesBySpace(w.layout).get(space) ?? []).map((f) => f.id);
  if (w.lightsOn(space)) w.setLights(space, false);
  const needsSwitch = switchSpaces(w.layout).has(space);
  const reviveAt = needsSwitch ? Infinity : now + Math.round((b.darkWalk.reviveMinSec + (b.darkWalk.reviveMaxSec - b.darkWalk.reviveMinSec) * st.rng.next()) * 1000);
  st.dark.set(space, { space, walk: a.ev.id, reviveAt, needsSwitch, seenOff: false, lights });
  const dead = (a.ev.data?.dead as number[] | undefined) ?? [];
  if (!dead.includes(space)) dead.push(space);
  if (a.ev.data) a.ev.data.dead = dead;
  for (const p of players) if (p.alive && spaceAtXZ(w.layout, p.x, p.z) === space) addWitness(a, p.id);
}

function tickDark(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, now: number): void {
  for (const d of [...st.dark.values()]) {
    const on = w.lightsOn(d.space);
    let revive = false;
    if (d.needsSwitch) {
      // revived when a player flips the room's switch back on (or power returns with the switch on)
      if (!on) d.seenOff = true;
      else if (d.seenOff) revive = true;
    } else if (now >= d.reviveAt) {
      w.setLights(d.space, true);
      revive = true;
    }
    if (!revive) continue;
    st.dark.delete(d.space);
    const walk = st.residue.get(d.walk) ?? st.active.get(d.walk)?.ev;
    if (walk?.data) {
      const dead = ((walk.data.dead as number[] | undefined) ?? []).filter((s) => s !== d.space);
      walk.data.dead = dead;
      if (!dead.length && st.residue.has(d.walk)) st.residue.delete(d.walk);
    }
    const ev: ParanormalEvent = {
      id: nextId(), kind: 'revive', tier: 0, at: now + Math.max(250, b.leadMs), ms: 1500, seed: st.rng.int(1, 0x7fffffff), space: d.space,
      data: { lights: d.lights, walk: d.walk },
    };
    out.event(ev);
  }
}

function tickResidue(st: CrewPara, now: number): void {
  for (const [id, ev] of st.residue) {
    if (ev.kind === 'footprints' && now > ev.at + Number(ev.data?.fadeMs ?? 90_000)) st.residue.delete(id);
  }
}

// ---------------------------------------------------------------- inputs from the world

function tickInputs(st: CrewPara, w: ParaWorld, b: ParaBalance, now: number, players: readonly ParaPlayer[], mons: readonly ParaMonster[]): void {
  const dir = w.director();
  let mx = 0;
  if (dir) for (const p of players) if (p.alive) mx = Math.max(mx, dir.tension[p.id] ?? 0);
  st.tensionEma = emaStep(st.tensionEma, clamp01(mx), (now - st.emaAt) / 1000, b.haunt.emaSec);
  st.emaAt = now;
  // a new director event (not 'quiet'); the first look only records what happened before the haunt started
  if (dir) {
    const evs = dir.events;
    const last = evs[evs.length - 1];
    const key = last ? `${evs.length}|${last.t}|${last.kind}|${last.source}` : '';
    if (st.dirEvSeen < 0) {
      st.dirEvSeen = evs.length;
      st.dirEvLast = key;
    } else if (key !== st.dirEvLast) {
      st.dirEvSeen = evs.length;
      st.dirEvLast = key;
      if (last && last.kind !== 'quiet') st.directorEventAt = now;
    }
  }
  // Listener wake without the event bus: inactive -> active
  const lis = mons.find((m) => m.kind === 'listener');
  if (lis) {
    if (st.listenerActive === false && lis.active) st.wokeAt = Math.max(st.wokeAt, now);
    st.listenerActive = lis.active;
  }
}

/** the first-mirror guarantee: pending while the player stays near a mirror */
function tickMirrorGuard(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, now: number, players: readonly ParaPlayer[], mons: ParaMonster[], blocked: string): boolean {
  const mirrors = w.mirrors().filter((m) => m.kind !== 'van' && indoor(w.layout, m.space));
  if (!mirrors.length) return false;
  for (const p of players) {
    if (!p.alive || p.inVan) continue;
    let g = st.mirrorGuard.get(p.id);
    if (g?.done) continue;
    if (!g) {
      let best: (typeof mirrors)[number] | null = null, bd = b.guarantees.mirrorM;
      for (const m of mirrors) {
        const d = dist2(m.x, m.z, p.x, p.z);
        if (d <= bd && (spaceAtXZ(w.layout, p.x, p.z) === m.space || losClear(w, p.x, p.z, m.x, m.z))) { bd = d; best = m; }
      }
      if (!best) continue;
      g = { since: now, mirror: best.id, done: false };
      st.mirrorGuard.set(p.id, g);
    }
    if (now - g.since > b.guarantees.mirrorPendingSec * 1000) { g.done = true; continue; }
    if (blocked) continue;
    if (p.hidden || p.grabbed) continue;
    // per-player spacing still holds (the guarantee stays pending meanwhile)
    if (now - (st.perPlayer.get(p.id) ?? -Infinity) < b.perPlayerSec * 1000) continue;
    const elig = eligible(w, players);
    const t = targetsFor(st, b, now, players, elig, mons, true);
    const c: BuildCtx = { w, st, b, now, tierCap: 2, force: false, target: p.id };
    const figLeft = (st.used.mirror_figure ?? 0) < (b.budgets.mirror_figure ?? 0);
    const wriLeft = (st.used.mirror_writing ?? 0) < (b.budgets.mirror_writing ?? 0);
    if (!figLeft && !wriLeft) { g.done = true; continue; }
    // novelty: not either of the last two groups
    const figureOk = figLeft && !p.core && directorPhase(w) === 'build' && !st.recent.includes('mirror_figure');
    const writingOk = wriLeft && !st.recent.includes('mirror_writing');
    if (!figureOk && !writingOk) continue;
    const built = buildMirrorGuarantee(c, t, p.id, g.mirror, figureOk, writingOk);
    if (!built) continue;
    if (built.kind === 'mirror_writing' && !writingOk) continue;
    emitBuilt(st, w, b, out, built, now, true);
    g.done = true;
    return true; // one per tick
  }
  return false;
}

// ---------------------------------------------------------------- tick

export function tickPara(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut): void {
  const t0 = performance.now();
  const now = w.now();
  const players = w.players();
  const mons = activeMonsters(w);
  st.stats.ticks++;
  tickInputs(st, w, b, now, players, w.monsters());
  const chase = chaseActive(mons, players);
  tickActive(st, w, b, out, now, players, chase);
  tickDark(st, w, b, out, now);
  tickResidue(st, now);
  // planning work at most 4x per second
  if (now - st.checkAt >= 250) {
    st.checkAt = now;
    // nothing at all while the crew unloads (first delay), guarantees included
    const blocked = now < st.startedAt + b.firstDelaySec * 1000 ? 'warm-up' : blockedWhy(st, w, b, now, players, mons);
    st.stats.why = blocked;
    const guarded = tickMirrorGuard(st, w, b, out, now, players, mons, blocked);
    const cm = clockMinOf(st, w);
    const forceOk = now >= st.forceAt;
    const wantT1 = forceOk && !st.t1Done && cm >= b.guarantees.t1ClockMin;
    const wantT2 = forceOk && !st.t2Done && cm >= b.guarantees.t2ClockMin && directorPhase(w) === 'build';
    const due = now >= st.nextAt;
    // a guarantee that just fired holds the crew-wide spacing: the slot waits for a later check
    if (!guarded && (due || wantT1 || wantT2)) {
      if (!blocked) planSlot(st, w, b, out, now, players, mons, wantT2 ? 2 : wantT1 ? 1 : undefined, due);
      else st.stats.blocked++;
    }
  }
  const ms = performance.now() - t0;
  st.stats.tickMs += ms;
}

/** a planned slot: no-op roll, then a build; reschedules either way */
function planSlot(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, now: number, players: readonly ParaPlayer[], mons: ParaMonster[], minTier: Tier | undefined, due: boolean): void {
  const phase = directorPhase(w);
  const H = hauntOf(st, w, b);
  st.stats.planned++;
  if (minTier === undefined && st.rng.chance(b.noopChance)) {
    st.stats.noop++;
    const g = drawGapSec(b, H, phase, st.rng.next());
    st.nextAt = now + g * 1000;
    trace(st, { at: now, H, phase, gapSec: g, outcome: 'noop' });
    return;
  }
  const ev = planOnce(st, w, b, out, players, mons, minTier !== undefined ? { minTier } : {});
  if (ev) {
    if (due || minTier === undefined) {
      const g = drawGapSec(b, H, phase, st.rng.next());
      st.nextAt = now + g * 1000;
      trace(st, { at: now, H, phase, gapSec: g, outcome: 'event', kind: ev.kind });
    } else trace(st, { at: now, H, phase, gapSec: 0, outcome: 'event', kind: ev.kind });
    return;
  }
  st.stats.failed++;
  if (due) st.nextAt = now + b.retrySec * 1000;
  // a pending guarantee retries every 2 s (not every check)
  if (minTier !== undefined) st.forceAt = now + 2000;
  trace(st, { at: now, H, phase, gapSec: due ? b.retrySec : 0, outcome: 'fail' });
}

// ---------------------------------------------------------------- requests

/** client paranormal.seen: rate-limited (10/s), validated; the first witness of a writing reveals it */
export function seenPara(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, pid: string, id: number, end: boolean): boolean {
  const now = w.now();
  const bk = st.buckets.get(pid) ?? { tokens: b.seenPerSec, at: now };
  bk.tokens = Math.min(b.seenPerSec, bk.tokens + ((now - bk.at) / 1000) * b.seenPerSec);
  bk.at = now;
  st.buckets.set(pid, bk);
  if (bk.tokens < 1) return false;
  bk.tokens -= 1;
  const a = st.active.get(id);
  if (!a) return false;
  const ev = a.ev;
  if (ev.to && !ev.to.includes(pid)) return false;
  if (now < ev.at - 150) return false;
  const p = w.players().find((q) => q.id === pid);
  if (!p || !p.alive) return false;
  if (ev.kind === 'mirror_figure') {
    const ids = (ev.data?.mirrors as string[] | undefined) ?? [];
    const ms = w.mirrors().filter((m) => ids.includes(m.id));
    if (!ms.some((m) => dist2(m.x, m.z, p.x, p.z) <= b.figure.lookM + 3)) return false;
  } else if (ev.kind === 'footprints') {
    const pts = (ev.data?.pts as number[][] | undefined) ?? [];
    if (!pts.some((q) => dist2(q[0], q[1], p.x, p.z) <= b.witnessM)) return false;
  } else if (ev.kind === 'dark_walk') {
    const lights = new Set((ev.data?.lights as string[] | undefined) ?? []);
    const fx = [...fixturesBySpace(w.layout).values()].flat().filter((f) => lights.has(f.id));
    if (!fx.some((f) => dist2(f.x, f.z, p.x, p.z) <= b.witnessM)) return false;
  } else if (ev.p && dist2(ev.p[0], ev.p[2], p.x, p.z) > b.witnessM) return false;
  addWitness(a, pid);
  if (ev.kind === 'mirror_writing' && a.armed) {
    a.armed = false;
    const at = now + b.writing.revealLeadMs;
    if (ev.data) ev.data.revealAt = at;
    out.reveal(id, at, ev.to);
    a.endAt = at + b.writing.revealMs + 500;
  }
  if (end && (ev.kind === 'presence' || ev.kind === 'silhouette' || ev.kind === 'mirror_figure')) finish(st, w, b, out, a, 'seen');
  return true;
}

/** residue + active for one player (filtered by `to`) */
export function syncPara(st: CrewPara | null, pid: string): { residue: ParanormalEvent[]; active: ParanormalEvent[] } {
  if (!st) return { residue: [], active: [] };
  const vis = (ev: ParanormalEvent) => !ev.to || ev.to.includes(pid);
  const copy = (ev: ParanormalEvent): ParanormalEvent => ({ ...ev, data: ev.data ? { ...ev.data } : undefined });
  return {
    residue: [...st.residue.values()].filter(vis).map(copy),
    active: [...st.active.values()].map((a) => a.ev).filter(vis).map(copy),
  };
}

/** end everything (phase / layout change, module disabled) */
export function resetPara(st: CrewPara, w: ParaWorld | null, b: ParaBalance, out: ParaOut): void {
  for (const a of [...st.active.values()]) {
    st.active.delete(a.ev.id);
    out.end(a.ev.id, 'interrupted', a.ev.to);
    st.records.push(a.rec);
    out.phenomenon(a.rec);
  }
  void w;
  void b;
  st.residue.clear();
  st.dark.clear();
}

/** a player left for good */
export function leavePara(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, pid: string): void {
  st.perPlayer.delete(pid);
  st.mirrorGuard.delete(pid);
  st.buckets.delete(pid);
  for (const a of [...st.active.values()]) {
    if (a.ev.to && a.ev.to.length === 1 && a.ev.to[0] === pid) finish(st, w, b, out, a, 'interrupted');
  }
}

/** dbg / triggerPhenomenon: one kind now (force skips budgets, novelty, spacing, blocks and the soft gates) */
export function firePara(st: CrewPara, w: ParaWorld, b: ParaBalance, out: ParaOut, kind: ParanormalKind, o: { target?: string; force?: boolean; patch?: ParanormalData } = {}): ParanormalEvent | null {
  const players = w.players();
  const mons = activeMonsters(w);
  const now = w.now();
  if (!o.force) {
    const why = blockedWhy(st, w, b, now, players, mons);
    if (why) { st.stats.why = why; return null; }
    const d = KIND_BY_NAME.get(kind);
    if (!d || !budgetLeft(st, b, d) || !kindEnabled(b, d)) return null;
  }
  return planOnce(st, w, b, out, players, mons, { kind, force: !!o.force, target: o.target, patch: o.patch });
}

export function hauntDebug(st: CrewPara, w: ParaWorld, b: ParaBalance): Record<string, unknown> {
  const H = hauntOf(st, w, b);
  const phase = directorPhase(w);
  return {
    H: Math.round(H * 1000) / 1000, cap: tierCap(b, H, phase), phase, clockMin: Math.round(clockMinOf(st, w) * 10) / 10,
    tensionEma: Math.round(st.tensionEma * 1000) / 1000, nextInSec: Math.round((st.nextAt - w.now()) / 100) / 10,
    used: st.used, recent: st.recent, t1: st.t1Done, t2: st.t2Done, quietUntil: st.quietUntil,
    active: [...st.active.values()].map((a) => ({ id: a.ev.id, kind: a.ev.kind, tier: a.ev.tier, armed: a.armed, witnesses: a.rec.witnesses })),
    residue: [...st.residue.values()].map((e) => ({ id: e.id, kind: e.kind })),
    dark: [...st.dark.values()].map((d) => ({ space: d.space, reviveIn: Number.isFinite(d.reviveAt) ? Math.round((d.reviveAt - w.now()) / 1000) : null, switch: d.needsSwitch })),
    stats: st.stats,
  };
}
