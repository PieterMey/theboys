// Owner: menu track. Main-menu sub-panels that must work BEFORE joining:
//  - CharacterPanel: local profile editor (meta's SuitPreview), saved with ctx.net.setIdentity -> sent in the hello
//  - SettingsPanel: meta's SettingsTab when meta exports it, else the same controls on meta's settings store
//  - HostPanel: GET /api/invite + copy (admin token only)
import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import type { ClientContext } from '../core/context.ts';
import type { HelmetKind, Profile } from '@dead-air/shared/profile.ts';
import { HELMET_UNLOCK_LEVEL, PROFILE_LIMITS, SUIT_PALETTE, VISOR_COLORS } from '@dead-air/shared/profile.ts';
import { SuitPreview, visorLevels } from '../meta/creator.tsx';
import * as metaMenus from '../meta/menus.tsx';
import { applySettings, players, render, saveSettings, settings } from '../meta/state.ts';
import type { MetaSettings } from '../meta/state.ts';
import { openScreen } from '../meta/nav.ts';
import { hashCode } from '../core/ui/JoinScreen.tsx';
import { uiSound } from './sound.ts';

// ---------------------------------------------------------------- character

const cloneProfile = (p: Profile): Profile => ({ ...p, suit: [p.suit[0], p.suit[1]], visor: { ...p.visor } });

