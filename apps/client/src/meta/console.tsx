// Owner: track (d) Meta. Van console (PLAN §1.4, §4.11): the only full map. Rooms with callsigns, doors by state (click
// security doors to toggle via (b) 'interaction.consoleDoor'), live player dots, vault code from (a)'s slice, monster blips
// only within 6 m of a living player, a SIGNAL SPIKE within one room of the Listener, the INTERCEPT log, radio indicator.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ScreenProps } from '../core/ui/api.ts';
import type { ClientContext } from '../core/context.ts';
import type { LevelLayout, LayoutDoor } from '@dead-air/shared/layout.ts';
import type { DoorState } from '@dead-air/shared/messages/interaction.ts';
import { clockLabel, sfx, useTicker, useWorldV } from './state.ts';
import { closeScreen, metaSlice } from './nav.ts';

interface ObjLike {
  code?: string;
  power?: Record<number, boolean>;
  vaultOpen?: boolean;
  coreState?: string;
  hauled?: number;
  lootTotal?: number;
  startedAt?: number;
  realSec?: number;
  clockMin?: number;
  blackout?: boolean;
  salvage?: { count: number; total: number; value: number };
  dead?: string[];
}

export interface ConsoleMirror {
  doors: Record<number, DoorState>;
  dead: string[];
  obj: ObjLike | null;
}

/** client-side mirror of (b) door state + (a) objectives (kept by index.ts from events) */
export function consoleMirror(ctx: ClientContext): ConsoleMirror {
  const s = metaSlice(ctx) as unknown as { console?: ConsoleMirror };
  s.console ??= { doors: {}, dead: [], obj: null };
  return s.console;
}

export function resetMirror(ctx: ClientContext): void {
  const m = consoleMirror(ctx);
  const ix = ctx.world.full?.interaction;
  m.doors = ix?.doors ? { ...ix.doors } : {};
  m.dead = ix?.dead ? [...ix.dead] : [];
  m.obj = (ctx.world.full?.objectives as unknown as ObjLike | null) ?? null;
}

interface View { s: number; ox: number; oy: number }

function fit(L: LevelLayout, w: number, h: number): View {
  const pad = 36;
  const s = Math.max(2, Math.min((w - pad * 2) / L.W, (h - pad * 2 - 30) / L.H));
  return { s, ox: (w - L.W * s) / 2, oy: (h - L.H * s) / 2 + 12 };
}

function doorSeg(d: LayoutDoor): [number, number, number, number] {
  return d.dir === 'v' ? [d.x, d.y, d.x, d.y + d.len] : [d.x, d.y, d.x + d.len, d.y];
}

function spaceAt(L: LevelLayout, x: number, z: number): number {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return -1;
  return L.owner[cz * L.W + cx] ?? -1;
}

