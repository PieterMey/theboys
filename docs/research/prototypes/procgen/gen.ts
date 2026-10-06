// Prototype: lattice-corridor + BSP-room interior generator with zones/locks/keys, placement and metrics.
// Erasable TypeScript only (runs with `node gen.ts` on Node 24 type stripping).

// ---------------- RNG (bryc xmur3 + sfc32) ----------------
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
export function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
export function makeRng(seed: string | number, stage: string) {
  const h = xmur3(`${seed}|gen-v1|${stage}`);
  const f = sfc32(h(), h(), h(), h());
  for (let i = 0; i < 15; i++) f();
  const int = (lo: number, hi: number) => lo + Math.floor(f() * (hi - lo + 1));
  return {
    float: f,
    int,
    chance: (p: number) => f() < p,
    pick<T>(a: readonly T[]): T { return a[Math.floor(f() * a.length)]; },
    shuffle<T>(a: T[]): T[] {
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    },
  };
}
export type Rng = ReturnType<typeof makeRng>;

// ---------------- Types ----------------
export type Rect = { x: number; y: number; w: number; h: number };
export type Space = { id: number; kind: 'corridor' | 'room'; rect: Rect; zone: number; type: string; dist: number; perimeter: boolean };
// v: edge on vertical line x, between cells (x-1,y)/(x,y), spanning y..y+len ; h: edge on horizontal line y between (x,y-1)/(x,y), spanning x..x+len
export type Door = { id: number; a: number; b: number; x: number; y: number; dir: 'v' | 'h'; len: number; kind: 'open' | 'door' | 'locked' | 'blocked' | 'exit'; lock: number };
export type Item = { kind: string; space: number; x: number; y: number; data?: Record<string, number | string> };
export type Level = {
  seed: string; W: number; H: number; owner: Int32Array; spaces: Space[]; doors: Door[]; items: Item[];
  entrance: number; zones: number; metrics: Record<string, number>;
};
export type GenParams = { seed: string; W: number; H: number; difficulty: number; locks: number };

// ---------------- helpers ----------------
function partition(total: number, n: number, minEach: number, rng: Rng): number[] {
  const s = new Array<number>(n).fill(minEach);
  let rest = total - n * minEach;
  while (rest > 0) { s[rng.int(0, n - 1)]++; rest--; }
  return s;
}
const area = (r: Rect) => r.w * r.h;
const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;

function bsp(r: Rect, rng: Rng, out: Rect[], minSide: number, maxSide: number, maxArea: number) {
  const canW = r.w >= 2 * minSide, canH = r.h >= 2 * minSide;
  const tooBig = r.w > maxSide || r.h > maxSide || area(r) > maxArea;
  if ((!canW && !canH) || (!tooBig && rng.chance(0.35))) { out.push(r); return; }
  let splitW = r.w > r.h ? true : r.h > r.w ? false : rng.chance(0.5);
  if (splitW && !canW) splitW = false;
  if (!splitW && !canH) splitW = true;
  if (splitW) {
    const s = rng.int(minSide, r.w - minSide);
    bsp({ x: r.x, y: r.y, w: s, h: r.h }, rng, out, minSide, maxSide, maxArea);
    bsp({ x: r.x + s, y: r.y, w: r.w - s, h: r.h }, rng, out, minSide, maxSide, maxArea);
  } else {
    const s = rng.int(minSide, r.h - minSide);
    bsp({ x: r.x, y: r.y, w: r.w, h: s }, rng, out, minSide, maxSide, maxArea);
    bsp({ x: r.x, y: r.y + s, w: r.w, h: r.h - s }, rng, out, minSide, maxSide, maxArea);
  }
}

