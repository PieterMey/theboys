// Owned by track ② Level. Facility generator: corridor lattice + BSP rooms + doors + vault + keycard zone +
// security/fire doors + rubble + parking lot with the van + placement (levers, keypad, Core, loot, lockers, lights...).
// Deterministic: one makeRng stream per stage; integer / exact arithmetic only (no Math.random / sin / cos).
import { GEN_VERSION } from '../layout.ts';
import type { DoorKind, LayoutDoor, LayoutSpace, LevelLayout, Rect, SpaceKind } from '../layout.ts';
import { makeRng } from '../rng.ts';
import type { Rng } from '../rng.ts';
import { WORLD } from '../constants.ts';
import { ALL_OPEN, buildEdgeGrid } from '../nav/grid.ts';
import { floodCells } from '../nav/path.ts';
import { los } from '../nav/los.ts';
import { DEFAULT_LEVEL_TUNING, footprintFor } from './tuning.ts';
import type { LevelTuning } from './tuning.ts';
import { layoutHash } from './hash.ts';
import { VAN_CARGO_W, VAN_LEN, addVanItems, addVanSpawns, stampVan } from './van.ts';
import { Placer } from './place.ts';
import type { Mount } from './place.ts';
import { assignCallsigns } from './names.ts';
import { GenFail, ItemList, area, bsp, centreCell, clamp, graphDijkstra, normalOfYaw, partition, r1, rcx, rcy, reach } from './common.ts';
import type { GEdge } from './common.ts';
import { addFixtures, rollLight } from './lights.ts';
import { placeDecor } from './decor.ts';

export interface FacilityParams {
  seed: string;
  /** crew size 1..6 (sets the footprint) */
  players: number;
  /** 1..3 */
  risk: number;
}

interface WS extends LayoutSpace { perimeter: boolean }
interface WD { a: number; b: number; x: number; y: number; dir: 'v' | 'h'; len: number; kind: DoorKind; lock: number; initiallyOpen: boolean; dead: boolean; id: number }
interface Run { a: number; b: number; x: number; y: number; dir: 'v' | 'h'; len: number }

export function generateFacility(params: FacilityParams, tuning: LevelTuning = DEFAULT_LEVEL_TUNING): LevelLayout {
  const seed = String(params.seed);
  const players = clamp(Math.round(params.players), 1, 6);
  const risk = clamp(Math.round(params.risk), 1, 3);
  const reasons: string[] = [];
  for (let attempt = 0; attempt < tuning.maxAttempts; attempt++) {
    try {
      return generateOnce(seed, attempt, players, risk, tuning);
    } catch (e) {
      if (!(e instanceof GenFail)) throw e;
      reasons.push(e.message);
    }
  }
  throw new Error(`generateFacility(${seed}, p${players}, r${risk}) failed: ${reasons.join(', ')}`);
}

const pairKey = (a: number, b: number) => (a < b ? a * 4096 + b : b * 4096 + a);

