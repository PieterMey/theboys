// Owner: track (d) Meta. Van hub HUD: crew list (voice badges, ready), shift panel, Discord banner, interact prompt, hints.
import { useEffect, useState } from 'preact/hooks';
import type { HudProps } from '../core/ui/api.ts';
import type { ClientContext } from '../core/context.ts';
import { MATERIAL_LABEL, MATERIAL_TYPES } from '@dead-air/shared/catalog.ts';
import { isLeader, mePub, metaOf, onSettings, ordersOf, settings, useTicker, useWorldV } from './state.ts';
import { metaSlice } from './nav.ts';

type PeerInfo = { state: string; candidate: string; name: string; band: number; gain: number };
type VoiceKind = 'you' | 'direct' | 'relay' | 'failed' | 'wait' | 'nomic';

function voicePeers(ctx: ClientContext): Record<string, PeerInfo> | null {
  const v = ctx.services.use('voice') as unknown as { peers?(): Record<string, PeerInfo> } | undefined;
  try { return v?.peers?.() ?? null; } catch { return null; }
}

export function voiceKind(p: PeerInfo | undefined): VoiceKind {
  if (!p) return 'wait';
  const st = String(p.state).toLowerCase();
  if (st === 'failed' || st === 'closed' || st === 'disconnected') return 'failed';
  if (st === 'connected' || st === 'completed') return p.candidate === 'relay' ? 'relay' : 'direct';
  return 'wait';
}

const KIND_LABEL: Record<VoiceKind, string> = { you: 'YOU', direct: 'DIRECT', relay: 'RELAY', failed: 'NO VOICE', wait: 'LINKING', nomic: 'NO MIC' };

export function crewVoice(ctx: ClientContext): { kinds: Record<string, VoiceKind>; others: number; linked: number; failed: number } {
  const peers = voicePeers(ctx);
  const kinds: Record<string, VoiceKind> = {};
  let others = 0;
  let linked = 0;
  let failed = 0;
  for (const p of ctx.world.crew?.players ?? []) {
    if (p.id === ctx.world.me) { kinds[p.id] = 'you'; continue; }
    if (!p.connected) continue;
    others++;
    const k = voiceKind(peers?.[p.id]);
    kinds[p.id] = k;
    if (k === 'direct' || k === 'relay') linked++;
    if (k === 'failed') failed++;
  }
  return { kinds, others, linked, failed };
}

export function HubCrew({ ctx }: HudProps) {
  useWorldV(ctx);
  useTicker(500);
  const [copied, setCopied] = useState('');
  if (ctx.world.phase !== 'hub' || !ctx.world.crew || ctx.net.status !== 'joined') return null;
  const crew = ctx.world.crew;
  const meta = metaOf(ctx);
  const me = mePub(ctx);
  const { kinds } = crewVoice(ctx);
  const picked = ordersOf(ctx).find((o) => o.id === meta?.picked) ?? null;
  const notReady = crew.players.filter((p) => p.connected && !p.ready);
  const toggleReady = () => {
    void ctx.net.req('meta.ready', { ready: !me?.ready }).catch(() => ctx.net.req('crew.ready', { ready: !me?.ready }));
  };
  const invite = async () => {
    let url = `${location.origin}/#${crew.code}`;
    try {
      const r = await fetch(`/api/invite?code=${crew.code}`);
      if (r.ok) {
        const j = (await r.json()) as { url?: string | null };
        if (j.url) url = j.url;
      }
    } catch { /* local fallback */ }
    try {
      await navigator.clipboard.writeText(url);
      setCopied('COPIED');
    } catch {
      setCopied(url);
    }
    setTimeout(() => setCopied(''), 2500);
  };
  return (
    <div class="m-hud-crew">
      <h4>
        <span>CREW {crew.code}</span>
        <small>{crew.players.filter((p) => p.connected).length}/{crew.maxPlayers}</small>
      </h4>
      {crew.players.filter((p) => p.connected || p.id === ctx.world.me).map((p) => {
        const k = kinds[p.id] ?? 'wait';
        return (
          <div class="m-crew-row" key={p.id}>
            <span class="m-dot" style={{ color: p.profile.visor.color, background: p.profile.visor.color }} />
            <span class="m-crew-name">
              {p.isLeader ? '★ ' : ''}{p.name}
              <small>L{meta?.careers?.[p.id]?.level ?? p.level}{!p.consent.transcribe ? ' · LOUD ONLY' : ''}</small>
            </span>
            <span class={`m-badge ${k}`}>{KIND_LABEL[k]}</span>
            <span class={`m-ready ${p.ready ? 'on' : 'off'}`}>{p.ready ? 'READY' : '· · ·'}</span>
          </div>
        );
      })}
      {picked && (
        <div class="m-small" style={{ marginTop: '8px', color: '#c9c5ba' }}>
          <span class="m-amber">ORDER:</span> {picked.siteName.toUpperCase()}
          {notReady.length ? <span class="m-dim"> · waiting for {notReady.map((p) => p.name).join(', ')}</span> : <span class="m-green"> · rolling out</span>}
        </div>
      )}
      {!picked && <div class="m-small m-dim" style={{ marginTop: '8px' }}>{isLeader(ctx) ? 'Pick a work order at the board [B].' : 'The leader picks a work order at the board.'}</div>}
      <div class="m-hud-actions">
        <button class={`m-btn ${me?.ready ? 'go' : 'primary'}`} onClick={toggleReady}>{me?.ready ? 'READY ✓' : 'READY UP [R]'}</button>
        <button class="m-btn" onClick={() => void invite()}>{copied ? (copied.length > 12 ? 'SEE BELOW' : copied) : 'COPY INVITE'}</button>
      </div>
      {copied.length > 12 && <div class="m-small" style={{ marginTop: '6px', userSelect: 'text', wordBreak: 'break-all' }}>{copied}</div>}
      <div class="m-keyline"><span><span class="m-keys">B</span> board</span><span><span class="m-keys">R</span> ready</span><span><span class="m-keys">E</span> use</span><span><span class="m-keys">ESC</span> menu</span></div>
    </div>
  );
}

