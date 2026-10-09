// v1.3 env-render: preset choices (settings menus -> services.render.setPreset).
// 3d: the same choice again (the settings re-apply it ~600 ms after every welcome) rebuilds nothing.
//   node --test tests/render/presets.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_NAMES, presetChoice } from '../../apps/client/src/render/presets.ts';

const N = [...PRESET_NAMES];

test('3d: the welcome re-apply of the stored preset changes nothing (the ladder keeps its step-down)', () => {
  // stored medium, active medium: nothing
  assert.deepEqual(presetChoice('medium', 'medium', 'medium', N), { store: 'medium', apply: null });
  // stored medium, auto quality stepped down to low: the re-apply keeps low (no rebuild back to medium)
  assert.deepEqual(presetChoice('medium', 'medium', 'low', N), { store: 'medium', apply: null });
  // a ?preset=low page with an older stored 'high': the re-apply keeps the URL preset
  assert.deepEqual(presetChoice('high', 'high', 'low', N), { store: 'high', apply: null });
});

test('3d: a real new choice applies once; picking the active preset only stores it', () => {
  assert.deepEqual(presetChoice('low', 'medium', 'medium', N), { store: 'low', apply: 'low' });
  assert.deepEqual(presetChoice('ultra', null, 'high', N), { store: 'ultra', apply: 'ultra' });
  // nothing stored yet, the detected preset is already active: stored, no rebuild
  assert.deepEqual(presetChoice('high', null, 'high', N), { store: 'high', apply: null });
});

test('an unknown name changes nothing', () => {
  assert.deepEqual(presetChoice('potato', 'medium', 'medium', N), { store: 'medium', apply: null });
  assert.deepEqual(presetChoice('', null, 'low', N), { store: null, apply: null });
});

test("P6: 'auto' clears the stored choice and applies the detected preset once; AUTO again does nothing", () => {
  // stored medium (the host), detected ultra: AUTO switches to ultra and stores nothing
  assert.deepEqual(presetChoice('auto', 'medium', 'medium', N, 'ultra'), { store: null, apply: 'ultra' });
  // already AUTO (nothing stored): the welcome re-apply of 'auto' keeps whatever the ladder chose
  assert.deepEqual(presetChoice('auto', null, 'high', N, 'ultra'), { store: null, apply: null });
  // stored = detected: nothing to rebuild, the stored value goes
  assert.deepEqual(presetChoice('auto', 'low', 'low', N, 'low'), { store: null, apply: null });
  // a stale stored value from an old build: cleared, nothing applied
  assert.deepEqual(presetChoice('auto', 'potato', 'medium', N, 'medium'), { store: null, apply: null });
  // after AUTO, picking a preset stores it again
  assert.deepEqual(presetChoice('medium', null, 'ultra', N, 'ultra'), { store: 'medium', apply: 'medium' });
});

test('4e: Lite is opt-in: listed first for the settings, outside the ladder, never detected', async () => {
  const { LITE_PRESET, MENU_PRESETS, presetForGpu } = await import('../../apps/client/src/render/presets.ts');
  assert.equal(MENU_PRESETS[0], LITE_PRESET);
  assert.ok(!(PRESET_NAMES as readonly string[]).includes(LITE_PRESET), 'not an auto-quality step');
  for (const gpu of ['SwiftShader', 'Intel(R) UHD Graphics 620', 'NVIDIA GeForce RTX 5090', 'AMD Radeon RX 6600', '']) for (const be of ['webgpu', 'webgl2'] as const) assert.notEqual(presetForGpu(gpu, be), LITE_PRESET);
  // a stored 'lite' choice is honoured like any preset
  assert.deepEqual(presetChoice('lite', 'low', 'low', [...MENU_PRESETS]), { store: 'lite', apply: 'lite' });
  assert.deepEqual(presetChoice('lite', 'lite', 'lite', [...MENU_PRESETS]), { store: 'lite', apply: null });
});
