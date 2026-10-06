// Owner: track (d) Meta. Drive (loading) screen: site, three rule cards (one per monster), dispatch radio chatter.
import { useEffect, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import { activeOrderOf, metaOf, sfx, useTicker, useWorldV } from './state.ts';

export function DriveScreen({ ctx }: ScreenProps) {
  useWorldV(ctx);
  useTicker(60);
  const meta = metaOf(ctx);
  const d = meta?.drive ?? null;
  const order = activeOrderOf(ctx);
  const [t0] = useState(() => performance.now());
  useEffect(() => {
    sfx(ctx, 'sfx.radio_squelch_on');
    const h = setTimeout(() => sfx(ctx, 'sfx.radio_static_burst'), 2600);
    let engine: { stop(): void } | null = null;
    try {
      engine = (ctx.services.use('sfx') as unknown as { play(k: string, p?: unknown, o?: unknown): { stop(): void } | null } | undefined)
        ?.play('sfx.van_engine_idle_loop', undefined, { ui: true, loop: true, volume: 0.45 }) ?? null;
    } catch { engine = null; }
    return () => {
      clearTimeout(h);
      try { engine?.stop(); } catch { /* ignore */ }
    };
  }, [ctx]);
  const el = (performance.now() - t0) / 1000;
  const chatter = d?.chatter ?? [];
  // typewriter: ~38 chars/s through the chatter, one line after another
  const cps = 46;
  let budget = el * cps;
  const shown: string[] = [];
  for (const line of chatter) {
    if (budget <= 0) break;
    shown.push(line.slice(0, Math.floor(budget)));
    budget -= line.length + 10;
  }
  const visible = shown.slice(-4);
  const driveMs = Number((ctx.balance.meta as Record<string, unknown> | undefined)?.driveSec ?? 6) * 1000;
  const left = d ? Math.max(0, d.endsAt - ctx.world.serverNow()) : 0;
  const pct = d ? Math.min(100, Math.max(0, 100 - (left / driveMs) * 100)) : Math.min(100, el * 16);
  const per = meta?.shift.contractsPerShift ?? 3;
  return (
    <div class="m-screen m-solid">
      <div class="m-road" />
      <div class="m-wrap m-drive">
        <div class="m-kicker">EN ROUTE · VAN 9 · CONTRACT {Math.min((meta?.shift.contract ?? 0) + 1, per)}/{per} · RISK {order?.risk ?? 1}</div>
        <h1 class="m-h1" style={{ fontSize: '78px', marginTop: '10px' }}>{d?.siteName ?? order?.siteName ?? 'Unknown site'}</h1>
        <div class="m-small m-dim" style={{ marginTop: '10px', maxWidth: '760px', lineHeight: 1.6 }}>{order?.memo}</div>
        <div class="m-rules">
          {(d?.rules ?? []).map((r) => (
            <div key={r.monster} class={`m-sheet m-rule ${r.title.includes('NOT REPORTED') ? 'off' : 'danger'}`}>
              <div class="who">{r.monster.toUpperCase()}</div>
              <div class="title">{r.title}</div>
              <div class="rule">{r.rule}</div>
              <div class="hint">{r.hint}</div>
            </div>
          ))}
        </div>
        <div class="m-radio">
          {visible.map((l, i) => <p key={i} class={i === visible.length - 1 ? 'cur' : ''}>{l}</p>)}
        </div>
        <div class="m-progress"><i style={{ width: `${pct}%` }} /></div>
        <div class="m-row" style={{ justifyContent: 'space-between', marginTop: '8px' }}>
          <span class="m-small m-dim">ARRIVING {left > 0 ? `IN ${(left / 1000).toFixed(0)} s` : 'NOW'} · 22:00 · THE VAN LEAVES AT 04:00</span>
          <span class="m-small m-dim">QUOTA {meta?.shift.hauled ?? 0}/{meta?.shift.quota ?? 0}</span>
        </div>
      </div>
    </div>
  );
}