export function HubShift({ ctx }: HudProps) {
  useWorldV(ctx);
  const meta = metaOf(ctx);
  if (ctx.world.phase !== 'hub' || !meta || ctx.net.status !== 'joined') return null;
  const sh = meta.shift;
  const per = sh.contractsPerShift ?? 3;
  const pct = sh.quota > 0 ? Math.min(100, (sh.hauled / sh.quota) * 100) : 0;
  // v1.2 workshop: crew stash chips (materials in the van locker)
  const stash = MATERIAL_TYPES.filter((m) => (meta.stash?.[m] ?? 0) > 0);
  return (
    <div class="m-hud-shift">
      <div class="m-kicker">SHIFT {sh.index + 1} · CONTRACT {Math.min(sh.contract + 1, per)}/{per}</div>
      <div class="big" style={{ marginTop: '6px' }}>{sh.hauled} <span class="m-dim" style={{ fontSize: '16px' }}>/ {sh.quota} QUOTA</span></div>
      <div class="m-quota-bar"><i style={{ width: `${pct}%` }} /></div>
      <div class="m-small"><span class="m-dim">SCRIP</span> <b class="m-amber">{sh.balance}</b> <span class="m-dim">· QUOTAS MET</span> {sh.quotasMet}</div>
      {meta.terms && (
        <div class="cl-deal" data-testid="hub-deal">
          COMPANY LINE · <b>{meta.terms.outcome === 'missed' ? 'MISSED' : 'DEAL'}</b> QUOTA {meta.terms.quotaPct > 0 ? '+' : meta.terms.quotaPct < 0 ? '−' : '±'}{Math.abs(meta.terms.quotaPct)}%
          {meta.terms.payoutPct ? ` · PAYOUT +${meta.terms.payoutPct}%` : ''}{meta.terms.bonus ? ` · HAZARD +${meta.terms.bonus}` : ''}{meta.terms.conditions.length ? ` · ${meta.terms.conditions.join(' · ')}` : ''}
        </div>
      )}
      {stash.length > 0 && (
        <div class="m-stash-chips" data-testid="hub-stash">
          <span class="m-dim">STASH</span>
          {stash.map((m) => <span key={m} class={`m-chip mat ${m.slice(4)}`}>{MATERIAL_LABEL[m].toUpperCase()} {meta.stash![m]}</span>)}
        </div>
      )}
    </div>
  );
}

export function HubBanner({ ctx }: HudProps) {
  useWorldV(ctx);
  useTicker(700);
  if (ctx.world.phase !== 'hub' || !ctx.world.crew || ctx.net.status !== 'joined') return null;
  const meta = metaOf(ctx);
  const hold = meta?.holdUntil && meta.holdUntil > ctx.world.serverNow();
  if (hold) {
    const sec = Math.max(0, (meta!.holdUntil! - ctx.world.serverNow()) / 1000);
    return <div class="m-drive-hold">LEADER IS STARTING THE VAN · {sec.toFixed(1)} s</div>;
  }
  const v = crewVoice(ctx);
  if (v.others === 0) return null;
  if (v.linked === v.others) {
    return (
      <div class="m-banner">
        <b>Everyone connected</b>
        <span>LEAVE DISCORD VOICE NOW · the game's voice is positional and the monsters hear it</span>
      </div>
    );
  }
  return (
    <div class="m-banner wait">
      <b>Voice linking {v.linked}/{v.others}</b>
      <span>{v.failed ? `${v.failed} friend${v.failed > 1 ? 's' : ''} without voice: reload or switch to Chrome` : 'stay in Discord until everyone shows DIRECT or RELAY'}</span>
    </div>
  );
}

const PROMPTS: Record<string, string> = { board: 'WORK ORDERS', shop: 'COMPANY STORE', mirror: 'LOCKER MIRROR · CHANGE YOUR LOOK', kennel: 'TRAINING KENNEL · CALIBRATE MIC', console: 'VAN CONSOLE' };

export function HubPrompt({ ctx }: HudProps) {
  useWorldV(ctx);
  const near = metaSlice(ctx).near;
  if (!near || ctx.ui.screen.value.name !== 'none') return null;
  if (metaOf(ctx)?.serverInteract && near.kind !== 'kennel') return null; // (b) shows its own prompt
  return (
    <div class="m-prompt">
      <span class="m-keys">E</span>{PROMPTS[near.kind] ?? near.kind.toUpperCase()}
    </div>
  );
}

/** van key hints (R is handled once, in meta/index.ts); hidden by the 'Gameplay hints' setting */
export function HubHints({ ctx }: HudProps) {
  useWorldV(ctx);
  const [on, setOn] = useState(settings().hints);
  useEffect(() => onSettings(() => setOn(settings().hints)), []);
  if (!on || ctx.world.phase !== 'hub' || ctx.net.status !== 'joined' || ctx.ui.screen.value.name !== 'none') return null;
  const desktop = !!(window as unknown as { deadAirDesktop?: unknown }).deadAirDesktop;
  return (
    <div class="m-hints">
      <span><span class="m-keys">B</span> WORK ORDERS</span>
      <span><span class="m-keys">R</span> READY</span>
      <span><span class="m-keys">E</span> USE</span>
      <span><span class="m-keys">{desktop ? 'C / L-CTRL' : 'C'}</span> CROUCH</span>
      <span><span class="m-keys">ESC</span> MENU · HOW TO PLAY</span>
    </div>
  );
}
