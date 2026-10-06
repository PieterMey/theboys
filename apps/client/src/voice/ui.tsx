// Owner: track ④ Voice. HUD band meter (bottom-left), Join-screen mic section (device, gain, consent) and the
// exported CalibrationPanel (for the meta track's kennel UI): `import { CalibrationPanel } from '../voice/index.ts'`.
import { useEffect, useRef, useState } from 'preact/hooks';
import { BAND_NAMES } from '@dead-air/shared/constants.ts';
import type { ClientContext } from '../core/context.ts';
import type { HudProps } from '../core/ui/api.ts';
import type { CalStep, CalibrationResult } from './calibrate.ts';
import type { MicDevice } from './mic.ts';

const BAND_COLORS = ['#3a4148', '#5fa8d3', '#7fd17f', '#f0b43c', '#ff4a3d'] as const;

function useTicker(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    let last = 0;
    const loop = (t: number) => {
      if (!alive) return;
      if (t - last >= ms) { last = t; setN((x) => x + 1); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return () => { alive = false; };
  }, [ms]);
  return n;
}

const box: Record<string, string | number> = {
  pointerEvents: 'none', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', letterSpacing: '0.12em',
  color: '#c9d1d9', background: 'rgba(4,6,8,0.55)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '3px',
  padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '150px',
};

