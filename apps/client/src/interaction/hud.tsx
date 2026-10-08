// Owner: track (b) Interaction. HUD widgets driven by signals the interaction system updates each frame:
// target prompt (+ hold ring + denial message), 4-slot inventory, radio LED, death card, spectator hint, locker slats.
import { signal } from '@preact/signals';
import type { HudProps } from '../core/ui/api.ts';
import { MATERIAL_COLOR, itemDef, itemLabel } from '@dead-air/shared/interactables.ts';
import { MATERIAL_LABEL, MATERIAL_TYPES } from '@dead-air/shared/catalog.ts';
import type { DeathCause, ItemState } from '@dead-air/shared/messages/interaction.ts';

export interface TargetView { id: string; text: string; key: 'E' | 'HOLD E' | null; enabled: boolean; sub?: string }
export interface SlotView { item: ItemState | null }

export const ui = {
  inGame: signal(false),
  target: signal<TargetView | null>(null),
  /** 0..1 hold progress (null = not holding) */
  hold: signal<number | null>(null),
  msg: signal<{ text: string; id: number } | null>(null),
  slots: signal<SlotView[]>([]),
  active: signal(0),
  hp: signal(100),
  radio: signal<{ has: boolean; tx: boolean; alarm: boolean }>({ has: false, tx: false, alarm: false }),
  death: signal<{ cause: DeathCause; out: boolean } | null>(null),
  spec: signal<{ reviveIn: number | null; respawnIn: number | null } | null>(null),
  hidden: signal(false),
  /** flashlight battery % in contracts (null = hidden) */
  battery: signal<number | null>(null),
  /** v1.1 gear status chips above the inventory (adrenaline countdown, cursed idol, lucky charm, pro flashlight) */
  status: signal<{ id: string; text: string; tone: 'good' | 'bad' | 'info' }[]>([]),
  /** v1.2 salvage pouch (MaterialType -> units) */
  pouch: signal<Record<string, number>>({}),
  /** v1.2 server-timed hold-E ring label ('Easing it open… (quiet)'); null = the plain hold ring */
  holdLabel: signal<string | null>(null),
  /** v1.2 night-vision CSS fallback overlay (render.setNightVision absent) */
  nvOverlay: signal(false),
  /** v1.2 flashbulb screen flash: bumps id per flash; soft = reduce-flicker setting */
  flash: signal<{ id: number; k: number; soft: boolean } | null>(null),
};

let msgId = 0;
export function flashMsg(text: string, ms = 2200): void {
  const id = ++msgId;
  ui.msg.value = { text, id };
  setTimeout(() => { if (ui.msg.value?.id === id) ui.msg.value = null; }, ms);
}