// ---------------- generator ----------------
export function generate(p: GenParams): Level {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { const L = generateOnce({ ...p, seed: attempt ? `${p.seed}#${attempt}` : p.seed }); if (L.metrics.unreachable === 0) return L; } catch { /* retry with derived seed */ }
  }
  throw new Error('generation failed: ' + p.seed);
}
export function generateOnce(p: GenParams): Level {
  const t0 = performance.now();
  const { W, H, seed } = p;
  const rL = makeRng(seed, 'layout');
  const cw = 2; // corridor width (cells = metres)
  const mL = rL.int(4, 7), mR = rL.int(4, 7), mT = rL.int(4, 7), mB = rL.int(4, 7);
  const spanX = W - mL - mR - cw, spanY = H - mT - mB - cw;
  const nbx = Math.max(1, Math.round(spanX / (cw + 11))), nby = Math.max(1, Math.round(spanY / (cw + 11)));
  const bw = partition(spanX - nbx * cw, nbx, 6, rL), bh = partition(spanY - nby * cw, nby, 6, rL);
  const xs = [mL]; for (const b of bw) xs.push(xs[xs.length - 1] + cw + b);
  const ys = [mT]; for (const b of bh) ys.push(ys[ys.length - 1] + cw + b);
  // inner vertical lines: absent / partial / full (outer two always full); horizontal lines always full
  const vPresent: boolean[][] = xs.map((_, i) => {
    const segs = new Array<boolean>(nby).fill(true);
    if (i === 0 || i === xs.length - 1) return segs;
    const r = rL.float();
    if (r < 0.2) return segs.fill(false);
    if (r < 0.55) { const a = rL.int(0, nby - 1), b = rL.int(a, nby - 1); for (let j = 0; j < nby; j++) segs[j] = j >= a && j <= b; }
    return segs;
  });

  const owner = new Int32Array(W * H).fill(-1);
  const spaces: Space[] = [];
  const addSpace = (kind: Space['kind'], rect: Rect, type: string, perimeter = false) => {
    const id = spaces.length;
    spaces.push({ id, kind, rect, zone: -1, type, dist: Infinity, perimeter });
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) owner[y * W + x] = id;
    return id;
  };
  // corridors: horizontal lines split into junction squares + segments; vertical segments where present
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i < xs.length; i++) {
      addSpace('corridor', { x: xs[i], y: ys[j], w: cw, h: cw }, 'junction');
      if (i < xs.length - 1) addSpace('corridor', { x: xs[i] + cw, y: ys[j], w: xs[i + 1] - xs[i] - cw, h: cw }, 'hall');
    }
  }
  for (let i = 0; i < xs.length; i++) for (let j = 0; j < nby; j++)
    if (vPresent[i][j]) addSpace('corridor', { x: xs[i], y: ys[j] + cw, w: cw, h: ys[j + 1] - ys[j] - cw }, 'hall');

  // blocks
  const blocks: { r: Rect; perimeter: boolean }[] = [];
  for (let j = 0; j < nby; j++) {
    const present = xs.map((_, i) => i).filter((i) => vPresent[i][j]);
    for (let k = 0; k < present.length - 1; k++) {
      const a = present[k], b = present[k + 1];
      blocks.push({ r: { x: xs[a] + cw, y: ys[j] + cw, w: xs[b] - xs[a] - cw, h: ys[j + 1] - ys[j] - cw }, perimeter: false });
    }
  }
  const yTop = ys[0], yBot = ys[ys.length - 1] + cw, xLeft = xs[0], xRight = xs[xs.length - 1] + cw;
  blocks.push({ r: { x: 0, y: 0, w: W, h: yTop }, perimeter: true });
  blocks.push({ r: { x: 0, y: yBot, w: W, h: H - yBot }, perimeter: true });
  blocks.push({ r: { x: 0, y: yTop, w: xLeft, h: yBot - yTop }, perimeter: true });
  blocks.push({ r: { x: xRight, y: yTop, w: W - xRight, h: yBot - yTop }, perimeter: true });

  for (const b of blocks) {
    const rooms: Rect[] = [];
    if (!b.perimeter && area(b.r) >= 40 && area(b.r) <= 220 && rL.chance(0.12)) rooms.push(b.r); // big hall
    else bsp(b.r, rL, rooms, 3, 8, 48);
    for (const r of rooms) addSpace('room', r, area(r) >= 60 ? 'hall-room' : area(r) <= 12 ? 'small' : 'room', b.perimeter);
  }

  // shared edge runs between space pairs (and exterior = -1)
  type Run = { a: number; b: number; x: number; y: number; dir: 'v' | 'h'; len: number };
  const pairEdges = new Map<number, { a: number; b: number; edges: { x: number; y: number; dir: 'v' | 'h' }[] }>();
  const keyOf = (a: number, b: number) => (a < b ? (a + 1) * 65536 + (b + 1) : (b + 1) * 65536 + (a + 1));
  const pushEdge = (a: number, b: number, x: number, y: number, dir: 'v' | 'h') => {
    if (a === b) return;
    const k = keyOf(a, b);
    let e = pairEdges.get(k);
    if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), edges: [] }; pairEdges.set(k, e); }
    e.edges.push({ x, y, dir });
  };
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
  for (let y = 0; y < H; y++) for (let x = 0; x <= W; x++) pushEdge(own(x - 1, y), own(x, y), x, y, 'v');
  for (let y = 0; y <= H; y++) for (let x = 0; x < W; x++) pushEdge(own(x, y - 1), own(x, y), x, y, 'h');
  const runsOf = (k: number): Run[] => {
    const e = pairEdges.get(k);
    if (!e) return [];
    const runs: Run[] = [];
    const sorted = [...e.edges].sort((p, q) => (p.dir === q.dir ? (p.dir === 'v' ? p.x - q.x || p.y - q.y : p.y - q.y || p.x - q.x) : p.dir < q.dir ? -1 : 1));
    for (const ed of sorted) {
      const last = runs[runs.length - 1];
      if (last && last.dir === ed.dir && (ed.dir === 'v' ? last.x === ed.x && last.y + last.len === ed.y : last.y === ed.y && last.x + last.len === ed.x)) last.len++;
      else runs.push({ a: e.a, b: e.b, x: ed.x, y: ed.y, dir: ed.dir, len: 1 });
    }
    return runs;
  };

  const doors: Door[] = [];
  const addDoor = (run: Run, kind: Door['kind'], len: number, rng: Rng | null): Door => {
    let off = 0;
    if (len < run.len) off = run.len >= len + 2 && rng ? rng.int(1, run.len - len - 1) : 0;
    const d: Door = { id: doors.length, a: run.a, b: run.b, x: run.dir === 'v' ? run.x : run.x + off, y: run.dir === 'v' ? run.y + off : run.y, dir: run.dir, len, kind, lock: 0 };
    doors.push(d);
    return d;
  };
  // corridor-corridor openings
  for (const [k, e] of pairEdges) {
    if (e.a < 0) continue;
    if (spaces[e.a].kind === 'corridor' && spaces[e.b].kind === 'corridor') for (const r of runsOf(k)) addDoor(r, 'open', r.len, null);
  }
  // room doors
  const rD = makeRng(seed, 'doors');
  const neighbors = (id: number) => {
    const out: { other: number; runs: Run[]; total: number }[] = [];
    for (const [k, e] of pairEdges) {
      if (e.a !== id && e.b !== id) continue;
      const other = e.a === id ? e.b : e.a;
      if (other < 0) continue;
      const runs = runsOf(k);
      out.push({ other, runs, total: runs.reduce((s, r) => s + r.len, 0) });
    }
    return out.sort((p, q) => q.total - p.total || p.other - q.other);
  };
  const nbrCache = new Map<number, ReturnType<typeof neighbors>>();
  const nb = (id: number) => { let v = nbrCache.get(id); if (!v) { v = neighbors(id); nbrCache.set(id, v); } return v; };
  const bestRun = (runs: Run[]) => runs.reduce((m, r) => (r.len > m.len ? r : m), runs[0]);
  for (const s of spaces) {
    if (s.kind !== 'room') continue;
    const cors = nb(s.id).filter((n) => spaces[n.other].kind === 'corridor');
    if (cors.length === 0) continue;
    const big = area(s.rect) >= 48;
    const r0 = bestRun(cors[0].runs);
    addDoor(r0, 'door', big && r0.len >= 5 ? 2 : 1, rD);
    if (cors.length > 1 && (area(s.rect) >= 30 || rD.chance(0.15))) {
      const alt = cors.find((c, i) => i > 0 && bestRun(c.runs).dir !== r0.dir) ?? cors[1];
      const r1 = bestRun(alt.runs);
      if (r1.len >= 1) addDoor(r1, 'door', 1, rD);
    }
  }
  // connectivity fixer: rooms without corridor access get a door to a connected neighbour room
  const adjOf = () => {
    const adj: number[][] = spaces.map(() => []);
    for (const d of doors) if (d.kind !== 'blocked' && d.a >= 0) { adj[d.a].push(d.b); adj[d.b].push(d.a); }
    return adj;
  };
  const bfsFrom = (src: number, adj: number[][]) => {
    const seen = new Uint8Array(spaces.length); const q = [src]; seen[src] = 1;
    while (q.length) { const u = q.shift()!; for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; q.push(v); } }
    return seen;
  };
  for (let guard = 0; guard < 50; guard++) {
    const seen = bfsFrom(0, adjOf());
    let changed = false;
    for (const s of spaces) {
      if (seen[s.id]) continue;
      const n = nb(s.id).find((n) => seen[n.other]);
      if (n) { addDoor(bestRun(n.runs), 'door', 1, rD); seen[s.id] = 1; changed = true; }
    }
    if (!changed) break;
  }
  // extra room-room doors (loops through rooms)
  for (const s of spaces) {
    if (s.kind !== 'room') continue;
    for (const n of nb(s.id)) {
      if (n.other < s.id || spaces[n.other].kind !== 'room') continue;
      const already = doors.some((d) => (d.a === s.id && d.b === n.other) || (d.b === s.id && d.a === n.other));
      if (!already && bestRun(n.runs).len >= 2 && rD.chance(0.12)) addDoor(bestRun(n.runs), 'door', 1, rD);
    }
  }

  // entrance: bottom perimeter room with a corridor door, nearest to horizontal centre
  const corridorDoorRooms = new Set<number>();
  for (const d of doors) {
    if (d.kind !== 'door') continue;
    if (spaces[d.a].kind === 'room' && spaces[d.b].kind === 'corridor') corridorDoorRooms.add(d.a);
    if (spaces[d.b].kind === 'room' && spaces[d.a].kind === 'corridor') corridorDoorRooms.add(d.b);
  }
  const bottomRooms = spaces.filter((s) => s.kind === 'room' && s.rect.y + s.rect.h === H && corridorDoorRooms.has(s.id) && s.rect.w >= 3);
  bottomRooms.sort((p, q) => Math.abs(cx(p.rect) - W / 2) - Math.abs(cx(q.rect) - W / 2) || p.id - q.id);
  const entrance = bottomRooms[0].id;
  spaces[entrance].type = 'lobby';
  const exterior = (id: number) => runsOf(keyOf(-1, id));
  addDoor(bestRun(exterior(entrance)), 'exit', 2, rD).lock = -1;

  // passable graph + Dijkstra on centre distances
  const passable = (d: Door, keys: Set<number> | null) => d.a >= 0 && (d.kind === 'open' || d.kind === 'door' || (d.kind === 'locked' && (keys === null || keys.has(d.lock))));
  const adjW = (keys: Set<number> | null) => {
    const adj: { v: number; w: number; door: number }[][] = spaces.map(() => []);
    for (const d of doors) {
      if (!passable(d, keys)) continue;
      const w = Math.abs(cx(spaces[d.a].rect) - cx(spaces[d.b].rect)) + Math.abs(cy(spaces[d.a].rect) - cy(spaces[d.b].rect)); // Manhattan: exact, engine-independent
      adj[d.a].push({ v: d.b, w, door: d.id }); adj[d.b].push({ v: d.a, w, door: d.id });
    }
    return adj;
  };
  const dijkstra = (srcs: number[], adj: { v: number; w: number }[][]) => {
    const dist = new Float64Array(spaces.length).fill(Infinity);
    const done = new Uint8Array(spaces.length);
    for (const s of srcs) dist[s] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = 1;
      for (const e of adj[u]) if (dist[u] + e.w < dist[e.v]) dist[e.v] = dist[u] + e.w;
    }
    return dist;
  };

  // optional rubble: block a few corridor openings while staying connected (creates chokepoints)
  const rZ = makeRng(seed, 'zones');
  for (const d of rZ.shuffle(doors.filter((d) => d.kind === 'open'))) {
    if (!rZ.chance(0.12 + 0.1 * p.difficulty)) continue;
    d.kind = 'blocked';
    if (bfsFrom(entrance, adjOf()).some((v) => v === 0)) d.kind = 'open';
  }

  for (const d of doors) if (d.kind === 'open' && d.a >= 0 && (spaces[d.a].type === 'junction' || spaces[d.b].type === 'junction') && rZ.chance(0.25)) d.kind = 'door';
  // zones: nested BFS balls on the FULL space graph (rooms + corridors); each new zone gets exactly one locked entry,
  // every other boundary door becomes 'blocked' (rubble / jammed door / shutter)
  const isCor = (id: number) => spaces[id].kind === 'corridor';
  const openish = (d: Door) => d.a >= 0 && (d.kind === 'open' || d.kind === 'door');
  for (const s of spaces) s.zone = 0;
  let region = spaces.map((s) => s.id);
  let seedNode = entrance;
  let zonesMade = 0;
  for (let z = 1; z <= p.locks; z++) {
    const inRegion = new Uint8Array(spaces.length); for (const id of region) inRegion[id] = 1;
    const adj: number[][] = spaces.map(() => []);
    for (const d of doors) if (openish(d) && inRegion[d.a] && inRegion[d.b]) { adj[d.a].push(d.b); adj[d.b].push(d.a); }
    const order: number[] = []; const seen = new Uint8Array(spaces.length); const q = [seedNode]; seen[seedNode] = 1;
    while (q.length) { const u = q.shift()!; order.push(u); for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; q.push(v); } }
    const frac = z === 1 ? 0.45 : 0.5;
    const ball = new Uint8Array(spaces.length); for (const id of order.slice(0, Math.max(1, Math.floor(order.length * frac)))) ball[id] = 1;
    const comp = new Int32Array(spaces.length).fill(-1); const sizes: number[] = [];
    for (const s0 of order) {
      if (ball[s0] || comp[s0] >= 0) continue;
      const c = sizes.length; sizes.push(0); const qq = [s0]; comp[s0] = c;
      while (qq.length) { const u = qq.shift()!; sizes[c]++; for (const v of adj[u]) if (!ball[v] && comp[v] < 0) { comp[v] = c; qq.push(v); } }
    }
    if (sizes.length === 0) break;
    const big = sizes.indexOf(Math.max(...sizes));
    if (sizes[big] < 6) break;
    const next = order.filter((id) => comp[id] === big); const inNext = new Uint8Array(spaces.length); for (const id of next) inNext[id] = 1;
    const boundary = doors.filter((d) => openish(d) && inNext[d.a] !== inNext[d.b]);
    if (boundary.length === 0) break;
    rZ.shuffle(boundary);
    const lockDoor = boundary.find((d) => isCor(d.a) && isCor(d.b)) ?? boundary[0];
    lockDoor.kind = 'locked'; lockDoor.lock = z;
    for (const d of boundary) if (d !== lockDoor) d.kind = 'blocked';
    for (const id of next) spaces[id].zone = z;
    region = next;
    seedNode = inNext[lockDoor.a] ? lockDoor.a : lockDoor.b;
    zonesMade = z;
  }

  // distances from entrance with all keys (for placement scoring)
  const all = new Set<number>(); for (let z = 1; z <= zonesMade; z++) all.add(z);
  const dist = dijkstra([entrance], adjW(all));
  for (const s of spaces) s.dist = dist[s.id];
  const maxDist = Math.max(...spaces.map((s) => (Number.isFinite(s.dist) ? s.dist : 0)));

  // ---------------- placement ----------------
  const rP = makeRng(seed, 'place');
  const items: Item[] = [];
  const rooms = spaces.filter((s) => s.kind === 'room');
  const degree = new Array<number>(spaces.length).fill(0);
  for (const d of doors) if (passable(d, all)) { degree[d.a]++; degree[d.b]++; }
  const randomCell = (s: Space) => ({ x: s.rect.x + rP.int(0, s.rect.w - 1) + 0.5, y: s.rect.y + rP.int(0, s.rect.h - 1) + 0.5 });
  const used = new Set<number>([entrance]);
  // keys: key z lives in zone z-1, far from its lock, prefer dead ends
  for (let z = 1; z <= zonesMade; z++) {
    const lock = doors.find((d) => d.kind === 'locked' && d.lock === z)!;
    const outside = spaces[lock.a].zone === z - 1 ? lock.a : lock.b;
    const dl = dijkstra([outside], adjW(new Set([...all].filter((k) => k < z))));
    const cands = rooms.filter((s) => s.zone === z - 1 && !used.has(s.id) && Number.isFinite(dl[s.id]));
    cands.sort((p2, q2) => dl[q2.id] + (degree[q2.id] === 1 ? 15 : 0) - (dl[p2.id] + (degree[p2.id] === 1 ? 15 : 0)) || p2.id - q2.id);
    const kr = cands[0] ?? rooms.find((s) => s.zone === z - 1 && s.id !== entrance)!;
    used.add(kr.id);
    items.push({ kind: 'keycard', space: kr.id, ...randomCell(kr), data: { lock: z } });
  }
  // objectives: farthest-point sampling over graph distance, at least one in deepest zone
  const nObj = 3 + Math.round(p.difficulty * 3);
  const objRooms: number[] = [];
  const deep = rooms.filter((s) => s.zone === zonesMade && !used.has(s.id)).sort((a2, b2) => b2.dist - a2.dist);
  if (deep.length) { objRooms.push(deep[0].id); used.add(deep[0].id); }
  const adjAll = adjW(all);
  while (objRooms.length < nObj) {
    const dd = dijkstra([entrance, ...objRooms], adjAll);
    const c = rooms.filter((s) => !used.has(s.id) && area(s.rect) >= 9).sort((a2, b2) => dd[b2.id] - dd[a2.id] || a2.id - b2.id)[0];
    if (!c) break;
    objRooms.push(c.id); used.add(c.id);
  }
  objRooms.forEach((id, i) => items.push({ kind: i === 0 ? 'objective:core-sample' : rP.pick(['objective:data-drive', 'objective:fuse', 'objective:specimen']), space: id, ...randomCell(spaces[id]) }));
  // teamwork: dual switch pair in same zone, >= 18 m apart
  const z0rooms = rooms.filter((s) => !used.has(s.id) && s.zone === zonesMade);
  outer: for (const a2 of z0rooms) {
    const da = dijkstra([a2.id], adjAll);
    for (const b2 of z0rooms) if (b2.id !== a2.id && da[b2.id] >= 18) {
      items.push({ kind: 'switch:A', space: a2.id, ...randomCell(a2) }, { kind: 'switch:B', space: b2.id, ...randomCell(b2) });
      used.add(a2.id); used.add(b2.id);
      break outer;
    }
  }
  // loot weighted by depth
  for (const s of rooms) {
    if (s.id === entrance || !Number.isFinite(s.dist)) continue;
    const depth = s.dist / maxDist;
    const n = Math.floor((area(s.rect) / 14) * (0.5 + depth) + rP.float());
    for (let i = 0; i < n; i++) items.push({ kind: 'loot', space: s.id, ...randomCell(s), data: { value: Math.round(10 + 60 * depth * (0.5 + rP.float())) } });
  }
  // hiding spots + coverage (every corridor within 16 m graph distance of a hiding spot)
  const hide: number[] = [];
  for (const s of rooms) if (s.id !== entrance && rP.chance(0.3)) { hide.push(s.id); items.push({ kind: 'hide:locker', space: s.id, ...randomCell(s) }); }
  for (let guard = 0; guard < 40; guard++) {
    const dh = dijkstra(hide.length ? hide : [entrance], adjAll);
    const far = spaces.filter((s) => isCor(s.id) && dh[s.id] > 16).sort((a2, b2) => dh[b2.id] - dh[a2.id])[0];
    if (!far) break;
    hide.push(far.id); items.push({ kind: 'hide:locker', space: far.id, ...randomCell(far) });
  }
  // lights per space, state by zone/difficulty
  for (const s of spaces) {
    const n = Math.max(1, Math.ceil(area(s.rect) / 24));
    const pOff = 0.08 + 0.15 * p.difficulty + 0.08 * Math.max(0, s.zone);
    const pFlicker = 0.1 + 0.1 * p.difficulty;
    for (let i = 0; i < n; i++) {
      const r = rP.float();
      items.push({ kind: r < pOff ? 'light:off' : r < pOff + pFlicker ? 'light:flicker' : 'light:on', space: s.id, ...randomCell(s) });
    }
  }
  // monster vents: far rooms, spread
  const vents = rooms.filter((s) => s.dist >= 0.55 * maxDist && !objRooms.includes(s.id)).sort((a2, b2) => b2.dist - a2.dist || a2.id - b2.id);
  for (const s of vents.filter((_, i) => i % 3 === 0).slice(0, 2 + Math.round(p.difficulty * 2))) items.push({ kind: 'spawn:vent', space: s.id, ...randomCell(s) });
  // fire exit: perimeter room in deepest zone touching the footprint edge, farthest from entrance
  let fe: Space | undefined;
  for (let z = zonesMade; z >= 0 && !fe; z--) fe = rooms.filter((s) => s.perimeter && s.zone === z && s.id !== entrance && exterior(s.id).length > 0 && s.dist >= 0.4 * maxDist).sort((a2, b2) => b2.dist - a2.dist)[0];
  if (fe) addDoor(bestRun(exterior(fe.id)), 'exit', 1, rP).lock = -2;

  // ---------------- metrics / validation ----------------
  const pass = doors.filter((d) => passable(d, all));
  const V = spaces.length, E = new Set(pass.map((d) => keyOf(d.a, d.b))).size;
  // solvability: expand reachable set, pick up keys, repeat
  const keys = new Set<number>();
  let reach = new Uint8Array(V);
  for (;;) {
    const adj: number[][] = spaces.map(() => []);
    for (const d of doors) if (passable(d, keys)) { adj[d.a].push(d.b); adj[d.b].push(d.a); }
    reach = bfsFrom(entrance, adj);
    let gained = false;
    for (const it of items) if (it.kind === 'keycard' && reach[it.space] && !keys.has(it.data!.lock as number)) { keys.add(it.data!.lock as number); gained = true; }
    if (!gained) break;
  }
  const unreachable = reach.reduce((s, v) => s + (v ? 0 : 1), 0);
  const z0 = spaces.filter((s) => s.zone === 0).map((s) => s.id); const z0s = new Set(z0);
  const E0 = new Set(pass.filter((d) => z0s.has(d.a) && z0s.has(d.b)).map((d) => keyOf(d.a, d.b))).size;
  const deadEnds = rooms.filter((s) => degree[s.id] === 1).length;
  return {
    seed, W, H, owner, spaces, doors, items, entrance, zones: zonesMade,
    metrics: {
      ms: +(performance.now() - t0).toFixed(2), spaces: V, rooms: rooms.length, doors: doors.length, cyclomatic: E - V + 1, loopsZone0: E0 - z0.length + 1,
      deadEnds, unreachable, maxDistM: Math.round(maxDist), zones: zonesMade, fireExit: fe ? 1 : 0,
      objectives: objRooms.length, loot: items.filter((i) => i.kind === 'loot').length, hide: hide.length,
    },
  };
}

