// Owner: track (b) Interaction. HUD widgets driven by signals the interaction system updates each frame:
// target prompt (+ hold ring + denial message), 4-slot inventory, radio LED, death card, spectator hint, locker slats.
import { signal } from '@preact/signals';
import type { HudProps } from '../core/ui/api.ts';
import { itemDef, itemLabel } from '@dead-air/shared/interactables.ts';
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
  if (!t && !m) return null;
  return (
    <div class={`ix-prompt${t && !t.enabled ? ' disabled' : ''}`} data-testid="ix-prompt">
      {t && (
        <div class="ix-prompt-row">
          {h !== null ? <HoldRing k={h} /> : t.key && t.enabled ? <span class={`ix-key${t.key === 'HOLD E' ? ' hold' : ''}`}>{t.key}</span> : null}
          <span class="ix-prompt-text">{t.text}</span>
        </div>
      )}
      {t?.sub && <div class="ix-sub">{t.sub}</div>}
      {m && <div class="ix-msg">{m.text}</div>}
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
  return (
    <div data-testid="ix-inventory">
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
