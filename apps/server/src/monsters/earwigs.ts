// Owner: track (c) Monsters (v1.3 F6, flag `earwigs`, off by default; a missing flag = off). THE EARWIGS: the
// Listener's ears (concepts-monsters TOP-1). On 2026-10-08 the dormant Listener heard 0 of the friends' 55 lines: it
// sleeps in the deepest 30 % of the site and the crew talks on the way in. Ears placed on the crew's route fix that
// (simulated pre-wake hearing 0.0-0.3 % -> 48-76 %).
//  - PLACEMENT (contract start, a pure function of the layout + the crew size): the route entrance -> levers ->
//    keypad -> Core (walking A*, every door passable), sampled every 3 m; candidate spots on that route at depth
//    0.1-0.7 (space dist / deepest), never in the lobby (the entrance), the vault, outside or the van; each candidate
//    is mounted on the nearest free plain wall of its room within 6.5 m (no door / fence / rubble, no item footprint
//    on that spot), on the visible wall face, at 1.25-1.75 m (seeded); greedy maximum coverage of the route samples
//    within talk radius (10 m path, initial door states; the first 40 % of the route, the pre-wake part, counts
//    double), >= 10 m apart. Looser tiers (wider depth band, any depth, then any free wall that still hears the route)
//    only seat the ears a short or back-and-forth route cannot. 2 ears up to 2 players, 3 for 3-4, 4 for 5-6.
//  - HEARING: an ear hears exactly what a teammate standing there would: a voice sample (runtime voiceNoise, 6.7 Hz)
//    whose sound flood reaches it within the band radius. It keeps who-heard-what records (like the Listener's own
//    voiceHeard), passes the loudness on (an awake, idle Listener drifts to the EAR, never the speaker) and a
//    transcript of a speaker it heard becomes a memory line placed at the ear (room = the ear's room, position = the
//    ear's): the Listener learns "voices near the ARCHIVE ear", never where the speaker stood.
//  - TELLS: a wet tick (cue 'tick', id = the ear id, 4 m) each time it relays a line, and every tickEverySec while
//    it passes voices on; the ear twitches (client).
//  - COUNTERPLAY: whisper (3 m); keep a flashlight on it: a lit ear is deaf while lit and deafSec (6 s) after; a deaf
//    ear relays nothing (not even a line it half heard before).
// TODO(integrator, catalog V12_KINDS): an 'ear' id prefix so G3 can make ears crushable (hold E 1.2 s, 4 m squelch).
// TODO(director, later): up to 2 more ears near the crew in quiet phases (concepts-monsters TOP-1, not this slice).
import { EDGE, astar, edgeCode, fieldAt, los, pathPoints, soundFlood } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import { HALF_T } from '@dead-air/shared/procgen/place.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import type { Snapshot } from '@dead-air/shared/state.ts';
import type { ServerContext } from '../core/types.ts';
import type { Rt } from './runtime.ts';
import { isAlive } from './ext.ts';
import { dist, inCab } from './geo.ts';
import { bal, num } from './types.ts';
import type { Bal, CrewMonsters, Ear, ListenerAgent, Noise } from './types.ts';
import { listenerEarNoise } from './listener.ts';

export const EAR_PREFIX = 'ear:';
/** mount point offset from the wall's grid line into the room: the visible wall face (HALF_T) + 1 cm */
export const EAR_WALL_OFF = HALF_T + 0.01;

/** behaviour gate (config/flags.json earwigs; missing = off): checked every tick, so the kill switch works mid-contract */
export function earwigsFlag(ctx: ServerContext): boolean {
  return (ctx.flags as Record<string, unknown>).earwigs === true;
}

export function earsOn(rt: Rt): boolean {
  return earwigsFlag(rt.ctx) && !!rt.cm.ears?.length;
}

// ---------------------------------------------------------------- placement (pure)

export interface EarOpts {
  count: number;
  minSepM: number;
  depthMin: number;
  depthMax: number;
  talkM: number;
  stepM: number;
  /** share of the route (from the entrance) that counts as pre-wake, and its weight in the coverage greedy */
  preShare: number;
  preWeight: number;
  heightMin: number;
  heightMax: number;
}

