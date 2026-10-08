// @ts-check
'use strict';
// Desktop-only hotkeys (v1.2): Left Ctrl crouches in the desktop app. The web client never reads Ctrl (Ctrl+W closes a
// browser tab), so the shell maps the key itself, from the game window's before-input-event (main.cjs), and sends the
// page an abstract event over 'desktop:hotkey' (preload.cjs: window.deadAirDesktop.onHotkey):
//   ControlLeft keyDown (not auto-repeat) -> { action: 'crouch', down: true }
//   ControlLeft keyUp (after a mapped keyDown) -> { action: 'crouch', down: false }
// AltGr: on Windows the AltGr key sends a synthetic Left Ctrl together with Right Alt. A Left Ctrl that arrives while
// Right Alt is down or with input.alt set is ignored, and a Left Ctrl immediately followed by Right Alt (within
// ALTGR_MS: the synthetic one comes first) is taken back at once, so typing an AltGr character never crouches.
// Pure: no Electron here (unit-tested in test/hotkeys.test.mjs).

/** a Left Ctrl press followed by Right Alt this quickly is AltGr's synthetic Ctrl (both come from one key press) */
const ALTGR_MS = 60;

/**
 * @typedef {{ type?: string, key?: string, code?: string, isAutoRepeat?: boolean, alt?: boolean, location?: number }} KeyInput
 * @typedef {{ action: 'crouch', down: boolean }} HotkeyEvent
 */

/** @param {KeyInput} input */
function isLeftCtrl(input) {
  return input.code === 'ControlLeft' || (!input.code && input.key === 'Control' && input.location === 1);
}

/** @param {KeyInput} input */
function isAltRight(input) {
  return input.code === 'AltRight' || input.key === 'AltGraph';
}

function createHotkeyMapper() {
  let altRight = false;
  /** a crouch-down was sent for the current Left Ctrl press */
  let ctrlDown = false;
  let ctrlAt = 0;

  /**
   * @param {KeyInput} input Electron's before-input-event input
   * @param {number} [now] ms (Date.now())
   * @returns {HotkeyEvent[]} events to send to the page, in order
   */
  function map(input, now = Date.now()) {
    if (!input || (input.type !== 'keyDown' && input.type !== 'keyUp')) return [];
    if (isAltRight(input)) {
      if (input.type === 'keyUp') {
        altRight = false;
        return [];
      }
      altRight = true;
      if (ctrlDown && now - ctrlAt <= ALTGR_MS) {
        // that Left Ctrl was AltGr's synthetic one: take the crouch back before the page acts on it
        ctrlDown = false;
        return [{ action: 'crouch', down: false }];
      }
      return [];
    }
    if (!isLeftCtrl(input)) return [];
    if (input.type === 'keyDown') {
      if (input.isAutoRepeat) return [];
      if (altRight || input.alt === true) return []; // AltGr held (or Ctrl+Alt chords): never a crouch
      ctrlDown = true;
      ctrlAt = now;
      return [{ action: 'crouch', down: true }];
    }
    // keyUp: always release what we pressed (also when Alt went down meanwhile, e.g. Alt+Tab while crouched)
    if (!ctrlDown) return [];
    ctrlDown = false;
    return [{ action: 'crouch', down: false }];
  }

  /** the window lost focus: a key-up may never come, so release now and forget AltGr */
  function reset() {
    const was = ctrlDown;
    altRight = false;
    ctrlDown = false;
    return was ? [/** @type {HotkeyEvent} */ ({ action: 'crouch', down: false })] : [];
  }

  return { map, reset, state: () => ({ altRight, ctrlDown }) };
}

module.exports = { createHotkeyMapper, isLeftCtrl, isAltRight, ALTGR_MS };
