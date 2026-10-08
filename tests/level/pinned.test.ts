// Env-layout (v1.2): no-theme layouts are pinned at gate L1 (integrator-acknowledged). Themed generation, modifiers and
// every derived view (containers, lore drawers, movables, clutter) must leave these hashes byte-identical.
// Run: node --test tests/level/pinned.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateFacility, generateHub } from '../../packages/shared/src/procgen/index.ts';
import { loadTuning } from '../../tools/gen-cli.ts';

const pinned = JSON.parse(readFileSync(resolve(import.meta.dirname, 'pinned-l1.json'), 'utf8')) as { hashes: Record<string, string> };

test('no-theme layouts keep their gate-L1 hashes (and an explicit facility theme is the same layout)', () => {
  const t = loadTuning();
  const bad: string[] = [];
  for (const [k, h] of Object.entries(pinned.hashes)) {
    if (k === 'hub') { if (generateHub().hash !== h) bad.push(`hub ${generateHub().hash} != ${h}`); continue; }
    const [seed, p, r] = k.split('|');
    const got = generateFacility({ seed, players: Number(p), risk: Number(r) }, t).hash;
    if (got !== h) bad.push(`${k}: ${got} != ${h}`);
    if (seed === 's1' || seed === 'pin-a') {
      const f = generateFacility({ seed, players: Number(p), risk: Number(r), theme: 'facility', modifiers: [] }, t).hash;
      if (f !== h) bad.push(`${k} theme facility: ${f} != ${h}`);
    }
  }
  assert.deepEqual(bad.slice(0, 10), []);
});
