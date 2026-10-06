// Owner: track (d) Meta. Pause menu (settings / how to play / credits / leave), brightness check, kennel calibration,
// and the Join-screen extras (mic permission, consent, AI disclosure, claim code).
import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import type { HudProps, ScreenProps } from '../core/ui/api.ts';
import type { ClientContext } from '../core/context.ts';
import { applySettings, players, render, saveSettings, settings, sfx, useTicker, useWorldV } from './state.ts';
import type { MetaSettings } from './state.ts';
import { closeScreen, openScreen } from './nav.ts';

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
  hasMic?(): boolean;
  micError?(): string | null;
  startMic?(): Promise<boolean>;
  level?(): { db: number; base: number; gate: number; band: number };
  band?(): number;
  calibrate?(o?: unknown): Promise<unknown>;
}
const voice = (ctx: ClientContext) => ctx.services.use('voice') as unknown as VoiceLike | undefined;

// ---------------------------------------------------------------- settings

function Range({ label, min, max, step, value, fmt, onChange }: { label: string; min: number; max: number; step: number; value: number; fmt?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label class="m-set">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(e) => onChange(Number(e.currentTarget.value))} />
      <span class="m-amber" style={{ textAlign: 'right' }}>{fmt ? fmt(value) : value.toFixed(2)}</span>
    </label>
  );
}

function Toggle({ label, on, disabled, note, onChange }: { label: string; on: boolean; disabled?: boolean; note?: string; onChange: (v: boolean) => void }) {
  return (
    <label class="m-set">
      <span>{label}</span>
      <span><input type="checkbox" class="m-toggle" checked={on} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />{note && <span class="m-dim m-small" style={{ marginLeft: '10px' }}>{note}</span>}</span>
      <span />
    </label>
  );
}

function SettingsTab({ ctx }: { ctx: ClientContext }) {
  const [s, setS] = useState<MetaSettings>(settings());
  const [devs, setDevs] = useState<{ deviceId: string; label: string }[]>([]);
  const r = render(ctx);
  const v = voice(ctx);
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
      <div class="m-set"><span /><button class="m-btn small" onClick={() => openScreen(ctx, 'brightness')}>RUN BRIGHTNESS CHECK</button><span /></div>
      <h3 class="m-h3" style={{ marginTop: '18px' }}>Audio + voice</h3>
      <Range label="Master volume" min={0} max={1.5} step={0.05} value={s.master} fmt={(x) => `${Math.round(x * 100)}%`} onChange={(x) => set({ master: x }, ['master'])} />
      <Range label="Voice volume" min={0} max={1.5} step={0.05} value={s.voice} fmt={(x) => `${Math.round(x * 100)}%`} onChange={(x) => set({ voice: x }, ['voice'])} />
      <Range label="Effects volume" min={0} max={1.5} step={0.05} value={s.sfx} fmt={(x) => `${Math.round(x * 100)}%`} onChange={(x) => set({ sfx: x }, ['sfx'])} />
      <label class="m-set">
        <span>Microphone</span>
        <select value={dev} onChange={(e) => { const id = e.currentTarget.value; setDev(id); ctx.audio.unlock(); void v?.setDevice?.(id); }}>
          <option value="">Default microphone</option>
          {devs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 10)}</option>)}
        </select>
        <span />
      </label>
      <Range label="Mic gain" min={0} max={2} step={0.05} value={gain} fmt={(x) => `${Math.round(x * 100)}%`} onChange={(x) => { setGain(x); saveSettings({ micGain: x }); v?.setMicGain?.(x); }} />
      <Toggle label="Push-to-talk (hold V)" on={ptt} onChange={(x) => { setPtt(x); saveSettings({ ptt: x }); v?.setPushToTalk?.(x); }} />
      <Toggle label="Transcribe my speech" on={tx} note="on the host PC; text only goes to the AI. Off = loudness only" onChange={(x) => { setTx(x); v?.setTranscribe?.(x); }} />
      <h3 class="m-h3" style={{ marginTop: '18px' }}>Controls</h3>
      <Range label="Mouse sensitivity" min={0.0005} max={0.006} step={0.0001} value={sens} fmt={(x) => (x * 1000).toFixed(1)} onChange={(x) => set({ sensitivity: x }, ['sensitivity'])} />
    </div>
  );
}