export function earOpts(b: Bal, players: number): EarOpts {
  return {
    count: earCount(b, players),
    minSepM: num(b, 'minSepM', 10), depthMin: num(b, 'depthMin', 0.1), depthMax: num(b, 'depthMax', 0.7),
    talkM: num(b, 'talkM', 10), stepM: num(b, 'stepM', 3), preShare: num(b, 'preShare', 0.4), preWeight: num(b, 'preWeight', 2),
    heightMin: num(b, 'heightMin', 1.25), heightMax: num(b, 'heightMax', 1.75),
  };
}

/** 2 ears up to 2 players, 3 for 3-4, 4 for 5-6 (balance count2 / count4 / count6) */
export function earCount(b: Bal, players: number): number {
  const n = Math.max(1, Math.round(players));
  return Math.max(0, Math.round(n <= 2 ? num(b, 'count2', 2) : n <= 4 ? num(b, 'count4', 3) : num(b, 'count6', 4)));
}

export interface EarRoute {
  /** speech samples every stepM along the route (x, z), entrance first */
  samples: [number, number][];
  /** samples[0 .. pre) are the pre-wake part */
  pre: number;
  /** route length (m) */
  length: number;
}

/** the crew's likely route: entrance -> levers -> keypad -> Core (walking, every door passable), sampled every stepM */
export function earRoute(L: LevelLayout, g: EdgeGrid, stepM = 3, preShare = 0.4): EarRoute {
  const ent = L.spaces[L.entrance];
  const goals: [number, number][] = [];
  if (ent) goals.push([ent.rect.x + ent.rect.w / 2, ent.rect.y + ent.rect.h / 2]);
  for (const kind of ['lever', 'keypad', 'core'] as const) for (const it of L.items) if (it.kind === kind) goals.push([it.x, it.z]);
  if (goals.length < 2) {
    // no objective items: entrance -> the deepest indoor room
    const deep = L.spaces.filter((s) => s.kind !== 'outside').sort((a, b) => b.dist - a.dist || a.id - b.id)[0];
    if (deep) goals.push([deep.rect.x + deep.rect.w / 2, deep.rect.y + deep.rect.h / 2]);
  }
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < goals.length; i++) {
    const r = astar(g, goals[i][0], goals[i][1], goals[i + 1][0], goals[i + 1][1], { mode: 'walk', doorOpen: () => true, maxCost: 2000 });
    if (r) for (const p of pathPoints(g, r.cells)) pts.push(p);
  }
  const samples: [number, number][] = pts.length ? [pts[0]] : [];
  let acc = 0, length = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    acc += d;
    length += d;
    if (acc >= stepM) { samples.push(pts[i]); acc = 0; }
  }
  return { samples, pre: Math.max(1, Math.floor(samples.length * preShare)), length };
}

/** spaces an ear never grows in: the lobby (entrance), the vault, outside (the lot / van) */
export function earSpaceOk(L: LevelLayout, space: number): boolean {
  const s = L.spaces[space];
  if (!s || space === L.entrance) return false;
  if (s.kind === 'vault' || s.kind === 'outside' || s.open) return false;
  if (s.type === 'lobby' || s.type === 'vault') return false;
  const cs = (s.callsign ?? '').toUpperCase();
  return cs !== 'LOBBY' && cs !== 'VAN' && cs !== 'VAULT';
}

interface Mount { space: number; x: number; z: number; wx: number; wz: number; nx: number; nz: number }

const EDGE_DIRS: readonly { dx: number; dz: number; nx: number; nz: number; ox: number; oz: number }[] = [
  // dir 0 (+x edge): mount at (x+1, z+.5), normal -x; dir 1 (-x): (x, z+.5), +x; dir 2 (+z): (x+.5, z+1), -z; dir 3 (-z)
  { dx: 1, dz: 0, nx: -1, nz: 0, ox: 1, oz: 0.5 },
  { dx: -1, dz: 0, nx: 1, nz: 0, ox: 0, oz: 0.5 },
  { dx: 0, dz: 1, nx: 0, nz: -1, ox: 0.5, oz: 1 },
  { dx: 0, dz: -1, nx: 0, nz: 1, ox: 0.5, oz: 0 },
];

