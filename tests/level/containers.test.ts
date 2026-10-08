// Env-layout (v1.2): containersOf, a pure filter over furniture. Deterministic; fronts walkable (reachable around
// solids, same space, no loose floor prop such as a chair or a box); <= 3 per room, <= 32 per site, 15-32 on 6-player sites; never in the van, lot or
// vault; drawers slide <= 0.45 m; GLB part nodes exist in .assets/build/props and their measured centres match the
// tables within 1 cm (tool chest lid: closed pose = the authored open pose rotated back about the hinge).
// Run: node --test tests/level/containers.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildEdgeGrid } from '../../packages/shared/src/nav/grid.ts';
import { generateFacility, generateHub } from '../../packages/shared/src/procgen/index.ts';
import { CONTAINER_LIMITS, CONTAINER_NODES, containerById, containerDefFor, containersOf, containersOfFresh } from '../../packages/shared/src/procgen/containers.ts';
import { reachAroundSolids } from '../../packages/shared/src/procgen/place.ts';
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';
import { glbBounds } from './glb-bounds.ts';

const SEEDS = Number(process.env.SEEDS ?? 40);
const PROPS = resolve(import.meta.dirname, '../../.assets/build/props');

test('containers: deterministic, memoised, fronts walkable, limits, never van/lot/vault', () => {
  const failures: string[] = [];
  const six: number[] = [];
  for (let i = 0; i < SEEDS * 6; i++) {
    const players = 1 + (i % 6);
    const L = generateFacility({ seed: `cont${i}`, players, risk: 1 + (i % 3) });
    const C = containersOf(L);
    if (containersOf(L) !== C) failures.push(`${L.seed}: not memoised`);
    if (JSON.stringify(containersOfFresh(JSON.parse(JSON.stringify(L)))) !== JSON.stringify(C)) failures.push(`${L.seed}: nondeterministic`);
    if (players === 6) six.push(C.length);
    if (C.length > CONTAINER_LIMITS.perSite) failures.push(`${L.seed}: ${C.length} containers`);
    const perRoom = new Map<number, number>();
    const g = buildEdgeGrid(L);
    const sp = L.items.find((it) => it.kind === 'spawn_player')!;
    const seen = reachAroundSolids(g, Math.floor(sp.z) * L.W + Math.floor(sp.x));
    const chairs = new Set(L.items.filter((it) => it.kind === 'prop' && it.data?.solid !== true && (it.y ?? 0) < 0.3 && !it.data?.station).map((it) => Math.floor(it.z) * L.W + Math.floor(it.x)));
    for (const c of C) {
      perRoom.set(c.space, (perRoom.get(c.space) ?? 0) + 1);
      const s = L.spaces[c.space];
      if (s.open || s.kind === 'vault' || s.type === 'van' || s.type === 'lot') failures.push(`${c.id} in ${s.type}`);
      const host = L.items.find((it) => it.id === c.id);
      if (!host || host.kind !== 'prop' || host.data?.prop !== c.prop || !containerDefFor(host)) failures.push(`${c.id}: bad host`);
      const fc = c.front[1] * L.W + c.front[0];
      if (L.owner[fc] !== c.space || !seen[fc] || chairs.has(fc)) failures.push(`${c.id}: front ${c.front} not walkable`);
      if (Math.abs(c.front[0] + 0.5 - c.x) + Math.abs(c.front[1] + 0.5 - c.z) > 2.2) failures.push(`${c.id}: front cell far from the host`);
      if (!c.parts.some((p) => p.idx === c.main)) failures.push(`${c.id}: main part missing`);
      if (!(c.tier >= 0 && c.tier <= 2)) failures.push(`${c.id}: tier ${c.tier}`);
      const ids = new Set<number>();
      for (const p of c.parts) {
        if (p.idx < 0 || p.idx > 15 || ids.has(p.idx)) failures.push(`${c.id}: part idx ${p.idx}`);
        ids.add(p.idx);
        if ((p.kind === 'drawer' || p.kind === 'tray') && !(p.travel > 0 && p.travel <= CONTAINER_LIMITS.maxTravel)) failures.push(`${c.id}: travel ${p.travel}`);
        if ((p.kind === 'door' || p.kind === 'lid') && !(p.hinge && p.travel > 0 && p.travel <= Math.PI)) failures.push(`${c.id}: hinge`);
        // slot near the host (inside the open part)
        if (Math.hypot(p.slot[0] - c.x, p.slot[2] - c.z) > 1.4 || p.slot[1] < 0 || p.slot[1] > 2.2) failures.push(`${c.id}: slot ${p.slot}`);
      }
      // aim point on the front face, within reach of the front cell
      if (Math.hypot(c.p[0] - (c.front[0] + 0.5), c.p[2] - (c.front[1] + 0.5)) > 1.6) failures.push(`${c.id}: aim point ${c.p} far from the front cell`);
      if (containerById(L, c.id) !== c) failures.push(`${c.id}: containerById`);
    }
    for (const [sid, n] of perRoom) if (n > CONTAINER_LIMITS.perRoom) failures.push(`${L.seed}: ${n} containers in space ${sid}`);
    if (failures.length > 20) break;
  }
  assert.deepEqual(failures.slice(0, 20), []);
  const lo = Math.min(...six), hi = Math.max(...six);
  console.log(JSON.stringify({ sixPlayerSites: six.length, min: lo, max: hi }));
  assert.ok(lo >= 15 && hi <= 32, `6-player sites: ${lo}..${hi} containers`);
  assert.deepEqual(containersOf(generateHub()), []);
});

