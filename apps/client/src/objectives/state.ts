// Owner: track (a) Objectives. Client-side objectives store (Preact signals) fed by FullState.objectives and the
// 'objectives.*' events. Everything else in this folder reads from here.
import { signal } from '@preact/signals';
import type { ObjContractResult, ObjectivesState } from '@dead-air/shared/messages/objectives.ts';
import { CLOCK } from '@dead-air/shared/constants.ts';

export interface Banner { id: number; title: string; sub?: string; tone: 'ok' | 'warn' | 'bad' | 'info'; until: number }
export interface Float3D { id: number; text: string; p: [number, number, number]; born: number; tone: 'ok' | 'bad' | 'info' }

export const objState = signal<ObjectivesState | null>(null);
export const banner = signal<Banner | null>(null);
export const floats = signal<Float3D[]>([]);
export const lastResult = signal<ObjContractResult | null>(null);
/** prompt for the fallback E targeting (only when (b)'s client does not handle E) */
export const prompt = signal<{ text: string; enabled: boolean; carry?: boolean } | null>(null);
/** server time (ms) a breaker went down and is waiting for its partner (for the 1 s countdown) */
export const leverWait = signal<{ id: string; at: number; by: string } | null>(null);

let bannerId = 1;
export function showBanner(title: string, tone: Banner['tone'] = 'info', sub?: string, ms = 2600): void {
  banner.value = { id: bannerId++, title, sub, tone, until: performance.now() + ms };
}

let floatId = 1;
export function addFloat(text: string, p: [number, number, number], tone: Float3D['tone'] = 'ok'): void {
  floats.value = [...floats.value.slice(-8), { id: floatId++, text, p, born: performance.now(), tone }];
}

/** in-game minutes since 22:00 for a server time */
export function clockMin(st: ObjectivesState, serverNow: number): number {
  const sec = (serverNow - st.startedAt) / 1000;
  return Math.max(0, Math.min(CLOCK.totalGameMin, (sec / Math.max(1, st.realSec)) * CLOCK.totalGameMin));
}

export function clockText(min: number): string {
  const total = CLOCK.startHour * 60 + Math.floor(min);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