/** static floor plan (cells, walls, labels) */
function drawStatic(L: LevelLayout, w: number, h: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const v = fit(L, w, h);
  // faint grid
  g.strokeStyle = 'rgba(60, 120, 70, 0.07)';
  g.lineWidth = 1;
  for (let x = 0; x <= L.W; x += 2) { g.beginPath(); g.moveTo(v.ox + x * v.s, v.oy); g.lineTo(v.ox + x * v.s, v.oy + L.H * v.s); g.stroke(); }
  for (let y = 0; y <= L.H; y += 2) { g.beginPath(); g.moveTo(v.ox, v.oy + y * v.s); g.lineTo(v.ox + L.W * v.s, v.oy + y * v.s); g.stroke(); }
  const kind = new Map(L.spaces.map((s) => [s.id, s]));
  const fill: Record<string, string> = { room: '#0a2410', hall: '#0b2a12', corridor: '#06160a', vault: '#2a1a06', outside: '#04090a' };
  for (let y = 0; y < L.H; y++) {
    for (let x = 0; x < L.W; x++) {
      const id = L.owner[y * L.W + x];
      if (id < 0) continue;
      const sp = kind.get(id);
      g.fillStyle = sp ? (sp.type === 'van' ? '#15210f' : (fill[sp.kind] ?? '#081a0c')) : '#081a0c';
      g.fillRect(v.ox + x * v.s, v.oy + y * v.s, v.s + 0.5, v.s + 0.5);
    }
  }
  // walls: edges between different spaces (doors are drawn live on top)
  g.strokeStyle = '#3d8a48';
  g.lineWidth = Math.max(1.5, v.s * 0.12);
  g.lineCap = 'square';
  g.beginPath();
  for (let y = 0; y < L.H; y++) {
    for (let x = 0; x < L.W; x++) {
      const a = L.owner[y * L.W + x];
      const r = x + 1 < L.W ? L.owner[y * L.W + x + 1] : -1;
      const d = y + 1 < L.H ? L.owner[(y + 1) * L.W + x] : -1;
      if (a !== r && (a >= 0 || r >= 0)) { g.moveTo(v.ox + (x + 1) * v.s, v.oy + y * v.s); g.lineTo(v.ox + (x + 1) * v.s, v.oy + (y + 1) * v.s); }
      if (a !== d && (a >= 0 || d >= 0)) { g.moveTo(v.ox + x * v.s, v.oy + (y + 1) * v.s); g.lineTo(v.ox + (x + 1) * v.s, v.oy + (y + 1) * v.s); }
      if (x === 0 && a >= 0) { g.moveTo(v.ox, v.oy + y * v.s); g.lineTo(v.ox, v.oy + (y + 1) * v.s); }
      if (y === 0 && a >= 0) { g.moveTo(v.ox + x * v.s, v.oy); g.lineTo(v.ox + (x + 1) * v.s, v.oy); }
    }
  }
  g.stroke();
  // callsigns
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const sp of L.spaces) {
    if (!sp.callsign) continue;
    const cx = v.ox + (sp.rect.x + sp.rect.w / 2) * v.s;
    const cy = v.oy + (sp.rect.y + sp.rect.h / 2) * v.s;
    const size = Math.max(10, Math.min(20, v.s * Math.min(sp.rect.w, sp.rect.h) * 0.32));
    g.font = `800 ${size}px 'Big Shoulders Stencil Display', 'Bahnschrift', Impact, sans-serif`;
    g.fillStyle = sp.kind === 'vault' ? '#f0b43c' : '#8fe39a';
    g.shadowColor = 'rgba(127, 211, 107, 0.45)';
    g.shadowBlur = 6;
    g.fillText(sp.callsign, cx, cy);
    g.shadowBlur = 0;
  }
  return c;
}

const KIND_COLOR: Record<string, string> = { hound: '#ff4d4d', mannequin: '#ffd84d', listener: '#ff4d4d' };

