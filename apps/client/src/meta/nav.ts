// Owner: track (d) Meta. Screen routing helpers shared by the meta screens (no imports of screens: avoids cycles).
import type { ClientContext } from '../core/context.ts';

/** screens this track owns (Esc closes them; phase changes replace them) */
export const META_SCREENS = new Set(['board', 'shop', 'mirror', 'kennel', 'brightness', 'menu', 'drive', 'console', 'results', 'memo']);
/** screens that are part of the phase flow (not closable with Esc) */
export const FLOW_SCREENS = new Set(['drive', 'results', 'memo']);
/** hub item kind -> screen */
export const ITEM_SCREEN: Record<string, string> = { board: 'board', shop: 'shop', mirror: 'mirror', kennel: 'kennel', console: 'console' };

export interface MetaClientSlice {
  intercepts: { text: string; quote: string; speaker: string | null; callsign: string | null; action: string; at: number }[];
  /** nearest usable hub item (for the prompt) */
  near: { id: string; kind: string; d: number } | null;
  openedAt: number;
}

export function metaSlice(ctx: ClientContext): MetaClientSlice {
  let s = ctx.world.slices.meta as MetaClientSlice | undefined;
  if (!s) ctx.world.slices.meta = s = { intercepts: [], near: null, openedAt: 0 };
  return s;
}

export function openScreen(ctx: ClientContext, name: string, props: Record<string, unknown> = {}): void {
  metaSlice(ctx).openedAt = performance.now();
  try { document.exitPointerLock?.(); } catch { /* ignore */ }
  ctx.ui.setScreen(name, props);
}

export function closeScreen(ctx: ClientContext): void {
  ctx.ui.setScreen('none');
}

