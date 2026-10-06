// Owner: v1.1 loading screen. Full-screen, on-theme: DEAD AIR stencil over radio static, rotating gameplay tips,
// a real progress bar with labelled steps (connecting -> downloading assets -> building level -> warming shaders ->
// ready), the current step's detail (files / MB) and the elapsed time, so a slow PC never looks hung.
// Every animation is transform/opacity only (compositor): it keeps moving while the main thread compiles shaders.
import { useEffect, useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';

export type StepId = 'connecting' | 'assets' | 'level' | 'shaders' | 'stable' | 'ready';

export interface LoadingView {
  visible: boolean;
  kind: 'join' | 'arrive';
  step: StepId;
  pct: number;
  detail: string;
  t0: number;
  site: string;
  crew: string;
  fading: boolean;
}

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'connecting', label: 'Connecting' },
  { id: 'assets', label: 'Downloading assets' },
  { id: 'level', label: 'Building level' },
  { id: 'shaders', label: 'Warming shaders' },
  { id: 'stable', label: 'Settling in' },
];

export const TIPS: string[] = [
  'Everything that hears you hears what your crew hears. Whisper near the Hound.',
  'The Mannequin only moves when nobody is looking at it. Keep a light on it.',
  'The Listener learns from what you say. Never say the vault code out loud near it.',
  'Hold Q to talk on the walkie. Anyone with a walkie hears you, and so might something else.',
  'The van is sealed. Inside it you can talk freely.',
  'A thrown bottle is a 15 m crash the Hound cannot resist. Use it to clear a corridor.',
  'Two people carry the Core. Stay close: drop it and it costs the haul.',
  'Glowsticks mark a path and keep a Mannequin lit while you work.',
  'Dead? Spectate your crew and talk to them. A medkit revives you within 30 s.',
  'The van leaves at 04:00 with or without you.',
  'Use the van console to open doors and watch for blips near your crew.',
  'Crouch (C) to move quietly. Sprinting is loud.',
  'Press F3 for the performance panel.',
];

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function LoadingScreen({ view }: { view: Signal<LoadingView> }) {
  const v = view.value;
  const [now, setNow] = useState(() => performance.now());
  const [tip, setTip] = useState(() => Math.floor((performance.now() / 1000) % TIPS.length));
  useEffect(() => {
    if (!v.visible) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => { setNow(performance.now()); t = setTimeout(loop, 250); };
    t = setTimeout(loop, 250);
    const tt = setInterval(() => setTip((x) => (x + 1) % TIPS.length), 6500);
    return () => { clearTimeout(t); clearInterval(tt); };
  }, [v.visible]);
  if (!v.visible) return null;
  const cur = STEPS.findIndex((s) => s.id === v.step);
  const stepLabel = v.step === 'ready' ? 'Ready' : (STEPS[cur]?.label ?? 'Loading');
  const pct = Math.max(0, Math.min(100, v.pct));
  return (
    <div class={`ld-root${v.fading ? ' ld-fade' : ''} ld-${v.kind}`} data-testid="loading-screen" data-loading-active="" data-step={v.step} data-pct={pct.toFixed(0)}>
      <div class="ld-static" />
      <div class="ld-scan" />
      <div class="ld-vignette" />
      <header class="ld-top">
        <span><i class="ld-dot" />{v.kind === 'join' ? 'CH 07 · 104.7 MHz · ACQUIRING SIGNAL' : 'VAN 9 · ON SITE · SETTING UP'}</span>
        <span>{v.crew ? `CREW ${v.crew}` : 'NIGHT SHIFT SALVAGE'}</span>
      </header>
      <div class="ld-center">
        <div class="ld-kicker">{v.kind === 'join' ? 'THE COMPANY PRESENTS' : 'ARRIVING'}</div>
        <h1 class="ld-title" data-text="DEAD AIR"><span>DEAD AIR</span></h1>
        {v.site && <div class="ld-site">{v.site}</div>}
        <div class="ld-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ transform: `scaleX(${(pct / 100).toFixed(3)})` }} />
          <b class="ld-sweep" />
        </div>
        <div class="ld-row">
          <span class="ld-step" data-testid="loading-step">{stepLabel}…</span>
          <span class="ld-detail">{v.detail}</span>
          <span class="ld-time">{Math.round(pct)}% · {fmtTime(now - v.t0)}</span>
        </div>
        <ol class="ld-steps">
          {STEPS.map((s, i) => (
            <li key={s.id} class={i < cur || v.step === 'ready' ? 'done' : i === cur ? 'on' : ''}>{s.label}</li>
          ))}
        </ol>
      </div>
      <footer class="ld-tip"><span class="ld-tip-k">TIP</span><span key={tip} class="ld-tip-t">{TIPS[tip]}</span></footer>
    </div>
  );
}