function generateOnce(seed: string, attempt: number, players: number, risk: number, t: LevelTuning): LevelLayout {
  const key = `${attempt ? `${seed}#${attempt}` : seed}|${GEN_VERSION}`;
  const rL = makeRng(key, 'layout');
  const [W, FH] = footprintFor(players, t);
  const LD = t.lotDepth, H = FH + LD, CW = t.corridorWidth;

  // ---------------- corridor lattice ----------------
  // perimeter strip depths, clamped so at least one block fits between the outer corridor lines
  const mMaxX = Math.max(t.marginMin, Math.min(t.marginMax, Math.floor((W - 2 * CW - t.blockMin) / 2)));
  const mMaxY = Math.max(t.marginMin, Math.min(t.marginMax, Math.floor((FH - 2 * CW - t.blockMin) / 2)));
  const mL = rL.int(t.marginMin, mMaxX), mR = rL.int(t.marginMin, mMaxX);
  const mT = rL.int(t.marginMin, mMaxY), mB = rL.int(Math.max(5, t.marginMin), Math.max(5, mMaxY));
  const spanX = W - mL - mR - CW, spanY = FH - mT - mB - CW;
  let nbx = Math.max(1, Math.round((spanX + CW) / (CW + t.blockTarget)));
  let nby = Math.max(1, Math.round((spanY + CW) / (CW + t.blockTarget)));
  while (nbx > 1 && spanX - nbx * CW < nbx * t.blockMin) nbx--;
  while (nby > 1 && spanY - nby * CW < nby * t.blockMin) nby--;
  if (spanX - nbx * CW < t.blockMin || spanY - nby * CW < t.blockMin) throw new GenFail('footprint');
  const bw = partition(spanX - nbx * CW, nbx, t.blockMin, rL), bh = partition(spanY - nby * CW, nby, t.blockMin, rL);
  const xs = [mL]; for (const b of bw) xs.push(xs[xs.length - 1] + CW + b);
  const ys = [mT]; for (const b of bh) ys.push(ys[ys.length - 1] + CW + b);
  const vPresent: boolean[][] = xs.map((_, i) => {
    const segs = new Array<boolean>(nby).fill(true);
    if (i === 0 || i === xs.length - 1) return segs;
    const r = rL.next();
    if (r < t.innerAbsent) return segs.fill(false);
    if (r < t.innerAbsent + t.innerPartial && nby > 1) {
      const a = rL.int(0, nby - 1), b = rL.int(a, nby - 1);
      for (let j = 0; j < nby; j++) segs[j] = j >= a && j <= b;
    }
    return segs;
  });

  const owner = new Int32Array(W * H).fill(-1);
  const S: WS[] = [];
  const addSpace = (kind: SpaceKind, rect: Rect, type: string, perimeter = false, open = false) => {
    const id = S.length;
    S.push({ id, kind, rect, zone: 0, type, callsign: null, dist: 0, light: 'on', open, powerZone: 0, perimeter });
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) owner[y * W + x] = id;
    return id;
  };
  for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) {
    addSpace('corridor', { x: xs[i], y: ys[j], w: CW, h: CW }, 'junction');
    if (i < xs.length - 1) addSpace('corridor', { x: xs[i] + CW, y: ys[j], w: xs[i + 1] - xs[i] - CW, h: CW }, 'corridor');
  }
  for (let i = 0; i < xs.length; i++) for (let j = 0; j < nby; j++) {
    if (vPresent[i][j]) addSpace('corridor', { x: xs[i], y: ys[j] + CW, w: CW, h: ys[j + 1] - ys[j] - CW }, 'corridor');
  }
  // blocks between present corridor lines + 4 perimeter strips
  const blocks: { r: Rect; perimeter: boolean }[] = [];
  for (let j = 0; j < nby; j++) {
    const present: number[] = [];
    for (let i = 0; i < xs.length; i++) if (vPresent[i][j]) present.push(i);
    for (let k = 0; k < present.length - 1; k++) {
      const a = present[k], b = present[k + 1];
      blocks.push({ r: { x: xs[a] + CW, y: ys[j] + CW, w: xs[b] - xs[a] - CW, h: ys[j + 1] - ys[j] - CW }, perimeter: false });
    }
  }
  const yTop = ys[0], yBot = ys[ys.length - 1] + CW, xLeft = xs[0], xRight = xs[xs.length - 1] + CW;
  blocks.push({ r: { x: 0, y: 0, w: W, h: yTop }, perimeter: true });
  blocks.push({ r: { x: 0, y: yBot, w: W, h: FH - yBot }, perimeter: true });
  blocks.push({ r: { x: 0, y: yTop, w: xLeft, h: yBot - yTop }, perimeter: true });
  blocks.push({ r: { x: xRight, y: yTop, w: W - xRight, h: yBot - yTop }, perimeter: true });
  const maxArea = t.bspMaxAreaBase + t.bspMaxAreaPerPlayer * players;
  for (const b of blocks) {
    const rooms: Rect[] = [];
    const A = area(b.r);
    if (!b.perimeter && A >= t.hallMinArea && A <= t.hallMaxArea && rL.chance(t.hallChance)) rooms.push(b.r);
    else bsp(b.r, rL, rooms, t.bspMinSide, t.bspMaxSide, maxArea, t.bspStopChance);
    for (const r of rooms) addSpace(area(r) >= t.hallKindArea ? 'hall' : 'room', r, 'room', b.perimeter);
  }
  const nRooms = S.filter((s) => s.kind === 'room' || s.kind === 'hall').length;
  if (nRooms < t.roomsMin || nRooms > t.roomsMax) throw new GenFail(`rooms:${nRooms}`);
  const lot = addSpace('outside', { x: 0, y: FH, w: W, h: LD }, 'lot', false, true);

  // ---------------- shared edge runs between space pairs ----------------
  const pairEv = new Map<number, { a: number; b: number; v: number[]; h: number[] }>();
  const nbrList: number[][] = S.map(() => []);
  const pushEdge = (a: number, b: number, dir: 'v' | 'h', e: number) => {
    if (a === b || a < 0 || b < 0) return;
    const k = pairKey(a, b);
    let p = pairEv.get(k);
    if (!p) { p = { a: Math.min(a, b), b: Math.max(a, b), v: [], h: [] }; pairEv.set(k, p); nbrList[a].push(b); nbrList[b].push(a); }
    (dir === 'v' ? p.v : p.h).push(e);
  };
  // v edges sorted by (x, y), h edges by (y, x) so runs merge in one pass
  for (let x = 1; x < W; x++) for (let y = 0; y < H; y++) pushEdge(owner[y * W + x - 1], owner[y * W + x], 'v', y * (W + 1) + x);
  for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) pushEdge(owner[(y - 1) * W + x], owner[y * W + x], 'h', y * W + x);
  const runCache = new Map<number, Run[]>();
  const runsOf = (a: number, b: number): Run[] => {
    const k = pairKey(a, b);
    const cached = runCache.get(k);
    if (cached) return cached;
    const p = pairEv.get(k);
    const runs: Run[] = [];
    if (p) {
      for (const e of p.v) {
        const x = e % (W + 1), y = (e - x) / (W + 1);
        const last = runs[runs.length - 1];
        if (last && last.dir === 'v' && last.x === x && last.y + last.len === y) last.len++;
        else runs.push({ a: p.a, b: p.b, x, y, dir: 'v', len: 1 });
      }
      for (const e of p.h) {
        const x = e % W, y = (e - x) / W;
        const last = runs[runs.length - 1];
        if (last && last.dir === 'h' && last.y === y && last.x + last.len === x) last.len++;
        else runs.push({ a: p.a, b: p.b, x, y, dir: 'h', len: 1 });
      }
    }
    runCache.set(k, runs);
    return runs;
  };
  const total = (runs: Run[]) => runs.reduce((s, r) => s + r.len, 0);
  const nbrs = (id: number) => nbrList[id].map((o) => ({ other: o, runs: runsOf(id, o) }))
    .sort((p, q) => total(q.runs) - total(p.runs) || p.other - q.other);
  const bestRun = (runs: Run[]) => runs.reduce((m, r) => (r.len > m.len ? r : m), runs[0]);

  const isCor = (id: number) => S[id].kind === 'corridor';
  const roomLike = (id: number) => S[id].kind === 'room' || S[id].kind === 'hall';

  // ---------------- doors ----------------
  const D: WD[] = [];
  const addDoor = (run: Run, kind: DoorKind, len: number, rng: Rng | null): WD => {
    len = Math.min(len, run.len);
    let off = 0;
    if (run.len > len) off = rng && run.len >= len + 2 ? rng.int(1, run.len - len - 1) : Math.floor((run.len - len) / 2);
    const d: WD = { id: D.length, a: run.a, b: run.b, x: run.dir === 'v' ? run.x : run.x + off, y: run.dir === 'v' ? run.y + off : run.y, dir: run.dir, len, kind, lock: 0, initiallyOpen: false, dead: false };
    D.push(d);
    return d;
  };
  for (const p of pairEv.values()) {
    if (isCor(p.a) && isCor(p.b)) for (const r of runsOf(p.a, p.b)) addDoor(r, 'open', r.len, null);
  }
  const rD = makeRng(key, 'doors');
  for (const s of S) {
    if (!roomLike(s.id)) continue;
    const cors = nbrs(s.id).filter((n) => isCor(n.other));
    if (!cors.length) continue;
    const r0 = bestRun(cors[0].runs);
    addDoor(r0, 'door', area(s.rect) >= 48 && r0.len >= 5 ? 2 : 1, rD);
  }
  const live = (d: WD) => !d.dead && d.kind !== 'blocked';
  const adjacency = (): number[][] => {
    const adj: number[][] = S.map(() => []);
    for (const d of D) if (live(d)) { adj[d.a].push(d.b); adj[d.b].push(d.a); }
    return adj;
  };
  // connectivity fixer: rooms without corridor access get a door to a connected neighbour
  for (let guard = 0; guard < 60; guard++) {
    const seen = reach(S.length, adjacency(), 0);
    let changed = false;
    for (const s of S) {
      if (seen[s.id] || s.kind === 'outside') continue;
      const n = nbrs(s.id).find((q) => seen[q.other] && S[q.other].kind !== 'outside');
      if (n) { addDoor(bestRun(n.runs), 'door', 1, rD); seen[s.id] = 1; changed = true; }
    }
    if (!changed) break;
  }
  // entrance: bottom-strip room with a corridor door, nearest the centre
  const corDoor = new Set<number>();
  for (const d of D) if (d.kind === 'door') { if (roomLike(d.a) && isCor(d.b)) corDoor.add(d.a); if (roomLike(d.b) && isCor(d.a)) corDoor.add(d.b); }
  const bottom = S.filter((s) => roomLike(s.id) && s.rect.y + s.rect.h === FH && s.rect.w >= 4 && corDoor.has(s.id) && runsOf(s.id, lot).length > 0)
    .sort((p, q) => Math.abs(2 * rcx(p.rect) - W) - Math.abs(2 * rcx(q.rect) - W) || p.id - q.id);
  if (!bottom.length) throw new GenFail('entrance');
  const lobby = bottom[0].id;
  S[lobby].type = 'lobby';
  S[lobby].callsign = 'LOBBY';
  addDoor(bestRun(runsOf(lobby, lot)), 'exit', 2, rD);

  // second doors: turn dead-end rooms into pass-through rooms until only a few dead ends remain
  const deg = new Int32Array(S.length);
  const linked = new Set<number>();
  const relink = () => {
    deg.fill(0); linked.clear();
    for (const d of D) {
      if (!live(d) || S[d.a].kind === 'outside' || S[d.b].kind === 'outside') continue;
      const k = pairKey(d.a, d.b);
      if (!linked.has(k)) { linked.add(k); deg[d.a]++; deg[d.b]++; }
    }
  };
  relink();
  const targetDE = rD.int(t.deadEnds[0], t.deadEnds[1]);
  const deadCount = () => { let n = 0; for (const s of S) if (roomLike(s.id) && s.id !== lobby && deg[s.id] === 1) n++; return n; };
  // a door may only join spaces of the same keycard zone, never the vault, never across rubble-sealed pairs
  const reduceDeadEnds = (rng: Rng) => {
    for (const id of rng.shuffle(S.filter((s) => roomLike(s.id) && s.id !== lobby).map((s) => s.id))) {
      if (deadCount() <= targetDE) break;
      if (deg[id] !== 1) continue;
      const cand = nbrs(id).filter((n) => S[n.other].kind !== 'outside' && S[n.other].kind !== 'vault' && S[n.other].zone === S[id].zone &&
        !linked.has(pairKey(id, n.other)) && !D.some((d) => !d.dead && d.kind === 'blocked' && pairKey(d.a, d.b) === pairKey(id, n.other)) &&
        (isCor(n.other) || (roomLike(n.other) && bestRun(n.runs).len >= 2)));
      if (!cand.length) continue;
      const score = (n: { other: number }) => (isCor(n.other) ? 3 : deg[n.other] === 1 ? 2 : 1);
      cand.sort((p, q) => score(q) - score(p) || p.other - q.other);
      addDoor(bestRun(cand[0].runs), 'door', 1, rng);
      relink();
    }
  };
  reduceDeadEnds(rD);
  // a few extra room-room doors (loops through rooms)
  for (const s of S) {
    if (!roomLike(s.id)) continue;
    for (const n of nbrs(s.id)) {
      if (n.other < s.id || !roomLike(n.other) || linked.has(pairKey(s.id, n.other))) continue;
      if (bestRun(n.runs).len >= 2 && rD.chance(t.roomRoomDoorChance)) { addDoor(bestRun(n.runs), 'door', 1, rD); relink(); }
    }
  }

  // ---------------- rubble (connectivity-preserving chokepoints) ----------------
  const rZ = makeRng(key, 'zones');
  const allConnected = (skip = -1) => { const seen = reach(S.length, adjacency(), lobby, skip); for (let i = 0; i < S.length; i++) if (!seen[i] && i !== skip) return false; return true; };
  if (!allConnected()) throw new GenFail('disconnected');
  let rubble = 0;
  const pRub = t.rubbleBase + t.rubblePerRisk * (risk - 1);
  for (const d of rZ.shuffle(D.filter((d) => !d.dead && d.kind === 'open' && isCor(d.a) && isCor(d.b)))) {
    if (rubble >= t.rubbleMax) break;
    if (!rZ.chance(pRub)) continue;
    d.kind = 'blocked';
    if (!allConnected()) d.kind = 'open'; else rubble++;
  }

  // ---------------- vault: deepest suitable room, single heavy door ----------------
  const gAdj = (): GEdge[][] => {
    const adj: GEdge[][] = S.map(() => []);
    for (const d of D) {
      if (!live(d)) continue;
      const w = Math.abs(rcx(S[d.a].rect) - rcx(S[d.b].rect)) + Math.abs(rcy(S[d.a].rect) - rcy(S[d.b].rect));
      const e = { a: d.a, b: d.b, w };
      adj[d.a].push(e); adj[d.b].push(e);
    }
    return adj;
  };
  const rV = makeRng(key, 'vault');
  const sd = graphDijkstra(S.length, gAdj(), [lobby]);
  const vCands = S.filter((s) => s.kind === 'room' && s.id !== lobby && area(s.rect) >= 12 && area(s.rect) <= 48 && Number.isFinite(sd[s.id]))
    .map((s) => {
      const runs = nbrs(s.id).filter((n) => isCor(n.other)).flatMap((n) => n.runs).filter((r) => r.len >= 3);
      return { s, run: runs.length ? bestRun(runs) : null };
    })
    .filter((c) => c.run !== null)
    .sort((p, q) => sd[q.s.id] - sd[p.s.id] || p.s.id - q.s.id);
  let vault = -1;
  let vaultDoor: WD | null = null;
  for (const c of vCands.slice(0, 8)) {
    const saved = D.filter((d) => !d.dead && (d.a === c.s.id || d.b === c.s.id));
    for (const d of saved) d.dead = true;
    if (!allConnected(c.s.id)) { for (const d of saved) d.dead = false; continue; }
    vault = c.s.id;
    vaultDoor = addDoor(c.run!, 'vault', c.run!.len >= 4 ? 2 : 1, rV);
    break;
  }
  if (vault < 0 || !vaultDoor) throw new GenFail('vault');
  S[vault].kind = 'vault';
  S[vault].type = 'vault';
  S[vault].callsign = 'VAULT';

  // ---------------- keycard zone (max 1 lock): vault wing behind one locked door ----------------
  const locks = Math.min(1, Math.max(0, Math.round(t.locksByRisk[String(risk)] ?? 0)));
  let zones = 1;
  let lockDoor: WD | null = null;
  const facilityN = S.filter((s) => s.kind !== 'outside').length;
  if (locks >= 1) {
    const adj = adjacency();
    const order: number[] = [];
    const seen = new Uint8Array(S.length);
    seen[lobby] = 1;
    order.push(lobby);
    for (let qi = 0; qi < order.length; qi++) for (const v of adj[order[qi]]) if (!seen[v]) { seen[v] = 1; order.push(v); }
    for (const frac of [0.45, 0.4, 0.5, 0.35, 0.55, 0.3, 0.6]) {
      const ball = new Uint8Array(S.length);
      for (const id of order.slice(0, Math.max(2, Math.floor(order.length * frac)))) ball[id] = 1;
      if (ball[vault]) continue;
      const comp: number[] = [vault];
      const inC = new Uint8Array(S.length);
      inC[vault] = 1;
      for (let qi = 0; qi < comp.length; qi++) for (const v of adj[comp[qi]]) if (!ball[v] && !inC[v]) { inC[v] = 1; comp.push(v); }
      if (comp.length < 5 || comp.length > 0.6 * facilityN) continue;
      const boundary = D.filter((d) => live(d) && inC[d.a] !== inC[d.b]);
      const corB = boundary.filter((d) => isCor(d.a) && isCor(d.b));
      const pickFrom = corB.length ? corB : boundary.filter((d) => d.kind === 'door' || d.kind === 'open');
      if (!pickFrom.length) continue;
      lockDoor = pickFrom[rZ.int(0, pickFrom.length - 1)];
      lockDoor.kind = 'locked';
      lockDoor.lock = 1;
      for (const d of boundary) if (d !== lockDoor) d.kind = 'blocked';
      for (const id of comp) S[id].zone = 1;
      zones = 2;
      break;
    }
    if (zones === 1 && attempt < t.maxAttempts - 3) throw new GenFail('zones');
  }

  // vault + zone boundaries removed links: open up new dead ends again (within each zone)
  relink();
  reduceDeadEnds(makeRng(key, 'deadends'));

  // ---------------- security doors at chokepoints (edge betweenness), fire doors, initial states ----------------
  const rS = makeRng(key, 'security');
  const bet = edgeBetweenness(S.length, D.filter(live));
  const nSec = t.securityDoors[String(players)] ?? 2;
  const secC = D.filter((d) => !d.dead && d.kind === 'open' && isCor(d.a) && isCor(d.b))
    .sort((p, q) => (bet.get(pairKey(q.a, q.b)) ?? 0) - (bet.get(pairKey(p.a, p.b)) ?? 0) || p.id - q.id);
  const sec: WD[] = [];
  const dcx = (d: WD) => (d.dir === 'v' ? d.x : d.x + d.len / 2), dcy = (d: WD) => (d.dir === 'v' ? d.y + d.len / 2 : d.y);
  for (const d of secC) {
    if (sec.length >= nSec) break;
    if (sec.some((c) => c.a === d.a || c.a === d.b || c.b === d.a || c.b === d.b)) continue;
    if (sec.some((c) => Math.abs(dcx(c) - dcx(d)) + Math.abs(dcy(c) - dcy(d)) < 8)) continue;
    d.kind = 'security';
    sec.push(d);
  }
  for (const d of D) {
    if (d.dead || d.kind !== 'open' || !isCor(d.a) || !isCor(d.b)) continue;
    if ((S[d.a].type === 'junction' || S[d.b].type === 'junction') && rS.chance(t.fireDoorChance)) d.kind = 'fire';
  }
  const rO = makeRng(key, 'doorstate');
  for (const d of D) {
    d.initiallyOpen = d.kind === 'open' || d.kind === 'security' || d.kind === 'exit' ? true
      : d.kind === 'door' ? rO.chance(0.3) : d.kind === 'fire' ? rO.chance(0.2) : false;
  }

  // ---------------- finalize doors, stamp the van ----------------
  const doors: LayoutDoor[] = [];
  const idMap = new Map<WD, number>();
  for (const d of D) {
    if (d.dead) continue;
    idMap.set(d, doors.length);
    doors.push({ id: doors.length, a: d.a, b: d.b, x: d.x, y: d.y, dir: d.dir, len: d.len, kind: d.kind, lock: d.lock, initiallyOpen: d.initiallyOpen });
  }
  const exitDoor = doors.find((d) => d.kind === 'exit')!;
  const rVan = makeRng(key, 'van');
  const ex = exitDoor.x + exitDoor.len / 2;
  const side = rVan.chance(0.5) ? -1 : 1;
  const off = rVan.int(4, 6);
  let vx0 = Math.round(ex + side * off) - VAN_CARGO_W / 2;
  if (vx0 < 2 || vx0 + VAN_CARGO_W > W - 2) vx0 = Math.round(ex - side * off) - VAN_CARGO_W / 2;
  vx0 = clamp(vx0, 2, W - 2 - VAN_CARGO_W);
  const vy0 = FH + 4;
  if (vy0 + VAN_LEN > H - 2) throw new GenFail('lot');
  const vanId = S.length;
  const van = stampVan(owner, W, vx0, vy0, vanId);
  S.push({ id: vanId, kind: 'room', rect: { ...van.cab }, zone: 0, type: 'van', callsign: 'VAN', dist: 0, light: 'on', open: false, powerZone: 0, perimeter: false });
  doors.push({ id: doors.length, a: lot, b: vanId, x: vx0, y: vy0, dir: 'h', len: VAN_CARGO_W, kind: 'open', lock: 0, initiallyOpen: true });

  const g = buildEdgeGrid({ W, H, owner, spaces: S, doors });

  // ---------------- distances (walk metric, all doors passable = with keys) ----------------
  const cc = S.map((s) => centreCell(owner, W, s.id, s.rect));
  const df = floodCells(g, [cc[lobby]], { mode: 'walk', doorOpen: ALL_OPEN });
  let maxDist = 0;
  for (const s of S) {
    const d = df[cc[s.id]];
    if (!Number.isFinite(d)) throw new GenFail("unreachable");
    s.dist = r1(d);
    if (s.kind !== 'outside' && s.type !== 'van') maxDist = Math.max(maxDist, s.dist);
  }
  const depthOf = (d: number) => (maxDist > 0 ? Math.min(1, d / maxDist) : 0);

  // ---------------- callsigns ----------------
  assignCallsigns(S, makeRng(key, 'names'), t.avoidCallsigns);

  // ---------------- power zones: vault wing ----------------
  const fromVault = graphDijkstra(S.length, gAdj(), [vault]);
  const wingCands = S.filter((s) => s.kind !== 'outside' && s.type !== 'van' && s.id !== lobby)
    .sort((p, q) => fromVault[p.id] - fromVault[q.id] || p.id - q.id);
  const nWing = Math.max(4, Math.round(wingCands.length * t.vaultWingFrac));
  for (const s of wingCands.slice(0, nWing)) s.powerZone = 1;
  const vaultZone = S[vault].powerZone;

  // ---------------- lights (space state) ----------------
  const rLt = makeRng(key, 'lights');
  for (const s of S) {
    if (s.id === lobby) s.light = rLt.chance(0.25) ? 'flicker' : 'on';
    else if (s.id === vault || s.kind === 'outside' || s.type === 'van') s.light = 'on';
    else s.light = rollLight(rLt, t, risk, depthOf(s.dist));
  }

  // ---------------- placement ----------------
  const items = new ItemList();
  const add = items.add;
  const P = new Placer(g, S.length);
  const rP = makeRng(key, 'place');
  const cellX = (c: number) => c % W, cellY = (c: number) => (c - (c % W)) / W;
  const cellPos = (c: number, rng: Rng | null, jitter = 0) => {
    const jx = rng ? (rng.next() - 0.5) * 2 * jitter : 0, jz = rng ? (rng.next() - 0.5) * 2 * jitter : 0;
    return { x: cellX(c) + 0.5 + jx, z: cellY(c) + 0.5 + jz };
  };
  const put = (kind: Parameters<typeof add>[0], space: number, m: Mount, y: number, data?: Record<string, number | string | boolean>) =>
    add(kind, space, m.x, m.z, { y, rot: m.rot, ...(data ? { data } : {}) });

  // van + crew spawns
  addVanItems(van, vanId, add);
  addVanSpawns(van, lot, add);

  // vault: keypad outside the vault door, Core inside
  const vDoorId = idMap.get(vaultDoor)!;
  const vD = doors[vDoorId];
  const vaultOutside = vD.a === vault ? vD.b : vD.a;
  const kp = P.jamb(vD, vaultOutside, 0.06, rP, 0.35) ?? P.pickWall(vaultOutside, rP, 0.06, { allowDoorFront: true, allowJamb: true });
  if (!kp) throw new GenFail('keypad');
  put('keypad', vaultOutside, kp, 1.35, { door: vDoorId, zone: vaultZone });
  const coreCell = cc[vault];
  P.usedCell[coreCell] = 1;
  add('core', vault, rcx(S[vault].rect), rcy(S[vault].rect), { y: 0, data: { door: vDoorId } });

  // light switches beside every room door (inside the room)
  for (const d of doors) {
    for (const sid of [d.a, d.b]) {
      if (sid < 0 || !roomLike(sid) || S[sid].type === 'van' || d.kind === 'blocked') continue;
      const m = P.jamb(d, sid, 0.04, rP, 0.3);
      if (m) put('switch', sid, m, 1.3, { space: sid, door: d.id });
    }
  }

  // twin levers: same power zone as the vault, >= leverMinPathM apart, no line of sight (all doors open)
  const rLev = makeRng(key, 'levers');
  const wing = S.filter((s) => s.powerZone === vaultZone && s.id !== vault && s.kind !== 'outside' && s.type !== 'van');
  const wingRooms = rLev.shuffle(wing.filter((s) => s.kind !== 'corridor').map((s) => s.id));
  const wingCors = rLev.shuffle(wing.filter((s) => s.kind === 'corridor' && area(s.rect) > 4).map((s) => s.id));
  type LevC = { space: number; m: Mount; slotKey: number };
  const levC: LevC[] = [];
  for (const sid of [...wingRooms, ...wingCors]) {
    if (levC.length >= 12) break;
    const free = P.freeSlots(sid);
    if (!free.length) continue;
    const s = free[rLev.int(0, free.length - 1)];
    levC.push({ space: sid, m: P.mount(s, 0.25), slotKey: s.key });
  }
  const levBudget = Math.max(t.leverMinPathM, t.leverIdealPathM) + 16;
  const fields = levC.map((c) => floodCells(g, [c.m.cell], { mode: 'walk', doorOpen: ALL_OPEN, budget: levBudget }));
  let bestPair: [number, number] | null = null;
  let bestScore = -Infinity, bestPath = 0;
  for (let i = 0; i < levC.length; i++) for (let j = i + 1; j < levC.length; j++) {
    if (levC[i].space === levC[j].space) continue;
    const pd = fields[i][levC[j].m.cell];
    if (!(pd >= t.leverMinPathM) || !Number.isFinite(pd)) continue;
    if (los(g, levC[i].m.x, levC[i].m.z, levC[j].m.x, levC[j].m.z, ALL_OPEN)) continue;
    const sc = -Math.abs(pd - t.leverIdealPathM) + (S[levC[i].space].kind !== 'corridor' ? 3 : 0) + (S[levC[j].space].kind !== 'corridor' ? 3 : 0);
    if (sc > bestScore) { bestScore = sc; bestPair = [i, j]; bestPath = pd; }
  }
  if (!bestPair) throw new GenFail('levers');
  {
    const [i, j] = bestPair;
    const slotOf = (c: LevC) => P.slots[c.space].find((s) => s.key === c.slotKey)!;
    P.take(slotOf(levC[i])); P.take(slotOf(levC[j]));
    const a = put('lever', levC[i].space, levC[i].m, 1.2, { pair: 0, zone: vaultZone });
    const b = put('lever', levC[j].space, levC[j].m, 1.2, { pair: 1, zone: vaultZone });
    a.data!.other = b.id; b.data!.other = a.id;
  }

  // keycard: zone 0, far from its lock (path distance inside zone 0), prefers dead-end rooms
  let keyDist = 0;
  if (lockDoor) {
    const lid = idMap.get(lockDoor)!;
    const ld = doors[lid];
    const zside = S[ld.a].zone === 0 ? ld.a : ld.b;
    const lf = floodCells(g, [cc[zside]], { mode: 'walk', doorOpen: (id) => id !== lid });
    relink();
    const kc = S.filter((s) => roomLike(s.id) && s.zone === 0 && s.id !== lobby && s.type !== 'van' && Number.isFinite(lf[cc[s.id]]))
      .sort((p, q) => lf[cc[q.id]] + (deg[q.id] === 1 ? 15 : 0) - (lf[cc[p.id]] + (deg[p.id] === 1 ? 15 : 0)) || p.id - q.id);
    if (!kc.length) throw new GenFail('keycard');
    const kr = kc[0].id;
    const kcell = P.pickFloor(kr, rP, { score: (c) => -Math.abs(cellX(c) + 0.5 - rcx(S[kr].rect)) - Math.abs(cellY(c) + 0.5 - rcy(S[kr].rect)) });
    if (kcell < 0) throw new GenFail('keycard-cell');
    const kp2 = cellPos(kcell, null);
    keyDist = lf[kcell];
    add('keycard', kr, kp2.x, kp2.z, { y: 0.85, data: { lock: 1, door: lid } });
  }

  // hiding lockers: ~one per two rooms, then coverage (every facility cell within hidingCoverageM)
  const hideCells: number[] = [];
  const addLocker = (sid: number, m: Mount) => { hideCells.push(m.cell); put('hiding', sid, m, 0, { type: 'locker' }); };
  for (const s of S) {
    if (!roomLike(s.id) || s.id === lobby || s.type === 'van' || !rP.chance(t.hidingRoomChance)) continue;
    const m = P.pickWall(s.id, rP, 0.55, { solid: true });
    if (m) addLocker(s.id, m);
  }
  const facilityCell = (c: number) => { const o = owner[c]; return o >= 0 && S[o].kind !== 'outside' && S[o].type !== 'van' && o !== vault; };
  let covered = false;
  // hf = path distance to the nearest locker; exact within the coverage radius, an upper bound beyond (updated
  // incrementally with bounded floods from each new locker)
  const hf = floodCells(g, hideCells.length ? hideCells : [cc[lobby]], { mode: 'walk', doorOpen: ALL_OPEN });
  const nf = new Float32Array(W * H);
  for (let guard = 0; guard < 80; guard++) {
    let far = -1, fd = t.hidingCoverageM;
    for (let c = 0; c < W * H; c++) if (facilityCell(c) && hf[c] > fd) { fd = hf[c]; far = c; }
    if (far < 0) { covered = true; break; }
    // new locker: within half the coverage radius (by path) of the uncovered cell, as deep into the
    // uncovered region as possible; else the path-nearest free slot
    const ff = floodCells(g, [far], { mode: 'walk', doorOpen: ALL_OPEN, budget: t.hidingCoverageM });
    let best: { sid: number; sl: ReturnType<Placer['freeSlots']>[number] } | null = null;
    let bestScore = -Infinity;
    for (const s of S) {
      if (s.kind === 'outside' || s.type === 'van' || s.id === vault) continue;
      for (const sl of P.freeSlots(s.id, { solid: true })) {
        const d = ff[sl.cell];
        if (!Number.isFinite(d)) continue;
        const sc = d <= t.hidingCoverageM * 0.5 ? 1000 + Math.min(hf[sl.cell], 500) : -d;
        if (sc > bestScore) { bestScore = sc; best = { sid: s.id, sl }; }
      }
    }
    if (!best) throw new GenFail('hiding');
    P.take(best.sl, true);
    addLocker(best.sid, P.mount(best.sl, 0.55));
    floodCells(g, [best.sl.cell], { mode: 'walk', doorOpen: ALL_OPEN, budget: t.hidingCoverageM }, nf);
    for (let c = 0; c < W * H; c++) if (nf[c] < hf[c]) hf[c] = nf[c];
  }
  if (!covered) throw new GenFail('hiding-coverage');

  // notes: 4-6 wall slots spread by farthest-point sampling over rooms
  const noteRooms = S.filter((s) => roomLike(s.id) && s.type !== 'van');
  const spreadPick = (cands: WS[], n: number, rng: Rng, seedIds: number[] = []): WS[] => {
    const picked: WS[] = [];
    const pts = seedIds.map((id) => S[id]);
    const md = (s: WS) => Math.min(Infinity, ...[...pts, ...picked].map((p) => Math.abs(rcx(p.rect) - rcx(s.rect)) + Math.abs(rcy(p.rect) - rcy(s.rect))));
    const pool = cands.slice();
    if (!pts.length && pool.length) picked.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
    while (picked.length < n && pool.length) {
      let bi = 0, bd = -1;
      for (let i = 0; i < pool.length; i++) { const d = md(pool[i]); if (d > bd) { bd = d; bi = i; } }
      picked.push(pool.splice(bi, 1)[0]);
    }
    return picked;
  };
  const nNotes = rP.int(t.notesMin, t.notesMax);
  let noteIdx = 0;
  for (const s of spreadPick(noteRooms, nNotes + 2, rP)) {
    if (noteIdx >= nNotes) break;
    const m = P.pickWall(s.id, rP, 0.02);
    if (m) put('note', s.id, m, 1.45, { idx: noteIdx++ });
  }
  if (noteIdx < t.notesMin) throw new GenFail('notes');

  // intercoms: 2-3, spread away from the lobby
  const nInt = rP.int(t.intercomsMin, t.intercomsMax);
  let nIntPlaced = 0;
  for (const s of spreadPick(S.filter((s) => (roomLike(s.id) || (s.kind === 'corridor' && area(s.rect) > 4)) && s.id !== lobby && s.type !== 'van'), nInt + 2, rP, [lobby])) {
    if (nIntPlaced >= nInt) break;
    const m = P.pickWall(s.id, rP, 0.08);
    if (m) { put('intercom', s.id, m, 1.6, { space: s.id }); nIntPlaced++; }
  }

  // vents: Listener-only shortcuts between rooms that are far by path but close as the crow flies
  const ventRooms = S.filter((s) => roomLike(s.id) && s.id !== lobby && s.type !== 'van');
  const adjG = gAdj();
  const vdist = ventRooms.map((s) => graphDijkstra(S.length, adjG, [s.id]));
  const vPairs: { i: number; j: number; score: number }[] = [];
  for (let i = 0; i < ventRooms.length; i++) for (let j = i + 1; j < ventRooms.length; j++) {
    const gd = vdist[i][ventRooms[j].id];
    const md = Math.abs(rcx(ventRooms[i].rect) - rcx(ventRooms[j].rect)) + Math.abs(rcy(ventRooms[i].rect) - rcy(ventRooms[j].rect));
    if (!Number.isFinite(gd) || gd < 15 || md > 0.8 * gd) continue;
    vPairs.push({ i, j, score: gd - md });
  }
  vPairs.sort((p, q) => q.score - p.score || p.i - q.i || p.j - q.j);
  const ventUsed = new Set<number>();
  let nVent = 0;
  const wantVents = t.ventPairs[String(players)] ?? 2;
  for (const vp of vPairs) {
    if (nVent >= wantVents) break;
    const A = ventRooms[vp.i], B = ventRooms[vp.j];
    if (ventUsed.has(A.id) || ventUsed.has(B.id)) continue;
    const ma = P.pickWall(A.id, rP, 0.05);
    if (!ma) continue;
    const mb = P.pickWall(B.id, rP, 0.05);
    if (!mb) continue;
    const va = put('vent', A.id, ma, 0.35, { pair: nVent });
    const vb = put('vent', B.id, mb, 0.35, { pair: nVent });
    va.data!.to = vb.id; vb.data!.to = va.id;
    ventUsed.add(A.id); ventUsed.add(B.id);
    nVent++;
  }

  // monster spawn slots (the monsters track picks which to use)
  const rM = makeRng(key, 'monsters');
  const spawnable = (c: number) => { const o = owner[c]; return o >= 0 && o !== lobby && o !== vault && S[o].kind !== 'outside' && S[o].type !== 'van' && !P.usedCell[c] && !P.doorFront[c]; };
  const cellsWhere = (f: (c: number, d: number) => boolean) => { const out: number[] = []; for (let c = 0; c < W * H; c++) if (spawnable(c) && f(c, depthOf(df[c]))) out.push(c); return out; };
  const man = (a: number, b: number) => Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
  const spreadCells = (cands: number[], n: number, minSep: number): number[] => {
    const out: number[] = [];
    if (!cands.length) return out;
    out.push(cands[rM.int(0, cands.length - 1)]);
    while (out.length < n) {
      let best = -1, bd = -1;
      for (const c of cands) { const d = Math.min(...out.map((o) => man(o, c))); if (d > bd) { bd = d; best = c; } }
      if (best < 0 || bd < minSep) break;
      out.push(best);
    }
    return out;
  };
  const houndC = cellsWhere((c, d) => d >= 0.45 && d <= 0.8 && df[c] >= 15 && S[owner[c]].kind !== 'vault');
  const houndCells = spreadCells(houndC.length ? houndC : cellsWhere((c) => df[c] >= 10), 2, 10);
  const listenC = cellsWhere((c, d) => d >= 0.7 && S[owner[c]].kind !== 'corridor');
  const listenCells = spreadCells(listenC.length ? listenC : cellsWhere((_c, d) => d >= 0.5), 2, 8);
  const manC = cellsWhere((_c, d) => d >= 0.5 && d <= 0.9);
  const manCells = spreadCells(manC.length ? manC : cellsWhere((_c, d) => d >= 0.3), 3, 8);
  if (!houndCells.length || !listenCells.length || !manCells.length) throw new GenFail('spawns');
  houndCells.forEach((c, i) => { P.usedCell[c] = 1; const p = cellPos(c, null); add('spawn_hound', owner[c], p.x, p.z, { rot: rM.int(0, 3) * (Math.PI / 2), data: { order: i, chained: false } }); });
  listenCells.forEach((c, i) => { P.usedCell[c] = 1; const p = cellPos(c, null); add('spawn_listener', owner[c], p.x, p.z, { data: { order: i } }); });
  manCells.forEach((c, i) => { P.usedCell[c] = 1; const p = cellPos(c, null); add('spawn_mannequin', owner[c], p.x, p.z, { rot: rM.int(0, 3) * (Math.PI / 2), data: { order: i } }); });

  // loot slots weighted by depth (tier 0..2)
  const rLoot = makeRng(key, 'loot');
  for (const s of S) {
    if (!roomLike(s.id) || s.type === 'van') continue;
    const dep = depthOf(s.dist);
    const n = Math.min(t.lootMaxPerRoom, Math.floor((area(s.rect) / t.lootAreaPerItem) * (0.6 + dep) + rLoot.next()));
    for (let i = 0; i < n; i++) {
      const c = P.pickFloor(s.id, rLoot);
      if (c < 0) break;
      const p = cellPos(c, rLoot, 0.2);
      const tier = clamp(Math.floor(dep * 3 + (rLoot.next() - 0.5) * 0.8), 0, 2);
      add('loot', s.id, p.x, p.z, { y: 0, rot: rLoot.int(0, 7) * (Math.PI / 4), data: { tier } });
    }
  }

  // furniture: wall-backed asset props; never on cells players must reach (wall items, loot, the Core)
  const keep = new Uint8Array(W * H);
  for (const it of items.items) {
    if (['lever', 'keypad', 'switch', 'note', 'intercom', 'vent', 'hiding', 'loot', 'core', 'keycard'].includes(it.kind)) keep[Math.floor(it.z) * W + Math.floor(it.x)] = 1;
  }
  for (const it of items.items) if (it.kind === 'hiding') {
    // the cell in front of a locker's door
    const [nx, nz] = normalOfYaw(it.rot ?? 0);
    const fx = Math.floor(it.x + nx * 0.9), fz = Math.floor(it.z + nz * 0.9);
    if (fx >= 0 && fz >= 0 && fx < W && fz < H) keep[fz * W + fx] = 1;
  }
  const nProps = placeDecor(W, H, owner, S, P, items, makeRng(key, 'decor'), keep);

  // light fixtures
  addFixtures(S, items, rLt, t, WORLD.wallH, { lot, van: vanId, exitDoor, lotLamps: 3 });

  // ---------------- metrics + invariants ----------------
  relink();
  const facIds = S.filter((s) => s.kind !== 'outside' && s.type !== 'van').map((s) => s.id);
  const facSet = new Set(facIds);
  const pairs = new Set<number>();
  for (const d of doors) if (d.kind !== 'blocked' && facSet.has(d.a) && facSet.has(d.b)) pairs.add(pairKey(d.a, d.b));
  const loops = pairs.size - facIds.length + 1;
  if (loops < 2) throw new GenFail('loops');
  const deadEnds = S.filter((s) => (roomLike(s.id) && s.id !== lobby && s.type !== 'van') && deg[s.id] === 1).length;
  const roomsN = S.filter((s) => (roomLike(s.id) || s.kind === 'vault') && s.type !== 'van').length;

  const spaces: LayoutSpace[] = S.map((s) => ({
    id: s.id, kind: s.kind, rect: s.rect, zone: s.zone, type: s.type, callsign: s.callsign, dist: s.dist,
    light: s.light, open: s.open, powerZone: s.powerZone,
  }));
  const L: LevelLayout = {
    genVersion: GEN_VERSION,
    kind: 'facility',
    seed,
    hash: '',
    theme: 'facility',
    W, H,
    owner: Array.from(owner),
    spaces,
    doors,
    items: items.items,
    entrance: lobby,
    van,
    zones,
    wallH: WORLD.wallH,
    metrics: {
      players, risk, attempt, facilityH: FH, lotDepth: LD, lot, vanSpace: vanId, vault, vaultDoor: vDoorId,
      vaultPowerZone: vaultZone, rooms: roomsN, halls: S.filter((s) => s.kind === 'hall').length,
      corridors: S.filter((s) => s.kind === 'corridor').length, spaces: S.length, doors: doors.length,
      loops, deadEnds, maxDistM: Math.round(maxDist), locks: lockDoor ? 1 : 0, lockDoor: lockDoor ? idMap.get(lockDoor)! : -1,
      keyDistM: Math.round(keyDist), security: sec.length, fire: doors.filter((d) => d.kind === 'fire').length, rubble,
      leverPathM: Math.round(bestPath), loot: items.count('loot'), hiding: items.count('hiding'), notes: items.count('note'),
      vents: items.count('vent'), intercoms: items.count('intercom'), lights: items.count('light'), props: nProps,
    },
  };
  L.hash = layoutHash(L);
  return L;
}