// ---------------- ASCII render (2x+1 lattice so edges are visible) ----------------
export function ascii(L: Level): string {
  const GW = 2 * L.W + 1, GH = 2 * L.H + 1;
  const g: string[][] = Array.from({ length: GH }, () => new Array<string>(GW).fill(' '));
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= L.W || y >= L.H ? -1 : L.owner[y * L.W + x]);
  for (let y = 0; y < L.H; y++) for (let x = 0; x < L.W; x++) g[2 * y + 1][2 * x + 1] = L.spaces[own(x, y)]?.kind === 'corridor' ? '.' : ' ';
  for (let y = 0; y < L.H; y++) for (let x = 0; x <= L.W; x++) if (own(x - 1, y) !== own(x, y)) g[2 * y + 1][2 * x] = '|';
  for (let y = 0; y <= L.H; y++) for (let x = 0; x < L.W; x++) if (own(x, y - 1) !== own(x, y)) g[2 * y][2 * x + 1] = '-';
  for (let y = 0; y <= L.H; y++) for (let x = 0; x <= L.W; x++) {
    const n = (y > 0 && g[2 * y - 1][2 * x] !== ' ') || (y < L.H && g[2 * y + 1][2 * x] !== ' ') || (x > 0 && g[2 * y][2 * x - 1] !== ' ') || (x < L.W && g[2 * y][2 * x + 1] !== ' ');
    if (n) g[2 * y][2 * x] = '+';
  }
  const sym: Record<Door['kind'], string> = { open: ' ', door: 'D', locked: 'L', blocked: 'X', exit: 'E' };
  for (const d of L.doors) for (let i = 0; i < d.len; i++) {
    if (d.dir === 'v') g[2 * (d.y + i) + 1][2 * d.x] = d.kind === 'open' ? ' ' : sym[d.kind];
    else g[2 * d.y][2 * (d.x + i) + 1] = d.kind === 'open' ? ' ' : sym[d.kind];
  }
  const isym: Record<string, string> = { keycard: 'k', loot: '$', 'hide:locker': 'h', 'spawn:vent': 'V', 'switch:A': 'S', 'switch:B': 'S' };
  for (const it of L.items) {
    const s = it.kind.startsWith('objective') ? 'O' : isym[it.kind];
    if (!s) continue;
    g[2 * Math.floor(it.y) + 1][2 * Math.floor(it.x) + 1] = s;
  }
  return g.map((r) => r.join('')).join('\n');
}

// ---------------- CLI ----------------
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gen.ts')) {
  const seed = process.argv[2] ?? 'demo';
  const L = generate({ seed, W: 64, H: 48, difficulty: 0.5, locks: 2 });
  console.log(ascii(L));
  console.log(L.metrics);
}
