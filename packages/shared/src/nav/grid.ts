// Owned by track ② Level. Edge grid: 1 m cells with thin walls on cell edges, built from a LevelLayout.
// Shared by the server (monsters, hearing, voice audibility, pose validation) and the client (collision, culling).
//
// Indexing (matches LayoutDoor):
//   v edges: line x in [0..W], row y in [0..H-1]  -> v[y*(W+1)+x]  separates cells (x-1,y) | (x,y)
//   h edges: line y in [0..H], col x in [0..W-1]  -> h[y*W+x]      separates cells (x,y-1) | (x,y)
import type { LayoutDoor, LayoutItem, LayoutSpace, LevelLayout } from '../layout.ts';

/** Edge codes */
export const EDGE = {
  /** nothing: same space, or an 'open' doorway */
  free: 0,
  /** solid wall (also van body, building facade, grid boundary of indoor spaces) */
  wall: 1,
  /** a door; passability depends on its runtime state (door id in vDoor/hDoor) */
  door: 2,
  /** rubble / jammed doorway: blocks walking and sight, sound leaks through like a closed door */
  blocked: 3,
  /** chain-link fence (between two outdoor spaces or around the lot): blocks walking, sight and sound pass */
  fence: 4,
} as const;
export type EdgeCode = (typeof EDGE)[keyof typeof EDGE];

/** door id -> currently open? (locked doors are simply closed) */
export type DoorOpenFn = (id: number) => boolean;

export interface EdgeGrid {
  readonly W: number;
  readonly H: number;
  /** W*H space id per cell (-1 = solid) */
  readonly owner: Int32Array;
  readonly v: Uint8Array;
  readonly vDoor: Int32Array;
  readonly h: Uint8Array;
  readonly hDoor: Int32Array;
  readonly doors: readonly LayoutDoor[];
  readonly spaces: readonly LayoutSpace[];
  /** static solid boxes for player collision only (lockers, console desk, ...): x0,z0,x1,z1 per box */
  readonly solids: Float32Array;
  /** CSR cell -> solid box indices: boxes overlapping cell c are solidIdx[solidStart[c] .. solidStart[c+1]) */
  readonly solidStart: Int32Array;
  readonly solidIdx: Int32Array;
}

export interface EdgeGridSource {
  W: number;
  H: number;
  /** number[] in a LevelLayout; generators may pass their Int32Array */
  owner: ArrayLike<number>;
  spaces: readonly LayoutSpace[];
  doors: readonly LayoutDoor[];
  items?: readonly LayoutItem[];
}

/** Items that become solid collision boxes: kind -> [width along the wall, depth] in metres. Position = box centre. */
export const SOLID_ITEMS: Readonly<Record<string, readonly [number, number]>> = {
  hiding: [0.9, 0.55],
  console: [1.7, 0.55],
  mirror: [0.9, 0.5],
  board: [1.6, 0.3],
  shop: [1.4, 0.8],
};

export function buildEdgeGrid(L: EdgeGridSource): EdgeGrid {
  const { W, H } = L;
  const owner = Int32Array.from(L.owner as ArrayLike<number>);
  const v = new Uint8Array((W + 1) * H);
  const h = new Uint8Array(W * (H + 1));
  const vDoor = new Int32Array((W + 1) * H).fill(-1);
  const hDoor = new Int32Array(W * (H + 1)).fill(-1);
  const isOpen = (id: number) => id >= 0 && L.spaces[id] !== undefined && L.spaces[id].open;
  const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x]);
  // boundary code between two owners; offA/offB = that side is beyond the grid
  const code = (a: number, b: number, offA: boolean, offB: boolean): number => {
    if (a === b) return EDGE.free;
    const oa = isOpen(a), ob = isOpen(b);
    if (oa && ob) return EDGE.fence;
    if ((oa && offB) || (ob && offA)) return EDGE.fence;
    return EDGE.wall;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x <= W; x++) v[y * (W + 1) + x] = code(own(x - 1, y), own(x, y), x === 0, x === W);
  for (let y = 0; y <= H; y++) for (let x = 0; x < W; x++) h[y * W + x] = code(own(x, y - 1), own(x, y), y === 0, y === H);
  for (const d of L.doors) {
    const c = d.kind === 'open' ? EDGE.free : d.kind === 'blocked' ? EDGE.blocked : EDGE.door;
    for (let i = 0; i < d.len; i++) {
      if (d.dir === 'v') {
        const e = (d.y + i) * (W + 1) + d.x;
        v[e] = c; vDoor[e] = d.id;
      } else {
        const e = d.y * W + d.x + i;
        h[e] = c; hDoor[e] = d.id;
      }
    }
  }
  // solid boxes
  const boxes: number[] = [];
  for (const it of L.items ?? []) {
    const dim = it.kind === 'prop' ? (it.data?.solid === true ? [Number(it.data.w ?? 0), Number(it.data.d ?? 0)] as const : undefined) : SOLID_ITEMS[it.kind];
    if (!dim || it.data?.solid === false) continue;
    const rot = it.rot ?? 0;
    // rot is always a multiple of PI/2 for generated items: wall-aligned boxes
    const alongX = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 0;
    const hw = (alongX ? dim[0] : dim[1]) / 2, hd = (alongX ? dim[1] : dim[0]) / 2;
    boxes.push(it.x - hw, it.z - hd, it.x + hw, it.z + hd);
  }
  const solids = Float32Array.from(boxes);
  const counts = new Int32Array(W * H + 1);
  const forCells = (bi: number, f: (c: number) => void) => {
    const x0 = Math.max(0, Math.floor(solids[bi * 4])), z0 = Math.max(0, Math.floor(solids[bi * 4 + 1]));
    const x1 = Math.min(W - 1, Math.floor(solids[bi * 4 + 2])), z1 = Math.min(H - 1, Math.floor(solids[bi * 4 + 3]));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) f(z * W + x);
  };
  const nb = solids.length / 4;
  for (let i = 0; i < nb; i++) forCells(i, (c) => { counts[c + 1]++; });
  const solidStart = new Int32Array(W * H + 1);
  for (let c = 0; c < W * H; c++) solidStart[c + 1] = solidStart[c] + counts[c + 1];
  const fill = solidStart.slice(0, W * H);
  const solidIdx = new Int32Array(solidStart[W * H]);
  for (let i = 0; i < nb; i++) forCells(i, (c) => { solidIdx[fill[c]++] = i; });
  return { W, H, owner, v, vDoor, h, hDoor, doors: L.doors, spaces: L.spaces, solids, solidStart, solidIdx };
}