export function CharacterPanel({ ctx }: { ctx: ClientContext }) {
  const [p, setP] = useState<Profile>(() => {
    const id = ctx.net.identity();
    return cloneProfile({ ...id.profile, name: id.name });
  });
  const vl = visorLevels(ctx);
  // persist once so a freshly rolled random profile stays the same until it is edited
  useEffect(() => { ctx.net.setIdentity({ name: p.name, profile: p }); }, []);
  const update = (q: Profile) => {
    setP(q);
    const name = q.name.trim().slice(0, PROFILE_LIMITS.nameMax);
    ctx.net.setIdentity({ name: name || undefined, profile: { ...q, name: name || q.name } });
    uiSound(ctx, 'hover');
  };
  const helmets: HelmetKind[] = ['dome', 'box', 'diver'];
  return (
    <div class="mm-char">
      <div class="mm-char-preview m-corners">
        <SuitPreview p={p} size={360} />
        <div class="mm-char-badge">BADGE #{p.badge}</div>
      </div>
      <div class="mm-char-fields">
        <div class="m-row" style={{ alignItems: 'flex-start', gap: '18px' }}>
          <div class="m-field m-grow">
            <label>CALLSIGN</label>
            <input class="m-input" value={p.name} maxLength={PROFILE_LIMITS.nameMax} spellcheck={false} onInput={(e) => update({ ...p, name: e.currentTarget.value })} />
          </div>
          <div class="m-field">
            <label>BODY</label>
            <div class="m-opts">
              {(['m', 'f'] as const).map((b) => <button key={b} type="button" class={`m-opt ${p.body === b ? 'on' : ''}`} onClick={() => update({ ...p, body: b })}>{b === 'm' ? 'BUILD A' : 'BUILD B'}<small>{b === 'm' ? 'BROAD' : 'NARROW'}</small></button>)}
            </div>
          </div>
        </div>
        <div class="m-field">
          <label>SUIT · PRIMARY</label>
          <div class="m-swatches">{SUIT_PALETTE.map((c) => <button key={c} type="button" aria-label={`primary ${c}`} class={`m-swatch ${p.suit[0] === c ? 'on' : ''}`} style={{ background: c }} onClick={() => update({ ...p, suit: [c, p.suit[1]] })} />)}</div>
        </div>
        <div class="m-field">
          <label>SUIT · SECONDARY</label>
          <div class="m-swatches">{SUIT_PALETTE.map((c) => <button key={c} type="button" aria-label={`secondary ${c}`} class={`m-swatch ${p.suit[1] === c ? 'on' : ''}`} style={{ background: c }} onClick={() => update({ ...p, suit: [p.suit[0], c] })} />)}</div>
        </div>
        <div class="m-field">
          <label>HELMET</label>
          <div class="m-opts">
            {helmets.map((h) => {
              const need = HELMET_UNLOCK_LEVEL[h];
              const locked = need > 1 && p.helmet !== h;
              return (
                <button key={h} type="button" class={`m-opt ${p.helmet === h ? 'on' : ''} ${locked ? 'locked' : ''}`} disabled={locked} onClick={() => update({ ...p, helmet: h })}>
                  {h}<small>{need > 1 ? `CAREER LVL ${need}` : 'STANDARD ISSUE'}</small>
                </button>
              );
            })}
          </div>
        </div>
        <div class="m-row" style={{ alignItems: 'flex-start', gap: '18px' }}>
          <div class="m-field" style={{ width: '130px' }}>
            <label>VISOR GLYPHS</label>
            <input class="m-input" value={p.visor.glyphs} maxLength={PROFILE_LIMITS.glyphsMax} spellcheck={false} onInput={(e) => update({ ...p, visor: { ...p.visor, glyphs: e.currentTarget.value.toUpperCase() } })} />
          </div>
          <div class="m-field m-grow">
            <label>VISOR COLOUR</label>
            <div class="m-swatches" style={{ paddingBottom: '12px' }}>
              {VISOR_COLORS.map((c, i) => {
                const need = vl[i] ?? 1;
                const locked = need > 1 && p.visor.color !== c;
                return <button key={c} type="button" aria-label={`visor ${c}`} data-lvl={`LVL ${need}`} class={`m-swatch ${p.visor.color === c ? 'on' : ''} ${locked ? 'locked' : ''}`} disabled={locked} style={{ background: c, boxShadow: `0 0 10px ${c}66` }} onClick={() => update({ ...p, visor: { ...p.visor, color: c } })} />;
              })}
            </div>
          </div>
        </div>
        <p class="mm-note">Saved on this PC and sent when you clock in. Higher-level helmets and visors unlock with your career: change them later at the locker mirror in the van, live for the whole crew.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings

// meta's pause-menu settings tab, if/when meta exports it (Reflect.get: no static missing-export error in the build)
const MetaSettingsTab = Reflect.get(metaMenus, 'SettingsTab') as ComponentType<{ ctx: ClientContext }> | undefined;

interface VoiceLike {
  devices?(): Promise<{ deviceId: string; label: string }[]>;
  setDevice?(id: string): Promise<boolean>;
  deviceId?(): string;
  setMicGain?(g: number): void;
  micGain?(): number;
  setPushToTalk?(on: boolean): void;
  pushToTalk?(): boolean;
  setTranscribe?(on: boolean): void;
  transcribe?(): boolean;
}

function Range({ label, min, max, step, value, fmt, onChange }: { label: string; min: number; max: number; step: number; value: number; fmt?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label class="m-set">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(e) => onChange(Number(e.currentTarget.value))} />
      <span class="m-amber" style={{ textAlign: 'right' }}>{fmt ? fmt(value) : value.toFixed(2)}</span>
    </label>
  );
}

function Toggle({ label, on, note, onChange }: { label: string; on: boolean; note?: string; onChange: (v: boolean) => void }) {
  return (
    <label class="m-set">
      <span>{label}</span>
      <span><input type="checkbox" class="m-toggle" checked={on} onChange={(e) => onChange(e.currentTarget.checked)} />{note && <span class="m-dim m-small" style={{ marginLeft: '10px' }}>{note}</span>}</span>
      <span />
    </label>
  );
}

/** same controls as meta's pause-menu settings, on meta's settings store (used until meta exports SettingsTab) */
function LocalSettings({ ctx }: { ctx: ClientContext }) {
  const [s, setS] = useState<MetaSettings>(settings());
  const [devs, setDevs] = useState<{ deviceId: string; label: string }[]>([]);
  const r = render(ctx);
  const v = ctx.services.use('voice') as unknown as VoiceLike | undefined;
  const pl = players(ctx);
  useEffect(() => { void v?.devices?.().then(setDevs).catch(() => {}); }, [v]);
  const set = (p: Partial<MetaSettings>, keys: (keyof MetaSettings)[]) => {
    setS(saveSettings(p));
    void applySettings(ctx, keys);
  };
  const presets = r?.presets?.length ? [...r.presets] : ['low', 'medium', 'high', 'ultra'];
  const exposure = s.exposure ?? r?.exposure?.() ?? 1;
  const sens = s.sensitivity ?? pl?.settings?.().sensitivity ?? 0.0022;
  const [dev, setDev] = useState(v?.deviceId?.() ?? '');
  const [gain, setGain] = useState(v?.micGain?.() ?? s.micGain ?? 1);
  const [ptt, setPtt] = useState(v?.pushToTalk?.() ?? s.ptt);
  const [tx, setTx] = useState(v?.transcribe?.() ?? true);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div>
      <h3 class="m-h3">Video</h3>
      <label class="m-set">
        <span>Graphics preset</span>
        <select value={s.preset ?? r?.preset ?? 'high'} onChange={(e) => set({ preset: e.currentTarget.value }, ['preset'])}>
          {presets.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
        </select>
        <span class="m-dim m-small">{r ? '' : 'n/a'}</span>
      </label>
      <Range label="Exposure (brightness)" min={0.4} max={2.6} step={0.02} value={exposure} onChange={(x) => set({ exposure: x }, ['exposure'])} />
      <Toggle label="Reduce flicker / chromatic aberration" on={s.reduceFlicker} onChange={(x) => set({ reduceFlicker: x }, ['reduceFlicker'])} />
      <div class="m-set"><span /><button type="button" class="m-btn small" onClick={() => openScreen(ctx, 'brightness')}>RUN BRIGHTNESS CHECK</button><span /></div>
      <h3 class="m-h3" style={{ marginTop: '18px' }}>Audio + voice</h3>
      <Range label="Master volume" min={0} max={1.5} step={0.05} value={s.master} fmt={pct} onChange={(x) => set({ master: x }, ['master'])} />
      <Range label="Voice volume" min={0} max={1.5} step={0.05} value={s.voice} fmt={pct} onChange={(x) => set({ voice: x }, ['voice'])} />
      <Range label="Effects volume" min={0} max={1.5} step={0.05} value={s.sfx} fmt={pct} onChange={(x) => set({ sfx: x }, ['sfx'])} />
      <label class="m-set">
        <span>Microphone</span>
        <select value={dev} onChange={(e) => { const id = e.currentTarget.value; setDev(id); ctx.audio.unlock(); void v?.setDevice?.(id); }}>
          <option value="">Default microphone</option>
          {devs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 10)}</option>)}
        </select>
        <span />
      </label>
      <Range label="Mic gain" min={0} max={2} step={0.05} value={gain} fmt={pct} onChange={(x) => { setGain(x); saveSettings({ micGain: x }); v?.setMicGain?.(x); }} />
      <Toggle label="Push-to-talk (hold V)" on={ptt} onChange={(x) => { setPtt(x); saveSettings({ ptt: x }); v?.setPushToTalk?.(x); }} />
      <Toggle label="Transcribe my speech" on={tx} note="on the host PC; text only goes to the AI" onChange={(x) => { setTx(x); v?.setTranscribe?.(x); }} />
      <h3 class="m-h3" style={{ marginTop: '18px' }}>Controls</h3>
      <Range label="Mouse sensitivity" min={0.0005} max={0.006} step={0.0001} value={sens} fmt={(x) => (x * 1000).toFixed(1)} onChange={(x) => set({ sensitivity: x }, ['sensitivity'])} />
    </div>
  );
}

