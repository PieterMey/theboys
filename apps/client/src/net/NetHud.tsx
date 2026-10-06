// Owner: track ① Net. Top-right lobby/connection widget: link status + RTT, crew code + COPY INVITE, player count.
// Also the error screens (stale build -> reload, kicked, unknown crew, lost connection).
import { useEffect, useState } from 'preact/hooks';
import type { HudProps, ScreenProps } from '../core/ui/api.ts';
import { useWorld } from '../core/ui/App.tsx';
import './net.css';

const STATUS_LABEL: Record<string, string> = {
  idle: 'OFFLINE', connecting: 'CONNECTING', open: 'HANDSHAKE', joined: 'LINK', reconnecting: 'RECONNECTING', failed: 'NO LINK',
};

export async function inviteLink(code: string): Promise<{ url: string; tunnel: boolean }> {
  try {
    const r = await fetch(`/api/invite?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (r.ok) {
      const j = (await r.json()) as { url?: string | null };
      if (typeof j.url === 'string' && j.url) return { url: j.url, tunnel: true };
    }
  } catch { /* server without the route */ }
  return { url: `${location.origin}/#${code}`, tunnel: false };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback for non-secure contexts
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

export function NetHud({ ctx }: HudProps) {
  useWorld(ctx);
  const [, setTick] = useState(0);
  const [copied, setCopied] = useState('');
  const [roster, setRoster] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    const off = ctx.net.onStatus(() => setTick((n) => n + 1));
    return () => { clearInterval(t); off(); };
  }, [ctx]);
  const status = ctx.net.status;
  const crew = ctx.world.crew;
  if (status === 'idle' && !crew) return null;
  const rtt = Math.round(ctx.net.rtt);
  const stat = ctx.services.use('netstat');
  const jitter = stat ? Math.round(stat.jitterMs) : 0;
  const quality = status !== 'joined' ? 'bad' : rtt > 180 || jitter > 120 ? 'bad' : rtt > 90 || jitter > 50 ? 'warn' : 'good';
  const online = crew?.players.filter((p) => p.connected).length ?? 0;
  const max = crew?.maxPlayers ?? 6;
  const code = crew?.code ?? ctx.net.crewCode ?? '';
  const meId = ctx.net.me;
  // another lobby panel (meta's hub UI) already shows the crew code + invite: keep only the link row then
  const otherInvite = typeof document !== 'undefined' && [...document.querySelectorAll('button')].some((b) => !b.closest('.nethud') && /COPY INVITE/i.test(b.textContent ?? ''));
  const canKick = !!ctx.net.adminToken() || crew?.players.some((p) => p.id === meId && p.isLeader) === true;
  const kick = (id: string, name: string) => {
    ctx.net.req('crew.kick', { id }).then(
      () => ctx.ui.toast(`${name} removed`, 'warn'),
      (e: unknown) => ctx.ui.toast(`kick failed: ${e instanceof Error ? e.message : e}`, 'error'),
    );
  };

  const copy = async (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (!code) return;
    const { url, tunnel } = await inviteLink(code);
    const ok = await copyText(url);
    setCopied(ok ? (tunnel ? 'COPIED' : 'COPIED (LOCAL)') : 'COPY FAILED');
    ctx.ui.toast(ok ? (tunnel ? `Invite copied: ${url}` : `No tunnel running: copied the local link ${url}`) : `Invite: ${url}`, ok && tunnel ? 'info' : 'warn', 5000);
    setTimeout(() => setCopied(''), 2500);
  };

  return (
    <div class="nethud" data-testid="nethud">
      <div class={`nethud-row nethud-${quality}`}>
        <span class="nethud-dot" />
        <span class="nethud-status">{STATUS_LABEL[status] ?? status.toUpperCase()}</span>
        {status === 'joined' && <span class="nethud-rtt">{rtt} MS</span>}
      </div>
      {code && !otherInvite && (
        <div class="nethud-row">
          <span class="nethud-label">CREW</span>
          <span class="nethud-code">{code}</span>
          <button type="button" class="nethud-count nethud-link" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRoster(!roster); }} title="Crew roster">{online}/{max}</button>
          <button type="button" class="nethud-btn" onClick={(e) => void copy(e)} title="Copy the invite link">{copied || 'COPY INVITE'}</button>
        </div>
      )}
      {roster && crew && !otherInvite && (
        <div class="nethud-roster" data-testid="nethud-roster">
          {crew.players.map((p) => (
            <div key={p.id} class={`nethud-player${p.connected ? '' : ' nethud-off'}`}>
              <span>{p.isLeader ? '★ ' : ''}{p.name}{p.id === meId ? ' (you)' : ''}</span>
              <span class="nethud-pstate">{p.connected ? (p.ready ? 'READY' : '') : 'AWAY'}</span>
              {canKick && p.id !== meId && <button type="button" class="nethud-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); kick(p.id, p.name); }}>KICK</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ERR_TEXT: Record<string, { title: string; body: string; reload?: boolean }> = {
  stale_build: { title: 'NEW VERSION', body: 'The host just updated the game. Reload to rejoin your crew.', reload: true },
  kicked: { title: 'DISCONNECTED', body: 'You were removed from the crew.' },
  unknown_crew: { title: 'NO SUCH CREW', body: 'That crew code does not exist on this server. Check the code with your host.' },
  crew_full: { title: 'CREW FULL', body: 'This crew is full.' },
  bad_password: { title: 'WRONG PASSWORD', body: 'The crew password was not accepted.' },
  bad_version: { title: 'NEW VERSION', body: 'The server runs a newer protocol. Reload the page.', reload: true },
  lost: { title: 'CONNECTION LOST', body: 'The link to the host dropped. Retrying automatically.' },
};

export function NetErrorScreen({ ctx, code, msg }: ScreenProps) {
  const c = String(code ?? 'server');
  const t = ERR_TEXT[c] ?? { title: 'CONNECTION ERROR', body: 'The server refused the connection.' };
  const detail = typeof msg === 'string' && msg && c !== 'stale_build' ? msg : '';
  return (
    <div class="panel neterr" data-testid="net-error" data-code={c}>
      <h1 class="title neterr-title">{t.title}</h1>
      <p class="neterr-body">{t.body}</p>
      {detail && <p class="neterr-detail">{detail}</p>}
      <div class="row">
        {t.reload || c === 'kicked' || c === 'unknown_crew' ? (
          <button type="button" class="btn primary" onClick={() => location.reload()}>{t.reload ? 'RELOAD' : 'BACK TO JOIN'}</button>
        ) : (
          <button type="button" class="btn primary" onClick={() => ctx.ui.setScreen('join')}>BACK</button>
        )}
      </div>
    </div>
  );
}
