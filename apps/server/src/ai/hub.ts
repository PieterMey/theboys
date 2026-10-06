// Owner: track (e) AI. Internal wiring shared by api.ts, the routes and the STT bridge (apps/server/src/stt):
// utterance subscribers, the installed ServerContext (absent in unit tests / scripts) and status counters.
import type { Utterance } from '@dead-air/shared/messages/ai.ts';
import type { Crew, Logger, ServerContext } from '../core/types.ts';

export type UtteranceFn = (crew: Crew, u: Utterance) => void;

const subs: UtteranceFn[] = [];
let ctxRef: ServerContext | null = null;
const fallbackLog: Logger = {
  debug() {},
  info: (...a) => console.log('[ai]', ...a),
  warn: (...a) => console.warn('[ai] WARN', ...a),
  error: (...a) => console.error('[ai] ERROR', ...a),
};

export function setCtx(ctx: ServerContext | null): void {
  ctxRef = ctx;
}

export function getCtx(): ServerContext | null {
  return ctxRef;
}

export function log(): Logger {
  return ctxRef ? ctxRef.log('ai') : fallbackLog;
}

/** balance.ai (hot-reload safe) or {} */
export function aiBal(): Record<string, unknown> {
  return (ctxRef?.balance.ai ?? {}) as Record<string, unknown>;
}

export function balNum(k: string, d: number): number {
  const v = aiBal()[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

export function flagOn(name: string): boolean {
  const f = ctxRef?.flags;
  if (!f) return true;
  return f[name] !== false;
}

export function subscribe(fn: UtteranceFn): () => void {
  subs.push(fn);
  return () => {
    const i = subs.indexOf(fn);
    if (i >= 0) subs.splice(i, 1);
  };
}

export function subscriberCount(): number {
  return subs.length;
}

/** Deliver an utterance to every subscriber (each isolated: one throwing subscriber can't break the others). */
export function emitUtterance(crew: Crew, u: Utterance): void {
  for (const fn of subs.slice()) {
    try {
      fn(crew, u);
    } catch (e) {
      log().warn(`utterance subscriber threw: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Listener decision counters for aiStatus() */
export const listenerStats = { decisions: 0, jev: 0, haiku: 0, taunt: 0, none: 0 };

/** STT bridge status provider (set by apps/server/src/stt) */
export interface SttStatus {
  url: string;
  healthy: boolean | null;
  lastMs: number | null;
  p50Ms: number | null;
  inFlight: number;
  queued: number;
  segments: number;
  utterances: number;
  dropped: number;
}

let sttStatusFn: (() => SttStatus) | null = null;

export function setSttStatus(fn: () => SttStatus): void {
  sttStatusFn = fn;
}

export function sttStatus(): SttStatus {
  return sttStatusFn?.() ?? { url: '', healthy: null, lastMs: null, p50Ms: null, inFlight: 0, queued: 0, segments: 0, utterances: 0, dropped: 0 };
}

/** Per-crew RAM quote store (HR memo); filled by the STT bridge, read by the review route. Never persisted. */
export interface Quote {
  text: string;
  at: number;
  heardByListener: boolean;
  meaningful: boolean;
  band: number;
}

const quotes = new Map<string, Map<string, Quote[]>>();

export function addQuote(crewCode: string, pid: string, q: Quote, max: number): void {
  let byPlayer = quotes.get(crewCode);
  if (!byPlayer) quotes.set(crewCode, (byPlayer = new Map()));
  let list = byPlayer.get(pid);
  if (!list) byPlayer.set(pid, (list = []));
  list.push(q);
  if (list.length > max) list.splice(0, list.length - max);
}

export function quotesOf(crewCode: string, pid: string): readonly Quote[] {
  return quotes.get(crewCode)?.get(pid) ?? [];
}

export function forgetCrewQuotes(crewCode: string): void {
  quotes.delete(crewCode);
}
