// Owner: track (d) Meta. v1.3 F5 Company Line v0 (flag companyLine): the van phone at shift start.
//   PhoneHud: ringing / on the line / deal signed banner in the van (P answers or opens the phone).
//   PhoneScreen ('phone'): the call (speakerphone: everyone in the van reads it and can type), the term sheet on the
//   table, quick lines, SIGN / HANG UP. Every number on screen comes from the host (meta.call, meta.terms).
import './phone.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { HudProps, ScreenProps } from '../core/ui/api.ts';
import type { ClientContext } from '../core/context.ts';
import type { MetaCall, MetaTerms } from '@dead-air/shared/messages/meta.ts';
import { metaOf, sfx, useTicker, useWorldV } from './state.ts';
import { closeScreen, openScreen } from './nav.ts';

const pct = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}%`;

export function callOf(ctx: ClientContext): MetaCall | null {
  return ctx.world.phase === 'hub' ? (metaOf(ctx)?.call ?? null) : null;
}

/** P in the van: answer a ringing phone (and open it), or open the call in progress */
export function phoneKey(ctx: ClientContext): boolean {
  const c = callOf(ctx);
  if (!c || c.state === 'ended') return false;
  if (c.state === 'ringing') void ctx.net.req('meta.phone', { op: 'answer' }).catch(() => {});
  openScreen(ctx, 'phone');
  sfx(ctx, 'sfx.ui_confirm');
  return true;
}

function termsLine(t: MetaTerms): string {
  const parts = [`QUOTA ${pct(t.quotaPct)}`];
  if (t.payoutPct) parts.push(`PAYOUT ${pct(t.payoutPct)}`);
  if (t.bonus) parts.push(`HAZARD PAY +${t.bonus}`);
  for (const c of t.conditions) parts.push(c);
  return parts.join(' · ');
}

export function PhoneHud({ ctx }: HudProps) {
  useWorldV(ctx);
  useTicker(500);
  const c = callOf(ctx);
  if (!c || ctx.ui.screen.value.name !== 'none' || ctx.net.status !== 'joined') return null;
  const left = Math.max(0, Math.ceil((c.until - ctx.world.serverNow()) / 1000));
  if (c.state === 'ringing') {
    return (
      <div class="cl-hud ringing" data-testid="phone-hud" data-state="ringing">
        <span class="cl-bell">☎</span>
        <b>THE VAN PHONE IS RINGING</b>
        <span>COMPANY LINE · <span class="m-keys">P</span> ANSWER · {left} s</span>
      </div>
    );
  }
  if (c.state === 'active') {
    return (
      <div class="cl-hud" data-testid="phone-hud" data-state="active">
        <span class="cl-bell">☎</span>
        <b>ON THE LINE WITH DALE</b>
        <span>{c.holderName ? `${c.holderName} picked up · ` : ''}<span class="m-keys">P</span> JOIN THE CALL · {termsLine(c.offer)}</span>
      </div>
    );
  }
  const missed = c.outcome === 'missed';
  return (
    <div class={`cl-hud ${missed ? 'missed' : 'done'}`} data-testid="phone-hud" data-state="ended">
      <b>{missed ? 'MISSED CALL' : c.outcome === 'deal' ? 'DEAL SIGNED' : 'CALL ENDED'}</b>
      <span>{termsLine(c.offer)} · QUOTA {c.quota}</span>
    </div>
  );
}

/** quick lines for the crew (typed text works the same: the host classifies every line) */
function quickLines(ctx: ClientContext, c: MetaCall): string[] {
  const sh = metaOf(ctx)?.shift;
  const fresh = (metaOf(ctx)?.contractsDone ?? 0) === 0;
  const out = fresh
    ? ['We are new here. Give us a chance.', `We promise you ${c.baseQuota} scrip.`]
    : ['We hit quota last shift.', 'We lost people out there.', `We promise you ${c.baseQuota} scrip.`];
  out.push('Hazard pay and we take a harder site.');
  if (sh && sh.quotasMet > 0 && !fresh) out.push('Nobody died last shift.');
  out.push('You are the best boss, Dale.');
  return out.slice(0, 5);
}

export function PhoneScreen({ ctx }: ScreenProps) {
  useWorldV(ctx);
  useTicker(250);
  const c = callOf(ctx);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const inp = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const lineCount = c?.lines.length ?? 0;
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [lineCount]);
  useEffect(() => { inp.current?.focus(); }, [c?.state]);
  // the call is over and its banner time ran out (or the van left): back to the van
  useEffect(() => { if (!c) closeScreen(ctx); }, [!c]);
  if (!c) return null;
  const me = ctx.world.me ?? '';
  const now = ctx.world.serverNow();
  const coolMs = Math.max(0, (c.cooldown?.[me] ?? 0) - now);
  const left = Math.max(0, Math.ceil((c.until - now) / 1000));
  const req = (op: 'answer' | 'say' | 'accept' | 'hangup', t?: string) =>
    ctx.net.req('meta.phone', t === undefined ? { op } : { op, text: t }).then((r) => { if (!r.ok && r.reason) setNote(r.reason); else setNote(''); }, (e: unknown) => setNote(e instanceof Error ? e.message : String(e)));
  const send = (t: string) => {
    const s = t.trim();
    if (!s || c.state !== 'active') return;
    void req('say', s);
    setText('');
    sfx(ctx, 'sfx.ui_select');
  };
  const o = c.offer;
  const ended = c.state === 'ended';
  return (
    <div class="m-screen cl-screen" data-testid="phone-screen" data-state={c.state}>
      <button class="m-close" onClick={() => closeScreen(ctx)}>{ended ? 'CLOSE' : 'PUT DOWN'} [ESC]</button>
      <div class="m-wrap cl-wrap">
        <div class="m-top">
          <div>
            <div class="m-kicker">COMPANY LINE · VAN 9 HANDSET · {c.state === 'ringing' ? `RINGING · ${left} s` : c.state === 'active' ? `ON THE LINE · ${left} s · ${c.turnsLeft} LINES LEFT` : 'CALL ENDED'}</div>
            <h1 class="m-h1 cl-h1">Dale, Regional Manager</h1>
          </div>
        </div>
        <div class="cl-grid">
          <div class="m-sheet cl-call">
            <div class="cl-log" ref={log}>
              {c.lines.map((l, i) => (
                <div key={`${l.at}-${i}`} class={`cl-line ${l.who}`}>
                  {l.who !== 'system' && <span class="who">{l.who === 'dale' ? 'DALE' : (l.name ?? 'CREW')}</span>}
                  <span class="text">{l.text}</span>
                </div>
              ))}
              {c.state === 'ringing' && <div class="cl-line system cl-ringing">☎ ring ring · ring ring</div>}
            </div>
            {c.state === 'ringing' && (
              <div class="cl-answer">
                <button class="m-btn primary" data-testid="phone-answer" onClick={() => { void req('answer'); sfx(ctx, 'sfx.ui_confirm'); }}>ANSWER THE PHONE</button>
                <span class="m-small m-dim">Unanswered, the growth target stands. Anyone in the van can pick up.</span>
              </div>
            )}
            {c.state === 'active' && (
              <>
                <form class="cl-say" onSubmit={(e) => { e.preventDefault(); send(text); }}>
                  <input
                    ref={inp}
                    class="m-input"
                    data-testid="phone-input"
                    maxLength={160}
                    placeholder={coolMs > 0 ? `Dale is talking… ${Math.ceil(coolMs / 1000)} s` : 'Type to Dale. Enter sends. The whole van hears it.'}
                    value={text}
                    spellcheck={false}
                    onInput={(e) => setText(e.currentTarget.value)}
                  />
                  <button class="m-btn" type="submit" disabled={!text.trim() || coolMs > 0}>SAY</button>
                </form>
                <div class="cl-quick">
                  {quickLines(ctx, c).map((q) => <button key={q} type="button" class="m-chip" disabled={coolMs > 0} onClick={() => send(q)}>{q}</button>)}
                </div>
              </>
            )}
            {note && <div class="m-small cl-note">{note}</div>}
          </div>
          <div class="m-sheet accent cl-terms" data-testid="phone-terms">
            <div class="m-label">TERM SHEET · {ended ? (c.outcome === 'deal' ? 'SIGNED' : c.outcome === 'missed' ? 'DEFAULTED' : 'STANDING') : 'ON THE TABLE'}</div>
            <div class="cl-quota">
              <span class={`cl-pct ${o.quotaPct > 0 ? 'up' : o.quotaPct < 0 ? 'down' : ''}`}>{pct(o.quotaPct)}</span>
              <span class="cl-q">SHIFT QUOTA<b>{c.quota}</b><small>today {c.baseQuota}</small></span>
            </div>
            <dl class="m-kv cl-kv">
              <dt>Payout</dt><dd class={o.payoutPct > 0 ? 'm-green' : o.payoutPct < 0 ? 'm-red' : 'm-dim'}>{o.payoutPct ? `${pct(o.payoutPct)} on every haul` : 'standard'}</dd>
              <dt>Hazard pay</dt><dd class={o.bonus ? 'm-green' : 'm-dim'}>{o.bonus ? `+${o.bonus} per contract (haul request)` : 'none'}</dd>
              <dt>Conditions</dt><dd>{o.conditions.length ? o.conditions.map((x) => <span key={x} class="m-chip red">{x}</span>) : <span class="m-dim">none</span>}</dd>
            </dl>
            <p class="m-small m-dim cl-fine">Payout is spendable scrip, never quota. Conditions make every site this shift harder. The Company keeps a file on you: numbers only.</p>
            {c.state === 'active' && (
              <div class="m-row cl-actions">
                <button class="m-btn primary m-grow" data-testid="phone-sign" onClick={() => { void req('accept'); sfx(ctx, 'sfx.ui_confirm'); }}>SIGN THE DEAL</button>
                <button class="m-btn danger" onClick={() => void req('hangup')}>HANG UP</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** the van phone's bell while it rings (positional at the van console when the layout has one) */
export function installPhoneBell(ctx: ClientContext): void {
  let ringing: { id: number; stop(): void } | null = null;
  const tick = () => {
    const c = callOf(ctx);
    const want = c && c.state === 'ringing' ? c.id : null;
    if (ringing && ringing.id !== want) { try { ringing.stop(); } catch { /* ignore */ } ringing = null; }
    if (want !== null && !ringing && c) {
      const sfxSvc = ctx.services.use('sfx');
      const con = ctx.world.layout?.items.find((i) => i.kind === 'console');
      const ms = Math.max(1000, c.until - ctx.world.serverNow());
      let h: { stop(): void } | null = null;
      try {
        h = sfxSvc?.synth?.('phone_bell', con ? [con.x, 1.1, con.z] : undefined, con ? { ms, id: 'company-phone', occlude: false, radius: 30 } : { ms, id: 'company-phone', ui: true, volume: 0.5 }) ?? null;
      } catch { h = null; }
      ringing = { id: want, stop: () => h?.stop() };
    }
  };
  ctx.world.subscribe(tick);
}
