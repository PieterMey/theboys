// Owner: track (c) Monsters (v1.3 F3, the monster half). Unit (no server): the Hound treats G3's noise lure like a
// thrown bottle: any noise kind containing 'lure' (e.g. 'lure', 'noiseLure') sends it to the impact point to sniff
// (state 'bottle', a huff cue), overriding an alert or an investigation; other noises still alert it.
//   node --test tests/monsters/hound-lure.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { addNoise, makeRt, startContract, tickRuntime } from '../../apps/server/src/monsters/runtime.ts';
import { isBait } from '../../apps/server/src/monsters/hound.ts';
import type { HoundAgent } from '../../apps/server/src/monsters/types.ts';
import { cellsOf, stubCrew, stubCtx, stubPlayer } from './unit.ts';

const L: LevelLayout = generateFacility({ seed: 'v13-lure', players: 2, risk: 1 });

/** a room with two cells >= 3 m apart (hound spot, noise spot) */
function spots(): [[number, number], [number, number]] {
  for (const s of L.spaces) {
    if (s.kind !== 'room' || s.id === L.entrance) continue;
    const cells = cellsOf(L, s.id);
    for (const a of cells) for (const b of cells) if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) <= 5) return [a, b];
  }
  throw new Error('no room');
}

function world() {
  const s = stubCtx({ flags: { director: false } });
  const cab = L.van.cab;
  const crew = stubCrew(L, [stubPlayer('a', cab.x + 1, cab.y + 1)]);
  const cm = startContract(s.ctx, crew, { risk: 1, contractIndex: 0 })!;
  const rt = makeRt(s.ctx, crew, cm, () => {});
  const h = cm.agents.find((a) => a.kind === 'hound') as HoundAgent;
  for (const a of cm.agents) if (a !== h) rt.retreat(a, 1e6);
  const [hp, np] = spots();
  h.x = h.lastX = hp[0];
  h.z = h.lastZ = hp[1];
  h.path = null;
  h.state = 'idle';
  h.timer = 30; // standing still
  return { s, rt, h, np };
}

test('isBait: bottles and every lure kind; nothing else', () => {
  for (const k of ['bottle', 'lure', 'noiseLure', 'noise_lure', 'lureRattle']) assert.equal(isBait(k), true, k);
  for (const k of ['door', 'voice', 'flare', 'airhorn', 'walkStep', 'crowbar']) assert.equal(isBait(k), false, k);
});

for (const kind of ['lure', 'noiseLure']) {
  test(`a '${kind}' noise sends the Hound to the impact point like a bottle`, () => {
    const { s, rt, h, np } = world();
    addNoise(rt.cm, { x: np[0], z: np[1], radiusM: 12, kind, source: 'a' });
    tickRuntime(rt, 1 / 30);
    assert.equal(h.state, 'bottle', `state ${h.state}`);
    assert.ok(Math.abs(h.tx - np[0]) < 1e-6 && Math.abs(h.tz - np[1]) < 1e-6, 'target = the lure');
    assert.ok(s.events.some((e) => e.e === 'monsters.cue' && (e.d as { cue: string }).cue === 'huff'), 'huff cue');
    for (let i = 0; i < 120 && h.state === 'bottle'; i++) tickRuntime(rt, 1 / 30);
    assert.equal(h.state, 'sniff', 'it arrives and sniffs at the lure');
  });
}

test('a lure overrides an alert (like a bottle); a door noise only alerts', () => {
  const a = world();
  addNoise(a.rt.cm, { x: a.np[0], z: a.np[1], radiusM: 10, kind: 'door', source: '' });
  tickRuntime(a.rt, 1 / 30);
  assert.equal(a.h.state, 'alert', 'a door noise: alert');
  addNoise(a.rt.cm, { x: a.np[0], z: a.np[1], radiusM: 12, kind: 'lure', source: 'a' });
  tickRuntime(a.rt, 1 / 30);
  assert.equal(a.h.state, 'bottle', 'then the lure takes over');
});