/** an item that occupies the wall spot (mx, mz): its footprint (props: data.w x data.d, rotated in quarter turns;
 *  other items ~0.6 x 0.4) plus a 0.2 m margin. Spawn markers and loot are not things on the wall. */
function itemAt(it: LevelLayout['items'][number], mx: number, mz: number): boolean {
  if (it.kind === 'loot' || it.kind.startsWith('spawn_')) return false;
  const w = Number(it.data?.w ?? 0.6) || 0.6, d = Number(it.data?.d ?? 0.4) || 0.4;
  const alongX = Math.abs(Math.round((it.rot ?? 0) / (Math.PI / 2))) % 2 === 0;
  const hw = (alongX ? w : d) / 2 + 0.2, hd = (alongX ? d : w) / 2 + 0.2;
  return Math.abs(mx - it.x) <= hw && Math.abs(mz - it.z) <= hd;
}

/** every free wall spot of the spaces an ear may grow in (space id -> mounts): a plain wall edge (no door, fence or
 *  rubble), nothing mounted on or standing against it, never in the van cab */
function wallMounts(L: LevelLayout, g: EdgeGrid): Map<number, Mount[]> {
  const items = new Map<number, LevelLayout['items']>();
  for (const it of L.items) {
    let a = items.get(it.space);
    if (!a) items.set(it.space, (a = []));
    a.push(it);
  }
  const out = new Map<number, Mount[]>();
  const ok = new Map<number, boolean>();
  for (let c = 0; c < g.owner.length; c++) {
    const sp = g.owner[c];
    if (sp < 0) continue;
    let allowed = ok.get(sp);
    if (allowed === undefined) ok.set(sp, (allowed = earSpaceOk(L, sp)));
    if (!allowed) continue;
    const xx = c % g.W, zz = (c - xx) / g.W;
    if (inCab(L, xx + 0.5, zz + 0.5)) continue;
    for (let dir = 0; dir < 4; dir++) {
      if (edgeCode(g, xx, zz, dir) !== EDGE.wall) continue;
      const e = EDGE_DIRS[dir];
      const mx = xx + e.ox, mz = zz + e.oz;
      if ((items.get(sp) ?? []).some((it) => itemAt(it, mx, mz))) continue;
      let a = out.get(sp);
      if (!a) out.set(sp, (a = []));
      // on the VISIBLE wall face: the mesher draws walls WALL_T thick, centred on the grid line (HALF_T into the room)
      a.push({ space: sp, x: xx + 0.5, z: zz + 0.5, wx: mx + e.nx * EAR_WALL_OFF, wz: mz + e.nz * EAR_WALL_OFF, nx: e.nx, nz: e.nz });
    }
  }
  return out;
}

/** the free wall spot of `space` nearest to (x, z), within maxM (big halls: the walls can be 6 m away) */
function mountNear(walls: Map<number, Mount[]>, space: number, x: number, z: number, maxM = 6.5): Mount | null {
  let best: Mount | null = null, bestD = maxM;
  for (const m of walls.get(space) ?? []) {
    const d = Math.hypot(m.wx - x, m.wz - z);
    if (d < bestD - 1e-9) { bestD = d; best = m; }
  }
  return best;
}

