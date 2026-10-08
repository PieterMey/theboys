// v1.2 (G3) spawn planners over 300 generated sites (1-6 players, risk 1-3): special finds, crafting materials and
// drawer contents are deterministic, never share a slot, follow room affinity and stay within +-20% of the formula.
// Run: node --test tests/gear/finds.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import type { LayoutItem, LevelLayout } from '../../packages/shared/src/layout.ts';
import { makeRng } from '../../packages/shared/src/rng.ts';
import { CURIOS, MATERIAL_TYPES } from '../../packages/shared/src/catalog.ts';
import { ITEM_DEFS } from '../../packages/shared/src/interactables.ts';
import {
  CONTAINER_LOOT_DEFAULT, DRAWER_LOOT_NAMES, MATERIALS_DEFAULT, materialCount, planFinds, planMaterials, rollContainers,
} from '../../apps/server/src/interaction/spawns.ts';
import { LOOT_NAMES } from '../../packages/shared/src/interactables.ts';
import type { FindsCfg } from '../../apps/server/src/interaction/spawns.ts';
import { fakeContainers } from '../interaction/v12lib.ts';

const N = Number(process.env.FINDS_SEEDS ?? 300);
const FINDS: FindsCfg = {
  finds: { syringe: 0.45, charm: 0.3, 'loot.idol': 0.35, lockpick: 0.3, soles: 0.2, nvg: 0.1, masterkey: 0.1, 'loot.curio': 0.4 },
  findRooms: { lockpick: ['office', 'warden', 'lockers', 'mailroom'], soles: ['lockers', 'laundry', 'showers'], nvg: ['server', 'radio', 'warden'] },
  minDistFrac: 0.6, idolValue: [350, 500], curioValue: [60, 140], gearV12: true,
};
const TIERS: [number, number][] = [[8, 35], [35, 90], [150, 300]];

interface Site { L: LevelLayout; players: number; risk: number; free: LayoutItem[] }
const sites: Site[] = [];
for (let i = 0; i < N; i++) {
  const players = 1 + (i % 6), risk = 1 + (Math.floor(i / 6) % 3);
  const L = generateFacility({ seed: `g3-finds-${i}`, players, risk });
  const free = makeRng(`${L.seed}:${L.hash}`, 'interaction.extras').shuffle(L.items.filter((x) => x.kind === 'loot'));
  sites.push({ L, players, risk, free });
}

test(`finds: deterministic, one slot each, v1.1 types deep, masterkey only with a locked door (${N} sites)`, () => {
  const count: Record<string, number> = {};
  for (const { L, free } of sites) {
    const a = planFinds(L, free, FINDS);
    const b = planFinds(L, free, FINDS);
    assert.deepEqual(a.specs, b.specs, `${L.seed}: deterministic`);
    const slots = a.specs.map((s) => s.slot);
    assert.equal(new Set(slots).size, slots.length, `${L.seed}: no reused slot`);
    assert.equal(new Set(a.specs.map((s) => s.type)).size, a.specs.length, 'at most one of each');
    const maxD = Math.max(...L.spaces.map((s) => s.dist ?? 0));
    for (const s of a.specs) {
      count[s.type] = (count[s.type] ?? 0) + 1;
      const sl = L.items.find((x) => x.id === s.slot)!;
      const sp = L.spaces[sl.space]!;
      assert.notEqual(sp.kind, 'corridor', 'never a corridor');
      if (['syringe', 'charm', 'loot.idol'].includes(s.type)) assert.ok(sp.dist >= maxD * 0.6 - 1e-9, `${s.type} deep`);
      if (s.type === 'masterkey') assert.ok(L.doors.some((d) => d.kind === 'locked'), 'masterkey needs a locked door');
      if (s.type === 'loot.curio') {
        assert.ok(s.value! >= 60 && s.value! <= 140 && CURIOS.includes(s.name!), 'curio value + name');
      }
      if (s.type === 'lockpick') assert.equal(s.count, 3, 'a full set of picks');
      if (s.type === 'masterkey') assert.equal(s.count, 3, '3 charges');
    }
    // gearV12 off: only the v1.1 types, with the exact v1.1 rolls (the new types come after them)
    const off = planFinds(L, free, { ...FINDS, gearV12: false });
    assert.ok(off.specs.every((s) => ['syringe', 'charm', 'loot.idol'].includes(s.type)));
    const v11 = a.specs.filter((s) => ['syringe', 'charm', 'loot.idol'].includes(s.type));
    assert.deepEqual(off.specs, v11, `${L.seed}: v1.1 finds unchanged by the v1.2 types`);
  }
  // rates roughly follow the chances (deep slots exist on every site)
  for (const [t, p] of Object.entries(FINDS.finds)) {
    if (t === 'masterkey') continue;
    const rate = (count[t] ?? 0) / N;
    assert.ok(Math.abs(rate - p) < 0.12, `${t}: ${rate.toFixed(2)} vs ${p}`);
  }
});

