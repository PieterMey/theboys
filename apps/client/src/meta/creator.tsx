// Owner: track (d) Meta. Locker-mirror character creator (PLAN §3.8): name, body, suit colours, helmet (level locks),
// visor glyphs + colour (level locks), claim code. Live: every change goes to the host (meta.profile) -> everyone's avatar.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import type { Profile, HelmetKind } from '@dead-air/shared/profile.ts';
import { HELMET_UNLOCK_LEVEL, PROFILE_LIMITS, SUIT_PALETTE, VISOR_COLORS } from '@dead-air/shared/profile.ts';
import { mePub, metaOf, sfx, useWorldV } from './state.ts';
import { closeScreen } from './nav.ts';

const VISOR_LVL_DEFAULT = [1, 1, 1, 2, 3, 4];

export function visorLevels(ctx: ScreenProps['ctx']): number[] {
  const v = (ctx.balance.meta as Record<string, unknown> | undefined)?.visorUnlockLevel;
  return Array.isArray(v) ? (v as number[]) : VISOR_LVL_DEFAULT;
}

/** stylised 2D contractor (front view) */
export function SuitPreview({ p, size = 460 }: { p: Profile; size?: number }) {
  const [a, b] = p.suit;
  const f = p.body === 'f';
  const sh = f ? 58 : 66; // shoulder half-width
  const hip = f ? 46 : 42;
  const vc = p.visor.color;
  const helmet = p.helmet;
  const glyphs = (p.visor.glyphs || '').slice(0, 3).toUpperCase();
  return (
    <svg width={size * 0.62} height={size} viewBox="0 0 220 360" style={{ filter: 'drop-shadow(0 18px 30px rgba(0,0,0,0.7))' }}>
      <defs>
        <radialGradient id="mg-v" cx="50%" cy="45%" r="60%"><stop offset="0%" stop-color={vc} stop-opacity="0.9" /><stop offset="100%" stop-color="#050708" stop-opacity="0.95" /></radialGradient>
        <linearGradient id="mg-s" x1="0" x2="1"><stop offset="0%" stop-color="#000" stop-opacity="0.45" /><stop offset="45%" stop-color="#fff" stop-opacity="0.08" /><stop offset="100%" stop-color="#000" stop-opacity="0.5" /></linearGradient>
        <filter id="mg-glow"><feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <ellipse cx="110" cy="346" rx="70" ry="9" fill="#000" opacity="0.6" />
      {/* legs */}
      <path d={`M${110 - hip} 214 L${110 - 30} 330 L${110 - 6} 330 L110 240 L${110 + 6} 330 L${110 + 30} 330 L${110 + hip} 214 Z`} fill={a} />
      <rect x={110 - 34} y="318" width="30" height="14" fill={b} />
      <rect x={110 + 4} y="318" width="30" height="14" fill={b} />
      {/* torso */}
      <path d={`M${110 - sh} 112 Q110 98 ${110 + sh} 112 L${110 + hip + 4} 220 L${110 - hip - 4} 220 Z`} fill={a} />
      <path d={`M${110 - sh} 112 Q110 98 ${110 + sh} 112 L${110 + hip + 4} 220 L${110 - hip - 4} 220 Z`} fill="url(#mg-s)" />
      {/* arms */}
      <path d={`M${110 - sh} 114 L${110 - sh - 16} 206 L${110 - sh + 2} 208 L${110 - sh + 12} 140 Z`} fill={a} />
      <path d={`M${110 + sh} 114 L${110 + sh + 16} 206 L${110 + sh - 2} 208 L${110 + sh - 12} 140 Z`} fill={a} />
      <rect x={110 - sh - 19} y="200" width="20" height="14" rx="4" fill={b} />
      <rect x={110 + sh - 1} y="200" width="20" height="14" rx="4" fill={b} />
      {/* secondary: shoulders, belt, chest stripe */}
      <path d={`M${110 - sh} 112 Q${110 - sh + 8} 102 ${110 - sh + 30} 106 L${110 - sh + 26} 126 L${110 - sh + 2} 128 Z`} fill={b} />
      <path d={`M${110 + sh} 112 Q${110 + sh - 8} 102 ${110 + sh - 30} 106 L${110 + sh - 26} 126 L${110 + sh - 2} 128 Z`} fill={b} />
      <rect x={110 - hip - 3} y="204" width={(hip + 3) * 2} height="12" fill={b} />
      <rect x="104" y="112" width="12" height="92" fill={b} opacity="0.75" />
      {/* badge */}
      <rect x={110 - sh + 20} y="140" width="34" height="20" fill="#e8e2d2" />
      <text x={110 - sh + 37} y="155" text-anchor="middle" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#1d1b16">#{p.badge}</text>
      {/* helmet */}
      {helmet === 'box' && <rect x="66" y="22" width="88" height="86" rx="8" fill="#2a3034" stroke={b} stroke-width="4" />}
      {helmet === 'dome' && <path d="M62 96 Q62 18 110 18 Q158 18 158 96 L150 108 L70 108 Z" fill="#2a3034" stroke={b} stroke-width="4" />}
      {helmet === 'diver' && (
        <g>
          <circle cx="110" cy="64" r="50" fill="#5b4a2e" stroke="#c9a458" stroke-width="5" />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <circle key={i} cx={110 + 44 * Math.cos((i * Math.PI) / 4)} cy={64 + 44 * Math.sin((i * Math.PI) / 4)} r="3" fill="#c9a458" />)}
        </g>
      )}
      {/* visor */}
      {helmet === 'diver'
        ? <circle cx="110" cy="64" r="30" fill="url(#mg-v)" stroke="#2a2216" stroke-width="5" />
        : <rect x={helmet === 'box' ? 76 : 74} y="44" width={helmet === 'box' ? 68 : 72} height="38" rx={helmet === 'box' ? 4 : 16} fill="url(#mg-v)" stroke="#0a0c0d" stroke-width="3" />}
      <text x="110" y={helmet === 'diver' ? 74 : 72} text-anchor="middle" font-family="'Big Shoulders Stencil Display', Impact, sans-serif" font-weight="900" font-size="26" letter-spacing="3" fill="#fff" filter="url(#mg-glow)" style={{ fill: '#ffffff' }}>{glyphs}</text>
      <rect x="96" y="104" width="28" height="10" fill="#1a1e21" />
    </svg>
  );
}

