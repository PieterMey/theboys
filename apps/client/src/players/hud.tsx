// Owner: track ⑤ Players (v1.2 stance HUD + stealth hints: players-stealth). HUD widgets: stamina, crosshair + "click
// to look" hint, emote wheel, proximity chat, spectator banner, stance (how far your steps carry), one-time hints,
// v1.3 the spectator's poke bar (dead pokes).
// State lives in ./social.ts signals.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { HudProps } from '../core/ui/api.ts';
import { EMOTE_LABEL, WHEEL, ui } from './social.ts';
import { fmtMetres } from './stealth.ts';
import './types.ts';

const mono = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

const STANCE_COLOR = { crouch: '#7fd17f', walk: '#f0b43c', sprint: '#ff4a3d' } as const;
/** loudest step the bar scales to: sprinting on grating, 12 x 1.4 */
const RADIUS_FULL_M = 16.8;

/**
 * v1.2 stance HUD (bottom-left, stacked with voice's band meter): how far your footsteps carry right now. Green
 * 'CROUCHED · STEPS SILENT', amber 'WALKING · 5 m', red 'SPRINTING · 12 m', plus why (METAL FLOOR / GRATING / TILES /
 * CARPET / SOFT SOLES). Pulses on each of your footsteps; hidden while standing still (index.ts decides where).
 */
export function StanceHud(_p: HudProps) {
  const v = ui.stance.value;
  const pulse = ui.stepPulse.value;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !pulse || typeof el.animate !== 'function') return;
    try {
      el.animate([{ opacity: 1, filter: 'brightness(1.6)' }, { opacity: 0.88, filter: 'brightness(1)' }], { duration: 260, easing: 'ease-out' });
    } catch { /* no WAAPI */ }
  }, [pulse]);
  if (!ui.inGame.value || ui.spectating.value.on || !v.mode) return null;
  const col = STANCE_COLOR[v.mode];
  const label = v.mode === 'crouch' ? 'CROUCHED · STEPS SILENT' : `${v.mode === 'walk' ? 'WALKING' : 'SPRINTING'} · ${fmtMetres(v.radiusM)} m`;
  const k = Math.max(0.04, Math.min(1, v.radiusM / RADIUS_FULL_M));
  const chips = [v.tag, v.soles && v.tag !== 'SOFT SOLES' ? 'SOFT SOLES' : null].filter(Boolean) as string[];
  return (
    <div ref={ref} data-testid="stance-hud" data-mode={v.mode} data-radius={String(v.radiusM)} style={{
      pointerEvents: 'none', font: `600 11px ${mono}`, letterSpacing: '0.12em', color: '#c9d1d9', background: 'rgba(4,6,8,0.55)',
      border: '1px solid rgba(255,255,255,0.08)', borderLeft: `2px solid ${col}`, borderRadius: '3px', padding: '6px 8px', minWidth: '150px',
      display: 'flex', flexDirection: 'column', gap: '4px', opacity: 0.88,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap' }}>
        <span style={{ color: col, fontWeight: 700 }}>{label}</span>
        {chips.map((c) => (
          <span key={c} style={{ fontSize: '9.5px', letterSpacing: '0.16em', color: '#e9e3d0', border: '1px solid rgba(233,227,208,0.28)', padding: '1px 5px 0', borderRadius: '2px' }}>{c}</span>
        ))}
      </div>
      <div style={{ position: 'relative', height: '3px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round(k * 100)}%`, background: col, opacity: v.mode === 'crouch' ? 0.55 : 0.9, transition: 'width 120ms linear' }} />
      </div>
    </div>
  );
}

/** v1.2 crawl vents: a dark duct vignette with the time left (the 3D duct is behind it, players/vents.ts) */
export function CrawlHud(_p: HudProps) {
  const c = ui.crawl.value;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!c) return;
    const t = setInterval(() => setTick((x) => x + 1), 200);
    return () => clearInterval(t);
  }, [c?.until]);
  if (!c) return null;
  const left = Math.max(0, c.until - performance.now());
  const k = 1 - left / Math.max(1, c.total);
  return (
    <div data-testid="crawl-hud" style={{
      position: 'fixed', inset: 0, pointerEvents: 'none',
      background: 'radial-gradient(ellipse 46% 40% at 50% 52%, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.94) 100%)',
    }}>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: '16%', textAlign: 'center', font: `600 12px ${mono}`, letterSpacing: '0.3em', color: 'rgba(214,206,186,0.82)', textShadow: '0 0 6px #000' }}>
        CRAWLING · {Math.ceil(left / 1000)} s
        <div style={{ width: '180px', height: '2px', margin: '8px auto 0', background: 'rgba(255,255,255,0.1)' }}>
          <div style={{ width: `${Math.round(k * 100)}%`, height: '100%', background: 'rgba(214,206,186,0.7)' }} />
        </div>
      </div>
    </div>
  );
}

