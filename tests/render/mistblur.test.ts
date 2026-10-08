// v1.2 mist blur (env-render): the depth-aware blur's two fullscreen materials are built ONCE. Gate P's pipeline log
// at the first mirror view showed 'mist-blur-h' / 'mist-blur-v' getting a new fragment program every frame: setup()
// re-assigned both fragment graphs (+ needsUpdate) and the vertical pass read a PassTextureNode of the blur node
// itself, so every rebuild of that material re-entered setup and dirtied both again. No GPU here: setup() is driven
// with a stub builder (it only needs getNodeProperties), the way three's builders reach it from the composite and
// from TRAA's resolve.
//   node --test tests/render/mistblur.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import { DepthAwareBlurNode } from '../../apps/client/src/render/mist.ts';

const stubBuilder = () => {
  const props = new Map<unknown, Record<string, unknown>>();
  return { getNodeProperties: (n: unknown) => { let p = props.get(n); if (!p) { p = {}; props.set(n, p); } return p; } };
};

type Mats = { _hm: THREE.NodeMaterial | null; _vm: THREE.NodeMaterial | null };

test('the blur materials are built once: repeated setup (any builder) never rebuilds or dirties them', () => {
  const march = new THREE.RenderTarget(64, 36, { type: THREE.HalfFloatType });
  const depth = new THREE.DepthTexture(128, 72);
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 120);
  const blur = new DepthAwareBlurNode(texture(march.texture), texture(depth), cam, 3, 1.8, 9);
  const b1 = stubBuilder();
  const out1 = blur.setup(b1 as never);
  const m = blur as unknown as Mats;
  assert.ok(m._hm && m._vm, 'built on the first setup');
  const hm = m._hm!, vm = m._vm!;
  const hv = hm.version, vv = vm.version, hf = hm.fragmentNode, vf = vm.fragmentNode;
  // the composite, TRAA's resolve and (before the fix) the vertical pass itself all reach setup
  for (let i = 0; i < 5; i++) blur.setup((i % 2 ? b1 : stubBuilder()) as never);
  assert.equal(m._hm, hm, 'same horizontal material');
  assert.equal(m._vm, vm, 'same vertical material');
  assert.equal(hm.fragmentNode, hf, 'horizontal graph untouched');
  assert.equal(vm.fragmentNode, vf, 'vertical graph untouched');
  assert.equal(hm.version, hv, 'horizontal material never marked for a rebuild');
  assert.equal(vm.version, vv, 'vertical material never marked for a rebuild');
  assert.equal(blur.setup(stubBuilder() as never), out1, 'one output node');
  assert.equal(hm.name, 'mist-blur-h');
  assert.equal(vm.name, 'mist-blur-v');
});
