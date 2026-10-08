// Owner: track ⑤ Players (v1.2: players-stealth). Keyboard + mouse input with pointer lock, action map (PLAN §3.5)
// published on the bus as 'action:*' events, test overrides (setInput/look/teleport bypass pointer lock). Never binds
// Ctrl/Meta: handlers only look at KeyboardEvent.code / MouseEvent.button. The desktop app's Left-Ctrl crouch arrives
// as an abstract hotkey from its shell (window.deadAirDesktop.onHotkey: {action:'crouch', down}), never as a key here.
// v1.2: the crouch latch resets on phase changes, death and revive (resetCrouch); alt-tabbing releases a held E.
import type { InputState } from '@dead-air/shared/test-api.ts';
import type { ClientContext } from '../core/context.ts';
import type { PlayerSettings } from './types.ts';
import { ui } from './social.ts';

const LS_SETTINGS = 'deadair.playerSettings';

export const DEFAULT_SETTINGS: PlayerSettings = { sensitivity: 0.0022, crouchToggle: false, invertY: false, headBob: true };

/** the desktop shell's hotkey event (apps/desktop/src/hotkeys.cjs): Left Ctrl mapped to crouch, AltGr filtered */
export interface DesktopHotkey { action: string; down: boolean }
export interface DesktopHotkeyBridge {
  onHotkey?: (cb: (ev: DesktopHotkey) => unknown) => (() => void) | unknown;
}

/** window.deadAirDesktop (desktop app only; the browser has none) */
export function desktopBridge(): DesktopHotkeyBridge | null {
  try {
    const d = (globalThis as { deadAirDesktop?: unknown }).deadAirDesktop;
    return d && typeof d === 'object' ? (d as DesktopHotkeyBridge) : null;
  } catch {
    return null;
  }
}

/** desktop Left-Ctrl crouch: on by default when the shell provides the hotkey bridge, off in the browser */
export function ctrlCrouchOn(s: PlayerSettings): boolean {
  return typeof desktopBridge()?.onHotkey === 'function' && s.ctrlCrouch !== false;
}

export function loadSettings(defSens: number): PlayerSettings {
  const s: PlayerSettings = { ...DEFAULT_SETTINGS, sensitivity: defSens };
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) Object.assign(s, JSON.parse(raw) as Partial<PlayerSettings>);
  } catch { /* private mode */ }
  if (!(s.sensitivity > 0 && s.sensitivity < 0.05)) s.sensitivity = defSens;
  return s;
}

export function saveSettings(s: PlayerSettings): void {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch { /* ignore */ }
}

export interface InputCore {
  /** merged movement state for this frame */
  state(): InputState;
  setInput(p: Partial<InputState>): void;
  /** consume accumulated mouse look delta (radians) */
  takeLook(): { dYaw: number; dPitch: number };
  /** raw mouse delta since the last call (pixels), for the emote wheel */
  takeMouse(): { dx: number; dy: number };
  locked(): boolean;
  requestLock(): void;
  releaseLock(): void;
  /** true while a text field has focus or the chat line is open */
  typing(): boolean;
  setChatOpen(open: boolean): void;
  settings: PlayerSettings;
  /** F pressed (the players track toggles the light and emits 'action:flashlight') */
  onFlashlight: () => void;
  /** game input active (in-game screen) */
  setActive(on: boolean): void;
  active(): boolean;
  /** v1.2: drop the crouch-toggle latch (phase change, own death, revive) */
  resetCrouch(): void;
  /** v1.2 test hook: the latch state */
  crouchLatched(): boolean;
}

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [1, 0], KeyS: [-1, 0], KeyA: [0, -1], KeyD: [0, 1],
  ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
};

