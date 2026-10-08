// players-stealth (v1.2) unit tests for apps/client/src/players/input.ts with a tiny fake DOM (no browser):
// the crouch latch (toggle + hold), resetCrouch, the desktop app's Left-Ctrl hotkey acting exactly like C (and never
// while typing / disabled), E released on alt-tab, and no Ctrl identifiers anywhere in the web client.
//   node --test tests/players/input-latch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Listener = (e: unknown) => void;
const winListeners = new Map<string, Listener[]>();
const g = globalThis as Record<string, unknown>;
g.addEventListener = (type: string, fn: Listener) => {
  const l = winListeners.get(type) ?? [];
  l.push(fn);
  winListeners.set(type, l);
};
const doc = {
  activeElement: null as unknown,
  pointerLockElement: null as unknown,
  addEventListener: () => {},
  getElementById: () => null,
  exitPointerLock: () => {},
};
g.document = doc;
let hotkey: ((ev: { action: string; down: boolean }) => void) | null = null;
g.deadAirDesktop = { onHotkey: (cb: (ev: { action: string; down: boolean }) => void) => { hotkey = cb; return () => {}; } };

const { createInput, ctrlCrouchOn } = await import('../../apps/client/src/players/input.ts');
const { DEFAULT_SETTINGS } = await import('../../apps/client/src/players/input.ts');

const fire = (type: string, e: Record<string, unknown> = {}) => {
  for (const fn of winListeners.get(type) ?? []) fn({ repeat: false, preventDefault() {}, ...e });
};
const key = (code: string, down: boolean, repeat = false) => fire(down ? 'keydown' : 'keyup', { code, repeat });

function make(over: Record<string, unknown> = {}) {
  winListeners.clear();
  hotkey = null;
  doc.activeElement = null;
  const events: [string, unknown][] = [];
  const ctx = { bus: { emit: (e: string, d: unknown) => events.push([e, d]) }, services: { use: () => undefined }, flags: {} };
  const settings = { ...DEFAULT_SETTINGS, ...over };
  const input = createInput(ctx as never, settings);
  input.setActive(true);
  return { input, events, settings };
}

test('hold mode: C crouches while held', () => {
  const { input } = make();
  key('KeyC', true);
  assert.equal(input.state().crouch, true);
  key('KeyC', true, true); // auto-repeat changes nothing
  key('KeyC', false);
  assert.equal(input.state().crouch, false);
});

test('toggle mode: C latches; resetCrouch (phase change, death, revive) drops the latch', () => {
  const { input } = make({ crouchToggle: true });
  key('KeyC', true);
  key('KeyC', false);
  assert.equal(input.state().crouch, true);
  assert.equal(input.crouchLatched(), true);
  key('KeyC', true);
  key('KeyC', false);
  assert.equal(input.state().crouch, false);
  key('KeyC', true);
  key('KeyC', false);
  assert.equal(input.state().crouch, true);
  input.resetCrouch();
  assert.equal(input.state().crouch, false);
  assert.equal(input.crouchLatched(), false);
});

test('desktop Left-Ctrl hotkey acts exactly like C (hold mode)', () => {
  const { input } = make();
  assert.ok(hotkey, 'subscribed to deadAirDesktop.onHotkey');
  hotkey!({ action: 'crouch', down: true });
  assert.equal(input.state().crouch, true);
  hotkey!({ action: 'crouch', down: false });
  assert.equal(input.state().crouch, false);
  // C and Ctrl together: releasing one keeps the other
  key('KeyC', true);
  hotkey!({ action: 'crouch', down: true });
  key('KeyC', false);
  assert.equal(input.state().crouch, true);
  hotkey!({ action: 'crouch', down: false });
  assert.equal(input.state().crouch, false);
  hotkey!({ action: 'other', down: true });
  assert.equal(input.state().crouch, false);
});

test('desktop hotkey in toggle mode flips the latch on press only', () => {
  const { input } = make({ crouchToggle: true });
  hotkey!({ action: 'crouch', down: true });
  hotkey!({ action: 'crouch', down: false });
  assert.equal(input.state().crouch, true);
  hotkey!({ action: 'crouch', down: true });
  hotkey!({ action: 'crouch', down: false });
  assert.equal(input.state().crouch, false);
});

test('desktop hotkey is ignored while typing, while the game input is off and with ctrlCrouch false', () => {
  const t = make();
  doc.activeElement = { tagName: 'INPUT' };
  hotkey!({ action: 'crouch', down: true });
  assert.equal(t.input.state().crouch, false, 'typing');
  doc.activeElement = null;
  t.input.setActive(false);
  hotkey!({ action: 'crouch', down: true });
  t.input.setActive(true);
  assert.equal(t.input.state().crouch, false, 'inactive');
  const off = make({ ctrlCrouch: false });
  hotkey!({ action: 'crouch', down: true });
  assert.equal(off.input.state().crouch, false, 'ctrlCrouch false');
  assert.equal(ctrlCrouchOn(off.settings), false);
  assert.equal(ctrlCrouchOn(make().settings), true, 'on by default when the bridge exists');
});

test('a release always lands, also while typing (no stuck crouch)', () => {
  const { input } = make();
  hotkey!({ action: 'crouch', down: true });
  doc.activeElement = { tagName: 'TEXTAREA' };
  hotkey!({ action: 'crouch', down: false });
  doc.activeElement = null;
  assert.equal(input.state().crouch, false);
});

test('alt-tab (blur) releases a held E once; the later keyup sends nothing more', () => {
  const { events } = make();
  key('KeyE', true);
  assert.deepEqual(events.filter(([e]) => e === 'action:interact'), [['action:interact', { down: true }]]);
  fire('blur');
  key('KeyE', false);
  assert.deepEqual(events.filter(([e]) => e === 'action:interact').map(([, d]) => d), [{ down: true }, { down: false }]);
  // a normal press still works afterwards
  key('KeyE', true);
  key('KeyE', false);
  assert.equal(events.filter(([e]) => e === 'action:interact').length, 4);
});

test('blur also drops a held Ctrl crouch', () => {
  const { input } = make();
  hotkey!({ action: 'crouch', down: true });
  fire('blur');
  assert.equal(input.state().crouch, false);
});

test('the web client never names Ctrl: no ctrlKey / metaKey / ControlLeft / ControlRight in apps/client', () => {
  const ROOT = join(import.meta.dirname, '../..');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (n !== 'dist' && n !== 'node_modules') walk(p, out); } else if (/\.(ts|tsx|js|mjs|cjs|html)$/.test(n)) out.push(p);
    }
    return out;
  };
  const hits: string[] = [];
  for (const f of walk(join(ROOT, 'apps/client/src'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\b(ctrlKey|metaKey)\b|Control(Left|Right)/.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
