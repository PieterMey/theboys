// Owner: track (d) Meta. v1.3: the drive screen's optional monster cards follow the monsters' own spawn rules
// (flow.ts driveMonsters reads balance.monsters the way monsters/runtime.ts does): on a Risk 1 site the Snatcher comes
// from the 3rd contract of a shift (contract index 2), never on the 2nd; a balance change moves the card with it; the
// cards agree with the field guide (fieldguide/logic.ts presentMonsters). The real flow: tests/meta/drivecards.e2e.ts.
//   node --test tests/meta/drivecards.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { driveMonsters } from '../../apps/server/src/meta/flow.ts';
import { presentMonsters } from '../../apps/server/src/fieldguide/logic.ts';

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(join(import.meta.dirname, '../..', p), 'utf8')) as Record<string, unknown>;
const monsters = readJson('config/balance/monsters.json');
const flags = readJson('config/flags.json');
const balance = { monsters };
type Opts = Partial<Parameters<typeof driveMonsters>[0]>;
const at = (risk: number, contractIndex: number, o: Opts = {}) => driveMonsters({ risk, contractIndex, hasVents: true, flags, balance, ...o });

test('Risk 1: no Snatcher on the 1st or 2nd contract of a shift; the Snatcher and the Mannequin on the 3rd', () => {
  assert.deepEqual(at(1, 0), { mannequin: false, snatcher: false });
  assert.deepEqual(at(1, 1), { mannequin: false, snatcher: false }, 'the 2nd contract (index 1): no Snatcher card');
  assert.deepEqual(at(1, 2), { mannequin: true, snatcher: true }, 'the 3rd contract (index 2)');
});

test('Risk 2: both from the first contract; no vents, no Snatcher; a flag off, no card', () => {
  assert.deepEqual(at(2, 0), { mannequin: true, snatcher: true });
  assert.deepEqual(at(2, 0, { hasVents: false }), { mannequin: true, snatcher: false });
  assert.deepEqual(at(1, 2, { flags: { ...flags, snatcher: false } }), { mannequin: true, snatcher: false });
  assert.deepEqual(at(1, 2, { flags: { ...flags, mannequin: false } }), { mannequin: false, snatcher: true });
});

test('the balance moves the cards; without a balance the defaults are the runtime\'s (2 and 2)', () => {
  const sn = monsters.snatcher as Record<string, unknown>;
  const earlier = { monsters: { ...monsters, snatcher: { ...sn, minContractIndex: 1 } } };
  assert.equal(at(1, 1, { balance: earlier }).snatcher, true, 'minContractIndex 1: the 2nd contract');
  const riskier = { monsters: { ...monsters, snatcher: { ...sn, minRisk: 3 } } };
  assert.equal(at(2, 0, { balance: riskier }).snatcher, false, 'minRisk 3: not on Risk 2');
  for (const b of [{}, { monsters: {} }, { monsters: { snatcher: { minContractIndex: 'x' } } }]) {
    assert.deepEqual(at(1, 1, { balance: b }), { mannequin: false, snatcher: false }, JSON.stringify(b));
    assert.deepEqual(at(1, 2, { balance: b }), { mannequin: true, snatcher: true }, JSON.stringify(b));
  }
});

test('the drive cards and the field guide agree on every risk, contract and vents case', () => {
  for (const risk of [1, 2]) {
    for (const contractIndex of [0, 1, 2]) {
      for (const hasVents of [true, false]) {
        const guide = presentMonsters({ risk, contractIndex, hasVents, mannequin: flags.mannequin !== false, snatcher: flags.snatcher !== false, balance: balance as never });
        const cards = at(risk, contractIndex, { hasVents });
        const where = `risk ${risk}, contract index ${contractIndex}, vents ${hasVents}`;
        assert.equal(cards.snatcher, guide.includes('snatcher'), `snatcher: ${where}`);
        assert.equal(cards.mannequin, guide.includes('mannequin'), `mannequin: ${where}`);
      }
    }
  }
});
