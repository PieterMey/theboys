// Owner: env-paranormal (v1.2). Phenomenon builders: each picks a target, a place and its data (server-authoritative,
// seeded by the crew rng), or returns null when nothing fits the gates. Pure over ParaWorld (tests run them on
// simulated crews). Never: strobes, walkies, intercoms, vents, ceiling scratching, the scrape loop, breath/whisper.
import { astar, cellOf, floodCells, los, walkClear } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import { PARANORMAL_PHRASES, safeMirrorName } from '@dead-air/shared/messages/paranormal.ts';
import type { ParanormalKind } from '@dead-air/shared/messages/paranormal.ts';
import type { MirrorSpot } from '@dead-air/shared/procgen/mirrors.ts';
import {
  activeMonsters, angleTo, anyoneLooking, betweenPlayerAndMonster, darkAt, dist2, doorCenter, doorNormal, fixturesBySpace, glowing,
  grateClear, hiddenSpaces, indoor, inDoorway, isLone, itemById, mannequinClear, monsterClear, nearVan, spaceAtXZ,
} from './gates.ts';
import type { Fixture } from './gates.ts';
import type { BuildCtx, Built, ParaGroup, ParaMonster, ParaPlayer, Tier } from './types.ts';

export interface KindDef {
  kind: ParanormalKind;
  group: ParaGroup;
  /** lowest tier this kind can run at */
  tier: Tier;
  /** highest tier variant */
  maxTier: Tier;
  /** the tier a guarantee can rely on (knock's T1 variant is random, presence's T2 is sure when the cap allows) */
  reaches: Tier;
  /** SHOULD kinds can be switched off in balance.kinds */
  should: boolean;
  build(c: BuildCtx, t: Targets): Built | null;
}

/** eligible targets (spacing respected unless forced), least recently targeted first */
export interface Targets { list: ParaPlayer[]; all: ParaPlayer[]; mons: ParaMonster[] }

const PI = Math.PI;
const between = (c: BuildCtx, lo: number, hi: number): number => lo + (hi - lo) * c.st.rng.next();
const yawTo = (fx: number, fz: number, tx: number, tz: number): number => Math.atan2(tx - fx, tz - fz);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** point (x, z) inside a static solid collision box (+pad) */
export function inSolid(g: EdgeGrid, x: number, z: number, pad = 0.25): boolean {
  const c = cellOf(g, x, z);
  for (let i = g.solidStart[c]; i < g.solidStart[c + 1]; i++) {
    const k = g.solidIdx[i] * 4;
    if (x > g.solids[k] - pad && x < g.solids[k + 2] + pad && z > g.solids[k + 1] - pad && z < g.solids[k + 3] + pad) return true;
  }
  return false;
}

/** shared soft gates: inside the building, away from the van, monsters and (lurking) Snatcher grates */
function placeOk(c: BuildCtx, t: Targets, x: number, z: number): boolean {
  const L = c.w.layout;
  const s = spaceAtXZ(L, x, z);
  if (s < 0 || !indoor(L, s)) return false;
  if (nearVan(L, x, z, c.b.gates.vanM)) return false;
  if (!monsterClear(t.mons, x, z, c.b.gates.monsterM)) return false;
  if (!grateClear(c.w, x, z, c.b.gates.grateM)) return false;
  return true;
}

/**
 * try targets in a seeded order (least recently targeted first, rotated by the rng) until fn finds a placement.
 * c.target pins one player.
 */
function eachTarget(c: BuildCtx, t: Targets, pred: (p: ParaPlayer) => boolean, fn: (p: ParaPlayer) => Built | null, max = 4): Built | null {
  if (c.target) {
    const p = t.list.find((q) => q.id === c.target) ?? (c.force ? t.all.find((q) => q.id === c.target && q.alive) : undefined);
    return p && pred(p) ? fn(p) : null;
  }
  const ok = t.list.filter(pred);
  if (!ok.length) return null;
  const start = Math.floor(c.st.rng.next() * Math.min(ok.length, 2));
  const n = Math.min(max, ok.length);
  for (let i = 0; i < n; i++) {
    const r = fn(ok[(start + i) % ok.length]);
    if (r) return r;
  }
  return null;
}

const playerSpace = (c: BuildCtx, p: ParaPlayer): number => spaceAtXZ(c.w.layout, p.x, p.z);
const inIndoor = (c: BuildCtx) => (p: ParaPlayer): boolean => indoor(c.w.layout, playerSpace(c, p));

// ---------------------------------------------------------------- dark walk

