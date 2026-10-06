// Owner: track (a) Objectives. HUD: work-order checklist (power / vault / Core / salvage + Company Requests) with the
// contract clock, centre banners (power restored, breaker tripped, blackout...), the fallback E prompt and the
// 3D-anchored "+scrip" floating texts.
import { useEffect, useState } from 'preact/hooks';
import type { HudProps } from '../core/ui/api.ts';
import { CLOCK } from '@dead-air/shared/constants.ts';
import type { ObjRequest } from '@dead-air/shared/messages/objectives.ts';
import { banner, clockMin, clockText, leverWait, objState, prompt } from './state.ts';

const REQ_LABEL: Record<string, (q: ObjRequest) => string> = {
  ALL_SURVIVE: () => 'Everyone survives',
  EXTRACT_ABOVE: (q) => `Haul over $${q.param ?? 0}`,
  LURE_IT_WITH_A_LIE: () => 'Lure it with a lie',
};

function useTick(ms: number): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setT((x) => x + 1), ms);
    return () => clearInterval(h);
  }, [ms]);
  return t;
}

function Box({ on, fail }: { on: boolean; fail?: boolean }) {
  return <span class={`obj-box${on ? ' on' : ''}${fail ? ' fail' : ''}`}>{on ? '✓' : fail ? '✕' : ''}</span>;
}

export function Checklist({ ctx }: HudProps) {
  useTick(250);
  const st = objState.value;
  if (!st || !st.active || ctx.world.phase !== 'contract') return null;
  const now = ctx.world.serverNow();
  const min = clockMin(st, now);
  const powered = st.levers.length ? st.levers.every((l) => !!st.power[l.zone]) : Object.values(st.power).every(Boolean);
  const coreIn = st.coreState === 'van';
  const late = min >= CLOCK.blackoutMin;
  const leaving = min >= CLOCK.hornMin;
  const left = Math.max(0, st.realSec * (1 - min / CLOCK.totalGameMin));
  const cool = st.leverCooldownUntil > now ? Math.ceil((st.leverCooldownUntil - now) / 1000) : 0;
  const carried = st.coreState === 'carried';
  return (
    <div class={`obj-card${late ? ' late' : ''}`}>
      <div class="obj-clock">
        <span class="obj-time">{st.ended ? '04:00' : clockText(min)}</span>
        <span class="obj-sub">{st.ended ? 'VAN GONE' : leaving ? `VAN LEAVES ${Math.ceil(left)}s` : late ? 'BLACKOUT' : 'VAN LEAVES 04:00'}</span>
      </div>
      <div class="obj-rows">
        <div class={`obj-row${powered ? ' done' : ''}`}><Box on={powered} /> <b>POWER</b><i>{powered ? 'restored' : cool ? `tripped ${cool}s` : 'twin breakers, 1 s'}</i></div>
        <div class={`obj-row${st.vaultOpen ? ' done' : ''}`}><Box on={st.vaultOpen} /> <b>VAULT</b><i>{st.vaultOpen ? 'open' : powered ? 'enter code' : 'no power'}</i></div>
        <div class={`obj-row${coreIn ? ' done' : ''}`}><Box on={coreIn} fail={st.coreState === 'none'} /> <b>CORE</b><i>{coreIn ? `$${st.core?.value ?? 0} in van` : carried ? 'carrying...' : st.coreState === 'dropped' ? `dropped $${st.core?.value ?? 0}` : 'two carriers'}</i></div>
        <div class="obj-row"><span class="obj-box sal">$</span> <b>SALVAGE</b><i>{st.salvage.count} / {st.salvage.total}  ·  ${st.hauled}</i></div>
      </div>
      {st.requests.length > 0 && (
        <div class="obj-reqs">
          <div class="obj-reqh">COMPANY REQUESTS</div>
          {st.requests.map((q) => (
            <div key={q.kind} class={`obj-row req${q.done ? ' done' : ''}${q.failed && !q.done ? ' failed' : ''}`} title={q.text}>
              <Box on={q.done} fail={q.failed && !q.done} /> <span>{(REQ_LABEL[q.kind] ?? ((x: ObjRequest) => x.kind))(q)}</span><em>+{q.reward}</em>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Banner() {
  useTick(200);
  const b = banner.value;
  if (!b || performance.now() > b.until) return null;
  return (
    <div key={b.id} class={`obj-banner ${b.tone}`}>
      <div class="obj-banner-t">{b.title}</div>
      {b.sub && <div class="obj-banner-s">{b.sub}</div>}
    </div>
  );
}

export function LeverCountdown({ ctx }: HudProps) {
  useTick(50);
  const w = leverWait.value;
  if (!w) return null;
  const left = 1000 - (ctx.world.serverNow() - w.at);
  if (left <= 0) return null;
  const pct = Math.max(0, Math.min(1, left / 1000));
  return (
    <div class="obj-lever">
      <div class="obj-lever-t">BREAKER DOWN · PULL THE OTHER</div>
      <div class="obj-lever-bar"><div style={{ width: `${pct * 100}%` }} /></div>
    </div>
  );
}

export function Prompt() {
  const p = prompt.value;
  if (!p) return null;
  return (
    <div class={`obj-prompt${p.enabled ? '' : ' off'}${p.carry ? ' carry' : ''}`}>
      {p.carry ? <><span class="obj-carry-dot" /> CARRYING THE CORE · stay together · <kbd>E</kbd> let go</> : <><kbd>E</kbd> {p.text}</>}
    </div>
  );
}
