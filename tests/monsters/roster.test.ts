// Owner: track (c) Monsters (v1.3 F2). Unit (no server): which monsters a contract starts with.
//  - the Snatcher comes from the crew's 3rd contract (contractIndex >= snatcher.minContractIndex = 2) or at risk >= 2;
//    contract index 0 and 1 at risk 1 have no Snatcher (the 2026-10-08 friends met 3 monsters on their first contract
//    because the host's solo run had already moved the counter)
//  - Hound + Listener always; the Mannequin rule is unchanged (risk >= 2 or contractIndex >= 2)
// The bot e2e tests/monsters/v13.e2e.ts checks the same through dbg.monsters.start on a dev server.
//   node --test tests/monsters/roster.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { startContract } from '../../apps/server/src/monsters/runtime.ts';
import { REPO, stubCrew, stubCtx, stubPlayer } from './unit.ts';

const bal = JSON.parse(readFileSync(join(REPO, 'config/balance/monsters.json'), 'utf8')) as { snatcher: { minContractIndex: number; minRisk: number } };

/** facilities with vents (the Snatcher needs grates) */
const SEEDS = ['v13-roster-a', 'v13-roster-b', 'v13-roster-c', 'v13-roster-d', 'v13-roster-e', 'v13-roster-f'];

function kinds(seed: string, risk: number, contractIndex: number): { kinds: string[]; vents: number } {
  const L = generateFacility({ seed, players: 2, risk });
  const s = stubCtx();
  const cab = L.van.cab;
  const crew = stubCrew(L, [stubPlayer('a', cab.x + 1, cab.y + 1), stubPlayer('b', cab.x + 1, cab.y + 2)]);
  const cm = startContract(s.ctx, crew, { risk, contractIndex });
  assert.ok(cm);
  return { kinds: cm.agents.map((a) => a.kind), vents: L.items.filter((i) => i.kind === 'vent').length };
}

test('balance: snatcher.minContractIndex is 2 (the crew\'s 3rd contract)', () => {
  assert.equal(bal.snatcher.minContractIndex, 2);
  assert.equal(bal.snatcher.minRisk, 2);
});

test('risk 1: contract index 0 and 1 have no Snatcher; index 2 has one (sites with vents)', () => {
  let withVents = 0;
  for (const seed of SEEDS) {
    for (const ci of [0, 1]) {
      const r = kinds(seed, 1, ci);
      assert.ok(!r.kinds.includes('snatcher'), `${seed} contract ${ci}: ${r.kinds.join(',')}`);
      assert.ok(r.kinds.includes('hound') && r.kinds.includes('listener'), `${seed} contract ${ci}: hound + listener`);
    }
    const r2 = kinds(seed, 1, 2);
    if (r2.vents > 0) {
      withVents++;
      assert.ok(r2.kinds.includes('snatcher'), `${seed} contract 2 (${r2.vents} vents): ${r2.kinds.join(',')}`);
    } else assert.ok(!r2.kinds.includes('snatcher'), `${seed}: no vents, no Snatcher`);
  }
  assert.ok(withVents >= 3, `enough sites with vents to test (${withVents}/${SEEDS.length})`);
});

test('risk 2 keeps the Snatcher from the first contract (sites with vents)', () => {
  for (const seed of SEEDS) {
    const r = kinds(seed, 2, 0);
    if (r.vents > 0) assert.ok(r.kinds.includes('snatcher'), `${seed} risk 2 contract 0: ${r.kinds.join(',')}`);
  }
});

test('the flag still turns the Snatcher off', () => {
  const L = generateFacility({ seed: SEEDS[0], players: 2, risk: 2 });
  const s = stubCtx({ flags: { snatcher: false } });
  const cm = startContract(s.ctx, stubCrew(L, [stubPlayer('a', L.van.cab.x + 1, L.van.cab.y + 1)]), { risk: 2, contractIndex: 5 });
  assert.ok(cm && !cm.agents.some((a) => a.kind === 'snatcher'));
});
