// Owner: track ④ Voice. /voicetest: lightweight voice-link test page (no WebGPU, no pointer lock, phone-friendly).
// Enter the crew code -> joins the crew as player 'voicetest' (own identity, so it never kicks your game tab),
// joins the voice mesh, and shows each peer's ICE path (direct / relay / failed), bytes and live levels.
// Everyone is heard 2D and ungated here; game clients also hear the 'voicetest' peer 2D (link test only).
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { createClientContext } from '../../core/context.ts';
import { install as installVoice } from '../index.ts';

// separate identity: the game tab on the same browser keeps its own player key
const ALIAS: Record<string, string> = { 'deadair.key': 'deadair.vt.key', 'deadair.name': 'deadair.vt.name', 'deadair.profile': 'deadair.vt.profile' };
try {
  const get = Storage.prototype.getItem;
  const set = Storage.prototype.setItem;
  Storage.prototype.getItem = function (k: string) { return get.call(this, ALIAS[k] ?? k); };
  Storage.prototype.setItem = function (k: string, v: string) { set.call(this, ALIAS[k] ?? k, v); };
} catch { /* storage unavailable */ }

const ctx = createClientContext();
installVoice(ctx, { mode: 'voicetest' });

const pathOf = (state: string, cand: string): { cls: string; text: string } => {
  if (state === 'failed') return { cls: 'failed', text: 'FAILED' };
  if (state !== 'connected') return { cls: 'pending', text: state.toUpperCase() };
  if (cand === 'relay') return { cls: 'relay', text: 'RELAY (TURN)' };
  if (cand === 'none') return { cls: 'pending', text: 'CONNECTED' };
  return { cls: 'direct', text: `DIRECT (${cand})` };
};

function App() {
  const [code, setCode] = useState(ctx.hashCrew || '');
  const [status, setStatus] = useState(ctx.net.status as string);
  const [err, setErr] = useState('');
  const [, setTick] = useState(0);
  const [relay, setRelay] = useState(ctx.services.use('voice')?.relayOnly() ?? false);
  useEffect(() => {
    const off = ctx.net.onStatus((s) => setStatus(s));
    let alive = true;
    const loop = () => { if (!alive) return; setTick((x) => x + 1); setTimeout(loop, 150); };
    loop();
    return () => { alive = false; off(); };
  }, []);
  const v = ctx.services.use('voice');
  const dbg = window.__voiceDebug as unknown as { inRms(): Record<string, number> } | undefined;
  const join = () => {
    const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!c) return;
    setErr('');
    ctx.audio.unlock();
    void v?.startMic();
    ctx.net.join(c, 'voicetest').then(
      () => history.replaceState(null, '', `${location.pathname}#${c}`),
      (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
    );
  };
  const peers = v?.peers() ?? {};
  const inRms = dbg?.inRms?.() ?? {};
  const lvl = v?.level();
  const meK = lvl ? Math.max(0, Math.min(1, (lvl.db + 70) / 65)) : 0;
  const joined = status === 'joined';
  return (
    <>
      <h1>DEAD AIR</h1>
      <p class="sub">VOICE LINK TEST · {ctx.build === 'dev' ? 'DEV' : 'LIVE'}</p>
      <div class="card">
        <div class="row">
          <input type="text" value={code} maxLength={8} placeholder="CREW" autoComplete="off" spellcheck={false}
            onInput={(e) => setCode(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
          <button type="button" disabled={!code || status === 'connecting'} onClick={join}>{joined ? 'REJOIN' : 'JOIN VOICE'}</button>
        </div>
        <p class="muted">Status: {status}{joined ? ` · rtt ${Math.round(ctx.net.rtt)} ms` : ''}{err ? ` · ${err}` : ''}</p>
        <label class="muted">
          <input type="checkbox" checked={relay} onChange={(e) => { const on = e.currentTarget.checked; setRelay(on); v?.setRelayOnly(on); }} />
          force relay (TURN only: tests the relay path, hides your IP)
        </label>
      </div>
      <div class="card">
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <strong>YOUR MIC</strong>
          <span class="muted">{v?.hasMic() ? `${lvl ? lvl.db.toFixed(0) : '-'} dBFS · band ${lvl?.band ?? 0}` : v?.micError() ?? 'not started'}</span>
        </div>
        <div class="bar" style={{ marginTop: '6px' }}><div style={{ width: `${meK * 100}%` }} /></div>
      </div>
      <div class="card">
        <strong>PEERS ({Object.keys(peers).length})</strong>
        {Object.keys(peers).length === 0 && <p class="muted">{joined ? 'Nobody else in this crew yet.' : 'Join a crew to see peers.'}</p>}
        <div>
          {Object.entries(peers).map(([id, p]) => {
            const path = pathOf(p.state, p.candidate);
            const r = inRms[id] ?? 0;
            const k = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-6, r)) + 70) / 60));
            return (
              <div class="peer" key={id}>
                <span>{p.name}</span>
                <span class={`badge ${path.cls}`}>{path.text}</span>
                <span class="muted">band {p.band < 0 ? '-' : p.band} · in {(20 * Math.log10(Math.max(1e-6, r))).toFixed(0)} dBFS</span>
                <span />
                <div class="bar"><div style={{ width: `${k * 100}%`, background: path.cls === 'relay' ? '#f0b43c' : '#7fd17f' }} /></div>
              </div>
            );
          })}
        </div>
      </div>
      <p class="muted">Tip: on mobile data this proves the TURN relay works. Use headphones to avoid echo.</p>
    </>
  );
}

render(<App />, document.getElementById('app')!);

// ?autojoin=1#CODE (tests / reloads): join without a tap. Phones still need a tap for audio (autoplay policy).
if (ctx.params.get('autojoin') === '1' && ctx.hashCrew) {
  ctx.audio.unlock();
  void ctx.services.use('voice')?.startMic();
  void ctx.net.join(ctx.hashCrew, 'voicetest').catch(() => {});
}
