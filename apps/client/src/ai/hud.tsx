// Owner: track (e) AI. Host-only status line (top-right): AI mode, $ spent / budget, JEV / Haiku / STT latencies,
// open circuit breakers. Shown only in the host tab (admin token in localStorage) or with ?aistatus=1.
// Polls the 'ai.status' request every 2 s while joined. Click to expand per-route details.
import { signal } from '@preact/signals';
import type { AiStatus } from '@dead-air/shared/messages/ai.ts';
import type { HudProps } from '../core/ui/api.ts';

export const aiStatusSig = signal<AiStatus | null>(null);
const expanded = signal(false);
const mono = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

const ms = (v: number | null | undefined) => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

export function AiStatusHud(_p: HudProps) {
  const s = aiStatusSig.value;
  if (!s) return null;
  const r = s.routes;
  const open = Object.entries(r).filter(([, v]) => v.breaker === 'open').map(([k]) => k);
  const color = !s.enabled ? '#ff8a6b' : open.length ? '#ffd84d' : '#9dff6b';
  const sttMs = s.stt.p50Ms ?? s.stt.lastMs;
  const sttOk = s.stt.healthy === false ? 'down' : sttMs != null ? ms(sttMs) : s.stt.healthy ? 'up' : '–';
  const line = `AI ${s.mode}${s.enabled ? '' : ' OFF'} · $${s.spentUsd.toFixed(3)}/${s.budgetUsd} · jev ${ms(r['listener.jev']?.p50Ms ?? s.jev.lastMs)} · haiku ${ms(r['listener.haiku']?.p50Ms)} · stt ${sttOk}`;
  return (
    <div
      onClick={() => { expanded.value = !expanded.value; }}
      style={{ font: `500 10px ${mono}`, color: '#c9c4b5', background: 'rgba(0,0,0,0.45)', padding: '3px 7px', borderRadius: '3px', marginTop: '4px', cursor: 'pointer', pointerEvents: 'auto', maxWidth: '420px' }}
      title="AI / speech status (host only). Click for details."
    >
      <span style={{ color }}>●</span> {line}
      {s.disabledReason && <div style={{ color: '#ff8a6b' }}>{s.disabledReason}</div>}
      {open.length > 0 && <div style={{ color: '#ffd84d' }}>breaker open: {open.join(', ')}</div>}
      {expanded.value && (
        <div style={{ marginTop: '3px', lineHeight: 1.45 }}>
          {Object.entries(r).map(([k, v]) => (
            <div key={k}>{k}: {v.ok}/{v.calls} ok · p50 {ms(v.p50Ms)} · last {ms(v.lastMs)}{v.breaker === 'open' ? ` · OPEN ${v.openForSec}s` : ''}</div>
          ))}
          <div>listener: {s.listener.decisions} decisions (jev {s.listener.jev}, haiku {s.listener.haiku}, taunt {s.listener.taunt}, rules {s.listener.none})</div>
          <div>stt: {s.stt.utterances} utterances / {s.stt.segments} segments · dropped {s.stt.dropped} · queue {s.stt.queued}</div>
        </div>
      )}
    </div>
  );
}