/** v1.2 one-time stealth hint (crouch on the first contract, freeze on a growl, break line of sight when seen) */
export function StealthHintHud(_p: HudProps) {
  const h = ui.hint.value;
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== 'function') return;
    try {
      el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 320, easing: 'ease-out' });
    } catch { /* no WAAPI */ }
  }, [h?.id, h?.until]);
  if (!h || !ui.inGame.value || ui.spectating.value.on) return null;
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: '23%', textAlign: 'center', pointerEvents: 'none' }}>
      <span ref={ref} data-testid="stealth-hint" data-hint={h.id} style={{
        display: 'inline-block', maxWidth: '86vw', font: `600 13px ${mono}`, letterSpacing: '0.16em', color: '#f2e6c4',
        background: 'rgba(6,7,8,0.74)', border: '1px solid rgba(240,180,60,0.4)', borderLeft: '3px solid #f0b43c',
        padding: '8px 14px 7px', textShadow: '0 0 6px #000', boxShadow: '0 2px 18px rgba(0,0,0,0.5)',
      }}>{h.text}</span>
    </div>
  );
}

export function StaminaHud(_p: HudProps) {
  const s = ui.stamina.value;
  if (!ui.inGame.value || ui.spectating.value.on || s >= 0.995) return null;
  const low = s < 0.25;
  return (
    <div style={{ width: '220px', padding: '4px 0', opacity: 0.85 }}>
      <div style={{ font: `600 10px ${mono}`, letterSpacing: '0.2em', color: low ? '#ff8a6b' : '#c9c4b5', marginBottom: '3px' }}>STAMINA</div>
      <div style={{ height: '5px', background: 'rgba(255,255,255,0.12)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(s * 100)}%`, height: '100%', background: low ? '#e0583a' : '#e8dcb5', transition: 'width 80ms linear' }} />
      </div>
    </div>
  );
}

/** centre dot (the 'center' slot is centred with a transform, so the dot at its 50%/50% is the screen centre) */
export function CrosshairHud(_p: HudProps) {
  if (!ui.inGame.value || ui.spectating.value.on) return null;
  return (
    <div style={{ position: 'fixed', left: '50%', top: '50%', width: '4px', height: '4px', margin: '-2px 0 0 -2px', borderRadius: '50%', background: 'rgba(255,255,255,0.55)', boxShadow: '0 0 3px rgba(0,0,0,0.9)', pointerEvents: 'none' }} />
  );
}

/**
 * Screen-anchored lines (spectator banner, "click to look"). Registered in the untransformed 'top-left' slot: inside a
 * transformed slot (center/top/bottom) position:fixed resolves against the slot box, which put them mid-screen.
 */
export function ScreenHintHud(_p: HudProps) {
  if (!ui.inGame.value) return null;
  const spec = ui.spectating.value;
  if (spec.on) {
    return (
      <div data-testid="players-spectating" style={{ position: 'fixed', top: '14%', left: 0, right: 0, textAlign: 'center', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
        <div style={{ font: `700 13px ${mono}`, letterSpacing: '0.35em', color: '#9fd7ff', textShadow: '0 0 8px #000' }}>STATIC // SPECTATING</div>
        <div style={{ font: `500 12px ${mono}`, color: '#d9d4c6', marginTop: '6px', textShadow: '0 0 6px #000' }}>
          {spec.target ? `following ${spec.target}` : 'no living crew in range'} · click to cycle
        </div>
      </div>
    );
  }
  if (ui.locked.value) return null;
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, top: '58%', textAlign: 'center', whiteSpace: 'nowrap', font: `600 12px ${mono}`, letterSpacing: '0.25em', color: 'rgba(230,224,206,0.8)', textShadow: '0 0 6px #000', pointerEvents: 'none' }}>
      CLICK TO LOOK AROUND
    </div>
  );
}

/**
 * Where the poke bar sits: the inventory hotbar's place at the bottom edge (the hotbar hides while spectating, and the
 * same keys 1-4 poke now), under interaction's revive line (.ix-spec, 96 px up) and clear of the followed teammate,
 * whom the follow camera frames mid-screen. On a window narrower than 960 px the corner HUD (band meter and chat,
 * render chip) would reach it, so there it steps up above the revive line instead: (960px - 100vw) * 1000 is hugely
 * negative on a wide window and hugely positive on a narrow one, and the clamp turns that into 14 px or 124 px.
 */
const POKE_BAR_BOTTOM = 'clamp(14px, calc((960px - 100vw) * 1000), 124px)';

/**
 * v1.3 dead pokes (flag deadPokes): the spectator's poke bar at the bottom edge (POKE_BAR_BOTTOM): one line (what this
 * is, then the last result or the hint) over the buttons. [1]-[3] knock that many times on the door or wall nearest
 * your camera (one shared cooldown), [4] flickers the lights of the room you watch. Keys work while the mouse is
 * captured; the buttons take clicks once it is free. The server decides where and whether.
 */
export function PokeBarHud({ ctx }: HudProps) {
  const p = ui.poke.value;
  const spec = ui.spectating.value;
  const [, setTick] = useState(0);
  const now = performance.now();
  const live = p.on && (now < p.knockReadyAt || now < p.flickerReadyAt || (!!p.msg && now < p.msgUntil));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((x) => x + 1), 150);
    return () => clearInterval(t);
  }, [live, p.knockReadyAt, p.flickerReadyAt, p.msgUntil]);
  if (!ui.inGame.value || !spec.on || !p.on) return null;
  const knockLeft = Math.max(0, p.knockReadyAt - now);
  const flickerLeft = Math.max(0, p.flickerReadyAt - now);
  const msg = p.msg && now < p.msgUntil ? p.msg : null;
  const btn = (key: string, label: string, left: number, full: number, send: () => void, testid: string) => {
    const busy = left > 0 || p.pending;
    const k = full > 0 ? Math.max(0, Math.min(1, 1 - left / full)) : 1;
    return (
      <button key={testid} type="button" data-no-lock="1" data-testid={testid} data-ready={busy ? '0' : '1'} disabled={busy}
        onClick={(e) => { e.preventDefault(); send(); }}
        style={{
          position: 'relative', overflow: 'hidden', minWidth: '108px', padding: '7px 11px 8px', cursor: busy ? 'default' : 'pointer',
          font: `700 11.5px/15px ${mono}`, letterSpacing: '0.16em', textAlign: 'left', whiteSpace: 'nowrap',
          color: busy ? 'rgba(159,215,255,0.45)' : '#d8eeff', background: 'rgba(4,8,12,0.72)',
          border: `1px solid ${busy ? 'rgba(159,215,255,0.16)' : 'rgba(159,215,255,0.5)'}`, borderRadius: '3px',
          boxShadow: busy ? 'none' : '0 0 14px rgba(110,190,255,0.16)', textShadow: '0 0 6px #000',
        }}>
        <span style={{ color: busy ? 'rgba(232,201,90,0.4)' : '#e8c95a', marginRight: '7px' }}>{key}</span>
        {label}
        {left > 0 && <span style={{ marginLeft: '7px', fontWeight: 500, color: 'rgba(216,238,255,0.6)' }}>{Math.ceil(left / 1000)} s</span>}
        <span style={{ position: 'absolute', left: 0, bottom: 0, height: '2px', width: `${Math.round(k * 100)}%`, background: busy ? 'rgba(159,215,255,0.35)' : 'rgba(159,215,255,0.8)' }} />
      </button>
    );
  };
  const send = (kind: 'knock' | 'flicker', count?: number) => () => ctx.bus.emit('players:poke', count ? { kind, count } : { kind });
  return (
    <div data-testid="poke-bar" style={{
      position: 'fixed', left: 0, right: 0, bottom: POKE_BAR_BOTTOM, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px',
      textAlign: 'center', pointerEvents: 'none',
    }}>
      <div data-testid="poke-line" style={{ maxWidth: '92vw', font: `500 11px/14px ${mono}`, letterSpacing: '0.07em', textShadow: '0 0 6px #000' }}>
        <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.22em', color: 'rgba(159,215,255,0.72)' }}>REACH THROUGH THE STATIC</span>
        <span style={{ margin: '0 8px', color: 'rgba(159,215,255,0.38)' }}>·</span>
        <span data-testid="poke-msg" style={{ color: msg ? '#f2e6c4' : 'rgba(217,212,198,0.62)' }}>{msg ?? 'THE LIVING HEAR YOUR KNOCKS. SO DOES THE HOUND.'}</span>
      </div>
      <div data-testid="poke-buttons" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px', maxWidth: '92vw', pointerEvents: 'auto' }}>
        {btn('1', 'KNOCK', knockLeft, p.knockMs, send('knock', 1), 'poke-knock-1')}
        {btn('2', 'KNOCK ×2', knockLeft, p.knockMs, send('knock', 2), 'poke-knock-2')}
        {btn('3', 'KNOCK ×3', knockLeft, p.knockMs, send('knock', 3), 'poke-knock-3')}
        {btn('4', p.room ? `FLICKER ${p.room}` : 'FLICKER', flickerLeft, p.flickerMs, send('flicker'), 'poke-flicker')}
      </div>
    </div>
  );
}