/** the ears for a layout (deterministic: layout + options only) */
export function placeEars(L: LevelLayout, g: EdgeGrid, o: EarOpts, route = earRoute(L, g, o.stepM, o.preShare)): Ear[] {
  if (o.count <= 0 || route.samples.length < 2) return [];
  const maxDist = Math.max(1e-6, ...L.spaces.map((s) => (Number.isFinite(s.dist) ? s.dist : 0)));
  const initOpen = (id: number) => { const d = L.doors[id]; return !!d && (d.kind === 'open' || d.initiallyOpen); };
  const walls = wallMounts(L, g);
  // candidate mounts (deduped by hearing cell), in tiers; a looser tier only seats the ears the tighter ones could not
  // seat >= minSepM apart (short or back-and-forth routes):
  //   0 = the wall nearest a route sample at depth depthMin..depthMax; 1 = the same at half depthMin .. depthMax + 0.15;
  //   2 = the same at any depth; 3 = any free wall of an allowed room on a 3 m lattice that still hears the route
  const mounts: Mount[] = [];
  const tier: number[] = [];
  const seen = new Set<number>();
  const add = (m: Mount | null, t: number) => {
    if (!m) return;
    const key = Math.floor(m.z) * g.W + Math.floor(m.x);
    if (seen.has(key)) return;
    seen.add(key);
    mounts.push(m);
    tier.push(t);
  };
  const loose = [o.depthMin / 2, Math.min(1, o.depthMax + 0.15)];
  for (const [x, z] of route.samples) {
    const sp = g.owner[Math.floor(z) * g.W + Math.floor(x)] ?? -1;
    if (sp < 0 || !walls.has(sp)) continue;
    const depth = (L.spaces[sp].dist ?? 0) / maxDist;
    add(mountNear(walls, sp, x, z), depth >= o.depthMin && depth <= o.depthMax ? 0 : depth >= loose[0] && depth <= loose[1] ? 1 : 2);
  }
  const lattice = new Set<number>();
  for (const list of walls.values()) {
    for (const m of list) {
      const k = Math.floor(m.z / 3) * 1024 + Math.floor(m.x / 3);
      if (lattice.has(k)) continue;
      lattice.add(k);
      add(m, 3);
    }
  }
  if (!mounts.length) return [];
  // which samples each mount hears (flood from the speaker = the sample, talk radius, initial doors)
  const covers = mounts.map(() => new Uint8Array(route.samples.length));
  route.samples.forEach(([x, z], i) => {
    const f = soundFlood(g, x, z, o.talkM, initOpen);
    mounts.forEach((m, mi) => { if (fieldAt(g, f, m.x, m.z) <= o.talkM) covers[mi][i] = 1; });
  });
  const weight = (i: number) => (i < route.pre ? o.preWeight : 1);
  const got = new Uint8Array(route.samples.length);
  const chosen: number[] = [];
  for (let maxTier = 0; maxTier <= 3 && chosen.length < o.count; maxTier++) {
    while (chosen.length < o.count) {
      let best = -1, bestGain = -1, bestFar = -1;
      mounts.forEach((m, mi) => {
        if (tier[mi] > maxTier || chosen.includes(mi) || chosen.some((c) => dist(mounts[c].x, mounts[c].z, m.x, m.z) < o.minSepM)) return;
        let gain = 0, hears = 0;
        for (let i = 0; i < covers[mi].length; i++) if (covers[mi][i]) { hears++; if (!got[i]) gain += weight(i); }
        if (tier[mi] === 3 && !hears) return; // off-route walls must hear the route
        // no new coverage left: spread out (farthest from the chosen ones)
        const far = chosen.length ? Math.min(...chosen.map((c) => dist(mounts[c].x, mounts[c].z, m.x, m.z))) : 0;
        if (gain > bestGain || (gain === bestGain && gain === 0 && far > bestFar)) { best = mi; bestGain = gain; bestFar = far; }
      });
      if (best < 0) break;
      chosen.push(best);
      covers[best].forEach((v, i) => { if (v) got[i] = 1; });
    }
  }
  const rng = makeRng(`${L.seed}|${L.hash}|ears`, 'monsters');
  return chosen.map((mi, n) => {
    const m = mounts[mi];
    return {
      id: `${EAR_PREFIX}${n}`, space: m.space, callsign: L.spaces[m.space]?.callsign ?? null,
      x: m.x, z: m.z, wx: m.wx, wz: m.wz, y: Math.round((o.heightMin + rng.next() * (o.heightMax - o.heightMin)) * 100) / 100, nx: m.nx, nz: m.nz,
      deafUntil: -1, heard: new Map(), tickAt: -100, relays: 0, samples: 0,
    };
  });
}