export function ConsoleScreen({ ctx }: ScreenProps) {
  useWorldV(ctx);
  useTicker(250);
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);
  hoverRef.current = hover;
  const view = useRef<View | null>(null);
  const L = ctx.world.layout;
  const mirror = consoleMirror(ctx);
  const obj = mirror.obj ?? (ctx.world.full?.objectives as unknown as ObjLike | null) ?? null;
  const intercepts = metaSlice(ctx).intercepts;

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !L) return;
    let raf = 0;
    let bg: HTMLCanvasElement | null = null;
    let bgKey = '';
    const trails = new Map<string, { x: number; z: number; t: number }[]>();
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = Math.max(200, r.width);
      const h = Math.max(200, r.height);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const key = `${L.hash}|${w}|${h}|${dpr}`;
      if (key !== bgKey) { bg = drawStatic(L, w, h, dpr); bgKey = key; }
      const v = fit(L, w, h);
      view.current = v;
      const g = cv.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#020403';
      g.fillRect(0, 0, cv.width, cv.height);
      if (bg) g.drawImage(bg, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const P = (x: number, z: number): [number, number] => [v.ox + x * v.s, v.oy + z * v.s];
      const now = performance.now();
      // doors
      for (const d of L.doors) {
        if (d.kind === 'blocked') continue;
        const st = mirror.doors[d.id];
        const open = st ? st.open : d.initiallyOpen || d.kind === 'open';
        const locked = st ? st.locked : d.kind === 'locked';
        const [x1, y1, x2, y2] = doorSeg(d);
        const [a, b] = P(x1, y1);
        const [c, e] = P(x2, y2);
        const sec = d.kind === 'security';
        g.lineCap = 'butt';
        g.lineWidth = sec ? Math.max(4, v.s * 0.38) : Math.max(2.5, v.s * 0.22);
        g.strokeStyle = d.kind === 'open' ? '#06160a' : locked ? '#d23b2e' : open ? (sec ? '#4fd16a' : '#2f7a3c') : sec ? '#f0b43c' : '#b08a2e';
        if (d.kind === 'vault') g.strokeStyle = obj?.vaultOpen ? '#4fd16a' : '#f0b43c';
        g.beginPath();
        g.moveTo(a, b);
        g.lineTo(c, e);
        g.stroke();
        if (sec) {
          const mx = (a + c) / 2;
          const my = (b + e) / 2;
          g.strokeStyle = hoverRef.current === d.id ? '#ffffff' : open ? '#4fd16a' : '#f0b43c';
          g.lineWidth = hoverRef.current === d.id ? 2 : 1.2;
          g.strokeRect(mx - 9, my - 9, 18, 18);
          g.font = "700 9px Consolas, monospace";
          g.fillStyle = g.strokeStyle;
          g.textAlign = 'center';
          g.fillText(open ? 'OPEN' : 'SHUT', mx, my - 14);
        }
      }
      // players
      const dead = new Set(mirror.dead.length ? mirror.dead : (obj?.dead ?? []));
      const living: [number, number][] = [];
      for (const pl of ctx.world.crew?.players ?? []) {
        if (!pl.connected) continue;
        const sp = ctx.world.samplePlayer(pl.id);
        if (!sp) continue;
        const isDead = dead.has(pl.id) || sp.stance === 4;
        if (!isDead) living.push([sp.p[0], sp.p[2]]);
        const [px, py] = P(sp.p[0], sp.p[2]);
        g.fillStyle = isDead ? '#555' : pl.profile.visor.color;
        g.shadowColor = g.fillStyle;
        g.shadowBlur = isDead ? 0 : 10;
        g.beginPath();
        g.arc(px, py, Math.max(4, v.s * 0.32), 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;
        // facing tick
        g.strokeStyle = g.fillStyle;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + Math.sin(sp.yaw) * 11, py + Math.cos(sp.yaw) * 11);
        g.stroke();
        g.font = '700 10px Consolas, monospace';
        g.fillStyle = isDead ? '#777' : '#d9f5dc';
        g.textAlign = 'left';
        g.fillText(`${pl.name}${isDead ? ' (STATIC)' : ''}`, px + 9, py - 8);
      }
      // monster blips: only within 6 m of a living player
      let listenerSpace = -1;
      for (const [id] of ctx.world.monsters) {
        const m = ctx.world.sampleMonster(id);
        if (!m || !m.active) continue;
        if (m.kind === 'listener') listenerSpace = spaceAt(L, m.p[0], m.p[2]);
        const near = living.some(([x, z]) => Math.hypot(x - m.p[0], z - m.p[2]) <= 6);
        if (!near) { trails.delete(id); continue; }
        const tr = trails.get(id) ?? [];
        tr.push({ x: m.p[0], z: m.p[2], t: now });
        while (tr.length && now - tr[0].t > 1600) tr.shift();
        trails.set(id, tr);
        for (const q of tr) {
          const k = 1 - (now - q.t) / 1600;
          const [qx, qy] = P(q.x, q.z);
          g.fillStyle = `rgba(255, 77, 77, ${0.25 * k})`;
          g.beginPath();
          g.arc(qx, qy, 3, 0, Math.PI * 2);
          g.fill();
        }
        const [mx, my] = P(m.p[0], m.p[2]);
        const pulse = 0.5 + 0.5 * Math.sin(now / 140);
        g.fillStyle = KIND_COLOR[m.kind] ?? '#ff4d4d';
        g.shadowColor = g.fillStyle;
        g.shadowBlur = 14;
        g.beginPath();
        g.arc(mx, my, Math.max(4, v.s * 0.36) + pulse * 2, 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;
        g.font = "800 11px 'Big Shoulders Stencil Display', Impact, sans-serif";
        g.textAlign = 'left';
        g.fillText(m.kind.toUpperCase(), mx + 10, my + 4);
      }
      // SIGNAL SPIKE: the Listener's room or a neighbour (changes every 8 s), never its exact position
      if (listenerSpace >= 0) {
        const nb = new Set<number>([listenerSpace]);
        for (const d of L.doors) {
          if (d.a === listenerSpace && d.b >= 0) nb.add(d.b);
          if (d.b === listenerSpace && d.a >= 0) nb.add(d.a);
        }
        const list = [...nb].sort((a, b) => a - b);
        const win = Math.floor(ctx.world.serverNow() / 8000);
        const pick = list[win % list.length] ?? listenerSpace;
        const sp = L.spaces.find((s) => s.id === pick);
        if (sp) {
          const [sx, sy] = P(sp.rect.x + sp.rect.w / 2, sp.rect.y + sp.rect.h / 2);
          const ph = (now % 1400) / 1400;
          g.strokeStyle = `rgba(255, 60, 60, ${1 - ph})`;
          g.lineWidth = 2;
          g.beginPath();
          g.arc(sx, sy, 10 + ph * Math.max(26, v.s * Math.max(sp.rect.w, sp.rect.h) * 0.5), 0, Math.PI * 2);
          g.stroke();
          g.font = "800 13px 'Big Shoulders Stencil Display', Impact, sans-serif";
          g.fillStyle = '#ff5a4d';
          g.textAlign = 'center';
          g.fillText('SIGNAL SPIKE', sx, sy - 16);
        }
      }
      // scanline sweep
      const sweep = ((now / 4200) % 1) * h;
      const grad = g.createLinearGradient(0, sweep - 60, 0, sweep);
      grad.addColorStop(0, 'rgba(127, 211, 107, 0)');
      grad.addColorStop(1, 'rgba(127, 211, 107, 0.06)');
      g.fillStyle = grad;
      g.fillRect(0, sweep - 60, w, 60);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [L?.hash]);

  const doorAt = (ev: MouseEvent): number | null => {
    const v = view.current;
    const cv = ref.current;
    if (!v || !cv || !L) return null;
    const r = cv.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    let best: number | null = null;
    let bestD = 14;
    for (const d of L.doors) {
      if (d.kind !== 'security') continue;
      const [x1, y1, x2, y2] = doorSeg(d);
      const cx = v.ox + ((x1 + x2) / 2) * v.s;
      const cy = v.oy + ((y1 + y2) / 2) * v.s;
      const dist = Math.hypot(mx - cx, my - cy);
      if (dist < bestD) { bestD = dist; best = d.id; }
    }
    return best;
  };
  const click = (ev: MouseEvent) => {
    const id = doorAt(ev);
    if (id === null) return;
    sfx(ctx, 'sfx.ui_click');
    const req = ctx.net.req as unknown as (r: string, a: unknown) => Promise<{ ok: boolean; msg?: string; open?: boolean; cooldownMs?: number }>;
    void req('interaction.consoleDoor', { id }).then((r) => {
      if (!r.ok) ctx.ui.toast(r.msg ?? 'door jammed', 'warn');
      else if (typeof r.open === 'boolean') {
        const st = mirror.doors[id] ?? { open: false, locked: false };
        mirror.doors[id] = { ...st, open: r.open };
      }
    }).catch((e: unknown) => ctx.ui.toast(`Security doors offline (${e instanceof Error ? e.message : e})`, 'warn'));
  };

  const v = ctx.services.use('voice') as unknown as { transmitting?(): boolean; radio?(): 0 | 1 } | undefined;
  const tx = !!(v?.transmitting?.() && v?.radio?.());
  const clock = obj?.startedAt && obj.realSec ? ((ctx.world.serverNow() - obj.startedAt) / 1000 / obj.realSec) * 360 : (obj?.clockMin ?? -1);
  const code = obj?.code ?? null;
  const kp = (obj as { keypad?: { enabled?: boolean; zone?: number } | null } | null)?.keypad ?? null;
  const powered = kp ? !!kp.enabled || !!(kp.zone !== undefined && obj?.power?.[kp.zone]) : obj?.power ? Object.values(obj.power).some(Boolean) : false;
  return (
    <div class="m-console">
      <div class="m-con-map">
        <canvas ref={ref} onClick={click} onMouseMove={(e) => { const id = doorAt(e); if (id !== hover) setHover(id); }} />
        <div class="m-con-title">VAN CONSOLE · SITE MAP<small>{L ? `${L.kind === 'hub' ? 'PARKING LOT' : (ctx.world.full?.activeOrder?.siteName ?? 'FACILITY').toUpperCase()} · ${L.W}×${L.H} M · CLICK A SECURITY DOOR TO TOGGLE` : 'NO SITE DATA'}</small></div>
        <div class="m-con-legend">
          <span><i style={{ background: '#4fd16a' }} />open</span>
          <span><i style={{ background: '#f0b43c' }} />security shut</span>
          <span><i style={{ background: '#d23b2e' }} />locked</span>
          <span><i style={{ background: '#ff4d4d', borderRadius: '50%' }} />contact (6 m)</span>
        </div>
      </div>
      <div class="m-con-side">
        <button class="m-close" style={{ position: 'static', alignSelf: 'flex-end' }} onClick={() => closeScreen(ctx)}>LEAVE CONSOLE [ESC]</button>
        <div class="m-con-box">
          <h5><span>VAULT CODE</span><span>{obj?.vaultOpen ? 'VAULT OPEN' : powered ? 'KEYPAD POWERED' : 'NO POWER'}</span></h5>
          <div class="m-code">{code ?? '----'}</div>
          <div class="m-small" style={{ color: '#5f8f65', marginTop: '6px' }}>Read it out once. Quietly. It is listening for numbers.</div>
        </div>
        <div class="m-con-box">
          <h5><span>CONTRACT</span><span>{clockLabel(clock)}</span></h5>
          <div class="m-small" style={{ lineHeight: 1.8 }}>
            <div>POWER {powered ? <b style={{ color: '#9dff6b' }}>ON</b> : <b style={{ color: '#f0b43c' }}>OFF</b>} · VAULT {obj?.vaultOpen ? <b style={{ color: '#9dff6b' }}>OPEN</b> : 'SEALED'} · CORE {(obj?.coreState ?? '-').toUpperCase()}</div>
            <div>SALVAGE {obj?.salvage ? `${obj.salvage.count}/${obj.salvage.total}` : '-'} · IN VAN <b style={{ color: '#9dff6b' }}>{obj?.hauled ?? 0}</b> SCRIP{obj?.blackout ? ' · BLACKOUT' : ''}</div>
          </div>
        </div>
        <div class="m-con-box">
          <h5><span>BUILT-IN RADIO · CH 1</span><span><span class={`m-led ${tx ? 'on' : ''}`} />{tx ? 'TX' : 'STANDBY'}</span></h5>
          <div class="m-small" style={{ color: '#5f8f65' }}>Hold <span class="m-keys">Q</span> to talk to every walkie. Anything near a walkie hears you too.</div>
        </div>
        <div class="m-con-box" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <h5><span>INTERCEPT LOG</span><span>{intercepts.length}</span></h5>
          <div class="m-log">
            {intercepts.length === 0 && <p class="empty">No intercepts. It is quiet. That is not the same as safe.</p>}
            {[...intercepts].reverse().slice(0, 30).map((it, i) => (
              <p key={`${it.at}-${i}`}>
                <small>{it.callsign ? `${it.callsign} · ` : ''}{(it.action ?? '').replace(/_/g, ' ').toUpperCase()}{it.speaker ? ` · from ${it.speaker}` : ''}</small>
                {it.text}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
