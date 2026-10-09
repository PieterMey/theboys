// Owner: track (d) Meta. v1.3 P6: the settings menus' AUTO (detected: X) entry (meta/state.ts presetAuto +
// chooseAutoPreset) against a render service with and without E2's AUTO members. No browser.
//   node --test tests/meta/preset-auto.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
} as Storage;

const { chooseAutoPreset, presetAuto, saveSettings, settings } = await import('../../apps/client/src/meta/state.ts');

function ctxWith(render: Record<string, unknown> | undefined, params = ''): never {
  return { services: { use: (n: string) => (n === 'render' ? render : undefined) }, params: new URLSearchParams(params) } as never;
}

beforeEach(() => {
  mem.clear();
  saveSettings({ preset: null });
});

test('render with the AUTO API: detected preset, source, clear through the service', () => {
  let cleared = 0;
  let source = 'stored';
  const r = { presets: ['low', 'medium', 'high', 'ultra'], preset: 'medium', detectedPreset: () => 'high', presetSource: () => source, clearPreset: () => { cleared++; source = 'auto'; }, setPreset: () => {} };
  saveSettings({ preset: 'medium' });
  let a = presetAuto(ctxWith(r));
  assert.equal(a.detected, 'high');
  assert.equal(a.active, false, 'a stored preset is not AUTO');
  assert.equal(a.canClear, true);
  chooseAutoPreset(ctxWith(r));
  assert.equal(cleared, 1, 'cleared through the render service');
  assert.equal(settings().preset, null, "meta's stored preset is gone too (applySettings would re-apply it)");
  a = presetAuto(ctxWith(r));
  assert.equal(a.active, true);
});

test("render v1.3 (E2): getters detectedPreset / presetSource and setPreset('auto')", () => {
  let source: 'url' | 'stored' | 'auto' = 'stored';
  let active = 'medium';
  const calls: string[] = [];
  const r = {
    presets: ['lite', 'low', 'medium', 'high', 'ultra'],
    get preset() { return active; },
    get detectedPreset() { return 'high'; },
    get presetSource() { return source; },
    setPreset(n: string) {
      calls.push(n);
      if (n === 'auto') { mem.delete('deadair.render.preset'); source = 'auto'; active = 'high'; return; }
      mem.set('deadair.render.preset', n); source = 'stored'; active = n;
    },
  };
  mem.set('deadair.render.preset', 'medium');
  saveSettings({ preset: 'medium' });
  let a = presetAuto(ctxWith(r));
  assert.equal(a.detected, 'high');
  assert.equal(a.active, false);
  assert.equal(a.canClear, true);
  chooseAutoPreset(ctxWith(r));
  assert.deepEqual(calls, ['auto'], "AUTO goes through setPreset('auto')");
  assert.equal(settings().preset, null);
  assert.equal(mem.has('deadair.render.preset'), false);
  a = presetAuto(ctxWith(r));
  assert.equal(a.active, true);
  assert.equal(r.preset, 'high', 'the detected preset runs');
});

test('render without the AUTO API (stub): stored keys decide, AUTO drops them', () => {
  const calls: string[] = [];
  const r = { presets: ['low', 'medium', 'high', 'ultra'], preset: 'low', setPreset: (n: string) => { calls.push(n); mem.set('deadair.render.preset', n); } };
  mem.set('deadair.render.preset', 'low');
  saveSettings({ preset: 'low' });
  assert.equal(presetAuto(ctxWith(r)).active, false);
  assert.equal(presetAuto(ctxWith(r)).detected, null);
  chooseAutoPreset(ctxWith(r));
  assert.equal(mem.has('deadair.render.preset'), false, "render's stored key dropped");
  assert.equal(settings().preset, null);
  assert.deepEqual(calls, [], 'no detected preset known: nothing applied now (next load detects)');
  assert.equal(presetAuto(ctxWith(r)).active, true);
});

test('stub with a detected value: AUTO applies it now and still leaves nothing stored', () => {
  const r = { presets: ['low', 'medium', 'high', 'ultra'], preset: 'ultra', autoPreset: 'medium', setPreset: (n: string) => { mem.set('deadair.render.preset', n); } };
  saveSettings({ preset: 'ultra' });
  chooseAutoPreset(ctxWith(r));
  assert.equal(mem.has('deadair.render.preset'), false);
  assert.equal(presetAuto(ctxWith(r)).detected, 'medium');
});

test('a ?preset= page is never shown as AUTO without render saying so', () => {
  assert.equal(presetAuto(ctxWith({ presets: ['low'] }, 'preset=low')).active, false);
  assert.equal(presetAuto(ctxWith({ presets: ['low'] })).active, true);
});
