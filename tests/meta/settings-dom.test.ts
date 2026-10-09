// Owner: track (d) Meta. v1.3: the settings panels' SIGNAL row under real Preact 11 + @preact/signals in Node (the DOM
// shim in domshim.ts, .tsx through tsx-hooks.ts; no browser, no GPU). The row follows the preset list: on with LOW,
// greyed out with a note on MEDIUM / HIGH, back with LITE (and the Lite reload note turns amber), AUTO; a click reaches
// render's setSignalLook. It also pins down the @preact/signals pitfall the lane run hit: its shouldComponentUpdate
// skips a component with hook state whose props did not change, so a row that only takes ctx kept the old preset.
//   node --test tests/meta/settings-dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { change, flush, installDom } from './domshim.ts';
import type { DomElement } from './domshim.ts';

register('./tsx-hooks.ts', import.meta.url);
const doc = installDom();
const { h, render } = await import('preact');
const { useState } = await import('preact/hooks');
await import('@preact/signals'); // the client loads it: every component gets its signals-aware shouldComponentUpdate
const { SettingsTab } = await import('../../apps/client/src/meta/menus.tsx');

/** a render service with the SIGNAL API: the look applies on Lite and Low only (render/index.ts signalActive) */
function fakeRender() {
  const r = {
    name: 'low',
    signal: false,
    presets: ['lite', 'low', 'medium', 'high', 'ultra'] as readonly string[],
    get preset() { return r.name; },
    setPreset(n: string) { r.name = n === 'auto' ? 'low' : n; },
    detectedPreset: 'low',
    presetSource: 'url',
    setExposure() {},
    exposure: () => 1,
    setReduceFlicker() {},
    setSignalLook(on: boolean) { r.signal = on; },
    signalLook: () => r.signal,
    signalActive: () => r.signal && (r.name === 'lite' || r.name === 'low'),
  };
  return r;
}
const fakeCtx = (r: ReturnType<typeof fakeRender>) => ({
  services: { use: (n: string) => (n === 'render' ? r : undefined) },
  params: new URLSearchParams('preset=low'),
  flags: {}, balance: { monsters: {} }, audio: { unlock() {}, ctx: null }, ui: { screens: new Map() },
});

function mount(): { root: DomElement; r: ReturnType<typeof fakeRender> } {
  const r = fakeRender();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  render(h(SettingsTab, { ctx: fakeCtx(r) as never }), root as never);
  return { root, r };
}
const toggle = (root: DomElement) => root.querySelector('[data-testid="signal-toggle"]') as (DomElement & { checked: boolean; disabled: boolean }) | null;
const rowText = (root: DomElement) => toggle(root)?.closest('.m-set')?.textContent ?? '';
const liteNote = (root: DomElement) => root.querySelector('[data-testid="lite-note"] span.m-small');
const pick = (root: DomElement, preset: string) => change(root.querySelector('[data-testid="preset-select"]'), { value: preset });

test('the SIGNAL row follows the preset list and drives render', async () => {
  const { root, r } = mount();
  await flush();
  const t = toggle(root);
  assert.ok(t, 'the SIGNAL row');
  assert.equal(t.disabled, false, 'LOW: enabled');
  assert.equal(t.checked, false, 'off by default');
  assert.ok(liteNote(root)?.classes.includes('m-dim'), 'the Lite reload note, dim');
  assert.match(liteNote(root)?.textContent ?? '', /LITE applies fully after a page reload/);

  await change(t, { checked: true });
  assert.equal(r.signal, true, 'the click reached setSignalLook');
  assert.equal(r.signalActive(), true);
  assert.equal(toggle(root)?.checked, true);

  await pick(root, 'medium');
  assert.equal(r.name, 'medium');
  assert.equal(toggle(root)?.disabled, true, 'MEDIUM: greyed out');
  assert.equal(toggle(root)?.checked, true, 'still on (the stored toggle)');
  assert.match(rowText(root), /LITE and LOW presets only \(now MEDIUM\)/);
  assert.ok(toggle(root)?.closest('.m-set')?.classes.includes('off'), 'the row is marked off');

  await pick(root, 'lite');
  assert.equal(toggle(root)?.disabled, false, 'LITE: enabled');
  assert.ok(liteNote(root)?.classes.includes('m-amber'), 'picking LITE turns the reload note amber');

  await pick(root, 'high');
  assert.equal(toggle(root)?.disabled, true, 'HIGH: greyed out');
  assert.match(rowText(root), /\(now HIGH\)/);

  await pick(root, 'auto');
  assert.equal(r.name, 'low', 'AUTO: the detected preset');
  assert.equal(toggle(root)?.disabled, false, 'AUTO on LOW: enabled');

  await change(toggle(root), { checked: false });
  assert.equal(r.signal, false, 'a second click turns it off');
  assert.equal(toggle(root)?.checked, false);
});

test('the pitfall: a stateful child whose only prop never changes does not re-render with its parent', async () => {
  const r = fakeRender();
  const ctx = fakeCtx(r);
  function CtxOnlyRow({ ctx: c }: { ctx: ReturnType<typeof fakeCtx> }) {
    const [on] = useState(false);
    return h('span', { 'data-testid': 'row' }, `${on}|${(c.services.use('render') as typeof r).preset}`);
  }
  let bump = () => {};
  function Parent() {
    const [n, setN] = useState(0);
    bump = () => setN(n + 1);
    return h('div', null, h(CtxOnlyRow, { ctx }), h('i', null, String(n)));
  }
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  render(h(Parent, null), root as never);
  await flush();
  r.name = 'medium';
  bump();
  await flush();
  assert.equal(root.querySelector('i')?.textContent, '1', 'the parent re-rendered');
  assert.equal(root.querySelector('[data-testid="row"]')?.textContent, 'false|low', 'the ctx-only child kept the old preset');
});
