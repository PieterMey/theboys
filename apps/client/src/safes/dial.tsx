// Owner: safes feature. The 'safe' screen: a combination dial. A/D or the mouse wheel turn it, E/Space sets the
// number, Esc steps away. The client streams its dial position (~10 Hz) and the server answers click / no-click only.
// The player is frozen while the dial is open (services.players.freeze('safe')): the Hound can still find you.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import type { ClientContext } from '../core/context.ts';

type AnyReq = (r: string, a: unknown, timeoutMs?: number) => Promise<unknown>;

/** test hook (?test=1 via window.__safes.log()): which dial sounds played, in order */
export const safeLog: string[] = [];

const bal = (ctx: ClientContext, k: string, d: number): number => {
  const v = (ctx.balance.safes as Record<string, unknown> | undefined)?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

export function SafeScreen(props: ScreenProps) {
  const ctx = props.ctx;
  const id = String(props.id ?? '');
  const n = Math.max(10, Number(props.n) || 40);
  const [pos, setPos] = useState(0);
  const [stage, setStage] = useState(Number(props.stage) || 0);
  const [msg, setMsg] = useState('Turn slowly. Listen for the click.');
  const [flash, setFlash] = useState<'' | 'ok' | 'bad' | 'open'>('');
  const st = useRef({ pos: 0, sent: 0, busy: false, done: false });

  useEffect(() => {
    const req = ctx.net.req as unknown as AnyReq;
    const sfx = (key: string, volume: number, rate = 1) => {
      try { ctx.services.use('sfx')?.play(key, undefined, { ui: true, volume, rate }); } catch { /* optional */ }
    };
    const players = ctx.services.use('players');
    players?.freeze('safe', true);
    const close = (tell: boolean) => {
      if (st.current.done) return;
      st.current.done = true;
      if (tell) void req('safes.close', { id }).catch(() => undefined);
      ctx.ui.setScreen('none');
    };
    const turn = (d: number) => {
      if (st.current.busy || st.current.done) return;
      st.current.pos = (((st.current.pos + d) % n) + n) % n;
      setPos(st.current.pos);
      sfx('sfx.ui_click', bal(ctx, 'tickVolume', 0.05), 1.7);
      if (ctx.testMode) safeLog.push('tick');
    };
    const confirm = async () => {
      if (st.current.busy || st.current.done) return;
      st.current.busy = true;
      try {
        const r = (await req('safes.confirm', { id, pos: st.current.pos })) as { ok: boolean; stage: number; open: boolean; closed?: boolean; value?: number; name?: string; gearName?: string };
        if (r.closed) { close(false); return; }
        setStage(r.stage);
        if (r.open) {
          setFlash('open');
          setMsg(`It swings open: ${r.name ?? 'loot'} (${r.value ?? '?'} scrip)${r.gearName ? ` and ${r.gearName}` : ''} in your hands.`);
          setTimeout(() => close(false), 1600);
          return;
        }
        if (r.ok) {
          setFlash('ok');
          sfx('sfx.keypad_accept', 0.25, 0.8);
          if (ctx.testMode) safeLog.push('ok');
          setMsg(`Number ${r.stage} holds. Now the next one.`);
        } else {
          setFlash('bad');
          setMsg('CLUNK. Wrong number: the tumblers reset. Something heard that.');
        }
        setTimeout(() => setFlash(''), 500);
      } catch {
        setMsg('No answer from the safe...');
      } finally {
        st.current.busy = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat && (e.code === 'KeyE' || e.code === 'Space')) return;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') turn(-1);
      else if (e.code === 'KeyD' || e.code === 'ArrowRight') turn(1);
      else if (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') void confirm();
      else if (e.code === 'Escape') close(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) turn(e.deltaY > 0 ? 1 : -1);
      e.preventDefault();
    };
    // ~10 Hz: send the dial position when it changed; the server answers click / no-click
    let timer = 0;
    const pump = async () => {
      if (st.current.done) return;
      if (st.current.pos !== st.current.sent && !st.current.busy) {
        const p = st.current.pos;
        st.current.sent = p;
        try {
          const r = (await req('safes.dial', { id, pos: p })) as { click?: boolean; closed?: boolean };
          if (r.closed) { close(false); return; }
          if (r.click) {
            sfx('sfx.metal_click', bal(ctx, 'clickVolume', 0.9), 1.25);
            if (ctx.testMode) safeLog.push(`click:${p}`);
          }
        } catch { /* ignore */ }
      }
      timer = window.setTimeout(() => void pump(), bal(ctx, 'dialSendMs', 100));
    };
    timer = window.setTimeout(() => void pump(), 100);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel);
      players?.freeze('safe', false);
      if (!st.current.done) { st.current.done = true; void req('safes.close', { id }).catch(() => undefined); }
    };
  }, [ctx, id, n]);

  const R = 120;
  const ticks = [];
  for (let i = 0; i < n; i++) {
    const major = i % 5 === 0;
    const a = (i / n) * Math.PI * 2;
    const sx = Math.sin(a), cy = -Math.cos(a);
    ticks.push(<line key={`t${i}`} x1={sx * (R - (major ? 18 : 10))} y1={cy * (R - (major ? 18 : 10))} x2={sx * (R - 3)} y2={cy * (R - 3)}
      stroke={major ? '#e8d3a0' : '#9c8a62'} stroke-width={major ? 3 : 1.5} />);
    if (major) ticks.push(<text key={`n${i}`} x={sx * (R - 34)} y={cy * (R - 34) + 6} fill="#efe2bf" font-size="17" text-anchor="middle" font-family="monospace">{i}</text>);
  }
  const ring = flash === 'bad' ? '#c0392b' : flash === 'ok' ? '#6fbf73' : flash === 'open' ? '#f2c230' : '#5a4a2a';
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at 50% 45%, rgba(10,12,14,0.55), rgba(0,0,0,0.88))', pointerEvents: 'auto', color: '#e6dcc4', fontFamily: 'ui-monospace, Consolas, monospace' }} data-testid="safe-dial">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', padding: '22px 26px', background: 'linear-gradient(#1d2124, #121416)', border: '2px solid #3a3f44', borderRadius: '10px', boxShadow: '0 20px 60px rgba(0,0,0,0.7)', maxWidth: '92vw' }}>
        <div style={{ letterSpacing: '0.25em', fontSize: '13px', color: '#a89c80' }}>COMPANY SAFE · PROPERTY OF FACILITY MGMT</div>
        <svg viewBox="-150 -150 300 300" width="300" height="300" style={{ maxWidth: '70vw', height: 'auto' }}>
          <circle r="146" fill="#0c0d0e" stroke={ring} stroke-width="5" />
          <polygon points="-9,-146 9,-146 0,-128" fill="#c0392b" />
          <g transform={`rotate(${(-pos * 360) / n})`}>
            <circle r={R} fill="url(#safeGrad)" stroke="#d9b866" stroke-width="3" />
            {ticks}
            <circle r="46" fill="#2b2418" stroke="#d9b866" stroke-width="2" />
            <rect x="-6" y="-44" width="12" height="30" rx="3" fill="#d9b866" />
          </g>
          <defs>
            <radialGradient id="safeGrad" cx="40%" cy="35%" r="75%">
              <stop offset="0%" stop-color="#6b5a35" />
              <stop offset="70%" stop-color="#3a301c" />
              <stop offset="100%" stop-color="#211b10" />
            </radialGradient>
          </defs>
        </svg>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', fontSize: '15px' }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px solid #d9b866', background: i < stage ? '#d9b866' : 'transparent', display: 'inline-block' }} />
          ))}
          <span style={{ marginLeft: '8px', fontSize: '22px', color: '#f3e7c6', minWidth: '3ch', textAlign: 'right' }}>{String(pos).padStart(2, '0')}</span>
        </div>
        <div style={{ fontSize: '14px', color: flash === 'bad' ? '#ff8a7a' : '#e6dcc4', minHeight: '1.3em', textAlign: 'center' }}>{msg}</div>
        <div style={{ fontSize: '12px', color: '#8f8670', textAlign: 'center', lineHeight: 1.5 }}>
          A / D or mouse wheel: turn · E / Space: set number · Esc: step away<br />
          Headphones help. Crew: keep quiet. A wrong number is LOUD.
        </div>
      </div>
    </div>
  );
}
