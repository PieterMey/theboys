// Owner: track (b) Interaction (apps/client/src/interaction/**). Client plugin entry; see apps/client/src/core/context.ts.
// Mirrors InteractionState (FullState slice + 'interaction.patch'), targets interactables with a camera ray, sends
// interaction.use / act / drop / slot, drives the HUD (prompt, inventory, radio LED, death card, spectator hint,
// locker slats), door + light state into ② level / ③ render, sfx, and item visuals. Provides services.interaction.
import './interaction.css';
import * as THREE from 'three/webgpu';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import { INV_SLOTS, applyInteractionPatch, emptyInteractionState, itemDef, itemLabel } from '@dead-air/shared/interactables.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';
import type { InteractionState, IxResult, ItemState } from '@dead-air/shared/messages/interaction.ts';
import type { ReqName } from '@dead-air/shared/messages/index.ts';
import { PLAYER } from '@dead-air/shared/constants.ts';
import { pick } from './targeting.ts';
import type { Hit, V3 } from './targeting.ts';
import { createVisuals } from './visuals.ts';
import type { Visuals } from './visuals.ts';
import { BatteryHud, DeathCardHud, InventoryHud, LockerHud, PromptHud, RadioHud, SpectatorHud, flashMsg, ui } from './hud.tsx';
import type { TargetView } from './hud.tsx';

/** services.interaction (consumed by ④ Voice for the radio chain, HUDs, tests) */
export interface InteractionService {
  /** player carries a walkie (radio chain enabled) */
  hasWalkie(id: string): boolean;
  /** local inventory: item TYPE per slot ('walkie', 'bottle', ... or null) */
  inventory(): (string | null)[];
  /** local inventory items per slot */
  inventoryItems(): (ItemState | null)[];
  activeSlot(): number;
  /** interactable under the crosshair (world items appear as kind 'item') */
  target(): InteractableInfo | null;
  isHidden(id: string): boolean;
  isDead(id: string): boolean;
  /** room light state for a space (switch + power + blackout) */
  lightOn(space: number): boolean;
  doorOpen(id: number): boolean;
  /** live mirrored state (read-only) */
  state(): InteractionState;
  /** v1.1: flashlight tier for a player (2 = carries the Pro Flashlight); ⑤ Players feeds it into flashlights() */
  flashlightTier(id: string): 1 | 2;
  /** local flashlight battery 0..1 (1 outside contracts) */
  battery(): number;
}

declare module '../core/services.ts' {
  interface ServiceMap {
    interaction: InteractionService;
  }
}

/** structural views of services owned by other tracks (always optional) */
interface LevelLike { setDoorOpen?(id: number, open: boolean): void; setLights?(space: number, on: boolean): void }
interface RenderLike { setPower?(space: number | 'all', on: boolean): void; flickerSpace?(space: number, ms: number): void }
interface PlayersLike {
  setHidden?(hidden: boolean, at?: V3, yaw?: number): void;
  freeze?(reason: string, on: boolean): void;
  setSpectate?(on: boolean): void;
  spectating?(): boolean;
  playAnim?(anim: number, ms: number): void;
  avatarObject?(id: string): THREE.Object3D | undefined;
  flashlightOn?(): boolean;
  setFlashlightEnabled?(enabled: boolean): void;
  localPose?(): { p: V3; yaw: number } | null;
  /** v1.1 adrenaline syringe: sprint without stamina drain for ms */
  setStaminaFree?(ms: number): void;
}
interface SfxLike { play(id: string, pos?: V3, opts?: { volume?: number; rate?: number; ui?: boolean }): unknown }

function loose<T>(ctx: ClientContext, name: string): T | undefined {
  return (ctx.services.use as unknown as (n: string) => T | undefined)(name);
}

const FX_SFX: Record<string, string> = {
  smash: 'sfx.bottle_smash', throw: 'sfx.cloth', swing: 'sfx.cloth', hit: 'sfx.crowbar_hit', horn: 'sfx.van_horn',
  security: 'sfx.security_door_slam', pickup: 'sfx.item_pickup', drop: 'sfx.item_drop', switch: 'sfx.switch_click',
  deny: 'sfx.keypad_deny', unlock: 'sfx.keypad_accept', glow: 'sfx.metal_click', locker: 'sfx.door_creak',
  deposit: 'sfx.loot_deposit', medkit: 'sfx.ui_confirm',
  flare: 'sfx.radio_static_burst', sensor: 'sfx.keypad_beep', inject: 'sfx.breath_scared', whisper: 'sfx.listener_radio_whisper', lucky: 'sfx.ui_confirm',
};

