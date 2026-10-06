// Playtest walker: plans on the shared nav grid, then walks with REAL keyboard input (held W, yaw via __game.look),
// opens closed doors with a real E press, and reports where the player got stuck.
import type { Page } from 'playwright-core';
import { astar, buildEdgeGrid, pathPoints, smoothPath } from '../../../packages/shared/src/nav/index.ts';
import type { EdgeGrid } from '../../../packages/shared/src/nav/index.ts';
import type { LevelLayout, LayoutDoor } from '../../../packages/shared/src/layout.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Pose { p: [number, number, number]; yaw: number; pitch: number; stance: number }
export const pose = (page: Page): Promise<Pose | null> => page.evaluate(() => {
  const c = (window as any).__ix.camera();
  if (!c) return null;
  return { p: [c.o[0], 0, c.o[2]], yaw: Math.atan2(c.d[0], c.d[2]), pitch: Math.asin(c.d[1]), stance: c.o[1] < 1.3 ? 1 : 0 };
});

const cache = new WeakMap<Page, { L: LevelLayout; g: EdgeGrid; hash: string }>();
export async function grid(page: Page): Promise<{ L: LevelLayout; g: EdgeGrid }> {
  const hash = await page.evaluate(() => (window as any).__ix.layout()?.hash ?? '');
  const c = cache.get(page);
  if (c && c.hash === hash) return c;
  const L = (await page.evaluate(() => { const L = (window as any).__ix.layout(); return { ...L, owner: Array.from(L.owner) }; })) as unknown as LevelLayout;
  (L as any).owner = Int32Array.from((L as any).owner);
  const g = buildEdgeGrid(L as never);
  const v = { L, g, hash };
  cache.set(page, v);
  return v;
}

export const doorStates = (page: Page): Promise<Record<number, { open: boolean; locked: boolean; kind?: string }>> =>
  page.evaluate(() => (window as any).__ix.state().doors);

function doorCenter(d: LayoutDoor): [number, number] {
  return d.dir === 'v' ? [d.x, d.y + d.len / 2] : [d.x + d.len / 2, d.y];
}

/** door crossed by a step between two cells (or -1) */
function crossedDoor(L: LevelLayout, a: number, b: number): LayoutDoor | null {
  const W = L.W;
  const ax = a % W, ay = (a - ax) / W, bx = b % W, by = (b - bx) / W;
  for (const d of L.doors) {
    if (d.dir === 'v' && ay === by && Math.min(ax, bx) === d.x - 1 && Math.max(ax, bx) === d.x && ay >= d.y && ay < d.y + d.len) return d;
    if (d.dir === 'h' && ax === bx && Math.min(ay, by) === d.y - 1 && Math.max(ay, by) === d.y && ax >= d.x && ax < d.x + d.len) return d;
  }
  return null;
}

export interface WalkResult { ok: boolean; reason?: string; stuck: { at: [number, number]; t: number }[]; doorsOpened: number[]; ms: number; end: [number, number] }

export async function face(page: Page, x: number, z: number, y = 1.2): Promise<void> {
  const ps = await pose(page);
  if (!ps) return;
  const eyeY = ps.stance === 1 ? 1.0 : 1.6;
  const dx = x - ps.p[0], dz = z - ps.p[2];
  await page.evaluate(([yaw, pitch]) => (window as any).__game.look(yaw, pitch), [Math.atan2(dx, dz), Math.atan2(y - eyeY, Math.hypot(dx, dz))]);
}

/** hold W toward (x, z) with re-aim; returns false when stuck */
async function stride(page: Page, x: number, z: number, o: { tol: number; timeoutMs: number; key?: string; stuck: WalkResult['stuck'] }): Promise<boolean> {
  const key = o.key ?? 'KeyW';
  const t0 = Date.now();
  let last = await pose(page);
  let lastMoveT = Date.now();
  let lastP: [number, number] = last ? [last.p[0], last.p[2]] : [0, 0];
  await page.keyboard.down(key);
  try {
    for (;;) {
      const ps = await pose(page);
      if (!ps) return false;
      const dx = x - ps.p[0], dz = z - ps.p[2];
      const d = Math.hypot(dx, dz);
      if (d <= o.tol) return true;
      await page.evaluate((yaw) => (window as any).__game.look(yaw, -0.05), Math.atan2(dx, dz));
      if (Math.hypot(ps.p[0] - lastP[0], ps.p[2] - lastP[1]) > 0.08) { lastP = [ps.p[0], ps.p[2]]; lastMoveT = Date.now(); }
      if (Date.now() - lastMoveT > 1500) { o.stuck.push({ at: [Math.round(ps.p[0] * 100) / 100, Math.round(ps.p[2] * 100) / 100], t: Date.now() - t0 }); return false; }
      if (Date.now() - t0 > o.timeoutMs) return false;
      await sleep(40);
    }
  } finally {
    await page.keyboard.up(key);
  }
}