export function EmoteWheelHud(_p: HudProps) {
  if (!ui.wheelOpen.value) return null;
  const sel = ui.wheelSel.value;
  const pos = [[0, -78], [96, 0], [0, 78], [-96, 0]];
  return (
    <div style={{ position: 'fixed', left: '50%', top: '50%', width: 0, height: 0, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: '-120px', top: '-120px', width: '240px', height: '240px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(0,0,0,0.55) 30%, rgba(0,0,0,0) 70%)' }} />
      {WHEEL.map((k, i) => (
        <div key={k} style={{
          position: 'absolute', left: `${pos[i][0]}px`, top: `${pos[i][1]}px`, transform: 'translate(-50%,-50%)',
          font: `700 12px ${mono}`, letterSpacing: '0.18em', padding: '7px 11px', borderRadius: '3px',
          color: sel === k ? '#101010' : '#e9e3d0', background: sel === k ? '#e8c95a' : 'rgba(20,20,18,0.8)',
          border: '1px solid rgba(232,201,90,0.5)', whiteSpace: 'nowrap',
        }}>{`${i + 1} ${EMOTE_LABEL[k]}`}</div>
      ))}
    </div>
  );
}

export function ChatHud({ ctx }: HudProps) {
  const lines = ui.chatLines.value;
  const open = ui.chatOpen.value;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => ref.current?.focus(), 0);
  }, [open]);
  if (!lines.length && !open) return null;
  const close = () => {
    ui.chatOpen.value = false;
    ctx.bus.emit('action:chat', { open: false });
  };
  return (
    <div style={{ width: '380px', maxWidth: '80vw', font: `500 13px ${mono}`, pointerEvents: open ? 'auto' : 'none' }}>
      {lines.map((l) => (
        <div key={l.id} style={{ padding: '2px 6px', marginTop: '2px', color: '#e6e0cf', background: 'rgba(0,0,0,0.45)', borderLeft: `2px solid ${l.self ? '#8fd3ff' : '#e8c95a'}`, textShadow: '0 0 4px #000' }}>
          <span style={{ color: l.self ? '#8fd3ff' : '#e8c95a' }}>{l.name}</span>: {l.text}
        </div>
      ))}
      {open && (
        <form onSubmit={(e) => {
          e.preventDefault();
          const v = ref.current?.value.trim() ?? '';
          if (v) ctx.bus.emit('players:chatSend', { text: v });
          close();
        }}>
          <input ref={ref} maxLength={140} placeholder="say nearby (talk radius)…" data-no-lock="1"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } e.stopPropagation(); }}
            style={{ marginTop: '6px', width: '100%', boxSizing: 'border-box', font: `500 13px ${mono}`, color: '#f2eddf', background: 'rgba(8,8,8,0.82)', border: '1px solid #6d6650', padding: '6px 8px', outline: 'none' }} />
        </form>
      )}
    </div>
  );
}
