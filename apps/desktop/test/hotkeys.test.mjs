// Desktop hotkeys (src/hotkeys.cjs): Left Ctrl -> { action: 'crouch', down }, auto-repeat ignored, AltGr's synthetic
// Left Ctrl never crouches (before, during and around Right Alt), focus loss releases.   node --test apps/desktop/test/
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { createHotkeyMapper, ALTGR_MS } = require('../src/hotkeys.cjs');

const down = (code, extra = {}) => ({ type: 'keyDown', code, key: code.replace(/(Left|Right)$/, ''), isAutoRepeat: false, alt: false, ...extra });
const up = (code, extra = {}) => ({ type: 'keyUp', code, key: code.replace(/(Left|Right)$/, ''), isAutoRepeat: false, alt: false, ...extra });
const C_DOWN = { action: 'crouch', down: true };
const C_UP = { action: 'crouch', down: false };

describe('Left Ctrl crouch', () => {
  test('press and release', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map(down('ControlLeft'), 1000), [C_DOWN]);
    assert.deepEqual(m.map(up('ControlLeft'), 1500), [C_UP]);
  });
  test('auto-repeat keyDowns are ignored; one release', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map(down('ControlLeft'), 1000), [C_DOWN]);
    for (let i = 1; i <= 5; i++) assert.deepEqual(m.map(down('ControlLeft', { isAutoRepeat: true }), 1000 + i * 33), []);
    assert.deepEqual(m.map(up('ControlLeft'), 1300), [C_UP]);
    assert.deepEqual(m.map(up('ControlLeft'), 1310), [], 'a second keyUp sends nothing');
  });
  test('Right Ctrl, other keys and char events never crouch', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map(down('ControlRight'), 1000), []);
    assert.deepEqual(m.map(down('KeyC'), 1000), []);
    assert.deepEqual(m.map(down('KeyW'), 1000), []);
    assert.deepEqual(m.map({ type: 'char', code: 'ControlLeft' }, 1000), []);
    assert.deepEqual(m.map(up('ControlRight'), 1100), []);
  });
  test('key + location fallback when code is missing', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map({ type: 'keyDown', key: 'Control', location: 1 }, 1000), [C_DOWN]);
    assert.deepEqual(m.map({ type: 'keyUp', key: 'Control', location: 1 }, 1100), [C_UP]);
    assert.deepEqual(m.map({ type: 'keyDown', key: 'Control', location: 2 }, 1200), [], 'right ctrl by location');
  });
  test('Alt+Tab while crouched still releases (keyUp arrives with alt set)', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map(down('ControlLeft'), 1000), [C_DOWN]);
    assert.deepEqual(m.map(down('AltLeft', { alt: true }), 1500), []);
    assert.deepEqual(m.map(up('ControlLeft', { alt: true }), 1600), [C_UP]);
  });
});

describe('AltGr (synthetic Left Ctrl + Right Alt)', () => {
  test('Left Ctrl first, Right Alt right after: the crouch is taken back at once', () => {
    const m = createHotkeyMapper();
    const evs = [...m.map(down('ControlLeft'), 1000), ...m.map(down('AltRight', { alt: true }), 1000)];
    assert.deepEqual(evs, [C_DOWN, C_UP]);
    // typing the character, then letting go: nothing more
    assert.deepEqual(m.map(up('AltRight'), 1150), []);
    assert.deepEqual(m.map(up('ControlLeft'), 1150), []);
    assert.deepEqual(m.state(), { altRight: false, ctrlDown: false });
  });
  test('within the AltGr window only', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map(down('ControlLeft'), 1000), [C_DOWN]);
    assert.deepEqual(m.map(down('AltRight', { alt: true }), 1000 + ALTGR_MS + 1), [], 'a deliberate Right Alt later keeps the crouch');
    assert.deepEqual(m.map(up('AltRight'), 1300), []);
    assert.deepEqual(m.map(up('ControlLeft'), 1400), [C_UP]);
  });
  test('Left Ctrl while Right Alt is held (AltGr held, repeats) is ignored', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map(down('AltRight', { alt: true }), 1000), []);
    assert.deepEqual(m.map(down('ControlLeft', { alt: true }), 1001), []);
    assert.deepEqual(m.map(down('ControlLeft'), 1002), [], 'alt flag missing: AltRight is tracked');
    assert.deepEqual(m.map(up('ControlLeft'), 1100), []);
    assert.deepEqual(m.map(up('AltRight'), 1101), []);
    // after AltGr is up, Left Ctrl crouches again
    assert.deepEqual(m.map(down('ControlLeft'), 1300), [C_DOWN]);
  });
  test('Left Ctrl with input.alt set (Ctrl+Alt chords) is ignored', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map(down('ControlLeft', { alt: true }), 1000), []);
    assert.deepEqual(m.map(up('ControlLeft', { alt: true }), 1100), []);
  });
  test('AltGraph key name is Right Alt too', () => {
    const m = createHotkeyMapper();
    assert.deepEqual(m.map(down('ControlLeft'), 1000), [C_DOWN]);
    assert.deepEqual(m.map({ type: 'keyDown', key: 'AltGraph', code: '', isAutoRepeat: false }, 1005), [C_UP]);
  });
});

describe('focus loss', () => {
  test('reset releases a held crouch once and forgets AltGr', () => {
    const m = createHotkeyMapper();
    m.map(down('ControlLeft'), 1000);
    assert.deepEqual(m.reset(), [C_UP]);
    assert.deepEqual(m.reset(), []);
    assert.deepEqual(m.map(up('ControlLeft'), 1200), [], 'the late keyUp after a reset sends nothing');
    m.map(down('AltRight', { alt: true }), 2000);
    m.reset();
    assert.deepEqual(m.map(down('ControlLeft'), 3000), [C_DOWN], 'AltRight forgotten (its keyUp never came)');
  });
});

describe('never names the forbidden browser modifier flags', () => {
  test('src/*.cjs never reads the DOM ctrl / meta modifier flags (tools/check-forbidden.mjs scans .cjs too)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '../src');
    // built from pieces so this test file itself stays clean for the forbidden-API grep
    const flags = new RegExp(`\\b(${['ctrl', 'meta'].map((m) => `${m}Key`).join('|')})\\b`);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.cjs')) continue;
      assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), flags, f);
    }
  });
});
