// Owner: track (a) Objectives. Unit tests: loot budget/rolls, vault code, clue notes (placeholders + code halves).
//   node --test tests/objectives/loot.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { lootBudget, rollLoot } from '../../apps/server/src/objectives/loot.ts';
import type { LootTuning } from '../../apps/server/src/objectives/loot.ts';
import { makeCode, resolveNotes } from '../../apps/server/src/objectives/notes.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const core = JSON.parse(readFileSync(join(ROOT, 'config/balance/core.json'), 'utf8')) as Record<string, unknown>;
const bal = JSON.parse(readFileSync(join(ROOT, 'config/balance/objectives.json'), 'utf8')) as Record<string, unknown>;
const tuning: LootTuning = {
  lootValue: bal.lootValue as LootTuning['lootValue'],
  lootClassByTier: bal.lootClassByTier as LootTuning['lootClassByTier'],
  lootSlotWeightByTier: bal.lootSlotWeightByTier as number[],
  lootMaxPerSpace: bal.lootMaxPerSpace as number,
  lootMaxHeavy: bal.lootMaxHeavy as number,
  lootFragileChance: bal.lootFragileChance as number,
};
const fixtures = readdirSync(join(ROOT, 'tests/fixtures/layouts')).filter((f) => f.startsWith('facility'));
const load = (f: string) => JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/layouts', f), 'utf8')) as LevelLayout;

test('loot budget = base x risk mult x player mult', () => {
  const base = core.lootBudgetBase as number;
  assert.equal(lootBudget(core, 1, 4), base);
  assert.equal(lootBudget(core, 1, 2), Math.round(base * 0.75));
  assert.equal(lootBudget(core, 2, 6), Math.round(base * 1.4 * 1.25));
});

test('rolled loot spends roughly the budget, values in class ranges, deterministic', () => {
  for (const f of fixtures) {
    const L = load(f);
    for (const players of [2, 4, 6]) {
      const budget = lootBudget(core, Number(L.metrics.risk ?? 1), players);
      const a = rollLoot(L, `${L.seed}|x`, budget, tuning);
      const b = rollLoot(L, `${L.seed}|x`, budget, tuning);
      assert.deepEqual(a, b, 'deterministic');
      const total = a.reduce((s, l) => s + l.value, 0);
      assert.ok(total >= budget * 0.85 && total <= budget + tuning.lootValue.heavy[1], `${f} p${players}: total ${total} vs budget ${budget}`);
      for (const l of a) {
        const [lo, hi] = tuning.lootValue[l.cls];
        assert.ok(l.value >= Math.min(lo, budget) && l.value <= hi, `${l.id} ${l.cls} ${l.value}`);
        assert.ok(L.items.some((i) => i.id === l.id && i.kind === 'loot'), 'uses a layout loot slot');
      }
      assert.ok(a.filter((l) => l.cls === 'heavy').length <= tuning.lootMaxHeavy);
      const ids = new Set(a.map((l) => l.id));
      assert.equal(ids.size, a.length, 'one item per slot');
    }
  }
});

test('vault code: 4 digits, deterministic, no triple digits', () => {
  for (let i = 0; i < 200; i++) {
    const c = makeCode(`seed${i}`);
    assert.match(c, /^\d{4}$/);
    assert.equal(c, makeCode(`seed${i}`));
    const counts = new Map<string, number>();
    for (const d of c) counts.set(d, (counts.get(d) ?? 0) + 1);
    assert.ok(Math.max(...counts.values()) <= 2, c);
  }
});

test('clue notes: two code halves in different slots, placeholders resolved, AI notes kept', () => {
  for (const f of fixtures) {
    const L = load(f);
    const code = makeCode(L.seed);
    const notes = resolveNotes({
      layout: L, code, seedKey: L.seed, siteName: 'Test Site',
      orderNotes: [{ title: 'Memo for {{SITE}}', body: 'Breakers are in {{LEVER_A}} and {{LEVER_B}}. Vault: {{VAULT}}. {{NOPE}}' }],
    });
    const a = notes.find((n) => n.codeHalf === 'A');
    const b = notes.find((n) => n.codeHalf === 'B');
    assert.ok(a && b, `${f}: both halves placed`);
    assert.notEqual(a!.id, b!.id);
    assert.ok(a!.body.includes(`${code[0]} and ${code[1]}`), a!.body);
    assert.ok(b!.body.includes(`${code[2]} and ${code[3]}`), b!.body);
    for (const n of notes) {
      assert.ok(!/\{\{/.test(n.body + n.title), `unresolved placeholder in ${n.id}: ${n.body}`);
      assert.ok(!n.body.includes(code) || n.codeHalf === undefined, 'no note carries the full code unless asked to');
      assert.ok(L.items.some((i) => i.id === n.id && i.kind === 'note'));
    }
    const ai = notes.find((n) => n.title === 'Memo for Test Site');
    assert.ok(ai, 'order note placed');
    assert.ok(!ai!.body.includes('LEVER_A'));
  }
});