/** Door states as generated (doors of kind 'open' are always open). */
export function initialDoorOpen(L: Pick<LevelLayout, 'doors'>): DoorOpenFn {
  const st = L.doors.map((d) => d.kind === 'open' || d.initiallyOpen);
  return (id) => st[id] === true;
}

/** Mutable door-state array helper: doorOpen callback backed by a Uint8Array. */
export function doorStateArray(L: Pick<LevelLayout, 'doors'>): { state: Uint8Array; open: DoorOpenFn } {
  const state = new Uint8Array(L.doors.length);
  L.doors.forEach((d, i) => { state[i] = d.kind === 'open' || d.initiallyOpen ? 1 : 0; });
  return { state, open: (id) => state[id] === 1 };
}

export const ALL_OPEN: DoorOpenFn = () => true;
export const ALL_CLOSED: DoorOpenFn = () => false;

/** Space id at world position (x, z) or -1. */
export function spaceAt(g: Pick<EdgeGrid, 'W' | 'H' | 'owner'>, x: number, z: number): number {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return -1;
  return g.owner[cz * g.W + cx];
}

/** Cell index for world (x, z), clamped into the grid. */
export function cellOf(g: Pick<EdgeGrid, 'W' | 'H'>, x: number, z: number): number {
  const cx = Math.min(g.W - 1, Math.max(0, Math.floor(x)));
  const cz = Math.min(g.H - 1, Math.max(0, Math.floor(z)));
  return cz * g.W + cx;
}

/**
 * Edge code and door id for stepping from cell (x,y) by one cell in direction dir:
 * 0 = +x, 1 = -x, 2 = +y, 3 = -y. Returns code; door id via edgeDoor().
 */
export function edgeIndex(g: EdgeGrid, x: number, y: number, dir: number): number {
  switch (dir) {
    case 0: return y * (g.W + 1) + x + 1;
    case 1: return y * (g.W + 1) + x;
    case 2: return (y + 1) * g.W + x;
    default: return y * g.W + x;
  }
}

export function edgeCode(g: EdgeGrid, x: number, y: number, dir: number): number {
  return dir < 2 ? g.v[edgeIndex(g, x, y, dir)] : g.h[edgeIndex(g, x, y, dir)];
}

export function edgeDoor(g: EdgeGrid, x: number, y: number, dir: number): number {
  return dir < 2 ? g.vDoor[edgeIndex(g, x, y, dir)] : g.hDoor[edgeIndex(g, x, y, dir)];
}

/** Can a walking agent step from (x,y) in dir? Closed doors pass only if canOpen(id). */
export function canWalk(g: EdgeGrid, x: number, y: number, dir: number, doorOpen: DoorOpenFn, canOpen?: DoorOpenFn): boolean {
  const nx = x + (dir === 0 ? 1 : dir === 1 ? -1 : 0), ny = y + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
  if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) return false;
  const c = edgeCode(g, x, y, dir);
  if (c === EDGE.free) return true;
  if (c !== EDGE.door) return false;
  const id = edgeDoor(g, x, y, dir);
  return doorOpen(id) || (canOpen !== undefined && canOpen(id));
}

/** Space adjacency for culling / graphs: doors plus fence contacts between outdoor spaces. */
export interface SpaceLink { other: number; door: number; kind: LayoutDoor['kind'] | 'fence' }

export function spaceLinks(L: Pick<LevelLayout, 'W' | 'H' | 'owner' | 'spaces' | 'doors'>): SpaceLink[][] {
  const links: SpaceLink[][] = L.spaces.map(() => []);
  for (const d of L.doors) {
    if (d.a < 0 || d.b < 0) continue;
    links[d.a].push({ other: d.b, door: d.id, kind: d.kind });
    links[d.b].push({ other: d.a, door: d.id, kind: d.kind });
  }
  const seen = new Set<number>();
  const add = (a: number, b: number) => {
    if (a < 0 || b < 0 || a === b || !L.spaces[a].open || !L.spaces[b].open) return;
    const k = Math.min(a, b) * 65536 + Math.max(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    links[a].push({ other: b, door: -1, kind: 'fence' });
    links[b].push({ other: a, door: -1, kind: 'fence' });
  };
  const { W, H, owner } = L;
  for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) add(owner[y * W + x - 1], owner[y * W + x]);
  for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) add(owner[(y - 1) * W + x], owner[y * W + x]);
  return links;
}