/** Brandes edge betweenness (unweighted) over the space graph; keyed by pairKey(a, b). */
function edgeBetweenness(n: number, doors: readonly { a: number; b: number }[]): Map<number, number> {
  const adj: number[][] = Array.from({ length: n }, () => []);
  const seenPair = new Set<number>();
  for (const d of doors) {
    if (d.a < 0 || d.b < 0) continue;
    const k = pairKey(d.a, d.b);
    if (seenPair.has(k)) continue;
    seenPair.add(k);
    adj[d.a].push(d.b); adj[d.b].push(d.a);
  }
  const bet = new Map<number, number>();
  const sigma = new Float64Array(n), dist = new Int32Array(n), delta = new Float64Array(n);
  const pred: number[][] = Array.from({ length: n }, () => []);
  for (let s = 0; s < n; s++) {
    sigma.fill(0); dist.fill(-1); delta.fill(0);
    for (const p of pred) p.length = 0;
    const stack: number[] = [];
    const q = [s];
    sigma[s] = 1; dist[s] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const v = q[qi];
      stack.push(v);
      for (const w of adj[v]) {
        if (dist[w] < 0) { dist[w] = dist[v] + 1; q.push(w); }
        if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; pred[w].push(v); }
      }
    }
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of pred[w]) {
        const c = (sigma[v] / sigma[w]) * (1 + delta[w]);
        const k = pairKey(v, w);
        bet.set(k, (bet.get(k) ?? 0) + c);
        delta[v] += c;
      }
    }
  }
  return bet;
}