test(`materials: deterministic, free slots only, never shared with finds, +-20% of the formula, room affinity (${N} sites)`, () => {
  let inAff = 0, total = 0, slotsAff = 0, slotsAll = 0;
  const perType: Record<string, number> = {};
  let relicOutside = 0;
  for (const { L, free, players, risk } of sites) {
    const finds = planFinds(L, free, FINDS);
    const left = free.filter((x) => !finds.used.has(x.id)).slice(6); // the 6 tool extras come first
    const a = planMaterials(L, left, players, risk);
    assert.deepEqual(a, planMaterials(L, left, players, risk), 'deterministic');
    const want = materialCount(players, risk);
    assert.ok(Math.abs(a.length - want) <= Math.ceil(want * 0.2), `${L.seed}: ${a.length} vs ${want}`);
    const slots = a.map((m) => m.slot);
    assert.equal(new Set(slots).size, slots.length, 'one pickup per slot');
    assert.ok(slots.every((s) => !finds.used.has(s!)), 'never on a find slot');
    for (const m of a) {
      assert.ok((MATERIAL_TYPES as readonly string[]).includes(m.type));
      assert.ok(m.count! >= 1 && m.count! <= 2, '1-2 units');
      const room = L.spaces[L.items.find((x) => x.id === m.slot)!.space]!.type;
      perType[m.type] = (perType[m.type] ?? 0) + 1;
      if (m.type === 'mat.relic') { if (!MATERIALS_DEFAULT.relicRooms.includes(room)) relicOutside++; continue; }
      total++;
      if (MATERIALS_DEFAULT.affinity[m.type]?.includes(room)) inAff++;
    }
    // baseline: how often a random material would land in one of its affinity rooms
    for (const sl of left) {
      const room = L.spaces[sl.space]?.type ?? '';
      for (const t of MATERIAL_TYPES) {
        if (t === 'mat.relic') continue;
        slotsAll++;
        if (MATERIALS_DEFAULT.affinity[t]?.includes(room)) slotsAff++;
      }
    }
  }
  assert.equal(relicOutside, 0, 'relics only in chapels, galleries and morgues');
  const share = inAff / Math.max(1, total), base = slotsAff / Math.max(1, slotsAll);
  assert.ok(share > base * 1.6, `affinity: ${(share * 100).toFixed(1)}% in affinity rooms vs ${(base * 100).toFixed(1)}% by chance`);
  for (const t of MATERIAL_TYPES) if (t !== 'mat.relic') assert.ok((perType[t] ?? 0) > N / 4, `${t} appears (${perType[t]})`);
});

test(`containers: deterministic, budget held, ~40% empty, flags respected (${N} sites)`, () => {
  let empty = 0, all = 0, mats = 0;
  for (const { L, players, risk } of sites.slice(0, Math.min(N, 120))) {
    const list = fakeContainers(L);
    const budget = 650 * (risk === 1 ? 1 : risk === 2 ? 1.35 : 1.75) * (0.8 + players * 0.15) * 0.15;
    const o = { cfg: CONTAINER_LOOT_DEFAULT, materials: true, gearV12: true, salvage: true, tierValues: TIERS };
    const r = rollContainers(L, list, budget, o);
    assert.deepEqual([...r.contents], [...rollContainers(L, list, budget, o).contents], 'deterministic');
    assert.ok(r.spent <= budget * 1.08 + 1e-9, `${L.seed}: drawer salvage ${r.spent} <= budget ${budget.toFixed(0)}`);
    for (const items of r.contents.values()) {
      all++;
      if (!items.length) empty++;
      assert.ok(items.length <= 2);
      for (const it of items) {
        assert.ok(it.type === 'page' || !!ITEM_DEFS[it.type], `known type ${it.type}`);
        if (it.type.startsWith('loot.')) assert.ok((it.tier ?? 0) <= 1, 'drawer salvage is tier 0-1');
        if (it.type.startsWith('mat.')) mats++;
      }
    }
    // v1.2 item models: drawer salvage is named from the drawer-sized subset; the rolls are the same with any name list
    for (const items of r.contents.values()) for (const it of items) {
      if (!it.type.startsWith('loot.')) continue;
      assert.ok(DRAWER_LOOT_NAMES[it.tier ?? 0]!.includes(it.name!), `drawer salvage '${it.name}' fits a drawer`);
      assert.ok(LOOT_NAMES[it.tier ?? 0]!.includes(it.name!), 'a frozen LOOT_NAMES flavour');
    }
    const anyName = rollContainers(L, list, budget, { ...o, drawerNames: false });
    const unnamed = (m: typeof r.contents) => [...m].map(([k, v]) => [k, v.map(({ name: _n, ...rest }) => rest)]);
    assert.deepEqual(unnamed(anyName.contents), unnamed(r.contents), 'names never move another roll');
    assert.equal(anyName.spent, r.spent);
    const off = rollContainers(L, list, budget, { ...o, materials: false, gearV12: false });
    for (const items of off.contents.values()) for (const it of items) {
      assert.ok(!it.type.startsWith('mat.'), 'materials off: no mats');
      assert.ok(!['battery', 'lockpick', 'masterkey', 'nvg', 'soles', 'flashbulb'].includes(it.type), 'gearV12 off: no v1.2 gear');
    }
  }
  const rate = empty / Math.max(1, all);
  assert.ok(rate > 0.28 && rate < 0.55, `empty rate ${(rate * 100).toFixed(0)}%`);
  assert.ok(mats > 0, 'drawers hold materials');
});
