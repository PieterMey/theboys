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
  const left = d ? Math.max(0, d.endsAt - ctx.world.serverNow()) : 0;
  // the progress bar is a compositor (transform) animation over the time left when the screen opened, so it keeps
  // moving while the main thread is busy building the level
  const [span] = useState(() => (d ? Math.max(1000, d.endsAt - ctx.world.serverNow()) : 6000));
  const per = meta?.shift.contractsPerShift ?? 3;
  // v1.1: the site is built and warmed behind this screen (apps/client/src/loading); the van waits for slow loaders
  const dl = ctx.services.use('loading')?.drive.value ?? null;
  const myName = ctx.world.crew?.players.find((p) => p.id === ctx.world.me)?.name;
  const others = dl ? dl.waiting.filter((n) => n !== myName) : [];
  const holding = left <= 0 && others.length > 0;
  return (
    <div class="m-screen m-solid">
      <div class="m-road" />
      <div class="m-wrap m-drive">
        <div class="m-kicker">EN ROUTE · VAN 9 · CONTRACT {Math.min((meta?.shift.contract ?? 0) + 1, per)}/{per} · RISK {order?.risk ?? 1}</div>
        <h1 class="m-h1" style={{ fontSize: '78px', marginTop: '10px' }}>{d?.siteName ?? order?.siteName ?? 'Unknown site'}</h1>
        <div class="m-small m-dim" style={{ marginTop: '10px', maxWidth: '760px', lineHeight: 1.6 }}>{order?.memo}</div>
        <div class={`m-rules ${(d?.rules?.length ?? 0) >= 4 ? 'four' : ''}`}>
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
        <div class="m-progress"><i class="anim" style={{ animationDuration: `${span}ms` }} /></div>
        {dl && dl.state !== 'idle' && (
          <div class="ld-drive" data-testid="drive-preload" data-state={dl.state}>
            <span>SITE DATA</span>
            <span class="ld-drive-bar"><i style={{ transform: `scaleX(${(Math.min(100, dl.pct) / 100).toFixed(3)})` }} /></span>
            <span>{dl.label}</span>
            {others.length > 0 && <span>{holding ? 'HOLDING FOR' : 'STILL LOADING'} <b>{others.join(', ')}</b></span>}
          </div>
        )}
        <div class="m-row" style={{ justifyContent: 'space-between', marginTop: '8px' }}>
          <span class="m-small m-dim">ARRIVING {left > 0 ? `IN ${Math.ceil(left / 1000)} s` : holding ? '· THE VAN WAITS FOR THE CREW' : 'NOW'} · 22:00 · THE VAN LEAVES AT 04:00 · READ THE RULES</span>
          <span class="m-small m-dim">QUOTA {meta?.shift.hauled ?? 0}/{meta?.shift.quota ?? 0}</span>
        </div>
      </div>
    </div>
  );
}
