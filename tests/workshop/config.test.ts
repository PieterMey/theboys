// Owner: workshop (v1.2). Pure checks of config/balance/crafting.json against the shared catalog (no server):
//   every frozen LOOT_NAMES flavour + the idol has a salvage yield, recipes give pool/hand-out gear only, upgrades are
//   exactly VAN_UPGRADES, numbers are positive whole units, and the yields the brief pins down.
// Run: node --test tests/workshop/config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEAR_PACKS, LOOT_NAMES } from '../../packages/shared/src/interactables.ts';
import { HANDOUT_ONLY, MATERIAL_TYPES, POOL_TYPES, VAN_UPGRADES } from '../../packages/shared/src/catalog.ts';

type Mats = Record<string, number>;
const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '../../config/balance/crafting.json'), 'utf8')) as {
  firedWipes: boolean; scrapHoldMs: number; benchRangeM: number; tierFallback: number[];
  recipes: { id: string; tier: number; name: string; out: string; qty: number; cost: Mats; desc: string; scrip?: number }[];
  upgrades: { id: string; name: string; scrip: number; cost: Mats; desc: string }[];
  salvage: Record<string, Mats>;
};
const mats = new Set<string>(MATERIAL_TYPES);
const wholePositive = (m: Mats) => Object.entries(m).every(([k, n]) => mats.has(k) && Number.isInteger(n) && n > 0);

test('knobs', () => {
  assert.equal(cfg.firedWipes, true);
  assert.equal(cfg.scrapHoldMs, 1200);
  assert.equal(cfg.benchRangeM, 3);
  assert.deepEqual(cfg.tierFallback, [1, 2, 4]);
});

test('the salvage table covers all 24 frozen names (LOOT_NAMES + the Cursed idol)', () => {
  const names = [...LOOT_NAMES.flat(), 'Cursed idol'];
  assert.equal(names.length, 24);
  for (const n of names) assert.ok(cfg.salvage[n] && Object.keys(cfg.salvage[n]).length, `salvage yield for ${n}`);
  assert.deepEqual(Object.keys(cfg.salvage).sort(), [...names].sort(), 'no unknown names');
  for (const [n, y] of Object.entries(cfg.salvage)) assert.ok(wholePositive(y), `${n}: material keys, whole units`);
  assert.deepEqual(cfg.salvage['Circuit board'], { 'mat.wiring': 2 });
  assert.deepEqual(cfg.salvage['Server blade rack'], { 'mat.wiring': 4, 'mat.cells': 2 });
  assert.deepEqual(cfg.salvage['Cryo canister'], { 'mat.chem': 4, 'mat.cells': 1 });
  assert.deepEqual(cfg.salvage['Cursed idol'], { 'mat.relic': 2 });
  // relic only from the idol (and world finds): never from ordinary salvage
  for (const [n, y] of Object.entries(cfg.salvage)) if (n !== 'Cursed idol') assert.ok(!y['mat.relic'], `${n} gives no relic`);
});

test('recipes: unique ids, gear the pool can hold, whole costs, tier I/II as briefed', () => {
  const ids = cfg.recipes.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  const handout = new Set([...POOL_TYPES, ...HANDOUT_ONLY]);
  for (const r of cfg.recipes) {
    const real = GEAR_PACKS[r.out]?.type ?? r.out;
    assert.ok(handout.has(real), `${r.id}: ${r.out} is POOL_TYPES + HANDOUT_ONLY`);
    assert.ok(r.tier === 1 || r.tier === 2, `${r.id}: tier`);
    assert.ok(Number.isInteger(r.qty) && r.qty > 0, `${r.id}: qty`);
    assert.ok(wholePositive(r.cost) && Object.keys(r.cost).length, `${r.id}: cost`);
    assert.ok(r.name && r.desc, `${r.id}: copy`);
    assert.ok(!('xp' in r), `${r.id}: no XP for crafting`);
  }
  const by = (out: string) => cfg.recipes.find((r) => r.out === out)!;
  const want: [string, number, number, Mats][] = [
    ['battery', 1, 2, { 'mat.cells': 1, 'mat.scrap': 1 }], ['lockpick', 1, 3, { 'mat.scrap': 2, 'mat.wiring': 1 }], ['soles', 1, 1, { 'mat.chem': 2 }],
    ['glowstick', 1, 5, { 'mat.chem': 1 }], ['flare', 1, 3, { 'mat.chem': 2, 'mat.scrap': 1 }], ['medkit', 1, 1, { 'mat.chem': 3 }],
    ['sensor', 1, 2, { 'mat.wiring': 2, 'mat.optics': 1 }], ['crowbar', 1, 1, { 'mat.scrap': 3 }], ['walkie', 1, 1, { 'mat.wiring': 2, 'mat.cells': 1 }],
    ['flashlight_pro', 1, 1, { 'mat.optics': 2, 'mat.wiring': 1, 'mat.cells': 1 }], ['lure', 1, 2, { 'mat.scrap': 2, 'mat.wiring': 1 }],
    ['masterkey', 2, 3, { 'mat.wiring': 4, 'mat.relic': 1 }], ['nvg', 2, 1, { 'mat.optics': 4, 'mat.wiring': 3, 'mat.cells': 2 }], ['syringe', 2, 1, { 'mat.chem': 4 }],
    ['charm', 2, 1, { 'mat.relic': 1, 'mat.scrap': 2 }], ['flashbulb', 2, 3, { 'mat.optics': 3, 'mat.cells': 2, 'mat.chem': 1 }],
    ['receiver', 2, 5, { 'mat.wiring': 3, 'mat.cells': 2, 'mat.relic': 1 }],
  ];
  assert.equal(cfg.recipes.length, want.length);
  for (const [out, tier, qty, cost] of want) {
    const r = by(out);
    assert.ok(r, `recipe for ${out}`);
    assert.equal(r.tier, tier, `${out} tier`);
    assert.equal(r.qty, qty, `${out} qty`);
    assert.deepEqual(r.cost, cost, `${out} cost`);
  }
});

test('upgrades: exactly the four VAN_UPGRADES with the briefed prices', () => {
  assert.deepEqual(cfg.upgrades.map((u) => u.id).sort(), [...VAN_UPGRADES].sort());
  const u = Object.fromEntries(cfg.upgrades.map((x) => [x.id, x]));
  assert.deepEqual([u.bench_tools.scrip, u.bench_tools.cost], [150, { 'mat.scrap': 4, 'mat.wiring': 3 }]);
  assert.deepEqual([u.charging_rack.scrip, u.charging_rack.cost], [120, { 'mat.cells': 3, 'mat.wiring': 2 }]);
  assert.deepEqual([u.scanner.scrip, u.scanner.cost], [180, { 'mat.wiring': 4, 'mat.optics': 2 }]);
  assert.deepEqual([u.stretcher.scrip, u.stretcher.cost], [200, { 'mat.scrap': 4, 'mat.chem': 3 }]);
  assert.equal(u.bench_tools.name, 'Soldering station', "tier II lock text is 'Needs: Soldering station'");
});