/** Live band meter: your own detected band (silent / whisper / talk / shout / scream) + level bar + badges. */
export function BandMeter({ ctx }: HudProps) {
  useTicker(80);
  const v = ctx.services.use('voice');
  if (!v || ctx.net.status === 'idle') return null;
  const lvl = v.level();
  const band = lvl.band;
  const col = BAND_COLORS[band] ?? BAND_COLORS[0];
  // map -70..-5 dBFS to 0..1
  const k = Math.max(0, Math.min(1, (lvl.db + 70) / 65));
  const mark = (db: number) => `${Math.max(0, Math.min(100, ((db + 70) / 65) * 100))}%`;
  const ptt = v.pushToTalk();
  const radio = v.radio();
  return (
    <div style={box} data-testid="band-meter">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span style={{ color: col, fontWeight: 700 }}>{v.hasMic() ? (BAND_NAMES[band] ?? 'silent').toUpperCase() : 'NO MIC'}</span>
        <span style={{ display: 'flex', gap: '4px' }}>
          {radio === 1 && <span style={{ color: '#ff4a3d' }}>● TX</span>}
          {ptt && <span style={{ color: v.transmitting() ? '#7fd17f' : '#8b949e' }}>{v.speakersPtt() ? 'SPEAKERS: PTT [V]' : 'PTT [V]'}</span>}
        </span>
      </div>
      <div style={{ position: 'relative', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${k * 100}%`, background: col, transition: 'width 60ms linear' }} />
        <div style={{ position: 'absolute', left: mark(lvl.base), top: 0, bottom: 0, width: '1px', background: 'rgba(255,255,255,0.5)' }} />
        <div style={{ position: 'absolute', left: mark(lvl.gate), top: 0, bottom: 0, width: '1px', background: 'rgba(255,255,255,0.25)' }} />
      </div>
      <div style={{ display: 'flex', gap: '2px' }}>
        {[1, 2, 3, 4].map((b) => (
          <div key={b} style={{ flex: 1, height: '3px', borderRadius: '1px', background: band >= b ? BAND_COLORS[b] : 'rgba(255,255,255,0.08)' }} />
        ))}
      </div>
    </div>
  );
}

const joinBox: Record<string, string | number> = { display: 'flex', flexDirection: 'column', gap: '14px', margin: '0 0 16px', fontSize: '12px' };

/** Join-screen section: mic picker, gain slider, live meter, transcription consent. */
export function MicJoinSection({ ctx }: HudProps) {
  const v = ctx.services.use('voice');
  const [devs, setDevs] = useState<MicDevice[]>([]);
  const [dev, setDev] = useState(v?.deviceId() ?? '');
  const [gain, setGain] = useState(v?.micGain() ?? 1);
  const [tx, setTx] = useState(v?.transcribe() ?? true);
  useTicker(100);
  useEffect(() => {
    let alive = true;
    const load = () => { void v?.devices().then((d) => { if (alive) setDevs(d); }); };
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    const t = setTimeout(load, 1500);
    return () => { alive = false; clearTimeout(t); navigator.mediaDevices?.removeEventListener?.('devicechange', load); };
  }, [v]);
  if (!v) return null;
  const lvl = v.level();
  const k = Math.max(0, Math.min(1, (lvl.db + 70) / 65));
  const head = { display: 'block', fontSize: '10px', letterSpacing: '0.24em', color: 'var(--amber, #f0b43c)', marginBottom: '6px' } as const;
  const field = {
    width: '100%', boxSizing: 'border-box', background: '#000', border: '1px solid var(--line, #2a2f33)', color: 'var(--text, #d9d6cc)',
    font: '600 13px var(--font-mono, monospace)', letterSpacing: '0.06em', padding: '9px 10px', outline: 'none', borderRadius: 0,
  } as const;
  return (
    <div style={joinBox} class="voice-join">
      <div>
        <span style={head}>MICROPHONE</span>
        <select
          style={field}
          value={dev}
          onChange={(e) => {
            const id = e.currentTarget.value;
            setDev(id);
            ctx.audio.unlock();
            void v.setDevice(id);
          }}
        >
          <option value="">Default microphone</option>
          {devs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
        </select>
      </div>
      <div>
        <span style={{ ...head, display: 'flex', justifyContent: 'space-between' }}>
          <span>MIC GAIN</span>
          <span style={{ color: 'var(--dim, #7c7f7a)' }}>{Math.round(gain * 100)}%{v.hasMic() ? ` · ${(BAND_NAMES[lvl.band] ?? 'silent').toUpperCase()}` : ''}</span>
        </span>
        <input
          type="range" min={0} max={2} step={0.05} value={gain}
          style={{ width: '100%', margin: 0, padding: 0, border: 0, background: 'transparent', accentColor: '#f0b43c', height: '16px' }}
          onInput={(e) => { const g = Number(e.currentTarget.value); setGain(g); v.setMicGain(g); }}
        />
        <div style={{ height: '4px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden', marginTop: '4px' }}>
          <div style={{ height: '100%', width: `${v.hasMic() ? k * 100 : 0}%`, background: BAND_COLORS[lvl.band] ?? BAND_COLORS[0], transition: 'width 80ms linear' }} />
        </div>
      </div>
      {!v.hasMic() && v.micError() && <span style={{ color: '#f0b43c', fontSize: '11px' }}>No mic ({v.micError()}): you can still listen.</span>}
      <div
        role="checkbox" aria-checked={tx} tabIndex={0}
        style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', fontSize: '10px', letterSpacing: '0.08em', color: 'var(--dim, #7c7f7a)', lineHeight: 1.5 }}
        onClick={() => { const on = !tx; setTx(on); v.setTranscribe(on); }}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); const on = !tx; setTx(on); v.setTranscribe(on); } }}
      >
        <span style={{ flex: '0 0 12px', height: '12px', marginTop: '1px', border: '1px solid var(--line, #2a2f33)', background: tx ? '#f0b43c' : '#000', boxShadow: tx ? 'inset 0 0 0 2px #000' : 'none' }} />
        <span>TRANSCRIBE MY SPEECH ON THE HOST PC (TEXT ONLY REACHES THE AI). OFF = LOUDNESS ONLY.</span>
      </div>
    </div>
  );
}

const STEP_TEXT: Record<CalStep, string> = {
  noise: 'Stay quiet for a moment…',
  talk: 'Say, at normal volume: “Night shift salvage, crew checking in. Radio check, one two three.”',
  whisper: 'Now WHISPER it: “is anyone there?”',
  shout: 'Now SHOUT it: “GET TO THE VAN!”',
  echo: 'Echo check: you will hear a short chirp…',
  done: 'Calibrated.',
  failed: 'Calibration failed.',
};

/** Full-screen wrapper: ctx.ui.setScreen('voice-calibration', { back?: screenName }) */
export function CalibrationScreen(props: { ctx: ClientContext; back?: unknown }) {
  const back = typeof props.back === 'string' ? props.back : 'none';
  const close = () => props.ctx.ui.setScreen(back);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto' }}>
      <CalibrationPanel ctx={props.ctx} onClose={close} onDone={(r) => { if (r.ok && !(r.echo && r.echo.echo)) setTimeout(close, 2500); }} />
    </div>
  );
}

/** Calibration panel (kennel UI). Runs services.voice.calibrate() with on-screen prompts and a live meter. */
export function CalibrationPanel({ ctx, whisper = true, shout = true, onDone, onClose }: { ctx: ClientContext; whisper?: boolean; shout?: boolean; onDone?: (r: CalibrationResult) => void; onClose?: () => void }) {
  const v = ctx.services.use('voice');
  const [step, setStep] = useState<CalStep | null>(null);
  const [prog, setProg] = useState(0);
  const [lvl, setLvl] = useState(-120);
  const [res, setRes] = useState<CalibrationResult | null>(null);
  const busy = useRef(false);
  if (!v) return <div class="panel">Voice is not available.</div>;
  const start = () => {
    if (busy.current) return;
    busy.current = true;
    ctx.audio.unlock();
    setRes(null);
    void v.calibrate({ whisper, shout, echo: true, onStep: (s, p, db) => { setStep(s); setProg(p); setLvl(db); } }).then((r) => {
      busy.current = false;
      setRes(r);
      setStep(r.ok ? 'done' : 'failed');
      onDone?.(r);
    });
  };
  const k = Math.max(0, Math.min(1, (lvl + 70) / 65));
  return (
    <div class="panel voice-cal" style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', width: 'min(420px, 90vw)', boxSizing: 'border-box' }}>
      <strong style={{ letterSpacing: '0.15em' }}>VOICE CALIBRATION</strong>
      <span>{step ? STEP_TEXT[step] : 'Takes about 8 seconds. Use the headset you will play with.'}</span>
      {step && step !== 'done' && step !== 'failed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)' }}><div style={{ height: '100%', width: `${k * 100}%`, background: '#7fd17f' }} /></div>
          <div style={{ height: '2px', background: 'rgba(255,255,255,0.08)' }}><div style={{ height: '100%', width: `${prog * 100}%`, background: '#c9d1d9' }} /></div>
        </div>
      )}
      {res && res.ok && res.data && (
        <span style={{ fontSize: '11px', opacity: 0.8 }}>
          noise {res.data.noiseDb.toFixed(0)} dBFS · talk {res.data.talkDb.toFixed(0)} dBFS
          {res.data.whisperDb !== undefined ? ` · whisper ${res.data.whisperDb.toFixed(0)}` : ''}
          {res.data.shoutDb !== undefined ? ` · shout ${res.data.shoutDb.toFixed(0)}` : ''}
          {res.echo ? (res.echo.echo ? ' · SPEAKERS: push-to-talk ON (V)' : ' · echo ok') : ''}
        </span>
      )}
      {res && !res.ok && <span style={{ color: '#f0b43c' }}>{res.reason}</span>}
      <div style={{ display: 'flex', gap: '10px' }}>
        <button type="button" class="btn primary" style={{ flex: 1 }} disabled={busy.current} onClick={start}>{res ? 'RECALIBRATE' : 'START'}</button>
        {onClose && <button type="button" class="btn" style={{ flex: 1 }} onClick={onClose}>CLOSE</button>}
      </div>
    </div>
  );
}
