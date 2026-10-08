// Owner: fieldguide (v1.2) client. The 'fieldguide' screen (Company form FG-1, a ring-bound booklet with one index tab per
// monster plus ANOMALIES) and the 'fieldguide-bulletin' reader. Every word of page text arrives from the server in the
// private view; this file only lays it out (plus UI chrome: labels, stamps, captions).
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import type { ClientContext } from '../core/context.ts';
import type { MonsterKind } from '@dead-air/shared/state.ts';
import type { FieldGuideMonsterView, FieldGuidePage, FieldGuideView } from '@dead-air/shared/messages/fieldguide.ts';
import { sketchSvg } from './sketches.ts';
import { MONSTER_NAMES, TABS, fgTab, fgView, isTab } from './store.ts';
import type { FgTab } from './store.ts';

interface PlayersLike { freeze?(reason: string, on: boolean): void }
interface SfxLike { play(id: string, pos?: unknown, opts?: { ui?: boolean; volume?: number; rate?: number }): unknown }

export function uiSfx(ctx: ClientContext, key: string, volume = 0.5, rate = 1): void {
  try { (ctx.services.use('sfx') as SfxLike | undefined)?.play(key, undefined, { ui: true, volume, rate }); } catch { /* audio not ready */ }
}

/** freeze movement, release the mouse and hide the HUD while a full-screen sheet is open */
function useSheet(ctx: ClientContext, reason: string): void {
  useEffect(() => {
    const players = ctx.services.use('players' as never) as PlayersLike | undefined;
    try { document.exitPointerLock?.(); } catch { /* ignore */ }
    try { players?.freeze?.(reason, true); } catch { /* optional */ }
    const hud = ctx.ui.hudVisible.value;
    ctx.ui.hudVisible.value = false;
    return () => {
      try { players?.freeze?.(reason, false); } catch { /* optional */ }
      ctx.ui.hudVisible.value = hud || ctx.ui.screen.value.name === 'none';
    };
  }, [ctx, reason]);
}

const TAB_LABEL: Readonly<Record<FgTab, string>> = { hound: 'HOUND', listener: 'LISTENER', mannequin: 'MANNEQUIN', snatcher: 'SNATCHER', anomalies: 'ANOMALIES' };
const HOW: Readonly<Record<string, string>> = { heard: 'HEARD IT', seen: 'SAW IT', grabbed: 'IT GRABBED YOU', killed: 'IT KILLED YOU' };

const monsterOf = (v: FieldGuideView | null, k: MonsterKind): FieldGuideMonsterView | null => v?.monsters.find((m) => m.kind === k) ?? null;
const pageNo = (p: FieldGuidePage): number => Number(p.id.split('.')[1]) || 0;

function firstOpenTab(v: FieldGuideView | null): FgTab {
  const known = v?.monsters.find((m) => m.level > 0 || m.pages.length > 0);
  return known?.kind ?? 'hound';
}

/** page text paragraphs; '✎ ' paragraphs are a previous crew's pencil note */
function Paras({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').filter((t) => t.trim()).map((t, i) => (t.startsWith('✎')
        ? <p key={i} class="fg-pencil">{t.replace(/^✎\s*/, '')}</p>
        : <p key={i}>{t}</p>))}
    </>
  );
}

function Note({ p, n }: { p: FieldGuidePage; n: number }) {
  return (
    <article class="fg-note" data-page={p.id} style={{ transform: `rotate(${((n * 37) % 7) / 10 - 0.3}deg)` }}>
      <header><span class="fg-note-n">P.{n}</span><h4>{p.title}</h4></header>
      <Paras text={p.text} />
    </article>
  );
}

function Torn({ n }: { n: number }) {
  return (
    <div class="fg-torn" data-torn={n}>
      <span class="fg-torn-edge" />
      <span>PAGE {n}</span>
      <em>page torn out</em>
    </div>
  );
}

function CardLines({ lines }: { lines: string[] }) {
  return (
    <div class="fg-card">
      {lines.map((l, i) => {
        const m = /^([A-Z][A-Z ]+):\s*(.*)$/.exec(l);
        return m
          ? <div key={i} class="fg-card-row"><span class="fg-card-k">{m[1]}</span><span class="fg-card-v">{m[2]}</span></div>
          : <div key={i} class="fg-card-row"><span class="fg-card-v">{l}</span></div>;
      })}
    </div>
  );
}

