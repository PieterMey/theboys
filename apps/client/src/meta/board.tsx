// Owner: track (d) Meta. Work-order board (pick + hold-to-drive) and the Company store.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import { GEAR_PACKS, ITEM_DEFS } from '@dead-air/shared/interactables.ts';
import { THEMES, isSiteTheme } from '@dead-air/shared/procgen/themes.ts';
import { isLeader, mePub, metaOf, ordersOf, sfx, useWorldV } from './state.ts';

/** v1.2: the site's theme label (THEMES), shown as a chip on the order card */
function themeLabel(o: WorkOrder): string | null {
  const t = o.siteTheme;
  return t && isSiteTheme(t) ? THEMES[t].label : null;
}
import { closeScreen } from './nav.ts';

function Risk({ n }: { n: number }) {
  return (
    <span class="risk">
      RISK {[1, 2, 3].map((i) => <i key={i} class={i <= n ? 'on' : ''} />)}
    </span>
  );
}

function OrderCard({ o, picked, onPick, canPick, onDenied, themes = true }: { o: WorkOrder; picked: boolean; onPick: () => void; canPick: boolean; onDenied?: () => void; themes?: boolean }) {
  const req = o.requirements;
  return (
    <div class={`m-sheet m-order ${picked ? 'picked' : ''} ${o.available ? '' : 'locked'} ${o.risk >= 2 ? 'danger' : 'accent'}`} onClick={() => { if (o.available && canPick) onPick(); else if (o.available) onDenied?.(); }}>
      {picked && <div class="m-stamp">PICKED</div>}
      <div class="m-row" style={{ justifyContent: 'space-between' }}>
        <Risk n={o.risk} />
        <span>
          {themes && themeLabel(o) && <span class="m-chip theme" data-testid="order-theme">{themeLabel(o)}</span>}
          <span class="m-chip">SITE {o.size}</span>
        </span>
      </div>
      <div class="site">{o.siteName}</div>
      <div>{o.modifiers.map((m) => <span key={m} class={`m-chip ${/MANNEQUIN|LISTENER|HOUND|DARK/.test(m) ? 'red' : ''}`}>{m}</span>)}</div>
      <div class="hist">{o.history}</div>
      <div class="memo">{o.memo}</div>
      <div>
        <div class="m-label" style={{ marginBottom: '6px' }}>COMPANY REQUESTS</div>
        <ul class="reqs" style={{ margin: 0, padding: 0 }}>
          {o.requests.map((r) => <li key={r.kind}>{r.text} <b>+{r.reward}</b></li>)}
        </ul>
      </div>
      <div class="pay">
        <div>
          <div class="m-label" style={{ marginBottom: '4px' }}>PAYOUT</div>
          <div class="m-num m-amber">×{o.payoutMult.toFixed(1)}</div>
        </div>
        <div style={{ textAlign: 'right' }} class="m-small m-dim">
          {o.notes.length} CLUE NOTES ON SITE<br />
          {req.minAvgLevel ? `NEEDS CREW AVG LVL ${req.minAvgLevel}` : 'NO REQUIREMENTS'}
          {req.achievement ? <><br />OR "{req.achievement.toUpperCase()}"</> : null}
          {o.source === 'ai' && <><br /><span style={{ color: '#6b8f9a' }}>BRIEF: AI-WRITTEN</span></>}
        </div>
      </div>
      {!o.available && (
        <div class="m-lock">
          LOCKED
          <small>CREW AVG LEVEL {req.minAvgLevel ?? 2} OR EXTRACT A CORE ("{(req.achievement ?? 'Core Business').toUpperCase()}")</small>
        </div>
      )}
    </div>
  );
}

