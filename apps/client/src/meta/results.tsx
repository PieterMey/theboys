// Owner: track (d) Meta. Per-contract results (scrip ledger, death cards, XP, "it heard -> it did") and the end-of-shift
// Company Performance Review / termination letter (typewriter on company letterhead).
import { useEffect, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import type { MetaContractResults, MetaShiftReview } from '@dead-air/shared/messages/meta.ts';
import { isLeader, metaOf, sfx, useTicker, useWorldV } from './state.ts';
import { openScreen } from './nav.ts';

const OUTCOME: Record<MetaContractResults['outcome'], [string, string]> = {
  extracted: ['EXTRACTED', 'var(--m-green)'],
  left_early: ['LEFT EARLY', 'var(--m-green)'],
  wiped: ['CREW LOST', 'var(--m-red)'],
  voided: ['CONTRACT VOIDED', 'var(--m-dim)'],
  timeout: ['VAN DEPARTED', 'var(--m-amber)'],
};

function Continue({ ctx, label }: ScreenProps & { label: string }) {
  useTicker(500);
  const meta = metaOf(ctx);
  const left = meta?.resultsEndsAt ? Math.max(0, Math.round((meta.resultsEndsAt - ctx.world.serverNow()) / 1000)) : 0;
  if (!isLeader(ctx)) return <span class="m-small m-dim">The crew leader continues · back to the van in {left} s</span>;
  return (
    <button class="m-btn primary" onClick={() => { sfx(ctx, 'sfx.ui_confirm'); void ctx.net.req('meta.continue', {}).then((r) => { if (!r.ok && r.reason) ctx.ui.toast(r.reason, 'warn'); }); }}>
      {label} <span style={{ opacity: 0.6 }}>· {left} s</span>
    </button>
  );
}

export function ResultsScreen({ ctx }: ScreenProps) {
  useWorldV(ctx);
  const meta = metaOf(ctx);
  const r = meta?.results ?? null;
  const [t0] = useState(() => performance.now());
  useTicker(120);
  useEffect(() => { sfx(ctx, r?.deaths.length ? 'sfx.death_sting' : 'sfx.van_horn'); }, [ctx]);
  if (!r) {
    return <div class="m-screen m-solid"><div class="m-wrap"><div class="m-kicker">RESULTS</div><h1 class="m-h1">Counting the haul…</h1></div></div>;
  }
  const [word, color] = OUTCOME[r.outcome] ?? ['DONE', 'var(--m-text)'];
  const el = (performance.now() - t0) / 1000;
  const count = (v: number) => Math.round(v * Math.min(1, el / 1.4));
  const pct = r.quota > 0 ? Math.min(100, (r.shiftHauled / r.quota) * 100) : 0;
  const fines = r.fines.reduce((a, f) => a + f.amount, 0);
  return (
    <div class="m-screen m-solid">
      <div class="m-wrap">
        <div class="m-top">
          <div>
            <div class="m-kicker">CONTRACT {r.contract}/{r.contractsPerShift} · {r.siteName.toUpperCase()} · RISK {r.risk}</div>
            <div class="m-big-outcome" style={{ color, marginTop: '8px' }}>{word}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div class="m-label">HAULED THIS CONTRACT</div>
            <div class="m-num m-amber" style={{ fontSize: '58px' }}>+{count(r.hauled)}</div>
            <div class="m-small m-dim">{r.lootTotal ? `of ${r.lootTotal} on site` : ''}{r.coreExtracted ? ' · CORE EXTRACTED' : ''}</div>
          </div>
        </div>
        <div class="m-results">
          <div>
            <div class="m-sheet accent">
              <div class="m-h3">Scrip ledger</div>
              <table class="m-ledger"><tbody>
                <tr><td>Balance before</td><td>{r.balanceBefore}</td></tr>
                <tr><td>Salvage hauled{r.coreExtracted ? ' (incl. the Core)' : ''}</td><td class="m-green">+{r.hauled}</td></tr>
                {r.requests.map((q) => <tr key={q.kind}><td>{q.done ? '✓' : '✗'} {q.text}</td><td class={q.done ? 'm-green' : 'm-dim'}>{q.done ? `+${q.reward}` : '0'}</td></tr>)}
                {r.fines.map((f) => <tr key={f.player}><td class="m-red">Badge not recovered: {f.name} (10% fine)</td><td class="m-red">−{f.amount}</td></tr>)}
                <tr class="total"><td>Spendable scrip</td><td class="m-amber">{r.balanceAfter}</td></tr>
              </tbody></table>
              <div style={{ marginTop: '14px' }}>
                <div class="m-row" style={{ justifyContent: 'space-between' }}><span class="m-label" style={{ margin: 0 }}>SHIFT QUOTA</span><span class="m-small"><b>{r.shiftHauled}</b> / {r.quota}{r.shiftHauled >= r.quota ? <span class="m-green"> · MET</span> : <span class="m-dim"> · {r.quota - r.shiftHauled} to go</span>}</span></div>
                <div class="m-quota-bar" style={{ height: '8px' }}><i style={{ width: `${pct}%`, background: r.shiftHauled >= r.quota ? 'var(--m-green)' : 'var(--m-amber)' }} /></div>
                {fines > 0 && <div class="m-small m-dim">Fines come out of spendable scrip only, never the quota.</div>}
              </div>
            </div>
            <div class="m-sheet" style={{ marginTop: '16px' }}>
              <div class="m-h3" style={{ color: r.deaths.length ? 'var(--m-red)' : 'var(--m-green)' }}>{r.deaths.length ? 'Death cards' : 'No casualties'}</div>
              {r.deaths.length === 0 && <div class="m-small m-dim">Everyone made it back to the van. HR is suspicious.</div>}
              {r.deaths.map((d) => (
                <div class="m-deathcard" key={d.player}>
                  <div class="k">{d.killer}</div>
                  <div>
                    <div class="n">{d.name}</div>
                    <div class="r">{d.killer} {d.reason}</div>
                    {d.detail && <div class="m-small m-dim" style={{ marginTop: '4px' }}>{d.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div class="m-sheet accent">
              <div class="m-h3">Career</div>
              {r.xp.map((x) => {
                const lv = (ctx.balance.core.xpLevels as number[] | undefined) ?? [0, 150, 400, 750, 1200, 1800, 2600];
                const lo = lv[x.level - 1] ?? 0;
                const hi = lv[x.level] ?? lo + 1;
                const k = Math.min(1, (x.xp - lo) / Math.max(1, hi - lo));
                return (
                  <div class="m-xp" key={x.player}>
                    <span><b>{x.name}</b> <span class="m-dim">LVL {x.level}</span>{x.levelUp && <span class="m-chip green" style={{ marginLeft: '8px' }}>LEVEL UP</span>}</span>
                    <span class="m-amber">+{x.gained} XP</span>
                    <span class="m-small m-dim" style={{ gridColumn: '1 / -1' }}>{x.reasons.map((q) => `${q.text} +${q.xp}`).join(' · ')}</span>
                    {x.unlocks.length > 0 && <span class="m-small" style={{ gridColumn: '1 / -1', color: 'var(--m-cyan)' }}>UNLOCKED: {x.unlocks.join(' · ')}</span>}
                    <div class="bar"><i style={{ width: `${k * 100}%` }} /></div>
                  </div>
                );
              })}
            </div>
            <div class="m-sheet" style={{ marginTop: '16px' }}>
              <div class="m-h3">It heard → it did</div>
              {r.heardDid.length === 0 && <div class="m-small m-dim">The Listener logged nothing it could use. Either you were careful, or it is saving it for later.</div>}
              {r.heardDid.map((h, i) => (
                <div class="m-heard" key={i}>{h.at ? <span class="m-dim">{h.at} </span> : null}heard <q>{h.heard}</q><span class="arrow">→</span>{h.did}</div>
              ))}
            </div>
          </div>
        </div>
        <div class="m-board-foot">
          <span class="m-small m-dim">{r.shiftEnd ? 'That was the last contract of the shift. Human Resources has prepared a memo.' : `Next: contract ${r.contract + 1} of ${r.contractsPerShift}. Visit the store before you pick.`}</span>
          {r.shiftEnd
            ? <button class="m-btn primary" onClick={() => openScreen(ctx, 'memo')}>READ THE HR MEMO</button>
            : <Continue ctx={ctx} label="BACK TO THE VAN" />}
        </div>
      </div>
    </div>
  );
}

function useTypewriter(text: string, cps = 140): string {
  const [t0] = useState(() => performance.now());
  useTicker(40);
  const n = Math.floor(((performance.now() - t0) / 1000) * cps);
  return text.slice(0, n);
}

function memoText(rv: MetaShiftReview): string {
  const parts: string[] = [rv.comments];
  for (const m of rv.memos) parts.push(`§${m.title}\n${m.rating}\n${m.body}`);
  if (rv.employeeComments?.length) parts.push(`§Anonymous employee comments\n\n${rv.employeeComments.map((c) => `· ${c}`).join('\n')}`);
  if (rv.letter) parts.push(`§NOTICE OF TERMINATION\n\n${rv.letter}`);
  return parts.join('\n\n');
}

export function MemoScreen({ ctx }: ScreenProps) {
  useWorldV(ctx);
  const rv = metaOf(ctx)?.review ?? null;
  const full = rv ? memoText(rv) : '';
  const typed = useTypewriter(full);
  const [skip, setSkip] = useState(false);
  const text = skip ? full : typed;
  useEffect(() => { sfx(ctx, 'sfx.ui_confirm'); }, [ctx]);
  if (!rv) {
    return <div class="m-screen m-solid"><div class="m-wrap narrow"><div class="m-kicker">HUMAN RESOURCES</div><h1 class="m-h1">No memo on file</h1><div style={{ marginTop: '18px' }}><Continue ctx={ctx} label="BACK TO THE VAN" /></div></div></div>;
  }
  // render: '§' starts a section heading line; second line of a memo section is the rating
  const blocks = text.split('\n\n');
  return (
    <div class="m-screen m-solid" onClick={() => setSkip(true)}>
      <div class="m-wrap narrow" style={{ paddingTop: '40px' }}>
        <div class="m-paper">
          <div class="m-letterhead">
            <div class="co">THE COMPANY<small>HUMAN RESOURCES · NIGHT DIVISION</small></div>
            <div class="ref">RE: COMPANY PERFORMANCE REVIEW<br />SHIFT {rv.shiftIndex + 1} · CREW {ctx.world.crew?.code ?? ''}<br />QUOTA {rv.quota} · HAULED {rv.hauled}{rv.overtime ? ` · OVERTIME +${rv.overtime}` : ''}</div>
          </div>
          <div class={`stamp ${rv.verdict}`}>{rv.verdict === 'promoted' ? 'PROMOTED' : 'TERMINATED'}</div>
          {blocks.map((b, i) => {
            if (b.startsWith('§')) {
              const lines = b.slice(1).split('\n');
              const isMemo = rv.memos.some((m) => m.title === lines[0]);
              return (
                <div key={i}>
                  <h3>{lines[0]}</h3>
                  {isMemo && lines[1] !== undefined ? <><span class="rating">{lines[1]}</span><p>{lines.slice(2).join('\n')}</p></> : <p>{lines.slice(1).join('\n')}</p>}
                </div>
              );
            }
            return <p key={i}>{b}</p>;
          })}
          {text.length < full.length ? <span class="m-caret" /> : <div class="sig">— Human Resources (Night Division){rv.source === 'ai' ? <span class="m-ai"> · DRAFTED WITH AI</span> : null}</div>}
        </div>
        <div class="m-board-foot static">
          <span class="m-small m-dim">{rv.verdict === 'promoted' ? `Next shift quota: ${rv.nextQuota ?? '?'} scrip. Levels and cosmetics are yours to keep.` : 'The run resets. Your levels and cosmetics stay.'} {text.length < full.length ? '(click to skip)' : ''}</span>
          <div class="m-row">
            <button class="m-btn" onClick={(e) => { e.stopPropagation(); openScreen(ctx, 'results'); }}>RESULTS</button>
            <Continue ctx={ctx} label={rv.verdict === 'promoted' ? 'NEXT SHIFT' : 'REAPPLY'} />
          </div>
        </div>
      </div>
    </div>
  );
}