function darkWalkFor(c: BuildCtx, t: Targets, target: ParaPlayer, tell: boolean): Built | null {
  const { w, st, b } = c;
  const dw = b.darkWalk;
  const g = w.grid;
  const L = w.layout;
  const field = floodCells(g, [cellOf(g, target.x, target.z)], { mode: 'walk', doorOpen: w.doorOpen, budget: dw.maxM + 1 });
  const cands: number[] = [];
  for (let i = 0; i < field.length; i++) {
    const d = field[i];
    if (!(d >= dw.minM && d <= dw.maxM)) continue;
    const s = g.owner[i];
    if (s < 0 || !indoor(L, s) || !w.lightsOn(s)) continue;
    cands.push(i);
  }
  if (!cands.length) return null;
  const bySpace = fixturesBySpace(L);
  for (let attempt = 0; attempt < 8 && cands.length; attempt++) {
    const k = Math.floor(st.rng.next() * cands.length);
    const start = cands[k];
    cands.splice(k, 1);
    const sx = (start % g.W) + 0.5, sz = Math.floor(start / g.W) + 0.5;
    const path = astar(g, sx, sz, target.x, target.z, { mode: 'walk', doorOpen: w.doorOpen, maxCost: dw.maxM + 4 });
    if (!path || path.cost < dw.minM - 0.5) continue;
    const pts: [number, number][] = path.cells.map((cell) => [(cell % g.W) + 0.5, Math.floor(cell / g.W) + 0.5]);
    // spaces in path order; every one indoor
    const spaces: number[] = [];
    let bad = false;
    for (const cell of path.cells) {
      const s = g.owner[cell];
      if (s < 0 || !indoor(L, s)) { bad = true; break; }
      if (!spaces.includes(s)) spaces.push(s);
    }
    if (bad || spaces.length > dw.maxSpaces) continue;
    // gates along the path (monsters 6 m, grates)
    let gated = false;
    for (let i = 0; i < pts.length; i += 2) {
      const [x, z] = pts[i];
      if (!c.force && (!monsterClear(t.mons, x, z, b.gates.monsterM) || !grateClear(w, x, z, b.gates.grateM))) { gated = true; break; }
    }
    if (gated) continue;
    // arc length along the path; every glowing fixture of every lit space it enters
    const arc: number[] = [0];
    for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + dist2(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    const fx: { f: Fixture; a: number }[] = [];
    for (const s of spaces) {
      if (!w.lightsOn(s)) continue; // an unpowered / switched-off space is already dark
      for (const f of bySpace.get(s) ?? []) {
        if (!glowing(f)) continue;
        let best = Infinity, ba = 0;
        for (let i = 0; i < pts.length; i++) {
          const d = dist2(pts[i][0], pts[i][1], f.x, f.z);
          if (d < best) { best = d; ba = arc[i]; }
        }
        fx.push({ f, a: ba + best * 0.15 });
      }
    }
    if (fx.length < dw.minFixtures) continue;
    // a Mannequin moves while unlit: no light kills within 25 m of an active one
    if (!c.force && !fx.every((q) => mannequinClear(t.mons, q.f.x, q.f.z, b.gates.mannequinLightM))) continue;
    fx.sort((p, q) => p.a - q.a || (p.f.id < q.f.id ? -1 : 1));
    const stepMs = Math.round(between(c, dw.stepMinMs, dw.stepMaxMs));
    // each space goes dark when its own last fixture dies: kill order = order of those last deaths
    const kills: { s: number; at: number }[] = [];
    for (const s of spaces) {
      let last = -1;
      for (let i = 0; i < fx.length; i++) if (fx[i].f.space === s) last = i;
      if (last >= 0) kills.push({ s, at: last * stepMs + dw.dieMs });
    }
    kills.sort((p, q) => p.at - q.at);
    const killSpaces = kills.map((q) => q.s);
    const killAt = kills.map((q) => q.at);
    const ms = (fx.length - 1) * stepMs + dw.dieMs + 300;
    // T2 (build phase, high haunt): when it reaches the target, their beam stutters too
    const tier: Tier = c.tierCap >= 2 ? 2 : 1;
    return {
      kind: 'dark_walk', tier, target: target.id, tell,
      ev: {
        ms, space: -1, p: [r2(sx), 0, r2(sz)], yaw: r2(yawTo(sx, sz, target.x, target.z)), persist: true,
        data: { lights: fx.map((q) => q.f.id), stepMs, dieMs: dw.dieMs, spaces: killSpaces, killAt, dead: [], target: target.id, interf: tier === 2 },
      },
      kills: killSpaces.map((s, i) => ({ space: s, at: killAt[i] })),
    };
  }
  return null;
}

function buildDarkWalk(c: BuildCtx, t: Targets): Built | null {
  const { w, st, b, now } = c;
  const dw = b.darkWalk;
  if (!c.force && now < st.lastDarkWalkAt + dw.gapSec * 1000) return null;
  if (w.blackout()) return null;
  // never toward a Core carrier or the van
  const okP = (p: ParaPlayer) => !p.core && inIndoor(c)(p) && !nearVan(w.layout, p.x, p.z, 12);
  // the player the Listener is stalking (a valid stalk decision < 60 s old), 70% of the time
  if (!c.target && b.tells.stalk && st.stalk && now - st.stalk.at < dw.stalkSec * 1000 && st.rng.chance(dw.stalkChance)) {
    const sp = st.stalk.pid;
    const p = t.list.find((q) => q.id === sp && okP(q));
    const r = p ? darkWalkFor(c, t, p, true) : null;
    if (r) return r;
  }
  // else a lone player
  return eachTarget(c, t, (p) => okP(p) && (c.force || isLone(t.all, p.id, dw.loneM)), (p) => darkWalkFor(c, t, p, false), 3);
}

// ---------------------------------------------------------------- mirrors

function mirrorsFor(c: BuildCtx): MirrorSpot[] {
  return c.w.mirrors().filter((m) => m.kind !== 'van' && indoor(c.w.layout, m.space));
}

function writtenMirrors(c: BuildCtx): Set<string> {
  const out = new Set<string>();
  for (const a of c.st.active.values()) if (a.ev.kind === 'mirror_writing' && a.ev.ref) out.add(a.ev.ref);
  for (const ev of c.st.residue.values()) if (ev.kind === 'mirror_writing' && ev.ref) out.add(ev.ref);
  return out;
}

/** the writing: the Listener's last valid investigate/ambush callsign (< 90 s), else a lone player's name, else a phrase */
export function writingText(c: BuildCtx, t: Targets): { text: string; tell: boolean } {
  const { st, b, now } = c;
  if (b.tells.intercept && st.room && now - st.room.at < b.writing.roomSec * 1000 && st.room.callsign) {
    return { text: st.room.callsign.toUpperCase(), tell: true };
  }
  // v1.3 P1d: only a name names.ts passes, in its mirror form too (safeMirrorName); else the phrase below
  const lone = t.all.filter((p) => p.alive && !p.inVan && isLone(t.all, p.id, b.darkWalk.loneM) && safeMirrorName(p.name, p.id)).sort((p, q) => (p.id < q.id ? -1 : 1));
  if (lone.length) {
    const p = lone[Math.floor(st.rng.next() * lone.length)];
    return { text: safeMirrorName(p.name, p.id), tell: false };
  }
  return { text: PARANORMAL_PHRASES[Math.floor(st.rng.next() * PARANORMAL_PHRASES.length)], tell: false };
}

function buildWriting(c: BuildCtx, t: Targets): Built | null {
  const { w, b } = c;
  const all = mirrorsFor(c);
  if (!all.length) return null;
  const used = writtenMirrors(c);
  return eachTarget(c, t, (p) => inIndoor(c)(p) && all.some((m) => dist2(m.x, m.z, p.x, p.z) <= b.writing.nearM), (target) => {
    // on a mirror within 8 m that nobody is looking at
    const cands = all.filter((m) => !used.has(m.id) && dist2(m.x, m.z, target.x, target.z) <= b.writing.nearM
      && (c.force || placeOk(c, t, m.x, m.z)) && !anyoneLooking(w, t.all, m.x, m.z, b.writing.lookM, b.writing.lookDeg));
    if (!cands.length) return null;
    const m = cands[Math.floor(c.st.rng.next() * cands.length)];
    const { text, tell } = writingText(c, t);
    return {
      kind: 'mirror_writing', tier: 1, target: target.id, tell, armed: true, activeMs: b.writing.maxArmSec * 1000,
      ev: {
        ms: b.writing.fogMs, space: m.space, p: [m.x, m.y, m.z], yaw: m.rot, ref: m.id, persist: true,
        data: { mirror: m.id, text, fog: b.writing.fog, fogMs: b.writing.fogMs, revealMs: b.writing.revealMs, w: m.w, h: m.h },
      },
    };
  });
}

function figureFor(c: BuildCtx, t: Targets, target: ParaPlayer, all: MirrorSpot[]): Built | null {
  const { b } = c;
  // one armed figure per player
  for (const a of c.st.active.values()) if (a.ev.kind === 'mirror_figure' && a.ev.to?.includes(target.id)) return null;
  const near = all.filter((m) => dist2(m.x, m.z, target.x, target.z) <= b.figure.nearM && (c.force || placeOk(c, t, m.x, m.z)))
    .sort((p, q) => dist2(p.x, p.z, target.x, target.z) - dist2(q.x, q.z, target.x, target.z));
  if (!near.length) return null;
  const m0 = near[0];
  return {
    kind: 'mirror_figure', tier: 2, target: target.id, activeMs: b.figure.armSec * 1000,
    ev: {
      ms: b.figure.armSec * 1000, space: m0.space, p: [m0.x, m0.y, m0.z], yaw: m0.rot, ref: m0.id, to: [target.id],
      data: {
        mirrors: near.map((m) => m.id), behind: r2(between(c, b.figure.behindMin, b.figure.behindMax)), side: r2(between(c, -0.25, 0.25)),
        holdMs: b.figure.holdMs, nearM: b.figure.lookM,
      },
    },
  };
}

function buildFigure(c: BuildCtx, t: Targets): Built | null {
  const all = mirrorsFor(c);
  if (!all.length) return null;
  return eachTarget(c, t, (p) => !p.core && inIndoor(c)(p) && all.some((m) => dist2(m.x, m.z, p.x, p.z) <= c.b.figure.nearM),
    (p) => figureFor(c, t, p, all));
}

// ---------------------------------------------------------------- presence + silhouette

function presenceFor(c: BuildCtx, t: Targets, target: ParaPlayer): Built | null {
  const { w, b, st } = c;
  const pr = b.presence;
  const fx = Math.sin(target.yaw), fz = Math.cos(target.yaw);
  for (let attempt = 0; attempt < 10; attempt++) {
    const d = between(c, pr.aheadMin, pr.aheadMax);
    const lat = between(c, -1.4, 1.4);
    const x = Math.floor(target.x + fx * d + fz * lat) + 0.5;
    const z = Math.floor(target.z + fz * d - fx * lat) + 0.5;
    const dd = dist2(x, z, target.x, target.z);
    if (dd < pr.aheadMin - 0.5 || dd > pr.aheadMax + 0.8) continue;
    if (!placeOk(c, t, x, z)) continue;
    // never in a doorway or between a player and a monster; in the dark; in plain sight of the target
    if (inDoorway(w.layout, x, z) || inSolid(w.grid, x, z)) continue;
    if (!darkAt(w, x, z, pr.darkFixtureM)) continue;
    if (!los(w.grid, target.x, target.z, x, z, w.doorOpen)) continue;
    if (betweenPlayerAndMonster(t.all, t.mons, x, z, pr.laneM)) continue;
    const tier: Tier = c.tierCap >= 2 && !target.core ? 2 : 1;
    const ms = Math.round(between(c, pr.msMin, pr.msMax));
    const approachM = r2(Math.max(1.5, Math.min(pr.approachM, dd - 1.5)));
    return {
      kind: 'presence', tier, target: target.id,
      ev: {
        ms, space: spaceAtXZ(w.layout, x, z), p: [x, 0, z], yaw: r2(yawTo(x, z, target.x, target.z)),
        data: { interf: tier === 2, litM: pr.litM, litMs: Math.round(pr.litSec * 1000), approachM, variant: st.rng.int(0, 2) },
      },
    };
  }
  return null;
}

function buildPresence(c: BuildCtx, t: Targets): Built | null {
  return eachTarget(c, t, inIndoor(c), (p) => presenceFor(c, t, p));
}

/**
 * silhouette: a pitch-dark figure at the far end of a corridor (8-22 m ahead, inside the view cone), backlit by a
 * glowing fixture of a lit space at that end (the corridor's own end light, or the lit room / corridor through the
 * opening it stands in). That backlit space browns out when it vanishes. Corridor ends, not doorways: this generator
 * puts corridor -> room doors in the corridors' side walls (no sightline into a room beyond ~4 m).
 */
function silhouetteFor(c: BuildCtx, t: Targets, target: ParaPlayer): Built | null {
  const { w, b } = c;
  const si = b.silhouette;
  const L = w.layout;
  const cone = (si.coneDeg * PI) / 180;
  const bySpace = fixturesBySpace(L);
  const opts: { x: number; z: number; room: number; end: number; d: number }[] = [];
  const R = Math.ceil(si.maxM);
  const tx0 = Math.floor(target.x), tz0 = Math.floor(target.z);
  const lit = new Map<number, boolean>();
  const litSpace = (s: number): boolean => {
    let v = lit.get(s);
    if (v === undefined) { v = s >= 0 && indoor(L, s) && w.lightsOn(s); lit.set(s, v); }
    return v;
  };
  for (let cz = Math.max(0, tz0 - R); cz <= Math.min(L.H - 1, tz0 + R); cz++) {
    for (let cx = Math.max(0, tx0 - R); cx <= Math.min(L.W - 1, tx0 + R); cx++) {
      const s = L.owner[cz * L.W + cx];
      if (s < 0 || L.spaces[s]?.kind !== 'corridor' || !indoor(L, s)) continue;
      const x = cx + 0.5, z = cz + 0.5;
      const dd = dist2(x, z, target.x, target.z);
      if (dd < si.minM || dd > si.maxM || angleTo(target, x, z) > cone) continue;
      // the corridor ends here along the view: the next cell along the dominant axis is not this corridor
      const alongX = Math.abs(x - target.x) >= Math.abs(z - target.z);
      const nx = alongX ? cx + Math.sign(x - target.x) : cx, nz = alongX ? cz : cz + Math.sign(z - target.z);
      const next = nx < 0 || nz < 0 || nx >= L.W || nz >= L.H ? -1 : L.owner[nz * L.W + nx];
      if (next === s) continue;
      // backlight: the nearest glowing fixture of a lit space (this corridor or the one beyond) within backM that is
      // not nearer the viewer than the figure (it would light the face, not the outline)
      let room = -1, best = Infinity;
      // the space beyond only counts through an opening (an open door / a gap), never through the end wall; a DARK
      // opening behind it swallows the outline (no contrast): skip those ends
      const open = next >= 0 && los(w.grid, x, z, nx + 0.5, nz + 0.5, w.doorOpen);
      if (open && !litSpace(next)) continue;
      const beyond = open;
      for (const sid of beyond ? [s, next] : [s]) {
        if (!litSpace(sid)) continue;
        for (const f of bySpace.get(sid) ?? []) {
          if (!glowing(f)) continue;
          const fd = dist2(f.x, f.z, x, z);
          if (fd > si.backM || fd >= best) continue;
          if (dist2(f.x, f.z, target.x, target.z) < dd - 0.75) continue;
          best = fd;
          room = sid;
        }
      }
      if (room >= 0) opts.push({ x, z, room, end: next, d: dd });
    }
  }
  // seeded pick, biased to the nearer half (a 20 m figure is a few pixels); the expensive checks only on the picks
  opts.sort((p, q) => p.d - q.d || p.z - q.z || p.x - q.x);
  for (let tries = 0; tries < 24 && opts.length; tries++) {
    const k = Math.floor(c.st.rng.next() * Math.min(opts.length, Math.max(4, Math.ceil(opts.length / 2))));
    const o = opts[k];
    opts.splice(k, 1);
    if (!los(w.grid, target.x, target.z, o.x, o.z, w.doorOpen)) continue;
    if (!placeOk(c, t, o.x, o.z) || inSolid(w.grid, o.x, o.z, 0.1)) continue;
    // the backlit space browns out when it vanishes: a light effect, so the Mannequin gate applies
    if (!c.force && !mannequinClear(t.mons, o.x, o.z, b.gates.mannequinLightM)) continue;
    if (betweenPlayerAndMonster(t.all, t.mons, o.x, o.z, b.presence.laneM)) continue;
    const ms = Math.round(between(c, si.msMin, si.msMax));
    return {
      kind: 'silhouette', tier: 1, target: target.id,
      ev: {
        ms, space: spaceAtXZ(L, o.x, o.z), p: [r2(o.x), 0, r2(o.z)], yaw: r2(yawTo(o.x, o.z, target.x, target.z)),
        data: { room: o.room, end: o.end, brownMs: si.brownMs, depth: si.depth, approachM: si.approachM },
      },
    };
  }
  return null;
}

function buildSilhouette(c: BuildCtx, t: Targets): Built | null {
  return eachTarget(c, t, inIndoor(c), (p) => silhouetteFor(c, t, p), 6);
}

// ---------------------------------------------------------------- knocks

const KNOCK_DOORS = new Set(['door', 'fire', 'security', 'locked']);

function knockFor(c: BuildCtx, t: Targets, target: ParaPlayer, rattle: boolean): Built | null {
  const { w, b } = c;
  const kb = b.knock;
  const L = w.layout;
  // never on doors (or lockers) a hidden player is behind
  const hidden = hiddenSpaces(w, t.all);
  const hiddenIds = new Set(t.all.map((p) => p.hidden).filter((h): h is string => !!h));
  const tier: Tier = !rattle && c.tierCap >= 1 && !target.core && c.st.rng.chance(0.5) ? 1 : 0;
  // a locker nobody hides in
  if (!rattle && c.st.rng.chance(kb.lockerChance)) {
    const lockers = L.items.filter((i) => i.kind === 'hiding' && !hiddenIds.has(i.id) && !hidden.has(i.space)
      && dist2(i.x, i.z, target.x, target.z) >= 2 && dist2(i.x, i.z, target.x, target.z) <= 7 && placeOk(c, t, i.x, i.z));
    if (lockers.length) {
      const it = lockers[Math.floor(c.st.rng.next() * lockers.length)];
      return {
        kind: 'knock', tier, target: target.id,
        ev: {
          ms: Math.round(between(c, kb.msMin, kb.msMax)), space: it.space, p: [it.x, 1.1, it.z], yaw: it.rot ?? 0, ref: it.id,
          data: { door: -1, pattern: 'locker', count: tier ? c.st.rng.int(4, 6) : c.st.rng.int(2, 3), amp: r2(between(c, 0.55, 0.9)), rattle: false },
        },
      };
    }
  }
  const opts: { id: number; x: number; z: number; space: number; kind: string }[] = [];
  for (const d of L.doors) {
    if (!KNOCK_DOORS.has(d.kind) || d.a < 0 || d.b < 0) continue;
    if (w.doorOpen(d.id)) continue;
    if (hidden.has(d.a) || hidden.has(d.b)) continue;
    if (!indoor(L, d.a) || !indoor(L, d.b)) continue;
    const [cx, cz] = doorCenter(d);
    const dd = dist2(cx, cz, target.x, target.z);
    if (dd < kb.minM || dd > kb.maxM) continue;
    // on the far side, 0.3 m beyond the leaf
    const [nx, nz] = doorNormal(d);
    const side = (target.x - cx) * nx + (target.z - cz) * nz >= 0 ? 1 : -1;
    const x = cx - nx * side * kb.beyondM, z = cz - nz * side * kb.beyondM;
    const far = spaceAtXZ(L, cx - nx * side * 0.6, cz - nz * side * 0.6);
    if (far < 0) continue;
    if (!c.force && (!monsterClear(t.mons, x, z, b.gates.monsterM) || !grateClear(w, x, z, b.gates.grateM))) continue;
    opts.push({ id: d.id, x, z, space: far, kind: d.kind });
  }
  if (!opts.length) return null;
  const o = opts[Math.floor(c.st.rng.next() * opts.length)];
  const pattern = o.kind === 'door' ? 'wood' : 'metal';
  return {
    kind: rattle ? 'handle_rattle' : 'knock', tier: rattle ? 0 : tier, target: target.id,
    ev: {
      ms: Math.round(between(c, kb.msMin, kb.msMax)), space: o.space, p: [r2(o.x), 1.15, r2(o.z)], yaw: 0, ref: `door:${o.id}`,
      data: {
        door: o.id, pattern, count: rattle ? 1 : tier ? c.st.rng.int(4, 6) : c.st.rng.int(2, 3), amp: r2(between(c, 0.5, rattle ? 0.7 : 1)),
        rattle: rattle || tier === 1,
      },
    },
  };
}

function buildKnock(c: BuildCtx, t: Targets, rattle: boolean): Built | null {
  return eachTarget(c, t, inIndoor(c), (p) => knockFor(c, t, p, rattle));
}

// ---------------------------------------------------------------- props (poltergeist / falls)

function movedRefs(c: BuildCtx): Set<string> {
  const out = new Set<string>();
  for (const a of c.st.active.values()) if (a.ev.ref && (a.ev.kind === 'poltergeist' || a.ev.kind === 'object_fall')) out.add(a.ev.ref);
  for (const ev of c.st.residue.values()) if (ev.ref && (ev.kind === 'poltergeist' || ev.kind === 'object_fall')) out.add(ev.ref);
  return out;
}

function propFor(c: BuildCtx, t: Targets, target: ParaPlayer, fall: boolean): Built | null {
  const { w, b } = c;
  const pb = b.props;
  const L = w.layout;
  const moved = movedRefs(c);
  // movableRefsOf candidates only (never solids)
  const cands = w.movables().filter((m) => !moved.has(m.ref) && indoor(L, m.space) && dist2(m.x, m.z, target.x, target.z) >= pb.minM
    && dist2(m.x, m.z, target.x, target.z) <= pb.maxM && (fall ? true : m.y < 0.3) && placeOk(c, t, m.x, m.z)
    && los(w.grid, target.x, target.z, m.x, m.z, w.doorOpen));
  if (!cands.length) return null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const m = cands[Math.floor(c.st.rng.next() * cands.length)];
    const a = between(c, 0, 2 * PI);
    const dx = Math.sin(a), dz = Math.cos(a);
    if (!fall) {
      const len = between(c, pb.slideMin, pb.slideMax);
      const ex = m.x + dx * len, ez = m.z + dz * len;
      if (spaceAtXZ(L, ex, ez) !== m.space || !walkClear(w.grid, m.x, m.z, ex, ez, w.doorOpen) || inSolid(w.grid, ex, ez, 0.05)) continue;
      const rot = m.rot + between(c, -0.5, 0.5);
      return {
        kind: 'poltergeist', tier: 0, target: target.id,
        ev: {
          ms: Math.round(between(c, pb.msMin, pb.msMax)), space: m.space, p: [r2(m.x), r2(m.y), r2(m.z)], yaw: r2(m.rot), ref: m.ref, persist: true,
          data: { key: m.key, from: [r2(m.x), r2(m.y), r2(m.z), r2(m.rot)], to: [r2(ex), r2(m.y), r2(ez), r2(rot)] },
        },
      };
    }
    const len = m.y > 0.35 ? between(c, 0.3, 0.6) : between(c, 0.08, 0.25);
    const ex = m.x + dx * len, ez = m.z + dz * len;
    if (spaceAtXZ(L, ex, ez) !== m.space || inSolid(w.grid, ex, ez, 0.02)) continue;
    const angle = (PI / 2) * between(c, 0.85, 1);
    return {
      kind: 'object_fall', tier: 0, target: target.id,
      ev: {
        ms: Math.round(between(c, pb.msMin, pb.msMax)), space: m.space, p: [r2(m.x), r2(m.y), r2(m.z)], yaw: r2(m.rot), ref: m.ref, persist: true,
        data: {
          key: m.key, from: [r2(m.x), r2(m.y), r2(m.z), r2(m.rot)], to: [r2(ex), r2(ez), r2(m.rot + between(c, -0.6, 0.6))],
          // the object tips over around the horizontal axis perpendicular to its push
          tilt: [r2(dz), r2(-dx)], angle: r2(angle),
        },
      },
    };
  }
  return null;
}