export function SettingsPanel({ ctx }: { ctx: ClientContext }) {
  const S = MetaSettingsTab ?? LocalSettings;
  return <div class="mm-settings"><S ctx={ctx} /></div>;
}

// ---------------------------------------------------------------- host

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function HostPanel({ ctx }: { ctx: ClientContext }) {
  const code = ctx.world.crew?.code ?? hashCode();
  const [inv, setInv] = useState<{ url: string | null; base: string | null } | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const load = () => {
    setErr('');
    fetch(`/api/invite${code ? `?code=${encodeURIComponent(code)}` : ''}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: unknown) => setInv(j as { url: string | null; base: string | null }))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);
  const tunnel = !!inv?.url;
  const link = inv?.url ?? `${location.origin}/${code ? `#${code}` : ''}`;
  const copy = () => {
    uiSound(ctx, 'select');
    void copyText(link).then((ok) => setCopied(ok ? 'COPIED' : 'COPY FAILED: select the link'));
    setTimeout(() => setCopied(''), 2500);
  };
  return (
    <div class="mm-host">
      <div class={`mm-host-status ${tunnel ? 'ok' : 'off'}`}>
        <i />{inv === null && !err ? 'ASKING THE SERVER…' : tunnel ? 'TUNNEL ONLINE · FRIENDS CAN REACH THIS PC' : 'NO TUNNEL · LOCAL NETWORK LINK ONLY'}
      </div>
      <label class="mm-host-label">INVITE LINK{code ? ` · CREW ${code}` : ''}</label>
      <div class="mm-host-link" data-testid="host-invite-link">
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" class="m-btn primary" onClick={copy}>{copied || 'COPY'}</button>
        <button type="button" class="m-btn" onClick={() => { uiSound(ctx, 'hover'); load(); }}>REFRESH</button>
      </div>
      {err && <p class="mm-note" style={{ color: 'var(--m-red)' }}>Invite lookup failed ({err}).</p>}
      <ol class="mm-steps">
        <li><b>Send the link</b> to your friends (Discord, WhatsApp).</li>
        <li><b>PLAY → CREATE CREW</b> to open the crew on this PC. The van's top-right panel then copies the invite <b>with</b> the crew code.</li>
        <li>Friends open the link, pick a callsign and press <b>JOIN CREW</b>. Chrome + a wired headset works best.</li>
      </ol>
    </div>
  );
}