test('container part tables match the GLBs (recentred loader frame, 1 cm)', { skip: !existsSync(resolve(PROPS, 'desk.glb')) && 'no .assets/build/props' }, () => {
  const bad: string[] = [];
  for (const key of Object.keys(CONTAINER_NODES)) {
    if (!existsSync(resolve(PROPS, `${key}.glb`))) { bad.push(`${key}.glb not built`); continue; }
    const gb = glbBounds(resolve(PROPS, `${key}.glb`));
    const def = containerDefFor({ data: { prop: key } })!;
    const names = new Set(gb.nodes.map((n) => n.name));
    for (const n of CONTAINER_NODES[key]) if (!names.has(n)) bad.push(`${key}: node ${n} missing`);
    // model footprint = PROP_DEFS (the collision box)
    const pd = PROP_DEFS[key];
    const size = gb.model.max.map((v, k) => v - gb.model.min[k]);
    // STRETCH hosts may not be furniture yet (no PROP_DEFS entry): then only the part tables are checked
    if (pd && (Math.abs(size[0] - pd.w) > 0.02 || Math.abs(size[2] - pd.d) > 0.02 || Math.abs(size[1] - pd.h) > 0.02)) bad.push(`${key}: model ${size} vs PROP_DEFS ${pd.w}x${pd.h}x${pd.d}`);
    for (const p of def.parts) {
      const nb = gb.nodes.find((n) => n.name === p.node);
      if (!nb) { bad.push(`${key}: part ${p.idx} node ${p.node}`); continue; }
      let c = nb.min.map((v, k) => (v + nb.max[k]) / 2), s = nb.min.map((v, k) => nb.max[k] - v);
      if (p.authoredOpen && p.hinge) {
        // back to the closed pose: rotate by -sign * travel about the hinge axis (x) through the pivot
        const a = -p.hinge.sign * p.travel, [, py, pz] = p.hinge.pivot;
        const dy = c[1] - py, dz = c[2] - pz;
        c = [c[0], py + dy * Math.cos(a) - dz * Math.sin(a), pz + dy * Math.sin(a) + dz * Math.cos(a)];
        if (Math.abs(Math.abs(a) - Math.PI / 2) < 1e-9) s = [s[0], s[2], s[1]];
      }
      for (let k = 0; k < 3; k++) {
        if (Math.abs(c[k] - p.local[k]) > 0.01) bad.push(`${key} ${p.node}: centre[${k}] ${c[k].toFixed(3)} vs ${p.local[k]}`);
        if (Math.abs(s[k] - p.size[k]) > 0.01) bad.push(`${key} ${p.node}: size[${k}] ${s[k].toFixed(3)} vs ${p.size[k]}`);
      }
      // the front face of each drawer sits at (or just past) the host's front
      if (p.kind === 'drawer' && Math.abs(p.local[2] + p.size[2] / 2 - def.frontZ) > 0.03) bad.push(`${key} ${p.node}: front ${p.local[2] + p.size[2] / 2} vs ${def.frontZ}`);
    }
  }
  assert.deepEqual(bad, []);
});