function buildProp(c: BuildCtx, t: Targets, fall: boolean): Built | null {
  if (!c.w.movables().length) return null;
  return eachTarget(c, t, inIndoor(c), (p) => propFor(c, t, p, fall), 3);
}

// ---------------------------------------------------------------- footprints

function resample(pts: [number, number][], stride: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  if (pts.length < 2) return out;
  let carry = 0;
  let side = 1;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const seg = dist2(ax, az, bx, bz);
    if (seg < 1e-6) continue;
    const ux = (bx - ax) / seg, uz = (bz - az) / seg;
    let s = carry;
    while (s <= seg) {
      const x = ax + ux * s, z = az + uz * s;
      // alternate left / right foot, 0.11 m off the walk line
      out.push([r2(x + uz * 0.11 * side), r2(z - ux * 0.11 * side), r2(Math.atan2(ux, uz))]);
      side = -side;
      s += stride;
    }
    carry = s - seg;
  }
  return out;
}

/** cheap smoothing of a cell path (keeps prints off cell corners) */
function smooth(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) out.push([(pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4]);
  out.push(pts[pts.length - 1]);
  return out;
}

function footprintsFor(c: BuildCtx, t: Targets, target: ParaPlayer): Built | null {
  const { w, b, st } = c;
  const fb = b.footprints;
  const L = w.layout;
  const g = w.grid;
  const spots = st.loreTargets.length ? w.loreSpots().filter((s) => st.loreTargets.includes(s.id) && indoor(L, s.space)) : [];
  let from: [number, number];
  let to: [number, number];
  let toLore = false;
  if (spots.length && st.rng.chance(fb.loreChance)) {
    // A* from just ahead of the player to the nearest page (setLoreTargets)
    const spot = spots.slice().sort((p, q) => dist2(p.x, p.z, target.x, target.z) - dist2(q.x, q.z, target.x, target.z))[0];
    const fx = Math.sin(target.yaw), fz = Math.cos(target.yaw);
    const ax = target.x + fx * 1.6, az = target.z + fz * 1.6;
    from = spaceAtXZ(L, ax, az) >= 0 && los(g, target.x, target.z, ax, az, w.doorOpen) ? [ax, az] : [target.x, target.z];
    to = [spot.p?.[0] ?? spot.x, spot.p?.[2] ?? spot.z];
    toLore = true;
  } else {
    // A* from 9-15 m away toward the target: something walked up to you
    const field = floodCells(g, [cellOf(g, target.x, target.z)], { mode: 'walk', doorOpen: w.doorOpen, budget: fb.fromMaxM + 1 });
    const cands: number[] = [];
    for (let i = 0; i < field.length; i++) {
      const d = field[i];
      if (!(d >= fb.fromMinM && d <= fb.fromMaxM)) continue;
      const s = g.owner[i];
      if (s < 0 || !indoor(L, s)) continue;
      cands.push(i);
    }
    if (!cands.length) return null;
    const k = cands[Math.floor(st.rng.next() * cands.length)];
    from = [(k % g.W) + 0.5, Math.floor(k / g.W) + 0.5];
    to = [target.x, target.z];
  }
  const path = astar(g, from[0], from[1], to[0], to[1], { mode: 'walk', doorOpen: w.doorOpen, maxCost: 60 });
  if (!path || path.cells.length < 3) return null;
  const cells: [number, number][] = path.cells.map((cell) => [(cell % g.W) + 0.5, Math.floor(cell / g.W) + 0.5]);
  if (toLore) cells[0] = from;
  let pts = resample(smooth(cells), fb.strideM);
  // stop short of the player (toward mode) / of the page
  const stopM = toLore ? 0.6 : 1.4;
  pts = pts.filter((q) => dist2(q[0], q[1], to[0], to[1]) > stopM);
  if (pts.length > fb.maxPrints) pts = toLore ? pts.slice(0, fb.maxPrints) : pts.slice(pts.length - fb.maxPrints);
  if (pts.length < 4) return null;
  for (const q of pts) {
    const s = spaceAtXZ(L, q[0], q[1]);
    if (s < 0 || !indoor(L, s)) return null;
  }
  for (const q of pts) {
    if (!c.force && (!monsterClear(t.mons, q[0], q[1], b.gates.monsterM) || !grateClear(w, q[0], q[1], b.gates.grateM))) return null;
  }
  const ms = pts.length * fb.stepMs + 400;
  return {
    kind: 'footprints', tier: 1, target: target.id,
    ev: {
      ms, space: spaceAtXZ(L, pts[0][0], pts[0][1]), p: [pts[0][0], 0, pts[0][1]], persist: true,
      data: { pts, stepMs: fb.stepMs, fadeMs: fb.fadeSec * 1000, toLore },
    },
  };
}

