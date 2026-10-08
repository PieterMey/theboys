// Owner: track (e) AI + speech. PUBLIC cross-track server API (names fixed by the integrator):
//   onUtterance(fn(crew, u))        transcripts + who heard them (STT bridge, proximity text)
//   listenerIntent(input)           JEV -> Haiku 4.5 -> null (register with (c) listener.setBrain)
//   directorPick(state, allowed)    JEV only -> null (register with (c) director.setPicker)
//   briefFor(order)                 async, template-first AI work-order text (always resolves)
//   reviewFor(shift)                async, template-first Company Performance Review (always resolves; also
//                                   emits 'ai.review' to the crew when ready)
//   aiStatus()                      budget, latencies, breaker states (host HUD / debug)
//   speakLure(req, fallback)        the Listener's radio_lure in a generated voice (Haiku line + ElevenLabs TTS);
//                                   false = not attempted (play the garbled clip now), true = it emits 'ai.lure' or
//                                   calls fallback itself (failure / 2.5 s deadline). Never throws.
// Safe to import before the ai track installed (unit tests, other tracks' install order): every function works
// with defaults (AI_MODE from env, mock by default) and never throws.
import type { AiStatus, DirectorOption, ListenerInput, ListenerIntent, ShiftReview, ShiftSummary, Utterance } from '@dead-air/shared/messages/ai.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import type { Crew } from '../core/types.ts';
import { gatewayHealth, gatewayMode, routeStatus, spentUsd } from './gateway.ts';
import { decide } from './listener.ts';
import { pick } from './director.ts';
import { brief } from './brief.ts';
import { review } from './review.ts';
import { lureStatus, speakLure as speakLureImpl } from './lure.ts';
import type { LureHeard, LureRequest } from './lure.ts';
import { getCtx, listenerStats, log, sttStatus, subscribe } from './hub.ts';

export type { AiStatus, DirectorOption, ListenerInput, ListenerIntent, ShiftReview, ShiftSummary, Utterance };
export type { LureHeard, LureRequest };

const fastModel = () => getCtx()?.env.MODEL_FAST ?? process.env.MODEL_FAST ?? 'claude-haiku-5-5';
/** refusal retry for briefs/memos: Haiku 4.5 on purpose (no safety classifiers; Haiku 5.5 has them and no fallback) */
const retryModel = () => getCtx()?.env.MODEL_RETRY ?? process.env.MODEL_RETRY ?? 'claude-haiku-4-5';
const writerModel = () => getCtx()?.env.MODEL_WRITER ?? process.env.MODEL_WRITER ?? 'claude-opus-5-5';

/** Subscribe to transcribed utterances (voice + proximity text). Returns an unsubscribe function. */
export function onUtterance(fn: (crew: Crew, u: Utterance) => void): () => void {
  return subscribe(fn);
}

/** Listener brain: an intent with a code-validated target, or null (use the rule brain). Never rejects. */
export function listenerIntent(input: ListenerInput): Promise<ListenerIntent | null> {
  return decide(input, fastModel());
}

/** Director bias: one of the allowed event ids, or null (weighted random). Never rejects. */
export function directorPick(state: unknown, allowed: readonly DirectorOption[]): Promise<string | null> {
  return pick(state, allowed);
}

/** AI-written flavour for a template work order (same id/seed/mechanics), or the template itself. Never rejects. */
export function briefFor(order: WorkOrder): Promise<WorkOrder> {
  return brief(order, writerModel(), retryModel());
}

/** Shift review (per-player HR memo + comments + letter). Template parts where AI failed. Never rejects. */
export function reviewFor(shift: ShiftSummary): Promise<ShiftReview> {
  return review(shift, writerModel(), retryModel()).then((r) => {
    const ctx = getCtx();
    const crew = ctx?.crews.get(shift.crew);
    if (ctx && crew) {
      try {
        ctx.emit(crew, 'ai.review', r);
      } catch (e) {
        log().warn(`ai.review emit failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return r;
  });
}

/** The Listener's radio lure, voiced (see lure.ts). false = not attempted: the caller plays its garbled clip now. */
export function speakLure(req: LureRequest, fallback: () => void): boolean {
  return speakLureImpl(req, fallback);
}

export function aiStatus(): AiStatus {
  const h = gatewayHealth();
  const ctx = getCtx();
  const budget = Number(ctx?.balance.core.aiBudgetUsdPerSession ?? 3);
  return {
    mode: gatewayMode(),
    enabled: h.enabled,
    disabledReason: h.reason,
    budgetUsd: budget,
    spentUsd: Math.round(spentUsd() * 10000) / 10000,
    routes: routeStatus(),
    jev: { healthy: h.jevHealthy, lastMs: h.jevLastMs },
    stt: sttStatus(),
    listener: { ...listenerStats },
    lure: lureStatus(),
  };
}
