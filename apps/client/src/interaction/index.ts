// Owner: track (b) Interaction (apps/client/src/interaction/**). Client plugin entry; see apps/client/src/core/context.ts.
// Mirrors InteractionState (FullState slice + 'interaction.patch'), targets interactables with a camera ray, sends
// interaction.use / act / drop / slot, drives the HUD (prompt, inventory, radio LED, death card, spectator hint,
// locker slats), door + light state into ② level / ③ render, sfx, and item visuals. Provides services.interaction.
// v1.2 (G3): hold-E on doors / drawers is server-timed (E released before easeTapMs = today's loud tap; held =
// 'interaction.ease' on/off, the ring follows the patched ease), lockpicks / master keycard prompts, containers
// (level.setContainerOpen / setContainerProgress), level.setDoorProgress while a door eases, the salvage pouch chips,
// night vision (KeyN, render.setNightVision or a CSS fallback, flashlight off, 2x battery), the battery swap, the
// flashbulb flash, the charging-rack upgrade, the death-card creeping tip and heldNote sub-lines.
import './interaction.css';
import * as THREE from 'three/webgpu';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import { INV_SLOTS, applyInteractionPatch, emptyInteractionState, itemDef, itemLabel } from '@dead-air/shared/interactables.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';
import type { EaseState, InteractionState, IxResult, ItemState } from '@dead-air/shared/messages/interaction.ts';
import type { ReqName } from '@dead-air/shared/messages/index.ts';
import { PLAYER } from '@dead-air/shared/constants.ts';
import { containerById } from '@dead-air/shared/procgen/containers.ts';
import { pick } from './targeting.ts';
import type { Hit, PickOpts, V3 } from './targeting.ts';
import { createVisuals } from './visuals.ts';
import type { HeldView, ThrownView, VisualOpts, Visuals } from './visuals.ts';
import {
  BatteryHud, DeathCardHud, FlashHud, InventoryHud, LockerHud, NightVisionHud, PromptHud, RadioHud, SpectatorHud, flashMsg, ui,
} from './hud.tsx';
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
  /** v1.2: the local player carries an item of this type in any slot (players: overshoes) */
  holds(type: string): boolean;
  /** v1.2: the local salvage pouch (MaterialType -> units) */
  pouch(): Record<string, number>;
  /** v1.2: local night vision on */
  nightVision(): boolean;
}

declare module '../core/services.ts' {
  interface ServiceMap {
    interaction: InteractionService;
  }
}

/** structural views of services owned by other tracks (always optional) */
interface LevelLike {
  setDoorOpen?(id: number, open: boolean): void;
  setLights?(space: number, on: boolean): void;
  visibleSpaces?(camPos: V3): Set<number>;
  roomAt?(x: number, z: number): number;
  // v1.2 (env-world, level/api.ts)
  setDoorProgress?(id: number, t: number | null): void;
  setContainerOpen?(id: string, mask: number, instant?: boolean): void;
  setContainerProgress?(id: string, idx: number, t: number | null): void;
  containers?(): readonly { id: string; main: number }[];
}
interface RenderLike {
  setPower?(space: number | 'all', on: boolean): void;
  flickerSpace?(space: number, ms: number): void;
  // v1.2 (env-render, render/api.ts)
  setNightVision?(on: boolean, opts?: { gain?: number }): void;
  readonly layers?: { firstPerson?: number; detail?: number };
}
interface PlayersLike {
  setHidden?(hidden: boolean, at?: V3, yaw?: number): void;
  freeze?(reason: string, on: boolean): void;
  setSpectate?(on: boolean): void;
  spectating?(): boolean;
  playAnim?(anim: number, ms: number): void;
  avatarObject?(id: string): THREE.Object3D | undefined;
  flashlightOn?(): boolean;
  /** v1.2: ref-counted per reason ('battery', 'nv', 'knockdown') */
  setFlashlightEnabled?(enabled: boolean, reason?: string): void;
  localPose?(): { p: V3; yaw: number } | null;
  /** v1.1 adrenaline syringe: sprint without stamina drain for ms */
  setStaminaFree?(ms: number): void;
}
interface SfxHandleLike { stop(): void }
interface SfxLike { play(id: string, pos?: V3, opts?: { volume?: number; rate?: number; ui?: boolean; radius?: number; loop?: boolean }): SfxHandleLike | null | void }

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

type EaseRes = IxResult & { t0?: number; ms?: number; off?: boolean; done?: boolean };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** the meta settings' reduce-flicker toggle (localStorage; absent / blocked = off) */
function reduceFlicker(): boolean {
  try { return !!(JSON.parse(localStorage.getItem('deadair.meta.settings') ?? '{}') as { reduceFlicker?: boolean }).reduceFlicker; } catch { return false; }
}