function HoldDrive({ ctx, orderId, disabled }: ScreenProps & { orderId: string | null; disabled: boolean }) {
  const [p, setP] = useState(0);
  const raf = useRef(0);
  const start = useRef(0);
  const stop = (send = true) => {
    cancelAnimationFrame(raf.current);
    start.current = 0;
    setP(0);
    if (send) void ctx.net.req('meta.hold', { holding: false }).catch(() => {});
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const down = () => {
    if (disabled) return;
    start.current = performance.now();
    void ctx.net.req('meta.hold', { holding: true }).catch(() => {});
    const step = () => {
      const k = Math.min(1, (performance.now() - start.current) / 3000);
      setP(k);
      if (k >= 1) {
        stop(false);
        sfx(ctx, 'sfx.van_horn');
        void ctx.net.req('meta.drive', { orderId: orderId ?? undefined }).then((r) => { if (!r.ok && r.reason) ctx.ui.toast(r.reason, 'warn'); });
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  return (
    <button
      class="m-btn primary m-hold"
      disabled={disabled}
      onPointerDown={down}
      onPointerUp={() => start.current && stop()}
      onPointerLeave={() => start.current && stop()}
    >
      <i style={{ width: `${p * 100}%` }} />
      {p > 0 ? `DRIVING IN ${(3 - p * 3).toFixed(1)} s` : 'HOLD TO DRIVE NOW'}
    </button>
  );
}

export function BoardScreen({ ctx }: ScreenProps) {
  useWorldV(ctx);
  const meta = metaOf(ctx);
  const orders = ordersOf(ctx);
  const me = mePub(ctx);
  const leader = isLeader(ctx);
  const crew = ctx.world.crew?.players.filter((p) => p.connected) ?? [];
  const ready = crew.filter((p) => p.ready).length;
  const lead = crew.find((p) => p.isLeader);
  const denied = () => ctx.ui.toast(`Only the crew leader${lead ? ` (★ ${lead.name})` : ''} picks. Tell them which one.`, 'info', 3500);
  const pick = (o: WorkOrder) => {
    sfx(ctx, 'sfx.ui_confirm');
    void ctx.net.req('meta.pick', { orderId: o.id }).then((r) => { if (!r.ok && r.reason) ctx.ui.toast(r.reason, 'warn'); });
  };
  return (
    <div class="m-screen">
      <button class="m-close" onClick={() => closeScreen(ctx)}>CLOSE [ESC]</button>
      <div class="m-wrap">
        <div class="m-top">
          <div>
            <div class="m-kicker">VAN 9 · WORK ORDER BOARD · SHIFT {(meta?.shift.index ?? 0) + 1} · CONTRACT {Math.min((meta?.shift.contract ?? 0) + 1, meta?.shift.contractsPerShift ?? 3)}/{meta?.shift.contractsPerShift ?? 3}</div>
            <h1 class="m-h1">Tonight's contracts</h1>
          </div>
          <dl class="m-kv" style={{ textAlign: 'right' }}>
            <dt>QUOTA</dt><dd><b>{meta?.shift.hauled ?? 0}</b> / {meta?.shift.quota ?? 0}</dd>
            <dt>SCRIP</dt><dd class="m-amber"><b>{meta?.shift.balance ?? 0}</b></dd>
            <dt>CREW AVG LVL</dt><dd>{meta?.avgLevel ?? 1}</dd>
          </dl>
        </div>
        <div class="m-orders">
          {orders.map((o) => <OrderCard key={o.id} o={o} picked={meta?.picked === o.id} canPick={leader} onPick={() => pick(o)} onDenied={denied} themes={ctx.flags.siteThemes !== false} />)}
        </div>
        <div class="m-board-foot">
          <div class="m-small" style={{ lineHeight: 1.7 }}>
            {leader
              ? <>You are the crew leader: <span class="m-amber">click a contract to pick it</span>. The van leaves when everyone is READY ({ready}/{crew.length}), or hold DRIVE for 3 s.</>
              : <>The crew leader picks the contract. Press <span class="m-keys">R</span> or the button to ready up ({ready}/{crew.length} ready).</>}
          </div>
          <div class="m-row">
            <button class={`m-btn ${me?.ready ? 'go' : ''}`} onClick={() => void ctx.net.req('meta.ready', { ready: !me?.ready })}>{me?.ready ? 'READY ✓' : 'READY UP'}</button>
            {leader && <HoldDrive ctx={ctx} orderId={meta?.picked ?? null} disabled={!meta?.picked} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- store

const ICONS: Record<string, preact.JSX.Element> = {
  walkie: (
    <svg width="64" height="64" viewBox="0 0 64 64"><rect x="22" y="14" width="22" height="42" rx="3" fill="#1d2326" stroke="#f0b43c" stroke-width="2" /><rect x="38" y="3" width="4" height="13" fill="#f0b43c" /><rect x="26" y="20" width="14" height="10" fill="#0b0f10" stroke="#5f8f65" /><circle cx="33" cy="42" r="6" fill="none" stroke="#7c7f7a" stroke-width="2" /><circle cx="27" cy="18" r="1.6" fill="#ff4d4d" /></svg>
  ),
  crowbar: (
    <svg width="64" height="64" viewBox="0 0 64 64"><path d="M14 52 L46 14 Q50 9 55 13" fill="none" stroke="#c0392b" stroke-width="5" stroke-linecap="round" /><path d="M14 52 L9 49" stroke="#c0392b" stroke-width="5" stroke-linecap="round" /></svg>
  ),
  bottles: (
    <svg width="64" height="64" viewBox="0 0 64 64">{[12, 28, 44].map((x, i) => <g key={x}><rect x={x} y={26 - i * 2} width="10" height={30 + i * 2} rx="3" fill="#27ae60" opacity="0.65" stroke="#9dff6b" stroke-width="1" /><rect x={x + 3} y={14 - i * 2} width="4" height="13" fill="#27ae60" opacity="0.8" /></g>)}</svg>
  ),
  glowsticks: (
    <svg width="64" height="64" viewBox="0 0 64 64">{[0, 1, 2, 3, 4].map((i) => <rect key={i} x={10 + i * 9} y={14 + (i % 2) * 6} width="5" height="34" rx="2.5" fill={['#9dff6b', '#7dfcff', '#ff7df3', '#ffd84d', '#9dff6b'][i]} style={{ filter: 'drop-shadow(0 0 4px currentColor)' }} />)}</svg>
  ),
  medkit: (
    <svg width="64" height="64" viewBox="0 0 64 64"><rect x="10" y="18" width="44" height="32" rx="3" fill="#ecf0f1" /><rect x="24" y="12" width="16" height="8" fill="none" stroke="#ecf0f1" stroke-width="3" /><rect x="28" y="24" width="8" height="20" fill="#c0392b" /><rect x="22" y="30" width="20" height="8" fill="#c0392b" /></svg>
  ),
  // v1.1 gear pack (shop ids from config/balance/meta.json)
  proflashlight: (
    <svg width="64" height="64" viewBox="0 0 64 64"><path d="M31 25 L61 11 L61 53 L31 39 Z" fill="#bfe3ff" opacity="0.2" /><rect x="5" y="26" width="19" height="12" rx="2" fill="#1d2326" stroke="#bfe3ff" stroke-width="2" /><path d="M24 23 L32 21 L32 43 L24 41 Z" fill="#2a3236" stroke="#bfe3ff" stroke-width="2" /><circle cx="14" cy="32" r="2" fill="#7dfcff" /><text x="7" y="21" font-size="9" fill="#bfe3ff" font-family="monospace">II</text></svg>
  ),
  flares: (
    <svg width="64" height="64" viewBox="0 0 64 64">{[0, 1, 2].map((i) => <g key={i} transform={`rotate(${-20 + i * 20} 32 54)`}><rect x="28" y="20" width="8" height="32" rx="2" fill="#8e1f17" stroke="#ff3b2f" stroke-width="1.5" /><circle cx="32" cy="17" r="4" fill="#ffb199" style={{ filter: 'drop-shadow(0 0 5px #ff3b2f)' }} /></g>)}</svg>
  ),
  sensors: (
    <svg width="64" height="64" viewBox="0 0 64 64"><path d="M12 32 A20 20 0 0 1 52 32" fill="none" stroke="#62e0c4" stroke-width="2" opacity="0.45" /><path d="M20 35 A12 12 0 0 1 44 35" fill="none" stroke="#62e0c4" stroke-width="2" opacity="0.8" /><rect x="20" y="40" width="24" height="13" rx="4" fill="#1d2326" stroke="#62e0c4" stroke-width="2" /><circle cx="32" cy="46.5" r="3" fill="#62e0c4" style={{ filter: 'drop-shadow(0 0 4px #62e0c4)' }} /></svg>
  ),
};

const TYPE_NAME: Record<string, string> = { walkie: 'Walkie', crowbar: 'Crowbar', bottle: 'Bottle', glowstick: 'Glowstick', medkit: 'Medkit', flare: 'Flare' };

/** gear pool counts -> "Walkie ×1 · Flare ×3": shop packs ('flares' = 3 flares) shown as their real items */
function gearUnits(g: Record<string, number>): [string, number][] {
  const out: Record<string, number> = {};
  for (const [t, n] of Object.entries(g)) {
    if (!(n > 0)) continue;
    const pack = GEAR_PACKS[t];
    const real = pack?.type ?? t;
    out[real] = (out[real] ?? 0) + n * (pack?.count ?? 1);
  }
  return Object.entries(out);
}

export function ShopScreen({ ctx }: ScreenProps) {
  useWorldV(ctx);
  const meta = metaOf(ctx);
  const [busy, setBusy] = useState('');
  const balance = meta?.shift.balance ?? 0;
  const mine = meta?.gear?.[ctx.world.me ?? ''] ?? {};
  const company = meta?.gear?.crew ?? {};
  const buy = (id: string) => {
    setBusy(id);
    void ctx.net.req('meta.buy', { item: id }).then((r) => {
      if (r.ok) sfx(ctx, 'sfx.ui_confirm');
      else ctx.ui.toast(r.reason ?? 'purchase failed', 'warn');
    }).catch((e: unknown) => ctx.ui.toast(String(e), 'error')).finally(() => setBusy(''));
  };
  const gearList = (g: Record<string, number>) => gearUnits(g).map(([t, n]) => `${TYPE_NAME[t] ?? ITEM_DEFS[t]?.name ?? t} ×${n}`).join(' · ') || 'nothing yet';
  return (
    <div class="m-screen">
      <button class="m-close" onClick={() => closeScreen(ctx)}>CLOSE [ESC]</button>
      <div class="m-wrap">
        <div class="m-top">
          <div>
            <div class="m-kicker">COMPANY STORE · PRICES SET BY THE COMPANY · NO REFUNDS</div>
            <h1 class="m-h1">Equipment</h1>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div class="m-label">SPENDABLE SCRIP</div>
            <div class="m-num m-amber">{balance}</div>
            <div class="m-small m-dim">purchases never count against the quota</div>
          </div>
        </div>
        <div class="m-shop">
          {(meta?.shop ?? []).map((it) => (
            <div key={it.id} class="m-sheet accent m-item">
              <div class="icon">{ICONS[it.id] ?? null}</div>
              <div class="name">{it.name}</div>
              <div class="desc">{it.desc}</div>
              <div class="m-row" style={{ justifyContent: 'space-between' }}>
                <span class="price">{it.price}</span>
                <button class="m-btn small primary" disabled={busy === it.id || balance < it.price || ctx.world.phase !== 'hub'} onClick={() => buy(it.id)}>{balance < it.price ? 'TOO POOR' : 'BUY'}</button>
              </div>
            </div>
          ))}
        </div>
        <div class="m-sheet m-gear">
          <div class="m-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div class="m-label">YOUR GEAR</div>
              <div>{gearList(mine)}</div>
            </div>
            <div>
              <div class="m-label">COMPANY ISSUE (FREE, PER SHIFT)</div>
              <div>{gearList(company)}</div>
            </div>
            <div class="m-small m-dim" style={{ maxWidth: '360px', lineHeight: 1.6 }}>
              Gear is handed out when the van reaches the site. Survivors keep what they carry back to the van. The dead do not.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