function Icon({ type }: { type: string }) {
  const c = itemDef(type).color;
  const s = { width: '30', height: '26', viewBox: '0 0 30 26' };
  switch (type) {
    case 'bottle':
      return <svg {...s}><path d="M13 2h4v5l2 3v13a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V10l2-3z" fill={c} stroke="#9fd3a8" stroke-width="0.8" /><rect x="11.5" y="13" width="7" height="5" fill="#d8cfa8" /></svg>;
    case 'crowbar':
      return <svg {...s}><path d="M5 22 L22 5 q3-2 4 1" fill="none" stroke={c} stroke-width="3" stroke-linecap="round" /><path d="M5 22 l-2 1" stroke="#9aa0a6" stroke-width="3" stroke-linecap="round" /></svg>;
    case 'glowstick':
      return <svg {...s}><g stroke="#39ff6a" stroke-width="3" stroke-linecap="round" style={{ filter: 'drop-shadow(0 0 3px #39ff6a)' }}><path d="M8 22 L13 4" /><path d="M14 22 L17 4" /><path d="M20 22 L21 4" /></g></svg>;
    case 'medkit':
      return <svg {...s}><rect x="3" y="7" width="24" height="16" rx="2" fill="#e7e1d3" /><path d="M11 5h8v2h-8z" fill="#555" /><path d="M13 10h4v4h4v4h-4v4h-4v-4H9v-4h4z" transform="translate(0,-1) scale(1,0.9)" fill="#c0201b" /></svg>;
    case 'walkie':
      return <svg {...s}><rect x="10" y="7" width="11" height="17" rx="2" fill="#3a3f44" stroke="#777" stroke-width="0.8" /><path d="M18 7V1" stroke="#888" stroke-width="2" /><rect x="12" y="10" width="7" height="5" fill="#15181a" /><circle cx="13" cy="19" r="1.3" fill="#3dff6e" /></svg>;
    case 'airhorn':
      return <svg {...s}><rect x="11" y="12" width="8" height="12" rx="1.5" fill="#d63b2f" /><path d="M9 2h12l-3 10h-6z" fill="#f2efe6" /></svg>;
    case 'keycard':
      return <svg {...s}><rect x="3" y="6" width="24" height="15" rx="2" fill="#f2c230" style={{ filter: 'drop-shadow(0 0 3px #ffb000)' }} /><rect x="3" y="9" width="24" height="3" fill="#222" /><rect x="6" y="15" width="8" height="3" fill="#7a5c00" /></svg>;
    case 'badge':
      return <svg {...s}><rect x="8" y="3" width="14" height="21" rx="2" fill="#3f7fb3" /><rect x="11" y="13" width="8" height="7" fill="#e8e8e8" /><circle cx="15" cy="9" r="2.5" fill="#cfe6f7" /></svg>;
    case 'flashlight_pro':
      return <svg {...s}><path d="M2 13 L9 9 L9 17 Z" fill="#cfe6ff" opacity="0.35" /><rect x="9" y="9" width="7" height="8" rx="1" fill="#b9c3cc" /><rect x="16" y="10.5" width="12" height="5" rx="1.5" fill="#1b1f24" stroke="#4fa3ff" stroke-width="0.9" /><rect x="8.4" y="10" width="1.2" height="6" fill="#e9f4ff" style={{ filter: 'drop-shadow(0 0 3px #bfe3ff)' }} /><text x="22" y="8" fill="#4fa3ff" font-size="6.5" font-family="monospace" font-weight="700" text-anchor="middle">II</text></svg>;
    case 'flare':
      return <svg {...s}><g style={{ filter: 'drop-shadow(0 0 3px #ff3b2f)' }}>{[9, 15, 21].map((x, i) => <g key={x}><rect x={x - 2} y={7 + i} width="4" height="15" rx="1" fill="#c8241b" /><rect x={x - 2} y={20 + i} width="4" height="3" fill="#222" /><circle cx={x} cy={6 + i} r="1.8" fill="#ffd0c0" /></g>)}</g></svg>;
    case 'sensor':
      return <svg {...s}><path d="M6 21 a9 9 0 0 1 18 0 Z" fill="#9adfd2" opacity="0.8" /><rect x="4" y="20" width="22" height="4" rx="1" fill="#2c3136" /><path d="M21 13 L24 4" stroke="#888" stroke-width="1.2" /><circle cx="15" cy="16" r="1.8" fill="#30ffd0" style={{ filter: 'drop-shadow(0 0 3px #30ffd0)' }} /><path d="M3 9 a14 14 0 0 1 6 -5 M27 9 a14 14 0 0 0 -6 -5" stroke="#30ffd0" stroke-width="1" fill="none" opacity="0.7" /></svg>;
    case 'syringe':
      return <svg {...s}><g transform="rotate(-35 15 13)"><rect x="6" y="10" width="15" height="6" rx="1.2" fill="#dfe8ea" opacity="0.6" stroke="#cfd8da" stroke-width="0.6" /><rect x="8" y="11" width="11" height="4" fill="#ffd23f" style={{ filter: 'drop-shadow(0 0 2px #ffb000)' }} /><path d="M21 13 H28" stroke="#9aa0a6" stroke-width="1" /><rect x="3" y="9.5" width="2" height="7" fill="#333" /><path d="M1 13 H4" stroke="#333" stroke-width="1.6" /></g></svg>;
    case 'charm':
      return <svg {...s}><circle cx="15" cy="5" r="3" fill="none" stroke="#b08a3e" stroke-width="1.6" /><path d="M15 8 C9 10 9 21 13 23 C15 24 17 24 18 22 C21 18 20 10 15 8 Z" fill="#e9e1cf" /><g fill="#4fd14a" style={{ filter: 'drop-shadow(0 0 2px #2fb52a)' }}><circle cx="23" cy="17" r="2" /><circle cx="26" cy="17" r="2" /><circle cx="24.5" cy="14.5" r="2" /><circle cx="24.5" cy="19.5" r="2" /></g></svg>;
    case 'loot.idol':
      return <svg {...s}><rect x="8" y="21" width="14" height="4" rx="1" fill="#3b3346" /><path d="M11 21 L13 11 H17 L19 21 Z" fill="#4a4058" /><rect x="14" y="5" width="2" height="7" fill="#4a4058" /><ellipse cx="16.5" cy="5" rx="3" ry="3.8" transform="rotate(28 16.5 5)" fill="#4a4058" /><g fill="#d6b8ff" style={{ filter: 'drop-shadow(0 0 2px #a060ff)' }}><circle cx="16" cy="4.5" r="0.9" /><circle cx="18" cy="5.6" r="0.9" /></g></svg>;
    // ---------------- v1.2 gear
    case 'battery':
      return <svg {...s}>{[9, 18].map((x) => <g key={x}><rect x={x - 3.5} y="6" width="7" height="17" rx="1.5" fill="#d9b43a" /><rect x={x - 3.5} y="9" width="7" height="3" fill="#16181a" /><rect x={x - 1.3} y="3.6" width="2.6" height="2.6" rx="0.6" fill="#c98a4a" /><path d={`M${x - 1.5} 17h3M${x} 15.5v3`} stroke="#5a4510" stroke-width="1.1" /></g>)}</svg>;
    case 'lockpick':
      return <svg {...s}><rect x="3" y="15" width="14" height="7" rx="1.5" fill="#4a3324" /><rect x="11" y="14.6" width="2.4" height="7.8" fill="#2a1d14" /><g stroke="#b9c0c6" stroke-width="1.3" stroke-linecap="round"><path d="M15 17 L27 9" /><path d="M15 18.5 L28 14" /><path d="M15 20 L27 19" /><path d="M27 9 l1.5 -1.4" /></g></svg>;
    case 'masterkey':
      return <svg {...s}><rect x="3" y="6" width="24" height="15" rx="2" fill="#ff8f3a" style={{ filter: 'drop-shadow(0 0 3px #ff6a10)' }} /><rect x="3" y="9" width="24" height="3" fill="#222" /><rect x="6" y="14" width="5" height="4" rx="0.6" fill="#d8b04a" /><text x="20" y="19.4" fill="#3a1a00" font-size="7" font-family="monospace" font-weight="700" text-anchor="middle">M</text></svg>;
    case 'soles':
      return <svg {...s}>{[9, 20].map((x, i) => <g key={x} transform={`rotate(${i ? 8 : -8} ${x} 14)`}><ellipse cx={x} cy="13" rx="4.6" ry="9" fill="#7d93a6" /><ellipse cx={x} cy="13.5" rx="3.6" ry="7.6" fill="none" stroke="#2b2f33" stroke-width="1.2" /></g>)}</svg>;
    case 'nvg':
      return <svg {...s}><path d="M4 11 C4 6 26 6 26 11" fill="none" stroke="#3b3a34" stroke-width="2" /><rect x="8" y="10" width="14" height="9" rx="3" fill="#262b2e" stroke="#555" stroke-width="0.7" /><circle cx="15" cy="14.5" r="3.4" fill="#5cff7a" style={{ filter: 'drop-shadow(0 0 3px #39ff6a)' }} /><circle cx="15" cy="14.5" r="1.4" fill="#d9ffe0" /></svg>;
    case 'flashbulb':
      return <svg {...s}><path d="M8 5 L22 5 L18 13 L12 13 Z" fill="#cfd5da" /><circle cx="15" cy="9" r="3" fill="#fff6d8" style={{ filter: 'drop-shadow(0 0 4px #fff0b0)' }} /><rect x="13.5" y="13" width="3" height="11" rx="1" fill="#1b1d20" /><g stroke="#fff2c2" stroke-width="1" stroke-linecap="round" opacity="0.8"><path d="M4 4 l2 1.5" /><path d="M26 4 l-2 1.5" /><path d="M15 1 v1.6" /></g></svg>;
    case 'loot.curio':
      return <svg {...s}><rect x="7" y="21" width="16" height="4" rx="1" fill="#4a2e1c" /><path d="M9 21 V12 a6 6 0 0 1 12 0 V21 Z" fill="#dfe9ee" opacity="0.35" stroke="#cfe0e8" stroke-width="0.8" /><circle cx="15" cy="15.5" r="3.2" fill="none" stroke="#c99b45" stroke-width="1.8" style={{ filter: 'drop-shadow(0 0 2px #8a5a10)' }} /><circle cx="15" cy="5.5" r="1.2" fill="#c99b45" /></svg>;
    case 'page':
      return <svg {...s}><path d="M8 3 H20 L24 7 V24 H8 Z" fill="#e8dfc6" /><path d="M20 3 V7 H24" fill="#cfc4a6" /><g stroke="#3b3a52" stroke-width="0.8" opacity="0.7"><path d="M10.5 10h11M10.5 13h11M10.5 16h11M10.5 19h8" /></g></svg>;
    default:
      return <svg {...s}><rect x="5" y="8" width="20" height="14" rx="1" fill={c} /><path d="M5 12h20" stroke="#000" stroke-opacity="0.35" /></svg>;
  }
}