function Redacted({ heard }: { heard: boolean }) {
  return (
    <div class="fg-card fg-redacted">
      {['CLASSIFICATION', 'RULE', 'COUNTERPLAY'].map((k, i) => (
        <div key={k} class="fg-card-row">
          <span class="fg-card-k">{k}</span>
          <span class="fg-card-v"><i style={{ width: `${88 - i * 9}%` }} /><i style={{ width: `${64 + i * 11}%` }} /></span>
        </div>
      ))}
      <div class="fg-stamp fg-stamp-sm">{heard ? 'CLASSIFIED · NO VISUAL CONFIRMATION' : 'CLASSIFIED · NO CONTACT'}</div>
    </div>
  );
}

function MonsterSpread({ m, idx, me }: { m: FieldGuideMonsterView; idx: number; me: string }) {
  const svg = useMemo(() => (m.level === 2 ? sketchSvg(m.kind, 'sketch') : m.level === 1 ? sketchSvg(m.kind, 'silhouette') : ''), [m.kind, m.level]);
  const byN = new Map(m.pages.map((p) => [pageNo(p), p]));
  const caption = m.level === 2 ? `fig. ${idx + 1}: ${m.name}, from crew sketches` : m.level === 1 ? 'heard, not seen. Shape estimated.' : 'no contact on file';
  return (
    <>
      <section class="fg-page fg-left">
        <div class="fg-formline"><span>COMPANY FORM FG-1</span><span>SECTION {idx + 1} OF 4</span></div>
        <h2 class={`fg-name ${m.level === 0 && !m.pages.length ? 'unknown' : ''}`}>{m.level === 0 && !m.pages.length ? '???' : m.name}</h2>
        <div class={`fg-photo lvl${m.level}`}>
          {svg ? <div class="fg-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <div class="fg-blank"><span class="fg-stamp">NO CONTACT ON FILE</span></div>}
          <span class="fg-tape a" /><span class="fg-tape b" />
        </div>
        <div class="fg-caption">{caption}</div>
        {m.level >= 1 && m.first && (
          <div class="fg-contact" data-first={m.first.at}>
            <div class="fg-k">FIRST CONTACT</div>
            <div class="fg-v">{m.first.at} · {m.first.site}</div>
            <div class="fg-how">{HOW[m.first.how] ?? m.first.how.toUpperCase()}</div>
          </div>
        )}
        {m.level >= 1 && (
          <table class="fg-counts">
            <tbody>
              <tr><th>HEARD</th><th>SEEN</th><th>DEATHS</th><th>ESCAPES</th></tr>
              <tr><td>{m.heard}</td><td>{m.seen}</td><td class={m.deaths ? 'bad' : ''}>{m.deaths}</td><td>{m.escapes}</td></tr>
            </tbody>
          </table>
        )}
        {m.level === 1 && (m.sounds?.length ?? 0) > 0 && (
          <div class="fg-sounds">
            <div class="fg-k">SOUNDS REPORTED</div>
            {m.sounds!.map((s, i) => <div key={i} class="fg-pencil">{s}</div>)}
          </div>
        )}
        {m.level === 0 && <div class="fg-hint">File a sighting to unlock this section. Hazard bulletins on site and field notes in desk drawers fill in the rest.</div>}
        <div class="fg-issued">ISSUED TO: {me || 'EMPLOYEE'}</div>
      </section>
      <section class="fg-page fg-right">
        {m.level === 2 && m.card.length ? <CardLines lines={m.card} /> : <Redacted heard={m.level === 1} />}
        <div class="fg-notes-h"><span>FIELD NOTES</span><span class="fg-count">{m.pages.length} / {m.pagesTotal}</span></div>
        <div class="fg-notes">
          {Array.from({ length: m.pagesTotal }, (_, i) => {
            const p = byN.get(i + 1);
            return p ? <Note key={p.id} p={p} n={i + 1} /> : <Torn key={`t${i}`} n={i + 1} />;
          })}
        </div>
      </section>
    </>
  );
}

function AnomalySpread({ v, me }: { v: FieldGuideView; me: string }) {
  const total = v.anomalyKinds ?? 16;
  return (
    <>
      <section class="fg-page fg-left">
        <div class="fg-formline"><span>COMPANY FORM FG-1</span><span>APPENDIX A</span></div>
        <h2 class="fg-name">ANOMALIES</h2>
        <div class="fg-photo lvl2">
          <div class="fg-svg" dangerouslySetInnerHTML={{ __html: BULB_SVG }} />
          <span class="fg-tape a" /><span class="fg-tape b" />
        </div>
        <div class="fg-caption">fig. A: site event, unexplained</div>
        <div class="fg-hint">Things you saw on site that were not a monster. The Company does not believe in ghosts and does not pay hazard rates for them.</div>
        <div class="fg-issued">ISSUED TO: {me || 'EMPLOYEE'}</div>
      </section>
      <section class="fg-page fg-right">
        <div class="fg-notes-h"><span>WITNESSED</span><span class="fg-count">{v.anomalies.length} / {total} KINDS</span></div>
        {v.anomalies.length === 0 && <div class="fg-empty">Nothing logged yet. Keep your eyes open. Not too open.</div>}
        <ul class="fg-anoms">
          {v.anomalies.map((a) => (
            <li key={a.kind} data-anomaly={a.kind}><span class="lbl">{a.label}</span><span class="dots" /><span class="cnt">x{a.count}</span></li>
          ))}
          {Array.from({ length: Math.max(0, Math.min(5, total - v.anomalies.length)) }, (_, i) => (
            <li key={`u${i}`} class="unk"><span class="lbl">? ? ?</span><span class="dots" /><span class="cnt">-</span></li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** a flickering bulb doodle for the ANOMALIES tab */
const BULB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 300"><defs><filter id="fgb-r"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="5"/><feDisplacementMap in="SourceGraphic" scale="2.2" xChannelSelector="R" yChannelSelector="G"/></filter><pattern id="fgb-h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(38)"><line x1="0" y1="0" x2="0" y2="5" stroke="#2b2924" stroke-width="1.1" stroke-opacity="0.5"/></pattern></defs>`
  + `<g filter="url(#fgb-r)" fill="none" stroke="#26241f" stroke-linecap="round" stroke-linejoin="round">`
  + `<path d="M160 20 L160 70" stroke-width="1.4"/><path d="M146 70 h28 v18 h-28 z" stroke-width="1.6"/><path d="M148 88 C120 104 112 140 128 166 C138 182 144 192 146 206 L174 206 C176 192 182 182 192 166 C208 140 200 104 172 88" stroke-width="1.8"/>`
  + `<path d="M150 206 h20 M152 214 h16 M155 222 h10" stroke-width="1.3"/><path d="M152 150 l4 -14 l4 14 l4 -14 l4 14" stroke-width="1.1" opacity="0.8"/>`
  + `<path d="M126 118 C118 134 122 156 132 168 C126 150 124 134 128 118 Z" fill="url(#fgb-h)" stroke="none"/>`
  + `<path d="M60 286 C120 282 200 284 262 282" stroke-width="0.9" opacity="0.6"/></g>`
  + `<g filter="url(#fgb-r)" fill="none" stroke="#b3271d" stroke-width="1.1" stroke-linecap="round"><path d="M100 120 l-22 -8 M98 150 l-24 2 M104 178 l-20 12 M220 120 l22 -8 M222 150 l24 2 M216 178 l20 12"/><path d="M200 236 C230 246 248 262 254 278"/></g>`
  + `<text x="176" y="270" font-family="'Caveat', 'Segoe Print', cursive" font-size="17" fill="#b3271d" fill-opacity="0.9" transform="rotate(-4 176 270)">nobody touched it</text></svg>`;

export function BookletScreen(props: ScreenProps) {
  const ctx = props.ctx;
  useSheet(ctx, 'fieldguide');
  const v = fgView.value;
  const [tab, setTab] = useState<FgTab>(() => (isTab(props.tab) ? props.tab : isTab(fgTab.value) && fgTab.value !== 'hound' ? fgTab.value : firstOpenTab(v)));

  useEffect(() => { fgTab.value = tab; }, [tab]);
  useEffect(() => { if (isTab(props.tab)) setTab(props.tab); }, [props.tab]);
  useEffect(() => {
    uiSfx(ctx, 'sfx.ui_open', 0.35, 0.8);
    void ctx.net.req('fieldguide.get', {}).then((r) => { fgView.value = r; }, () => undefined);
    const turn = (d: number) => setTab((t) => {
      const i = TABS.indexOf(t);
      const n = TABS[(i + d + TABS.length) % TABS.length]!;
      uiSfx(ctx, 'sfx.ui_click', 0.25, 0.7);
      return n;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') ctx.ui.setScreen('none');
      else if (e.code === 'ArrowRight' || e.code === 'KeyD' || e.code === 'Tab') turn(e.shiftKey && e.code === 'Tab' ? -1 : 1);
      else if (e.code === 'ArrowLeft' || e.code === 'KeyA') turn(-1);
      else if (/^Digit[1-5]$/.test(e.code)) setTab(TABS[Number(e.code.slice(5)) - 1]!);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      uiSfx(ctx, 'sfx.ui_close', 0.3, 0.8);
    };
  }, [ctx]);

  const me = ctx.world.crew?.players.find((p) => p.id === ctx.world.me)?.name ?? '';
  const m = tab === 'anomalies' ? null : monsterOf(v, tab);
  return (
    <div class="fg-screen fg-book-screen" data-testid="fieldguide" data-tab={tab}>
      <div class="fg-book">
        <div class="fg-cover-edge" />
        {!v && <section class="fg-page fg-left"><div class="fg-empty">Fetching your file...</div></section>}
        {v && m && <MonsterSpread m={m} idx={TABS.indexOf(tab)} me={me} />}
        {v && tab === 'anomalies' && <AnomalySpread v={v} me={me} />}
        {v && !m && tab !== 'anomalies' && <section class="fg-page fg-left"><div class="fg-empty">Section missing.</div></section>}
        <div class="fg-rings">{Array.from({ length: 9 }, (_, i) => <span key={i} />)}</div>
        <nav class="fg-tabs">
          {TABS.map((t) => {
            const mv = t === 'anomalies' ? null : monsterOf(v, t);
            const known = t === 'anomalies' || (mv && (mv.level > 0 || mv.pages.length > 0));
            // vertical position comes from the t-<tab> class (fieldguide.css: tighter spacing on short screens)
            return (
              <button key={t} type="button" class={`fg-tab t-${t} ${tab === t ? 'on' : ''} ${known ? '' : 'unknown'}`}
                onClick={() => { uiSfx(ctx, 'sfx.ui_click', 0.25, 0.7); setTab(t); }} data-tab={t}>
                <span>{known ? TAB_LABEL[t] : '???'}</span>
                {mv && mv.pagesTotal > 0 && <small>{mv.pages.length}/{mv.pagesTotal}</small>}
              </button>
            );
          })}
        </nav>
      </div>
      <div class="fg-footer">
        <span>FIELD GUIDE · {v ? `${v.pagesFound} / ${v.pagesTotal} PAGES FILED` : '...'}</span>
        <span><kbd>A</kbd><kbd>D</kbd> or <kbd>←</kbd><kbd>→</kbd> turn · <kbd>J</kbd> / <kbd>Esc</kbd> close</span>
      </div>
    </div>
  );
}

/** 'fieldguide-bulletin': the hazard bulletin you just read (props = the 'fieldguide.read' payload) */
export function BulletinScreen(props: ScreenProps) {
  const ctx = props.ctx;
  useSheet(ctx, 'fieldguide-bulletin');
  const monster = (typeof props.monster === 'string' ? props.monster : 'hound') as MonsterKind;
  const name = typeof props.name === 'string' ? props.name : MONSTER_NAMES[monster];
  const title = String(props.title ?? '');
  const text = String(props.text ?? '');
  const filed = props.filed === true;
  const n = Number(props.n) || 0, of = Number(props.of) || 0;
  useEffect(() => {
    uiSfx(ctx, filed ? 'sfx.ui_confirm' : 'sfx.ui_open', 0.4, 0.85);
    const opened = performance.now();
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'Escape' || ((e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') && performance.now() - opened > 300)) {
        ctx.ui.setScreen('none');
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctx, filed]);
  return (
    <div class="fg-screen fg-bulletin-screen" data-testid="fieldguide-bulletin" data-page={String(props.pageId ?? '')}>
      <div class="fg-bulletin">
        <div class="fg-hazard" />
        <div class="fg-bul-head">
          <span>HAZARD BULLETIN</span>
          <span>COMPANY FORM FG-1</span>
        </div>
        <div class="fg-bul-monster">{name}</div>
        <h3 class="fg-bul-title">{title}</h3>
        <div class="fg-bul-text"><Paras text={text} /></div>
        <div class={`fg-bul-foot ${filed ? 'filed' : ''}`}>
          {filed
            ? <span class="fg-stamp fg-stamp-ok">FILED · {name} {n}/{of}</span>
            : <span class="fg-stamp fg-stamp-dim">ALREADY IN YOUR FIELD GUIDE</span>}
          <span class="fg-bul-keys"><kbd>E</kbd> / <kbd>Esc</kbd> done · <kbd>J</kbd> field guide</span>
        </div>
      </div>
    </div>
  );
}