/** walk to (x, z) like a player: plan, hold W, press E on closed doors */
export async function walkTo(page: Page, x: number, z: number, o: { tol?: number; timeoutMs?: number; sprint?: boolean; crouch?: boolean; keycard?: boolean; log?: (...a: unknown[]) => void } = {}): Promise<WalkResult> {
  const t0 = Date.now();
  const res: WalkResult = { ok: false, stuck: [], doorsOpened: [], ms: 0, end: [0, 0] };
  const { L, g } = await grid(page);
  const tol = o.tol ?? 0.35;
  const deadline = t0 + (o.timeoutMs ?? 60_000);
  if (o.sprint) await page.keyboard.down('ShiftLeft');
  if (o.crouch) await page.keyboard.down('KeyC');
  try {
    for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
      const ds = await doorStates(page);
      const open = (id: number) => !!ds[id]?.open || L.doors[id]?.kind === 'open';
      const canOpen = (id: number) => open(id) || ((!ds[id]?.locked || (o.keycard && L.doors[id]?.kind === 'locked')) && L.doors[id]?.kind !== 'vault' && L.doors[id]?.kind !== 'blocked');
      const ps = await pose(page);
      if (!ps) { res.reason = 'no pose'; break; }
      const r = astar(g, ps.p[0], ps.p[2], x, z, { mode: 'walk', doorOpen: open, canOpen });
      if (!r) { res.reason = `no path from ${ps.p[0].toFixed(1)},${ps.p[2].toFixed(1)}`; break; }
      // split at closed doors
      const segs: { cells: number[]; door: LayoutDoor | null }[] = [{ cells: [r.cells[0]], door: null }];
      for (let i = 1; i < r.cells.length; i++) {
        const d = crossedDoor(L, r.cells[i - 1], r.cells[i]);
        if (d && !open(d.id)) segs.push({ cells: [r.cells[i]], door: d });
        else segs[segs.length - 1].cells.push(r.cells[i]);
      }
      let failed = false;
      for (const s of segs) {
        if (s.door) {
          const [cx, cz] = doorCenter(s.door);
          await face(page, cx, cz, 1.1);
          await sleep(250);
          const tgt = await page.evaluate(() => (window as any).__ix.target());
          await page.keyboard.down('KeyE'); await sleep(70); await page.keyboard.up('KeyE');
          let opened = false;
          for (let k = 0; k < 20 && !opened; k++) { await sleep(100); opened = !!(await doorStates(page))[s.door.id]?.open; }
          o.log?.(`door ${s.door.id} (${s.door.kind}) target=${tgt?.id ?? 'none'} '${tgt?.view?.text ?? ''}' opened=${opened}`);
          if (opened) res.doorsOpened.push(s.door.id);
          else { res.reason = `door ${s.door.id} did not open (target ${tgt?.id ?? 'none'})`; failed = true; break; }
        }
        const pts = pathPoints(g, s.cells);
        const sm = smoothPath(g, pts, (id) => true, 0.32);
        for (const [wx, wz] of sm) {
          const ok = await stride(page, wx, wz, { tol: 0.3, timeoutMs: Math.max(2000, deadline - Date.now()), stuck: res.stuck });
          if (!ok) { failed = true; break; }
        }
        if (failed) break;
      }
      if (!failed) {
        const ok = await stride(page, x, z, { tol, timeoutMs: Math.max(1500, deadline - Date.now()), stuck: res.stuck });
        if (ok) { res.ok = true; break; }
      }
      // unstick: back off a little and re-plan
      await page.keyboard.down('KeyS'); await sleep(300); await page.keyboard.up('KeyS');
      await page.keyboard.down(attempt % 2 ? 'KeyA' : 'KeyD'); await sleep(300); await page.keyboard.up(attempt % 2 ? 'KeyA' : 'KeyD');
    }
  } finally {
    if (o.sprint) await page.keyboard.up('ShiftLeft');
    if (o.crouch) await page.keyboard.up('KeyC');
  }
  const pe = await pose(page);
  res.end = pe ? [Math.round(pe.p[0] * 100) / 100, Math.round(pe.p[2] * 100) / 100] : [0, 0];
  res.ms = Date.now() - t0;
  return res;
}

/** a walkable stand point near (x, z) in the same space, `dist` m away, preferring the side the item faces */
export async function standNear(page: Page, x: number, z: number, dist = 1.0, rot?: number): Promise<[number, number]> {
  const { L } = await grid(page);
  const own = (px: number, pz: number) => (px < 0 || pz < 0 || px >= L.W || pz >= L.H ? -1 : L.owner[Math.floor(pz) * L.W + Math.floor(px)]);
  const target = own(x, z);
  const cands: [number, number, number][] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    for (const r of [dist, dist * 0.75, dist * 1.3]) {
      const sx = x + Math.sin(a) * r, sz = z + Math.cos(a) * r;
      const o2 = own(sx, sz);
      if (o2 < 0) continue;
      const score = (o2 === target || target < 0 ? 0 : 3) + (rot !== undefined ? Math.abs(Math.atan2(Math.sin(a - rot), Math.cos(a - rot))) : 0) + Math.abs(r - dist);
      // keep 0.35 m off walls (cell borders) roughly
      const fx = sx - Math.floor(sx), fz = sz - Math.floor(sz);
      const edge = Math.min(fx, 1 - fx, fz, 1 - fz) < 0.2 ? 0.5 : 0;
      cands.push([sx, sz, score + edge]);
    }
  }
  cands.sort((a, b) => a[2] - b[2]);
  return cands.length ? [cands[0][0], cands[0][1]] : [x, z];
}