// ---------------------------------------------------------------- how to play

const CONTROLS: [string, string][] = [
  ['WASD · Mouse', 'Move · look (click the game to capture the mouse)'],
  ['Shift', 'Sprint (loud: 12 m)'], ['C', 'Crouch (quiet: 1.5 m)'], ['E', 'Interact · carry · hide'],
  ['LMB', 'Use · throw · swing'], ['F', 'Flashlight'], ['Q (hold)', 'Walkie-talkie: transmit'],
  ['V (hold)', 'Push-to-talk (if enabled)'], ['G', 'Drop'], ['1-4', 'Inventory slots'], ['T', 'Emotes'],
  ['MMB', 'Silent ping (teammates with line of sight)'], ['B', 'Work-order board (in the van)'], ['R', 'Ready up (in the van)'], ['Esc', 'This menu'],
];

export function HowToTab() {
  return (
    <div>
      <h3 class="m-h3">The job</h3>
      <p class="m-credit">Salvage loot, restore power with the <b>twin breaker levers</b> (pulled within one second of each other), read the <b>vault code</b> off the van console, open the vault and carry the <b>Core</b> out between two people. The van leaves at <b>04:00</b>. Blackout at 03:00. Three contracts make a shift; miss the quota and HR writes to you.</p>
      <div class="m-law">
        <div class="m-sheet danger"><div class="m-kicker" style={{ color: 'var(--m-red)' }}>HOUND</div><h3 class="m-h2" style={{ margin: '8px 0' }}>It is blind</h3><div class="m-small" style={{ lineHeight: 1.6 }}>It ignores whispers and crouch-steps. When it growls, FREEZE. A second noise nearby and it charges. Bottles send it elsewhere.</div></div>
        <div class="m-sheet danger"><div class="m-kicker" style={{ color: 'var(--m-red)' }}>LISTENER</div><h3 class="m-h2" style={{ margin: '8px 0' }}>It understands</h3><div class="m-small" style={{ lineHeight: 1.6 }}>It hears what a teammate standing where it stands would hear, and acts on room names, player names, numbers and plans. It only grabs someone alone.</div></div>
        <div class="m-sheet danger"><div class="m-kicker" style={{ color: 'var(--m-red)' }}>MANNEQUIN</div><h3 class="m-h2" style={{ margin: '8px 0' }}>Keep it lit</h3><div class="m-small" style={{ lineHeight: 1.6 }}>Frozen while someone watches it and it is lit. Your visor blinks; two watchers are safe. Risk 2 and every third contract.</div></div>
      </div>
      <div class="m-row" style={{ alignItems: 'stretch', gap: '14px', marginBottom: '16px' }}>
        <div class="m-sheet accent m-grow"><div class="m-h3">It hunts information, not noise</div><div class="m-small" style={{ lineHeight: 1.6 }}>Laughing and small talk are just loudness. Callsigns ("BOILER"), names, digits and plans ("meet", "wait", "code") give it a target. Use code words. Lie to it. The van cab is sealed: talk freely in there.</div></div>
        <div class="m-sheet accent m-grow"><div class="m-h3">Walkies are speakers</div><div class="m-small" style={{ lineHeight: 1.6 }}>What you say on the radio comes out of every other walkie, and whatever stands next to one hears it too. It can fake radio calls: no click before the voice, a red LED. Verify.</div></div>
        <div class="m-sheet accent m-grow"><div class="m-h3">Nobody survives alone</div><div class="m-small" style={{ lineHeight: 1.6 }}>The console has the map and the codes, the field has the hands. A grabbed teammate has 3 seconds: hit it with a crowbar or shove it. If a friend can hear you, so can it.</div></div>
      </div>
      <h3 class="m-h3">Controls</h3>
      <table class="m-table"><tbody>{CONTROLS.map(([k, d]) => <tr key={k}><td><span class="m-keys">{k}</span></td><td>{d}</td></tr>)}</tbody></table>
      <p class="m-small m-dim" style={{ marginTop: '10px' }}>Never Ctrl: Ctrl+W closes the tab. A wired headset beats speakers (speakers force push-to-talk).</p>
    </div>
  );
}