function buildFootprints(c: BuildCtx, t: Targets): Built | null {
  return eachTarget(c, t, inIndoor(c), (p) => footprintsFor(c, t, p), 2);
}

// ---------------------------------------------------------------- cold spot + brownout breath

function coldFor(c: BuildCtx, t: Targets, target: ParaPlayer): Built | null {
  const { w, b, st } = c;
  const cb = b.cold;
  const L = w.layout;
  // ambushCold (signed off false): the cold spot would mark the Listener's ambush room
  if (b.tells.ambushCold && st.room && c.now - st.room.at < b.writing.roomSec * 1000) {
    const s = L.spaces[st.room.space];
    if (s && indoor(L, s.id)) {
      const x = s.rect.x + s.rect.w / 2, z = s.rect.y + s.rect.h / 2;
      if (placeOk(c, t, x, z)) {
        return {
          kind: 'cold_spot', tier: 0, target: target.id, tell: true,
          ev: { ms: Math.round(between(c, cb.msMin, cb.msMax)), space: s.id, p: [r2(x), 0, r2(z)], data: { r: r2(between(c, cb.rMin, cb.rMax)), density: cb.density, frost: 1 } },
        };
      }
    }
  }
  const ts = spaceAtXZ(L, target.x, target.z);
  for (let attempt = 0; attempt < 10; attempt++) {
    const a = between(c, 0, 2 * PI);
    const d = between(c, cb.minM, cb.maxM);
    const x = target.x + Math.sin(a) * d, z = target.z + Math.cos(a) * d;
    const s = spaceAtXZ(L, x, z);
    if (s < 0 || (s !== ts && !los(w.grid, target.x, target.z, x, z, w.doorOpen))) continue;
    if (!placeOk(c, t, x, z) || inSolid(w.grid, x, z, 0.1)) continue;
    return {
      kind: 'cold_spot', tier: 0, target: target.id,
      ev: { ms: Math.round(between(c, cb.msMin, cb.msMax)), space: s, p: [r2(x), 0, r2(z)], data: { r: r2(between(c, cb.rMin, cb.rMax)), density: cb.density, frost: 1 } },
    };
  }
  return null;
}

