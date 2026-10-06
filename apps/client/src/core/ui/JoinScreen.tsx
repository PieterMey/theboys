// Join panel: name, crew code (URL hash) or "Create crew" (dev / admin), Join.
// The click unlocks the AudioContext and fires bus 'join:click' synchronously (user gesture), then net.join().
// Tracks add sections (mic picker, consent) with ctx.ui.registerHud('join', Component).
// Standalone it is the bare 'join' screen (fallback, ?autojoin=1); the menu track (apps/client/src/menu) wraps it as
// the PLAY sub-panel of the main menu (embedded: no title, BACK button, onEntering for the transition overlay).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ScreenProps } from './api.ts';
import { JoinError } from '../net.ts';

/** Resolves once rendering is smooth (first frames after a new scene compile shaders and can stall for seconds).
 * Keeps the (already painted) Join screen up during that stall instead of showing a frozen scene. */
export function waitForStableFrames(minMs = 500, maxMs = 8000, needGood = 12): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0;
    let good = 0;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    // hard cap on a timer too: rAF stops in a background tab and is starved while shaders compile
    setTimeout(finish, maxMs);
    const tick = (now: number) => {
      if (done) return;
      const dt = now - last;
      last = now;
      good = dt < 60 ? good + 1 : 0;
      if ((now - t0 > minMs && good >= needGood) || now - t0 > maxMs) finish();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** crew code from the URL hash ('#CODE' or '#CODE&...') */
export function hashCode(): string {
  return location.hash.replace(/^#/, '').split('&')[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export interface JoinPanelProps extends ScreenProps {
  /** rendered inside the main menu: no big title / footer line */
  embedded?: boolean;
  onBack?: () => void;
  /** the join succeeded; the scene is warming up (waitForStableFrames) */
  onEntering?: () => void;
  /** called on hover/focus of the buttons (menu UI sound) */
  onHover?: () => void;
}

export function JoinScreen(props: ScreenProps) {
  const { ctx, embedded, onBack, onEntering, onHover } = props as JoinPanelProps;
  const id = ctx.net.identity();
  const [name, setName] = useState(id.name);
  const [code, setCode] = useState((ctx.world.crew?.code ?? hashCode()).toUpperCase());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [entering, setEntering] = useState(false);
  /** the join failed in a way only a reload fixes (timeout, client error while entering) */
  const [reload, setReload] = useState(false);
  const canCreate = ctx.build === 'dev' || !!ctx.net.adminToken();
  const extras = ctx.ui.huds.value.filter((h) => h.slot === 'join');
  const nameRef = useRef<HTMLInputElement>(null);
  const joinRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!embedded) return;
    // invite link: the code is there, Enter joins; otherwise start at the callsign
    if (code) joinRef.current?.focus();
    else nameRef.current?.focus();
  }, []);

  const join = (crew: string) => {
    const nm = name.trim().slice(0, 16) || id.name;
    ctx.audio.unlock();
    ctx.bus.emit('join:click', { crew, name: nm });
    setBusy(true);
    setErr('');
    setReload(false);
    ctx.net
      .join(crew, nm)
      .then((w) => {
        history.replaceState(null, '', `${location.pathname}${location.search}#${w.crew.code}`);
        setEntering(true);
        onEntering?.();
        // v1.1: the loading screen (apps/client/src/loading) covers the hub build, downloads and shader warm-up and
        // shows real progress; without it, the old stable-frames wait (capped at 8 s)
        const loading = ctx.services.use('loading');
        return (loading ? loading.untilReady() : waitForStableFrames(500, 8000, 12)).then(() => ctx.ui.setScreen('none'));
      })
      .catch((e: unknown) => {
        ctx.services.use('loading')?.cancel();
        setErr(e instanceof JoinError ? e.message : String(e));
        setReload(e instanceof JoinError && (e.code === 'closed' || e.code === 'server') && /reload/i.test(e.message));
      })
      .finally(() => setBusy(false));
  };

  return (
    <form class={`panel join${embedded ? ' join-embedded' : ''}`} data-testid="join-panel" onSubmit={(e) => { e.preventDefault(); if (code) join(code); }}>
      {!embedded && <h1 class="title">DEAD AIR</h1>}
      {!embedded && <p class="sub">NIGHT SHIFT SALVAGE · THE COMPANY APPRECIATES YOUR DISCRETION</p>}
      <label>
        <span>CALLSIGN</span>
        <input ref={nameRef} value={name} maxLength={16} autoComplete="off" spellcheck={false} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        <span>CREW CODE</span>
        <input value={code} maxLength={8} autoComplete="off" spellcheck={false} placeholder="BKRT" onInput={(e) => setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
      </label>
      {extras.map((h) => <h.comp key={h.id} ctx={ctx} />)}
      <div class="join-actions">
        {embedded && err && <p class="error" data-testid="join-error">{err}</p>}
        <div class="row">
          <button ref={joinRef} type="submit" class="btn primary" disabled={busy || !code} onMouseEnter={onHover} onFocus={onHover}>{entering ? 'ENTERING THE LOT…' : busy ? 'CONNECTING…' : 'JOIN CREW'}</button>
          {canCreate && <button type="button" class="btn" disabled={busy} onMouseEnter={onHover} onFocus={onHover} onClick={() => join('')}>CREATE CREW</button>}
        </div>
        {!embedded && err && <p class="error" data-testid="join-error">{err}</p>}
        {err && reload && <button type="button" class="btn" data-testid="join-reload" onClick={() => location.reload()}>RELOAD</button>}
        {entering && !ctx.services.use('loading') && <p class="fine" data-testid="join-status">Warming up shaders… a few seconds on the first entry.</p>}
        {embedded && onBack && <button type="button" class="btn join-back" disabled={busy || entering} onMouseEnter={onHover} onClick={onBack}>BACK [ESC]</button>}
      </div>
      {!embedded && <p class="fine">Chrome or Edge · wired headset · the monsters hear what your friends hear</p>}
    </form>
  );
}