export function install(ctx: ClientContext): void {
  const st: InteractionState = emptyInteractionState();
  let version = 0;
  const me = () => ctx.net.me;
  const sync = () => {
    if (ctx.world.full) ctx.world.full.interaction = st;
    version++;
  };
  const resetFrom = () => {
    const src = ctx.world.full?.interaction;
    if (src !== st) applyInteractionPatch(st, { reset: src ?? emptyInteractionState() });
    sync();
  };
  ctx.bus.on('net:welcome', resetFrom);
  ctx.bus.on('world:phase', resetFrom);
  ctx.net.on('interaction.patch', (p) => {
    applyInteractionPatch(st, p);
    sync();
  });

  const sfx = (id: string, pos?: V3, opts?: { volume?: number; rate?: number; ui?: boolean }) => {
    try { loose<SfxLike>(ctx, 'sfx')?.play(id, pos, opts); } catch { /* audio not ready */ }
  };

  // ---------------- state helpers ----------------
  const myInv = (): (ItemState | null)[] => {
    const inv = st.inventories[me() ?? ''] ?? [];
    const out: (ItemState | null)[] = [];
    for (let i = 0; i < INV_SLOTS; i++) out.push(inv[i] ? (st.items[inv[i]!] ?? null) : null);
    return out;
  };
  const activeIdx = () => st.active[me() ?? ''] ?? 0;
  const activeItem = () => myInv()[activeIdx()] ?? null;
  const hasType = (pid: string, type: string) => (st.inventories[pid] ?? []).some((id) => !!id && st.items[id]?.type === type);
  const isDeadId = (id: string) => st.dead.includes(id);
  const nameOf = (id: string) => ctx.world.crew?.players.find((p) => p.id === id)?.name ?? 'Someone';

  // ---------------- requests ----------------
  const send = async (r: ReqName, a: unknown): Promise<IxResult | null> => {
    try {
      const res = (await ctx.net.req(r, a as never)) as IxResult;
      if (res && !res.ok && res.msg) flashMsg(res.msg);
      else if (res?.ok && res.msg) flashMsg(res.msg, 1800);
      return res;
    } catch (e) {
      ctx.reportError(`${r}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  };

  // ---------------- targeting ----------------
  let hit: Hit | null = null;
  let targetInfo: InteractableInfo | null = null;
  let holding: { id: string; start: number; ms: number } | null = null;
  const cam = () => ctx.services.use('three')?.camera;
  const camRay = (): { o: V3; d: V3 } | null => {
    const c = cam();
    if (!c) return null;
    c.updateMatrixWorld();
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    c.getWorldPosition(o);
    c.getWorldDirection(d);
    return { o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] };
  };

  const doorText = (id: number): { text: string; key: TargetView['key']; enabled: boolean; sub?: string } => {
    const d = st.doors[id];
    const kind = d?.kind ?? 'door';
    const open = !!d?.open;
    if (kind === 'vault') return { text: open ? 'Vault door' : 'Vault door: use the keypad', key: null, enabled: false };
    if (d?.locked) {
      const mine = me();
      const hasCard = !!mine && hasType(mine, 'keycard');
      return hasCard ? { text: 'Unlock with the keycard', key: 'E', enabled: true } : { text: 'Locked: needs the keycard', key: null, enabled: false };
    }
    if (kind === 'security') {
      const cd = d?.cooldownUntil && d.cooldownUntil > ctx.world.serverNow() ? 'motor cooling down' : undefined;
      return { text: open ? 'Force the security door shut' : 'Force the security door open', key: 'HOLD E', enabled: true, sub: cd ?? 'loud: 12 m clank' };
    }
    return { text: open ? 'Close door' : 'Open door', key: 'E', enabled: true };
  };

  const viewFor = (h: Hit): TargetView | null => {
    const c = h.c;
    if (c.kind === 'item') {
      const it = st.items[c.item!];
      if (!it) return null;
      if (it.type === 'sensor' && it.armed) return { id: c.id, text: 'Motion sensor (armed)', key: 'E', enabled: true, sub: 'E picks it back up · the van console sees movement within 6 m' };
      return { id: c.id, text: `Pick up ${itemLabel(it)}`, key: 'E', enabled: true, ...(itemDef(it.type).note ? { sub: itemDef(it.type).note } : {}) };
    }
    const info = c.info!;
    switch (info.kind) {
      case 'door':
        return { id: c.id, ...doorText(Number(info.ref)) };
      case 'locker': {
        const occ = Object.entries(st.hidden).find(([pid, l]) => l === info.id && pid !== me());
        return occ ? { id: c.id, text: 'Locker (occupied)', key: null, enabled: false } : { id: c.id, text: 'Hide in locker', key: 'E', enabled: true, sub: 'monsters check lockers: stay silent' };
      }
      case 'switch': {
        const space = Number(info.ref);
        return { id: c.id, text: st.lights[space] ? 'Lights off' : 'Lights on', key: 'E', enabled: true, sub: 'a lit room shows you, too' };
      }
      case 'body': {
        const b = st.bodies[String(info.ref)];
        if (!b) return null;
        const left = (b.reviveBy - ctx.world.serverNow()) / 1000;
        const mine = me();
        if (left > 0 && mine && hasType(mine, 'medkit')) return { id: c.id, text: `Revive ${b.name} (medkit)`, key: 'E', enabled: true, sub: `${Math.ceil(left)} s left` };
        if (left > 0) return { id: c.id, text: `${b.name} is down: a medkit revives`, key: null, enabled: false, sub: `${Math.ceil(left)} s left · or carry the badge to the van` };
        return { id: c.id, text: `${b.name}'s body`, key: null, enabled: false, sub: 'carry their badge to the van deposit' };
      }
      default:
        return { id: c.id, text: info.prompt, key: info.holdMs ? 'HOLD E' : 'E', enabled: info.enabled };
    }
  };

  const updateTarget = () => {
    const mine = me();
    const ray = camRay();
    const alive = !!mine && !isDeadId(mine);
    if (!ray || !alive || st.hidden[mine ?? ''] || !ctx.world.layout) {
      hit = null;
      targetInfo = null;
      return;
    }
    hit = pick({ st, layout: ctx.world.layout, me: mine, origin: ray.o, dir: ray.d, reach: PLAYER.interactRange + 0.45 });
    if (!hit) { targetInfo = null; return; }
    const c = hit.c;
    targetInfo = c.info ?? { id: c.id, kind: 'item', p: c.p, prompt: `Pick up ${itemLabel(st.items[c.item!] ?? { type: 'item' })}`, enabled: true, ref: c.item };
  };

  // ---------------- input (⑤ Players emits action:* on the bus) ----------------
  const inGame = () => ctx.net.status === 'joined' && !!ctx.world.layout && ctx.ui.screen.value.name === 'none';
  const doUse = (id: string, hold = false) => void send('interaction.use', { id, hold });
  ctx.bus.on('action:interact', ({ down }) => {
    if (!inGame()) return;
    const mine = me();
    if (!mine) return;
    if (!down) {
      holding = null;
      ui.hold.value = null;
      return;
    }
    if (st.hidden[mine]) return doUse(st.hidden[mine]);
    if (isDeadId(mine) || !hit) return;
    const view = viewFor(hit);
    if (!view || !view.enabled) {
      if (view && !view.enabled && hit.c.kind !== 'body') doUse(hit.c.id); // let the server explain (locked, vault)
      return;
    }
    const ms = hit.c.info?.holdMs ?? 0;
    if (ms > 0) {
      holding = { id: hit.c.id, start: performance.now(), ms };
      return;
    }
    doUse(hit.c.id);
  });
  ctx.bus.on('action:use', ({ down }) => {
    if (!down || !inGame()) return;
    const mine = me();
    if (!mine || isDeadId(mine) || st.hidden[mine]) return;
    const it = activeItem();
    if (!it) return;
    const use = itemDef(it.type).use;
    if (use === 'none') return;
    if (use === 'radio') return flashMsg('Hold Q to talk on the walkie', 1500);
    const ray = camRay();
    if (!ray) return;
    if (use === 'swing') visuals?.animate('swing');
    else if (use === 'throw') visuals?.animate('throw');
    else visuals?.animate('use');
    void send('interaction.act', { dir: ray.d, eye: ray.o });
  });
  ctx.bus.on('action:drop', ({ down }) => {
    if (!down || !inGame()) return;
    const mine = me();
    if (!mine || isDeadId(mine) || st.hidden[mine]) return;
    if (!activeItem()) return;
    void send('interaction.drop', {});
  });
  ctx.bus.on('action:slot', ({ slot }) => {
    if (!inGame()) return;
    const mine = me();
    if (!mine || slot < 0 || slot >= INV_SLOTS) return;
    st.active[mine] = slot; // optimistic
    void send('interaction.slot', { slot });
  });
  let radioTx = false;
  ctx.bus.on('action:radio', ({ down }) => { radioTx = down; });
  // Listener tell (monsters): the walkie LED flickers red
  let ledAlarmUntil = 0;
  (ctx.bus as unknown as { on(k: string, fn: (d: { ms?: number }) => void): () => void }).on('monsters:led', (d) => {
    ledAlarmUntil = performance.now() + Math.max(200, Number(d?.ms ?? 1200));
  });

  // ---------------- events ----------------
  let deathTimer: ReturnType<typeof setTimeout> | null = null;
  // the twin-breaker pull resolved: drop the stale 'Breaker down: the other one must follow…' line
  ctx.net.on('objectives.lever', (d) => {
    if (d.result !== 'waiting' && ui.msg.value && /^Breaker down/i.test(ui.msg.value.text)) ui.msg.value = null;
  });
  ctx.net.on('interaction.death', (d) => {
    if (d.pid === me()) {
      ui.death.value = { cause: d.cause, out: false };
      sfx('sfx.death_sting', undefined, { ui: true });
      loose<PlayersLike>(ctx, 'players')?.freeze?.('ix-deathcard', true);
      if (deathTimer) clearTimeout(deathTimer);
      deathTimer = setTimeout(() => {
        if (ui.death.value) ui.death.value = { ...ui.death.value, out: true };
        loose<PlayersLike>(ctx, 'players')?.freeze?.('ix-deathcard', false);
        deathTimer = setTimeout(() => { ui.death.value = null; }, 600);
      }, 4000);
    } else {
      sfx('sfx.body_fall', d.p);
      // the cause is written to the victim ('heard your SHOUT'): retell it in the third person for teammates
      // ('took you while you were alone' -> 'took Sam while they were alone')
      const third = String(d.cause.reason ?? '')
        .replace(/\byou were\b/gi, 'they were')
        .replace(/\byour\b/gi, `${d.name}'s`)
        .replace(/\byou\b/i, d.name)
        .replace(/\byou\b/gi, 'them');
      ctx.ui.toast(`${d.name} is down: the ${d.cause.killer} ${third}`, 'warn', 4500);
    }
  });
  ctx.net.on('interaction.revive', (d) => {
    if (d.pid === me()) {
      ui.death.value = null;
      loose<PlayersLike>(ctx, 'players')?.freeze?.('ix-deathcard', false);
      ctx.services.use('input')?.teleport(d.p[0], d.p[2], d.yaw);
      ctx.ui.toast(d.how === 'badge' ? `Back at the van (${d.hp}% HP). HR has been notified.` : `${d.by ? nameOf(d.by) : 'Someone'} patched you up (${d.hp}% HP)`, 'info', 4000);
      sfx('sfx.ui_confirm', undefined, { ui: true });
    } else ctx.ui.toast(`${nameOf(d.pid)} is back on their feet`, 'info', 3000);
  });
  const fxCount: Record<string, number> = {};
  ctx.net.on('interaction.fx', (d) => {
    const mine = d.pid === me();
    if (ctx.testMode) fxCount[d.kind] = (fxCount[d.kind] ?? 0) + 1;
    if (mine && (d.kind === 'swing' || d.kind === 'throw')) {
      // local view model already animated; play the whoosh softer in 2D
      sfx(FX_SFX[d.kind], undefined, { ui: true, volume: 0.5 });
      return;
    }
    if (d.kind === 'door') return sfx(d.open ? 'sfx.door_open' : 'sfx.door_close', d.p);
    if (d.kind === 'horn') return sfx('sfx.van_horn', d.p, { rate: 1.7, volume: 1 });
    if (d.kind === 'inject') {
      if (mine) {
        const ms = Number(ctx.balance.interaction?.adrenalineSec ?? 15) * 1000;
        adrenUntil = performance.now() + ms;
        loose<PlayersLike>(ctx, 'players')?.setStaminaFree?.(ms);
        sfx('sfx.breath_scared', undefined, { ui: true, volume: 0.9 });
        sfx('sfx.cloth', undefined, { ui: true, volume: 0.5, rate: 1.4 });
        return;
      }
      return sfx('sfx.breath_scared', d.p, { volume: 0.7 });
    }
    if (d.kind === 'flare') return sfx('sfx.radio_static_burst', d.p, { rate: 0.45, volume: 0.8 });
    if (d.kind === 'whisper') return sfx('sfx.listener_radio_whisper', d.p, { volume: d.open ? 1 : 0.75, rate: d.open ? 0.7 : 0.9 });
    if (d.kind === 'lucky') {
      if (mine) ctx.ui.toast(`Lucky charm: +${d.item ?? '?'} scrip on that deposit`, 'info', 3200);
      return sfx('sfx.ui_confirm', d.p, { rate: 1.3, volume: 0.6 });
    }
    const key = FX_SFX[d.kind];
    if (key) sfx(key, d.p);
  });

  // ---------------- services.interaction ----------------
  const service: InteractionService = {
    hasWalkie: (id) => hasType(id, 'walkie'),
    inventory: () => myInv().map((it) => it?.type ?? null),
    inventoryItems: myInv,
    activeSlot: activeIdx,
    target: () => targetInfo,
    isHidden: (id) => !!st.hidden[id],
    isDead: isDeadId,
    lightOn: (space) => !!st.lights[space],
    doorOpen: (id) => !!st.doors[id]?.open,
    state: () => st,
    flashlightTier: (id) => (hasType(id, 'flashlight_pro') ? 2 : 1),
    battery: () => battery,
  };
  ctx.services.provide('interaction', service);

  // ---------------- HUD ----------------
  ctx.ui.registerHud('center', PromptHud, { id: 'ix-prompt', order: 30 });
  ctx.ui.registerHud('bottom', InventoryHud, { id: 'ix-inventory', order: 20 });
  ctx.ui.registerHud('bottom-right', RadioHud, { id: 'ix-radio', order: 20 });
  ctx.ui.registerHud('bottom-right', BatteryHud, { id: 'ix-battery', order: 21 });
  // full-screen overlays live in the untransformed top-left slot (position: fixed must resolve against the viewport)
  ctx.ui.registerHud('top-left', DeathCardHud, { id: 'ix-death', order: 90 });
  ctx.ui.registerHud('bottom', SpectatorHud, { id: 'ix-spec', order: 25 });
  ctx.ui.registerHud('top-left', LockerHud, { id: 'ix-locker', order: 5 });

  // ---------------- per frame ----------------
  let visuals: Visuals | null = null;
  let layoutKey = '';
  const pushedDoors = new Map<number, boolean>();
  const pushedLights = new Map<number, boolean>();
  let resyncAcc = 0;
  let hiddenPushed: string | null = null;
  let lastInvKey = '';
  // ---- remote held items (at the avatar's right hand bone)
  const handBone = new WeakMap<THREE.Object3D, THREE.Object3D | null>();
  const tmpV = new THREE.Vector3();
  const heldList = (): { pid: string; type: string; p: V3; yaw: number }[] => {
    const pl = loose<PlayersLike>(ctx, 'players');
    if (!pl?.avatarObject) return [];
    const out: { pid: string; type: string; p: V3; yaw: number }[] = [];
    for (const [pid, inv] of Object.entries(st.inventories)) {
      if (pid === me() || isDeadId(pid) || st.hidden[pid]) continue;
      const id = inv[st.active[pid] ?? 0];
      const it = id ? st.items[id] : undefined;
      if (!it || itemDef(it.type).loot || it.type === 'keycard' || it.type === 'badge') continue;
      const root = pl.avatarObject(pid);
      if (!root || !root.visible) continue;
      let bone = handBone.get(root);
      if (bone === undefined) {
        bone = root.getObjectByName('hand_r') ?? null;
        if (!bone) root.traverse((o) => { if (!bone && /hand[_.]?r(ight)?$/i.test(o.name)) bone = o; });
        handBone.set(root, bone);
      }
      if (bone) bone.getWorldPosition(tmpV);
      else {
        const yaw = root.rotation.y;
        tmpV.set(root.position.x + Math.cos(yaw) * -0.28 + Math.sin(yaw) * 0.2, 0.95, root.position.z - Math.sin(yaw) * -0.28 + Math.cos(yaw) * 0.2);
      }
      out.push({ pid, type: it.type, p: [tmpV.x, tmpV.y, tmpV.z], yaw: root.rotation.y });
    }
    return out;
  };
  // ---- flashlight battery (client-side; ⑤ setFlashlightEnabled): drains while on, recharges in the van cab
  let battery = 1;
  let batteryDead = false;
  let batteryPhase = '';
  const tickBattery = (dt: number) => {
    const pl = loose<PlayersLike>(ctx, 'players');
    const mine = me();
    const L = ctx.world.layout;
    const phaseKey = `${ctx.world.phase}:${L?.hash ?? ''}`;
    if (phaseKey !== batteryPhase) {
      batteryPhase = phaseKey;
      battery = 1;
      if (batteryDead) { batteryDead = false; pl?.setFlashlightEnabled?.(true); }
    }
    if (!pl || !mine || ctx.world.phase !== 'contract' || !L) { if (ui.battery.value !== null) ui.battery.value = null; return; }
    const pro = hasType(mine, 'flashlight_pro');
    const drainSec = Number(ctx.balance.interaction?.flashlightBatterySec ?? 840) * (pro ? Number(ctx.balance.interaction?.proBatteryMult ?? 2) : 1);
    const rechargeSec = Number(ctx.balance.interaction?.flashlightRechargeSec ?? 25);
    const pose = pl.localPose?.();
    const c = L.van?.cab;
    const inVan = !!pose && !!c && pose.p[0] >= c.x - 0.3 && pose.p[0] <= c.x + c.w + 0.3 && pose.p[2] >= c.y - 0.3 && pose.p[2] <= c.y + c.h + 0.3;
    if (inVan) battery = Math.min(1, battery + dt / Math.max(1, rechargeSec));
    else if (pl.flashlightOn?.()) battery = Math.max(0, battery - dt / Math.max(30, drainSec));
    if (!batteryDead && battery <= 0) {
      batteryDead = true;
      pl.setFlashlightEnabled?.(false);
      flashMsg('Flashlight battery dead: recharge it in the van', 3500);
      sfx('sfx.flashlight_click', undefined, { ui: true, rate: 0.7 });
    } else if (batteryDead && battery >= 0.12) {
      batteryDead = false;
      pl.setFlashlightEnabled?.(true);
    }
    const pct = Math.round(battery * 100);
    if (ui.battery.value !== pct) ui.battery.value = pct;
  };
  let ixMs = 0;
  // ---- v1.1 gear status chips (adrenaline countdown, cursed idol, lucky charm, pro flashlight)
  let adrenUntil = 0;
  let statusKey = '';
  const updateStatus = () => {
    const mine = me();
    const chips: { id: string; text: string; tone: 'good' | 'bad' | 'info' }[] = [];
    if (mine && !isDeadId(mine)) {
      const left = Math.ceil((adrenUntil - performance.now()) / 1000);
      if (left > 0) chips.push({ id: 'adren', text: `ADRENALINE ${left} S · SPRINT FREELY`, tone: 'good' });
      if (hasType(mine, 'loot.idol')) chips.push({ id: 'idol', text: 'CURSED IDOL · IT WHISPERS · THEY HEAR YOU', tone: 'bad' });
      if (hasType(mine, 'charm')) chips.push({ id: 'charm', text: 'LUCKY CHARM · DEPOSITS +10%', tone: 'good' });
      if (hasType(mine, 'flashlight_pro')) chips.push({ id: 'pro', text: 'PRO FLASHLIGHT · LED II', tone: 'info' });
    }
    const key = chips.map((c) => c.text).join('|');
    if (key !== statusKey) { statusKey = key; ui.status.value = chips; }
  };

  const syncDoorsAndLights = (dt: number) => {
    const L = ctx.world.layout;
    const key = L ? `${L.seed}:${L.hash}` : '';
    if (key !== layoutKey) {
      layoutKey = key;
      pushedDoors.clear();
      pushedLights.clear();
    }
    resyncAcc += dt;
    const full = resyncAcc > 2;
    if (full) resyncAcc = 0;
    const lvl = loose<LevelLike>(ctx, 'level');
    if (lvl?.setDoorOpen) {
      for (const [k, d] of Object.entries(st.doors)) {
        const id = Number(k);
        if (!full && pushedDoors.get(id) === d.open) continue;
        pushedDoors.set(id, d.open);
        try { lvl.setDoorOpen(id, d.open); } catch { /* level mid-rebuild */ }
      }
    }
    const rnd = loose<RenderLike>(ctx, 'render');
    if (rnd?.setPower) {
      for (const [k, on] of Object.entries(st.lights)) {
        const sp = Number(k);
        if (!full && pushedLights.get(sp) === on) continue;
        pushedLights.set(sp, on);
        try { rnd.setPower(sp, on); } catch { /* render not ready */ }
      }
    }
  };

  const syncHidden = () => {
    const mine = me();
    const l = mine ? (st.hidden[mine] ?? null) : null;
    if (l === hiddenPushed) return;
    hiddenPushed = l;
    const pl = loose<PlayersLike>(ctx, 'players');
    ui.hidden.value = !!l;
    if (l) {
      const li = ctx.world.layout?.items.find((i) => i.id === l);
      const x = li?.x ?? st.ints[l]?.p[0] ?? 0, z = li?.z ?? st.ints[l]?.p[2] ?? 0, rot = li?.rot ?? 0;
      // eye on the locker door plane (the mesh is solid: inside it is black), looking out; the CSS slats frame the view
      pl?.setHidden?.(true, [x + Math.sin(rot) * 0.31, 1.58, z + Math.cos(rot) * 0.31], rot);
    } else pl?.setHidden?.(false);
  };

  const updateUi = () => {
    const mine = me();
    ui.inGame.value = inGame();
    const inv = myInv();
    const invKey = inv.map((i) => (i ? `${i.id}:${i.type}:${i.count ?? 1}` : '-')).join('|');
    if (invKey !== lastInvKey) {
      lastInvKey = invKey;
      ui.slots.value = inv.map((item) => ({ item }));
    }
    if (ui.active.value !== activeIdx()) ui.active.value = activeIdx();
    const hp = mine ? (st.hp[mine] ?? 100) : 100;
    if (ui.hp.value !== hp) ui.hp.value = hp;
    const has = !!mine && hasType(mine, 'walkie');
    const r = ui.radio.value;
    const alarm = has && performance.now() < ledAlarmUntil;
    if (r.has !== has || r.tx !== (radioTx && has) || r.alarm !== alarm) ui.radio.value = { has, tx: radioTx && has, alarm };
    // target prompt
    const view = hit ? viewFor(hit) : null;
    const cur = ui.target.value;
    if ((view?.id ?? null) !== (cur?.id ?? null) || view?.text !== cur?.text || view?.sub !== cur?.sub || view?.enabled !== cur?.enabled) ui.target.value = view;
    // hold progress
    if (holding) {
      if (!hit || hit.c.id !== holding.id) {
        holding = null;
        ui.hold.value = null;
      } else {
        const k = Math.min(1, (performance.now() - holding.start) / holding.ms);
        ui.hold.value = k;
        if (k >= 1) {
          const id = holding.id;
          holding = null;
          ui.hold.value = null;
          doUse(id, true);
        }
      }
    }
    // spectator hint
    if (mine && isDeadId(mine) && ctx.world.phase === 'contract') {
      const now = ctx.world.serverNow();
      const b = st.bodies[mine];
      const rs = st.respawns[mine];
      const spec = { reviveIn: b && b.reviveBy > now ? (b.reviveBy - now) / 1000 : null, respawnIn: rs ? Math.max(0, (rs - now) / 1000) : null };
      const s = ui.spec.value;
      if (!s || Math.ceil(s.reviveIn ?? -1) !== Math.ceil(spec.reviveIn ?? -1) || Math.ceil(s.respawnIn ?? -1) !== Math.ceil(spec.respawnIn ?? -1)) ui.spec.value = spec;
    } else if (ui.spec.value) ui.spec.value = null;
  };

  ctx.registerSystem({
    name: 'interaction',
    order: SYS.interaction,
    update(dt) {
      const t0 = performance.now();
      try {
        frame(dt);
      } finally {
        const ms = performance.now() - t0;
        ixMs = ixMs * 0.9 + ms * 0.1;
        if (ctx.testMode) ctx.diag.ixMs = Math.round(ixMs * 100) / 100;
      }
    },
  });
  function frame(dt: number): void {
    {
      const three = ctx.services.use('three');
      if (three && !visuals) visuals = createVisuals(three.scene);
      updateTarget();
      tickBattery(dt);
      syncDoorsAndLights(dt);
      syncHidden();
      updateUi();
      updateStatus();
      if (visuals && three) {
        const mine = me();
        const thrown: { id: string; p: V3; yaw: number }[] = [];
        for (const [id] of ctx.world.dyn) {
          if (!id.startsWith('thrown:')) continue;
          const s = ctx.world.dyn.get(id)?.sample(ctx.world.renderTime());
          if (s) thrown.push({ id, p: s.p, yaw: s.yaw });
        }
        const act = activeItem();
        const tp = hit && hit.c.kind !== 'door' ? hit.c.p : null;
        visuals.update(st, {
          camera: three.camera,
          activeType: act?.type ?? null,
          // passive Pro Flashlight: the beam is the right-hand flashlight (⑤), no second torch in the left hand
          showViewModel: inGame() && !!mine && !isDeadId(mine) && !st.hidden[mine] && act?.type !== 'flashlight_pro',
          targetItem: hit?.c.item ?? null,
          targetPos: tp && (hit?.c.kind === 'item' || hit?.c.kind === 'loot') ? tp : null,
          thrown,
          serverNow: ctx.world.serverNow(),
          radioTx: radioTx,
          dt,
        });
        visuals.held(heldList());
      }
    }
  }

  // ---------------- test hooks (?test=1) ----------------
  if (ctx.testMode) {
    const api = {
      state: () => JSON.parse(JSON.stringify(st)) as InteractionState,
      version: () => version,
      target: () => (targetInfo ? { ...targetInfo, view: hit ? viewFor(hit) : null } : null),
      use: (id: string, hold = false) => send('interaction.use', { id, hold }),
      act: () => {
        const ray = camRay();
        return send('interaction.act', { dir: ray?.d ?? [0, 0, 1], eye: ray?.o });
      },
      drop: () => send('interaction.drop', {}),
      slot: (slot: number) => send('interaction.slot', { slot }),
      /** point the camera at a world point (via ⑤ input.look); returns [yaw, pitch] */
      aim: (x: number, y: number, z: number) => {
        const ray = camRay();
        if (!ray) return null;
        const dx = x - ray.o[0], dy = y - ray.o[1], dz = z - ray.o[2];
        const yaw = Math.atan2(dx, dz);
        const pitch = Math.atan2(dy, Math.hypot(dx, dz));
        ctx.services.use('input')?.look(yaw, pitch);
        return [yaw, pitch];
      },
      camera: () => camRay(),
      /** hold E for ms (bus action:interact down ... up), for hold interactables (security doors) */
      holdE: (ms: number) => new Promise<void>((res) => {
        ctx.bus.emit('action:interact', { down: true });
        setTimeout(() => { ctx.bus.emit('action:interact', { down: false }); res(); }, ms);
      }),
      layout: () => ctx.world.layout,
      flashlight: (on: boolean) => loose<{ setFlashlight?(on: boolean): void }>(ctx, 'players')?.setFlashlight?.(on),
      inventory: () => service.inventory(),
      status: () => ui.status.value.map((c) => c.text),
      /** interaction.fx events received so far, by kind */
      fx: () => ({ ...fxCount }),
      battery: () => battery,
      tier: (id?: string) => service.flashlightTier(id ?? me() ?? ''),
      ui: () => ({ target: ui.target.value, slots: ui.slots.value.map((s) => s.item?.type ?? null), active: ui.active.value, death: !!ui.death.value, hidden: ui.hidden.value, spec: ui.spec.value }),
    };
    (window as unknown as { __ix: typeof api }).__ix = api;
  }
}