/** share of the route samples (pre-wake part / whole route) within `radius` path metres of any ear (tests, tuning) */
export function routeCoverage(L: LevelLayout, g: EdgeGrid, ears: readonly Pick<Ear, 'x' | 'z'>[], route: EarRoute, radius = 10): { pre: number; whole: number } {
  if (!route.samples.length) return { pre: 0, whole: 0 };
  const initOpen = (id: number) => { const d = L.doors[id]; return !!d && (d.kind === 'open' || d.initiallyOpen); };
  const hit = route.samples.map(([x, z]) => {
    const f = soundFlood(g, x, z, radius, initOpen);
    return ears.some((e) => fieldAt(g, f, e.x, e.z) <= radius);
  });
  const pre = hit.slice(0, route.pre).filter(Boolean).length / Math.max(1, Math.min(route.pre, hit.length));
  return { pre, whole: hit.filter(Boolean).length / hit.length };
}

/** contract start (flag earwigs, a Listener in play): place the ears for this crew size */
export function setupEars(ctx: ServerContext, cm: CrewMonsters): Ear[] {
  cm.ears = [];
  if (!earwigsFlag(ctx) || !cm.agents.some((a) => a.kind === 'listener')) return cm.ears;
  cm.ears = placeEars(cm.layout, cm.grid, earOpts(bal(ctx, 'earwigs'), cm.players));
  return cm.ears;
}

// ---------------------------------------------------------------- runtime

