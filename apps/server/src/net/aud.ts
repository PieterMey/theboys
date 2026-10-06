// Owner: track ① Net. Per-receiver voice audibility (Snapshot.aud): path distance in metres from each receiver
// to every OTHER connected player, using ②'s shared sound flood (octile, doors +1 open / +6 closed, 255 = none).
// - One flood per speaker, from the speaker's cell, reused while cell + door state are unchanged.
// - Active speakers (band > 0 or spoke within BAND_HOLD_MS) refresh immediately; silent ones at most every
//   audSilentRefreshMs (2 Hz) - their field may be a little stale, which only matters once they speak.
// - Van cab NOT sealed for player-to-player voice: the normal path distance through the open rear doorway
//   (the van stays a sanctuary for MONSTER hearing only; apps/server/src/monsters/runtime.ts has its own cab check).
// - Receivers in a solid cell (spectator cameras clip walls) read the best neighbouring cell + 1 m.
// - No layout / point outside the grid -> rounded Euclidean distance (255 beyond range).
import { BAND_HOLD_MS, PATH } from '@dead-air/shared/constants.ts';
import { floodCells } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { Rect } from '@dead-air/shared/layout.ts';
import type { Snapshot } from '@dead-air/shared/state.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { doorView, gridFor } from './grid.ts';
import { netBalance } from './balance.ts';

const UNREACH = PATH.unreachable;

interface Field { cell: number; field: Float32Array; at: number; version: number }

interface AudCrewState {
  grid: EdgeGrid | null;
  layoutRef: unknown;
  doorSig: string;
  version: number;
  open: (id: number) => boolean;
  fields: Map<string, Field>;
  /** who may be heard this snapshot (connected players) */
  points: { id: string; x: number; z: number; cell: number; sealed: number }[];
}

export interface AudStats { snaps: number; floods: number; lastMs: number; avgMs: number; maxMs: number; maxPlayers: number }
export const audStats: AudStats = { snaps: 0, floods: 0, lastMs: 0, avgMs: 0, maxMs: 0, maxPlayers: 0 };

const lastLoud = new WeakMap<ServerPlayer, number>();

export function noteLoud(p: ServerPlayer): void {
  if (p.band > 0) lastLoud.set(p, performance.now());
}

function stateOf(crew: Crew): AudCrewState {
  const slot = (crew.slices.net ??= {}) as { aud?: AudCrewState };
  slot.aud ??= { grid: null, layoutRef: undefined, doorSig: '', version: 0, open: () => true, fields: new Map(), points: [] };
  return slot.aud;
}

const inRect = (r: Rect, x: number, z: number) => x >= r.x && x < r.x + r.w && z >= r.y && z < r.y + r.h;

function cellIn(g: EdgeGrid | null, x: number, z: number): number {
  if (!g) return -1;
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return -1;
  return cz * g.W + cx;
}

/** field value at a cell; solid/unreached cells fall back to the best 8-neighbour + 1 */
function readField(g: EdgeGrid, f: Float32Array, cell: number): number {
  const d = f[cell];
  if (Number.isFinite(d) && g.owner[cell] >= 0) return d;
  const W = g.W, H = g.H, x = cell % W, y = (cell - x) / W;
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const v = f[ny * W + nx];
    if (v < best) best = v;
  }
  return Number.isFinite(best) ? best + 1 : Number.isFinite(d) ? d : Infinity;
}

const round = (d: number, range: number) => (Number.isFinite(d) && d <= range ? Math.min(UNREACH - 1, Math.round(d)) : UNREACH);