function HoldRing({ k }: { k: number }) {
  const r = 14, C = 2 * Math.PI * r;
  return (
    <svg class="ix-ring" viewBox="0 0 34 34">
      <circle cx="17" cy="17" r={r} fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3" />
      <circle cx="17" cy="17" r={r} fill="none" stroke="#f0b43c" stroke-width="3" stroke-dasharray={`${C * k} ${C}`} transform="rotate(-90 17 17)" stroke-linecap="round" />
    </svg>
  );
}

export function PromptHud(_p: HudProps) {
  if (!ui.inGame.value || ui.death.value || ui.spec.value) return null;
  const t = ui.target.value;
  const m = ui.msg.value;
  const h = ui.hold.value;
  const hl = ui.holdLabel.value;
  if (!t && !m && !(h !== null && hl)) return null;
  // v1.2: a server-timed hold keeps its ring + label even if the crosshair drifts off the door
  const easing = h !== null && !!hl;
  return (
    <div class={`ix-prompt${t && !t.enabled && !easing ? ' disabled' : ''}`} data-testid="ix-prompt">
      {(t || easing) && (
        <div class="ix-prompt-row">
          {h !== null ? <HoldRing k={h} /> : t?.key && t.enabled ? <span class={`ix-key${t.key === 'HOLD E' ? ' hold' : ''}`}>{t.key}</span> : null}
          <span class={`ix-prompt-text${easing ? ' easing' : ''}`}>{easing ? hl : t!.text}</span>
        </div>
      )}
      {!easing && t?.sub && <div class="ix-sub">{t.sub}</div>}
      {m && <div class="ix-msg">{m.text}</div>}
    </div>
  );
}