// ---------------------------------------------------------------- credits

interface Credits { required?: string[]; sources?: { id: string; title: string; author: string; license: string; url?: string }[] }

export function CreditsTab() {
  const [c, setC] = useState<Credits | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/assets/credits.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((j) => setC(j as Credits)).catch((e: unknown) => setErr(String(e)));
  }, []);
  return (
    <div>
      <h3 class="m-h3">Required attribution</h3>
      {(c?.required ?? ['Horror Sound Effects Library by Little Robot Sound Factory (www.littlerobotsoundfactory.com), CC-BY 3.0']).map((l) => (
        <p key={l} class="m-credit" style={{ fontSize: '14px', borderLeft: '3px solid var(--m-amber)', paddingLeft: '10px' }}>{l}</p>
      ))}
      <h3 class="m-h3" style={{ marginTop: '18px' }}>Assets</h3>
      {err && <p class="m-small m-dim">credits.json unavailable ({err})</p>}
      {(c?.sources ?? []).map((s) => (
        <p key={s.id} class="m-credit"><b>{s.title}</b> · {s.author} · <span class="m-dim">{s.license}</span>{s.url ? <span class="m-dim"> · {s.url}</span> : null}</p>
      ))}
      <h3 class="m-h3" style={{ marginTop: '18px' }}>Made tonight</h3>
      <p class="m-credit">DEAD AIR was designed and built in one evening by a crew of Claude Code agents for a group of friends. Some text in this game (work orders, HR memos) is written by AI; speech is transcribed on the host PC and only text reaches the AI.</p>
    </div>
  );
}

// ---------------------------------------------------------------- menu