/** the ears' 5 Hz light check: any living player's flashlight on it (range, cone incl. pitch, line of sight) = deaf */
export function earsTick(rt: Rt, dt: number): void {
  const cm = rt.cm;
  if (!earsOn(rt)) return;
  cm.earAcc = (cm.earAcc ?? 0) + dt;
  if (cm.earAcc < 0.2) return;
  cm.earAcc = 0;
  const b = bal(rt.ctx, 'earwigs');
  const range = num(b, 'litRangeM', 8), cosHalf = Math.cos((num(b, 'litHalfAngleDeg', 22) * Math.PI) / 180), deaf = num(b, 'deafSec', 6);
  const lit = rt.alive().filter((p) => p.pose.light === 1);
  if (!lit.length) return;
  for (const e of cm.ears!) {
    for (const p of lit) {
      const [px, py, pz] = p.pose.p;
      const eye = (py ?? 0) + (p.pose.stance === STANCE.crouch ? 1.0 : 1.6);
      const dx = e.wx - px, dy = e.y - eye, dz = e.wz - pz;
      const d = Math.hypot(dx, dy, dz);
      if (d > range || d < 1e-3) continue;
      const pitch = Number((p.pose as { pitch?: number }).pitch ?? 0) || 0;
      const fx = Math.sin(p.pose.yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = Math.cos(p.pose.yaw) * Math.cos(pitch);
      if ((fx * dx + fy * dy + fz * dz) / d < cosHalf) continue;
      if (!los(cm.grid, px, pz, e.x, e.z, cm.doorOpen)) continue;
      if (e.deafUntil < cm.time) rt.ctx.log('monsters').debug(`crew ${rt.crew.code}: ${e.id} lit: deaf ${deaf} s`);
      e.deafUntil = cm.time + deaf;
      break;
    }
  }
}

export function earDeaf(rt: Rt, e: Ear): boolean {
  return rt.cm.time < e.deafUntil;
}

/** the wet tick at the ear (4 m); `force` = a relayed line (else at most every tickEverySec) */
function earTick(rt: Rt, e: Ear, force: boolean): void {
  const b = bal(rt.ctx, 'earwigs');
  if (!force && rt.cm.time - e.tickAt < num(b, 'tickEverySec', 2)) return;
  e.tickAt = rt.cm.time;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  rt.ctx.emit(rt.crew, 'monsters.cue', { id: e.id, kind: 'listener', cue: 'tick', p: [r2(e.wx), e.y, r2(e.wz)], radius: num(b, 'tickRadiusM', 4) });
}

/**
 * processNoise: a living player's voice sample. Every ear that hears it (not deaf, within the band radius by path)
 * records who-heard-what and passes the loudness on to the Listener (placed at the ear). Reuses the noise's sound
 * flood when the monsters already computed it; returns the flood (computed lazily here otherwise).
 */
export function earsHearVoice(rt: Rt, n: Noise, field: Float32Array | null): Float32Array | null {
  const cm = rt.cm;
  if (!earsOn(rt) || n.kind !== 'voice' || !n.source) return field;
  const sp = rt.crew.players.get(n.source);
  if (!sp || !isAlive(rt.crew, sp)) return field;
  const L = cm.agents.find((a) => a.kind === 'listener') as ListenerAgent | undefined;
  for (const e of cm.ears!) {
    if (earDeaf(rt, e)) continue;
    if (Math.abs(e.x - n.x) > n.radiusM + 1 || Math.abs(e.z - n.z) > n.radiusM + 1) continue;
    field ??= soundFlood(cm.grid, n.x, n.z, n.radiusM, cm.doorOpen);
    const d = fieldAt(cm.grid, field, e.x, e.z);
    if (!(d <= n.radiusM)) continue;
    let arr = e.heard.get(sp.id);
    if (!arr) e.heard.set(sp.id, (arr = []));
    arr.push(cm.time);
    if (arr.length > 40) arr.splice(0, arr.length - 40);
    e.samples++;
    if (L) listenerEarNoise(rt, L, e, n);
    earTick(rt, e, false);
  }
  return field;
}

/** a transcript the Listener did not hear itself: the ear (not deaf now) that heard this speaker while the segment
 *  was open (who-heard-what window, as the Listener's own fallback), the most recent first */
export function earForUtterance(rt: Rt, speaker: string, durSec: number): Ear | null {
  if (!earsOn(rt)) return null;
  const from = rt.cm.time - Math.max(1, durSec) - 4;
  let best: Ear | null = null, bestT = -Infinity;
  for (const e of rt.cm.ears!) {
    if (earDeaf(rt, e)) continue;
    const arr = e.heard.get(speaker);
    const t = arr && arr.length ? arr[arr.length - 1] : -Infinity;
    if (t >= from && t > bestT) { best = e; bestT = t; }
  }
  return best;
}

/** a proximity text line at (x, z) within radiusM (typed text reaches the ears the way speech does) */
export function earForText(rt: Rt, x: number, z: number, radiusM: number, field: Float32Array | null): Ear | null {
  if (!earsOn(rt) || inCab(rt.cm.layout, x, z)) return null;
  let best: Ear | null = null, bestD = Infinity;
  for (const e of rt.cm.ears!) {
    if (earDeaf(rt, e)) continue;
    field ??= soundFlood(rt.cm.grid, x, z, radiusM, rt.cm.doorOpen);
    const d = fieldAt(rt.cm.grid, field, e.x, e.z);
    if (d <= radiusM && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

/** a line went to the Listener through this ear: count it + the tick */
export function earRelayed(rt: Rt, e: Ear): void {
  e.relays++;
  earTick(rt, e, true);
}

/** snapshot dyn entries 'ear:<n>' (static: the mount point + height, yaw = the wall normal); the client draws them */
export function earsSnapshot(rt: Rt, snap: Snapshot): void {
  if (!earsOn(rt)) return;
  for (const e of rt.cm.ears!) snap.dyn.push({ id: e.id, p: [Math.round(e.wx * 100) / 100, e.y, Math.round(e.wz * 100) / 100], yaw: Math.round(Math.atan2(e.nx, e.nz) * 1000) / 1000 });
}

/** dbg / tests */
export function describeEars(rt: Rt): Record<string, unknown>[] {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return (rt.cm.ears ?? []).map((e) => ({
    id: e.id, space: e.space, callsign: e.callsign, x: r2(e.x), z: r2(e.z), wx: r2(e.wx), wz: r2(e.wz), y: e.y, nx: e.nx, nz: e.nz,
    deaf: earDeaf(rt, e), deafLeft: r2(Math.max(0, e.deafUntil - rt.cm.time)), relays: e.relays, samples: e.samples, on: earsOn(rt),
  }));
}