function buildCold(c: BuildCtx, t: Targets): Built | null {
  return eachTarget(c, t, inIndoor(c), (p) => coldFor(c, t, p), 3);
}

function buildBreath(c: BuildCtx, t: Targets): Built | null {
  const { w, b } = c;
  const L = w.layout;
  return eachTarget(c, t, (p) => {
    const s = spaceAtXZ(L, p.x, p.z);
    return s >= 0 && indoor(L, s) && w.lightsOn(s) && (fixturesBySpace(L).get(s) ?? []).some(glowing);
  }, (target) => {
    if (!placeOk(c, t, target.x, target.z)) return null;
    // a brownout is a light effect: the Mannequin gate applies
    if (!c.force && !mannequinClear(t.mons, target.x, target.z, b.gates.mannequinLightM)) return null;
    const s = spaceAtXZ(L, target.x, target.z);
    return {
      kind: 'brownout_breath', tier: 0, target: target.id,
      ev: { ms: Math.round(between(c, b.breath.msMin, b.breath.msMax)), space: s, p: [r2(target.x), 1.6, r2(target.z)], data: { depth: b.breath.depth, puffs: b.breath.puffs } },
    };
  }, 3);
}

// ---------------------------------------------------------------- table

export const KINDS: readonly KindDef[] = [
  { kind: 'knock', group: 'knock', tier: 0, maxTier: 1, reaches: 0, should: false, build: (c, t) => buildKnock(c, t, false) },
  { kind: 'handle_rattle', group: 'knock', tier: 0, maxTier: 0, reaches: 0, should: false, build: (c, t) => buildKnock(c, t, true) },
  { kind: 'poltergeist', group: 'poltergeist', tier: 0, maxTier: 0, reaches: 0, should: true, build: (c, t) => buildProp(c, t, false) },
  { kind: 'object_fall', group: 'object_fall', tier: 0, maxTier: 0, reaches: 0, should: true, build: (c, t) => buildProp(c, t, true) },
  { kind: 'cold_spot', group: 'cold_spot', tier: 0, maxTier: 0, reaches: 0, should: true, build: buildCold },
  { kind: 'brownout_breath', group: 'brownout_breath', tier: 0, maxTier: 0, reaches: 0, should: true, build: buildBreath },
  { kind: 'footprints', group: 'footprints', tier: 1, maxTier: 1, reaches: 1, should: true, build: buildFootprints },
  { kind: 'dark_walk', group: 'dark_walk', tier: 1, maxTier: 2, reaches: 2, should: false, build: buildDarkWalk },
  { kind: 'mirror_writing', group: 'mirror_writing', tier: 1, maxTier: 1, reaches: 1, should: false, build: buildWriting },
  { kind: 'presence', group: 'presence', tier: 1, maxTier: 2, reaches: 2, should: false, build: buildPresence },
  { kind: 'silhouette', group: 'presence', tier: 1, maxTier: 1, reaches: 1, should: false, build: buildSilhouette },
  { kind: 'mirror_figure', group: 'mirror_figure', tier: 2, maxTier: 2, reaches: 2, should: false, build: buildFigure },
];

export const KIND_BY_NAME: ReadonlyMap<string, KindDef> = new Map(KINDS.map((k) => [k.kind, k]));

export function groupOf(kind: ParanormalKind): ParaGroup {
  return KIND_BY_NAME.get(kind)?.group ?? 'stretch';
}

/** the first-mirror guarantee: arm the figure (build phase, not a Core carrier) else write on a mirror nobody watches */
export function buildMirrorGuarantee(c: BuildCtx, t: Targets, pid: string, _mirror: string, figureOk: boolean, writingOk = true): Built | null {
  const all = mirrorsFor(c);
  const p = t.all.find((q) => q.id === pid);
  if (!p || !all.length) return null;
  if (figureOk && !p.core) {
    const f = figureFor(c, t, p, all);
    if (f) return f;
  }
  return writingOk ? buildWriting({ ...c, target: pid }, t) : null;
}

export { activeMonsters, itemById };
