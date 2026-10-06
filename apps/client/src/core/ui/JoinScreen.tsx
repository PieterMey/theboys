// Minimal Join screen: name, crew code (URL hash) or "Create crew" (dev / admin), Join.
// The click unlocks the AudioContext and fires bus 'join:click' synchronously (user gesture), then net.join().
// Tracks add sections (mic picker, consent) with ctx.ui.registerHud('join', Component).
import { useState } from 'preact/hooks';
import type { ScreenProps } from './api.ts';
import { JoinError } from '../net.ts';

export function JoinScreen({ ctx }: ScreenProps) {
  const id = ctx.net.identity();
  const [name, setName] = useState(id.name);
  const [code, setCode] = useState((ctx.world.crew?.code ?? location.hash.replace(/^#/, '').split('&')[0]).toUpperCase());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canCreate = ctx.build === 'dev' || !!ctx.net.adminToken();
  const extras = ctx.ui.huds.value.filter((h) => h.slot === 'join');

  const join = (crew: string) => {
    const nm = name.trim().slice(0, 16) || id.name;
    ctx.audio.unlock();
    ctx.bus.emit('join:click', { crew, name: nm });
    setBusy(true);
    setErr('');
    ctx.net
      .join(crew, nm)
      .then((w) => {
        history.replaceState(null, '', `${location.pathname}${location.search}#${w.crew.code}`);
        ctx.ui.setScreen('none');
      })
      .catch((e: unknown) => setErr(e instanceof JoinError ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <form class="panel join" onSubmit={(e) => { e.preventDefault(); if (code) join(code); }}>
      <h1 class="title">DEAD AIR</h1>
      <p class="sub">NIGHT SHIFT SALVAGE · THE COMPANY APPRECIATES YOUR DISCRETION</p>
      <label>
        <span>CALLSIGN</span>
        <input value={name} maxLength={16} autoComplete="off" spellcheck={false} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        <span>CREW CODE</span>
        <input value={code} maxLength={8} autoComplete="off" spellcheck={false} placeholder="BKRT" onInput={(e) => setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
      </label>
      {extras.map((h) => <h.comp key={h.id} ctx={ctx} />)}
      <div class="row">
        <button type="submit" class="btn primary" disabled={busy || !code}>{busy ? 'CONNECTING…' : 'JOIN CREW'}</button>
        {canCreate && <button type="button" class="btn" disabled={busy} onClick={() => join('')}>CREATE CREW</button>}
      </div>
      {err && <p class="error">{err}</p>}
      <p class="fine">Chrome or Edge · wired headset · the monsters hear what your friends hear</p>
    </form>
  );
}