/** v1.2 salvage pouch: one chip per crafting material carried (no slot) */
function PouchChips() {
  const p = ui.pouch.value;
  const list = MATERIAL_TYPES.filter((t) => (p[t] ?? 0) > 0);
  if (!list.length) return null;
  return (
    <div class="ix-pouch" data-testid="ix-pouch">
      <span class="ix-pouch-tag">POUCH</span>
      {list.map((t) => (
        <span key={t} class="ix-pouch-chip" title={MATERIAL_LABEL[t]}>
          <span class="ix-pouch-dot" style={{ background: MATERIAL_COLOR[t], boxShadow: `0 0 6px ${MATERIAL_COLOR[t]}` }} />
          {MATERIAL_LABEL[t].toUpperCase()} {p[t]}
        </span>
      ))}
    </div>
  );
}

export function InventoryHud(_p: HudProps) {
  if (!ui.inGame.value || ui.spec.value) return null;
  const slots = ui.slots.value;
  if (!slots.length) return null;
  const a = ui.active.value;
  const act = slots[a]?.item;
  const hint = act ? itemDef(act.type).hint : null;
  const status = ui.status.value;
  return (
    <div data-testid="ix-inventory">
      <PouchChips />
      {status.length > 0 && (
        <div class="ix-status" data-testid="ix-status">
          {status.map((c) => <span key={c.id} class={`ix-chip ${c.tone}`}>{c.text}</span>)}
        </div>
      )}
      {ui.hp.value < 100 && <div class="ix-hp">HP {ui.hp.value}%</div>}
      {hint && <div class="ix-hint">{hint}</div>}
      <div class="ix-inv">
        {slots.map((s, i) => (
          <div key={i} class={`ix-slot${i === a ? ' active' : ''}${s.item ? '' : ' empty'}`}>
            <span class="ix-slot-n">{i + 1}</span>
            {s.item && <span class="ix-slot-icon"><Icon type={s.item.type} /></span>}
            {s.item && (s.item.count ?? 1) > 1 && <span class="ix-slot-count">x{s.item.count}</span>}
            <span class="ix-slot-name">{s.item ? itemLabel({ ...s.item, count: 1 }) : 'empty'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RadioHud(_p: HudProps) {
  if (!ui.inGame.value) return null;
  const r = ui.radio.value;
  if (!r.has) return null;
  return (
    <div class="ix-radio" data-testid="ix-radio">
      <span class={`ix-led ${r.alarm ? 'alarm' : r.tx ? 'tx' : 'on'}`} />
      {r.tx ? 'TX · RADIO' : 'RADIO · Q'}
    </div>
  );
}

export function DeathCardHud(_p: HudProps) {
  const d = ui.death.value;
  if (!d) return null;
  return (
    <div class={`ix-death${d.out ? ' out' : ''}`} data-testid="ix-deathcard">
      <div class="ix-death-card">
        <div class="ix-death-tag">INCIDENT REPORT · CONTRACTOR DECEASED</div>
        <div class="ix-death-killer">{d.cause.killer}</div>
        <div class="ix-death-reason">{d.cause.reason}</div>
        {d.cause.detail && <div class="ix-death-detail">{d.cause.detail}</div>}
        {/FOOTSTEP|SPRINT|MOVEMENT|STEPS/.test(d.cause.reason) && <div class="ix-death-tip" data-testid="ix-death-tip">Creeping (C) is silent to the Hound.</div>}
        <div class="ix-death-foot">YOU ARE NOW STATIC · A MEDKIT AT YOUR BODY (30 S) OR YOUR BADGE IN THE VAN BRINGS YOU BACK</div>
      </div>
    </div>
  );
}

export function SpectatorHud(_p: HudProps) {
  const s = ui.spec.value;
  if (!s || ui.death.value) return null;
  return (
    <div class="ix-spec" data-testid="ix-spec">
      {s.respawnIn !== null ? (
        <span>BADGE FILED · RESPAWN AT THE VAN IN <b>{Math.ceil(s.respawnIn)} S</b></span>
      ) : s.reviveIn !== null ? (
        <span>MEDKIT REVIVE WINDOW <b>{Math.ceil(s.reviveIn)} S</b> · OR A TEAMMATE CARRIES YOUR BADGE TO THE VAN</span>
      ) : (
        <span>YOUR BADGE IS ON THE FLOOR · A TEAMMATE CAN CARRY IT TO THE VAN</span>
      )}
    </div>
  );
}

export function LockerHud(_p: HudProps) {
  if (!ui.hidden.value) return null;
  return (
    <div class="ix-locker" data-testid="ix-locker">
      <div class="ix-locker-slats" />
      <div class="ix-locker-frame" />
      <div class="ix-locker-hint">HIDING · STAY QUIET · [E] LEAVE LOCKER</div>
    </div>
  );
}

/** v1.2 night vision without render.setNightVision: a green phosphor overlay (the canvas also gets a CSS filter) */
export function NightVisionHud(_p: HudProps) {
  if (!ui.nvOverlay.value || !ui.inGame.value) return null;
  return (
    <div class="ix-nv" data-testid="ix-nv">
      <div class="ix-nv-grain" />
      <div class="ix-nv-tag">NV · N TO SWITCH OFF</div>
    </div>
  );
}

/** v1.2 flashbulb: a white screen flash for players facing it (reduce flicker: a soft, slow, dim one) */
export function FlashHud(_p: HudProps) {
  const f = ui.flash.value;
  if (!f) return null;
  return <div key={f.id} class={`ix-flash${f.soft ? ' soft' : ''}`} style={{ '--ix-flash-k': String(f.k) } as Record<string, string>} />;
}

export function BatteryHud(_p: HudProps) {
  const b = ui.battery.value;
  if (!ui.inGame.value || b === null || ui.spec.value) return null;
  const low = b < 15;
  return (
    <div class="ix-radio" data-testid="ix-battery" style={{ color: low ? '#ff8a6b' : '#8a8d88' }}>
      <span style={{ display: 'inline-block', width: '26px', height: '9px', border: '1px solid currentColor', position: 'relative', boxSizing: 'border-box' }}>
        <span style={{ position: 'absolute', left: '1px', top: '1px', bottom: '1px', width: `${Math.max(0, Math.min(100, b)) * 0.22}px`, background: low ? '#ff5a3d' : '#d9d6cc' }} />
      </span>
      {low ? `LIGHT ${b}% · RECHARGE IN VAN` : `LIGHT ${b}%`}
    </div>
  );
}
