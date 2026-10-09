// Owner: env-paranormal (v1.3 P1d). Mirror writing only ever shows a roster name names.ts passes, in its mirror form too
// (safeMirrorName); otherwise a fixed phrase. Blocked words come from ROT13 codes decoded at run time (the names.ts test
// convention: no slur or swear word is typed in this file).
//   node --test tests/paranormal/mirror-names.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { buildEdgeGrid, initialDoorOpen } from '../../packages/shared/src/nav/index.ts';
import { rot13 } from '../../packages/shared/src/names.ts';
import { PARANORMAL_PHRASES, mirrorName, safeMirrorName } from '../../packages/shared/src/messages/paranormal.ts';
import { resolveBalance } from '../../apps/server/src/paranormal/balance.ts';
import { writingText } from '../../apps/server/src/paranormal/kinds.ts';
import { newCrewPara } from '../../apps/server/src/paranormal/plan.ts';
import { indoor } from '../../apps/server/src/paranormal/gates.ts';
import type { BuildCtx, ParaPlayer, ParaWorld } from '../../apps/server/src/paranormal/types.ts';

/** a mild word on the names.ts list (ROT13), never typed here */
const BAD = rot13('onfgneq');

test('safeMirrorName: ordinary names (incl. the allow-listed lookalikes) keep their mirror form', () => {
  for (const n of ['Ann', 'Pieter', 'van der Berg', "O'Neill", 'Contractor-0042', 'Dickson', 'Scunthorpe', 'xXSniperXx']) {
    assert.equal(safeMirrorName(n, 'p1'), mirrorName(n), n);
    assert.ok(safeMirrorName(n, 'p1').length > 0, `${n} is written`);
  }
});

test('safeMirrorName: a blocked name in any spelling the fold undoes, and a reserved one, are never written', () => {
  const spellings = [
    BAD, BAD.toUpperCase(), `xX${BAD}Xx`, [...BAD].join('.'), [...BAD].join('_'), [...BAD].join(' '),
    `${BAD.slice(0, 3)}\u200b${BAD.slice(3)}`, BAD.replace(/a/g, '4'), `${BAD}2000`,
  ];
  for (const n of spellings) assert.equal(safeMirrorName(n, 'p1'), '', `spelling ${spellings.indexOf(n)} is blocked`);
  // mirrorName alone would rebuild the dotted / underscored / zero-width spellings into the plain word
  assert.equal(mirrorName([...BAD].join('.')), BAD.toUpperCase());
  assert.equal(safeMirrorName('Listener', 'p1'), '', 'reserved names are not written either');
  assert.equal(safeMirrorName('', 'p1'), '');
});

test("writingText: a lone player with a blocked name gets a phrase, a lone player with a clean name gets theirs", () => {
  const L = generateFacility({ seed: 'mirror-names-1', players: 2, risk: 1 });
  const grid = buildEdgeGrid(L);
  const w: ParaWorld = {
    now: () => 1_000_000, layout: L, grid, doorOpen: initialDoorOpen(L), players: () => [], monsters: () => [], director: () => null,
    clockMin: () => 60, contractRealSec: () => 900, blackout: () => false, coreLifted: () => false, lightsOn: () => true, setLights: () => {},
    mirrors: () => [], movables: () => [], loreSpots: () => [], themeHaunt: () => 0, snatcherLurking: () => false,
  };
  const b = resolveBalance({});
  const room = L.spaces.find((s) => indoor(L, s.id) && s.kind !== 'corridor')!;
  const P = (id: string, name: string): ParaPlayer => ({
    id, name, x: room.rect.x + 1.5, z: room.rect.y + 1.5, yaw: 0, light: true, alive: true, inVan: false, hidden: null, core: false, grabbed: false,
  });
  const run = (name: string): string => {
    const st = newCrewPara(w, 'MNAM', 0, b);
    const c: BuildCtx = { w, st, b, now: w.now(), tierCap: 1, force: false };
    const p = P('p1', name);
    return writingText(c, { list: [p], all: [p], mons: [] }).text;
  };
  assert.equal(run('Ann'), 'ANN');
  const t = run([...BAD].join('.'));
  assert.ok((PARANORMAL_PHRASES as readonly string[]).includes(t), 'a fixed phrase instead');
  assert.ok(!t.includes(BAD.toUpperCase()));
});