export function install(ctx: ClientContext): void {
  const st: InteractionState = emptyInteractionState();
  let version = 0;
  const me = () => ctx.net.me;
  const sync = () => {
    if (ctx.world.full) ctx.world.full.interaction = st;
    version++;
  };
  let containersResync = true;
  const resetFrom = () => {
    const src = ctx.world.full?.interaction;
    if (src !== st) applyInteractionPatch(st, { reset: src ?? emptyInteractionState() });
    containersResync = true;
    sync();
  };
  ctx.bus.on('net:welcome', resetFrom);
  ctx.bus.on('world:phase', resetFrom);
  ctx.net.on('interaction.patch', (p) => {
    applyInteractionPatch(st, p);
    if (p.reset) containersResync = true;
    sync();
  });

  const sfx = (id: string, pos?: V3, opts?: { volume?: number; rate?: number; ui?: boolean; radius?: number; loop?: boolean }): SfxHandleLike | null => {
    try { return loose<SfxLike>(ctx, 'sfx')?.play(id, pos, opts) ?? null; } catch { return null; /* audio not ready */ }
  };
  const bnum = (k: string, d: number): number => {
    const v = (ctx.balance.interaction as Record<string, unknown> | undefined)?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };

  // ---------------- state helpers ----------------
  const myInv = (): (ItemState | null)[] => {
    const inv = st.inventories[me() ?? ''] ?? [];
    const out: (ItemState | null)[] = [];
    for (let i = 0; i < INV_SLOTS; i++) out.push(inv[i] ? (st.items[inv[i]!] ?? null) : null);
    return out;
  };
  const activeIdx = () => st.active[me() ?? ''] ?? 0;
  const activeItem = (): ItemState | null => {
    const i = activeIdx();
    if (i < 0 || i >= INV_SLOTS) return null;
    const id = st.inventories[me() ?? '']?.[i];
    return id ? (st.items[id] ?? null) : null;
  };
  const hasType = (pid: string, type: string): boolean => {
    const inv = st.inventories[pid];
    if (inv) for (const id of inv) if (id && st.items[id]?.type === type) return true;
    return false;
  };
  const countOf = (pid: string, type: string) => (st.inventories[pid] ?? []).reduce((a, id) => a + (id && st.items[id]?.type === type ? (st.items[id]!.count ?? 1) : 0), 0);
  const isDeadId = (id: string) => st.dead.includes(id);
  const nameOf = (id: string) => ctx.world.crew?.players.find((p) => p.id === id)?.name ?? 'Someone';
  const nvMine = () => !!st.nv?.[me() ?? ''];

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
  const rayO = new THREE.Vector3();
  const rayD = new THREE.Vector3();
  /** the camera ray as fresh arrays (requests keep them) */
  const camRay = (): { o: V3; d: V3 } | null => {
    const c = cam();
    if (!c) return null;
    c.updateMatrixWorld();
    c.getWorldPosition(rayO);
    c.getWorldDirection(rayD);
    return { o: [rayO.x, rayO.y, rayO.z], d: [rayD.x, rayD.y, rayD.z] };
  };
  /** the per-frame targeting ray: reused arrays (pick() keeps nothing) */
  const frameRay: { o: V3; d: V3 } = { o: [0, 0, 0], d: [0, 0, 1] };
  const camRayFrame = (): { o: V3; d: V3 } | null => {
    const c = cam();
    if (!c) return null;
    c.updateMatrixWorld();
    c.getWorldPosition(rayO);
    c.getWorldDirection(rayD);
    frameRay.o[0] = rayO.x; frameRay.o[1] = rayO.y; frameRay.o[2] = rayO.z;
    frameRay.d[0] = rayD.x; frameRay.d[1] = rayD.y; frameRay.d[2] = rayD.z;
    return frameRay;
  };

  /** v1.2: quiet hold-E is on (client flag, and the server did not answer 'off' yet) */
  let serverEaseOff = false;
  const easeOn = () => ctx.flags.easeDoors !== false && !serverEaseOff;
  const easeHint = (open: boolean) => (easeOn() ? { sub: open ? 'HOLD E · ease it shut quietly' : 'HOLD E · ease it open quietly' } : {});

  const doorText = (id: number): { text: string; key: TargetView['key']; enabled: boolean; sub?: string } => {
    const d = st.doors[id];
    const kind = d?.kind ?? 'door';
    const open = !!d?.open;
    const mine = me() ?? '';
    if (kind === 'vault') return { text: open ? 'Vault door' : 'Vault door: use the keypad', key: null, enabled: false };
    const mk = countOf(mine, 'masterkey');
    if (d?.locked) {
      if (hasType(mine, 'keycard')) return { text: 'Unlock with the keycard', key: 'E', enabled: true, ...easeHint(false) };
      if (mk > 0) return { text: `Open with the master keycard (${mk} left)`, key: 'E', enabled: true, ...(easeOn() ? { sub: 'HOLD E · open it quietly · one charge' } : { sub: 'uses one charge' }) };
      if (hasType(mine, 'lockpick')) return { text: 'Hold E: pick the lock (loud)', key: 'HOLD E', enabled: true, sub: `${Math.round(bnum('lockpickMs', 5000) / 1000)} s · ${bnum('lockpickNoiseM', 6)} m of scraping · uses one pick` };
      return { text: 'Locked: needs the keycard', key: null, enabled: false };
    }
    if (kind === 'security') {
      const cd = d?.cooldownUntil && d.cooldownUntil > ctx.world.serverNow() ? 'motor cooling down' : undefined;
      if (mk > 0) return { text: open ? 'Shut it with the master keycard' : 'Open it with the master keycard', key: 'E', enabled: true, sub: cd ?? `no clank · ${mk} charge${mk === 1 ? '' : 's'} left · HOLD E forces it (12 m)` };
      return { text: open ? 'Force the security door shut' : 'Force the security door open', key: 'HOLD E', enabled: true, sub: cd ?? 'loud: 12 m clank' };
    }
    return { text: open ? 'Close door' : 'Open door', key: 'E', enabled: true, ...easeHint(open) };
  };

  const viewFor = (h: Hit): TargetView | null => {
    const c = h.c;
    if (c.kind === 'item') {
      const it = st.items[c.item!];
      if (!it) return null;
      if (it.type === 'sensor' && it.armed) return { id: c.id, text: 'Motion sensor (armed)', key: 'E', enabled: true, sub: 'E picks it back up · the van console sees movement within 6 m' };
      // a field-note page's name is its page id (the fieldguide's key): never show it
      if (it.type === 'page') return { id: c.id, text: 'Pick up a field-note page', key: 'E', enabled: true, sub: itemDef('page').note };
      if (it.type === 'mat.pouch') {
        const units = Object.values(it.mats ?? {}).reduce((a, n) => a + n, 0);
        return { id: c.id, text: `Pick up ${it.name ?? 'a salvage pouch'}`, key: 'E', enabled: true, sub: `${units} crafting material${units === 1 ? '' : 's'} · into your pouch` };
      }
      return { id: c.id, text: `Pick up ${itemLabel(it)}`, key: 'E', enabled: true, ...(itemDef(it.type).note ? { sub: itemDef(it.type).note } : {}) };
    }
    const info = c.info!;
    switch (info.kind) {
      case 'door':
        return { id: c.id, ...doorText(Number(info.ref)) };
      case 'container': {
        const cs = st.containers?.[String(info.ref)];
        if (cs?.open) return { id: c.id, text: info.prompt, key: null, enabled: false };
        if (cs?.ease && cs.ease.by !== me()) return { id: c.id, text: `${nameOf(cs.ease.by)} is easing it open`, key: 'E', enabled: true, sub: 'E yanks it open (loud)' };
        return { id: c.id, text: info.prompt, key: 'E', enabled: info.enabled, sub: easeOn() ? `HOLD E · quietly (${(bnum('easeContainerMs', 1200) / 1000).toFixed(1)} s)` : 'drawers are noisy' };
      }
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
      default: {
        const v: TargetView = { id: c.id, text: info.prompt, key: info.holdMs ? 'HOLD E' : 'E', enabled: info.enabled };
        // v1.2 heldNote: a sub-line about the active slot's item ('{item} · no longer counts toward the quota')
        const a = activeItem();
        if (info.heldNote && a) v.sub = info.heldNote.replace('{item}', itemLabel(a));
        return v;
      }
    }
  };

  const pickOpts: PickOpts = { st, layout: null, me: null, origin: frameRay.o, dir: frameRay.d, reach: PLAYER.interactRange + 0.45, version: 0 };
  const updateTarget = () => {
    const mine = me();
    const ray = camRayFrame();
    const alive = !!mine && !isDeadId(mine);
    if (!ray || !alive || st.hidden[mine ?? ''] || !ctx.world.layout) {
      hit = null;
      targetInfo = null;
      return;
    }
    pickOpts.layout = ctx.world.layout;
    pickOpts.me = mine;
    pickOpts.version = version;
    hit = pick(pickOpts);
    if (!hit) { targetInfo = null; return; }
    const c = hit.c;
    targetInfo = c.info ?? { id: c.id, kind: 'item', p: c.p, prompt: `Pick up ${itemLabel(st.items[c.item!] ?? { type: 'item' })}`, enabled: true, ref: c.item };
  };

  // ---------------- v1.2 hold-E: which targets the server times ----------------
  /** a locked door the player can only pick (the lockpick hold also runs with easeDoors off) */
  const pickOnly = (h: Hit): boolean => {
    const info = h.c.info;
    if (!info || info.kind !== 'door') return false;
    const d = st.doors[Number(info.ref)];
    const mine = me() ?? '';
    return !!d?.locked && d.kind === 'locked' && !hasType(mine, 'keycard') && !hasType(mine, 'masterkey') && hasType(mine, 'lockpick');
  };
  const serverHold = (h: Hit): boolean => {
    const info = h.c.info;
    if (!info) return false;
    if (pickOnly(h)) return true;
    if (!easeOn()) return false;
    if (info.kind === 'container') return ctx.flags.containers !== false && !st.containers?.[String(info.ref)]?.open;
    if (info.kind !== 'door') return false;
    const d = st.doors[Number(info.ref)];
    if (!d || d.kind === 'vault' || d.kind === 'blocked' || d.kind === 'open') return false;
    if (d.locked) return d.kind === 'locked' && (hasType(me() ?? '', 'keycard') || hasType(me() ?? '', 'masterkey'));
    return true;
  };

  // ---------------- input (⑤ Players emits action:* on the bus) ----------------
  const inGame = () => ctx.net.status === 'joined' && !!ctx.world.layout && ctx.ui.screen.value.name === 'none';
  const doUse = (id: string, hold = false) => void send('interaction.use', { id, hold });
  let eDown = false;
  let ePending: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let easeSent: { id: string } | null = null;
  const releaseEase = () => {
    if (easeSent) {
      void ctx.net.req('interaction.ease', { id: easeSent.id, on: false }).catch(() => undefined);
      easeSent = null;
    }
  };
  const startEase = (id: string) => {
    if (!ePending || ePending.id !== id) return;
    ePending = null;
    if (!eDown) return;
    easeSent = { id };
    void (ctx.net.req('interaction.ease', { id, on: true }) as Promise<EaseRes>).then((res) => {
      if (res?.ok) return;
      if (easeSent?.id === id) easeSent = null;
      if (res?.off) {
        // the server runs v1.1 doors: a tap, or the client-timed hold of a security door
        serverEaseOff = true;
        const info = st.ints[id];
        if (info?.holdMs && eDown) {
          holding = { id, start: performance.now() - bnum('easeTapMs', 220), ms: info.holdMs };
          return;
        }
        doUse(id);
        return;
      }
      if (res?.msg) flashMsg(res.msg);
    }).catch((e) => ctx.reportError(`interaction.ease: ${e instanceof Error ? e.message : e}`));
  };
  ctx.bus.on('action:interact', ({ down }) => {
    if (!inGame()) return;
    const mine = me();
    if (!mine) return;
    if (!down) {
      eDown = false;
      holding = null;
      ui.hold.value = null;
      if (ePending) {
        // released before easeTapMs: today's loud use. Not when the release came from alt-tab (players releases E on
        // blur, possibly before our own blur listener runs): decide after this event dispatch.
        const id = ePending.id;
        clearTimeout(ePending.timer);
        ePending = null;
        setTimeout(() => { if (performance.now() - blurAt > 250) doUse(id); }, 0);
      }
      releaseEase();
      return;
    }
    eDown = true;
    if (st.hidden[mine]) return doUse(st.hidden[mine]);
    if (isDeadId(mine) || !hit) return;
    const view = viewFor(hit);
    if (!view || !view.enabled) {
      if (view && !view.enabled && hit.c.kind !== 'body') doUse(hit.c.id); // let the server explain (locked, vault)
      return;
    }
    if (serverHold(hit)) {
      const id = hit.c.id;
      if (ePending) clearTimeout(ePending.timer);
      ePending = { id, timer: setTimeout(() => startEase(id), Math.max(60, bnum('easeTapMs', 220))) };
      return;
    }
    const ms = hit.c.info?.holdMs ?? 0;
    if (ms > 0) {
      holding = { id: hit.c.id, start: performance.now(), ms };
      return;
    }
    doUse(hit.c.id);
  });
  // alt-tab mid-hold: never let an ease complete in the background (and no tap either)
  let blurAt = -1e9;
  addEventListener('blur', () => {
    blurAt = performance.now();
    eDown = false;
    if (ePending) { clearTimeout(ePending.timer); ePending = null; }
    releaseEase();
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
    if (use === 'battery' && battery >= 0.995) return flashMsg('Your battery is still full', 1500);
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
  // v1.2 night vision: our own KeyN (game screen only, never while typing or with the chat line open)
  let chatOpen = false;
  ctx.bus.on('action:chat', ({ open }) => { chatOpen = open; });
  const toggleNv = () => {
    const mine = me();
    if (!mine || isDeadId(mine) || !inGame()) return;
    if (ctx.flags.nightVision === false) return;
    if (!hasType(mine, 'nvg')) { if (nvMine()) void send('interaction.nv', { on: false }); else flashMsg('No night-vision module', 1500); return; }
    if (!nvMine() && ctx.world.phase === 'contract' && battery <= 0.02) return flashMsg('Battery dead: recharge it in the van', 2200);
    void send('interaction.nv', { on: !nvMine() });
  };
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyN' || e.repeat) return;
    if (chatOpen || isTextTarget(document.activeElement) || isTextTarget(e.target)) return;
    if (!inGame()) return;
    toggleNv();
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
  let flashId = 0;
  ctx.net.on('interaction.fx', (d) => {
    const mine = d.pid === me();
    if (ctx.testMode) fxCount[d.kind] = (fxCount[d.kind] ?? 0) + 1;
    if (mine && (d.kind === 'swing' || d.kind === 'throw')) {
      // local view model already animated; play the whoosh softer in 2D
      sfx(FX_SFX[d.kind], undefined, { ui: true, volume: 0.5 });
      return;
    }
    if (d.kind === 'door') {
      if (ctx.testMode && d.soft) fxCount.doorSoft = (fxCount.doorSoft ?? 0) + 1;
      // an eased door closes on a soft latch click instead of the swing
      if (d.soft) { sfx('sfx.metal_click', d.p, { volume: 0.25, radius: 3 }); return; }
      return void sfx(d.open ? 'sfx.door_open' : 'sfx.door_close', d.p);
    }
    if (d.kind === 'horn') return void sfx('sfx.van_horn', d.p, { rate: 1.7, volume: 1 });
    if (d.kind === 'inject') {
      if (mine) {
        const ms = Number(ctx.balance.interaction?.adrenalineSec ?? 15) * 1000;
        adrenUntil = performance.now() + ms;
        loose<PlayersLike>(ctx, 'players')?.setStaminaFree?.(ms);
        sfx('sfx.breath_scared', undefined, { ui: true, volume: 0.9 });
        sfx('sfx.cloth', undefined, { ui: true, volume: 0.5, rate: 1.4 });
        return;
      }
      return void sfx('sfx.breath_scared', d.p, { volume: 0.7 });
    }
    if (d.kind === 'flare') return void sfx('sfx.radio_static_burst', d.p, { rate: 0.45, volume: 0.8 });
    if (d.kind === 'whisper') return void sfx('sfx.listener_radio_whisper', d.p, { volume: d.open ? 1 : 0.75, rate: d.open ? 0.7 : 0.9 });
    if (d.kind === 'lucky') {
      if (mine) ctx.ui.toast(`Lucky charm: +${d.item ?? '?'} scrip on that deposit`, 'info', 3200);
      return void sfx('sfx.ui_confirm', d.p, { rate: 1.3, volume: 0.6 });
    }
    // ---------------- v1.2
    if (d.kind === 'container') {
      if (d.soft) {
        sfx('sfx.cloth', d.p, { volume: 0.32, radius: 3, rate: 0.9 });
        sfx('sfx.metal_click', d.p, { volume: 0.25, radius: 3 });
      } else if (d.item === 'desk' || d.item === 'counter') sfx('sfx.wood_hit', d.p, { rate: 1.6, volume: 0.8, radius: 14 });
      else sfx('sfx.metal_latch', d.p, { volume: 0.9, radius: 14 });
      return;
    }
    if (d.kind === 'pick') {
      if (mine) flashMsg('The lock gives', 1600);
      return void sfx('sfx.metal_latch', d.p, { volume: 1, rate: 1.15, radius: 12 });
    }
    if (d.kind === 'masterkey') {
      if (mine && d.count !== undefined) flashMsg(`Master keycard: ${d.count} charge${d.count === 1 ? '' : 's'} left`, 1800);
      return void sfx('sfx.keypad_accept', d.p, { volume: 0.7, radius: 8 });
    }
    if (d.kind === 'battery') {
      if (mine) {
        battery = 1;
        if (batteryDead) { batteryDead = false; loose<PlayersLike>(ctx, 'players')?.setFlashlightEnabled?.(true, 'battery'); }
        sfx('sfx.flashlight_click', undefined, { ui: true, rate: 1.2 });
        sfx('sfx.metal_click', undefined, { ui: true, volume: 0.6 });
      }
      return;
    }
    if (d.kind === 'nv') return void sfx('sfx.switch_click', d.p, { volume: mine ? 0.5 : 0.25, rate: d.open ? 1.5 : 1.2, radius: 4, ...(mine ? { ui: true } : {}) });
    if (d.kind === 'stash') {
      if (mine) flashMsg(`+${d.count ?? 0} material${d.count === 1 ? '' : 's'} to the van stash`, 1800);
      return void sfx('sfx.loot_deposit', d.p, { rate: 1.3, volume: 0.6 });
    }
    if (d.kind === 'flash') {
      const p = d.p ?? [0, 0, 0];
      const dir = d.dir ?? [0, 0, 1];
      visuals?.flash(p, dir);
      sfx('sfx.switch_click', p, { rate: 0.55, volume: 1, radius: 22 });
      sfx('sfx.radio_static_burst', p, { rate: 2.3, volume: 0.3, radius: 10 });
      // the screen flash: the flasher sees the scene light up, anyone looking at the bulb is dazzled
      const ray = camRay();
      if (ray) {
        const vx = p[0] - ray.o[0], vy = p[1] - ray.o[1], vz = p[2] - ray.o[2];
        const dist = Math.hypot(vx, vy, vz);
        const facing = dist > 0.01 ? (vx * ray.d[0] + vy * ray.d[1] + vz * ray.d[2]) / dist : 1;
        const k = mine ? 0.45 : dist < bnum('flashRangeM', 14) && facing > 0.4 ? clamp01(1 - dist / bnum('flashRangeM', 14)) * facing : 0;
        if (k > 0.05) ui.flash.value = { id: ++flashId, k, soft: reduceFlicker() };
      }
      return;
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
    holds: (type) => hasType(me() ?? '', type),
    pouch: () => ({ ...(st.pouches?.[me() ?? ''] ?? {}) }),
    nightVision: nvMine,
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
  ctx.ui.registerHud('top-left', NightVisionHud, { id: 'ix-nv', order: 4 });
  ctx.ui.registerHud('top-left', FlashHud, { id: 'ix-flash', order: 95 });

  // ---------------- per frame ----------------
  let visuals: Visuals | null = null;
  let layoutKey = '';
  let layoutRef: unknown = undefined;
  const pushedDoors = new Map<number, boolean>();
  const pushedLights = new Map<number, boolean>();
  const pushedConts = new Map<string, number>();
  let resyncAcc = 0;
  let hiddenPushed: string | null = null;
  let lastInvKey = '';
  let invVer = -1;
  let invMe: string | null = null;
  // ---- remote held items (at the avatar's right hand bone); pooled views, no allocation per frame
  const handBone = new WeakMap<THREE.Object3D, THREE.Object3D | null>();
  const tmpV = new THREE.Vector3();
  const heldOut: HeldView[] = [];
  const heldPool: HeldView[] = [];
  const NO_HELD: readonly HeldView[] = [];
  const heldList = (): readonly HeldView[] => {
    const pl = loose<PlayersLike>(ctx, 'players');
    if (!pl?.avatarObject) return NO_HELD;
    heldOut.length = 0;
    const mine = me();
    for (const pid in st.inventories) {
      if (pid === mine || isDeadId(pid) || st.hidden[pid]) continue;
      const inv = st.inventories[pid]!;
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
      const v = heldPool[heldOut.length] ?? (heldPool[heldOut.length] = { pid: '', type: '', p: [0, 0, 0], yaw: 0 });
      v.pid = pid;
      v.type = it.type;
      v.p[0] = tmpV.x; v.p[1] = tmpV.y; v.p[2] = tmpV.z;
      v.yaw = root.rotation.y;
      heldOut.push(v);
    }
    return heldOut;
  };
  // ---- flashlight battery (client-side; ⑤ setFlashlightEnabled 'battery'): drains while on (night vision: 2x), recharges
  //      in the van cab (v1.2 charging rack upgrade: 8 s and 1.3x capacity)
  let battery = 1;
  let batteryDead = false;
  let batteryPhase: string | null = null;
  let batteryHash: string | null = null;
  const unlocked = (id: string) => (ctx.world.full?.meta?.unlocks ?? []).includes(id);
  const tickBattery = (dt: number) => {
    const pl = loose<PlayersLike>(ctx, 'players');
    const mine = me();
    const L = ctx.world.layout;
    const hash = L?.hash ?? '';
    if (ctx.world.phase !== batteryPhase || hash !== batteryHash) {
      batteryPhase = ctx.world.phase;
      batteryHash = hash;
      battery = 1;
      if (batteryDead) { batteryDead = false; pl?.setFlashlightEnabled?.(true, 'battery'); }
    }
    if (!pl || !mine || ctx.world.phase !== 'contract' || !L) { if (ui.battery.value !== null) ui.battery.value = null; return; }
    const pro = hasType(mine, 'flashlight_pro');
    const rack = unlocked('charging_rack');
    const drainSec = bnum('flashlightBatterySec', 840) * (pro ? bnum('proBatteryMult', 2) : 1) * (rack ? bnum('chargingRackCapacityMult', 1.3) : 1);
    const rechargeSec = rack ? bnum('chargingRackRechargeSec', 8) : bnum('flashlightRechargeSec', 25);
    const pose = pl.localPose?.();
    const c = L.van?.cab;
    const inVan = !!pose && !!c && pose.p[0] >= c.x - 0.3 && pose.p[0] <= c.x + c.w + 0.3 && pose.p[2] >= c.y - 0.3 && pose.p[2] <= c.y + c.h + 0.3;
    const nv = nvMine();
    if (inVan) battery = Math.min(1, battery + dt / Math.max(1, rechargeSec));
    else if (nv || pl.flashlightOn?.()) battery = Math.max(0, battery - (dt * (nv ? bnum('nvBatteryMult', 2) : 1)) / Math.max(30, drainSec));
    if (!batteryDead && battery <= 0) {
      batteryDead = true;
      pl.setFlashlightEnabled?.(false, 'battery');
      if (nv) void send('interaction.nv', { on: false });
      flashMsg('Flashlight battery dead: recharge it in the van', 3500);
      sfx('sfx.flashlight_click', undefined, { ui: true, rate: 0.7 });
    } else if (batteryDead && battery >= 0.12) {
      batteryDead = false;
      pl.setFlashlightEnabled?.(true, 'battery');
    }
    const pct = Math.round(battery * 100);
    if (ui.battery.value !== pct) ui.battery.value = pct;
  };
  // ---- v1.2 night vision: render.setNightVision (or a CSS fallback), the flashlight held off while it is on
  let nvPushed = false;
  let nvCanvas: HTMLElement | null = null;
  const syncNightVision = () => {
    const on = nvMine();
    if (on === nvPushed) return;
    nvPushed = on;
    const pl = loose<PlayersLike>(ctx, 'players');
    pl?.setFlashlightEnabled?.(!on, 'nv');
    // until players ref-counts the reasons the last call wins: a dead battery keeps the light off
    if (!on && batteryDead) pl?.setFlashlightEnabled?.(false, 'battery');
    const rnd = loose<RenderLike>(ctx, 'render');
    if (rnd?.setNightVision) {
      try { rnd.setNightVision(on, { gain: 6 }); } catch { /* render mid-rebuild */ }
      ui.nvOverlay.value = false;
      return;
    }
    // fallback: a phosphor-green CSS grade on the canvas + an overlay (vignette, scanlines)
    const canvas = (ctx.services.use('three')?.renderer.domElement as HTMLElement | undefined) ?? null;
    if (on && canvas) {
      nvCanvas = canvas;
      canvas.style.filter = 'brightness(4.2) contrast(1.25) grayscale(1) sepia(1) hue-rotate(58deg) saturate(3.2)';
    } else if (nvCanvas) {
      nvCanvas.style.filter = '';
      nvCanvas = null;
    }
    ui.nvOverlay.value = on;
  };
  let ixMs = 0;
  // ---- gear status chips (adrenaline countdown, cursed idol, lucky charm, pro flashlight; v1.2 overshoes, night vision)
  let adrenUntil = 0;
  // the chips depend on the mirrored state (version), the adrenaline seconds left and who we are: rebuilt only when one
  // of those changes (no per-frame arrays, joins or JSON)
  let statusVer = -1;
  let statusLeft = -1;
  let statusMe: string | null = null;
  const updateStatus = () => {
    const mine = me();
    const left = Math.max(0, Math.ceil((adrenUntil - performance.now()) / 1000));
    if (version === statusVer && left === statusLeft && mine === statusMe) return;
    statusVer = version;
    statusLeft = left;
    statusMe = mine;
    const chips: { id: string; text: string; tone: 'good' | 'bad' | 'info' }[] = [];
    if (mine && !isDeadId(mine)) {
      if (left > 0) chips.push({ id: 'adren', text: `ADRENALINE ${left} S · SPRINT FREELY`, tone: 'good' });
      if (hasType(mine, 'loot.idol')) chips.push({ id: 'idol', text: 'CURSED IDOL · IT WHISPERS · THEY HEAR YOU', tone: 'bad' });
      if (hasType(mine, 'charm')) chips.push({ id: 'charm', text: 'LUCKY CHARM · DEPOSITS +10%', tone: 'good' });
      if (hasType(mine, 'flashlight_pro')) chips.push({ id: 'pro', text: 'PRO FLASHLIGHT · LED II', tone: 'info' });
      if (hasType(mine, 'soles')) chips.push({ id: 'soles', text: 'SOFT SOLES', tone: 'good' });
      if (hasType(mine, 'nvg')) chips.push({ id: 'nvg', text: nvMine() ? 'NIGHT VISION ON · 2X BATTERY · N' : 'NIGHT VISION READY · N', tone: 'info' });
    }
    const cur = ui.status.value;
    if (cur.length !== chips.length || chips.some((c, i) => c.text !== cur[i]!.text)) ui.status.value = chips;
    const pouch = (mine ? st.pouches?.[mine] : undefined) ?? {};
    const shown = ui.pouch.value;
    let same = Object.keys(shown).length === Object.keys(pouch).length;
    if (same) for (const k in pouch) if (shown[k] !== pouch[k]) { same = false; break; }
    if (!same) ui.pouch.value = { ...pouch };
  };

  const containerMain = (cid: string): number => {
    const L = ctx.world.layout;
    const lvl = loose<LevelLike>(ctx, 'level');
    const fromLevel = lvl?.containers?.().find((c) => c.id === cid);
    if (fromLevel) return fromLevel.main;
    return L ? (containerById(L, cid)?.main ?? 0) : 0;
  };

  // doors / containers / lights only change with a patch (version) or a layout; the 2 s resync re-pushes everything
  let pushedVer = -1;
  let pushedLevel: LevelLike | undefined;
  let pushedRender: RenderLike | undefined;
  const syncDoorsAndLights = (dt: number) => {
    const L = ctx.world.layout;
    if (L !== layoutRef) {
      const key = L ? `${L.seed}:${L.hash}` : '';
      layoutRef = L;
      if (key !== layoutKey) {
        layoutKey = key;
        pushedDoors.clear();
        pushedLights.clear();
        pushedConts.clear();
        containersResync = true;
      }
      pushedVer = -1;
    }
    resyncAcc += dt;
    const full = resyncAcc > 2;
    if (full) resyncAcc = 0;
    const lvl = loose<LevelLike>(ctx, 'level');
    const rnd = loose<RenderLike>(ctx, 'render');
    // nothing changed since the last push (and the providers are the same): skip the walk over every door
    if (!full && !containersResync && version === pushedVer && lvl === pushedLevel && rnd === pushedRender) return;
    pushedVer = version;
    pushedLevel = lvl;
    pushedRender = rnd;
    if (lvl?.setDoorOpen) {
      for (const k in st.doors) {
        const id = Number(k);
        const d = st.doors[id]!;
        if (!full && pushedDoors.get(id) === d.open) continue;
        pushedDoors.set(id, d.open);
        try { lvl.setDoorOpen(id, d.open); } catch { /* level mid-rebuild */ }
      }
    }
    // v1.2 containers: animate on patches, snap on a reset / resume / the 2 s resync
    if (lvl?.setContainerOpen) {
      const snap = containersResync || full;
      const conts = st.containers ?? {};
      for (const cid in conts) {
        const mask = conts[cid]!.open ?? 0;
        if (!snap && pushedConts.get(cid) === mask) continue;
        const instant = containersResync || pushedConts.get(cid) === mask;
        pushedConts.set(cid, mask);
        try { lvl.setContainerOpen(cid, mask, instant); } catch { /* level mid-rebuild */ }
      }
      for (const [cid, was] of pushedConts) {
        if (conts[cid]) continue;
        pushedConts.delete(cid);
        if (was) try { lvl.setContainerOpen(cid, 0, containersResync); } catch { /* level mid-rebuild */ }
      }
      containersResync = false;
    }
    if (rnd?.setPower) {
      for (const k in st.lights) {
        const sp = Number(k);
        const on = st.lights[sp]!;
        if (!full && pushedLights.get(sp) === on) continue;
        pushedLights.set(sp, on);
        try { rnd.setPower(sp, on); } catch { /* render not ready */ }
      }
    }
  };

  // ---- v1.2 eases: the level animates quiet eases, a creak while a door eases, scraping while a lock is picked
  const easedDoors = new Map<number, { sound: SfxHandleLike | null; kind: string; nextTick: number; p: V3 | undefined }>();
  const easedConts = new Map<string, number>();
  let myEaseLast: { target: 'door' | 'container'; ref: string; to: boolean; kind?: string } | null = null;
  const easeLabel = (e: EaseState, target: 'door' | 'container'): string => {
    if (e.kind === 'pick') return 'Picking the lock… (loud)';
    if (e.kind === 'force') return e.to ? 'Forcing the security door open…' : 'Forcing the security door shut…';
    if (target === 'container') return 'Easing it open… (quiet)';
    return e.to ? 'Easing it open… (quiet)' : 'Easing it shut… (quiet)';
  };
  // the eases in the mirrored state (re-listed only when the state version changes); per frame only those animate
  let easeVer = -1;
  const easingDoors: number[] = [];
  const easingConts: string[] = [];
  /** my own ease this frame (reused) */
  const my = { on: false, k: 0, label: '', target: 'door' as 'door' | 'container', ref: '', to: false, kind: undefined as string | undefined };
  const syncEases = () => {
    const lvl = loose<LevelLike>(ctx, 'level');
    if (version !== easeVer) {
      easeVer = version;
      easingDoors.length = 0;
      for (const k in st.doors) { const id = Number(k); if (st.doors[id]!.ease) easingDoors.push(id); }
      easingConts.length = 0;
      const conts = st.containers ?? {};
      for (const cid in conts) if (conts[cid]!.ease) easingConts.push(cid);
      // eases that ended: stop the creak, hand the door / the part back to the level
      for (const [id, rec] of easedDoors) {
        if (st.doors[id]?.ease) continue;
        easedDoors.delete(id);
        try { rec.sound?.stop(); } catch { /* already gone */ }
        if (rec.kind === 'soft') try { lvl?.setDoorProgress?.(id, null); } catch { /* level mid-rebuild */ }
      }
      for (const [cid, idx] of easedConts) {
        if (conts[cid]?.ease) continue;
        easedConts.delete(cid);
        try { lvl?.setContainerProgress?.(cid, idx, null); } catch { /* level mid-rebuild */ }
      }
    }
    if (!easingDoors.length && !easingConts.length && !myEaseLast) return;
    const now = ctx.world.serverNow();
    const mine = me();
    my.on = false;
    for (const id of easingDoors) {
      const e = st.doors[id]?.ease;
      if (!e) continue;
      const t = clamp01((now - e.t0) / Math.max(1, e.ms));
      if (e.by === mine) { my.on = true; my.k = t; my.label = easeLabel(e, 'door'); my.target = 'door'; my.ref = String(id); my.to = e.to; my.kind = e.kind; }
      let rec = easedDoors.get(id);
      if (!rec) {
        const p = st.ints[`door:${id}`]?.p;
        rec = { kind: e.kind ?? 'soft', nextTick: 0, p, sound: e.kind === 'soft' || !e.kind ? sfx('sfx.door_creak', p, { volume: 0.2, rate: 0.75, radius: 4, loop: true }) : null };
        easedDoors.set(id, rec);
      }
      if (rec.kind === 'pick' && performance.now() >= rec.nextTick) {
        rec.nextTick = performance.now() + 380 + ((id * 97) % 160);
        sfx('sfx.metal_click', rec.p, { volume: 0.45, rate: 0.8 + ((id * 13 + Math.floor(now / 380)) % 7) * 0.06, radius: 6 });
      }
      // the level takes the door's visual openness (0 shut .. 1 open): creep towards the target, the commit finishes it
      const s = t * t * (3 - 2 * t) * 0.94;
      if (rec.kind === 'soft') try { lvl?.setDoorProgress?.(id, e.to ? s : 1 - s); } catch { /* level mid-rebuild */ }
    }
    for (const cid of easingConts) {
      const e = st.containers?.[cid]?.ease;
      if (!e) continue;
      const t = clamp01((now - e.t0) / Math.max(1, e.ms));
      if (e.by === mine) { my.on = true; my.k = t; my.label = easeLabel(e, 'container'); my.target = 'container'; my.ref = cid; my.to = true; my.kind = e.kind; }
      let idx = easedConts.get(cid);
      if (idx === undefined) { idx = containerMain(cid); easedConts.set(cid, idx); }
      try { lvl?.setContainerProgress?.(cid, idx, t * t * (3 - 2 * t) * 0.94); } catch { /* level mid-rebuild */ }
    }
    // my own hold: the ring follows the server's clock; a hold that vanished without its result was interrupted
    if (my.on) {
      ui.hold.value = my.k;
      if (ui.holdLabel.value !== my.label) ui.holdLabel.value = my.label;
      const last = myEaseLast ?? (myEaseLast = { target: my.target, ref: my.ref, to: my.to, kind: my.kind });
      last.target = my.target; last.ref = my.ref; last.to = my.to; last.kind = my.kind;
    } else if (myEaseLast) {
      const last = myEaseLast;
      myEaseLast = null;
      ui.holdLabel.value = null;
      if (!holding) ui.hold.value = null;
      const done = last.target === 'door'
        ? (last.kind === 'pick' ? !st.doors[Number(last.ref)]?.locked : !!st.doors[Number(last.ref)]?.open === last.to)
        : !!st.containers?.[last.ref]?.open;
      if (!done && eDown) flashMsg('Interrupted', 1400);
    }
  };

  const syncHidden = () => {
    const mine = me();
    const l = mine ? (st.hidden[mine] ?? null) : null;
    if (l === hiddenPushed) return;
    hiddenPushed = l;
    const pl = loose<PlayersLike>(ctx, 'players');
    // a crawl vent (players' 'duct:' spots) is not a locker: players drives that camera itself
    const locker = !!l && (st.ints[l]?.kind === 'locker' || !!ctx.world.layout?.items.some((i) => i.id === l && i.kind === 'hiding'));
    ui.hidden.value = locker;
    if (l && locker) {
      const li = ctx.world.layout?.items.find((i) => i.id === l);
      const x = li?.x ?? st.ints[l]?.p[0] ?? 0, z = li?.z ?? st.ints[l]?.p[2] ?? 0, rot = li?.rot ?? 0;
      // eye on the locker door plane (the mesh is solid: inside it is black), looking out; the CSS slats frame the view
      pl?.setHidden?.(true, [x + Math.sin(rot) * 0.31, 1.58, z + Math.cos(rot) * 0.31], rot);
    } else if (!l) pl?.setHidden?.(false);
  };

  const updateUi = () => {
    const mine = me();
    ui.inGame.value = inGame();
    // the slots only change with the mirrored state (or who we are)
    if (version !== invVer || mine !== invMe) {
      invVer = version;
      invMe = mine;
      const inv = myInv();
      const invKey = inv.map((i) => (i ? `${i.id}:${i.type}:${i.count ?? 1}` : '-')).join('|');
      if (invKey !== lastInvKey) {
        lastInvKey = invKey;
        ui.slots.value = inv.map((item) => ({ item }));
      }
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
    // client-timed hold progress (interactables with holdMs that the server does not time)
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

  // ---- per-frame visual inputs (one reused object; no closures or arrays per frame)
  const camArr: V3 = [0, 0, 0];
  const thrownOut: ThrownView[] = [];
  const thrownPool: ThrownView[] = [];
  let dynRt = 0;
  const collectThrown = (buf: { sample(t: number): { p: V3; yaw: number } | null }, id: string) => {
    if (!id.startsWith('thrown:')) return;
    const smp = buf.sample(dynRt);
    if (!smp) return;
    const v = thrownPool[thrownOut.length] ?? (thrownPool[thrownOut.length] = { id: '', p: [0, 0, 0], yaw: 0 });
    v.id = id;
    v.p[0] = smp.p[0]; v.p[1] = smp.p[1]; v.p[2] = smp.p[2];
    v.yaw = smp.yaw;
    thrownOut.push(v);
  };
  const spaceAt = (x: number, z: number): number => {
    const L = ctx.world.layout;
    if (!L) return -1;
    const cx = Math.floor(x), cz = Math.floor(z);
    return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : (L.owner[cz * L.W + cx] ?? -1);
  };
  let vopts: VisualOpts | null = null;

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
      syncEases();
      syncHidden();
      syncNightVision();
      updateUi();
      updateStatus();
      if (visuals && three) {
        const mine = me();
        // thrown projectiles (pooled views; Map.forEach: no entry arrays)
        thrownOut.length = 0;
        if (ctx.world.dyn.size) {
          dynRt = ctx.world.renderTime();
          ctx.world.dyn.forEach(collectThrown);
        }
        const act = activeItem();
        const tp = hit && hit.c.kind !== 'door' ? hit.c.p : null;
        const lvl = loose<LevelLike>(ctx, 'level');
        three.camera.getWorldPosition(tmpV);
        camArr[0] = tmpV.x; camArr[1] = tmpV.y; camArr[2] = tmpV.z;
        let visible: Set<number> | null = null;
        try { visible = lvl?.visibleSpaces?.(camArr) ?? null; } catch { visible = null; }
        const rl = loose<RenderLike>(ctx, 'render')?.layers;
        visuals.setFirstPersonLayer(rl?.firstPerson ?? null);
        // gate P: item meshes on render's detail layer (every view draws them, only your own beam shadows them)
        visuals.setDetailLayer(rl?.detail ?? null);
        const o = vopts ??= {
          camera: three.camera, activeType: null, showViewModel: false, targetItem: null, targetPos: null, thrown: thrownOut, serverNow: 0,
          radioTx: false, dt: 0, version: -1, layoutRef: null, visibleSpaces: null, spaceAt,
        };
        o.camera = three.camera;
        o.activeType = act?.type ?? null;
        // passive Pro Flashlight: the beam is the right-hand flashlight (⑤), no second torch in the left hand
        o.showViewModel = inGame() && !!mine && !isDeadId(mine) && !st.hidden[mine] && act?.type !== 'flashlight_pro';
        o.targetItem = hit?.c.item ?? null;
        o.targetPos = tp && (hit?.c.kind === 'item' || hit?.c.kind === 'loot') ? tp : null;
        o.serverNow = ctx.world.serverNow();
        o.radioTx = radioTx;
        o.dt = dt;
        o.version = version;
        o.layoutRef = ctx.world.layout;
        o.visibleSpaces = visible;
        visuals.update(st, o);
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
      /** v1.2: hold E on the target for ms (> easeTapMs = a server-timed ease); resolves after release */
      easeE: (ms: number) => new Promise<void>((res) => {
        ctx.bus.emit('action:interact', { down: true });
        setTimeout(() => { ctx.bus.emit('action:interact', { down: false }); res(); }, ms);
      }),
      /** v1.2: toggle night vision as KeyN does */
      nv: () => toggleNv(),
      nightVision: () => nvMine(),
      pouch: () => service.pouch(),
      hold: () => ({ k: ui.hold.value, label: ui.holdLabel.value }),
      matStats: () => visuals?.matStats() ?? null,
      matProbe: () => {
        const three = ctx.services.use('three');
        return visuals && three ? visuals.matProbe(three.camera) : null;
      },
      matPlain: (on: boolean) => visuals?.matPlain(on),
      /** v1.2 gate-P fix: what the interaction root draws (meshes, casters, culled items, the warm set) */
      drawStats: () => visuals?.drawStats() ?? null,
      flashHud: () => ui.flash.value,
      layout: () => ctx.world.layout,
      flashlight: (on: boolean) => loose<{ setFlashlight?(on: boolean): void }>(ctx, 'players')?.setFlashlight?.(on),
      inventory: () => service.inventory(),
      status: () => ui.status.value.map((c) => c.text),
      /** interaction.fx events received so far, by kind */
      fx: () => ({ ...fxCount }),
      battery: () => battery,
      setBattery: (v: number) => { battery = clamp01(v); },
      tier: (id?: string) => service.flashlightTier(id ?? me() ?? ''),
      ui: () => ({ target: ui.target.value, slots: ui.slots.value.map((s) => s.item?.type ?? null), active: ui.active.value, death: !!ui.death.value, hidden: ui.hidden.value, spec: ui.spec.value, pouch: ui.pouch.value, nv: ui.nvOverlay.value }),
    };
    (window as unknown as { __ix: typeof api }).__ix = api;
  }
}
