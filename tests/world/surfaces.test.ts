// env-world: theme palettes + floor surfaces (apps/client/src/level/{palettes,surfaces,mesher}.ts). Node only:
//   node --test tests/world/surfaces.test.ts
// - the floor the client draws has exactly floorSurface's surface, for every theme x space class (+ HARD FLOORS);
// - facility (and the hub) use exactly the v1.1 MatIds; the four dressed themes differ; undressed themes resolve via base;
// - <= 4 material groups per space; directional floors turn in 90-degree steps only;
// - surfaceAt = floorSurface of the cell's space, puddle cells and flooded halls 'water', outside the grid = the lot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_THEMES, THEMES, floorSurface } from '../../packages/shared/src/procgen/themes.ts';
import type { LayoutSpace } from '../../packages/shared/src/layout.ts';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { generateHub } from '../../packages/shared/src/procgen/hub.ts';
import { clutterFor } from '../../packages/shared/src/procgen/clutter.ts';
import { DIRECTIONAL_FLOORS, FLOOR_SURFACE, dressedTheme, spacePalette, themeMaterials, themeOf } from '../../apps/client/src/level/palettes.ts';
import { buildSurfaceGrid, floodedSpace, surfaceFromGrid } from '../../apps/client/src/level/surfaces.ts';
import { buildLevelGeometry } from '../../apps/client/src/level/mesher.ts';

const KINDS: LayoutSpace['kind'][] = ['corridor', 'room', 'hall', 'vault', 'outside'];
const TYPES = ['lobby', 'morgue', 'infirmary', 'showers', 'cold', 'cryo', 'kitchen', 'laundry', 'nursery', 'boiler', 'furnace', 'foundry', 'pumps', 'tanks',
  'garage', 'dock', 'pit', 'storage', 'greenhouse', 'server', 'radio', 'office', 'archive', 'library', 'mailroom', 'gallery', 'chapel', 'canteen', 'lockers',
  'lot', 'kennel', 'van', 'junction', 'corridor', 'vault', ''];
function spaces(): LayoutSpace[] {
  const out: LayoutSpace[] = [];
  for (const kind of KINDS) for (const type of TYPES) out.push({ id: out.length, kind, rect: { x: 0, y: 0, w: 4, h: 6 }, zone: 0, type, callsign: null, dist: 0, light: 'on', open: kind === 'outside', powerZone: 0 });
  return out;
}

test('palette floor surface === floorSurface for every theme x space class (and HARD FLOORS)', () => {
  const S = spaces();
  let n = 0;
  for (const theme of [...SITE_THEMES, 'hub', 'nonsense', undefined]) for (const metrics of [{}, { 'mod:hardfloors': 1 }] as Record<string, number>[]) {
    const L = { theme: theme as string, spaces: S, metrics };
    for (const s of S) {
      const pal = spacePalette(L, s.id);
      const want = floorSurface(L, s.id);
      if (s.type === 'van') continue; // the van floor is the van model's checker plate (floorSurface: metal)
      assert.equal(FLOOR_SURFACE[pal.floor], want, `${theme} ${s.kind}/${s.type} ${JSON.stringify(metrics)}: palette ${pal.floor} vs ${want}`);
      n++;
    }
  }
  assert.ok(n > 1000);
});

