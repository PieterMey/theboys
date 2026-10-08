// Owner: track (c) Monsters (v1.2 G2). Shared helpers for the Listener fairness ws-bot tests: crew setup (director off,
// other monsters parked, Listener awake), layout geometry finders (open runs, doors, lockers, lit sight lines) on the
// shared nav grid, state polling and event helpers. Geometry is searched per layout, never hard-coded.
import { buildEdgeGrid, canWalk, cellOf, initialDoorOpen, los, walkClear } from '../../packages/shared/src/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout, LayoutDoor } from '../../packages/shared/src/layout.ts';
import { Bot, sleep, waitFor } from './bot.ts';
import type { EventRec } from './bot.ts';

export interface Ag {
  id: string; kind: string; x: number; z: number; yaw: number; state: string; active: boolean; anim: number; intent?: string;
  targetPlayer?: string | null; grabVictim?: string | null; dormant?: boolean; grabStruggle?: number; grabLeft?: number;
  pouncing?: boolean; speed?: number; knocks?: Record<string, number>; warned?: Record<string, number>;
}
export interface Dump { mode: string; time: number; agents: Ag[]; poses: { id: string; p: number[]; alive: boolean }[]; log: { line: string }[] }

export const results: { name: string; pass: boolean; info: string }[] = [];
export function check(name: string, pass: boolean, info = ''): boolean {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
}
export function summary(title: string): number {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${title}: ${failed.length ? 'FAILED' : 'PASSED'} ${results.length - failed.length}/${results.length}`);
  return failed.length ? 1 : 0;
}

export const r1 = (v: number) => Math.round(v * 10) / 10;
export const r2 = (v: number) => Math.round(v * 100) / 100;

export interface World { L: LevelLayout; g: EdgeGrid; open: DoorOpenFn }

export function worldOf(L: LevelLayout): World {
  return { L, g: buildEdgeGrid(L), open: initialDoorOpen(L) };
}

/** connected bots in `crew`; the director is switched off (no relax phases mid-test), a fresh contract on `seed`,
 *  every other monster parked, the Listener awake and parked */
export async function contract(url: string, crew: string, bots: Bot[], seed: string, players = 2, risk = 1): Promise<World> {
  for (const b of bots) await b.connect(url, crew);
  const a = bots[0];
  await a.dbg('monsters.flag', { name: 'director', on: false });
  await a.dbg('monsters.flag', { name: 'listenerFairV12', on: true });
  const t0 = performance.now();
  await a.dbg('monsters.start', { seed, players, risk });
  const L = await waitFor(() => (a.eventsOf('phase', t0).pop()?.d as { state?: { layout?: LevelLayout } } | undefined)?.state?.layout, 4000, 'layout');
  for (const id of ['hound0', 'hound1', 'mannequin0', 'snatcher0']) await a.dbg('monsters.place', { id, outSec: 9999 }).catch(() => null);
  await a.dbg('monsters.wake');
  await park(a);
  return worldOf(L);
}

/** the Listener out of play (somewhere far) until placed again */
export async function park(a: Bot): Promise<void> {
  await a.dbg('monsters.place', { id: 'listener0', outSec: 9999 });
}

export async function dump(a: Bot): Promise<Dump> { return a.dbg<Dump>('monsters.state'); }
export async function lis(a: Bot): Promise<Ag> { return (await dump(a)).agents.find((x) => x.kind === 'listener')!; }

/** stand the Listener at (x, z) facing (fx, fz), awake and watching (ambush hold) */
export async function placeListener(a: Bot, x: number, z: number, fx: number, fz: number, holdSec = 120): Promise<void> {
  await a.dbg('monsters.place', { id: 'listener0', x, z, yaw: Math.atan2(fx - x, fz - z), state: 'ambush', active: true, holdSec });
}

export async function tp(b: Bot, x: number, z: number, o: { yaw?: number; light?: 0 | 1; stance?: number } = {}): Promise<void> {
  await b.dbg('monsters.tp', { id: b.id, x, z, ...o });
}

/** a living player far away from everything (the van cab is a sealed sanctuary) */
export function cabSpot(w: World): [number, number] {
  return [w.L.van.cab.x + 1, w.L.van.cab.y + 1.5];
}

const isWalk = (w: World, x: number, z: number) => {
  const c = cellOf(w.g, x, z);
  if (c < 0 || w.g.owner[c] < 0) return false;
  const sp = w.L.spaces[w.g.owner[c]];
  return !!sp && sp.kind !== 'outside' && sp.type !== 'van' && sp.callsign !== 'VAN';
};

/** true if (x, z) is clear of solid boxes (lockers, props: the server's pose validation) */
export function freeOfSolids(w: World, x: number, z: number, r = 0.35): boolean {
  const s = w.g.solids;
  for (let i = 0; i < s.length; i += 4) if (x > s[i] - r && x < s[i + 2] + r && z > s[i + 1] - r && z < s[i + 3] + r) return false;
  return true;
}

/** no solid box (props, lockers) within `r` of the segment (sampled every 0.1 m) */
export function segClear(w: World, a: [number, number], b: [number, number], r = 0.3): boolean {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(L / 0.1));
  for (let i = 0; i <= n; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / n, z = a[1] + ((b[1] - a[1]) * i) / n;
    if (!freeOfSolids(w, x, z, r)) return false;
  }
  return true;
}

/**
 * A run for the sprinter: start S (the Listener), P at `gap` m (straight, LOS, no props between), then a cell path of
 * >= runM from P onward through open doorways only, clear of solid props, never coming back within gap of S.
 * Returns the path points (P first), evenly resampled at 0.1 m.
 */
export function findRun(w: World, gap: number, runM: number): { S: [number, number]; path: [number, number][] } | null {
  const { g } = w;
  const N = g.W * g.H;
  const blocked = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    const x = (c % g.W) + 0.5, z = Math.floor(c / g.W) + 0.5;
    if (!isWalk(w, x, z) || !freeOfSolids(w, x, z, 0.32)) blocked[c] = 1;
  }
  const dist = new Int32Array(N), par = new Int32Array(N);
  const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
  for (let c = 0; c < N; c += 3) {
    if (blocked[c]) continue;
    const sx = (c % g.W) + 0.5, sz = Math.floor(c / g.W) + 0.5;
    for (let k = 0; k < 4; k++) {
      const px = sx + DX[k] * gap, pz = sz + DZ[k] * gap;
      if (!isWalk(w, px, pz) || !freeOfSolids(w, px, pz) || !los(g, sx, sz, px, pz, w.open) || !walkClear(g, sx, sz, px, pz, w.open) || !segClear(w, [sx, sz], [px, pz])) continue;
      const pc = cellOf(g, px, pz);
      if (blocked[pc]) continue;
      // BFS over free cells from P, never within gap - 0.3 of S
      dist.fill(-1);
      const q: number[] = [pc];
      dist[pc] = 0;
      par[pc] = -1;
      let far = pc;
      for (let qi = 0; qi < q.length; qi++) {
        const cc = q[qi];
        const x = cc % g.W, y = (cc - x) / g.W;
        if (dist[cc] > dist[far]) far = cc;
        for (let dir = 0; dir < 4; dir++) {
          const nx = x + DX[dir], ny = y + DZ[dir];
          if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
          const n = ny * g.W + nx;
          if (dist[n] >= 0 || blocked[n]) continue;
          if (!canWalk(g, x, y, dir, w.open)) continue;
          if (Math.hypot(nx + 0.5 - sx, ny + 0.5 - sz) < gap - 0.3) continue;
          dist[n] = dist[cc] + 1;
          par[n] = cc;
          q.push(n);
        }
      }
      if (dist[far] < runM) continue;
      const cells: number[] = [];
      for (let cc = far; cc >= 0; cc = par[cc]) cells.push(cc);
      cells.reverse();
      const pts: [number, number][] = cells.map((cc) => [(cc % g.W) + 0.5, Math.floor(cc / g.W) + 0.5]);
      pts[0] = [px, pz];
      return { S: [sx, sz], path: resample(pts, 0.1) };
    }
  }
  return null;
}

export function resample(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [[pts[0][0], pts[0][1]]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const L = Math.hypot(bx - ax, bz - az);
    let s = step - carry;
    while (s <= L) {
      out.push([ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L]);
      s += step;
    }
    carry = L - (s - step);
  }
  return out;
}

/** a hand door (kind door/fire) with walkable, solid-free spots `dA` m before and `dB` m behind it along its normal */
export function findDoor(w: World, dA: number, dB: number): { door: LayoutDoor; A: [number, number]; B: [number, number]; c: [number, number] } | null {
  for (const d of w.L.doors) {
    if ((d.kind !== 'door' && d.kind !== 'fire') || d.a < 0 || d.b < 0 || d.len > 2) continue;
    const c: [number, number] = d.dir === 'v' ? [d.x, d.y + d.len / 2] : [d.x + d.len / 2, d.y];
    const n: [number, number] = d.dir === 'v' ? [1, 0] : [0, 1];
    for (const sgn of [1, -1]) {
      const A: [number, number] = [c[0] - n[0] * sgn * dA, c[1] - n[1] * sgn * dA];
      const B: [number, number] = [c[0] + n[0] * sgn * dB, c[1] + n[1] * sgn * dB];
      if (!isWalk(w, A[0], A[1]) || !isWalk(w, B[0], B[1])) continue;
      if (!freeOfSolids(w, A[0], A[1]) || !freeOfSolids(w, B[0], B[1])) continue;
      const allOpen = () => true;
      if (!walkClear(w.g, A[0], A[1], B[0], B[1], allOpen) || !los(w.g, A[0], A[1], B[0], B[1], allOpen) || !segClear(w, A, B, 0.25)) continue;
      return { door: d, A, B, c };
    }
  }
  return null;
}

/** a locker (layout 'hiding') with a free standing spot in front and a lit-or-not watch spot `far` m away with LOS */
export function findLocker(w: World, far: number): { id: string; P: [number, number]; S: [number, number] } | null {
  for (const it of w.L.items) {
    if (it.kind !== 'hiding') continue;
    const rot = it.rot ?? 0;
    const nx = Math.sin(rot), nz = Math.cos(rot);
    for (const sgn of [1, -1]) {
      const P: [number, number] = [it.x + nx * sgn * 0.85, it.z + nz * sgn * 0.85];
      if (!isWalk(w, P[0], P[1]) || !freeOfSolids(w, P[0], P[1], 0.3)) continue;
      for (const [dx, dz] of [[nx * sgn, nz * sgn], [nz, -nx], [-nz, nx]] as const) {
        const S: [number, number] = [P[0] + dx * far, P[1] + dz * far];
        if (!isWalk(w, S[0], S[1]) || !freeOfSolids(w, S[0], S[1])) continue;
        if (!los(w.g, S[0], S[1], P[0], P[1], w.open) || !walkClear(w.g, S[0], S[1], P[0], P[1], w.open) || !segClear(w, S, P, 0.25)) continue;
        return { id: it.id, P, S };
      }
    }
  }
  return null;
}

/** an open straight sight line of `len` m (both ends walkable, no solids), optionally in a lit room */
export function findLine(w: World, len: number, opts: { lit?: boolean; skip?: number } = {}): { S: [number, number]; P: [number, number]; dir: [number, number] } | null {
  const { g } = w;
  let skip = opts.skip ?? 0;
  for (let c = 0; c < g.W * g.H; c += 3) {
    if (g.owner[c] < 0) continue;
    const sp = w.L.spaces[g.owner[c]];
    if (opts.lit !== undefined && (sp.light === 'on') !== opts.lit) continue;
    const sx = (c % g.W) + 0.5, sz = Math.floor(c / g.W) + 0.5;
    if (!isWalk(w, sx, sz) || !freeOfSolids(w, sx, sz)) continue;
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const px = sx + dx * len, pz = sz + dz * len;
      if (!isWalk(w, px, pz) || !freeOfSolids(w, px, pz)) continue;
      if (g.owner[cellOf(g, px, pz)] !== g.owner[c]) continue; // same space (lighting)
      if (!los(g, sx, sz, px, pz, w.open) || !walkClear(g, sx, sz, px, pz, w.open) || !segClear(w, [sx, sz], [px, pz])) continue;
      if (skip-- > 0) continue;
      return { S: [sx, sz], P: [px, pz], dir: [dx, dz] };
    }
  }
  return null;
}

/** poll the Listener until pred holds (returns it) or timeout */
export async function untilL(a: Bot, pred: (l: Ag) => boolean, ms: number, label: string, every = 25): Promise<Ag | null> {
  const t0 = performance.now();
  for (;;) {
    const l = await lis(a);
    if (pred(l)) return l;
    if (performance.now() - t0 > ms) { console.log(`  (timeout ${ms} ms: ${label}; state ${l.state}/${l.intent})`); return null; }
    await sleep(every);
  }
}

export function cueEvents(b: Bot, since: number, cue: string): EventRec[] {
  return b.eventsOf('monsters.cue', since).filter((e) => (e.d as { cue: string; kind: string }).cue === cue && (e.d as { kind: string }).kind === 'listener');
}
export function grabEvents(b: Bot, since: number, state?: string): EventRec[] {
  return b.eventsOf('monsters.grab', since).filter((e) => !state || (e.d as { state: string }).state === state);
}

/** the server log lines that look like errors from the monsters track */
export function serverErrors(log: string): string[] {
  return log.split('\n').filter((l) => /error|threw|TypeError|ReferenceError/i.test(l) && /monsters|listener|director/i.test(l));
}