export function MenuScreen({ ctx, tab: tab0 }: ScreenProps) {
  const [tab, setTab] = useState<string>(typeof tab0 === 'string' ? tab0 : 'howto');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (typeof tab0 === 'string') setTab(tab0); }, [tab0]);
  useWorldV(ctx);
  const tabs: [string, string, ComponentType<{ ctx: ClientContext }>][] = [
    ['howto', 'How to play', HowToTab], ['settings', 'Settings', SettingsTab], ['credits', 'Credits', CreditsTab],
  ];
  const Cur = tabs.find((t) => t[0] === tab)?.[2] ?? HowToTab;
  return (
    <div class="m-screen">
      <button class="m-close" onClick={() => closeScreen(ctx)}>RESUME [ESC]</button>
      <div class="m-wrap">
        <div class="m-top">
          <div>
            <div class="m-kicker">PAUSED · THE NIGHT CONTINUES WITHOUT YOU · CREW {ctx.world.crew?.code ?? ''}</div>
            <h1 class="m-h1">Dead Air</h1>
          </div>
        </div>
        <div class="m-menu">
          <div class="m-menu-nav">
            <button class="m-btn primary" onClick={() => closeScreen(ctx)}>Resume</button>
            {tabs.map(([id, label]) => <button key={id} class={`m-btn ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>{label}</button>)}
            <div class="m-hazard" style={{ margin: '10px 0 4px' }} />
            {!confirm
              ? <button class="m-btn danger" onClick={() => setConfirm(true)}>Leave the shift</button>
              : <div class="m-sheet danger"><div class="m-small" style={{ marginBottom: '8px' }}>Leave the crew? Your progress is saved on the host.</div><div class="m-row"><button class="m-btn danger small" onClick={() => { ctx.net.leave(); ctx.ui.setScreen('join'); }}>LEAVE</button><button class="m-btn small" onClick={() => setConfirm(false)}>STAY</button></div></div>}
          </div>
          <div class="m-sheet" style={{ minHeight: '420px' }}><Cur ctx={ctx} /></div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- brightness check

export function BrightnessScreen({ ctx, first }: ScreenProps) {
  const r = render(ctx);
  const [e, setE] = useState<number>(settings().exposure ?? r?.exposure?.() ?? 1);
  const set = (x: number) => {
    setE(x);
    try { r?.setExposure?.(x); } catch { /* optional */ }
  };
  const done = () => {
    saveSettings({ exposure: e, brightnessDone: true });
    void applySettings(ctx, ['exposure']);
    sfx(ctx, 'sfx.ui_confirm');
    closeScreen(ctx);
  };
  const k = (base: number) => {
    const v = Math.min(255, Math.round(255 * base * Math.pow(e, 1.6)));
    return `rgb(${v},${v},${Math.min(255, v + 1)})`;
  };
  return (
    <div class="m-screen m-solid">
      <div class="m-wrap m-bright">
        <div class="m-bright-box">
          <div class="m-kicker">{first ? 'ONE-TIME SETUP · ' : ''}BRIGHTNESS CHECK</div>
          <h1 class="m-h1" style={{ fontSize: '54px' }}>Can you see it?</h1>
          <p class="m-small m-dim" style={{ lineHeight: 1.7 }}>Darkness is the point, but you should never play blind. Move the slider until the <b class="m-amber">left</b> stencil is just barely visible and the right one is clear.</p>
          <div class="m-bright-plate">
            <div style={{ color: k(0.018) }}>D</div>
            <div style={{ color: k(0.05) }}>E</div>
            <div style={{ color: k(0.12) }}>A</div>
          </div>
          <input type="range" min={0.4} max={2.6} step={0.02} value={e} style={{ width: '100%', accentColor: 'var(--m-amber)' }} onInput={(ev) => set(Number(ev.currentTarget.value))} />
          <div class="m-row" style={{ justifyContent: 'space-between', marginTop: '18px' }}>
            <span class="m-small m-dim">EXPOSURE {e.toFixed(2)}{r ? '' : ' · (renderer not ready: saved for later)'}</span>
            <button class="m-btn primary" onClick={done}>LOOKS RIGHT</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- kennel

const BAND_LABEL = ['SILENT', 'WHISPER', 'TALK', 'SHOUT', 'SCREAM'];
const BAND_COLOR = ['#3a4045', '#7dfcff', '#7fd36b', '#f0b43c', '#d23b2e'];

export function KennelScreen({ ctx }: ScreenProps) {
  useTicker(80);
  const [Panel, setPanel] = useState<ComponentType<{ ctx: ClientContext; onDone?: (r: unknown) => void }> | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let alive = true;
    import('../voice/ui.tsx')
      .then((m) => { if (alive && m.CalibrationPanel) setPanel(() => m.CalibrationPanel as unknown as ComponentType<{ ctx: ClientContext; onDone?: (r: unknown) => void }>); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const v = voice(ctx);
  const lvl = v?.level?.() ?? null;
  const band = lvl?.band ?? v?.band?.() ?? 0;
  const k = lvl ? Math.max(0, Math.min(1, (lvl.db + 70) / 65)) : band / 4;
  return (
    <div class="m-screen">
      <button class="m-close" onClick={() => closeScreen(ctx)}>DONE [ESC]</button>
      <div class="m-wrap narrow">
        <div class="m-top">
          <div>
            <div class="m-kicker">TRAINING KENNEL · MIC CALIBRATION</div>
            <h1 class="m-h1">Meet the dog</h1>
          </div>
        </div>
        <div class="m-sheet accent" style={{ marginBottom: '16px' }}>
          <div class="m-small" style={{ lineHeight: 1.7 }}>
            The chained Hound behind the fence is blind. <b class="m-amber">Whisper</b> and it ignores you. <b class="m-green">Talk</b> and it turns its head. <b class="m-red">Shout</b> and it lunges at the fence. Out there, it is not chained. This also teaches the game your voice: your friends hear you exactly as far as it does.
          </div>
          <div class="m-kennel-meter"><i style={{ width: `${k * 100}%`, background: BAND_COLOR[band] }} /></div>
          <div class="m-kennel-scale">{BAND_LABEL.map((b, i) => <span key={b} style={{ color: i === band ? BAND_COLOR[i] : undefined, fontWeight: i === band ? 700 : 400 }}>{b}</span>)}</div>
          <div class="m-small m-dim" style={{ marginTop: '6px' }}>{v?.hasMic?.() === false ? `No microphone: ${v?.micError?.() ?? 'permission needed'}` : `RADIUS NOW: ${[0, 3, 10, 25, 35][band]} m`}</div>
        </div>
        <div class="m-sheet">
          {Panel && !done ? <Panel ctx={ctx} onDone={() => { setDone(true); sfx(ctx, 'sfx.ui_confirm'); }} /> : null}
          {!Panel && <div class="m-small m-dim">Voice calibration is not available in this build: the meter above still shows your live loudness band.</div>}
          {done && <div class="m-row" style={{ justifyContent: 'space-between' }}><span class="m-green">CALIBRATED. Good dog.</span><button class="m-btn small" onClick={() => setDone(false)}>AGAIN</button></div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- join extras

const LS_CLAIM = 'deadair.meta.pendingClaim';

export function JoinExtras({ ctx }: HudProps) {
  useTicker(400);
  const v = voice(ctx);
  const [badge, setBadge] = useState('');
  const [pin, setPin] = useState('');
  const [note, setNote] = useState('');
  const hasMic = v?.hasMic?.() ?? false;
  const askMic = () => {
    ctx.audio.unlock();
    if (v?.startMic) void v.startMic().then((ok) => setNote(ok ? 'Microphone OK.' : `Microphone blocked: ${v.micError?.() ?? 'check the browser permission'}`));
    else void navigator.mediaDevices?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } }).then((s) => { s.getTracks().forEach((t) => t.stop()); setNote('Microphone OK.'); }).catch((e: unknown) => setNote(`Microphone blocked: ${e}`));
  };
  const saveClaim = () => {
    if (!/^\d{1,5}$/.test(badge.replace('#', '')) || !/^\d{4}$/.test(pin)) return setNote('Badge is a number, PIN is 4 digits.');
    try { sessionStorage.setItem(LS_CLAIM, JSON.stringify({ name: badge.replace('#', ''), pin })); } catch { /* ignore */ }
    setNote(`Badge #${badge.replace('#', '')} will be reclaimed when you join.`);
  };
  return (
    <div class="m-join">
      {!hasMic && (
        <div class="line"><button type="button" class="m-btn small primary" onClick={askMic}>ALLOW MICROPHONE</button><span>Chrome will ask for permission. Without a mic you can still listen and type.</span></div>
      )}
      <div class="line off"><input type="checkbox" class="m-toggle" disabled /><span>Voice mimicry · <b>coming soon</b> (always off tonight)</span></div>
      <div class="ai">Some content is AI-generated (work orders, HR memos, the Listener's choices). Speech is transcribed on the host PC; only text goes to Claude/JEV, never audio.</div>
      <details>
        <summary>Returning contractor? Reclaim your badge</summary>
        <div class="claim-row">
          <input placeholder="BADGE #" value={badge} maxLength={6} onInput={(e) => setBadge(e.currentTarget.value.replace(/[^0-9#]/g, ''))} />
          <input placeholder="PIN" value={pin} maxLength={4} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} />
          <button type="button" class="m-btn small" onClick={saveClaim}>SET</button>
        </div>
      </details>
      {note && <div class="line" style={{ color: 'var(--m-amber)' }}>{note}</div>}
    </div>
  );
}

/** after welcome: run a pending claim from the join screen */
export function runPendingClaim(ctx: ClientContext): void {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(LS_CLAIM); sessionStorage.removeItem(LS_CLAIM); } catch { raw = null; }
  if (!raw) return;
  let c: { name: string; pin: string } | null = null;
  try { c = JSON.parse(raw) as { name: string; pin: string }; } catch { c = null; }
  if (!c) return;
  void ctx.net.req('claim', c).then(
    (r) => ctx.ui.toast(`Badge reclaimed: level ${r.level ?? '?'}`, 'info', 5000),
    (e: unknown) => ctx.ui.toast(`Claim failed: ${e instanceof Error ? e.message : e}`, 'warn', 6000),
  );
}