export function MirrorScreen({ ctx }: ScreenProps) {
  useWorldV(ctx);
  const me = mePub(ctx);
  const meta = metaOf(ctx);
  const level = meta?.you?.level ?? me?.level ?? 1;
  const [p, setP] = useState<Profile | null>(me ? { ...me.profile, suit: [...me.profile.suit] as [string, string], visor: { ...me.profile.visor } } : null);
  const [claim, setClaim] = useState<string | null>(meta?.you?.claim ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vl = visorLevels(ctx);

  useEffect(() => {
    if (meta?.you?.claim) setClaim(meta.you.claim);
  }, [meta?.you?.claim]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('deadair.meta.claim');
      if (!claim && saved) setClaim(saved);
      if (claim) localStorage.setItem('deadair.meta.claim', claim);
    } catch { /* ignore */ }
  }, [claim]);

  if (!p) return null;
  const update = (q: Profile) => {
    setP(q);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void ctx.net.req('meta.profile', { profile: q }).then((r) => {
        if (!r.ok && r.reason) ctx.ui.toast(r.reason, 'warn');
        ctx.net.setIdentity({ name: r.profile.name, profile: r.profile });
      }).catch(() => ctx.net.req('profile.set', { profile: q }).catch(() => {}));
    }, 220);
  };
  const helmets: HelmetKind[] = ['dome', 'box', 'diver'];
  return (
    <div class="m-screen">
      <button class="m-close" onClick={() => closeScreen(ctx)}>DONE [ESC]</button>
      <div class="m-wrap">
        <div class="m-top">
          <div>
            <div class="m-kicker">LOCKER MIRROR · CONTRACTOR APPEARANCE · CHANGES ARE LIVE FOR THE WHOLE CREW</div>
            <h1 class="m-h1">Look the part</h1>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div class="m-label">CAREER</div>
            <div class="m-num">LVL {level}</div>
            <div class="m-small m-dim">{meta?.you?.xp ?? 0} XP{meta?.you?.nextLevelXp ? ` · next at ${meta.you.nextLevelXp}` : ' · max level'}</div>
          </div>
        </div>
        <div class="m-creator">
          <div class="m-preview m-corners"><SuitPreview p={p} /></div>
          <div>
            <div class="m-row" style={{ alignItems: 'flex-start', gap: '22px' }}>
              <div class="m-field m-grow">
                <label>NAME</label>
                <input class="m-input" value={p.name} maxLength={PROFILE_LIMITS.nameMax} spellcheck={false} onInput={(e) => update({ ...p, name: e.currentTarget.value })} />
              </div>
              <div class="m-field">
                <label>BODY</label>
                <div class="m-opts">
                  {(['m', 'f'] as const).map((b) => <button key={b} class={`m-opt ${p.body === b ? 'on' : ''}`} onClick={() => update({ ...p, body: b })}>{b === 'm' ? 'BUILD A' : 'BUILD B'}<small>{b === 'm' ? 'BROAD' : 'NARROW'}</small></button>)}
                </div>
              </div>
            </div>
            <div class="m-field">
              <label>SUIT · PRIMARY</label>
              <div class="m-swatches">{SUIT_PALETTE.map((c) => <button key={c} class={`m-swatch ${p.suit[0] === c ? 'on' : ''}`} style={{ background: c }} onClick={() => update({ ...p, suit: [c, p.suit[1]] })} />)}</div>
            </div>
            <div class="m-field">
              <label>SUIT · SECONDARY</label>
              <div class="m-swatches">{SUIT_PALETTE.map((c) => <button key={c} class={`m-swatch ${p.suit[1] === c ? 'on' : ''}`} style={{ background: c }} onClick={() => update({ ...p, suit: [p.suit[0], c] })} />)}</div>
            </div>
            <div class="m-field">
              <label>HELMET</label>
              <div class="m-opts">
                {helmets.map((h) => {
                  const need = HELMET_UNLOCK_LEVEL[h];
                  const locked = need > level;
                  return (
                    <button key={h} class={`m-opt ${p.helmet === h ? 'on' : ''} ${locked ? 'locked' : ''}`} disabled={locked} onClick={() => update({ ...p, helmet: h })}>
                      {h}<small>{locked ? `LOCKED · LVL ${need}` : need > 1 ? `UNLOCKED · LVL ${need}` : 'STANDARD ISSUE'}</small>
                    </button>
                  );
                })}
              </div>
            </div>
            <div class="m-row" style={{ alignItems: 'flex-start', gap: '22px' }}>
              <div class="m-field" style={{ width: '170px' }}>
                <label>VISOR GLYPHS</label>
                <input class="m-input" value={p.visor.glyphs} maxLength={PROFILE_LIMITS.glyphsMax} spellcheck={false} onInput={(e) => update({ ...p, visor: { ...p.visor, glyphs: e.currentTarget.value.toUpperCase() } })} />
              </div>
              <div class="m-field m-grow">
                <label>VISOR COLOUR</label>
                <div class="m-swatches" style={{ paddingBottom: '12px' }}>
                  {VISOR_COLORS.map((c, i) => {
                    const need = vl[i] ?? 1;
                    const locked = need > level;
                    return <button key={c} data-lvl={`LVL ${need}`} class={`m-swatch ${p.visor.color === c ? 'on' : ''} ${locked ? 'locked' : ''}`} disabled={locked} title={locked ? `Unlocks at level ${need}` : ''} style={{ background: c, boxShadow: `0 0 10px ${c}66` }} onClick={() => update({ ...p, visor: { ...p.visor, color: c } })} />;
                  })}
                </div>
              </div>
            </div>
            <div class="m-sheet accent" style={{ marginTop: '6px' }}>
              <div class="m-row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div class="m-label">CLAIM CODE · BADGE + PIN</div>
                  <div class="m-claim">{claim ?? `#${p.badge}-????`}</div>
                </div>
                <button class="m-btn small" onClick={() => void ctx.net.req('meta.newPin', {}).then((r) => { setClaim(r.claim); sfx(ctx, 'sfx.keypad_accept'); })}>NEW PIN</button>
              </div>
              <div class="m-small m-dim" style={{ marginTop: '8px', lineHeight: 1.6 }}>
                Write this down. Tomorrow's link is a new address, so your browser forgets you: type your badge and PIN on the join screen to get your level and look back. {claim ? '' : 'Your PIN was issued in an earlier session: press NEW PIN if you lost it.'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