/** crewSnapshot hook: refresh the speaker fields (once per crew per snapshot). */
export function audCrewSnapshot(crew: Crew, _snap: Snapshot, ctx: ServerContext): void {
  const t0 = performance.now();
  const bal = netBalance(ctx);
  const st = stateOf(crew);
  if (st.layoutRef !== crew.layout) {
    st.layoutRef = crew.layout;
    st.grid = gridFor(crew.layout);
    st.fields.clear();
    st.doorSig = '';
    st.version++;
  }
  const g = st.grid;
  if (g && crew.layout) {
    const dv = doorView(crew);
    if (dv.sig !== st.doorSig) { st.doorSig = dv.sig; st.version++; }
    st.open = dv.open;
  }
  const cab = crew.layout?.van?.cab;
  const now = performance.now();
  st.points.length = 0;
  let n = 0;
  for (const p of crew.players.values()) {
    if (!p.connected) { st.fields.delete(p.id); continue; }
    n++;
    const [x, , z] = p.pose.p;
    const cell = cellIn(g, x, z);
    st.points.push({ id: p.id, x, z, cell, sealed: cab && inRect(cab, x, z) ? 1 : 0 });
    if (!g || cell < 0) continue;
    if (p.band > 0) lastLoud.set(p, now);
    const active = now - (lastLoud.get(p) ?? -Infinity) < BAND_HOLD_MS;
    const f = st.fields.get(p.id);
    const stale = !f || f.cell !== cell || f.version !== st.version;
    if (!stale) continue;
    if (f && !active && now - f.at < bal.audSilentRefreshMs) continue;
    const out = f?.field.length === g.W * g.H ? f.field : undefined;
    const field = floodCells(g, [cell], { mode: 'sound', doorOpen: st.open, budget: bal.audRangeM }, out);
    audStats.floods++;
    st.fields.set(p.id, { cell, field, at: now, version: st.version });
  }
  const ms = performance.now() - t0;
  audStats.snaps++;
  audStats.lastMs = ms;
  audStats.avgMs = audStats.avgMs ? audStats.avgMs * 0.95 + ms * 0.05 : ms;
  if (ms > audStats.maxMs) audStats.maxMs = ms;
  if (n > audStats.maxPlayers) audStats.maxPlayers = n;
}

/** Distance (rounded m, 255 = unreachable) from receiver to speaker using the crew's current fields. */
export function audDistance(crew: Crew, receiverId: string, speakerId: string, ctx: ServerContext): number {
  const st = stateOf(crew);
  const r = st.points.find((q) => q.id === receiverId);
  const s = st.points.find((q) => q.id === speakerId);
  if (!r || !s) return UNREACH;
  return pairDistance(st, r, s, netBalance(ctx).audRangeM);
}

function pairDistance(st: AudCrewState, r: AudCrewState['points'][number], s: AudCrewState['points'][number], range: number): number {
  const g = st.grid;
  const f = st.fields.get(s.id);
  if (g && f && r.cell >= 0) return round(readField(g, f.field, r.cell), range);
  if (g && s.cell >= 0 && r.cell >= 0) return UNREACH; // in grid but no field yet (never happens after crewSnapshot)
  const dx = r.x - s.x, dz = r.z - s.z;
  return round(Math.sqrt(dx * dx + dz * dz), range);
}

/** snapshot hook: fill this receiver's aud map. */
export function audForReceiver(crew: Crew, receiver: ServerPlayer, snap: Snapshot, ctx: ServerContext): void {
  const st = stateOf(crew);
  const range = netBalance(ctx).audRangeM;
  let r = st.points.find((q) => q.id === receiver.id);
  if (!r) {
    // receiver not in this crew snapshot's points (e.g. welcome built before the first crewSnapshot)
    const [x, , z] = receiver.pose.p;
    const cab = crew.layout?.van?.cab;
    r = { id: receiver.id, x, z, cell: cellIn(st.grid, x, z), sealed: cab && inRect(cab, x, z) ? 1 : 0 };
  }
  const aud: Record<string, number> = { ...snap.aud };
  for (const s of st.points) {
    if (s.id === receiver.id) continue;
    aud[s.id] = pairDistance(st, r, s, range);
  }
  snap.aud = aud;
}
