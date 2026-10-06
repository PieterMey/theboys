// Owner: track ⑤ Players. HUD widgets: stamina, crosshair + "click to look" hint, emote wheel, proximity chat,
// spectator banner. State lives in ./social.ts signals.
import { useEffect, useRef } from 'preact/hooks';
import type { HudProps } from '../core/ui/api.ts';
import { EMOTE_LABEL, WHEEL, ui } from './social.ts';
import './types.ts';

const mono = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

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

export function CrosshairHud(_p: HudProps) {
  if (!ui.inGame.value) return null;
  const spec = ui.spectating.value;
  if (spec.on) {
    return (
      <div style={{ position: 'fixed', top: '14%', left: 0, right: 0, textAlign: 'center', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
        <div style={{ font: `700 13px ${mono}`, letterSpacing: '0.35em', color: '#9fd7ff', textShadow: '0 0 8px #000' }}>STATIC // SPECTATING</div>
        <div style={{ font: `500 12px ${mono}`, color: '#d9d4c6', marginTop: '6px', textShadow: '0 0 6px #000' }}>
          {spec.target ? `following ${spec.target}` : 'no living crew in range'} · click to cycle
        </div>
      </div>
    );
  }
  return (
    <>
      <div style={{ position: 'fixed', left: '50%', top: '50%', width: '4px', height: '4px', margin: '-2px 0 0 -2px', borderRadius: '50%', background: 'rgba(255,255,255,0.55)', boxShadow: '0 0 3px rgba(0,0,0,0.9)', pointerEvents: 'none' }} />
      {!ui.locked.value && (
        <div style={{ position: 'fixed', left: 0, right: 0, top: '58%', textAlign: 'center', whiteSpace: 'nowrap', font: `600 12px ${mono}`, letterSpacing: '0.25em', color: 'rgba(230,224,206,0.8)', textShadow: '0 0 6px #000', pointerEvents: 'none' }}>
          CLICK TO LOOK AROUND
        </div>
      )}
    </>
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
