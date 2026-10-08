// env-world: EXIT signs over the doors on the way out (apps/client/src/level/signs.ts):
//   node --test tests/world/signs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { generateHub } from '../../packages/shared/src/procgen/hub.ts';
import { spaceLinks } from '../../packages/shared/src/nav/index.ts';
import { installDomShim } from './harness.ts';

installDomShim();
const { exitSigns } = await import('../../apps/client/src/level/signs.ts');

test('EXIT signs: one inside the exit door, more toward it; on the lintel face, facing their own space', () => {
  assert.deepEqual(exitSigns(generateHub(), spaceLinks(generateHub())), [], 'no signs in the hub');
  let shifted = 0;
  for (const [seed, theme] of [['s2', 'facility'], ['dw', 'waterworks'], ['dc', 'cold_storage'], ['dh', 'hospital'], ['dr', 'records']] as const) {
    const L = generateFacility({ seed, players: 6, risk: 2, theme });
    const signs = exitSigns(L, spaceLinks(L));
    assert.ok(signs.length >= 2 && signs.length <= 10, `${theme}: ${signs.length} signs`);
    const exit = L.doors.find((d) => d.kind === 'exit')!;
    assert.equal(signs[0].door, exit.id, 'the first sign hangs over the exit door');
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (const sg of signs) {
      const d = L.doors[sg.door];
      sg.m.decompose(p, q, s);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      // over the door's span, 0.111 m off the door line (HALF_T + half the housing), below the ceiling
      if (d.dir === 'v') {
        assert.ok(Math.abs(Math.abs(p.x - d.x) - 0.111) < 1e-3 && p.z > d.y && p.z < d.y + d.len, `${theme} sign ${sg.door} on the lintel`);
      } else {
        assert.ok(Math.abs(Math.abs(p.z - d.y) - 0.111) < 1e-3 && p.x > d.x && p.x < d.x + d.len, `${theme} sign ${sg.door} on the lintel`);
      }
      assert.ok(p.y - 0.08 > 2.1 && p.y + 0.11 < L.wallH, 'between the door head and the ceiling');
      // 0.4 m in front of the sign is the sign's own space
      const fx = Math.floor(p.x + fwd.x * 0.4), fz = Math.floor(p.z + fwd.z * 0.4);
      assert.equal(L.owner[fz * L.W + fx], sg.space, 'faces into its own space');
      assert.ok(sg.parts.some((pt) => pt.mat === 'exitGlow') && sg.parts.some((pt) => pt.mat === 'black'));
      // env-layout's battery emergency lights hang over door middles at y 2.4: the sign keeps clear of them
      for (const e of L.items.filter((i) => i.kind === 'light' && i.data?.kind === 'emergency' && i.space === sg.space)) {
        assert.ok(Math.hypot(p.x - e.x, p.z - e.z) > 0.38 || Math.abs(p.y - (e.y ?? 2.4)) > 0.3, `${theme} sign ${sg.door} clear of emergency light ${e.id}`);
      }
    }
    shifted += signs.filter((sg) => L.items.some((i) => i.kind === 'light' && i.data?.kind === 'emergency' && i.data?.door === sg.door)).length;
  }
  assert.ok(shifted > 0, "some signs moved beside an emergency light");
});