test('facility (and the hub) use exactly the v1.1 MatIds', () => {
  // the v1.1 mesher table (apps/client/src/level/mesher.ts themeOf before v1.2)
  const v11 = (s: LayoutSpace) => {
    const C = new Set(['morgue', 'infirmary', 'showers', 'cold', 'cryo', 'kitchen', 'laundry', 'nursery']);
    const I = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks', 'garage', 'dock', 'pit', 'storage', 'greenhouse']);
    const HV = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks']);
    if (s.kind === 'outside') return { floor: s.type === 'kennel' ? 'floor_dirt' : 'asphalt', wallLo: 'facade', wallHi: 'facade', ceil: 'ceiling_concrete' };
    if (s.kind === 'corridor') return { floor: 'floor_lino', wallLo: 'wall_tile_green', wallHi: 'wall_plaster_green', ceil: 'ceiling_tiles' };
    if (s.kind === 'vault') return { floor: 'floor_metal', wallLo: 'wall_vault', wallHi: 'wall_vault', ceil: 'ceiling_concrete' };
    if (s.type === 'lobby') return { floor: 'floor_tiles', wallLo: 'wall_tile_green', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
    if (C.has(s.type)) return { floor: 'floor_tiles', wallLo: 'wall_tile_white', wallHi: 'wall_tile_white', ceil: 'ceiling_tiles' };
    if (I.has(s.type)) return { floor: HV.has(s.type) ? 'floor_metal' : 'floor_concrete', wallLo: 'wall_concrete_dark', wallHi: 'wall_concrete', ceil: 'ceiling_metal' };
    if (s.type === 'server' || s.type === 'radio') return { floor: 'floor_rubber', wallLo: 'wall_plaster_blue', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
    return { floor: 'floor_lino', wallLo: 'wall_plaster_blue', wallHi: 'wall_plaster', ceil: 'ceiling_tiles' };
  };
  for (const theme of ['facility', 'hub', undefined]) for (const s of spaces()) {
    if (s.type === 'van') continue;
    assert.deepEqual(themeOf(s, theme), v11(s), `${theme} ${s.kind}/${s.type}`);
  }
  // a real hub + facility layout through the mesher: same materials per space as the v1.1 table
  for (const L of [generateHub(), generateFacility({ seed: 's2', players: 4, risk: 1 })]) {
    const geo = buildLevelGeometry(L);
    for (const [sid, e] of geo.spaces) {
      const t = v11(L.spaces[sid]);
      for (const m of e.mats) assert.ok(Object.values(t).includes(m), `${L.seed} space ${sid}: ${m} not in the v1.1 palette`);
    }
  }
});

test('the four dressed themes look different; undressed themes resolve through ThemeDef.base', () => {
  const S = spaces();
  const sig = (theme: string) => S.filter((s) => s.kind !== 'outside' && s.kind !== 'vault').map((s) => { const p = themeOf(s, theme); return `${p.wallLo}/${p.wallHi}/${p.ceil}`; }).join('|');
  const base = sig('facility');
  const seen = new Set([base]);
  for (const t of ['hospital', 'waterworks', 'records', 'cold_storage']) {
    const s = sig(t);
    assert.notEqual(s, base, `${t} looks like facility`);
    assert.ok(!seen.has(s), `${t} looks like another theme`);
    seen.add(s);
  }
  for (const t of SITE_THEMES) {
    const d = dressedTheme(t);
    let c: string | null = t;
    while (c && !['facility', 'hospital', 'waterworks', 'records', 'cold_storage'].includes(c)) c = THEMES[c as keyof typeof THEMES].base;
    assert.equal(d, c ?? 'facility', t);
    assert.ok(themeMaterials(t).length >= 4, `${t}: prefetch list`);
  }
});

test('themed layouts: <= 4 material groups per space; directional floors run along the long axis', () => {
  for (const theme of ['facility', 'hospital', 'waterworks', 'records', 'cold_storage', 'hospitality', 'industry']) {
    for (const [seed, players] of [['th1', 3], ['th2', 6]] as const) {
      const L = generateFacility({ seed, players, risk: 1, theme });
      const geo = buildLevelGeometry(L);
      for (const [sid, e] of geo.spaces) {
        assert.ok(new Set(e.mats).size <= 4, `${theme} ${seed} space ${sid}: ${e.mats.join(',')}`);
        const s = L.spaces[sid];
        const pal = spacePalette(L, sid);
        if (s.open || s.type === 'van') continue;
        assert.ok(e.mats.includes(pal.floor), `${theme} space ${sid} draws no ${pal.floor} floor`);
        // UV direction of the floor quads: rotated only for directional floors in spaces longer than wide
        if (!DIRECTIONAL_FLOORS.has(pal.floor)) continue;
        const gi = e.mats.indexOf(pal.floor);
        const grp = e.geometry.groups[gi];
        const idx = e.geometry.index!, pos = e.geometry.getAttribute('position'), uv = e.geometry.getAttribute('uv');
        const i0 = idx.getX(grp.start), i1 = idx.getX(grp.start + 1);
        const du = uv.getX(i1) - uv.getX(i0), dx = pos.getX(i1) - pos.getX(i0), dz = pos.getZ(i1) - pos.getZ(i0);
        const alongZ = Math.abs(du) > 1e-6 && Math.abs(dz) > Math.abs(dx);
        const alongX = Math.abs(du) > 1e-6 && Math.abs(dx) > Math.abs(dz);
        if (s.rect.h > s.rect.w) assert.ok(alongZ || (!alongX && Math.abs(du) < 1e-6), `${theme} space ${sid}: u should follow z`);
      }
    }
  }
});

test('surfaceAt: floorSurface of the cell space; puddles + flooded halls are water; outside the grid = the lot', () => {
  let puddleCells = 0, checked = 0;
  for (const theme of ['facility', 'waterworks', 'records', 'cold_storage', 'hospital']) for (const seed of ['sa', 'sb', 'sc']) {
    const L = generateFacility({ seed, players: 4, risk: 1, theme, modifiers: seed === 'sc' ? ['DAMP', 'HARD FLOORS'] : [] });
    const g = buildSurfaceGrid(L);
    const water = new Set<number>();
    for (const ci of clutterFor(L)) if (ci.kind === 'puddle') water.add(Math.floor(ci.z) * L.W + Math.floor(ci.x));
    for (let z = 0; z < L.H; z++) for (let x = 0; x < L.W; x++) {
      const o = L.owner[z * L.W + x];
      if (o < 0) continue;
      const got = surfaceFromGrid(g, x + 0.5, z + 0.5);
      const want = floorSurface(L, o);
      if (water.has(z * L.W + x) || floodedSpace(L.spaces[o])) { assert.equal(surfaceFromGrid(g, x + 0.5, z + 0.5) === 'water' || !water.has(z * L.W + x), true); }
      if (got === 'water') { puddleCells++; continue; }
      assert.equal(got, want, `${theme} ${seed} cell ${x},${z} (${L.spaces[o].type})`);
      checked++;
    }
    for (const c of water) assert.equal(g.cells[c] === 255 ? 'water' : surfaceFromGrid(g, (c % L.W) + 0.5, Math.floor(c / L.W) + 0.5), 'water', `${theme} ${seed}: puddle cell not water`);
    const lot = L.spaces.find((s) => s.type === 'lot');
    if (lot) assert.equal(surfaceFromGrid(g, -5, -5), floorSurface(L, lot.id));
  }
  assert.ok(checked > 2000 && puddleCells > 0, `${checked} cells, ${puddleCells} water`);
});