function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function createInput(ctx: ClientContext, settings: PlayerSettings): InputCore {
  const held = new Set<string>();
  let crouchLatched = false;
  let lookYaw = 0;
  let lookPitch = 0;
  let mouseDx = 0;
  let mouseDy = 0;
  let isLocked = false;
  let chatOpen = false;
  let gameActive = false;
  /** test overrides (movement axes persist until changed) */
  const test: Partial<InputState> = {};
  let testUsed = false;

  const bus = ctx.bus;
  const typing = () => chatOpen || isTextTarget(document.activeElement);
  /** a crouch press from C or the desktop hotkey: flips the latch in toggle mode, else held until its release */
  const crouchDown = (src: 'KeyC' | 'desk:crouch') => {
    if (settings.crouchToggle) crouchLatched = !crouchLatched;
    held.add(src);
  };

  const canvas = (): HTMLElement | null => {
    const three = ctx.services.use('three');
    return (three?.renderer.domElement as HTMLElement | undefined) ?? document.getElementById('game');
  };

  const requestLock = () => {
    const el = canvas();
    if (!el || document.pointerLockElement === el) return;
    try {
      const r = (el.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | void).call(el, { unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          try {
            const r2 = el.requestPointerLock() as unknown as Promise<void> | undefined;
            r2?.catch?.(() => { /* user gesture / cooldown: ignore */ });
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
  };

  document.addEventListener('pointerlockchange', () => {
    const now = document.pointerLockElement !== null && document.pointerLockElement === canvas();
    if (now === isLocked) return;
    isLocked = now;
    bus.emit('input:pointerlock', { locked: now });
    if (!now) {
      held.clear();
      if (gameActive && !chatOpen) bus.emit('action:menu', { down: true });
    }
  });

  addEventListener('mousemove', (e) => {
    if (!isLocked) return;
    const dx = e.movementX || 0, dy = e.movementY || 0;
    if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return; // Chrome pointer-lock spikes
    mouseDx += dx;
    mouseDy += dy;
    lookYaw -= dx * settings.sensitivity;
    lookPitch -= dy * settings.sensitivity * (settings.invertY ? -1 : 1);
  });

  addEventListener('mousedown', (e) => {
    if (!gameActive) return;
    const t = e.target as HTMLElement | null;
    const onUi = !!t?.closest?.('button,input,select,textarea,a,label,.screen,[data-no-lock]');
    if (!isLocked) {
      if (e.button === 0 && !onUi && !typing()) requestLock();
      return;
    }
    if (e.button === 0) bus.emit('action:use', { down: true });
    else if (e.button === 1) {
      e.preventDefault();
      bus.emit('action:ping', { down: true });
    }
  });
  addEventListener('mouseup', (e) => {
    if (!gameActive || !isLocked) return;
    if (e.button === 0) bus.emit('action:use', { down: false });
    else if (e.button === 1) bus.emit('action:ping', { down: false });
  });
  // MMB autoscroll off
  addEventListener('auxclick', (e) => { if (e.button === 1 && gameActive) e.preventDefault(); });

  /** E is down (sent action:interact down, no up yet): alt-tab must release it (quiet doors never finish unattended) */
  let interactHeld = false;
  const keyAction = (code: string, down: boolean, repeat: boolean) => {
    switch (code) {
      case 'KeyE':
        if (!repeat) {
          if (!down && !interactHeld) return true; // its down was never sent (typing, menu) or blur already released it
          interactHeld = down;
          bus.emit('action:interact', { down });
        }
        return true;
      case 'KeyG': if (!repeat) bus.emit('action:drop', { down }); return true;
      case 'KeyQ': if (!repeat) bus.emit('action:radio', { down }); return true;
      case 'KeyV': if (!repeat) bus.emit('action:ptt', { down }); return true;
      case 'KeyT': if (!repeat) bus.emit('action:emote', { down }); return true;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
        // with the emote wheel open the digits pick an emote and must not also switch the inventory slot
        if (down && !repeat) bus.emit(ui.wheelOpen.value ? 'action:wheelKey' : 'action:slot', { slot: Number(code.slice(5)) - 1 });
        return true;
      default: return false;
    }
  };

  addEventListener('keydown', (e) => {
    if (!gameActive) return;
    if (e.code === 'Escape') {
      if (chatOpen) return; // chat line handles its own Esc
      if (!isLocked) bus.emit('action:menu', { down: true });
      return;
    }
    if (typing()) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (ctx.flags.proxText !== false && !e.repeat) {
        e.preventDefault();
        bus.emit('action:chat', { open: true });
      }
      return;
    }
    if (e.code === 'Tab') e.preventDefault();
    if (MOVE_KEYS[e.code] || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      held.add(e.code);
      return;
    }
    if (e.code === 'KeyC') {
      if (!e.repeat) crouchDown('KeyC');
      return;
    }
    if (e.code === 'KeyF') {
      if (!e.repeat) input.onFlashlight();
      return;
    }
    if (keyAction(e.code, true, e.repeat)) e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    if (!gameActive) return;
    held.delete(e.code);
    if (typing() && !['KeyQ', 'KeyV', 'KeyT', 'KeyE'].includes(e.code)) return;
    if (e.code === 'KeyF') return;
    keyAction(e.code, false, false);
  });
  addEventListener('blur', () => {
    // releasing held keys avoids stuck sprint / walkie when alt-tabbing
    if (held.has('KeyQ')) bus.emit('action:radio', { down: false });
    if (held.has('KeyV')) bus.emit('action:ptt', { down: false });
    // v1.2: a held E (quiet door, drawer, lockpick) is released too, so nothing completes while alt-tabbed
    if (interactHeld) {
      interactHeld = false;
      bus.emit('action:interact', { down: false });
    }
    held.clear();
  });

  // ---- v1.2 desktop app: Left Ctrl crouches exactly like C (the shell maps the key; the page never reads Ctrl) ----
  const bridge = desktopBridge();
  if (bridge && typeof bridge.onHotkey === 'function') {
    try {
      bridge.onHotkey((ev) => {
        if (!ev || ev.action !== 'crouch') return;
        if (!ev.down) {
          held.delete('desk:crouch'); // releases always land, also while typing (no stuck crouch)
          return;
        }
        if (!gameActive || typing() || settings.ctrlCrouch === false) return;
        crouchDown('desk:crouch');
      });
    } catch { /* an older shell */ }
  }

  const state = (): InputState => {
    let forward = 0, right = 0;
    for (const k of held) {
      const m = MOVE_KEYS[k];
      if (m) { forward += m[0]; right += m[1]; }
    }
    forward = Math.max(-1, Math.min(1, forward));
    right = Math.max(-1, Math.min(1, right));
    let sprint = held.has('ShiftLeft') || held.has('ShiftRight');
    let crouch = settings.crouchToggle ? crouchLatched : held.has('KeyC') || held.has('desk:crouch');
    if (testUsed) {
      if (test.forward !== undefined && test.forward !== 0) forward = test.forward;
      if (test.right !== undefined && test.right !== 0) right = test.right;
      if (test.sprint) sprint = true;
      if (test.crouch) crouch = true;
    }
    return { forward, right, sprint, crouch };
  };

  const input: InputCore = {
    state,
    setInput(p) {
      testUsed = true;
      for (const k of ['forward', 'right', 'sprint', 'crouch'] as const) if (p[k] !== undefined) (test as Record<string, unknown>)[k] = p[k];
      // one-shot actions -> bus (same events as the keys)
      if (p.interact) { bus.emit('action:interact', { down: true }); bus.emit('action:interact', { down: false }); }
      if (p.use) { bus.emit('action:use', { down: true }); bus.emit('action:use', { down: false }); }
      if (p.drop) { bus.emit('action:drop', { down: true }); bus.emit('action:drop', { down: false }); }
      if (p.flashlight) input.onFlashlight();
      if (p.radio !== undefined && p.radio !== test.radio) {
        test.radio = p.radio;
        bus.emit('action:radio', { down: p.radio });
      }
      if (p.slot !== undefined) bus.emit('action:slot', { slot: p.slot });
    },
    takeLook() {
      const r = { dYaw: lookYaw, dPitch: lookPitch };
      lookYaw = 0;
      lookPitch = 0;
      return r;
    },
    takeMouse() {
      const r = { dx: mouseDx, dy: mouseDy };
      mouseDx = 0;
      mouseDy = 0;
      return r;
    },
    locked: () => isLocked,
    requestLock,
    releaseLock() {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    typing,
    setChatOpen(open) {
      chatOpen = open;
      if (open) held.clear();
    },
    settings,
    onFlashlight: () => {},
    setActive(on) {
      gameActive = on;
      if (!on) held.clear();
    },
    active: () => gameActive,
    resetCrouch() {
      // only the toggle latch: a key that is physically held keeps crouching until its own release
      crouchLatched = false;
    },
    crouchLatched: () => crouchLatched,
  };
  return input;
}
