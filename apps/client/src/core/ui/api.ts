// UI API (Preact overlay): screen router, HUD slots, toasts. Tracks register their own screens/HUD widgets:
//   ctx.ui.registerScreen('board', BoardScreen); ctx.ui.setScreen('board', { orderId });
//   ctx.ui.registerHud('bottom-left', BandMeter, { order: 10 });
import { signal } from '@preact/signals';
import type { ReadonlySignal, Signal } from '@preact/signals';
import type { ComponentType } from 'preact';
import type { ClientContext } from '../context.ts';

export type HudSlot =
  | 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'
  /** extra sections rendered inside the Join screen (mic picker, consent, ...) */
  | 'join';

export const HUD_SLOTS: readonly HudSlot[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

export interface ScreenProps {
  ctx: ClientContext;
  [k: string]: unknown;
}
export interface HudProps {
  ctx: ClientContext;
}
export interface HudEntry {
  id: string;
  slot: HudSlot;
  order: number;
  comp: ComponentType<HudProps>;
}
export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error';
}

export interface UiApi {
  /** 'none' = no screen (in-game HUD only) */
  setScreen(name: string, props?: Record<string, unknown>): void;
  registerScreen(name: string, comp: ComponentType<ScreenProps>): void;
  /** returns an unregister function */
  registerHud(slot: HudSlot, comp: ComponentType<HudProps>, opts?: { order?: number; id?: string }): () => void;
  toast(text: string, kind?: Toast['kind'], ms?: number): void;
  readonly screen: ReadonlySignal<{ name: string; props: Record<string, unknown> }>;
  /** false hides the HUD layer (full-screen menus) */
  readonly hudVisible: Signal<boolean>;
  readonly screens: Map<string, ComponentType<ScreenProps>>;
  readonly screensVersion: Signal<number>;
  readonly huds: Signal<HudEntry[]>;
  readonly toasts: Signal<Toast[]>;
}

export function createUi(ctx: ClientContext): UiApi {
  const screen = signal<{ name: string; props: Record<string, unknown> }>({ name: 'join', props: {} });
  const huds = signal<HudEntry[]>([]);
  const toasts = signal<Toast[]>([]);
  const screensVersion = signal(0);
  const screens = new Map<string, ComponentType<ScreenProps>>();
  let toastId = 1;
  let hudId = 1;
  const ui: UiApi = {
    setScreen(name, props = {}) {
      screen.value = { name, props };
    },
    registerScreen(name, comp) {
      screens.set(name, comp);
      screensVersion.value++;
    },
    registerHud(slot, comp, opts = {}) {
      const entry: HudEntry = { id: opts.id ?? `hud${hudId++}`, slot, order: opts.order ?? 50, comp };
      huds.value = [...huds.value.filter((h) => h.id !== entry.id), entry].sort((a, b) => a.order - b.order);
      return () => {
        huds.value = huds.value.filter((h) => h !== entry);
      };
    },
    toast(text, kind = 'info', ms = 3500) {
      const t: Toast = { id: toastId++, text, kind };
      toasts.value = [...toasts.value.slice(-4), t];
      setTimeout(() => {
        toasts.value = toasts.value.filter((x) => x !== t);
      }, ms);
    },
    screen,
    hudVisible: signal(true),
    screens,
    screensVersion,
    huds,
    toasts,
  };
  ctx.net.on('notice', (d) => ui.toast(d.text, d.kind ?? 'info'));
  return ui;
}
